/**
 * Main TTS server class.
 * Orchestrates configuration, model registry, routing, and HTTP server lifecycle.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { createServer } from 'node:http'
import Config from './config.js'
import Logger from './logger.js'
import ModelRegistry from './model-registry.js'
import Router from './router.js'
import Controller from './controller.js'

/**
 * Main TTS server class.
 * Orchestrates configuration, model registry, routing, and HTTP lifecycle.
 */
export default class Server {
    #config
    #log
    #models
    #controller
    #router
    #httpServer

    /**
     * @param {Logger} [log] - Optional root logger (created if omitted for backward compatibility)
     */
    constructor(log) {
        this.#log = log || new Logger({ namespace: 'Server' })

        // Initialize configuration with logger
        const configLog = this.#log.child('Config')
        this.#config = new Config(process.env, configLog)

        // Initialize model registry with logger
        const modelLog = this.#log.child('ModelRegistry')
        this.#models = new ModelRegistry(this.#config.modelDir, modelLog)

        // Initialize controller with dependencies injected
        const controllerLog = this.#log.child('Controller')
        this.#controller = new Controller(this.#config, this.#models, controllerLog)

        // Build router and register routes
        this.#router = new Router(this.#log.child('Router'))
        this.#registerRoutes()

        // Logging
        if (this.#config.useRamDisk) {
            this.#log.log(`Models served from RAM disk: ${this.#config.modelDir}`)
        } else {
            this.#log.log(`Model directory: ${this.#config.modelDir}`)
        }
        this.#log.log(`Temp directory: ${this.#config.tempDir}`)
        this.#log.log(`Available models (${this.#models.count}): ${this.#models.models.join(', ')}`)
    }

    /** @returns {Config} */
    get config() {
        return this.#config
    }

    /** @returns {ModelRegistry} */
    get models() {
        return this.#models
    }

    /**
     * Register all application routes with the router.
     */
    #registerRoutes() {
        this.#router.use('GET', '/', this.#controller.handleRoot.bind(this.#controller))
        this.#router.use('GET', '/health', this.#controller.handleHealth.bind(this.#controller))
        this.#router.use('GET', '/models', this.#controller.handleModels.bind(this.#controller))
        this.#router.use('POST', '/tts', this.#controller.handleTts.bind(this.#controller))
    }

    /**
     * Start the HTTP server and listen for incoming requests.
     * @returns {Promise<void>}
     */
    start() {
        const { host, port } = this.#config.serverAddress

        this.#httpServer = createServer((req, res) => {
            this.#router.dispatch(req, res)
        })

        this.#httpServer.listen(port, host, () => {
            this.#log.log(`Server is listening on ${this.#config.serverBind}`)
        })

        // Graceful shutdown handlers
        process.on('SIGTERM', () => {
            this.#log.log('SIGTERM received, shutting down gracefully...')
            this.stop()
        })

        process.on('SIGINT', () => {
            this.#log.log('SIGINT received, shutting down...')
            this.stop()
        })
    }

    /**
     * Stop the HTTP server and close all connections.
     * @returns {Promise<void>}
     */
    stop() {
        // Clean up RAM disk before closing server
        this.#config.cleanupRamDisk()

        return new Promise((resolve) => {
            if (!this.#httpServer) {
                resolve()
                return
            }
            this.#httpServer.close(() => {
                this.#log.log('HTTP server closed.')
                this.#httpServer = null
                resolve()
            })
        })
    }
}