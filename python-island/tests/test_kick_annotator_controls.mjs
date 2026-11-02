import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateAuditionWindow,
  candidatePrediction,
  candidatePredictionSummary,
  auditionReachedEnd,
  cancelWaveGesture,
  candidateReviewStatus,
  clampSeekTime,
  nearestCandidateIndex,
  setCandidateLabel,
  shouldCommitSeek,
  toggleCandidateKick,
  waveformPointerMode,
} from "../tools/kick-annotator/annotation-controls.mjs";

function annotations() {
  return { candidateReviews: [], candidatePredictions: [], kickOnsets: [], ambiguousEvents: [] };
}

test("legacy session data without prediction rows renders disposition-based provisional labels", () => {
  const candidates = [
    { timeMs: 100, detectorDisposition: "accepted" },
    { timeMs: 200, detectorDisposition: "rejected_or_merged" },
  ];
  assert.deepEqual(candidatePredictionSummary(candidates), {
    predictedKick: 1,
    predictedNonKick: 1,
  });
  assert.equal(candidatePrediction(candidates[0]).predictedKick, true);
  assert.equal(candidatePrediction(candidates[1]).predictedKick, false);
  assert.equal(candidatePrediction(candidates[0]).reviewed, false);
});

test("partial or stale prediction metadata falls back per candidate and preserves saved predictions", () => {
  const candidates = [
    { timeMs: 100, detectorDisposition: "accepted" },
    { timeMs: 200, detectorDisposition: "rejected_or_merged" },
  ];
  const rows = [{ candidateTimeMs: 100, predictedKick: false, reviewed: true, finalLabel: "non_kick" }];
  assert.equal(candidatePrediction(candidates[0], rows).predictedKick, false);
  assert.equal(candidatePrediction(candidates[0], rows).reviewed, true);
  assert.equal(candidatePrediction(candidates[1], rows).predictedKick, false);
  assert.deepEqual(candidatePredictionSummary(candidates, rows), {
    predictedKick: 0,
    predictedNonKick: 2,
  });
});

test("candidate Kick toggle only changes candidate labels and never duplicates events", () => {
  const data = annotations();
  toggleCandidateKick(data, 500);
  assert.equal(candidateReviewStatus(data, 500), "confirmed");
  assert.deepEqual(data.kickOnsets, [
    { timeMs: 500, reviewStatus: "confirmed", candidateTimeMs: 500 },
  ]);
  toggleCandidateKick(data, 500);
  assert.equal(candidateReviewStatus(data, 500), "unverified");
  assert.deepEqual(data.kickOnsets, []);
  assert.equal(data.candidateReviews.length, 1);
  const restored = JSON.parse(JSON.stringify(data));
  assert.equal(candidateReviewStatus(restored, 500), "unverified");
  assert.deepEqual(restored.kickOnsets, []);
});

test("candidate labeling links an existing manual onset at the same timestamp", () => {
  const data = annotations();
  data.kickOnsets.push({ timeMs: 200, reviewStatus: "confirmed" });
  setCandidateLabel(data, 201, "confirmed", 200);
  assert.equal(data.kickOnsets.length, 1);
  assert.equal(data.kickOnsets[0].candidateTimeMs, 201);
});

test("human corrections update review fields but preserve the automatic prediction", () => {
  const data = annotations();
  data.candidatePredictions.push({
    candidateTimeMs: 250,
    predictedKick: true,
    reviewed: false,
    finalLabel: null,
    predictionMethod: "detector_disposition_v1",
  });
  setCandidateLabel(data, 250, "rejected");
  assert.deepEqual(data.candidatePredictions[0], {
    candidateTimeMs: 250,
    predictedKick: true,
    reviewed: true,
    finalLabel: "non_kick",
    predictionMethod: "detector_disposition_v1",
  });
});

