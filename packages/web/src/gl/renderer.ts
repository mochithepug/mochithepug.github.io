/**
 * WebGL2 renderer emulating the Direct3D 7 fixed-function state Tod_e.exe uses for models.
 * Lighting here is a viewer approximation (one directional light + ambient); the game's exact
 * lights/fog are ported in a later milestone.
 */
import { CULL_TABLE, Cull, d3dLighting, DEFAULT_SCENE_LIGHT, meshState, type D3DLighting, type MeshState, type PolModel } from '@ttotd/formats';
import type { Mat4 } from '@ttotd/formats';

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uWorld, uView, uProj;
uniform bool uLit;
// Direct3D 7 fixed-function lighting (one directional light, as light_setup_single sets up)
uniform vec3 uAmbientRS;   // AMBIENT render state
uniform vec3 uLd, uLs, uLa; // light diffuse / specular / ambient
uniform vec3 uToLight;     // world-space direction towards the light
uniform vec3 uEye;         // world-space eye (LOCALVIEWER = TRUE, the D3D7 default)
uniform vec3 uColor;       // material diffuse RGB
uniform float uAlpha;      // material diffuse alpha
uniform float uAmbientScale; // material ambient = colour × scale
uniform vec3 uSpecular;
uniform float uPower;
out vec4 vDiffuse;
flat out vec4 vDiffuseFlat;
out vec3 vSpec;
flat out vec3 vSpecFlat;
out vec2 vUV;
out float vW;
void main() {
  vec4 wp = uWorld * vec4(aPos, 1.0);
  vec4 clip = uProj * (uView * wp);
  gl_Position = vec4(clip.xy, clip.z * 2.0 - clip.w, clip.w); // D3D depth [0,1] → GL [-1,1]
  vW = clip.w; // eye depth for W-based table fog
  vUV = aUV;
  vec4 col = vec4(uColor, uAlpha);
  vec3 spec = vec3(0.0);
  if (uLit) {
    // normals by the inverse-transpose; NORMALIZENORMALS is FALSE, so no renormalisation
    vec3 n = transpose(inverse(mat3(uWorld))) * aNormal;
    vec3 l = normalize(uToLight);
    float ndl = dot(n, l);
    vec3 c = uColor * uAmbientScale * (uAmbientRS + uLa);
    if (ndl > 0.0) {
      c += uColor * uLd * ndl;
      if (uPower > 0.0) {
        vec3 h = normalize(l + normalize(uEye - wp.xyz));
        float ndh = dot(n, h);
        if (ndh > 0.0) spec = uSpecular * uLs * pow(ndh, uPower);
      }
    }
    col = vec4(clamp(c, 0.0, 1.0), uAlpha);
    spec = clamp(spec, 0.0, 1.0);
  }
  vDiffuse = col; vDiffuseFlat = col; vSpec = spec; vSpecFlat = spec;
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vDiffuse;
flat in vec4 vDiffuseFlat;
in vec3 vSpec;
flat in vec3 vSpecFlat;
in vec2 vUV;
in float vW;
uniform sampler2D uTex;
uniform bool uHasTex;
uniform bool uFlat;         // D3DSHADE_FLAT: colour of the triangle's first vertex
uniform bool uAlphaSelect;  // D3DTOP_SELECTARG1 for alpha (texture alpha only)
uniform bool uAlphaTest;    // ALPHAREF 1, ALPHAFUNC GREATEREQUAL
uniform bool uFog;          // FOGENABLE (scene fog on and the mesh allows it)
uniform vec3 uFogColor;
uniform vec2 uFogRange;     // FOGSTART, FOGEND (linear table fog on eye depth)
out vec4 outColor;
void main() {
  vec4 d = uFlat ? vDiffuseFlat : vDiffuse;
  vec3 sp = uFlat ? vSpecFlat : vSpec;
  vec4 t = uHasTex ? texture(uTex, vUV) : vec4(1.0);
  float a = uAlphaSelect ? t.a : t.a * d.a;
  if (uAlphaTest && a * 255.0 < 0.5) discard;
  vec3 c = t.rgb * d.rgb + sp;
  if (uFog) {
    float f = clamp((uFogRange.y - vW) / max(uFogRange.y - uFogRange.x, 1e-6), 0.0, 1.0);
    c = mix(uFogColor, c, f);
  }
  outColor = vec4(c, a);
}`;

const DEFAULT_LIGHTING = d3dLighting(DEFAULT_SCENE_LIGHT);

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
  smooth: boolean;
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
  /** Direct3D lighting/fog state (see @ttotd/formats scenelight); defaults to the exe's reset values. */
  lighting?: D3DLighting;
  /** World-space eye (for specular and fog depth). */
  eye?: [number, number, number];
  fog?: { color: [number, number, number] } | false;
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
  private markerProg?: WebGLProgram;
  private markerVao?: WebGLVertexArrayObject;
  private markerU: Record<string, WebGLUniformLocation | null> = {};
  private markerCount = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // No destination alpha, like the game's 16-bit back buffer (DESTALPHA reads as 1).
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.prog = this.link(VS, FS);
    for (const n of ['uWorld', 'uView', 'uProj', 'uLit', 'uAmbientRS', 'uLd', 'uLs', 'uLa', 'uToLight', 'uEye', 'uColor', 'uAlpha', 'uAmbientScale', 'uSpecular', 'uPower',
      'uTex', 'uHasTex', 'uFlat', 'uAlphaSelect', 'uAlphaTest', 'uFog', 'uFogColor', 'uFogRange']) {
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
        // Batch per (cull mode, shade mode) into triangle lists. Each triangle keeps D3D's winding and
        // is rotated so D3D's *first* vertex (the flat-shading colour source) is last — GL's provoking
        // vertex. Strip triangle i is (i, i+1, i+2) for even i and (i, i+2, i+1) for odd i.
        const groups = new Map<string, { cull: number; smooth: boolean; data: number[] }>();
        for (const p of mesh.prims) {
          const cull = CULL_TABLE[p.cull]!;
          const key = `${cull}|${p.smooth}`;
          let g = groups.get(key);
          if (!g) groups.set(key, (g = { cull, smooth: p.smooth, data: [] }));
          const out = g.data;
          const v = p.vertices, n = v.length / 8;
          const push = (i: number) => { for (let c = 0; c < 8; c++) out.push(v[i * 8 + c]!); };
          const tri = (a: number, b: number, c: number) => { push(b); push(c); push(a); };
          if (p.list) for (let i = 0; i + 2 < n; i += 3) tri(i, i + 1, i + 2);
          else for (let i = 0; i + 2 < n; i++) {
            if (i & 1) tri(i, i + 2, i + 1); else tri(i, i + 1, i + 2);
          }
        }
        const prims: GpuPrim[] = [];
        for (const { cull, smooth, data } of groups.values()) {
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
          prims.push({ vao, buf, count: data.length / 8, list: true, cull, smooth });
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
    const L = o.lighting ?? DEFAULT_LIGHTING;
    gl.uniform1i(this.u.uLit!, o.lit ? 1 : 0);
    gl.uniform3fv(this.u.uAmbientRS!, L.ambient);
    gl.uniform3fv(this.u.uLd!, L.lightDiffuse);
    gl.uniform3fv(this.u.uLs!, L.lightSpecular);
    gl.uniform3fv(this.u.uLa!, L.lightAmbient);
    gl.uniform3fv(this.u.uToLight!, L.toLight);
    gl.uniform3fv(this.u.uEye!, o.eye ?? [0, 0, -1000]);
    gl.uniform2f(this.u.uFogRange!, L.fogStart, L.fogEnd);
    gl.uniform3fv(this.u.uFogColor!, o.fog ? o.fog.color : [0, 0, 0]);
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
        gl.uniform1i(this.u.uFog!, o.fog && s.fogEnable ? 1 : 0);
        for (const p of m.prims) {
          if (!o.culling || p.cull === Cull.NONE) gl.disable(gl.CULL_FACE);
          else {
            // D3DCULL_CCW keeps triangles that are clockwise in D3D screen space. Verified against the
            // exact game pipeline (game view + fixed z-flip view matrix, M7b): that corresponds to GL
            // front = CW, cull BACK (and D3DCULL_CW to front = CCW).
            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.BACK);
            gl.frontFace(p.cull === Cull.CCW ? gl.CW : gl.CCW);
          }
          gl.uniform1i(this.u.uFlat!, p.smooth ? 0 : 1);
          gl.bindVertexArray(p.vao);
          gl.drawArrays(p.list ? gl.TRIANGLES : gl.TRIANGLE_STRIP, 0, p.count);
        }
      }
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  private initMarkers() {
    if (this.markerProg) return;
    const gl = this.gl;
    this.markerProg = this.link(MARKER_VS, MARKER_FS);
    for (const n of ['uVP', 'uCenter', 'uSize', 'uColor'])
      this.markerU[n] = gl.getUniformLocation(this.markerProg, n);
    // Diamond shape: 8 triangles (top pyramid + bottom pyramid)
    const S = 1;
    const verts = new Float32Array([
      // top pyramid (4 faces)
      0, S, 0, S, 0, 0, 0, 0, S,
      0, S, 0, 0, 0, S, -S, 0, 0,
      0, S, 0, -S, 0, 0, 0, 0, -S,
      0, S, 0, 0, 0, -S, S, 0, 0,
      // bottom pyramid (4 faces)
      0, -S, 0, 0, 0, S, S, 0, 0,
      0, -S, 0, -S, 0, 0, 0, 0, S,
      0, -S, 0, 0, 0, -S, -S, 0, 0,
      0, -S, 0, S, 0, 0, 0, 0, -S,
    ]);
    this.markerCount = verts.length / 3;
    this.markerVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.markerVao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
  }

  drawMarkers(markers: Marker3D[], view: Mat4, proj: Mat4) {
    if (!markers.length) return;
    this.initMarkers();
    const gl = this.gl;
    gl.useProgram(this.markerProg!);
    // VP = proj * view
    const vp = new Float32Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += proj[r + k * 4]! * view[k + c * 4]!;
      vp[r + c * 4] = s;
    }
    gl.uniformMatrix4fv(this.markerU.uVP!, false, vp);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.markerVao!);
    for (const m of markers) {
      gl.uniform3fv(this.markerU.uCenter!, m.pos);
      gl.uniform1f(this.markerU.uSize!, m.size ?? 3);
      gl.uniform3fv(this.markerU.uColor!, m.color);
      gl.drawArrays(gl.TRIANGLES, 0, this.markerCount);
    }
    gl.bindVertexArray(null);
  }

  /** Project a 3D world point to canvas pixel coordinates (or undefined if behind the camera). */
  project(pos: [number, number, number], view: Mat4, proj: Mat4): [number, number] | undefined {
    // clip = proj * view * [x,y,z,1]
    const v = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += view[r + k * 4]! * (k < 3 ? pos[k]! : 1);
      v[r] = s;
    }
    const c = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += proj[r + k * 4]! * v[k]!;
      c[r] = s;
    }
    if (c[3]! <= 0) return undefined;
    const ndc = [c[0]! / c[3]!, c[1]! / c[3]!];
    return [(ndc[0]! * 0.5 + 0.5) * this.canvas.clientWidth, (1 - (ndc[1]! * 0.5 + 0.5)) * this.canvas.clientHeight];
  }
}

export interface Marker3D {
  pos: [number, number, number];
  color: [number, number, number];
  size?: number;
  label?: string;
}

const MARKER_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
uniform vec3 uCenter;
uniform float uSize;
uniform vec3 uColor;
out vec3 vColor;
void main() {
  vec3 wp = aPos * uSize + uCenter;
  gl_Position = uVP * vec4(wp, 1.0);
  gl_Position.z = gl_Position.z * 2.0 - gl_Position.w;
  vColor = uColor * (0.6 + 0.4 * aPos.y);
}`;
const MARKER_FS = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }`;

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
