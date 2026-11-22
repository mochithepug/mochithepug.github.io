/**
 * WebGL2 renderer emulating the Direct3D 7 fixed-function state Tod_e.exe uses for models.
 * Lighting here is a viewer approximation (one directional light + ambient); the game's exact
 * lights/fog are ported in a later milestone.
 */
import { CULL_TABLE, Cull, meshState, type MeshState, type PolModel } from '@ttotd/formats';
import type { Mat4 } from '@ttotd/formats';

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uWorld, uView, uProj;
uniform vec3 uLightDir;       // world space, direction the light travels
uniform vec3 uColor;          // material RGB
uniform float uAlpha;         // material alpha
uniform float uAmbientScale;  // material ambient = colour * scale
uniform vec3 uSpecular;
uniform float uPower;
uniform bool uLit;
out vec4 vDiffuse;
out vec3 vSpec;
out vec2 vUV;
void main() {
  vec4 wp = uWorld * vec4(aPos, 1.0);
  vec4 vp = uView * wp;
  vec4 clip = uProj * vp;
  gl_Position = vec4(clip.xy, clip.z * 2.0 - clip.w, clip.w); // D3D depth [0,1] → GL [-1,1]
  vUV = aUV;
  if (!uLit) { vDiffuse = vec4(uColor, uAlpha); vSpec = vec3(0.0); return; }
  vec3 n = normalize(mat3(uWorld) * aNormal);
  vec3 l = -normalize(uLightDir);
  float d = max(dot(n, l), 0.0);
  vec3 ambient = vec3(0.45) * uAmbientScale;
  vDiffuse = vec4(uColor * (ambient + vec3(0.75) * d), uAlpha);
  vSpec = vec3(0.0);
  if (uPower > 0.0 && d > 0.0) {
    vec3 h = normalize(l + normalize(-wp.xyz));
    vSpec = uSpecular * pow(max(dot(n, h), 0.0), uPower);
  }
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vDiffuse;
in vec3 vSpec;
in vec2 vUV;
uniform sampler2D uTex;
uniform bool uHasTex;
uniform bool uAlphaSelect;  // D3DTOP_SELECTARG1 for alpha (texture alpha only)
uniform bool uAlphaTest;    // ALPHAREF 1, ALPHAFUNC GREATEREQUAL
out vec4 outColor;
void main() {
  vec4 t = uHasTex ? texture(uTex, vUV) : vec4(1.0);
  float a = uAlphaSelect ? t.a : t.a * vDiffuse.a;
  if (uAlphaTest && a * 255.0 < 0.5) discard;
  outColor = vec4(t.rgb * vDiffuse.rgb + vSpec, a);
}`;

export interface TextureSource {
  /** RGBA8 texels in the exe's memory order (row 0 first), or undefined if unavailable. */
  get(index: number): { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> } | undefined;
  key: string;
}

interface GpuPrim {
  vao: WebGLVertexArrayObject;
  buf: WebGLBuffer;
  count: number;
  list: boolean;
  cull: number;
}
interface GpuMesh {
  state: MeshState;
  texture: number;
  color: [number, number, number];
  alpha: number;
  ambientScale: number;
  specular: [number, number, number];
  power: number;
  prims: GpuPrim[];
}
export interface GpuModel {
  meshes: GpuMesh[];
  dispose(): void;
}

export interface DrawOptions {
  world: Mat4;
  view: Mat4;
  proj: Mat4;
  lit: boolean;
  culling: boolean;
  lightDir: [number, number, number];
  /** Replace every mesh's material colour (the exe's per-model colour override, FUN_00489140). */
  colorOverride?: [number, number, number];
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private textures = new Map<string, WebGLTexture | null>();
  private samplers = new Map<string, WebGLSampler>();
  readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // No destination alpha, like the game's 16-bit back buffer (DESTALPHA reads as 1).
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.prog = this.link(VS, FS);
    for (const n of ['uWorld', 'uView', 'uProj', 'uLightDir', 'uColor', 'uAlpha', 'uAmbientScale', 'uSpecular', 'uPower', 'uLit', 'uTex', 'uHasTex', 'uAlphaSelect', 'uAlphaTest']) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
  }

  private link(vs: string, fs: string) {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    return p;
  }

  /**
   * Upload models. Each mesh's primitives are batched per cull mode into one triangle list:
   * strip triangle i uses (i, i+1, i+2) for even i and (i+1, i, i+2) for odd i — the same winding
   * D3D and GL give strips — so the result draws identically with far fewer draw calls.
   */
  upload(models: PolModel[]): GpuModel {
    const gl = this.gl;
    const bufs: WebGLBuffer[] = [];
    const vaos: WebGLVertexArrayObject[] = [];
    const meshes: GpuMesh[] = [];
    for (const m of models) {
      for (const mesh of m.meshes) {
        const byCull = new Map<number, number[]>();
        for (const p of mesh.prims) {
          const cull = CULL_TABLE[p.cull]!;
          let out = byCull.get(cull);
          if (!out) byCull.set(cull, (out = []));
          const v = p.vertices, n = v.length / 8;
          const push = (i: number) => { for (let c = 0; c < 8; c++) out!.push(v[i * 8 + c]!); };
          if (p.list) for (let i = 0; i < n; i++) push(i);
          else for (let i = 0; i + 2 < n; i++) {
            if (i & 1) { push(i + 1); push(i); push(i + 2); } else { push(i); push(i + 1); push(i + 2); }
          }
        }
        const prims: GpuPrim[] = [];
        for (const [cull, data] of byCull) {
          if (!data.length) continue;
          const vao = gl.createVertexArray()!;
          const buf = gl.createBuffer()!;
          gl.bindVertexArray(vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
          gl.enableVertexAttribArray(0);
          gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
          gl.enableVertexAttribArray(1);
          gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
          gl.enableVertexAttribArray(2);
          gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
          bufs.push(buf);
          vaos.push(vao);
          prims.push({ vao, buf, count: data.length / 8, list: true, cull });
        }
        meshes.push({
          state: meshState(mesh),
          texture: mesh.texture,
          color: mesh.color,
          alpha: mesh.alpha,
          ambientScale: mesh.ambientScale,
          specular: mesh.specular,
          power: mesh.specularPower > 0 ? 1 << mesh.specularPower : 0,
          prims,
        });
      }
    }
    gl.bindVertexArray(null);
    return {
      meshes,
      dispose: () => {
        bufs.forEach((b) => gl.deleteBuffer(b));
        vaos.forEach((v) => gl.deleteVertexArray(v));
      },
    };
  }

  private texture(src: TextureSource, index: number): WebGLTexture | null {
    const key = `${src.key}#${index}`;
    if (this.textures.has(key)) return this.textures.get(key)!;
    const gl = this.gl;
    const t = src.get(index);
    let tex: WebGLTexture | null = null;
    if (t) {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      // Rows uploaded unchanged: v = 0 is the first row, exactly as in the D3D surface.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, t.width, t.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, t.rgba);
    }
    this.textures.set(key, tex);
    return tex;
  }

  private sampler(s: MeshState): WebGLSampler {
    const key = `${s.addressU}/${s.addressV}/${s.linear}`;
    let sm = this.samplers.get(key);
    if (!sm) {
      const gl = this.gl;
      const wrap = (a: number) => (a === 2 ? gl.MIRRORED_REPEAT : a === 3 ? gl.CLAMP_TO_EDGE : gl.REPEAT);
      sm = gl.createSampler()!;
      gl.samplerParameteri(sm, gl.TEXTURE_WRAP_S, wrap(s.addressU));
      gl.samplerParameteri(sm, gl.TEXTURE_WRAP_T, wrap(s.addressV));
      const f = s.linear ? gl.LINEAR : gl.NEAREST;
      gl.samplerParameteri(sm, gl.TEXTURE_MIN_FILTER, f);
      gl.samplerParameteri(sm, gl.TEXTURE_MAG_FILTER, f);
      this.samplers.set(key, sm);
    }
    return sm;
  }

  clear(r = 0.15, g = 0.15, b = 0.18) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.depthMask(true);
    gl.clearColor(r, g, b, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** Draw like the game: opaque meshes first with blending off, then translucent ones blended. */
  draw(model: GpuModel, textures: TextureSource | undefined, o: DrawOptions) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uWorld!, false, o.world);
    gl.uniformMatrix4fv(this.u.uView!, false, o.view);
    gl.uniformMatrix4fv(this.u.uProj!, false, o.proj);
    gl.uniform3fv(this.u.uLightDir!, o.lightDir);
    gl.uniform1i(this.u.uLit!, o.lit ? 1 : 0);
    gl.uniform1i(this.u.uTex!, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST);
    for (const pass of [true, false]) {
      if (pass) gl.disable(gl.BLEND);
      else gl.enable(gl.BLEND);
      for (const m of model.meshes) {
        if (m.state.opaque !== pass) continue;
        const s = m.state;
        gl.depthFunc(0x200 + s.zFunc - 1); // D3DCMP_* 1..8 → gl.NEVER..gl.ALWAYS
        gl.depthMask(s.zWrite);
        if (!pass) gl.blendFunc(glBlend(gl, s.srcBlend), glBlend(gl, s.destBlend));
        const tex = textures && m.texture >= 0 ? this.texture(textures, m.texture) : null;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.bindSampler(0, this.sampler(s));
        gl.uniform1i(this.u.uHasTex!, tex ? 1 : 0);
        gl.uniform1i(this.u.uAlphaSelect!, s.alphaOp === 2 ? 1 : 0);
        gl.uniform1i(this.u.uAlphaTest!, s.alphaTest ? 1 : 0);
        gl.uniform3fv(this.u.uColor!, o.colorOverride ?? m.color);
        gl.uniform1f(this.u.uAlpha!, m.alpha);
        gl.uniform1f(this.u.uAmbientScale!, m.ambientScale);
        gl.uniform3fv(this.u.uSpecular!, m.specular);
        gl.uniform1f(this.u.uPower!, m.power);
        for (const p of m.prims) {
          if (!o.culling || p.cull === Cull.NONE) gl.disable(gl.CULL_FACE);
          else {
            // D3D culls by screen-space (y-down) winding; GL by window-space (y-up) winding, which
            // mirrors it: D3DCULL_CCW ≡ GL front = CCW, cull BACK; D3DCULL_CW ≡ front = CW.
            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.BACK);
            gl.frontFace(p.cull === Cull.CCW ? gl.CCW : gl.CW);
          }
          gl.bindVertexArray(p.vao);
          gl.drawArrays(p.list ? gl.TRIANGLES : gl.TRIANGLE_STRIP, 0, p.count);
        }
      }
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }
}

function glBlend(gl: WebGL2RenderingContext, d3d: number): number {
  switch (d3d) {
    case 1: return gl.ZERO;
    case 2: return gl.ONE;
    case 3: return gl.SRC_COLOR;
    case 4: return gl.ONE_MINUS_SRC_COLOR;
    case 5: return gl.SRC_ALPHA;
    case 6: return gl.ONE_MINUS_SRC_ALPHA;
    case 7: return gl.DST_ALPHA;
    case 8: return gl.ONE_MINUS_DST_ALPHA;
    case 9: return gl.DST_COLOR;
    case 10: return gl.ONE_MINUS_DST_COLOR;
    default: return gl.ONE;
  }
}
