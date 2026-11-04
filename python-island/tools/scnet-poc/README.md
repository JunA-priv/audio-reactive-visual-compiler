# SCNet local comparison PoC

This tool is isolated from the production Python Island. It calls the official
SCNet PyTorch inference implementation and the existing Python Island feature
extractor. It does not change `python-island/pyproject.toml`, `uv.lock`, the Go
API, or the production separator.

## Current status

The official source checkout and checkpoint are available locally and pinned
below. Dependency installation may still require a network-enabled WSL2
environment before inference can run.
SCNet upstream's code and its author's checkpoint clarification are MIT, with
attribution required. The upstream says the model was trained on MUSDB; SigSep
limits MUSDB access to academic use and lists track-specific rights. Whether
those dataset conditions affect pretrained weights remains unresolved. Keep
this PoC local and do not deploy or redistribute the checkpoint until that
separate rights question is cleared.

## Pinned inputs

- Official code: <https://github.com/starrytong/SCNet>
- Official code commit: `5d95bf96b19c3eede63248d171efeca8e3abb948`.
- Official standard checkpoint: the `checkpoint.th` Google Drive link in the
  official README. The official Drive retrieval was confirmed to match the
  local file. Expected SHA-256: `f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5`;
  expected size: 42,434,545 bytes. A third-party model card records a different
  hash; it is not used for verification. The PoC verifies the local file before
  loading and uses PyTorch `weights_only=True` for the tensor-only checkpoint.
- Official inference config: `conf/config.yaml` from the same SCNet checkout.
- The SCNet-large model is optional and intentionally not included in this first
  run. It needs its own official checkpoint digest/config verification before
  acquisition.

Review the pinned source and license before running. The output JSON records the
source commit. Do not substitute third-party ONNX files for this PyTorch baseline.

## Environment setup

Use a dedicated Python 3.12 virtual environment in this directory. The app's
Python Island targets Python 3.14 and remains untouched.

```sh
cd python-island/tools/scnet-poc
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python \
  --index-url https://download.pytorch.org/whl/cpu \
  --extra-index-url https://pypi.org/simple \
  -r requirements.txt
git clone https://github.com/starrytong/SCNet.git ./SCNet
git -C ./SCNet rev-parse HEAD
```

Download the official standard checkpoint only from its official README link.
Before inference, verify the expected digest and size:

```sh
sha256sum /path/to/checkpoint.th
stat -c '%s' /path/to/checkpoint.th
```

Both values must match the pinned values above. Do not place the weight under
Git. If either differs, stop and investigate rather than changing the pin.

## Comparison command

Run from the repository root. The source file is decoded locally; no audio is
uploaded. The output directory must not already contain files. Stems are written
as 44.1 kHz stereo PCM16. Both SCNet and existing Demucs PCM16 stems are passed
to the same existing feature extractor with the same Gate Mode values.

```sh
python-island/tools/scnet-poc/.venv/bin/python \
  python-island/tools/scnet-poc/compare.py \
  --source demo-assets/source/audio-reactive-silent-demo4.mp3 \
  --demucs-stems demo-assets/stems/demo4-kick-evaluation \
  --scnet-repo python-island/tools/scnet-poc/external/SCNet \
  --checkpoint /path/to/checkpoint.th \
  --config python-island/tools/scnet-poc/external/SCNet/conf/config.yaml \
  --output-dir /tmp/arvc-scnet-demo4
```

The default compares the full 189.960-second demo4 against its existing
full-length Demucs stems. To mirror the product's 60-second limit, compare the
same 43.14–103.14-second section from both inputs with
`--start-seconds 43.14 --duration-seconds 60`.

The script uses the official `scnet.inference.Seperator` API on CPU, with a
fixed seed for its upstream random-shift inference. It measures model load,
first and warm inference, process CPU, process peak RSS, and checkpoint bytes;
validates all four stems and reports sample count, clipping, level and mixture
recomposition residual. It computes the existing Feature Timeline for Off,
Soft, Middle, and Hard. Detector event differences are descriptive comparisons,
not TP/FP/FN or accuracy measures because no confirmed human annotations exist.

The output directory contains the four SCNet stems, `comparison.json`, and
`features.csv`. It will refuse a non-empty destination. No output is written in
the existing demo-assets folders by default.

`features.csv` keeps the original event columns and appends event offset p90/max,
match rate, and comparison status. It writes one record for each Kick/Snare event
and each of the five feature series in every Gate Mode (28 data rows total).
Series rows include both means, MAE, MAE normalized by the Demucs mean absolute
level, Pearson correlation, and peak-time delta. Undefined metrics are empty
cells; `comparisonStatus` distinguishes empty, misaligned, invalid, and valid
comparisons. Corresponding event and series values are also recorded in
`comparison.json` for cross-checking. Event matches remain descriptive
model-to-model comparisons, not accuracy against human labels.

## What this does not establish

- A clean or legal right to distribute MUSDB18-HQ-trained weights or their
  derived output. The author clarification and dataset access terms are separate.
- Separation quality or Kick/Snare accuracy from event counts alone.
- Cloud Run 2 vCPU / 4 GiB runtime. Local timing is not a Cloud benchmark.
- ONNX parity. The optional third-party ONNX export has a separate provenance,
  conversion and runtime review and is not used by this PoC.
