-- ============================================================
-- Ledger guards: financial invariants enforced by Postgres.
-- Hand-written because Prisma's schema language cannot express
-- CHECK constraints or triggers. Applied by `prisma migrate`.
-- ============================================================

-- ---------- CHECK: wallet balance is never negative ----------
ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_balance_nonneg" CHECK (balance >= 0);

-- ---------- CHECK: posting amount is strictly positive ----------
ALTER TABLE "LedgerPosting"
  ADD CONSTRAINT "LedgerPosting_amount_positive" CHECK ("amountMinor" > 0);

-- ---------- CHECK: transfer source != destination ----------
ALTER TABLE "Transfer"
  ADD CONSTRAINT "Transfer_src_dst_distinct"
  CHECK ("sourceWalletId" <> "destinationWalletId");

-- ---------- CHECK: transfer amount positive, fee non-negative ----------
ALTER TABLE "Transfer"
  ADD CONSTRAINT "Transfer_amount_positive" CHECK ("amountMinor" > 0);
ALTER TABLE "Transfer"
  ADD CONSTRAINT "Transfer_fee_nonneg" CHECK ("feeMinor" >= 0);

-- ---------- CHECK: payment amounts and refund cap ----------
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amount_positive" CHECK ("amountMinor" > 0);
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_fee_nonneg" CHECK ("feeMinor" >= 0);
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_refunded_nonneg" CHECK ("refundedTotalMinor" >= 0);
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_refunded_within"
  CHECK ("refundedTotalMinor" <= "amountMinor");

-- ---------- CHECK: refund amount positive ----------
ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_amount_positive" CHECK ("amountMinor" > 0);

-- ---------- CHECK: ledger account is either wallet-backed or internal ----------
ALTER TABLE "LedgerAccount"
  ADD CONSTRAINT "LedgerAccount_wallet_or_code"
  CHECK (("walletId" IS NOT NULL) <> ("internalCode" IS NOT NULL));

-- ============================================================
-- TRIGGER 1: a journal entry must balance at COMMIT.
-- Deferred so that multi-statement transactions (insert debits,
-- then insert credits, then update projection) can commit safely
-- as long as the final state is balanced.
-- ============================================================
CREATE OR REPLACE FUNCTION ledger_assert_journal_balanced()
RETURNS TRIGGER AS $$
DECLARE
  v_entry_id   TEXT := COALESCE(NEW."journalEntryId", OLD."journalEntryId");
  v_debits     BIGINT;
  v_credits    BIGINT;
  v_currencies TEXT[];
BEGIN
  SELECT
    COALESCE(SUM("amountMinor") FILTER (WHERE direction = 'DEBIT'),  0),
    COALESCE(SUM("amountMinor") FILTER (WHERE direction = 'CREDIT'), 0),
    ARRAY_AGG(DISTINCT currency)
  INTO v_debits, v_credits, v_currencies
  FROM "LedgerPosting"
  WHERE "journalEntryId" = v_entry_id;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'Journal % is unbalanced: debits=% credits=%',
      v_entry_id, v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;

  IF array_length(v_currencies, 1) > 1 THEN
    RAISE EXCEPTION 'Journal % mixes currencies: %', v_entry_id, v_currencies
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_journal_balanced
AFTER INSERT OR UPDATE OR DELETE ON "LedgerPosting"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION ledger_assert_journal_balanced();

-- ============================================================
-- TRIGGER 2: LedgerPosting rows are immutable.
-- ============================================================
CREATE OR REPLACE FUNCTION ledger_posting_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'LedgerPosting rows are immutable (attempted %)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_posting_no_update
BEFORE UPDATE ON "LedgerPosting"
FOR EACH ROW EXECUTE FUNCTION ledger_posting_immutable();

CREATE TRIGGER ledger_posting_no_delete
BEFORE DELETE ON "LedgerPosting"
FOR EACH ROW EXECUTE FUNCTION ledger_posting_immutable();

-- ============================================================
-- TRIGGER 3: JournalEntry can only change status POSTED -> REVERSED.
-- All other UPDATEs and all DELETEs are refused.
-- ============================================================
CREATE OR REPLACE FUNCTION journal_entry_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'JournalEntry rows cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- No-op update or the one allowed transition.
    IF NEW.status = OLD.status
       AND NEW."referenceType"   = OLD."referenceType"
       AND NEW."referenceId"     = OLD."referenceId"
       AND NEW.currency          = OLD.currency
       AND NEW."transactionType" = OLD."transactionType" THEN
      RETURN NEW;
    END IF;
    IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Illegal JournalEntry mutation'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entry_guard_trg
BEFORE UPDATE OR DELETE ON "JournalEntry"
FOR EACH ROW EXECUTE FUNCTION journal_entry_guard();

-- ============================================================
-- TRIGGER 4: Wallet.balance must equal the sum of its postings
-- for its linked LedgerAccount. Deferred to COMMIT for the same
-- reason as Trigger 1.
-- ============================================================
CREATE OR REPLACE FUNCTION wallet_balance_matches_ledger()
RETURNS TRIGGER AS $$
DECLARE
  v_wallet_id TEXT;
  v_expected  BIGINT;
  v_actual    BIGINT;
BEGIN
  -- Affected wallet = wallet of the ledger account on either OLD or NEW row.
  SELECT a."walletId" INTO v_wallet_id
  FROM "LedgerAccount" a
  WHERE a.id = COALESCE(NEW."ledgerAccountId", OLD."ledgerAccountId");

  IF v_wallet_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    COALESCE(SUM(
      CASE p.direction
        WHEN 'CREDIT' THEN  p."amountMinor"
        WHEN 'DEBIT'  THEN -p."amountMinor"
      END
    ), 0)
  INTO v_expected
  FROM "LedgerPosting" p
  JOIN "LedgerAccount" a ON a.id = p."ledgerAccountId"
  WHERE a."walletId" = v_wallet_id;

  SELECT balance INTO v_actual FROM "Wallet" WHERE id = v_wallet_id;

  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Wallet % balance drift: expected=%, actual=%',
      v_wallet_id, v_expected, v_actual
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER wallet_balance_matches_ledger
AFTER INSERT OR UPDATE OR DELETE ON "LedgerPosting"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION wallet_balance_matches_ledger();