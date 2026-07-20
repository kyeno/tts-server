/**
 * Represents a single TTS processing pipeline.
 * Instantiated per request, runs the Piper -> Sox -> Netcat stages, then cleans up temp files.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { spawn } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import Logger from './logger.js'

/**
 * Represents a single TTS processing pipeline.
 * Instantiated per request, runs once, then cleaned up.
 */
export default class Pipeline {
    #config
    #jobId
    #log
    #modelPath
    #text
    #piperEffects
    #soxEffects
    #endpoint

    // Temp file paths tracked for cleanup
    #piperWav = null
    #processedWav = null

    /**
     * @param {object} options
     * @param {import('./config.js').default} options.config - Application configuration
     * @param {string} options.jobId - Unique job identifier
     * @param {Logger} [options.log] - Logger instance
     * @param {string} options.modelPath - Full path to the .onnx model file
     * @param {string} options.text - Text to synthesize
     * @param {string|null} [options.piperEffects] - Optional piper CLI flags
     * @param {string|null} [options.soxEffects] - Optional sox effects string
     * @param {{ host: string, port: string }|null} [options.endpoint] - Netcat target
     */
    constructor({ config, jobId, log, modelPath, text, piperEffects, soxEffects, endpoint }) {
        this.#config = config
        this.#jobId = jobId
        this.#log = log || new Logger({ namespace: 'Pipeline', jobId })
        this.#modelPath = modelPath
        this.#text = text
        this.#piperEffects = piperEffects || null
        this.#soxEffects = soxEffects || null
        this.#endpoint = endpoint || null

        this.#piperWav = `${this.#config.tempDir}${jobId}-piper.wav`
    }

    /** @returns {string} Job ID */
    get jobId() {
        return this.#jobId
    }

    /**
     * Execute the full pipeline: piper -> [sox] -> netcat.
     * @returns {Promise<void>} Resolves on success, rejects on failure
     */
    async run() {
        try {
            this.#log.log(`Starting TTS pipeline for model: ${this.#modelPath}`)

            // Stage 1: Piper TTS
            await this.#runPiper()
            this.#log.log('Piper completed')

            // Stage 2: Sox processing (optional)
            if (this.#soxEffects) {
                await this.#runSox()
                this.#log.log('Sox processing completed')
                this.#cleanup(this.#piperWav)
                this.#piperWav = null
            } else {
                this.#log.log('Skipping sox (no effects specified)')
                this.#processedWav = this.#piperWav
            }

            // Stage 3: Stream to endpoint (optional)
            if (this.#endpoint) {
                await this.#streamToEndpoint()
            } else {
                this.#log.log('Skipping netcat (no output endpoint specified)')
                this.#cleanup(this.#processedWav)
                this.#processedWav = null
            }

            this.#log.log('Pipeline complete')
        } catch (err) {
            this.#log.error('Pipeline failed, cleaning up...')
            throw err
        } finally {
            // Ensure all temp files are cleaned up
            this.#destroy()
        }
    }

    /**
     * Explicitly destroy this pipeline and clean up all temp files.
     * Call after .run() completes (success or failure).
     */
    #destroy() {
        this.#cleanup(this.#piperWav)
        if (this.#processedWav && this.#processedWav !== this.#piperWav) {
            this.#cleanup(this.#processedWav)
        }
        // Clear references for garbage collection
        this.#piperWav = null
        this.#processedWav = null
        this.#modelPath = null
        this.#text = null
        this.#endpoint = null
    }

    /**
     * Stage 1: Invoke the Piper CLI to synthesize speech from text.
     * Writes the resulting WAV file to the temp directory.
     * @returns {Promise<void>}
     */
    #runPiper() {
        return new Promise((resolve, reject) => {
            const errChunks = []
            const extraArgs = this.#piperEffects ? this.#parseEffects(this.#piperEffects) : []

            this.#log.log(`Piper input text (${this.#text.length} chars): ${JSON.stringify(this.#text)}`)
            if (this.#piperEffects) {
                this.#log.log(`Piper effects: ${this.#piperEffects}`)
            }

            const piper = spawn(this.#config.piperPath, ['--model', this.#modelPath, '--output-file', this.#piperWav, ...extraArgs], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: process.env,
            })

            piper.stderr.on('data', (chunk) => errChunks.push(chunk))
            piper.on('error', (err) => reject(new Error(`Failed to spawn piper: ${err.message}`)))

            piper.on('close', (code) => {
                if (code !== 0) {
                    const stderr = Buffer.concat(errChunks).toString().trim()
                    return reject(new Error(`Piper failed with exit code ${code}: ${stderr || 'no error message'}`))
                }
                resolve()
            })

            piper.stdin.write(this.#text)
            piper.stdin.end()
        })
    }

    /**
     * Stage 2: Apply optional Sox audio effects to the Piper output.
     * Produces a processed WAV file in the temp directory.
     * @returns {Promise<void>}
     */
    #runSox() {
        return new Promise((resolve, reject) => {
            const errChunks = []
            const effectsArgs = this.#parseEffects(this.#soxEffects)
            this.#processedWav = `${this.#config.tempDir}${this.#jobId}-processed.wav`

            this.#log.log(`Applying sox effects: ${effectsArgs.join(' ')}`)

            const sox = spawn(this.#config.soxPath, [this.#piperWav, this.#processedWav, ...effectsArgs], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: process.env,
            })

            sox.stderr.on('data', (chunk) => errChunks.push(chunk))
            sox.on('error', (err) => reject(new Error(`Failed to spawn sox: ${err.message}`)))

            sox.on('close', (code) => {
                if (code !== 0) {
                    const stderr = Buffer.concat(errChunks).toString().trim()
                    return reject(new Error(`Sox failed with exit code ${code}: ${stderr || 'no error message'}`))
                }
                resolve()
            })
        })
    }

    /**
     * Stage 3: Stream the final WAV file to the remote endpoint via netcat.
     * @returns {Promise<void>}
     */
    #streamToEndpoint() {
        return new Promise((resolve, reject) => {
            const errChunks = []
            const filePath = this.#processedWav || this.#piperWav

            this.#log.log(`Streaming to ${this.#endpoint.host}:${this.#endpoint.port}`)

            const nc = spawn(`cat "${filePath}" | ${this.#config.netcatPath} ${this.#endpoint.host} ${this.#endpoint.port}`, {
                shell: true,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: process.env,
            })

            nc.stderr.on('data', (chunk) => errChunks.push(chunk))

            nc.on('error', (err) => {
                this.#cleanup(filePath)
                reject(new Error(`Failed to spawn netcat: ${err.message}`))
            })

            nc.on('close', (code) => {
                if (code !== 0) {
                    const stderr = Buffer.concat(errChunks).toString().trim()
                    this.#log.warn(
                        `Netcat exited with code ${code}: ${stderr || 'connection may have closed'}`
                    )
                } else {
                    this.#log.log('Audio streamed successfully via netcat')
                }
                resolve()
            })
        })
    }

    /**
     * Split a whitespace-delimited effects string into an argument array.
     * @param {string} effectsStr - Space-separated effect tokens
     * @returns {string[]} Array of individual effect arguments
     */
    #parseEffects(effectsStr) {
        return effectsStr.trim().split(/\s+/)
    }

    /**
     * Remove a temporary file from disk, logging success or silently ignoring missing files.
     * @param {string|null} filePath - Path to the file to delete
     */
    #cleanup(filePath) {
        if (!filePath) return
        try {
            unlinkSync(filePath)
            this.#log.log(`Cleaned up temp file: ${filePath}`)
        } catch {
            // File might not exist yet or already removed
        }
    }
}