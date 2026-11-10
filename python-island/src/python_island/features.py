from __future__ import annotations

from typing import TypedDict

import numpy as np

from python_island.audio import TARGET_SAMPLE_RATE
from python_island.errors import AnalysisError

HOP_MS = 10
HOP_SAMPLES = TARGET_SAMPLE_RATE * HOP_MS // 1000
WAVEFORM_PEAK_INTERVAL_MS = 20
WAVEFORM_PEAK_SAMPLES = TARGET_SAMPLE_RATE * WAVEFORM_PEAK_INTERVAL_MS // 1000
SPECTRUM_HOP_MS = 20
SPECTRUM_FFT_SIZE = 4096
SPECTRUM_BAND_COUNT = 32
SPECTRUM_MIN_HZ = 40.0
SPECTRUM_MAX_HZ = 16_000.0
KICK_GATE_MODES = ("off", "soft", "middle", "hard")
KICK_GATE_THRESHOLDS = {
    # score percentile multiplier, absolute score floor, low floor multiplier,
    # minimum sub/body share, maximum 80ms decay ratio.
    "off": (0.0, 0.0, 0.0, 0.0, 1.0),
    "soft": (0.08, 0.035, 0.04, 0.40, 0.90),
    "middle": (0.13, 0.055, 0.08, 0.55, 0.70),
    "hard": (0.18, 0.08, 0.12, 0.70, 0.50),
}


class FeaturePoint(TypedDict):
    timeMs: int
    value: float


class WaveformPeak(TypedDict):
    min: float
    max: float


class WaveformPeaks(TypedDict):
    sampleIntervalMs: int
    windowSamples: int
    normalization: str
    music: list[WaveformPeak]
    drums: list[WaveformPeak]
    bass: list[WaveformPeak]
    vocals: list[WaveformPeak]
    other: list[WaveformPeak]


class FrequencySpectrum(TypedDict):
    hopMs: int
    fftSize: int
    bandCount: int
    sampleRateHz: int
    minHz: float
    maxHz: float
    normalization: str
    encoding: str
    values: list[int]


class FeatureTimeline(TypedDict, total=False):
    durationMs: int
    bassEnvelope: list[FeaturePoint]
    kickEvents: list[int]
    kickEventStrengths: list[float]
    drumEnergy: list[FeaturePoint]
    snareEvents: list[int]
    snareEventStrengths: list[float]
    vocalsEnvelope: list[FeaturePoint]
    otherEnvelope: list[FeaturePoint]
    musicEnergy: list[FeaturePoint]
    featureHopMs: int
    featureSampleRateHz: float
    normalization: str
    schemaVersion: int
    analysisVersion: str
    sampleRateHz: int
    timeUnit: str
    kickEventStrengthsUnit: str
    snareEventStrengthsUnit: str
    waveformPeaks: WaveformPeaks
    frequencySpectrum: FrequencySpectrum
    bpm: float
    bpmSource: str


def _validate_stem(samples: np.ndarray, name: str) -> np.ndarray:
    if samples.ndim != 2 or samples.shape[1] not in (1, 2) or samples.shape[0] == 0:
        raise AnalysisError(f"Stem {name} must be a non-empty [frames, channels] array")
    if not np.isfinite(samples).all():
        raise AnalysisError(f"Stem {name} contains NaN or Infinity")
    return samples.astype(np.float64, copy=False)


def _frames(samples: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    times: list[int] = []
    rms: list[float] = []
    for start in range(0, len(samples), HOP_SAMPLES):
        block = samples[start : start + HOP_SAMPLES]
        times.append(round(start * 1000 / TARGET_SAMPLE_RATE))
        rms.append(float(np.sqrt(np.mean(np.square(block)))))
    return np.asarray(times, dtype=np.int64), np.asarray(rms, dtype=np.float64)


def _normalize(values: np.ndarray) -> np.ndarray:
    finite: np.ndarray = np.asarray(
        np.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0), dtype=np.float64
    )
    scale = float(np.percentile(finite, 95)) if finite.size else 0.0
    if scale <= 1e-12:
        return np.zeros_like(finite)
    return np.clip(finite / scale, 0.0, 1.0)


