/**
 * Represents a single TTS processing pipeline.
 * Instantiated per request, runs the Piper -> Sox -> Ffmpeg -> Netcat stages, then cleans up temp files.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { execFile, spawn } from 'node:child_process'
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
    #introPath
    #outroPath
    #introSpacing
    #streamQueue = null

    // Temp file paths tracked for cleanup
    #piperWav = null
    #processedWav = null
    #finalWav = null

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
     * @param {string|null} [options.introPath] - Absolute path to an optional intro sound file
     * @param {string|null} [options.outroPath] - Absolute path to an optional outro sound file
     * @param {number|null} [options.introSpacing] - Seconds between end of intro and start of speech (negative mixes them)
     * @param {import('./stream-queue.js').default} [options.streamQueue] - Per-endpoint stream queue
     */
    constructor({ config, jobId, log, modelPath, text, piperEffects, soxEffects, endpoint, introPath, outroPath, introSpacing, streamQueue }) {
        this.#config = config
        this.#jobId = jobId
        this.#log = log || new Logger({ namespace: 'Pipeline', jobId })
        this.#modelPath = modelPath
        this.#text = text
        this.#piperEffects = piperEffects || null
        this.#soxEffects = soxEffects || null
        this.#endpoint = endpoint || null
        this.#introPath = introPath || null
        this.#outroPath = outroPath || null
        this.#introSpacing = typeof introSpacing === 'number' ? introSpacing : null
        this.#streamQueue = streamQueue || null

        this.#piperWav = `${this.#config.tempDir}${jobId}-piper.wav`
    }

    /** @returns {string} Job ID */
    get jobId() {
        return this.#jobId
    }

    /**
     * Execute the full pipeline: prepare audio, then queue it for streaming.
     * @returns {Promise<void>} Resolves on success, rejects on failure
     */
    async run() {
        const prepared = await this.prepare()
        await this.stream(prepared)
    }

    /**
     * Generate the final WAV file without streaming it.
     * @returns {Promise<{ wavPath: string, cleanup: Function }>}
     */
    async prepare() {
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

            // Stage 3: Ffmpeg intro/outro concatenation (optional)
            if (this.#introPath || this.#outroPath) {
                await this.#runFfmpeg()
                this.#log.log('Ffmpeg intro/outro concatenation completed')
            } else {
                this.#log.log('Skipping ffmpeg (no intro/outro specified)')
            }

            const wavPath = this.#finalWav || this.#processedWav || this.#piperWav
            if (!wavPath) {
                throw new Error('Pipeline produced no output WAV file')
            }

            this.#log.log('TTS preparation complete')
            return { wavPath, cleanup: () => this.#destroy() }
        } catch (err) {
            this.#log.error('Pipeline preparation failed, cleaning up...')
            this.#destroy()
            throw err
        }
    }

    /**
     * Queue the prepared WAV file for endpoint streaming.
     * @param {{ wavPath: string, cleanup: Function }} prepared
     * @returns {Promise<void>}
     */
    async stream(prepared) {
        if (!this.#endpoint) {
            this.#log.log('Skipping netcat (no output endpoint specified)')
            prepared.cleanup()
            return
        }

        if (!this.#streamQueue) {
            prepared.cleanup()
            throw new Error('Pipeline requires a stream queue to stream to an endpoint')
        }

        try {
            await this.#streamQueue.enqueue(this.#endpoint, {
                jobId: this.#jobId,
                wavPath: prepared.wavPath,
                cleanup: prepared.cleanup,
                log: this.#log,
            })
            this.#log.log('Queued stream completed')
        } catch (err) {
            prepared.cleanup()
            throw err
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
        this.#cleanup(this.#finalWav)
        // Clear references for garbage collection
        this.#piperWav = null
        this.#processedWav = null
        this.#finalWav = null
        this.#modelPath = null
        this.#text = null
        this.#endpoint = null
        this.#introPath = null
        this.#outroPath = null
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
     * Stage 3: Concatenate optional intro/outro sound files around the main WAV using ffmpeg.
     * All inputs are normalized to mono 22050 Hz first; output is written as RIFF/WAVE,
     * Microsoft PCM 16-bit little-endian, mono, 22050 Hz.
     * A positive intro_spacing inserts silence between the end of the intro and the start of
     * the speech; a negative value overlaps (mixes) that many seconds of the end of the intro
     * with the start of the speech, clamped to the actual length of both segments.
     * @returns {Promise<void>}
     */
    async #runFfmpeg() {
        let ffmpegBin
        try {
            ffmpegBin = this.#config.getFfmpegPath()
        } catch (err) {
            throw new Error(`Failed to resolve ffmpeg binary: ${err.message}`)
        }

        // Ordered input list: [intro] -> speech -> [outro]
        const mainWav = this.#processedWav || this.#piperWav
        const sources = []
        if (this.#introPath) sources.push(this.#introPath)
        const hasIntro = sources.length > 0
        const introIdx = 0
        const speechIdx = hasIntro ? 1 : 0
        sources.push(mainWav)
        const outroIdx = this.#outroPath ? sources.length : null
        if (this.#outroPath) sources.push(this.#outroPath)

        // Normalize every raw audio stream so all downstream filters operate on uniform data
        const filters = sources.map(
            (_, i) => `[${i}:a]aformat=sample_rates=22050:channel_layouts=mono[n${i}]`
        )

        // Plan the ordered segments that will be concatenated into the final output
        const parts = []
        const spacing = hasIntro && typeof this.#introSpacing === 'number' ? this.#introSpacing : 0

        if (spacing > 0) {
            // Silence gap between the end of the intro and the start of the speech
            filters.push(`[n${introIdx}]apad=pad_dur=${spacing}[gap]`)
            parts.push('gap', `n${speechIdx}`)
        } else if (spacing < 0) {
            const [introDur, speechDur] = await Promise.all([
                this.#probeDuration(sources[introIdx]),
                this.#probeDuration(sources[speechIdx]),
            ])
            const overlap = Math.min(-spacing, introDur, speechDur)
            if (overlap <= 0.001) {
                // Degenerate case - nothing left to mix, fall back to plain concatenation
                parts.push(`n${introIdx}`, `n${speechIdx}`)
            } else {
                const cut = +(introDur - overlap).toFixed(3)
                const headPart = cut > 0.001 ? 'ahead' : null
                const restPart = speechDur - overlap > 0.001 ? 'srest' : null
                // Split each stream explicitly before branching into two trim chains;
                // letting sibling atrim filters share one input makes ffmpeg under-deliver frames
                if (headPart) {
                    filters.push(`[n${introIdx}]asplit=2[iA][iT]`)
                    filters.push(`[iA]atrim=end=${cut},asetpts=PTS-STARTPTS[ahead]`)
                    filters.push(`[iT]atrim=start=${cut},asetpts=PTS-STARTPTS[tailA]`)
                } else {
                    filters.push(`[n${introIdx}]atrim=start=${cut},asetpts=PTS-STARTPTS[tailA]`)
                }
                if (restPart) {
                    filters.push(`[n${speechIdx}]asplit=2[sH][sR]`)
                    filters.push(`[sH]atrim=duration=${overlap.toFixed(3)},asetpts=PTS-STARTPTS[shead]`)
                    filters.push(`[sR]atrim=start=${overlap.toFixed(3)},asetpts=PTS-STARTPTS[srest]`)
                } else {
                    filters.push(`[n${speechIdx}]atrim=duration=${overlap.toFixed(3)},asetpts=PTS-STARTPTS[shead]`)
                }
                // Mix the overlapping tail/head together at full volume (no auto-normalization)
                filters.push('[tailA][shead]amix=inputs=2:normalize=0[mx]')
                parts.push(...(headPart ? [headPart] : []), 'mx', ...(restPart ? [restPart] : []))
            }
        } else {
            // No spacing requested - plain concatenation of all normalized inputs
            // (the outro index is appended below exactly once, like in the spaced branches)
            sources.forEach((_, i) => { if (i !== outroIdx) parts.push(`n${i}`) })
        }

        if (outroIdx !== null) {
            parts.push(`n${outroIdx}`)
        }

        const concatLabels = parts.map((p) => `[${p}]`).join('')
        filters.push(`${concatLabels}concat=n=${parts.length}:v=0:a=1[out]`)
        const filterComplex = filters.join(';')

        this.#finalWav = `${this.#config.tempDir}${this.#jobId}-final.wav`

        const args = ['-nostdin', '-y']
        for (const src of sources) {
            args.push('-i', src)
        }
        args.push(
            '-filter_complex', filterComplex,
            '-map', '[out]',
            '-ar', '22050',
            '-ac', '1',
            '-c:a', 'pcm_s16le',
            this.#finalWav
        )

        this.#log.log(`Concatenating ${sources.length} segment(s), intro_spacing=${spacing}s -> ${this.#finalWav}`)

        await new Promise((resolve, reject) => {
            const errChunks = []
            const ffmpeg = spawn(ffmpegBin, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: process.env,
            })

            ffmpeg.stderr.on('data', (chunk) => errChunks.push(chunk))
            ffmpeg.on('error', (err) => reject(new Error(`Failed to spawn ffmpeg: ${err.message}`)))
            ffmpeg.stdin.end()

            ffmpeg.on('close', (code) => {
                if (code !== 0) {
                    const stderr = Buffer.concat(errChunks).toString().trim()
                    return reject(new Error(`Ffmpeg failed with exit code ${code}: ${stderr || 'no error message'}`))
                }
                // The main WAV has been absorbed into the final file - clean it up eagerly like sox does
                this.#cleanup(mainWav)
                if (mainWav === this.#piperWav) {
                    this.#piperWav = null
                    this.#processedWav = null   // aliases piperWav when sox was skipped
                } else {
                    this.#processedWav = null
                }
                resolve()
            })
        })
    }

    /**
     * Probe the duration of an audio file in seconds using ffprobe.
     * @param {string} filePath - Path to the media file
     * @returns {Promise<number>} Duration in seconds
     */
    #probeDuration(filePath) {
        return new Promise((resolve, reject) => {
            let ffprobeBin
            try {
                ffprobeBin = this.#config.getFfprobePath()
            } catch (err) {
                return reject(new Error(`Failed to resolve ffprobe binary: ${err.message}`))
            }
            execFile(ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], (err, stdout) => {
                if (err) {
                    return reject(new Error(`ffprobe failed for '${filePath}': ${err.message}`))
                }
                const dur = parseFloat(stdout.trim())
                if (!Number.isFinite(dur) || dur < 0) {
                    return reject(new Error(`Could not determine duration of '${filePath}'`))
                }
                resolve(dur)
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