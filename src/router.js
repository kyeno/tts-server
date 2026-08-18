/**
 * Simple HTTP router that maps method:path combinations to handler functions.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import Logger from './logger.js'
import { sendJson } from './lib/http.js'

/**
 * Simple HTTP router that maps paths to handler functions.
 */
export default class Router {
    #routes = new Map()
    #log

    /**
     * Create a new Router instance with an empty route table.
     * @param {Logger} [log] - Logger instance
     */
    constructor(log) {
        this.#log = log || new Logger({ namespace: 'Router' })
    }

    /**
     * Register a route with an explicit handler function.
     * @param {string} method - HTTP method (GET, POST, etc.)
     * @param {string} path - URL path
     * @param {Function} handler - Request handler function(req, res)
     */
    use(method, path, handler) {
        const key = `${method.toUpperCase()}:${path}`
        this.#routes.set(key, handler)
    }

    /**
     * Dispatch an incoming request to the appropriate handler.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    dispatch(req, res) {
        const key = `${req.method}:${this.#pathname(req)}`

        const handler = this.#routes.get(key)
        if (!handler) {
            // Check if path exists but wrong method
            const path = this.#pathname(req)
            const possibleMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
            for (const method of possibleMethods) {
                if (this.#routes.get(`${method}:${path}`)) {
                    return sendJson(res, 405, { error: 'Method Not Allowed' })
                }
            }

            return sendJson(res, 404, { error: 'NotFound' })
        }

        try {
            const result = handler(req, res)
            if (result && typeof result.catch === 'function') {
                result.catch((err) => this.#handleError(err, res))
            }
        } catch (err) {
            this.#handleError(err, res)
        }
    }

    /**
     * Last-resort error handling: logs the failure and sends a generic 500 unless
     * headers were already sent. Guarantees that malformed requests can never crash
     * the process via uncaught exceptions or promise rejections.
     * @param {*} err - The error thrown by a request handler
     * @param {import('node:http').ServerResponse} res
     */
    #handleError(err, res) {
        this.#log.error(`Unhandled request handler error: ${err?.message || String(err)}`)
        try {
            if (!res.headersSent) {
                sendJson(res, 500, { error: 'InternalServerError', detail: 'An unexpected server error occurred' })
            } else {
                res.end()
            }
        } catch { /* connection is gone - nothing more we can do */ }
    }

    /**
     * Extract the path portion of the request target without throwing on malformed
     * Host headers or unusual targets.
     * @param {import('node:http').IncomingMessage} req
     * @returns {string} Pathname (always starts with '/')
     */
    #pathname(req) {
        try {
            return new URL(req.url, `http://${req.headers.host}`).pathname
        } catch {
            const raw = String(req.url || '/').split('?')[0].split('#')[0]
            return raw.startsWith('/') ? raw : '/'
        }
    }
}