def _points(times: np.ndarray, values: np.ndarray, duration_ms: int) -> list[FeaturePoint]:
    result: list[FeaturePoint] = []
    for time_ms, value in zip(times.tolist(), values.tolist(), strict=True):
        if 0 <= time_ms <= duration_ms:
            result.append({"timeMs": int(time_ms), "value": float(np.clip(value, 0.0, 1.0))})
    return result


def _waveform_peaks(samples: np.ndarray) -> list[WaveformPeak]:
    """Signed full-scale min/max per fixed 20ms window, flattened across channels."""
    valid = _validate_stem(samples, "waveform")
    # Separation stems can exceed full scale even though the corresponding WAV
    # output is clipped to PCM range. Keep Timeline peaks inside its [-1, 1]
    # contract using the same clipping semantics.
    valid = np.clip(valid, -1.0, 1.0)
    result: list[WaveformPeak] = []
    for start in range(0, len(valid), WAVEFORM_PEAK_SAMPLES):
        window = valid[start : start + WAVEFORM_PEAK_SAMPLES]
        result.append({"min": float(window.min()), "max": float(window.max())})
    return result


def _frequency_spectrum(
    samples: np.ndarray, sample_rate_hz: int = TARGET_SAMPLE_RATE
) -> FrequencySpectrum:
    """Return time-major, uint8-quantized log-band RMS values at a 20ms hop."""
    valid = _validate_stem(samples, "frequency spectrum")
    if sample_rate_hz <= 0:
        raise AnalysisError("Spectrum sample rate must be positive")
    nyquist = sample_rate_hz / 2
    max_hz = min(SPECTRUM_MAX_HZ, nyquist)
    if max_hz <= SPECTRUM_MIN_HZ:
        raise AnalysisError("Sample rate is too low for the frequency spectrum")
    hop_samples = sample_rate_hz * SPECTRUM_HOP_MS // 1000
    if hop_samples <= 0:
        raise AnalysisError("Spectrum hop is smaller than one sample")
    mono = valid.mean(axis=1)
    window = np.hanning(SPECTRUM_FFT_SIZE)
    edges = np.geomspace(SPECTRUM_MIN_HZ, max_hz, SPECTRUM_BAND_COUNT + 1)
    frequencies = np.fft.rfftfreq(SPECTRUM_FFT_SIZE, d=1 / sample_rate_hz)
    masks = [
        (frequencies >= edges[index]) & (frequencies < edges[index + 1])
        for index in range(SPECTRUM_BAND_COUNT)
    ]
    frames = (len(mono) + hop_samples - 1) // hop_samples
    energy = np.zeros((frames, SPECTRUM_BAND_COUNT), dtype=np.float64)
    window_gain = float(window.sum())
    for frame_index in range(frames):
        start = frame_index * hop_samples
        center = start + hop_samples // 2
        left = center - SPECTRUM_FFT_SIZE // 2
        source_left = max(0, left)
        source_right = min(len(mono), left + SPECTRUM_FFT_SIZE)
        padded = np.zeros(SPECTRUM_FFT_SIZE, dtype=np.float64)
        if source_right > source_left:
            target_left = source_left - left
            padded[target_left : target_left + source_right - source_left] = mono[
                source_left:source_right
            ]
        magnitudes = np.abs(np.fft.rfft(padded * window)) / max(window_gain, 1.0)
        for band_index, mask in enumerate(masks):
            if np.any(mask):
                energy[frame_index, band_index] = float(
                    np.sqrt(np.sum(np.square(magnitudes[mask])) * 2.0)
                )
    if not np.isfinite(energy).all():
        raise AnalysisError("Frequency spectrum contains NaN or Infinity")
    compressed = np.log1p(energy * 32.0)
    positive = compressed[compressed > 1e-12]
    scale = float(np.percentile(positive, 99.0)) if positive.size else 0.0
    if scale <= 1e-12:
        quantized = np.zeros_like(compressed, dtype=np.uint8)
    else:
        quantized = np.rint(np.clip(compressed / scale, 0.0, 1.0) * 255).astype(np.uint8)
    return {
        "hopMs": SPECTRUM_HOP_MS,
        "fftSize": SPECTRUM_FFT_SIZE,
        "bandCount": SPECTRUM_BAND_COUNT,
        "sampleRateHz": sample_rate_hz,
        "minHz": SPECTRUM_MIN_HZ,
        "maxHz": float(max_hz),
        "normalization": "whole-clip-p99-log-rms",
        "encoding": "uint8-linear-0-255",
        "values": quantized.reshape(-1).astype(int).tolist(),
    }


