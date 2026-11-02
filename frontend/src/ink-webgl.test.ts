import { describe, expect, it } from 'vitest';
import { inkEffectMode, inkShaderSourceForTests, renderInkDiffusion } from './ink-webgl';

describe('Ink WebGL2 shader', () => {
  it('declares a WebGL2 density-field shader with temporal flow, vortices and layered noise', () => {
    expect(inkShaderSourceForTests.vertexSource).toContain('#version 300 es');
    expect(inkShaderSourceForTests.fragmentSource).toContain('#version 300 es');
    expect(inkShaderSourceForTests.fragmentSource).toContain('vec2 vortex(');
    expect(inkShaderSourceForTests.fragmentSource).toContain('float fbm(');
    expect(inkShaderSourceForTests.fragmentSource).toContain('u_density');
    expect(inkShaderSourceForTests.fragmentSource).toContain('u_response');
    expect(inkShaderSourceForTests.fragmentSource).toContain('u_expansion');
    expect(inkShaderSourceForTests.fragmentSource).toContain('float coreDensity');
    expect(inkShaderSourceForTests.fragmentSource).toContain('float spreadRadius');
    expect(inkShaderSourceForTests.fragmentSource).toContain('vec2 driftB');
    expect(inkShaderSourceForTests.fragmentSource).toContain('float expansionFront');
    expect(inkShaderSourceForTests.fragmentSource).toContain('u_hasGradient');
    expect(inkShaderSourceForTests.fragmentSource).toContain('outColor = vec4(color * alpha, alpha)');
  });

  it('treats offscreen UVs as Region-local while retaining stage coordinates for gradient mapping', () => {
    expect(inkShaderSourceForTests.fragmentSource).toContain('vec2 local = v_uv;');
    expect(inkShaderSourceForTests.fragmentSource).not.toContain('(v_uv - u_region.xy) / max(u_region.zw');
    expect(inkShaderSourceForTests.fragmentSource).toContain('u_region.xy + v_uv * u_region.zw');
  });

  it('keeps broad diffusion as a weak carrier and applies a localized nonlinear premultiplied alpha mask', () => {
    const shader = inkShaderSourceForTests.fragmentSource;
    expect(shader).toContain('cloudEnvelope * (0.075 + u_density * 0.12)');
    expect(shader).toContain('expansionFront * (0.18 + u_response * 0.27)');
    expect(shader).toContain('float threshold = 0.32 + (1.0 - u_density) * 0.12 - u_response * 0.055;');
    expect(shader).toContain('float ink = smoothstep(threshold - 0.055, threshold + 0.16, densityField);');
    expect(shader).toContain('float alpha = pow(ink, 1.6)');
    expect(shader).toContain('outColor = vec4(color * alpha, alpha)');
    expect(shader).not.toContain('outColor = vec4(color,');
  });

  it('provides separate Flow stream-density and multi-pigment mixing shader modes', () => {
    const shader = inkShaderSourceForTests.fragmentSource;
    expect(shader).toContain('u_effectMode < 1.5 ? flowDensity : mixingField');
    expect(shader).toContain('float flowBody = smoothstep(0.18, 0.72, streams');
    expect(shader).toContain('vec2 mixWarpD =');
    expect(shader).toContain('if (u_effectMode > 1.5) mixedPalette = (u_colorA * mixA');
    expect(inkEffectMode('ink-diffusion')).toBe(0);
    expect(inkEffectMode('ink-flow')).toBe(1);
    expect(inkEffectMode('color-mixing')).toBe(2);
  });

  it('reports unavailable WebGL output so the shared renderer can use its Canvas2D fallback', () => {
    const context = { canvas: undefined } as unknown as CanvasRenderingContext2D;
    expect(renderInkDiffusion(context, {
      timeSeconds: 1, diffusionSpeed: 0.25, flowStrength: 0.4, turbulence: 0.3,
      inkDensity: 0.65, cloudScale: 0.5, response: 0.2, diffusion: 0.35, seed: 42, color: '#8855cc',
    }, 0, 0, 100, 100, 100, 100, 1)).toBe(false);
  });
});
