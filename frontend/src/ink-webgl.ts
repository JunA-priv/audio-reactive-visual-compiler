export type InkRenderPayload = {
  effectKind?: 'ink-diffusion' | 'ink-flow' | 'color-mixing';
  timeSeconds: number;
  diffusionSpeed: number;
  flowStrength: number;
  turbulence: number;
  inkDensity: number;
  cloudScale: number;
  response: number;
  diffusion: number;
  seed: number;
  color: string;
  paletteColors?: string[];
  gradient?: { startColor: string; middleColor: string; endColor: string; angleDeg: number };
};

type InkRenderer = {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  lost: boolean;
  restorePending: boolean;
  lastUsed: number;
};

const MAX_CONTEXTS = 4;
const renderers = new Map<HTMLCanvasElement, InkRenderer>();

const vertexSource = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_stageResolution;
uniform vec4 u_region;
uniform float u_time;
uniform float u_speed;
uniform float u_flow;
uniform float u_turbulence;
uniform float u_density;
uniform float u_scale;
uniform float u_response;
uniform float u_expansion;
uniform float u_seed;
uniform vec3 u_colorA;
uniform vec3 u_colorB;
uniform vec3 u_colorC;
uniform vec3 u_colorD;
uniform float u_gradientAngle;
uniform float u_hasGradient;
uniform float u_hasPalette;
uniform float u_effectMode;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45) + u_seed * 0.00017);
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float value = 0.0, amplitude = 0.5;
  mat2 turn = mat2(1.62, -1.18, 1.18, 1.62);
  for (int octave = 0; octave < 5; octave++) {
    value += amplitude * noise(p);
    p = turn * p + 0.13;
    amplitude *= 0.5;
  }
  return value;
}
float cloudSource(vec2 p, vec2 center, float radius) {
  vec2 d = p - center;
  return exp(-dot(d, d) / max(0.003, radius));
}
vec2 vortex(vec2 p, vec2 center, float direction, float radius) {
  vec2 d = p - center;
  float r2 = dot(d, d);
  float weight = exp(-r2 / max(0.001, radius)) * direction;
  float angle = weight * (0.8 + u_flow * 2.1 + u_response * 0.7);
  float c = cos(angle), s = sin(angle);
  return mat2(c, -s, s, c) * d + center;
}
void main() {
  // The offscreen texture already spans the Region bounding box. Its UV is
  // Region-local; subtracting the stage-space Region origin here shrinks the
  // visible field a second time for inset Regions such as the default Stage.
  vec2 local = v_uv;
  if (any(lessThan(local, vec2(0.0))) || any(greaterThan(local, vec2(1.0)))) { outColor = vec4(0.0); return; }
  float aspect = max(0.2, (u_region.z * u_stageResolution.x) / max(1.0, u_region.w * u_stageResolution.y));
  float scale = 0.82 + u_scale * 0.36;
  vec2 p = (local - 0.5) * vec2(aspect, 1.0) / max(0.12, scale);
  float t = u_time * u_speed * (0.34 + u_response * 1.05);
  float phaseA = t * 0.31 + hash21(vec2(2.7, 4.1)) * 6.28318;
  float phaseB = t * 0.19 + hash21(vec2(7.3, 1.9)) * 6.28318;
  float phaseC = t * 0.11 + hash21(vec2(3.4, 8.2)) * 6.28318;
  float spreadRadius = (0.20 + u_expansion * 0.72 + u_response * 0.36) * (0.78 + u_scale * 0.44);
  float seedAngle = hash21(vec2(9.1, 2.3)) * 6.28318;
  vec2 c0 = vec2(cos(seedAngle + phaseA), sin(seedAngle + phaseA)) * spreadRadius * 0.43;
  vec2 c1 = vec2(cos(seedAngle + 1.57 - phaseB), sin(seedAngle + 1.57 - phaseB)) * spreadRadius * 0.56;
  vec2 c2 = vec2(cos(seedAngle + 3.18 + phaseC), sin(seedAngle + 3.18 + phaseC)) * spreadRadius * 0.48;
  vec2 c3 = vec2(cos(seedAngle + 4.82 - phaseA * 0.72), sin(seedAngle + 4.82 - phaseA * 0.72)) * spreadRadius * 0.60;
  vec2 q = p;
  q = vortex(q, c0, 1.0, 0.12 + u_response * 0.08);
  q = vortex(q, c1, -1.0, 0.16 + u_turbulence * 0.08);
  q = vortex(q, c2, 1.0, 0.09 + u_flow * 0.06);
  q = vortex(q, c3, -1.0, 0.13 + u_response * 0.07);
  vec2 driftA = vec2(cos(phaseA), sin(phaseB)) * t * 0.23;
  vec2 driftB = vec2(cos(phaseC + 1.1), sin(phaseA - 0.7)) * t * 0.17;
  vec2 warpA = vec2(fbm(q * 2.9 + driftA), fbm(q * 2.9 - driftA + 7.1)) - 0.5;
  vec2 warpB = vec2(fbm(q * 6.7 + driftB + 13.2), fbm(q * 6.7 - driftB + 3.8)) - 0.5;
  vec2 advected = q + warpA * (0.20 + u_turbulence * 0.50 + u_flow * 0.25)
      + warpB * (0.045 + u_turbulence * 0.13);
  float broad = fbm(advected * 3.7 + driftA * 0.7 + phaseC);
  float detail = fbm(advected * 10.8 - driftB * 1.4 + phaseB);
  float radius = length(advected);
  float coreRadius = 0.12 + u_density * 0.035;
  float coreDensity = exp(-dot(advected, advected) / (coreRadius * coreRadius * 1.45));
  float lobeRadius = 0.045 + u_expansion * 0.075 + u_turbulence * 0.03;
  float lobes = 0.52 * cloudSource(advected, c0, lobeRadius)
      + 0.48 * cloudSource(advected, c1, lobeRadius * 1.18)
      + 0.46 * cloudSource(advected, c2, lobeRadius * 0.9)
      + 0.5 * cloudSource(advected, c3, lobeRadius * 1.12);
  float cloudEnvelope = exp(-radius * radius / max(0.02, spreadRadius * spreadRadius * 1.55));
  float frontWidth = 0.075 + u_expansion * 0.065 + u_response * 0.045;
  float expansionFront = exp(-pow((radius - spreadRadius * 0.91) / frontWidth, 2.0));
  // Keep the broad field as a weak carrier only. The core, satellite lobes,
  // and moving front provide local pigment; they must not turn the entire
  // Region into a low-alpha color wash.
  float diffusionField = coreDensity * 1.12 + lobes * 0.76 + cloudEnvelope * (0.075 + u_density * 0.12)
      + expansionFront * (0.18 + u_response * 0.27)
      + (broad - 0.5) * (0.13 + u_turbulence * 0.22)
      + (detail - 0.5) * (0.09 + u_turbulence * 0.18);
  float flowAngle = 0.0;
  float flowDensity = 0.0, mixingField = 0.0;
  float mixA = 0.0, mixB = 0.0, mixC = 0.0, mixD = 0.0;
  if (u_effectMode > 0.5) {
    flowAngle = atan(advected.y, advected.x);
    float flowField = fbm(advected * 4.3 + vec2(t * 0.12, -t * 0.08));
    float streamA = exp(-pow(sin(flowAngle * 2.4 + radius * (11.0 + u_flow * 3.0) + flowField * 2.4 + phaseA) / (0.24 + u_response * 0.12), 2.0));
    float streamB = exp(-pow(sin(flowAngle * 1.55 - radius * 8.5 + detail * 2.0 - phaseC) / (0.30 + u_turbulence * 0.1), 2.0));
    float streams = max(streamA * 0.7, streamB * 0.56) * smoothstep(0.04, 0.18, radius)
        * (1.0 - smoothstep(spreadRadius * 0.28, spreadRadius * 1.55, radius));
    float flowBody = smoothstep(0.18, 0.72, streams + max(0.0, flowField - 0.48) * 0.55);
    float flowEdge = smoothstep(0.08, 0.3, streams) * (0.5 + 0.5 * detail);
    flowDensity = flowBody * (0.72 + 0.18 * broad) + flowEdge * (0.12 + u_density * 0.12)
        + coreDensity * 0.28 + lobes * (0.08 + u_response * 0.13);
    if (u_effectMode > 1.5) {
      vec2 mixWarpA = (vec2(fbm(advected * 3.1 + driftA + phaseA), fbm(advected * 3.1 - driftA + phaseB)) - 0.5) * (0.16 + u_response * 0.06);
      vec2 mixWarpB = (vec2(fbm(advected * 4.0 + driftB + 8.3), fbm(advected * 4.0 - driftB + 2.1)) - 0.5) * (0.18 + u_turbulence * 0.07);
      vec2 mixWarpC = (vec2(fbm(advected * 5.2 + driftA + 4.7), fbm(advected * 5.2 - driftB + 11.2)) - 0.5) * (0.14 + u_flow * 0.06);
      vec2 mixWarpD = (vec2(fbm(advected * 6.1 - driftB + 5.4), fbm(advected * 6.1 + driftA + 9.6)) - 0.5) * (0.12 + u_turbulence * 0.06);
      mixA = cloudSource(advected + mixWarpA, c0, lobeRadius * 1.34);
      mixB = cloudSource(advected + mixWarpB, c1, lobeRadius * 1.46);
      mixC = cloudSource(advected + mixWarpC, c2, lobeRadius * 1.28);
      mixD = cloudSource(advected + mixWarpD, c3, lobeRadius * 1.38);
      float dominantDensity = max(max(mixA, mixB), max(mixC, mixD));
      float secondaryDensity = min(max(mixA, mixB), max(mixC, mixD));
      float mixingRidge = pow(1.0 - abs(mixA - mixB) * 1.8, 5.0) * pow(1.0 - abs(mixC - mixD) * 1.5, 3.0);
      mixingField = dominantDensity * (0.88 + 0.12 * broad) + secondaryDensity * 0.12
          + mixingRidge * smoothstep(0.18, 0.58, dominantDensity) * (0.035 + u_turbulence * 0.025);
    }
  }
  float densityField = u_effectMode < 0.5 ? diffusionField : (u_effectMode < 1.5 ? flowDensity : mixingField);
  float threshold = 0.32 + (1.0 - u_density) * 0.12 - u_response * 0.055;
  float ink = smoothstep(threshold - 0.055, threshold + 0.16, densityField);
  if (u_effectMode > 0.5 && u_effectMode < 1.5) ink = smoothstep(0.24, 0.64, flowDensity);
  if (u_effectMode > 1.5) ink = smoothstep(threshold + 0.015, threshold + 0.17, mixingField);
  float angle = atan(advected.y, advected.x);
  float filamentPhase = angle * (4.0 + floor(hash21(vec2(5.2, 1.3)) * 5.0))
      + radius * (15.0 + u_turbulence * 12.0) + phaseA + broad * 4.0;
  float filaments = pow(1.0 - abs(sin(filamentPhase)), 12.0);
  float filamentStrength = u_effectMode < 0.5 ? (0.08 + u_flow * 0.18 + u_response * 0.14)
      : (u_effectMode < 1.5 ? (0.02 + u_flow * 0.05) : (0.035 + u_turbulence * 0.05));
  filaments *= smoothstep(0.12, 0.52, radius) * cloudEnvelope * filamentStrength;
  ink = clamp(ink + filaments, 0.0, 1.0);
  float innerDensity = clamp(coreDensity * 0.55 + lobes * 0.3 + smoothstep(threshold + 0.08, threshold + 0.42, densityField) * 0.55, 0.0, 1.0);
  vec2 gradientDirection = vec2(cos(u_gradientAngle), sin(u_gradientAngle));
  vec2 stagePoint = u_region.xy + v_uv * u_region.zw;
  float halfGradientLength = max(1.0, (abs(u_stageResolution.x * gradientDirection.x) + abs(u_stageResolution.y * gradientDirection.y)) * 0.5);
  float gradientPosition = dot((stagePoint - 0.5) * u_stageResolution, gradientDirection) / (2.0 * halfGradientLength) + 0.5;
  float pigment = clamp(gradientPosition * 0.48 + broad * 0.34 + detail * 0.12 + sin(phaseB + radius * 5.0) * 0.08, 0.0, 1.0);
  vec3 palette = pigment < 0.5 ? mix(u_colorA, u_colorB, smoothstep(0.0, 0.5, pigment)) : mix(u_colorB, u_colorC, smoothstep(0.5, 1.0, pigment));
  vec3 customTone = u_colorA * (0.72 + 0.28 * broad);
  vec3 color = mix(customTone, palette, u_hasGradient);
  vec3 flowPalette = u_colorA;
  if (u_effectMode > 0.5) flowPalette = mix(u_colorA, u_colorC, clamp(0.5 + 0.25 * sin(flowAngle * 2.0 + broad * 5.0 + phaseB) + 0.25 * detail, 0.0, 1.0));
  vec3 mixedPalette = u_colorA;
  if (u_effectMode > 1.5) mixedPalette = (u_colorA * mixA + u_colorB * mixB + u_colorC * mixC + u_colorD * mixD) / max(0.001, mixA + mixB + mixC + mixD);
  if (u_hasGradient > 0.5) mixedPalette = mix(mixedPalette, palette, 0.14 + 0.1 * broad);
  if (u_effectMode > 0.5 && u_effectMode < 1.5) color = mix(customTone, flowPalette, u_hasGradient);
  if (u_effectMode > 1.5) color = mix(customTone, mixedPalette, max(u_hasGradient, u_hasPalette));
  float alpha = pow(ink, 1.6) * (0.10 + u_density * 0.46) * (0.78 + u_expansion * 0.24 + u_response * 0.16);
  if (u_effectMode > 0.5 && u_effectMode < 1.5) alpha *= 0.82;
  if (u_effectMode > 1.5) alpha *= 0.9;
  alpha *= 0.58 + innerDensity * 0.62;
  alpha = clamp(alpha, 0.0, 0.72);
  // WebGL context is premultipliedAlpha=true; transparent gaps therefore
  // carry zero RGB as well as zero alpha when composited by Canvas2D.
  outColor = vec4(color * alpha, alpha);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); return null; }
  return shader;
}