def estimate_bpm(kick_events: list[int]) -> tuple[float, str]:
    """Estimate a conventional 60..180 BPM tempo from regular kick intervals.

    This estimates tempo only, not beat phase/position. Sparse or irregular
    kick candidates use the explicit 120 BPM fallback.
    """
    if len(kick_events) < 4:
        return 120.0, "fallback"
    intervals = np.diff(np.asarray(kick_events, dtype=np.float64))
    intervals = intervals[(intervals >= 250) & (intervals <= 2000)]
    if intervals.size < 3:
        return 120.0, "fallback"
    median = float(np.median(intervals))
    deviation = float(np.median(np.abs(intervals - median)))
    if median <= 0 or deviation / median > 0.25:
        return 120.0, "fallback"
    bpm = 60_000.0 / median
    # Protect common quantized 180 BPM intervals (333ms) from rounding above
    # the conventional range and being misread as half-time 90 BPM.
    if 180 < bpm <= 185:
        bpm = 180.0
    while bpm < 60:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    if not 60 <= bpm <= 180:
        return 120.0, "fallback"
    return round(bpm, 2), "kick-estimated"


def detect_kicks_legacy(drums: np.ndarray) -> tuple[list[int], list[float]]:
    """Baseline detector retained for deterministic comparison tests."""
    samples = _validate_stem(drums, "drums")
    mono = samples.mean(axis=1)
    frame_size = 2048
    window = np.hanning(frame_size)
    frequencies = np.fft.rfftfreq(frame_size, 1 / TARGET_SAMPLE_RATE)
    band = (frequencies >= 30) & (frequencies <= 150)
    energies: list[float] = []
    for start in range(0, len(mono), HOP_SAMPLES):
        frame = mono[start : start + frame_size]
        padded = np.zeros(frame_size, dtype=np.float64)
        padded[: len(frame)] = frame
        spectrum = np.abs(np.fft.rfft(padded * window))
        energies.append(float(np.sqrt(np.mean(np.square(spectrum[band])))))
    energy = np.asarray(energies, dtype=np.float64)
    normalized = _normalize(energy)
    if normalized.size < 3 or float(normalized.max(initial=0.0)) < 0.25:
        return [], []

    median = float(np.median(normalized))
    mad = float(np.median(np.abs(normalized - median)))
    threshold = max(0.25, median + 3.0 * mad)
    min_gap_frames = 18  # 180ms prevents repeated peaks within one kick.
    events: list[int] = []
    strengths: list[float] = []
    last_frame = -min_gap_frames
    for index in range(1, len(normalized) - 1):
        if (
            normalized[index] < threshold
            or normalized[index] < normalized[index - 1]
            or normalized[index] <= normalized[index + 1]
        ):
            continue
        if index - last_frame < min_gap_frames:
            if normalized[index] > strengths[-1]:
                events[-1] = index * HOP_MS
                strengths[-1] = float(normalized[index])
                last_frame = index
            continue
        events.append(index * HOP_MS)
        strengths.append(float(normalized[index]))
        last_frame = index
    return events, strengths


