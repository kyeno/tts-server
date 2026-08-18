/**
 * Application configuration loaded from environment variables.
 * Validates required settings and resolves external binary paths at startup.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { execSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Logger from './logger.js'
import { setupRamDisk, cleanupRamDisk } from './ramdisk.js'

// Project root (parent directory of src/) - used to resolve relative DIR_SOUNDS values
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Application configuration loaded from environment variables.
 * Validates required settings at construction time.
 */
export default class Config {
    #raw = {}
    #log
    #piperPath
    #soxPath
    #netcatPath
    #ffmpegPath = undefined
    #ffprobePath = undefined
    #ramDiskActive = false
    #ramDiskDir = null
    #ramDiskExisted = true

    /**
     * @param {object} [env] - Environment variables (defaults to process.env)
     * @param {Logger} [log] - Logger instance
     */
    constructor(env = process.env, log) {
        this.#raw = env
        this.#log = log || new Logger({ namespace: 'Config' })

        // Required: DIR_MODEL must be set
        if (!env.DIR_MODEL) {
            this.#log.error('ERROR: DIR_MODEL environment variable is required')
            process.exit(1)
        }

        // Temp directory: create if needed
        const tempDir = this.tempDir
        if (!existsSync(tempDir)) {
            try {
                mkdirSync(tempDir, { recursive: true })
                this.#log.log(`Created temp directory: ${tempDir}`)
            } catch (err) {
                this.#log.error(`ERROR: Cannot create temp directory '${tempDir}': ${err.message}`)
                process.exit(1)
            }
        }

        // Optional: RAM disk setup (after DIR_MODEL validation, before binary resolution)
        this.#initRamDisk()

        // Validate external dependencies
        this.#piperPath = this.#resolveBinary('PATH_PIPER', 'piper')
        this.#soxPath = this.#resolveBinary('PATH_SOX', 'sox')
        this.#netcatPath = this.#resolveBinary('PATH_NETCAT', 'nc')
    }

    /**
     * Initialize RAM disk if DIR_RAMDISK_MODEL is configured.
     * Copies models from DIR_MODEL to the RAM disk after all validation checks.
     */
    #initRamDisk() {
        const ramDiskPath = this.#raw.DIR_RAMDISK_MODEL
        if (!ramDiskPath) {
            return
        }

        this.#log.log(`RAM disk enabled: copying models from '${this.modelDir}' to '${ramDiskPath}'`)

        const dirExisted = setupRamDisk(this.#raw.DIR_MODEL, ramDiskPath, this.#log.child('RamDisk'))
        this.#ramDiskActive = true
        this.#ramDiskDir = ramDiskPath
        this.#ramDiskExisted = dirExisted
        this.#log.log(`Models will be served from RAM disk: ${ramDiskPath}`)
    }

    /** @returns {string} Path to the model directory (RAM disk if active, otherwise DIR_MODEL) */
    get modelDir() {
        if (this.#ramDiskActive && this.#ramDiskDir) {
            return this.#ramDiskDir
        }
        return this.#raw.DIR_MODEL
    }

    /** @returns {boolean} Whether models are being served from a RAM disk */
    get useRamDisk() {
        return this.#ramDiskActive
    }