function initialize(gl: WebGL2RenderingContext): { program: WebGLProgram; buffer: WebGLBuffer } | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) { if (vertex) gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); return null; }
  const program = gl.createProgram();
  if (!program) { gl.deleteShader(vertex); gl.deleteShader(fragment); return null; }
  gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
  gl.deleteShader(vertex); gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
  const buffer = gl.createBuffer();
  if (!buffer) { gl.deleteProgram(program); return null; }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  return { program, buffer };
}

function dispose(renderer: InkRenderer): void {
  renderer.gl.deleteBuffer(renderer.buffer);
  renderer.gl.deleteProgram(renderer.program);
  renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
}

function getRenderer(target: HTMLCanvasElement): InkRenderer | null {
  const existing = renderers.get(target);
  if (existing) {
    existing.lastUsed = performance.now();
    if (existing.lost) return null;
    if (existing.restorePending) {
      const handles = initialize(existing.gl);
      if (!handles) return null;
      existing.program = handles.program; existing.buffer = handles.buffer; existing.restorePending = false;
    }
    return existing;
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  let gl: WebGL2RenderingContext;
  try {
    const context = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    if (!context) return null;
    gl = context;
  } catch { return null; }
  const handles = initialize(gl);
  if (!handles) { gl.getExtension('WEBGL_lose_context')?.loseContext(); return null; }
  const renderer: InkRenderer = { canvas, gl, ...handles, lost: false, restorePending: false, lastUsed: performance.now() };
  canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); renderer.lost = true; });
  canvas.addEventListener('webglcontextrestored', () => { renderer.lost = false; renderer.restorePending = true; });
  renderers.set(target, renderer);
  if (renderers.size > MAX_CONTEXTS) {
    const oldest = [...renderers.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest && oldest[0] !== target) { renderers.delete(oldest[0]); dispose(oldest[1]); }
  }
  return renderer;
}

