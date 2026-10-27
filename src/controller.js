/**
 * Server controller: contains all route handler logic.
 * Depends on ModelRegistry, Config and Logger injected by Server.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import Logger from './logger.js'
import Pipeline from './pipeline.js'
import EndpointStreamQueue from './stream-queue.js'
import { sendJson } from './lib/http.js'

// ---------------------------------------------------------------------------
// Request hardening limits - tune as needed for your deployment
// ---------------------------------------------------------------------------
/** Maximum JSON request body size in bytes (1 MiB) */
export const MAX_BODY_BYTES = 1024 * 1024
/** Maximum length of the "text" field per request */
export const MAX_TEXT_LENGTH = 10_000
/** Maximum number of whitespace-separated arguments per effects string */
export const MAX_EFFECT_TOKENS = 64
/** Maximum sound file name length (NAME_MAX on most Linux filesystems) */
export const MAX_SOUND_NAME_LENGTH = 255

/**
 * Server controller: contains all route handler logic.
 * Depends on ModelRegistry, Config and Logger injected by Server.
 */
export default class Controller {
    #config
    #models
    #log
    /** Number of pipelines currently preparing (sync or background) */
    #activeJobs = 0
    #streamQueue

    /**
     * @param {import('./config.js').default} config
     * @param {import('./model-registry.js').default} models
     * @param {import('./logger.js').default} log
     */
    constructor(config, models, log) {
        this.#config = config
        this.#models = models
        this.#log = log || new Logger({ namespace: 'Controller' })
        this.#streamQueue = new EndpointStreamQueue(this.#config, this.#log.child('StreamQueue'))
    }

