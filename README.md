# TTS Server

![TypeScript-Free](https://img.shields.io/badge/TypeScript-free-ff69b4?style=flat-square)

> This is a TypeScript-free project. Stop JavaScript pollution!

A lightweight Node.js HTTP server that orchestrates **Piper TTS**, optional **Sox** audio processing, and **Netcat** streaming. Zero external dependencies — pure Node.js standard library.

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
- **Shell Subprocess Injection:** User-supplied `output_endpoint` values from API requests are passed directly into shell subprocess commands (netcat). While the endpoint format is validated (`IP:PORT`), there is no comprehensive sanitization against shell metacharacters. This reinforces that the server must only be accessible from trusted clients on your local network.

## Server

### Requirements

- **Node.js 20+** (Modern LTS version recommended)
- [`piper`](https://github.com/rhasspy/piper) (installed and available in your `$PATH`)
- [`netcat`](https://netcat.sourceforge.net/) (installed and available in your `$PATH`)
- [`sox`](http://sox.sourceforge.net/) *(optional, for audio effects)*

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
| `PATH_PIPER`          | No       | `$PATH` lookup        | Override path to the `piper` binary.                     |
| `PATH_SOX`            | No       | `$PATH` lookup        | Override path to the `sox` binary.                       |
| `PATH_NETCAT`         | No       | `$PATH` lookup        | Override path to the `netcat` binary.                    |
| `FIRE_AND_FORGET`     | No       | `false`               | Respond immediately after validation without waiting for the audio pipeline to finish (`true`/`1` to enable). |

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
| `piper_effects`           | string    | No       | Space-separated piper CLI flags                          |
| `sox_effects`             | string    | No       | Space-separated Sox effects                              |
| `output_endpoint`         | string    | ✅ Yes   | `"IP:PORT"` for netcat streaming                         |

> 💡 **The `triple_leading_consonant` Workaround:** 
> When using certain Slavic language models (Polish, Czech, Slovak, etc.), Piper TTS tends to clip the very first consonant of a sentence, making words sound unnatural (e.g., "Pozdrawiam" might be pronounced as "Ozdrawiam"). 
> 
> Enabling this flag triples the leading consonant before passing the text to Piper (e.g., "Pozdrawiam" → "PP Pozdrawiam"). This quick-and-dirty fix ensures that at least one consonant survives the synthesis pipeline. This transformation only targets initial consonants; sentences starting with vowels are left untouched.

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
┌─────────┐     ┌──────┐      ┌────────┐
│  Piper  │────>│ Sox? │───-->│ Netcat │
│ (TTS)   │     │(opt) │      │        │
└─────────┘     └──────┘      └────────┘
   text            effects        IP:PORT
   wav out         wav in/out     stream
```

1. **Piper** generates audio from the text using the specified model.
2. **Sox** (optional) applies real-time audio effects to the stream.
3. **Netcat** (optional) streams the processed audio data to the remote endpoint.