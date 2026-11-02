import { describe, expect, it } from 'vitest';
import { demoBlueprint, demoFeatures, evaluateFrame } from './renderer';

describe('evaluateFrame', () => {
  it('interpolates feature values at the requested time', () => {
    expect(evaluateFrame(demoBlueprint, demoFeatures, 500)[0]?.opacity).toBeCloseTo(0.54375);
  });

  it('is independent of evaluation order', () => {
    const atStart = evaluateFrame(demoBlueprint, demoFeatures, 0);
    evaluateFrame(demoBlueprint, demoFeatures, 2000);
    expect(evaluateFrame(demoBlueprint, demoFeatures, 0)).toEqual(atStart);
  });

  it('clamps feature values and uses the last sample after the timeline', () => {
    const features = { 'bass.rms': [{ timeMs: 0, value: 2 }, { timeMs: 100, value: -1 }] };
    expect(evaluateFrame(demoBlueprint, features, 0)[0]?.opacity).toBeCloseTo(0.9);
    expect(evaluateFrame(demoBlueprint, features, 200)[0]?.opacity).toBeCloseTo(0.15);
  });
});
