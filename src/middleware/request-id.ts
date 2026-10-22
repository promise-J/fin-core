import {randomUUID} from 'node:crypto'

import type {RequestHandler} from 'express'
import type { Logger } from 'pino'


declare module 'express-serve-static-core' {
    interface Request {
        requestId: string,
        log: Logger
    }
}

export const requestId: RequestHandler = (req, res, next) => {
    const incoming = req.header('x-request-id')
    const id = incoming && /^[A-Za-z0-9._-]{8,128}$/.test(incoming) ? incoming : randomUUID();
    req.requestId = id;
    res.setHeader('x-request-id', id);
    next()
}