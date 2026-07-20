/**
 * Scans a model directory at startup and maintains a cached list
 * of valid model names (matching .onnx + .json pairs).
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { resolve, basename, extname } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import Logger from './logger.js'

const PIPER_VOICES_URL = 'https://huggingface.co/rhasspy/piper-voices'
const ALTERNATIVE_VOICES_URL = 'https://huggingface.csukuangfj/models'

/**
 * Scans a model directory at startup and maintains a cached list
 * of valid model names (matching .onnx + .json pairs).
 */
export default class ModelRegistry {
    #dir
    #log
    #models = []

    /**
     * @param {string} dir - Path to the model directory
     * @param {Logger} [log] - Logger instance
     */
    constructor(dir, log) {
        this.#dir = dir
        this.#log = log || new Logger({ namespace: 'ModelRegistry' })
        this.#scan()
    }

    /** @returns {string} The model directory path */
    get directory() {
        return this.#dir
    }

    /** @returns {string[]} Sorted array of available model base names */
    get models() {
        return [...this.#models]
    }

    /** @returns {number} Number of available models */
    get count() {
        return this.#models.length
    }

    /**
     * Check if a model is available. Accepts bare name or with .onnx extension.
     * @param {string} name
     * @returns {boolean}
     */
    has(name) {
        const clean = extname(name).toLowerCase() === '.onnx' ? name.slice(0, -5) : basename(name)
        return this.#models.includes(clean)
    }

    /**
     * Resolve a model name to its full .onnx file path.
     * Uses basename to prevent path traversal attacks.
     * @param {string} name
     * @returns {string} Full path to the .onnx file
     */
    resolvePath(name) {
        const clean = extname(name).toLowerCase() === '.onnx' ? name.slice(0, -5) : basename(name)
        return resolve(this.#dir, `${clean}.onnx`)
    }

    #scan() {
        // Check directory exists
        if (!existsSync(this.#dir)) {
            this.#log.error(`ERROR: Model directory does not exist: ${this.#dir}`)
            this.#log.error('')
            this.#log.error('Please download Piper TTS models from one of these sources:')
            this.#log.error(`  - ${PIPER_VOICES_URL}`)
            this.#log.error(`  - ${ALTERNATIVE_VOICES_URL}`)
            this.#log.error('')
            this.#log.error('Then set MODEL_DIR to point to the directory containing the models.')
            process.exit(1)
        }

        // Check directory is accessible
        let files
        try {
            files = readdirSync(this.#dir)
        } catch (err) {
            this.#log.error(`ERROR: Cannot access model directory '${this.#dir}': ${err.message}`)
            this.#log.error('Please check directory permissions.')
            process.exit(1)
        }

        // Collect .onnx bases and .json bases
        const onnxBases = new Set()
        const jsonBases = new Set()

        for (const file of files) {
            const ext = extname(file).toLowerCase()
            if (ext === '.onnx') {
                onnxBases.add(file.slice(0, -5))
            } else if (ext === '.json') {
                // Support both "model.json" and "model.onnx.json" naming
                let base = file.slice(0, -5)
                if (base.endsWith('.onnx')) {
                    base = base.slice(0, -5)
                }
                jsonBases.add(base)
            }
        }

        if (onnxBases.size === 0 && jsonBases.size === 0) {
            this.#log.error(`ERROR: Model directory is empty (no .onnx or .json files found): ${this.#dir}`)
            this.#log.error('')
            this.#log.error('Please download Piper TTS models from one of these sources:')
            this.#log.error(`  - ${PIPER_VOICES_URL}`)
            this.#log.error(`  - ${ALTERNATIVE_VOICES_URL}`)
            this.#log.error('')
            this.#log.error('Each model requires both a .onnx and a .json file with the same base name.')
            process.exit(1)
        }

        // Find valid pairs
        for (const baseName of onnxBases) {
            if (jsonBases.has(baseName)) {
                this.#models.push(baseName)
            }
        }

        if (this.#models.length === 0) {
            this.#log.error(`ERROR: No valid model pairs found in ${this.#dir}`)
            this.#log.error('')
            this.#log.error('Found .onnx bases:', [...onnxBases].join(', ') || 'none')
            this.#log.error('Found .json bases:', [...jsonBases].join(', ') || 'none')
            this.#log.error('')
            this.#log.error('Each model requires both a .onnx and a .json file with the same base name.')
            this.#log.error('Please download Piper TTS models from one of these sources:')
            this.#log.error(`  - ${PIPER_VOICES_URL}`)
            this.#log.error(`  - ${ALTERNATIVE_VOICES_URL}`)
            process.exit(1)
        }

        this.#models.sort()
    }
}