    /**
     * Clean up the RAM disk directory on shutdown.
     * Should be called during graceful shutdown.
     */
    cleanupRamDisk() {
        if (!this.#ramDiskActive || !this.#ramDiskDir) {
            return
        }
        cleanupRamDisk(this.#ramDiskDir, this.#ramDiskExisted, this.#log.child('RamDisk'))
        this.#ramDiskActive = false
    }

    /** @returns {string} Server bind address in "host:port" format */
    get serverBind() {
        return this.#raw.ADDRESS_LISTEN || '0.0.0.0:8080'
    }

    /** @returns {{ host: string, port: number }} Parsed server bind */
    get serverAddress() {
        const parts = this.serverBind.split(':')
        return {
            host: parts[0] || '0.0.0.0',
            port: parseInt(parts[1] || '8080', 10),
        }
    }

    /** @returns {string} Absolute path to temp directory */
    get tempDir() {
        return this.#raw.DIR_TEMP || '/tmp/tts-server/'
    }

    /** @returns {string} Resolved path to piper binary */
    get piperPath() {
        return this.#piperPath
    }

    /** @returns {string} Resolved path to sox binary */
    get soxPath() {
        return this.#soxPath
    }

    /** @returns {string} Resolved path to netcat binary */
    get netcatPath() {
        return this.#netcatPath
    }

    /** @returns {string} Absolute path to the sounds directory for intro/outro files */
    get soundsDir() {
        const raw = this.#raw.DIR_SOUNDS || 'sounds/'
        return isAbsolute(raw) ? raw : join(PROJECT_ROOT, raw)
    }

    /**
     * Lazily resolve the ffmpeg binary path on first use and cache it.
     * Unlike piper/sox/netcat, ffmpeg is only required when a request uses "intro"/"outro",
     * so it is not resolved at startup; failures throw instead of terminating the process.
     * @throws {Error} If ffmpeg cannot be found or PATH_FFMPEG points to an invalid file
     * @returns {string} Resolved absolute path to the ffmpeg binary
     */
    getFfmpegPath() {
        if (this.#ffmpegPath !== undefined) {
            return this.#ffmpegPath
        }

        let path = this.#raw.PATH_FFMPEG || null

        // If no custom path provided, try to resolve via `which` / `where`
        if (!path) {
            try {
                path = execSync('which ffmpeg', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
            } catch {
                throw new Error("Required dependency 'ffmpeg' not found in PATH - install it or set PATH_FFMPEG=/full/path/to/ffmpeg")
            }
        }

        // Validate the resolved/override path exists and is executable
        try {
            accessSync(path, constants.X_OK)
        } catch {
            throw new Error(`PATH_FFMPEG points to '${path}' which does not exist or is not executable`)
        }

        this.#log.log(`Found 'ffmpeg' at: ${path}`)
        this.#ffmpegPath = path
        return path
    }

    /**
     * Lazily resolve the ffprobe binary path on first use and cache it.
     * Prefers the sibling of the resolved ffmpeg binary (they ship together),
     * falling back to a $PATH lookup.
     * @throws {Error} If ffprobe cannot be found or is not executable
     * @returns {string} Resolved absolute path to the ffprobe binary
     */
    getFfprobePath() {
        if (this.#ffprobePath !== undefined) {
            return this.#ffprobePath
        }

        const candidates = []
        try {
            candidates.push(join(dirname(this.getFfmpegPath()), 'ffprobe'))
        } catch {
            // ffmpeg itself unresolvable - its error will surface instead
        }

        for (const candidate of candidates) {
            try {
                accessSync(candidate, constants.X_OK)
                this.#log.log(`Found 'ffprobe' at: ${candidate}`)
                this.#ffprobePath = candidate
                return candidate
            } catch {
                // Keep looking
            }
        }

        let path = null
        try {
            path = execSync('which ffprobe', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
        } catch {
            throw new Error("Required dependency 'ffprobe' not found in PATH - it normally ships alongside ffmpeg")
        }
        try {
            accessSync(path, constants.X_OK)
        } catch {
            throw new Error(`Resolved ffprobe '${path}' does not exist or is not executable`)
        }

        this.#log.log(`Found 'ffprobe' at: ${path}`)
        this.#ffprobePath = path
        return path
    }

    /** @returns {boolean} Whether to respond immediately without waiting for pipeline */
    get fireAndForget() {
        const val = this.#raw.FIRE_AND_FORGET
        return val === 'true' || val === '1'
    }

    /**
     * Maximum number of pipelines allowed to run concurrently.
     * Requests beyond the limit are rejected with HTTP 429 until a slot frees up.
     * @returns {number} The configured limit, or 0 when unlimited (default / invalid values)
     */
    get maxConcurrentPipelines() {
        const val = Number.parseInt(this.#raw.MAX_CONCURRENT_PIPELINES ?? '', 10)
        return Number.isInteger(val) && val > 0 ? val : 0
    }

    /**
     * Resolve a binary path from an optional env var, falling back to looking it up in $PATH.
     * Validates the resolved path exists and is executable.
     * @param {string} envVar - Environment variable name (e.g., "PATH_PIPER")
     * @param {string} fallbackName - Fallback command name (e.g., "piper")
     * @returns {string} Resolved absolute path
     */
    #resolveBinary(envVar, fallbackName) {
        let path = this.#raw[envVar] || null

        // If no custom path provided, try to resolve via `which` / `where`
        if (!path) {
            try {
                path = execSync(`which ${fallbackName}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
            } catch {
                this.#log.error(`ERROR: Required dependency '${fallbackName}' not found in PATH`)
                this.#log.error('')
                this.#log.error(`Install it or set ${envVar}=/full/path/to/${fallbackName}`)
                process.exit(1)
            }
        }

        // Validate the resolved/override path exists and is executable
        try {
            accessSync(path, constants.X_OK)
        } catch {
            this.#log.error(`ERROR: ${envVar} points to '${path}' which does not exist or is not executable`)
            process.exit(1)
        }

        this.#log.log(`Found '${fallbackName}' at: ${path}`)
        return path
    }
}