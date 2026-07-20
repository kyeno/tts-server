/**
 * Simple HTTP router that maps method:path combinations to handler functions.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { sendJson } from './lib/http.js'

/**
 * Simple HTTP router that maps paths to handler functions.
 */
export default class Router {
    #routes = new Map()

    /**
     * Create a new Router instance with an empty route table.
     */
    constructor() {}

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
        if (handler) {
            return handler(req, res)
        }

        // Check if path exists but wrong method
        const path = this.#pathname(req)
        const possibleMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
        for (const method of possibleMethods) {
            if (this.#routes.get(`${method}:${path}`)) {
                return sendJson(res, 405, { error: 'Method Not Allowed' })
            }
        }

        sendJson(res, 404, { error: 'NotFound' })
    }

    #pathname(req) {
        return new URL(req.url, `http://${req.headers.host}`).pathname
    }
}