function hexColor(value: string): [number, number, number] {
  const color = /^#([0-9a-f]{6})$/i.exec(value)?.[1] ?? 'ffffff';
  return [0, 2, 4].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

function uniform1(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, value: number): void {
  const location = gl.getUniformLocation(program, name);
  if (location) gl.uniform1f(location, value);
}

export function inkEffectMode(effectKind: InkRenderPayload['effectKind']): number {
  return effectKind === 'ink-flow' ? 1 : effectKind === 'color-mixing' ? 2 : 0;
}

function paletteColor(value: string): [number, number, number] { return hexColor(value); }

export function renderInkDiffusion(
  context: CanvasRenderingContext2D,
  payload: InkRenderPayload,
  x: number,
  y: number,
  width: number,
  height: number,
  canvasWidth: number,
  canvasHeight: number,
  opacity: number,
): boolean {
  const target = context.canvas as HTMLCanvasElement | undefined;
  if (!target || typeof target.getContext !== 'function' || target.width < 1 || target.height < 1) return false;
  const renderer = getRenderer(target);
  if (!renderer) return false;
  const { gl, canvas } = renderer;
  const pixelScaleX = target.width / canvasWidth;
  const pixelScaleY = target.height / canvasHeight;
  const regionPixelWidth = Math.max(1, Math.ceil(width * pixelScaleX));
  const regionPixelHeight = Math.max(1, Math.ceil(height * pixelScaleY));
  if (canvas.width !== regionPixelWidth || canvas.height !== regionPixelHeight) { canvas.width = regionPixelWidth; canvas.height = regionPixelHeight; }
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(renderer.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.buffer);
  const position = gl.getAttribLocation(renderer.program, 'a_position');
  if (position < 0) return false;
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const region = gl.getUniformLocation(renderer.program, 'u_region');
  if (region) gl.uniform4f(region, x / canvasWidth, y / canvasHeight, width / canvasWidth, height / canvasHeight);
  const stageResolution = gl.getUniformLocation(renderer.program, 'u_stageResolution');
  if (stageResolution) gl.uniform2f(stageResolution, canvasWidth, canvasHeight);
  uniform1(gl, renderer.program, 'u_time', payload.timeSeconds);
  uniform1(gl, renderer.program, 'u_speed', payload.diffusionSpeed);
  uniform1(gl, renderer.program, 'u_flow', payload.flowStrength);
  uniform1(gl, renderer.program, 'u_turbulence', payload.turbulence);
  uniform1(gl, renderer.program, 'u_density', payload.inkDensity);
  uniform1(gl, renderer.program, 'u_scale', payload.cloudScale);
  uniform1(gl, renderer.program, 'u_response', payload.response);
  uniform1(gl, renderer.program, 'u_expansion', payload.diffusion);
  uniform1(gl, renderer.program, 'u_seed', payload.seed >>> 0);
  uniform1(gl, renderer.program, 'u_effectMode', inkEffectMode(payload.effectKind));
  const hasGradient = payload.gradient ? 1 : 0;
  uniform1(gl, renderer.program, 'u_hasGradient', hasGradient);
  uniform1(gl, renderer.program, 'u_hasPalette', payload.effectKind === 'color-mixing' && (payload.paletteColors?.length ?? 0) >= 2 && !payload.gradient ? 1 : 0);
  const gradientAngle = ((payload.gradient?.angleDeg ?? 0) * Math.PI) / 180;
  uniform1(gl, renderer.program, 'u_gradientAngle', gradientAngle);
  const palette = payload.effectKind === 'color-mixing' && !payload.gradient && payload.paletteColors?.length
    ? payload.paletteColors.slice(0, 4).map(paletteColor)
    : null;
  const colors = payload.gradient
    ? [hexColor(payload.gradient.startColor), hexColor(payload.gradient.middleColor), hexColor(payload.gradient.endColor), hexColor(payload.gradient.middleColor)]
    : palette
      ? [palette[0]!, palette[1]!, palette[2] ?? palette[0]!, palette[3] ?? palette[1]!]
    : [hexColor(payload.color), hexColor(payload.color), hexColor(payload.color), hexColor(payload.color)];
  for (const [index, name] of ['u_colorA', 'u_colorB', 'u_colorC', 'u_colorD'].entries()) {
    const location = gl.getUniformLocation(renderer.program, name);
    const color = colors[index]!;
    if (location) gl.uniform3f(location, color[0], color[1], color[2]);
  }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (gl.getError() !== gl.NO_ERROR) return false;
  context.save();
  context.globalAlpha = opacity;
  try { context.drawImage(canvas, x, y, width, height); }
  catch { context.restore(); return false; }
  context.restore();
  return true;
}

export const inkShaderSourceForTests = { vertexSource, fragmentSource };
