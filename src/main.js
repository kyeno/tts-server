/**
 * Application entry point. Initializes the logger and server, then starts listening.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import Logger from './logger.js'
import Server from './server.js'

const log = new Logger({ namespace: 'Main' })
const app = new Server(log)
app.start()