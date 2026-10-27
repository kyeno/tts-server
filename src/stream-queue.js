/**
 * Per-endpoint in-memory stream queue.
 *
 * Queues generated WAV files by output endpoint and flushes them serially:
 * stream item -> cleanup item -> pause if more items exist -> next item.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import Logger from './logger.js'

export default class EndpointStreamQueue {
    #config
    #log
    #queues = new Map()
    #closing = false

    /**
     * @param {import('./config.js').default} config - Application configuration
     * @param {Logger} [log] - Logger instance
     */
    constructor(config, log) {
        this.#config = config
        this.#log = log || new Logger({ namespace: 'StreamQueue' })
    }

    /**
     * Enqueue a prepared WAV file for streaming to an endpoint.
     * @param {{ host: string, port: string }} endpoint - Netcat target
     * @param {object} item - Queue item
     * @param {string} item.jobId - Job identifier
     * @param {string} item.wavPath - Path to the WAV file to stream
     * @param {Function} item.cleanup - Cleanup callback for temp files
     * @param {Logger} [item.log] - Optional job logger
     * @returns {Promise<void>} Resolves when this item has been streamed and cleaned up
     */
    enqueue(endpoint, item) {
        if (this.#closing) {
            return Promise.reject(new Error('Stream queue is shutting down'))
        }

        const key = this.#key(endpoint)
        let state = this.#queues.get(key)
        if (!state) {
            state = { key, endpoint, items: [], flushing: false }
            this.#queues.set(key, state)
        }

        let resolve
        let reject
        const done = new Promise((res, rej) => {
            resolve = res
            reject = rej
        })

        state.items.push({ ...item, endpoint, resolve, reject })

        this.#log.log(
            `Queued stream for ${endpoint.host}:${endpoint.port} ` +
            `(job ${item.jobId}, queue length ${state.items.length})`
        )

        if (!state.flushing) {
            state.flushing = true
            this.#flushLoop(key, state).catch((err) => {
                this.#log.error(
                    `Stream queue flush loop failed for ${endpoint.host}:${endpoint.port}: ` +
                    `${err?.message || String(err)}`
                )
            })
        }

        // Prevent unhandled rejections for callers that intentionally fire-and-forget.
        done.catch(() => {})
        return done
    }

    async #flushLoop(key, state) {
        this.#log.log(`Starting stream queue flush for ${state.endpoint.host}:${state.endpoint.port}`)

        while (state.items.length > 0) {
            const item = state.items.shift()

            try {
                await this.#streamItem(item)
                item.resolve()
            } catch (err) {
                item.reject(err)
            } finally {
                this.#cleanupItem(item)
            }

            if (state.items.length > 0) {
                const pauseMs = this.#config.streamQueuePauseMs
                this.#log.log(
                    `Queue flush: pausing ${pauseMs} ms before next item for ` +
                    `${state.endpoint.host}:${state.endpoint.port}`
                )
                await this.#sleep(pauseMs)
            }
        }

        state.flushing = false
        if (state.items.length === 0) {
            this.#queues.delete(key)
        }
    }

    #streamItem(item) {
        return new Promise((resolve, reject) => {
            const errChunks = []
            const filePath = item.wavPath
            const log = item.log || this.#log

            log.log(`Queue flush: streaming job ${item.jobId} to ${item.endpoint.host}:${item.endpoint.port}`)

            let nc
            try {
                nc = spawn(this.#config.netcatPath, [item.endpoint.host, item.endpoint.port], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: process.env,
                })
            } catch (err) {
                return reject(new Error(`Failed to spawn netcat: ${err.message}`))
            }

            nc.stderr.on('data', (chunk) => errChunks.push(chunk))

            // If the child exits early (e.g., the client went away), stop writing;
            // the close event below reports the outcome with the usual semantics.
            nc.stdin.on('error', () => {})

            const audio = createReadStream(filePath)
            audio.on('error', (err) => {
                nc.kill()
                reject(new Error(`Failed to read audio file '${filePath}': ${err.message}`))
            })
            audio.pipe(nc.stdin)

            nc.on('error', (err) => {
                reject(new Error(`Failed to spawn netcat: ${err.message}`))
            })

            nc.on('close', (code) => {
                if (code !== 0) {
                    const stderr = Buffer.concat(errChunks).toString().trim()
                    log.warn(
                        `Netcat exited with code ${code}: ${stderr || 'connection may have closed'}`
                    )
                } else {
                    log.log('Audio streamed successfully via netcat')
                }
                resolve()
            })
        })
    }

    #cleanupItem(item) {
        try {
            item.cleanup?.()
        } catch (err) {
            this.#log.warn(`Queue cleanup failed for job ${item.jobId}: ${err?.message || String(err)}`)
        }
    }

    #key(endpoint) {
        return createHash('sha1').update(`${endpoint.host}:${endpoint.port}`).digest('hex')
    }

    #sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /** @returns {object} Debug snapshot of active queues */
    get stats() {
        const snapshot = {}
        for (const [key, state] of this.#queues.entries()) {
            snapshot[key] = {
                endpoint: `${state.endpoint.host}:${state.endpoint.port}`,
                length: state.items.length,
                flushing: state.flushing,
            }
        }
        return snapshot
    }

    /**
     * Discard queued items during graceful shutdown.
     * @returns {Promise<void>}
     */
    async discard() {
        this.#closing = true
        const states = [...this.#queues.values()]
        this.#queues.clear()

        for (const state of states) {
            for (const item of state.items) {
                this.#log.warn(
                    `Discarding queued stream for ${state.endpoint.host}:${state.endpoint.port} ` +
                    `(job ${item.jobId})`
                )
                this.#cleanupItem(item)
                item.resolve()
            }
        }
    }
}

