/**
 * Scene lighting & fog inputs, and how Tod_e.exe turns them into Direct3D 7 state.
 * See re/notes/overview.md "Lighting & fog (M7c)".
 *
 * Per-frame (`FUN_0044fee0`): light colour = g(0x00A11D00..08), intensity = g(0x00A11D0C), fog
 * start/end = g(0x00A11AF0/AF4); light direction from two angles g(0x00A11AD8/ADC) via FUN_0046d780.
 * The values are set by game/event code (decoded in M9); the defaults below are the exe's resets.
 * `light_setup_single` @004c2bb0: s = colour × intensity;
 *   AMBIENT render state = (trunc(s·255)) per channel, alpha 255;
 *   light 0 (directional): diffuse = specular = s × 1.4 (@004f100c), ambient = colour × 0.3 (@004dd4a8).
 * Fog (`FUN_00451470` → FUN_004c2a10): LINEAR, FOGSTART = min(2·start, 2·end), FOGEND = max(...);
 * table (per-pixel) fog when the device supports it (else vertex fog).
 */
import type { PeImage } from './pe.ts';

export interface SceneLight {
  /** Light colour (g 0x00A11D00/04/08). */
  color: [number, number, number];
  /** Light intensity (g 0x00A11D0C). */
  intensity: number;
  /** Light direction angles in Sega units (pitch, yaw), g 0x00A11AD8/ADC. */
  pitch: number;
  yaw: number;
  /** Game fog start/end (g 0x00A11AF0/AF4) — the device gets twice these. */
  fogStart: number;
  fogEnd: number;
  /** Fog colour (D3D ARGB, FOGCOLOR render state). */
  fogColor: [number, number, number];
  fog: boolean;
}

/** The exe's reset values (FUN_004c2a80: white, intensity 1, direction +z). Fog off until set. */
export const DEFAULT_SCENE_LIGHT: SceneLight = {
  color: [1, 1, 1],
  intensity: 1,
  pitch: 0,
  yaw: 0,
  fogStart: 0,
  fogEnd: 4000,
  fogColor: [0, 0, 0],
  fog: false,
};

export interface D3DLighting {
  /** AMBIENT render state as 0..1 (8-bit quantised like the exe's ARGB). */
  ambient: [number, number, number];
  lightDiffuse: [number, number, number];
  lightSpecular: [number, number, number];
  lightAmbient: [number, number, number];
  /** World-space unit vector pointing *towards* the light (D3D uses −direction). */
  toLight: [number, number, number];
  fogStart: number;
  fogEnd: number;
}

const RAD = (2 * Math.PI) / 65536;

/** Direction for (pitch, yaw) as FUN_0046d780: (0,0,1) rotated by Rx(pitch) then Ry(yaw). */
export function angleDirection(pitch: number, yaw: number): [number, number, number] {
  const p = pitch * RAD, y = yaw * RAD;
  // (0,0,1)·Rx(p) = (0, −sin p, cos p); ·Ry(y) with Ry rows (c,0,−s),(0,1,0),(s,0,c)
  const z = Math.cos(p), yv = -Math.sin(p);
  return [z * Math.sin(y), yv, z * Math.cos(y)];
}

export function d3dLighting(s: SceneLight): D3DLighting {
  const scaled = s.color.map((c) => Math.fround(c * s.intensity)) as [number, number, number];
  const q = (v: number) => (Math.trunc(Math.fround(v * 255)) & 0xff) / 255;
  return {
    ambient: [q(scaled[0]), q(scaled[1]), q(scaled[2])],
    lightDiffuse: scaled.map((v) => Math.fround(v * Math.fround(1.4))) as [number, number, number],
    lightSpecular: scaled.map((v) => Math.fround(v * Math.fround(1.4))) as [number, number, number],
    lightAmbient: s.color.map((v) => Math.fround(v * Math.fround(0.3))) as [number, number, number],
    toLight: angleDirection(s.pitch, s.yaw),
    fogStart: Math.min(2 * s.fogStart, 2 * s.fogEnd),
    fogEnd: Math.max(2 * s.fogStart, 2 * s.fogEnd),
  };
}

/** Checks the constants this module copies from the exe (used by tests). */
export function lightingConstants(pe: PeImage) {
  return { diffuseScale: pe.f32(0x004f100c), ambientScale: pe.f32(0x004dd4a8), ambientTo255: pe.f32(0x0058ff50) };
}
