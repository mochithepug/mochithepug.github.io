/**
 * Direct3D 7 render state for a model mesh, as set by FUN_004bfff0 from the mesh's Dreamcast
 * ISP/TSP words, plus global state set once at start-up (FUN_004c0cd0 caller / device init).
 * Tables are copied from the exe (addresses noted) and checked against it in test/notes.test.ts.
 */
import type { PolMesh } from './pol.ts';

/** D3DCMPFUNC */
export const Cmp = { NEVER: 1, LESS: 2, EQUAL: 3, LESSEQUAL: 4, GREATER: 5, NOTEQUAL: 6, GREATEREQUAL: 7, ALWAYS: 8 } as const;
/** D3DBLEND */
export const Blend = {
  ZERO: 1, ONE: 2, SRCCOLOR: 3, INVSRCCOLOR: 4, SRCALPHA: 5, INVSRCALPHA: 6,
  DESTALPHA: 7, INVDESTALPHA: 8, DESTCOLOR: 9, INVDESTCOLOR: 10,
} as const;
/** D3DTEXTUREADDRESS */
export const Address = { WRAP: 1, MIRROR: 2, CLAMP: 3 } as const;
/** D3DTEXTUREOP (subset) */
export const TexOp = { SELECTARG1: 2, MODULATE: 4 } as const;
/** D3DCULL */
export const Cull = { NONE: 1, CW: 2, CCW: 3 } as const;

export const ZFUNC_TABLE = [1, 7, 3, 5, 4, 6, 2, 8] as const; // @005eb8c0, by ISP bits 31..29
export const SRCBLEND_TABLE = [1, 2, 9, 10, 5, 6, 7, 8] as const; // @005eb870, by TSP bits 31..29
export const DESTBLEND_TABLE = [1, 2, 3, 4, 5, 6, 7, 8] as const; // @005eb890, by TSP bits 28..26
export const ADDRESS_TABLE = [1, 2, 3, 2] as const; // @005eb8b0, by (clamp << 1 | flip)
export const CULL_TABLE = [1, 1, 3, 2] as const; // @005eb8e0, by primitive flags & 3

/** Set once at start-up. */
export const GLOBAL_STATE = {
  alphaRef: 1, // D3DRS_ALPHAREF
  alphaFunc: Cmp.GREATEREQUAL, // D3DRS_ALPHAFUNC
  specularEnable: true,
  ditherEnable: true,
} as const;

export interface MeshState {
  zFunc: number;
  zWrite: boolean;
  srcBlend: number;
  destBlend: number;
  fogEnable: boolean;
  alphaTest: boolean;
  /** Drawn in the opaque pass (blending disabled) — otherwise deferred to the translucent pass. */
  opaque: boolean;
  addressU: number;
  addressV: number;
  colorOp: number;
  alphaOp: number;
  /** Bilinear when true, point sampling otherwise. */
  linear: boolean;
}

export function meshState(m: Pick<PolMesh, 'isp' | 'tsp'>): MeshState {
  const { isp, tsp } = m;
  const useAlphaBits = tsp & 0x180000;
  const instr = (tsp >>> 6) & 3;
  return {
    zFunc: ZFUNC_TABLE[isp >>> 29]!,
    zWrite: ((isp >>> 26) & 1) === 0,
    srcBlend: SRCBLEND_TABLE[tsp >>> 29]!,
    destBlend: DESTBLEND_TABLE[(tsp >>> 26) & 7]!,
    fogEnable: ((tsp >>> 23) & 1) === 0,
    alphaTest: useAlphaBits !== 0x80000,
    opaque: useAlphaBits === 0x80000,
    addressU: ADDRESS_TABLE[(((tsp >>> 3) & 0x8000) | (tsp & 0x10000)) >>> 15]!,
    addressV: ADDRESS_TABLE[(((tsp >>> 3) & 0x4000) | (tsp & 0x8000)) >>> 14]!,
    colorOp: TexOp.MODULATE,
    alphaOp: instr === 1 ? TexOp.SELECTARG1 : TexOp.MODULATE,
    linear: (tsp & 0x6000) !== 0,
  };
}
