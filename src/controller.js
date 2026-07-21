/**
 * Server controller: contains all route handler logic.
 * Depends on ModelRegistry, Config and Logger injected by Server.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { randomUUID } from 'node:crypto'
import Logger from './logger.js'
import Pipeline from './pipeline.js'
import { sendJson } from './lib/http.js'

/**
 * Server controller: contains all route handler logic.
 * Depends on ModelRegistry, Config and Logger injected by Server.
 */
export default class Controller {
    #config
    #models
    #log

    /**
     * @param {import('./config.js').default} config
     * @param {import('./model-registry.js').default} models
     * @param {import('./logger.js').default} log
     */
    constructor(config, models, log) {
        this.#config = config
        this.#models = models
        this.#log = log || new Logger({ namespace: 'Controller' })
    }

    /**
     * Handle GET / — returns an empty 200 response.
     * @param {import('node:http').IncomingMessage} _req
     * @param {import('node:http').ServerResponse} res
     */
    handleRoot(_req, res) {
        res.writeHead(200)
        res.end()
    }

    /**
     * Handle GET /health — health check endpoint.
     * @param {import('node:http').IncomingMessage} _req
     * @param {import('node:http').ServerResponse} res
     */
    handleHealth(_req, res) {
        if (_req.method !== 'GET') {
            return sendJson(res, 405, { error: 'Method Not Allowed' })
        }
        res.writeHead(200)
        res.end()
    }

