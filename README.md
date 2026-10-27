# TTS Server

![TypeScript-Free](https://img.shields.io/badge/TypeScript-free-ff69b4?style=flat-square)

> This is a TypeScript-free project. Stop JavaScript pollution!

A lightweight Node.js HTTP server that orchestrates **Piper TTS**, optional **Sox** audio processing, optional **Ffmpeg** intro/outro concatenation, and **Netcat** streaming. Zero external dependencies — pure Node.js standard library.

## Why?

It is standard practice to host Large Language Model (LLM) servers (such as `llama.cpp`, `Ollama`, or `vLLM`) separately from the main application. This microservice architecture is widely accepted because running these models requires significant computational power. 

However, hosting Text-to-Speech (TTS) engines in a similar fashion is rarely considered, even though running TTS locally can easily overwhelm low-power hardware. If you are working with resource-constrained environments—like ARM development boards or legacy SoC terminals—and want them to speak using their local sound card without the computational burden, this project is designed for you.

This server allows you to host [Piper TTS](https://github.com/OHF-Voice/piper1-gpl) on a more powerful remote machine while streaming the generated audio directly back to the sound card of your low-power client device.

### Key Features & Considerations:
- **Ultra-lightweight clients:** Client-side requirements remain absolutely minimal. No complex network audio protocols (like native PipeWire or PulseAudio streaming over the network) are required.
- **Audio Format:** By default, the server transmits uncompressed, full WAVE/PCM streams to minimize client-side CPU overhead.
- **Network Environment:** Designed to operate within a Local Area Network (LAN) over raw, unencrypted, and unauthenticated network sockets. It is **not** best suited for high-latency, low-bandwidth, or zero-trust networks.

### ⚠️ Security Considerations

This server is designed exclusively for **trusted, private LAN environments**. Please be aware of the following:

- **No Authentication:** The server has no built-in authentication mechanism. Anyone who can reach the server's IP and port can invoke TTS synthesis. Deploy it behind a firewall or restrict access at the network level.
- **No Encryption:** All communication (requests and audio streams) is transmitted in plaintext over HTTP. Do not expose this server to untrusted networks or the internet.
- **Input Validation & Shell-Free Execution:** All external tools (Piper, Sox, Ffmpeg, Netcat) are spawned directly with explicit argument arrays — never through a shell — so user input can only ever be treated as plain arguments, never as commands. Incoming values are strictly validated before use: `output_endpoint` must be a literal `IP:PORT`, `piper_effects`/`sox_effects` may only contain CLI flags/effect names and numeric parameters, sound files must be plain file names inside `DIR_SOUNDS`, request bodies and text lengths are capped, and an optional concurrency limit (`MAX_CONCURRENT_PIPELINES`) protects against job floods. Despite this hardening, the server still has **no authentication** and will happily stream audio to any LAN address it is told to, so keep it reachable only from trusted clients on your local network.

## Server

### Requirements

- **Node.js 20+** (Modern LTS version recommended)
- [`piper`](https://github.com/rhasspy/piper) (installed and available in your `$PATH`)
- [`netcat`](https://netcat.sourceforge.net/) (installed and available in your `$PATH`)
- [`sox`](http://sox.sourceforge.net/) *(optional, for audio effects)*
- [`ffmpeg`](https://ffmpeg.org/) + `ffprobe` *(optional; `ffmpeg` is required for `intro`/`outro` request fields, and `ffprobe` additionally for negative `intro_spacing`. Both ship together in the same package.)*

> **Note:** You are responsible for installing the required binaries on the server; setting up these underlying system dependencies is outside the scope of this project.

### Configuration

Copy `.env.example` to `.env` and adjust the values to match your environment:

```bash
cp .env.example .env
```

| Variable              | Required | Default               | Description                                              |
|-----------------------|----------|-----------------------|----------------------------------------------------------|
| `DIR_MODEL`           | ✅ Yes   | —                     | Absolute path to the Piper models directory.             |
| `DIR_RAMDISK_MODEL`   | No       | —                     | Optional RAM disk (tmpfs) directory for model files. Models are verified and copied here on startup, then automatically cleaned up on shutdown. |
| `ADDRESS_LISTEN`      | No       | `0.0.0.0:8080`        | Address and port for the HTTP server to bind to.         |
| `DIR_TEMP`            | No       | `/tmp/tts-server/`    | Directory for temporary WAV files (created if missing).  |
| `DIR_SOUNDS`          | No       | `./sounds/`           | Directory for intro/outro sound files referenced by name in requests (relative paths resolve against the project root). |
| `PATH_PIPER`          | No       | `$PATH` lookup        | Override path to the `piper` binary.                     |
| `PATH_SOX`            | No       | `$PATH` lookup        | Override path to the `sox` binary.                       |
| `PATH_NETCAT`         | No       | `$PATH` lookup        | Override path to the `netcat` binary.                    |
| `PATH_FFMPEG`         | No       | `$PATH` lookup (lazy) | Override path to the `ffmpeg` binary (only needed for `intro`/`outro`). |
| `FIRE_AND_FORGET`     | No       | `false`               | Respond immediately after validation without waiting for the audio pipeline to finish (`true`/`1` to enable). |
| `MAX_CONCURRENT_PIPELINES` | No  | unlimited             | Maximum number of pipelines allowed to run concurrently; excess requests receive HTTP 429 until a slot frees up (`0` or unset = no limit). Useful with `FIRE_AND_FORGET=true`. |
| `STREAM_QUEUE_PAUSE_MS` | No | `5000` | Pause in milliseconds between queued streams to the same `output_endpoint`. |

### Per-Endpoint Stream Queue

Generated audio is queued per `output_endpoint` before Netcat streaming. Requests for the same endpoint are streamed one after another, while Piper/Sox/Ffmpeg processing can run concurrently. After a stream finishes, the server waits `STREAM_QUEUE_PAUSE_MS` milliseconds before starting the next queued stream for that endpoint.

The queue is in-memory and per app instance. It is independent of `FIRE_AND_FORGET`: synchronous requests wait for their queued stream to finish, while fire-and-forget requests return immediately and flush in the background. `MAX_CONCURRENT_PIPELINES` limits active generation/preparation jobs, not queued stream items.

### Performance Optimization (RAM Disk / tmpfs)

Unlike `piper-server`, which typically binds to a single pre-loaded model, **TTS Server** is designed to dynamically serve *any* available model specified in the request payload. To achieve this, models and intermediate execution files are loaded per-request on the fly.

To maximize throughput and prevent unnecessary write cycles on your SSD/NVMe drives, it is strongly recommended to mount a `tmpfs` partition in RAM and route both `DIR_RAMDISK_MODEL` and `DIR_TEMP` to it:

```env
DIR_RAMDISK_MODEL=/mnt/ram/tts-server/models/
DIR_TEMP=/mnt/ram/tts-server/tmp/
```

**Example `tmpfs` mount setup:**
```bash
# Mount a 2GB RAM disk
sudo mount -t tmpfs -o size=2G tmpfs /mnt/ram
```

### Running

The provided startup script loads the `.env` file and boots the server:

```bash
./bin/tts-server
```

Alternatively, if you prefer another deployment method (e.g., inside Kubernetes), ensure all environment variables from `.env` are properly loaded and launch the application directly:

```bash
node src/main.js
```

## Client device

### Requirements

Any GNU/Linux machine with a functional sound card, ALSA, and optionally a sound server like PulseAudio or PipeWire. Other UNIX-like systems should also work with minor adjustments.

### Configuration

Expose a TCP port using `socat` and pipe the incoming stream directly into your command-line audio player (e.g., `aplay` for pure ALSA, `paplay` for PulseAudio, or `pw-play` for PipeWire).

```bash
socat TCP-LISTEN:12345,reuseaddr,fork EXEC:"/usr/bin/aplay -
```

#### systemd Service

To run this permanently as a background service, create a systemd service file (e.g., `/etc/systemd/system/socat-audio.service`) with the following contents:

```ini
[Unit]
Description=Network ALSA Sound Client (socat + aplay)
After=network.target

[Service]
Type=simple
User=kyeno
ExecStart=/usr/bin/socat TCP-LISTEN:12345,reuseaddr,fork EXEC:"/usr/bin/aplay -"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable and start the service:

```bash
systemctl daemon-reload
systemctl enable socat-audio --now
```

#### ALSA Downmixing (Optional)

If you are using pure ALSA without a sound server (like PulseAudio or PipeWire), you will need a way to mix concurrent incoming streams. To achieve this without installing a heavy sound server, configure ALSA to use the `dmix` (downmixer) plugin by editing `/etc/asound.conf`:

```conf
pcm.!default {
    type plug
    slave.pcm "dmixer"
}

pcm.dmixer {
    type dmix
    ipc_key 1024
    slave {
        pcm "hw:0,0" # Your soundcard hardware ID
        period_time 0
        period_size 1024
        buffer_size 4096
        rate 44100
    }
    bindings {
        0 0
        1 1
    }
}
```

## Usage

The server exposes straightforward HTTP endpoints.

### Health Check

```http
GET /health
```

**Response:** `200 OK`

### List Models

```http
GET /models
```

**Response:** `200 OK`

```json
{
  "models": ["pl-pl-rafal-medium.onnx", "en-us-lessac-medium.onnx"]
}
```

### Synthesize TTS

```http
POST /tts
Content-Type: application/json
```

**Request Body Fields:**

| Field                     | Type      | Required | Description                                              |
|---------------------------|-----------|----------|----------------------------------------------------------|
| `model`                   | string    | ✅ Yes   | Model filename (relative to `DIR_MODEL`)                 |
| `text`                    | string    | ✅ Yes   | Text to synthesize (UTF-8, JSON-unescaped)               |
| `triple_leading_consonant`| boolean/number | No   | Triple leading consonant (`true`/`1` or `false`/`0`, default: `false`) |
| `piper_effects`           | string    | No       | Space-separated Piper CLI flags and values (e.g. `--length_scale 1.15 --noise-w-scale 0.6`) — only flag tokens and numeric parameters are accepted |
| `sox_effects`             | string    | No       | Space-separated Sox effect names and numeric parameters (e.g. `pitch -400 speed 0.9 reverb 10 10 50`) — anything else is rejected |
| `intro`                   | string    | No       | Sound file name from `DIR_SOUNDS`, prepended before the speech |
| `outro`                   | string    | No       | Sound file name from `DIR_SOUNDS`, appended after the speech  |
| `intro_spacing`           | number    | No       | Seconds of silence between end of `intro` and start of speech; negative values overlap/mix that many seconds instead (default `0`) |
| `output_endpoint`         | string    | ✅ Yes   | `"IP:PORT"` for netcat streaming — literal IPv4/IPv6 address + port 1–65535 |

> 💡 **The `triple_leading_consonant` Workaround:** 
> When using certain Slavic language models (Polish, Czech, Slovak, etc.), Piper TTS tends to clip the very first consonant of a sentence, making words sound unnatural (e.g., "Pozdrawiam" might be pronounced as "Ozdrawiam"). 
> 
> Enabling this flag triples the leading consonant before passing the text to Piper (e.g., "Pozdrawiam" → "PP Pozdrawiam"). This quick-and-dirty fix ensures that at least one consonant survives the synthesis pipeline. This transformation only targets initial consonants; sentences starting with vowels are left untouched.

> **Intro / Outro:** When either field is provided, ffmpeg concatenates the named sound files (looked up in `DIR_SOUNDS`) around the synthesized speech — intro first, then speech, then outro. Only plain file names are accepted (no paths). The concatenated output is always normalized to RIFF/WAVE, Microsoft PCM 16-bit little-endian, mono, 22050 Hz, regardless of the source files' formats.
>
> **Intro Spacing:** `intro_spacing` (seconds, default `0`, range -60..60) controls the boundary between the intro and the speech: positive values insert that much silence after the intro; negative values overlap (mix at full volume) that many seconds of the end of the intro with the beginning of the speech. Overlap length is clamped to the actual duration of both segments, so requesting more overlap than exists simply maximizes it. It has no effect when no `intro` is given.
>
> Negative spacing probes segment lengths via ffprobe (resolved next to the ffmpeg binary first, then `$PATH`); if ffprobe cannot be found, requests using negative `intro_spacing` fail while all other requests keep working.

**Example Request:**

```json
{
  "model": "pl-pl-rafal-medium.onnx",
  "text": "Witaj świecie! To jest test z polskimi znakami: ąęćńóśłżź",
  "triple_leading_consonant": true,
  "piper_effects": "--length_scale 1.15 --noise_scale 0.6",
  "sox_effects": "pitch -400 speed 0.9 reverb 10 10 50",
  "output_endpoint": "127.0.0.1:9999"
}
```

**Success Response (`200 OK`):**

```json
{
  "status": "ok",
  "job_id": "a1b2c3d4-e5f6-...",
  "message": "Audio generated and streamed successfully"
}
```

**Error Response (`400 Bad Request` / `500 Internal Server Error`):**

```json
{
  "error": "Bad Request",
  "detail": "Invalid output_endpoint format: 'bad'. Expected 'IP:PORT'"
}
```

## Pipeline Flow

```
┌─────────┐     ┌──────┐     ┌─────────┐     ┌────────┐
│  Piper  │────>│ Sox? │────>│Ffmpeg?  │────>│ Netcat │
│ (TTS)   │     │(opt) │     │ (opt)   │     │        │
└─────────┘     └──────┘     └─────────┘     └────────┘
   text           effects       intro/outro      IP:PORT
   wav out        wav in/out    concat+norm      stream
```

1. **Piper** generates audio from the text using the specified model.
2. **Sox** (optional) applies real-time audio effects to the stream.
3. **Ffmpeg** (optional, when `intro`/`outro` is requested) concatenates the sound files around the speech and normalizes the output to PCM 16-bit mono 22050 Hz WAV.
4. **Netcat** (optional) streams the final audio data to the remote endpoint.