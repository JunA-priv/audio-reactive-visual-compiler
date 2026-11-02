export function candidateReviewStatus(annotations, candidateTimeMs) {
  return (
    annotations.candidateReviews.find(
      (review) => Number(review.candidateTimeMs) === Number(candidateTimeMs),
    )?.status ?? "unverified"
  );
}

export function candidatePrediction(candidate, predictions = []) {
  const saved = predictions.find(
    (prediction) => Number(prediction?.candidateTimeMs) === Number(candidate.timeMs),
  );
  if (saved && typeof saved.predictedKick === "boolean") return saved;
  return {
    candidateTimeMs: Number(candidate.timeMs),
    predictedKick: candidate.detectorDisposition === "accepted",
    reviewed: false,
    finalLabel: null,
    predictionMethod: "detector_disposition_v1",
  };
}

export function candidatePredictionSummary(candidates, predictions = []) {
  let predictedKick = 0;
  let predictedNonKick = 0;
  for (const candidate of candidates) {
    if (candidatePrediction(candidate, predictions).predictedKick) predictedKick += 1;
    else predictedNonKick += 1;
  }
  return { predictedKick, predictedNonKick };
}

export function setCandidateLabel(annotations, candidateTimeMs, status, labelTimeMs = candidateTimeMs) {
  const candidateTime = Number(candidateTimeMs);
  const labelTime = Number(labelTimeMs);
  const duplicateKick = annotations.kickOnsets.find(
    (event) =>
      status === "confirmed" &&
      Number(event.timeMs) === labelTime &&
      Number(event.candidateTimeMs) !== candidateTime,
  );
  if (duplicateKick?.candidateTimeMs !== undefined) {
    throw new Error("同じ時刻のKickラベルが既にあります。");
  }
  const reusableKick = annotations.kickOnsets.find(
    (event) =>
      status === "confirmed" &&
      Number(event.timeMs) === labelTime &&
      event.candidateTimeMs === undefined,
  );
  const reusableAmbiguous = annotations.ambiguousEvents.find(
    (event) =>
      status === "ambiguous" &&
      Number(event.timeMs) === labelTime &&
      event.candidateTimeMs === undefined,
  );
  annotations.candidateReviews = annotations.candidateReviews.filter(
    (review) => Number(review.candidateTimeMs) !== candidateTime,
  );
  annotations.candidateReviews.push({
    candidateTimeMs: candidateTime,
    status,
    labelTimeMs: labelTime,
  });
  const prediction = annotations.candidatePredictions?.find(
    (item) => Number(item.candidateTimeMs) === candidateTime,
  );
  if (prediction) {
    prediction.reviewed = ["confirmed", "rejected", "ambiguous"].includes(status);
    prediction.finalLabel =
      status === "confirmed"
        ? "kick"
        : status === "rejected"
          ? "non_kick"
          : status === "ambiguous"
            ? "ambiguous"
            : null;
  }
  annotations.kickOnsets = annotations.kickOnsets.filter(
    (event) => event === reusableKick || Number(event.candidateTimeMs) !== candidateTime,
  );
  annotations.ambiguousEvents = annotations.ambiguousEvents.filter(
    (event) =>
      event === reusableAmbiguous || Number(event.candidateTimeMs) !== candidateTime,
  );
  if (status === "confirmed") {
    if (reusableKick) reusableKick.candidateTimeMs = candidateTime;
    else {
      annotations.kickOnsets.push({
        timeMs: labelTime,
        reviewStatus: "confirmed",
        candidateTimeMs: candidateTime,
      });
    }
  } else if (status === "ambiguous") {
    if (reusableAmbiguous) reusableAmbiguous.candidateTimeMs = candidateTime;
    else {
      annotations.ambiguousEvents.push({
        timeMs: labelTime,
        reviewStatus: "ambiguous",
        candidateTimeMs: candidateTime,
      });
    }
  }
  return annotations;
}

export function toggleCandidateKick(annotations, candidateTimeMs) {
  const current = candidateReviewStatus(annotations, candidateTimeMs);
  return setCandidateLabel(
    annotations,
    candidateTimeMs,
    current === "confirmed" ? "unverified" : "confirmed",
  );
}

export function candidateAuditionWindow(candidates, selected, durationMs) {
  const duration = Math.max(0, Number(durationMs));
  if (duration === 0) return { startMs: 0, endMs: 0 };
  const candidateTime = Number(selected.timeMs);
  const startMs = Math.min(duration - 1, Math.max(0, candidateTime));
  const selectedIndex = Math.max(
    0,
    candidates.findIndex((candidate) => candidate === selected),
  );
  let nextTime = duration;
  for (let index = selectedIndex + 1; index < candidates.length; index += 1) {
    const time = Number(candidates[index].timeMs);
    if (time > candidateTime) {
      nextTime = time;
      break;
    }
  }
  let endMs = Math.min(duration, nextTime);
  if (endMs <= startMs) endMs = Math.min(duration, startMs + 1);
  return { startMs, endMs };
}

export function nearestCandidateIndex(candidates, timeMs) {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (Number(candidates[middle].timeMs) < timeMs) low = middle + 1;
    else high = middle;
  }
  const before = candidates[low - 1];
  const after = candidates[low];
  if (!before) return after ? low : -1;
  if (!after) return low - 1;
  return Math.abs(before.timeMs - timeMs) <= Math.abs(after.timeMs - timeMs) ? low - 1 : low;
}

export function waveformPointerMode(shiftKey, playheadDistancePx, candidateDistancePx) {
  if (shiftKey) return "range";
  if (playheadDistancePx <= 14) return "seek";
  if (candidateDistancePx <= 9) return "candidate";
  return "seek";
}

export function shouldCommitSeek(nowMs, lastCommitMs, force = false) {
  return force || nowMs - lastCommitMs >= 100;
}

export function clampSeekTime(timeMs, durationMs) {
  return Math.max(0, Math.min(Number(durationMs), Number(timeMs)));
}

export function cancelWaveGesture() {
  return { drag: null, rangeDraft: null, seekDraftMs: null };
}

export function auditionReachedEnd(currentTimeMs, audition) {
  return Boolean(audition && currentTimeMs >= audition.stopMs);
}
