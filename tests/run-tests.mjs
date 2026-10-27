#!/usr/bin/env node
/**
 * Integration tests for the TTS server pipeline and controller.
 *
 * Zero external dependencies beyond the Node.js standard library plus ffmpeg/ffprobe
 * (on $PATH or next to PATH_FFMPEG) and file(1). Piper, Sox and netcat are replaced by
 * shell shims, so no real Piper installation or network endpoint is required.
 *
 * Run with: npm run test   (or directly: node tests/run-tests.mjs)
 */

import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Config from '../src/config.js'
import Pipeline from '../src/pipeline.js'
import Controller, { MAX_BODY_BYTES, MAX_TEXT_LENGTH } from '../src/controller.js'
import EndpointStreamQueue from '../src/stream-queue.js'
import ModelRegistry from '../src/model-registry.js'

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let failures = 0
function check(label, cond, extra = '') {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ` -- ${extra}` : ''}`)
    if (!cond) failures++
}

const silentLog = { log() {}, error() {}, warn() {}, info() {}, child() { return silentLog } }
const EXPECTED_FORMAT = 'RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 22050 Hz'

// ---------- scratch environment ----------
const T = mkdtempSync(path.join(os.tmpdir(), 'tts-server-test-'))
for (const d of ['models', 'tmp', 'sounds', 'fakebin']) {
    mkdirSync(path.join(T, d), { recursive: true })
}
writeFileSync(path.join(T, 'models', 'test-voice.onnx'), '')
writeFileSync(path.join(T, 'models', 'test-voice.json'), '{}')

// Piper shim: copies the canned "speech" WAV to whatever path follows --output-file
writeFileSync(path.join(T, 'fakebin', 'piper.sh'), [
    '#!/bin/sh',
    'out=""',
    'prev=""',
    'for a in "$@"; do',
    '    if [ "$prev" = "--output-file" ]; then out="$a"; fi',
    '    prev="$a"',
    'done',
    '[ -n "$out" ] || exit 1',
    `cat "${T}/main.wav" > "$out"`,
    'exit 0',
].join('\n') + '\n')
// Sox shim: passes input through unchanged (effects are ignored)
writeFileSync(path.join(T, 'fakebin', 'sox.sh'), '#!/bin/sh\ncat "$1" > "$2"\nexit 0\n')
// Netcat shim: captures the streamed audio for inspection
writeFileSync(path.join(T, 'fakebin', 'nc.sh'), `#!/bin/sh\ncat > "${T}/captured.wav"\nexit 0\n`)
// Netcat shim: appends streamed audio to a queue log for queue-order tests
writeFileSync(path.join(T, 'fakebin', 'nc-append.sh'), `#!/bin/sh\ncat >> "${T}/queue.log"\nexit 0\n`)
// Netcat shim: appends a start marker, delays, then appends audio for queue timing tests
writeFileSync(path.join(T, 'fakebin', 'nc-slow-append.sh'), `#!/bin/sh\necho START >> "${T}/queue.log"\nsleep 0.5\ncat >> "${T}/queue.log"\nexit 0\n`)
// Piper "slow" variant: delays synthesis so concurrency-limit tests can observe in-flight jobs
writeFileSync(path.join(T, 'fakebin', 'piper-slow.sh'), [
    '#!/bin/sh',
    'sleep 0.3',
    'out=""',
    'prev=""',
    'for a in "$@"; do',
    '    if [ "$prev" = "--output-file" ]; then out="$a"; fi',
    '    prev="$a"',
    'done',
    '[ -n "$out" ] || exit 1',
    `cat "${T}/main.wav" > "$out"`,
    'exit 0',
].join('\n') + '\n')
for (const f of ['piper.sh', 'piper-slow.sh', 'sox.sh', 'nc.sh', 'nc-append.sh', 'nc-slow-append.sh']) {
    chmodSync(path.join(T, 'fakebin', f), 0o755)
}