def detect_kicks(drums: np.ndarray, gate_mode: str = "hard") -> tuple[list[int], list[float]]:
    """Detect kick-like transients using low-band rise, spectral ratio, and decay.

    This remains an estimate from the mixed Demucs drums stem, not isolated or
    ground-truth kick labels. The 80ms decay look-ahead is deterministic.
    """
    if gate_mode not in KICK_GATE_THRESHOLDS:
        raise AnalysisError("Kick gate mode must be off, soft, middle, or hard")
    samples = _validate_stem(drums, "drums")
    mono = samples.mean(axis=1)
    frame_size = 2048
    window = np.hanning(frame_size)
    frequencies = np.fft.rfftfreq(frame_size, 1 / TARGET_SAMPLE_RATE)
    masks = (
        (frequencies >= 35) & (frequencies < 80),
        (frequencies >= 35) & (frequencies <= 120),
        (frequencies >= 100) & (frequencies <= 250),
    )
    bands = np.zeros((int(np.ceil(len(mono) / HOP_SAMPLES)), 3), dtype=np.float64)
    for index, start in enumerate(range(0, len(mono), HOP_SAMPLES)):
        frame = mono[start : start + frame_size]
        padded = np.zeros(frame_size, dtype=np.float64)
        padded[: len(frame)] = frame
        power = np.square(np.abs(np.fft.rfft(padded * window)))
        bands[index] = [
            float(np.sqrt(np.mean(power[mask]))) if np.any(mask) else 0.0
            for mask in masks
        ]

    sub, low, mid = bands.T
    if low.size < 3 or float(low.max(initial=0.0)) <= 1e-12:
        return [], []
    history = max(1, round(500 / HOP_MS))
    baseline = np.asarray(
        [np.median(low[max(0, i - history) : i]) if i else 0.0 for i in range(len(low))]
    )
    floor = max(float(np.percentile(low, 75)) * 0.03, 1e-9)
    rise = np.maximum(0.0, low - np.concatenate(([0.0], low[:-1])))
    score = np.log1p(rise / (baseline + floor)) * np.clip(sub / (sub + mid + 1e-9), 0.0, 1.0)
    score_scale, score_floor, low_scale, ratio_floor, decay_ceiling = KICK_GATE_THRESHOLDS[
        gate_mode
    ]
    score_threshold = max(float(np.percentile(score, 85)) * score_scale, score_floor)
    low_threshold = float(np.percentile(low, 65)) * low_scale
    decay_frames = round(80 / HOP_MS)
    candidate_indices: list[int] = []
    candidate_scores: list[float] = []
    for index in range(1, len(score) - 1):
        future = min(len(low) - 1, index + decay_frames)
        decay = low[future] / max(low[index], 1e-9)
        ratio = sub[index] / max(sub[index] + mid[index], 1e-9)
        if score[index] <= 1e-12:
            continue
        if (
            score[index] < score[index - 1]
            or score[index] <= score[index + 1]
            or (gate_mode != "off" and score[index] < score_threshold)
            or (gate_mode != "off" and low[index] < low_threshold)
            or (gate_mode != "off" and ratio < ratio_floor)
            or (gate_mode != "off" and decay > decay_ceiling)
        ):
            continue
        if candidate_indices and index - candidate_indices[-1] < 12:
            if score[index] > candidate_scores[-1]:
                candidate_indices[-1] = index
                candidate_scores[-1] = float(score[index])
        else:
            candidate_indices.append(index)
            candidate_scores.append(float(score[index]))
    if not candidate_scores:
        return [], []
    scale = float(np.percentile(candidate_scores, 99.0))
    strengths = [float(np.clip(value / max(scale, 1e-12), 0.0, 1.0)) for value in candidate_scores]
    return [index * HOP_MS for index in candidate_indices], strengths


def detect_snares(drums: np.ndarray) -> tuple[list[int], list[float]]:
    """Estimate snare-like mid/high transient onsets from the mixed drums stem."""
    samples = _validate_stem(drums, "drums")
    mono = samples.mean(axis=1)
    size = 2048
    window = np.hanning(size)
    frequencies = np.fft.rfftfreq(size, 1 / TARGET_SAMPLE_RATE)
    band = (frequencies >= 700) & (frequencies <= 10_000)
    energies = []
    for start in range(0, len(mono), HOP_SAMPLES):
        frame = mono[start : start + size]
        padded = np.zeros(size, dtype=np.float64)
        padded[:len(frame)] = frame
        spectrum = np.abs(np.fft.rfft(padded * window))
        energies.append(float(np.sqrt(np.mean(np.square(spectrum[band])))))
    normalized = _normalize(np.asarray(energies, dtype=np.float64))
    if normalized.size < 3 or float(normalized.max(initial=0.0)) < 0.2:
        return [], []
    median = float(np.median(normalized))
    mad = float(np.median(np.abs(normalized - median)))
    threshold = max(0.2, median + 3.0 * mad)
    events: list[int] = []
    strengths: list[float] = []
    min_gap = 12  # 120ms; snare-like transients are shorter and denser than kick candidates.
    for index in range(1, len(normalized) - 1):
        if normalized[index] < threshold or normalized[index] < normalized[index - 1] or normalized[index] <= normalized[index + 1]:
            continue
        if events and index - events[-1] // HOP_MS < min_gap:
            if normalized[index] > strengths[-1]:
                events[-1], strengths[-1] = index * HOP_MS, float(normalized[index])
        else:
            events.append(index * HOP_MS)
            strengths.append(float(normalized[index]))
    return events, strengths