    /**
     * Handle GET /models — returns list of available TTS models.
     * @param {import('node:http').IncomingMessage} _req
     * @param {import('node:http').ServerResponse} res
     */
    handleModels(_req, res) {
        if (_req.method !== 'GET') {
            return sendJson(res, 405, { error: 'Method Not Allowed' })
        }
        sendJson(res, 200, { models: this.#models.models })
    }

    /**
     * Handle POST /tts — process a text-to-speech request through the Piper pipeline.
     * Validates the request body, processes optional text transformations, and runs the pipeline.
     * Supports both synchronous and fire-and-forget modes.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async handleTts(req, res) {
        if (req.method !== 'POST') {
            return sendJson(res, 405, { error: 'Method Not Allowed' })
        }

        const jobId = randomUUID()
        const clientIp = req.socket.remoteAddress
        const jobLog = this.#log.child('Controller', jobId)
        jobLog.log(`Incoming POST /tts request from ${clientIp}`)

        // Validate Content-Type
        const contentType = req.headers['content-type'] || ''
        if (!contentType.includes('application/json')) {
            return sendJson(res, 415, {
                error: 'UnsupportedMediaType',
                detail: 'Content-Type must be application/json',
            })
        }

        // Parse body
        const body = await this.#readBody(req)
        if (!body) {
            return sendJson(res, 400, {
                error: 'BadRequest',
                detail: 'Failed to parse JSON body',
            })
        }

        // Validate required fields
        const { model, text, piper_effects, sox_effects, output_endpoint, triple_leading_consonant } = body

        if (!model || typeof model !== 'string' || model.trim() === '') {
            return sendJson(res, 400, {
                error: 'BadRequest',
                detail: '"model" field is required and cannot be empty',
            })
        }

        if (!text || typeof text !== 'string' || text.trim() === '') {
            return sendJson(res, 400, {
                error: 'BadRequest',
                detail: '"text" field is required and cannot be empty',
            })
        }

        if (!output_endpoint || typeof output_endpoint !== 'string' || output_endpoint.trim() === '') {
            return sendJson(res, 400, {
                error: 'BadRequest',
                detail: '"output_endpoint" field is required and cannot be empty',
            })
        }

        // Parse output endpoint
        let endpoint
        try {
            endpoint = this.#parseEndpoint(output_endpoint)
        } catch (e) {
            return sendJson(res, 400, {
                error: 'BadRequest',
                detail: e.message,
            })
        }

        // Validate model exists
        if (!this.#models.has(model)) {
            return sendJson(res, 400, {
                error: 'BadRequest',
                detail: `Model '${model}' not found. Available models: ${this.#models.models.join(', ')}`,
            })
        }

        const modelPath = this.#models.resolvePath(model)
        jobLog.log(`Processing TTS request - model: ${model}, text length: ${text.length}`)

        // Process text — triple leading consonant for Slavic language support
        let processedText = text
        if (triple_leading_consonant && (triple_leading_consonant === true || triple_leading_consonant === 1)) {
            processedText = this.#tripleLeadingConsonant(text)
        }

        // Create and run pipeline (transient object)
        const pipeline = new Pipeline({
            config: this.#config,
            jobId,
            log: jobLog.child('Pipeline'),
            modelPath,
            text: processedText,
            piperEffects: piper_effects || null,
            soxEffects: sox_effects || null,
            endpoint,
        })

        // Fire-and-forget mode: respond immediately after validation, run pipeline asynchronously
        if (this.#config.fireAndForget) {
            jobLog.log('Fire-and-forget mode: responding immediately, running pipeline in background')

            sendJson(res, 200, {
                status: 'ok',
                job_id: jobId,
                message: 'TTS request accepted and processing in background',
            })

            // Run pipeline asynchronously without blocking the response
            pipeline.run().catch(err => {
                jobLog.error(`Background TTS pipeline failed: ${err.message}`)
            })

            return
        }

        // Default behavior: wait for pipeline to complete
        try {
            await pipeline.run()
            jobLog.log('TTS pipeline completed successfully')

            return sendJson(res, 200, {
                status: 'ok',
                job_id: jobId,
                message: 'Audio generated and streamed successfully',
            })
        } catch (err) {
            jobLog.error(`TTS pipeline failed: ${err.message}`)
            return sendJson(res, 500, {
                error: 'PipelineError',
                detail: `TTS processing failed: ${err.message}`,
            })
        }
    }

    /**
     * Reads the full request body and parses it as JSON.
     * @param {import('node:http').IncomingMessage} req
     * @returns {Promise<object|null>}
     */
    #readBody(req) {
        return new Promise((resolve) => {
            const chunks = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString()
                try {
                    resolve(JSON.parse(body))
                } catch {
                    resolve(null)
                }
            })
        })
    }

    /**
     * Parses an "IP:PORT" string into separate components.
     * @param {string} endpoint - String in "IP:PORT" format
     * @returns {{ host: string, port: string }}
     */
    #parseEndpoint(endpoint) {
        const lastColon = endpoint.lastIndexOf(':')
        if (lastColon === -1) {
            throw new Error(`Invalid output_endpoint format: '${endpoint}'. Expected 'IP:PORT'`)
        }
        return {
            host: endpoint.slice(0, lastColon),
            port: endpoint.slice(lastColon + 1),
        }
    }

    /**
     * Triple the leading consonant of a string for better TTS sentence beginnings.
     * UTF-8 aware: uses code point iteration and Unicode property escapes.
     * Skips transformation if the very first word has one grapheme or fewer.
     * @param {string} text
     * @returns {string}
     */
    #tripleLeadingConsonant(text) {
        if (!text || text.length === 0) return text

        // Find first word (skip leading whitespace), UTF-8 safe
        const match = text.match(/^\s*(\S+)/)
        if (!match) return text
        const firstWord = match[1]

        // Count graphemes in first word using spread (handles surrogate pairs)
        const graphemes = [...firstWord]
        if (graphemes.length <= 1) return text

        const firstChar = graphemes[0]
        const upper = firstChar.toUpperCase()

        // Expanded vowel set including accented vowels (Polish, French, German, etc.)
        const vowels = new Set([
            'A', 'E', 'I', 'O', 'U',
            'Ą', 'Ę', 'Ó',
            'Á', 'É', 'Í', 'Ó', 'Ú', 'Ý',
            'À', 'È', 'Ì', 'Ò', 'Ù',
            'Â', 'Ê', 'Î', 'Ô', 'Û',
            'Ä', 'Ë', 'Ï', 'Ö', 'Ü', 'Ÿ',
            'Å', 'Æ', 'Ø',
        ])

        // Use Unicode property for letter check (\p{Letter} with 'u' flag)
        if (!/\p{Letter}/u.test(firstChar) || vowels.has(upper)) {
            return text
        }

        // Calculate offset: account for leading whitespace that was skipped
        const prefixLen = match.index === undefined ? 0 : match[0].length - firstWord.length
        const afterPrefix = text.slice(prefixLen)

        // Triple the leading consonant (only position 0 preserves case, rest lowercase)
        return text.slice(0, prefixLen) + firstChar + firstChar.toLowerCase() + firstChar.toLowerCase() + afterPrefix.slice(1)
    }
}