test("rejected and ambiguous labels never become confirmed Kick truth", () => {
  const data = annotations();
  setCandidateLabel(data, 300, "rejected");
  assert.equal(data.kickOnsets.length, 0);
  setCandidateLabel(data, 300, "ambiguous");
  assert.equal(data.kickOnsets.length, 0);
  assert.deepEqual(data.ambiguousEvents, [
    { timeMs: 300, reviewStatus: "ambiguous", candidateTimeMs: 300 },
  ]);
  setCandidateLabel(data, 300, "confirmed", 311);
  assert.deepEqual(data.kickOnsets, [
    { timeMs: 311, reviewStatus: "confirmed", candidateTimeMs: 300 },
  ]);
  assert.deepEqual(data.ambiguousEvents, []);
});

test("candidate audition runs from its onset to the next candidate", () => {
  const rows = [{ timeMs: 100 }, { timeMs: 300 }, { timeMs: 600 }];
  assert.deepEqual(candidateAuditionWindow(rows, rows[1], 1000), {
    startMs: 300,
    endMs: 600,
  });
  assert.deepEqual(candidateAuditionWindow(rows, rows[2], 1000), {
    startMs: 600,
    endMs: 1000,
  });
});

test("duplicate and near-identical candidate times never produce negative or zero duration", () => {
  const rows = [{ timeMs: 400 }, { timeMs: 400 }, { timeMs: 401 }];
  assert.deepEqual(candidateAuditionWindow(rows, rows[0], 1000), {
    startMs: 400,
    endMs: 401,
  });
  assert.deepEqual(candidateAuditionWindow(rows, rows[2], 1000), {
    startMs: 401,
    endMs: 1000,
  });
});

test("candidate audition range clamps to source boundaries", () => {
  const rows = [{ timeMs: -5 }, { timeMs: 1005 }];
  assert.deepEqual(candidateAuditionWindow(rows, rows[0], 1000), {
    startMs: 0,
    endMs: 1000,
  });
  assert.deepEqual(candidateAuditionWindow(rows, rows[1], 1000), {
    startMs: 999,
    endMs: 1000,
  });
  assert.deepEqual(candidateAuditionWindow([], { timeMs: 0 }, 0), {
    startMs: 0,
    endMs: 0,
  });
});

test("nearest candidate search selects the closest marker around seek position", () => {
  const candidates = [{ timeMs: 100 }, { timeMs: 300 }, { timeMs: 600 }];
  assert.equal(nearestCandidateIndex(candidates, 240), 1);
  assert.equal(nearestCandidateIndex(candidates, 440), 1);
  assert.equal(nearestCandidateIndex(candidates, 800), 2);
  assert.equal(nearestCandidateIndex([], 1), -1);
});

test("waveform pointer priority preserves Shift-range and playhead drag semantics", () => {
  assert.equal(waveformPointerMode(true, 0, 0), "range");
  assert.equal(waveformPointerMode(false, 4, 0), "seek");
  assert.equal(waveformPointerMode(false, 30, 5), "candidate");
  assert.equal(waveformPointerMode(false, 30, 20), "seek");
});

test("drag seeking is rate-limited while pointer-up can force the final seek", () => {
  assert.equal(shouldCommitSeek(40, 0), false);
  assert.equal(shouldCommitSeek(100, 0), true);
  assert.equal(shouldCommitSeek(40, 0, true), true);
});

test("seek clamps to audio boundaries and pointer cancel clears transient gesture state", () => {
  assert.equal(clampSeekTime(-10, 1000), 0);
  assert.equal(clampSeekTime(1010, 1000), 1000);
  assert.deepEqual(cancelWaveGesture(), { drag: null, rangeDraft: null, seekDraftMs: null });
});

test("candidate preview stops at its requested end time", () => {
  const audition = { stopMs: 800 };
  assert.equal(auditionReachedEnd(799, audition), false);
  assert.equal(auditionReachedEnd(800, audition), true);
  assert.equal(auditionReachedEnd(1000, null), false);
});
