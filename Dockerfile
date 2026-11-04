# syntax=docker/dockerfile:1.7

FROM golang:1.27.3-bookworm AS go-build
WORKDIR /src
COPY api/go.mod api/go.sum ./
RUN go mod download
COPY api/ ./
RUN mkdir -p /out \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/arvc-api ./cmd/server

FROM python:3.14.10-slim-bookworm AS python-runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    TMPDIR=/tmp \
    PORT=8080 \
    AUDIO_ANALYSIS_THREADS=2 \
    PYTHON_ISLAND_EXECUTABLE=/app/python-island/.venv/bin/python-island \
    PYTHON_ISLAND_DIRECTORY=/app/python-island \
    FFPROBE_EXECUTABLE=/usr/bin/ffprobe \
    ARVC_SCNET_CHECKPOINT=/opt/models/scnet-standard-f8aff3bc.th

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/models /home/arvc \
    && chmod 0755 /opt/models \
    && chmod 0700 /home/arvc

COPY --from=ghcr.io/astral-sh/uv:0.8.12 /uv /uvx /usr/local/bin/
WORKDIR /app/python-island
COPY python-island/pyproject.toml python-island/uv.lock ./
COPY python-island/src ./src
RUN uv sync --locked --no-dev --no-extra demucs-dev \
    && rm -f /usr/local/bin/uv /usr/local/bin/uvx

# The dedicated named context contains only the checkpoint and is read-only in this build step.
RUN --mount=type=bind,from=scnet_weights,source=checkpoint.th,target=/run/scnet-checkpoint,ro \
    test "$(stat -c '%s' /run/scnet-checkpoint)" = "42434545" \
    && printf '%s  %s\n' \
      'f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5' \
      '/run/scnet-checkpoint' | sha256sum --check --status \
    && install -m 0444 /run/scnet-checkpoint /opt/models/scnet-standard-f8aff3bc.th

RUN groupadd --system --gid 10001 arvc \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/arvc --no-create-home arvc \
    && chown 10001:10001 /tmp /home/arvc \
    && chmod 1777 /tmp
WORKDIR /app
ENV HOME=/home/arvc
USER 10001:10001

FROM python-runtime AS runtime
COPY --from=go-build --chown=0:0 /out/arvc-api /app/arvc-api
EXPOSE 8080
ENTRYPOINT ["/app/arvc-api"]
