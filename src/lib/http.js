/**
 * HTTP utility functions for sending standardized responses.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

/**
 * Writes a JSON response with the given status code and data.
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} data
 */
export function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
}