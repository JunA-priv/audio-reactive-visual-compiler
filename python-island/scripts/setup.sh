#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

python_runtime=".python/python/bin/python3.14"
python_archive=".python-dist.tar.gz"
python_url="https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.14.10%2B20261026-x86_64-unknown-linux-gnu-install_only.tar.gz"
python_sha256="1b38024924eb7f4cf0cab45d7b871d1f1991354190fccd2625ac7529a43786e2"

if [[ ! -x "$python_runtime" ]] || ! "$python_runtime" -c 'import sys; assert sys.version_info[:3] == (3, 14, 10)'; then
  mkdir -p .python
  curl --fail --location --retry 2 "$python_url" --output "$python_archive"
  printf '%s  %s\n' "$python_sha256" "$python_archive" | sha256sum --check --status
  tar -xzf "$python_archive" -C .python
fi

uv venv --python "$python_runtime" .venv
uv sync --locked --extra dev