    /**
     * Discard queued streams and clean their temp files during graceful shutdown.
     * @returns {Promise<void>}
     */
    async shutdownQueues() {
        await this.#streamQueue.discard()
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

        // Parse body (rejects with a typed error when the size limit is exceeded)
        let body
        try {
            body = await this.#readBody(req)
        } catch (e) {
            sendJson(res, e.statusCode || 500, {
                error: 'PayloadTooLarge',
                detail: e.message,
            })
            if (typeof req.destroy === 'function') {
                try { req.destroy() } catch { /* socket already gone */ }
            }
            return
        }
        if (!body) {
            return sendJson(res, 400, {
                error: 'BadRequest',
                detail: 'Failed to parse JSON body',
            })
        }

        // Validate required fields
        const { model, text, piper_effects, sox_effects, output_endpoint, intro, outro, intro_spacing, triple_leading_consonant } = body

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

        if (text.length > MAX_TEXT_LENGTH) {
            return sendJson(res, 400, {
                error: 'BadRequest',
                detail: `"text" exceeds the maximum allowed length of ${MAX_TEXT_LENGTH} characters`,
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

        // Validate optional intro/outro sound files (names relative to the sounds directory)
        let introPath = null
        let outroPath = null
        try {
            if (intro != null) {
                introPath = this.#resolveSoundFile('intro', intro)
            }
            if (outro != null) {
                outroPath = this.#resolveSoundFile('outro', outro)
            }
        } catch (e) {
            return sendJson(res, 400, {
                error: 'BadRequest',
                detail: e.message,
            })
        }

        // Validate optional intro spacing (seconds between end of intro and start of speech;
        // negative values overlap/mix the two segments instead). Ignored when no intro is given.
        let introSpacing = null
        if (intro_spacing !== undefined) {
            if (typeof intro_spacing !== 'number' || !Number.isFinite(intro_spacing) || Math.abs(intro_spacing) > 60) {
                return sendJson(res, 400, {
                    error: 'BadRequest',
                    detail: '"intro_spacing" must be a finite number of seconds between -60 and 60',
                })
            }
            introSpacing = intro_spacing
        }

        // Validate optional effect strings against a strict allowlist (see #validateEffectString).
        // Only tokens that can be legitimate CLI arguments survive - anything else is rejected.
        for (const [field, kind] of [['piper_effects', 'piper'], ['sox_effects', 'sox']]) {
            const value = body[field]
            if (value === undefined || value === null) continue
            try {
                this.#validateEffectString(field, value, kind)
            } catch (e) {
                return sendJson(res, 400, {
                    error: 'BadRequest',
                    detail: e.message,
                })
            }
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

        // Enforce optional concurrency limit (protects fire-and-forget mode from job floods)
        const maxConcurrent = this.#config.maxConcurrentPipelines
        if (maxConcurrent > 0 && this.#activeJobs >= maxConcurrent) {
            return sendJson(res, 429, {
                error: 'TooManyRequests',
                detail: `Maximum number of concurrent pipelines (${maxConcurrent}) reached - try again later`,
            })
        }

        // Create pipeline (transient object). The queue serializes streaming per endpoint.
        const pipeline = new Pipeline({
            config: this.#config,
            jobId,
            log: jobLog.child('Pipeline'),
            modelPath,
            text: processedText,
            piperEffects: typeof piper_effects === 'string' ? piper_effects.trim() || null : null,
            soxEffects: typeof sox_effects === 'string' ? sox_effects.trim() || null : null,
            endpoint,
            introPath,
            outroPath,
            introSpacing,
            streamQueue: this.#streamQueue,
        })

        // Fire-and-forget mode: respond immediately after validation, run pipeline asynchronously
        if (this.#config.fireAndForget) {
            jobLog.log('Fire-and-forget mode: responding immediately, running pipeline in background')

            sendJson(res, 200, {
                status: 'ok',
                job_id: jobId,
                message: 'TTS request accepted and queued for streaming',
            })

            // Run pipeline asynchronously without blocking the response.
            // The concurrency slot is released after preparation; queue flush is independent.
            this.#runPipelineBackground(pipeline, jobLog)

            return
        }

        // Default behavior: wait for preparation and queued streaming to complete.
        let slotReleased = false
        this.#activeJobs++

        try {
            const prepared = await pipeline.prepare()
            this.#activeJobs--
            slotReleased = true

            await pipeline.stream(prepared)
            jobLog.log('TTS pipeline completed successfully')

            return sendJson(res, 200, {
                status: 'ok',
                job_id: jobId,
                message: 'Audio generated and streamed successfully',
            })
        } catch (err) {
            if (!slotReleased) {
                this.#activeJobs--
            }
            jobLog.error(`TTS pipeline failed: ${err.message}`)
            return sendJson(res, 500, {
                error: 'PipelineError',
                detail: `TTS processing failed: ${err.message}`,
            })
        }
    }

    /**
     * Run a pipeline in the background for fire-and-forget mode.
     * The concurrency slot is released after preparation, not after queued streaming.
     * @param {Pipeline} pipeline
     * @param {Logger} jobLog
     * @returns {Promise<void>}
     */
    async #runPipelineBackground(pipeline, jobLog) {
        let slotReleased = false
        this.#activeJobs++

        try {
            const prepared = await pipeline.prepare()
            this.#activeJobs--
            slotReleased = true

            await pipeline.stream(prepared)
            jobLog.log('Background TTS pipeline completed successfully')
        } catch (err) {
            if (!slotReleased) {
                this.#activeJobs--
            }
            jobLog.error(`Background TTS pipeline failed: ${err.message}`)
        }
    }

    /**
     * Reads the request body (up to MAX_BODY_BYTES) and parses it as JSON.
     * Rejects with a typed error ({ statusCode: 413 }) when the size limit is exceeded;
     * resolves null when the completed body was not valid JSON.
     * @param {import('node:http').IncomingMessage} req
     * @returns {Promise<object|null>}
     */
    #readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = []
            let totalBytes = 0
            let overLimit = false
            req.on('data', (chunk) => {
                if (overLimit) return // stop accumulating once the limit is breached
                totalBytes += chunk.length
                if (totalBytes > MAX_BODY_BYTES) {
                    overLimit = true
                    reject(Object.assign(
                        new Error(`Request body exceeds the maximum allowed size of ${MAX_BODY_BYTES} bytes`),
                        { statusCode: 413 },
                    ))
                    return
                }
                chunks.push(chunk)
            })
            req.on('end', () => {
                if (overLimit) return
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString()))
                } catch {
                    resolve(null)
                }
            })
            req.on('error', () => { if (!overLimit) resolve(null) })
        })
    }

    /**
     * Parses an "IP:PORT" string into separate components.
     * The host must be a literal IPv4/IPv6 address and the port a number in 1-65535 -
     * anything else (including shell metacharacters or DNS names) is rejected, so the
     * values can only ever reach netcat as plain arguments.
     * @param {string} endpoint - String in "IP:PORT" format
     * @returns {{ host: string, port: string }}
     */
    #parseEndpoint(endpoint) {
        const trimmed = endpoint.trim()
        const lastColon = trimmed.lastIndexOf(':')
        if (lastColon === -1 || lastColon === 0) {
            throw new Error(`Invalid output_endpoint format: '${endpoint}'. Expected 'IP:PORT'`)
        }
        const host = trimmed.slice(0, lastColon)
        const portStr = trimmed.slice(lastColon + 1)
        if (!isIP(host)) {
            throw new Error(`Invalid output_endpoint host: '${host}'. Must be an IPv4 or IPv6 address`)
        }
        if (!/^\d{1,5}$/.test(portStr)) {
            throw new Error(`Invalid output_endpoint port: '${portStr}'. Must be a number between 1 and 65535`)
        }
        const port = Number.parseInt(portStr, 10)
        if (port < 1 || port > 65535) {
            throw new Error(`Invalid output_endpoint port: ${port}. Must be between 1 and 65535`)
        }
        return { host, port: String(port) }
    }

    /**
     * Validates a user-supplied effects string against a strict allowlist so that only
     * tokens which can be legitimate CLI arguments reach Piper/Sox. Every shell
     * metacharacter (`; & | $ ` > < quotes ...`) is outside the allowed character set
     * and therefore rejected with a descriptive error instead of being silently
     * stripped (stripping could corrupt valid effect parameters).
     * @param {'piper_effects'|'sox_effects'} field - Request field name (used in error messages)
     * @param {*} value - Raw request body value for the field
     * @param {'piper'|'sox'} kind - Which tool's argument grammar to validate against
     */
    #validateEffectString(field, value, kind) {
        if (typeof value !== 'string') {
            throw new Error(`"${field}" must be a space-separated string of arguments`)
        }
        const trimmed = value.trim()
        if (trimmed === '') return // whitespace-only behaves as "no effects"
        const tokens = trimmed.split(/\s+/)
        if (tokens.length > MAX_EFFECT_TOKENS) {
            throw new Error(`"${field}" exceeds the maximum of ${MAX_EFFECT_TOKENS} arguments`)
        }

        // Allowed token shapes:
        //   WORD  - letter followed by letters/digits/underscore/hyphen
        //           (effect names like "reverb", word params like fade's "h")
        //   NUMERIC - signed decimal number, optionally comma-separated list
        //           (params like "-400", "0.9", compand curves like "-4,-35,-60")
        //   FLAG  - piper CLI flags only ("--length_scale", "--noise-w-scale")
        const WORD_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/
        const NUMERIC_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:,[-+]?(?:\d+(?:\.\d*)?|\.\d+))*$/
        const FLAG_RE = /^--?[a-zA-Z][a-zA-Z0-9_-]*$/

        for (const token of tokens) {
            const ok = kind === 'sox'
                ? WORD_RE.test(token) || NUMERIC_RE.test(token)
                : FLAG_RE.test(token) || NUMERIC_RE.test(token)
            if (!ok) {
                throw new Error(`"${field}" contains disallowed argument '${token}' - only effect names and numeric parameters are permitted`)
            }
        }
    }

    /**
     * Resolves a user-supplied sound file name against the configured sounds directory.
     * Only plain file names are accepted - no path separators or traversal sequences.
     * @param {'intro'|'outro'} field - Request field name (used in error messages)
     * @param {*} value - Raw request body value for the field
     * @returns {string} Absolute path to the existing regular file
     */
    #resolveSoundFile(field, value) {
        if (!value || typeof value !== 'string') {
            throw new Error(`"${field}" must be a non-empty string`)
        }
        const name = value.trim()
        if (name === '') {
            throw new Error(`"${field}" cannot be empty`)
        }
        if (name.length > MAX_SOUND_NAME_LENGTH) {
            throw new Error(`"${field}" file name exceeds ${MAX_SOUND_NAME_LENGTH} characters`)
        }
        // Reject anything that could escape the sounds directory (path traversal protection)
        if (/[\\/]/.test(name) || name.includes('..')) {
            throw new Error(`"${field}" must be a plain file name inside the sounds directory (got '${name}')`)
        }

        let stats
        try {
            stats = statSync(join(this.#config.soundsDir, name))
        } catch {
            throw new Error(`"${field}" file '${name}' not found in ${this.#config.soundsDir}`)
        }
        if (!stats.isFile()) {
            throw new Error(`"${field}" entry '${name}' is not a regular file`)
        }
        return join(this.#config.soundsDir, name)
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