def extract_features(
    stems: dict[str, np.ndarray],
    duration_ms: int,
    audio: np.ndarray,
    *,
    kick_gate_mode: str = "hard",
) -> FeatureTimeline:
    required = {"drums", "bass", "vocals", "other"}
    if set(stems) != required:
        raise AnalysisError("Demucs output must contain exactly drums, bass, vocals, and other")
    if duration_ms <= 0:
        raise AnalysisError("Duration must be a positive millisecond value")
    times_by_stem: dict[str, np.ndarray] = {}
    rms_by_stem: dict[str, np.ndarray] = {}
    for name, samples in stems.items():
        valid = _validate_stem(samples, name)
        times_by_stem[name], rms_by_stem[name] = _frames(valid)
    frame_counts = {len(samples) for samples in stems.values()}
    if len(frame_counts) != 1:
        raise AnalysisError("Demucs stems must have matching frame counts")
    if len(_validate_stem(audio, "music")) not in frame_counts:
        raise AnalysisError("Original music PCM must match Demucs stem duration")

    bass_times, bass_rms = times_by_stem["bass"], rms_by_stem["bass"]
    drum_times, drum_rms = times_by_stem["drums"], rms_by_stem["drums"]
    kick_times, kick_strengths = detect_kicks(stems["drums"], gate_mode=kick_gate_mode)
    bpm, bpm_source = estimate_bpm(kick_times)
    snare_times, snare_strengths = detect_snares(stems["drums"])
    points = _points(bass_times, _normalize(bass_rms), duration_ms)
    drum_points = _points(drum_times, _normalize(drum_rms), duration_ms)
    if not points:
        raise AnalysisError("Feature Timeline would have no Bass Envelope points")
    vocals_points = _points(times_by_stem["vocals"], _normalize(rms_by_stem["vocals"]), duration_ms)
    other_points = _points(times_by_stem["other"], _normalize(rms_by_stem["other"]), duration_ms)
    music_samples = _validate_stem(audio, "music")
    music_times, music_rms = _frames(music_samples)
    music_points = _points(music_times, _normalize(music_rms), duration_ms)
    return {
        "durationMs": duration_ms,
        "bpm": bpm,
        "bpmSource": bpm_source,
        "bassEnvelope": points,
        "kickEvents": [time for time in kick_times if 0 <= time <= duration_ms],
        "kickEventStrengths": [
            strength
            for time, strength in zip(kick_times, kick_strengths, strict=True)
            if 0 <= time <= duration_ms
        ],
        "drumEnergy": drum_points,
        "snareEvents": snare_times,
        "snareEventStrengths": snare_strengths,
        "vocalsEnvelope": vocals_points,
        "otherEnvelope": other_points,
        "musicEnergy": music_points,
        "waveformPeaks": {
            "sampleIntervalMs": WAVEFORM_PEAK_INTERVAL_MS,
            "windowSamples": WAVEFORM_PEAK_SAMPLES,
            "normalization": "signed-full-scale",
            "music": _waveform_peaks(music_samples),
            "drums": _waveform_peaks(stems["drums"]),
            "bass": _waveform_peaks(stems["bass"]),
            "vocals": _waveform_peaks(stems["vocals"]),
            "other": _waveform_peaks(stems["other"]),
        },
        "frequencySpectrum": _frequency_spectrum(music_samples),
        "featureHopMs": HOP_MS,
        "featureSampleRateHz": 1000 / HOP_MS,
        "normalization": (
            "each continuous feature is divided by its global 95th percentile RMS "
            "and clamped to 0..1"
        ),
    }