function sh(cmd, args) {
    return new Promise((resolve, reject) => execFile(cmd, args, (err, stdout) => err ? reject(err) : resolve(stdout)))
}
async function binAvailable(name) {
    try { await sh(name, ['-version']); return true } catch { return false }
}
function ff(args) {
    return sh('ffmpeg', ['-v', 'error', '-y', ...args])
}

if (!(await binAvailable('ffmpeg')) || !(await binAvailable('ffprobe'))) {
    console.error('ERROR: tests require ffmpeg and ffprobe to be installed and available on $PATH.')
    process.exit(2)
}

// Fixture audio - deliberately mismatched formats to exercise normalization
await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '22050', '-ac', '1', '-c:a', 'pcm_s16le', `${T}/main.wav`])
await ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.5', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', path.join(T, 'sounds', 'intro.wav')])
await ff(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.5', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(T, 'sounds', 'outro.wav')])

const envBase = {
    DIR_MODEL: path.join(T, 'models'),
    PATH_PIPER: path.join(T, 'fakebin', 'piper.sh'),
    PATH_SOX: path.join(T, 'fakebin', 'sox.sh'),
    PATH_NETCAT: path.join(T, 'fakebin', 'nc.sh'),
    DIR_TEMP: path.join(T, 'tmp') + '/',
    DIR_SOUNDS: path.join(T, 'sounds'),
}

async function runPipeline(config, opts) {
    const queue = new EndpointStreamQueue(config, silentLog)
    const p = new Pipeline({ config, jobId: `job-${Math.random().toString(36).slice(2)}`, streamQueue: queue, ...opts })
    await p.run()
}
function resetCapture() { rmSync(`${T}/captured.wav`, { force: true }) }
async function capturedInfo() {
    const format = (await sh('file', ['-b', `${T}/captured.wav`])).trim()
    const duration = parseFloat(await sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${T}/captured.wav`]))
    return { format, duration }
}
const tempClean = () => readdirSync(path.join(T, 'tmp')).length === 0
const near = (a, b, tol = 0.05) => Math.abs(a - b) < tol
const resetQueueLog = () => rmSync(`${T}/queue.log`, { force: true })
const queueLog = () => existsSync(`${T}/queue.log`) ? readFileSync(`${T}/queue.log`).toString() : ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(cond, timeout = 2000) {
    const start = Date.now()
    while (!cond()) {
        if (Date.now() - start > timeout) return false
        await sleep(20)
    }
    return true
}
let info = null

try {
    // ---------- P1: intro + outro concatenation ----------
    resetCapture()
    {
        const config = new Config(envBase, silentLog)
        await runPipeline(config, {
            modelPath: path.join(T, 'models', 'test-voice.onnx'), text: 'hello world',
            endpoint: { host: '127.0.0.1', port: '9' },
            introPath: path.join(T, 'sounds', 'intro.wav'), outroPath: path.join(T, 'sounds', 'outro.wav'),
        })
        info = await capturedInfo()
    }
    check('P1 concat format is RIFF PCM s16 mono 22050 Hz', info.format === EXPECTED_FORMAT, info.format)
    check('P1 duration ~2.0s (intro+speech+outro)', near(info.duration, 2.0), `duration=${info.duration}`)
    check('P1 temp dir cleaned up', tempClean())

    // ---------- P2: outro only ----------
    resetCapture()
    {
        const config = new Config(envBase, silentLog)
        await runPipeline(config, {
            modelPath: path.join(T, 'models', 'test-voice.onnx'), text: 'hello world',
            endpoint: { host: '127.0.0.1', port: '9' },
            outroPath: path.join(T, 'sounds', 'outro.wav'),
        })
        info = await capturedInfo()
    }
    check('P2 duration ~1.5s (speech+outro)', near(info.duration, 1.5), `duration=${info.duration}`)
    check('P2 temp dir cleaned up', tempClean())

    // ---------- P3: no intro/outro -> unchanged passthrough ----------
    resetCapture()
    {
        const config = new Config(envBase, silentLog)
        await runPipeline(config, {
            modelPath: path.join(T, 'models', 'test-voice.onnx'), text: 'hello world',
            endpoint: { host: '127.0.0.1', port: '9' },
        })
    }
    check('P3 capture byte-identical to piper output (ffmpeg not invoked)', readFileSync(`${T}/captured.wav`).equals(readFileSync(`${T}/main.wav`)))
    check('P3 temp dir cleaned up', tempClean())

    // ---------- P4: positive intro_spacing inserts silence after intro ----------
    resetCapture()
    {
        const config = new Config(envBase, silentLog)
        await runPipeline(config, {
            modelPath: path.join(T, 'models', 'test-voice.onnx'), text: 'hello world',
            endpoint: { host: '127.0.0.1', port: '9' },
            introPath: path.join(T, 'sounds', 'intro.wav'), outroPath: path.join(T, 'sounds', 'outro.wav'),
            introSpacing: 0.5,
        })
        info = await capturedInfo()
    }
    check('P4 duration ~2.5s (intro+gap+speech+outro)', near(info.duration, 2.5), `duration=${info.duration}`)
    check('P4 format ok', info.format === EXPECTED_FORMAT, info.format)
    check('P4 temp dir cleaned up', tempClean())

    // ---------- P5: negative intro_spacing overlaps/mixes segments ----------
    resetCapture()
    {
        const config = new Config(envBase, silentLog)
        await runPipeline(config, {
            modelPath: path.join(T, 'models', 'test-voice.onnx'), text: 'hello world',
            endpoint: { host: '127.0.0.1', port: '9' },
            introPath: path.join(T, 'sounds', 'intro.wav'), outroPath: path.join(T, 'sounds', 'outro.wav'),
            introSpacing: -0.25,
        })
        info = await capturedInfo()
    }
    check('P5 duration ~1.75s (overlap applied)', near(info.duration, 1.75), `duration=${info.duration}`)
    check('P5 format ok', info.format === EXPECTED_FORMAT, info.format)
    check('P5 temp dir cleaned up', tempClean())

    // ---------- P6: overlap larger than available audio is clamped ----------
    resetCapture()
    {
        const config = new Config(envBase, silentLog)
        await runPipeline(config, {
            modelPath: path.join(T, 'models', 'test-voice.onnx'), text: 'hello world',
            endpoint: { host: '127.0.0.1', port: '9' },
            introPath: path.join(T, 'sounds', 'intro.wav'), outroPath: path.join(T, 'sounds', 'outro.wav'),
            introSpacing: -999,
        })
        info = await capturedInfo()
    }
    check('P6 extreme negative spacing clamps to full intro (~1.5s total)', near(info.duration, 1.5), `duration=${info.duration}`)
    check('P6 format ok', info.format === EXPECTED_FORMAT, info.format)
    check('P6 temp dir cleaned up', tempClean())

    // ---------- P7: sox effects still applied before concatenation ----------
    resetCapture()
    {
        const config = new Config(envBase, silentLog)
        await runPipeline(config, {
            modelPath: path.join(T, 'models', 'test-voice.onnx'), text: 'hello world',
            endpoint: { host: '127.0.0.1', port: '9' },
            soxEffects: 'gain -3',
            introPath: path.join(T, 'sounds', 'intro.wav'), outroPath: path.join(T, 'sounds', 'outro.wav'),
        })
        info = await capturedInfo()
    }
    check('P7 duration ~2.0s with sox + concat', near(info.duration, 2.0), `duration=${info.duration}`)
    check('P7 format ok', info.format === EXPECTED_FORMAT, info.format)
    check('P7 temp dir cleaned up', tempClean())

    // ---------- DIR_SOUNDS relative resolution ----------
    {
        const norm = (p) => p.replace(/\/+$/, '')
        const expectedRoot = path.join(PROJECT_ROOT, 'sounds')
        const cfgRel = new Config({ ...envBase, DIR_SOUNDS: 'sounds/' }, silentLog)
        check('relative DIR_SOUNDS resolves against project root', norm(cfgRel.soundsDir) === norm(expectedRoot), cfgRel.soundsDir)
        const defEnv = { ...envBase }
        delete defEnv.DIR_SOUNDS
        const cfgDef = new Config(defEnv, silentLog)
        check('default soundsDir is <project>/sounds', norm(cfgDef.soundsDir) === norm(expectedRoot), cfgDef.soundsDir)
    }

    // ---------- controller-level tests (mocked req/res) ----------
    function mockRequest() {
        const req = new EventEmitter()
        req.method = 'POST'
        req.headers = { 'content-type': 'application/json' }
        req.socket = { remoteAddress: '127.0.0.1' }
        req.destroy = () => {}
        return req
    }
    function emitBody(req, bodyObj) {
        req.emit('data', Buffer.from(JSON.stringify(bodyObj)))
        req.emit('end')
    }
    function mockResponse() {
        const res = {}
        let resolveDone
        res.done = new Promise((r) => { resolveDone = r })
        res.writeHead = (code) => { res.statusCode = code }
        res.end = (body) => { res.body = body ? JSON.parse(String(body)) : null; resolveDone() }
        return res
    }

    const controllerConfig = new Config(envBase, silentLog)
    const models = new ModelRegistry(controllerConfig.modelDir, silentLog)
    const controller = new Controller(controllerConfig, models, silentLog)

    async function postTts(configOverride, body) {
        resetCapture()
        resetQueueLog()
        const cfg = configOverride || controllerConfig
        const ctrl = configOverride ? new Controller(cfg, new ModelRegistry(cfg.modelDir, silentLog), silentLog) : controller
        const req = mockRequest()
        const res = mockResponse()
        const p = ctrl.handleTts(req, res)
        emitBody(req, body)
        await p
        return res
    }

    // ---------- C1: full request with intro+outro via handler ----------
    let r = await postTts(null, { model: 'test-voice', text: 'hello world', output_endpoint: '127.0.0.1:9', intro: 'intro.wav', outro: 'outro.wav' })
    check('C1 status 200 ok', r.statusCode === 200 && r.body?.status === 'ok', JSON.stringify(r.body))
    if (existsSync(`${T}/captured.wav`)) {
        info = await capturedInfo()
        check('C1 streamed format ok', info.format === EXPECTED_FORMAT, info.format)
        check('C1 duration ~2.0s', near(info.duration, 2.0), `duration=${info.duration}`)
    } else {
        check('C1 capture exists', false)
    }

    // ---------- C2-C5: intro/outro validation errors ----------
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', intro: 'nope.wav' })
    check('C2 missing file -> 400 not found in sounds dir', r.statusCode === 400 && /not found in/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', outro: '../etc/passwd' })
    check('C3 traversal path rejected -> 400 plain name only', r.statusCode === 400 && /plain file name/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', intro: '/etc/passwd' })
    check('C4 absolute path rejected -> 400 plain name only', r.statusCode === 400 && /plain file name/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', intro: 5 })
    check('C5a non-string intro -> 400', r.statusCode === 400 && /non-empty string/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', outro: '' })
    check('C5b empty outro -> 400', r.statusCode === 400 && /string/.test(r.body.detail), JSON.stringify(r.body))

    // ---------- C6: broken PATH_FFMPEG surfaces a helpful 500 ----------
    const badConfig = new Config({ ...envBase, PATH_FFMPEG: '/nonexistent/ffmpeg' }, silentLog)
    r = await postTts(badConfig, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', intro: 'intro.wav' })
    check('C6 missing ffmpeg binary -> 500 PipelineError with hint', r.statusCode === 500 && r.body.error === 'PipelineError' && /PATH_FFMPEG|ffmpeg/.test(r.body.detail), JSON.stringify(r.body))

    // ---------- C7: intro_spacing validation ----------
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', intro: 'intro.wav', intro_spacing: '0.5' })
    check('C7a spacing as string -> 400 finite number required', r.statusCode === 400 && /finite number/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', intro: 'intro.wav', intro_spacing: {} })
    check('C7b spacing as object -> 400', r.statusCode === 400 && /finite number/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', intro: 'intro.wav', intro_spacing: 999 })
    check('C7c spacing out of range -> 400 between -60 and 60', r.statusCode === 400 && /between -60 and 60/.test(r.body.detail), JSON.stringify(r.body))

    // ---------- C8: negative spacing end-to-end through handler ----------
    r = await postTts(null, { model: 'test-voice', text: 'hello world', output_endpoint: '127.0.0.1:9', intro: 'intro.wav', outro: 'outro.wav', intro_spacing: -0.25 })
    check('C8 status 200 ok (valid spacing accepted)', r.statusCode === 200 && r.body?.status === 'ok', JSON.stringify(r.body))
    if (existsSync(`${T}/captured.wav`)) {
        info = await capturedInfo()
        check('C8 duration ~1.75s (overlap applied)', near(info.duration, 1.75), `duration=${info.duration}`)
        check('C8 format ok', info.format === EXPECTED_FORMAT, info.format)
    } else {
        check('C8 capture exists', false)
    }

    // ---------- E1: shell metacharacters in output_endpoint are rejected ----------
    const pwnMarker = path.join(T, 'pwned')
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: `127.0.0.1; touch ${pwnMarker} :9` })
    check('E1a semicolon injection -> 400 invalid host', r.statusCode === 400 && /IPv4 or IPv6/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '$(touch ' + pwnMarker + ')' })
    check('E1b command substitution -> 400 bad format', r.statusCode === 400 && /Expected 'IP:PORT'/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '`id`' })
    check('E1c backticks -> 400 bad format', r.statusCode === 400 && /Expected 'IP:PORT'/.test(r.body.detail), JSON.stringify(r.body))
    check('E1d rejected endpoints had no side effects', !existsSync(pwnMarker))

    // ---------- E2: endpoint format validation (literal IP + port range) ----------
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: 'myhost.local:9' })
    check('E2a hostname rejected - literal IP required', r.statusCode === 400 && /IPv4 or IPv6/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:99999' })
    check('E2b out-of-range port -> 400', r.statusCode === 400 && /between 1 and 65535/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:' })
    check('E2c empty port -> 400', r.statusCode === 400, JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: ':9' })
    check('E2d empty host -> 400', r.statusCode === 400, JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '::1:9' })
    check('E2e IPv6 literal accepted end-to-end', r.statusCode === 200 && r.body?.status === 'ok', JSON.stringify(r.body))

    // ---------- E3: sox_effects allowlist ----------
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', sox_effects: 'pitch -400 speed 0.9 reverb 10 10 50 pad 1.2 0.5 compand -4,-35,-60 gain -3' })
    check('E3a valid sox effects pass through to pipeline', r.statusCode === 200 && r.body?.status === 'ok', JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', sox_effects: '   ' })
    check('E3b whitespace-only effects treated as absent', r.statusCode === 200 && r.body?.status === 'ok', JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', sox_effects: `gain -3; touch ${pwnMarker}` })
    check('E3c semicolon in effect token -> 400 disallowed argument', r.statusCode === 400 && /disallowed argument/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', sox_effects: 'reverb $(id)' })
    check('E3d command substitution rejected -> 400', r.statusCode === 400 && /\$\(id\)/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', sox_effects: '"quoted" | nc evil' })
    check('E3e quotes/pipes rejected -> 400', r.statusCode === 400 && /disallowed argument/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', sox_effects: 42 })
    check('E3f non-string sox_effects -> 400 (no crash)', r.statusCode === 400 && /space-separated string/.test(r.body.detail), JSON.stringify(r.body))

    // ---------- E4: piper_effects allowlist ----------
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', piper_effects: '--length_scale 1.15 --noise-w-scale 0.6 --speaker_id 3' })
    check('E4a valid piper flags pass through to pipeline', r.statusCode === 200 && r.body?.status === 'ok', JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', piper_effects: '--output-file /etc/passwd' })
    check('E4b option injection with path value rejected -> 400', r.statusCode === 400 && /disallowed argument/.test(r.body.detail), JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', piper_effects: 'rm -rf ~' })
    check('E4c bare words (not CLI flags) rejected -> 400', r.statusCode === 400 && /disallowed argument/.test(r.body.detail), JSON.stringify(r.body))

    // ---------- E5: request size limits ----------
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', pad: 'x'.repeat(MAX_BODY_BYTES) })
    check('E5a oversized body -> 413 PayloadTooLarge', r.statusCode === 413 && r.body?.error === 'PayloadTooLarge', JSON.stringify(r.body))
    r = await postTts(null, { model: 'test-voice', text: 'a'.repeat(MAX_TEXT_LENGTH + 1), output_endpoint: '127.0.0.1:9' })
    check('E5b overlong text -> 400 maximum length', r.statusCode === 400 && /maximum allowed length/.test(r.body.detail), JSON.stringify(r.body))

    // ---------- E6: MAX_CONCURRENT_PIPELINES throttles fire-and-forget jobs ----------
    {
        const limitedConfig = new Config({ ...envBase, PATH_PIPER: path.join(T, 'fakebin', 'piper-slow.sh'), FIRE_AND_FORGET: 'true', MAX_CONCURRENT_PIPELINES: '1' }, silentLog)
        const limitedCtrl = new Controller(limitedConfig, new ModelRegistry(limitedConfig.modelDir, silentLog), silentLog)
        async function postLimited(body) {
            resetCapture()
            const req = mockRequest()
            const res = mockResponse()
            const p = limitedCtrl.handleTts(req, res)
            emitBody(req, body)
            await p
            return res
        }
        r = await postLimited({ model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9' })
        check('E6a first job accepted (fire-and-forget)', r.statusCode === 200 && r.body?.status === 'ok', JSON.stringify(r.body))
        r = await postLimited({ model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9' })
        check('E6b concurrent job while slot busy -> 429 TooManyRequests', r.statusCode === 429 && r.body?.error === 'TooManyRequests', JSON.stringify(r.body))
        await new Promise((res) => setTimeout(res, 800))
        r = await postLimited({ model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9' })
        check('E6c job after slot freed -> 200 ok', r.statusCode === 200 && r.body?.status === 'ok', JSON.stringify(r.body))
    }

    // ---------- Q1: queue flushes single item ----------
    {
        const cfg = new Config({ ...envBase, PATH_NETCAT: path.join(T, 'fakebin', 'nc-append.sh'), STREAM_QUEUE_PAUSE_MS: '0' }, silentLog)
        const queue = new EndpointStreamQueue(cfg, silentLog)
        const fileA = path.join(T, 'tmp', 'q-a.wav')
        writeFileSync(fileA, 'A')
        resetQueueLog()
        await queue.enqueue({ host: '127.0.0.1', port: '9999' }, {
            jobId: 'q-a', wavPath: fileA, cleanup: () => rmSync(fileA, { force: true }),
        })
        check('Q1 queue streams single item', queueLog() === 'A', queueLog())
        check('Q1 queue cleans temp file', !existsSync(fileA))
        check('Q1 queue state empty', Object.keys(queue.stats).length === 0)
    }

    // ---------- Q2: queue serializes same endpoint ----------
    {
        const cfg = new Config({ ...envBase, PATH_NETCAT: path.join(T, 'fakebin', 'nc-append.sh'), STREAM_QUEUE_PAUSE_MS: '0' }, silentLog)
        const queue = new EndpointStreamQueue(cfg, silentLog)
        const endpoint = { host: '127.0.0.1', port: '9999' }
        const fileA = path.join(T, 'tmp', 'q2-a.wav')
        const fileB = path.join(T, 'tmp', 'q2-b.wav')
        writeFileSync(fileA, 'A')
        writeFileSync(fileB, 'B')
        resetQueueLog()
        const pA = queue.enqueue(endpoint, { jobId: 'q2-a', wavPath: fileA, cleanup: () => rmSync(fileA, { force: true }) })
        const pB = queue.enqueue(endpoint, { jobId: 'q2-b', wavPath: fileB, cleanup: () => rmSync(fileB, { force: true }) })
        await Promise.all([pA, pB])
        check('Q2 queue serializes same endpoint', queueLog() === 'AB', queueLog())
        check('Q2 queue cleans temp files', !existsSync(fileA) && !existsSync(fileB))
    }

    // ---------- Q3: queue picks up items added during flush ----------
    {
        const cfg = new Config({ ...envBase, PATH_NETCAT: path.join(T, 'fakebin', 'nc-slow-append.sh'), STREAM_QUEUE_PAUSE_MS: '0' }, silentLog)
        const queue = new EndpointStreamQueue(cfg, silentLog)
        const endpoint = { host: '127.0.0.1', port: '9999' }
        const fileA = path.join(T, 'tmp', 'q3-a.wav')
        const fileB = path.join(T, 'tmp', 'q3-b.wav')
        writeFileSync(fileA, 'A')
        writeFileSync(fileB, 'B')
        resetQueueLog()
        const pA = queue.enqueue(endpoint, { jobId: 'q3-a', wavPath: fileA, cleanup: () => rmSync(fileA, { force: true }) })
        await sleep(50)
        const pB = queue.enqueue(endpoint, { jobId: 'q3-b', wavPath: fileB, cleanup: () => rmSync(fileB, { force: true }) })
        await Promise.all([pA, pB])
        check('Q3 queue picks up items added during flush', queueLog() === 'START\nASTART\nB', queueLog())
        check('Q3 queue cleans temp files', !existsSync(fileA) && !existsSync(fileB))
    }

    // ---------- Q4: queue picks up items added during pause ----------
    {
        const cfg = new Config({ ...envBase, PATH_NETCAT: path.join(T, 'fakebin', 'nc-append.sh'), STREAM_QUEUE_PAUSE_MS: '300' }, silentLog)
        const queue = new EndpointStreamQueue(cfg, silentLog)
        const endpoint = { host: '127.0.0.1', port: '9999' }
        const fileA = path.join(T, 'tmp', 'q4-a.wav')
        const fileB = path.join(T, 'tmp', 'q4-b.wav')
        const fileC = path.join(T, 'tmp', 'q4-c.wav')
        writeFileSync(fileA, 'A')
        writeFileSync(fileB, 'B')
        writeFileSync(fileC, 'C')
        resetQueueLog()
        const start = Date.now()
        const pA = queue.enqueue(endpoint, { jobId: 'q4-a', wavPath: fileA, cleanup: () => rmSync(fileA, { force: true }) })
        const pB = queue.enqueue(endpoint, { jobId: 'q4-b', wavPath: fileB, cleanup: () => rmSync(fileB, { force: true }) })
        await sleep(50)
        const pC = queue.enqueue(endpoint, { jobId: 'q4-c', wavPath: fileC, cleanup: () => rmSync(fileC, { force: true }) })
        await Promise.all([pA, pB, pC])
        const elapsed = Date.now() - start
        check('Q4 queue picks up items added during pause', queueLog() === 'ABC', queueLog())
        check('Q4 queue pauses before next item', elapsed >= 250, `elapsed=${elapsed}`)
    }

    // ---------- Q5: queue continues after stream failure ----------
    {
        const cfg = new Config({ ...envBase, PATH_NETCAT: path.join(T, 'fakebin', 'nc-append.sh'), STREAM_QUEUE_PAUSE_MS: '0' }, silentLog)
        const queue = new EndpointStreamQueue(cfg, silentLog)
        const endpoint = { host: '127.0.0.1', port: '9999' }
        const missing = path.join(T, 'tmp', 'q5-missing.wav')
        const good = path.join(T, 'tmp', 'q5-good.wav')
        writeFileSync(good, 'B')
        resetQueueLog()
        const pMissing = queue.enqueue(endpoint, { jobId: 'q5-missing', wavPath: missing, cleanup: () => rmSync(missing, { force: true }) })
        const pGood = queue.enqueue(endpoint, { jobId: 'q5-good', wavPath: good, cleanup: () => rmSync(good, { force: true }) })
        const missingResult = await pMissing.then(() => 'resolved').catch(() => 'rejected')
        await pGood
        check('Q5 queue continues after stream failure', queueLog() === 'B', queueLog())
        check('Q5 queue rejects failed item', missingResult === 'rejected', missingResult)
        check('Q5 queue cleans failed item temp file', !existsSync(missing))
    }

    // ---------- Q6: fire-and-forget uses queue ----------
    {
        const cfg = new Config({ ...envBase, FIRE_AND_FORGET: 'true', PATH_NETCAT: path.join(T, 'fakebin', 'nc-append.sh'), STREAM_QUEUE_PAUSE_MS: '0' }, silentLog)
        const ctrl = new Controller(cfg, new ModelRegistry(cfg.modelDir, silentLog), silentLog)
        resetCapture()
        resetQueueLog()
        const req = mockRequest()
        const res = mockResponse()
        const p = ctrl.handleTts(req, res)
        emitBody(req, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9999' })
        await p
        check('Q6 fire-and-forget responds immediately', res.statusCode === 200 && res.body?.status === 'ok', JSON.stringify(res.body))
        const flushed = await waitFor(() => queueLog().length > 0)
        check('Q6 fire-and-forget queue flushes in background', flushed && queueLog().length > 0, queueLog())
        const cleaned = await waitFor(tempClean)
        check('Q6 fire-and-forget queue cleans temp files', cleaned && tempClean())
    }

    // ---------- Q7: sync mode waits for queue ----------
    {
        const cfg = new Config({ ...envBase, PATH_NETCAT: path.join(T, 'fakebin', 'nc-slow-append.sh'), STREAM_QUEUE_PAUSE_MS: '0' }, silentLog)
        r = await postTts(cfg, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9999' })
        check('Q7 sync mode waits for queued stream', r.statusCode === 200 && r.body?.status === 'ok' && queueLog().includes('START'), JSON.stringify(r.body))
    }

    // ---------- Q8: queue flush does not consume pipeline slot ----------
    {
        const cfg = new Config({ ...envBase, FIRE_AND_FORGET: 'true', MAX_CONCURRENT_PIPELINES: '1', PATH_NETCAT: path.join(T, 'fakebin', 'nc-slow-append.sh'), STREAM_QUEUE_PAUSE_MS: '0' }, silentLog)
        const ctrl = new Controller(cfg, new ModelRegistry(cfg.modelDir, silentLog), silentLog)
        async function postLimited(body) {
            resetCapture()
            resetQueueLog()
            const req = mockRequest()
            const res = mockResponse()
            const p = ctrl.handleTts(req, res)
            emitBody(req, body)
            await p
            return res
        }
        r = await postLimited({ model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9999' })
        check('Q8a first job accepted (fire-and-forget)', r.statusCode === 200 && r.body?.status === 'ok', JSON.stringify(r.body))
        const started = await waitFor(() => queueLog().includes('START'))
        check('Q8b first queued stream started', started && queueLog().includes('START'), queueLog())
        r = await postLimited({ model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9999' })
        check('Q8c queue flush does not consume pipeline slot', r.statusCode === 200 && r.body?.status === 'ok', JSON.stringify(r.body))
    }

    // ---------- E7: sound file name length guard ----------
    r = await postTts(null, { model: 'test-voice', text: 'hi', output_endpoint: '127.0.0.1:9', intro: 'a'.repeat(300) + '.wav' })
    check('E7 overlong sound file name -> 400', r.statusCode === 400 && /exceeds/.test(r.body.detail), JSON.stringify(r.body))
} finally {
    if (failures === 0) {
        rmSync(T, { recursive: true, force: true })
    } else {
        console.log(`\nScratch dir kept for inspection: ${T}`)
    }
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
