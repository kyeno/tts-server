/**
 * Simple logger that wraps console methods with timestamp and namespace support.
 *
 * Usage:
 *   const log = new Logger({ namespace: 'Server' })
 *   log.log('hello')        // [2026-07-20T10:30:00.000Z] [Server] hello
 *   log.error('fail')       // [2026-07-20T10:30:00.000Z] [Server] fail
 *
 *   const reqLog = log.child('Controller', jobId)
 *   reqLog.log('request')   // [2026-07-20T10:30:00.000Z] [Controller] [a1b2c3d4] request
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */
export default class Logger {
    /**
     * @param {object} options
     * @param {string} [options.namespace='App'] - Label prefixed to every log line
     * @param {string|null} [options.jobId=null] - Optional job identifier
     */
    constructor({ namespace = 'App', jobId = null } = {}) {
        this.namespace = namespace
        this.jobId = jobId
    }

    /**
     * Build the timestamped prefix string for a log line.
     * @returns {string} Formatted prefix, e.g. "2026-07-20T10:30:00.000Z [Server]"
     */
    #prefix() {
        const ts = new Date().toISOString()
        const jobPart = this.jobId ? ` [${this.jobId}]` : ''
        return `${ts} [${this.namespace}]${jobPart}`
    }

    /**
     * Log an informational message to stdout.
     * @param  {...*} args - Values to log
     */
    log(...args) {
        console.log(this.#prefix(), ...this.#sanitizeArgs(args))
    }

    /**
     * Log an error message to stderr.
     * @param  {...*} args - Values to log
     */
    error(...args) {
        console.error(this.#prefix(), ...this.#sanitizeArgs(args))
    }

    /**
     * Log a warning message to stderr.
     * @param  {...*} args - Values to log
     */
    warn(...args) {
        console.warn(this.#prefix(), ...this.#sanitizeArgs(args))
    }

    /**
     * Log an info message to stdout.
     * @param  {...*} args - Values to log
     */
    info(...args) {
        console.info(this.#prefix(), ...this.#sanitizeArgs(args))
    }

    /**
     * Strip C0 control characters from string arguments so that user-supplied input
     * (text, file names, endpoints...) cannot forge or corrupt individual log lines.
     * Control characters are replaced by their \xNN escape form for traceability.
     * @param {*}[] args - Original argument list
     * @returns {*[]} Sanitized copy of the argument list
     */
    #sanitizeArgs(args) {
        return args.map((arg) => typeof arg === 'string'
            ? arg.replace(/[\u0000-\u001f\u007f]/g, (ch) => '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'))
            : arg)
    }

    /**
     * Create a child logger with a new namespace and/or jobId.
     * @param {string} [namespace] - New namespace (inherits from parent if omitted)
     * @param {string|null} [jobId] - Job identifier (inherits from parent if omitted)
     * @returns {Logger}
     */
    child(namespace, jobId) {
        return new Logger({
            namespace: namespace ?? this.namespace,
            jobId: jobId !== undefined ? jobId : this.jobId,
        })
    }
}