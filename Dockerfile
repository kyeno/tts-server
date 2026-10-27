# syntax=docker/dockerfile:1
#
# TTS Server container image.
#
# Bundles every runtime dependency the server resolves at startup:
#   piper (Python venv, OHF-Voice/piper1-gpl), sox, netcat (OpenBSD), ffmpeg + ffprobe
# plus a security-pinned Node.js LTS release (see NODE_VERSION below).
#
# Build args:
#   NODE_VERSION   - exact Node.js image tag, pinned to a patched release
#                    (default: 22.23.4; the build refuses older runtimes)
#   PIPER_VERSION  - pinned piper-tts version (default: 1.8.0)
#   PIPER_CUDA     - "1" swaps the CPU onnxruntime wheel for onnxruntime-gpu +
#                    NVIDIA cu13 runtime wheels (experimental, see README)
#
# @author Ratan M. Kyeno
# @license MIT

# Node.js is pinned to an exact patched release instead of a floating major tag.
# 22.23.4 is the 22.x release of the Node.js security advisory of 2026-10-21
# (https://nodejs.org/en/blog/vulnerability/october-2026-security-releases):
# dns.resolve NUL truncation (CVE-2026-105482), TLS hostname bypasses
# (CVE-2026-106069), Brotli decoder out-of-bounds write / RCE (CVE-2026-111497),
# keep-alive response injection (CVE-2026-105481), non-canonical IPv4 certificate
# validation (CVE-2026-106072), startup-snapshot entropy reuse (CVE-2026-106074),
# Permission Model bypasses (CVE-2026-106071/73), plus the bundled c-ares, OpenSSL,
# SQLite, Undici and CA-certificate updates. Bump NODE_VERSION to the newest patched
# 22.x release after each advisory - the build fails below NODE_MIN_VERSION.
ARG NODE_VERSION=22.23.4
ARG PIPER_VERSION=1.8.0
ARG PIPER_CUDA=0

# ---------------------------------------------------------------------------
# Stage 1: Piper CLI inside a self-contained Python virtualenv
# ---------------------------------------------------------------------------
FROM python:3.11-bookworm AS piper-builder

ARG PIPER_VERSION
ARG PIPER_CUDA

RUN python3 -m venv /opt/piper-venv \
 && /opt/piper-venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/piper-venv/bin/pip install --no-cache-dir "piper-tts==${PIPER_VERSION}" \
 && if [ "${PIPER_CUDA}" = "1" ]; then \
      echo ">>> Swapping CPU onnxruntime for onnxruntime-gpu (CUDA build)"; \
      /opt/piper-venv/bin/pip uninstall -y onnxruntime-gpl onnxruntime || true; \
      /opt/piper-venv/bin/pip install --no-cache-dir \
        onnxruntime-gpu \
        nvidia-cuda-runtime \
        nvidia-cublas \
        nvidia-curand \
        nvidia-cufft \
        nvidia-cusolver \
        nvidia-cusparse \
        nvidia-nvtx \
        nvidia-cuda-nvrtc \
        nvidia-cuda-cupti \
        nvidia-cudnn-cu13; \
    fi \
 && /opt/piper-venv/bin/piper --help > /dev/null

# ---------------------------------------------------------------------------
# Stage 2: runtime (Node.js + audio toolchain)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim

# Fail the build if the base image is not a patched Node.js runtime: guards against
# a floating tag, a stale mirror, or a NODE_VERSION predating the 2026-10-21
# security release.
ARG NODE_MIN_VERSION=22.23.4
RUN node -e 'const min=(process.env.NODE_MIN_VERSION||"22.23.4").split(".").map(Number),cur=process.versions.node.split(".").map(Number);for(let i=0;i<3;i++){if(cur[i]>min[i]){break}if(cur[i]<min[i]){console.error("FATAL: Node "+process.versions.node+" is older than the patched minimum "+min.join(".")+" - see https://nodejs.org/en/blog/vulnerability/october-2026-security-releases");process.exit(1)}}console.log("Node.js "+process.versions.node+" satisfies patched minimum "+min.join("."))'

# `which` is required: src/config.js resolves piper/sox/nc/ffmpeg via `which <name>`.
# `file` is only needed by tests/run-tests.mjs (npm run test inside the container).
# `apt-get upgrade` keeps the Debian OpenSSL/libssl and CA bundle current too.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends \
      sox \
      ffmpeg \
      netcat-openbsd \
      which \
      file \
      python3 \
      libgomp1 \
      libatomic1 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # The venv's console scripts have shebangs pointing at the builder interpreter
 # location (/opt/piper-venv/bin/python3 -> /usr/local/bin/python3), so bridge it
 # to the distro interpreter installed above (python3 == 3.11 on bookworm).
 && ln -s /usr/bin/python3 /usr/local/bin/python3 \
 && ln -s /usr/bin/python3.11 /usr/local/bin/python3.11

COPY --from=piper-builder /opt/piper-venv /opt/piper-venv
ENV PATH="/opt/piper-venv/bin:${PATH}"
# CUDA builds ship the NVIDIA runtime wheels inside the venv (onnxruntime-gpu links
# against CUDA 13 / cuDNN 9, which it does not bundle). The cu13 wheels install into
# nvidia/cu13/lib, cuDNN into nvidia/cudnn/lib. Harmless for CPU builds - missing
# directories are ignored by the loader.
ENV LD_LIBRARY_PATH="/opt/piper-venv/lib/python3.11/site-packages/nvidia/cu13/lib:/opt/piper-venv/lib/python3.11/site-packages/nvidia/cudnn/lib"

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node bin/ ./bin/
COPY --chown=node:node tests/ ./tests/

# Mount points expected by docker-compose.yml (DIR_MODEL, DIR_SOUNDS, DIR_TEMP, DIR_RAMDISK_MODEL)
RUN mkdir -p /app/sounds /data/piper-models /tmp/tts-server /mnt/ram/tts-server-models \
 && chown -R node:node /app /data /tmp/tts-server /mnt/ram

# Build-time smoke test: fail the build loudly if any dependency is unusable.
RUN node -v \
 && piper --help > /dev/null \
 && sox --version \
 && ffmpeg -version | head -1 \
 && ffprobe -version | head -1 \
 && which piper sox nc ffmpeg ffprobe

USER node

EXPOSE 7423

# GET /health (no curl in the slim image - Node's built-in fetch is used instead)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const p=(process.env.ADDRESS_LISTEN||'0.0.0.0:8080').split(':')[1]||8080;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node runs as PID 1 so SIGTERM triggers the app's graceful shutdown
# (stream queue flush + RAM disk cleanup in src/server.js).
CMD ["node", "src/main.js"]
