import type { PolModel } from '@ttotd/formats';
import type { VertexPatch } from '@ttotd/engine';

/** A copy of a skin model with this frame's vertex positions/normals written into its records. */
export function patchedModel(m: PolModel, patch: VertexPatch[]): PolModel {
  const at = new Map<number, VertexPatch>();
  for (const p of patch) for (const o of p.offsets) at.set(o, p);
  return {
    ...m,
    meshes: m.meshes.map((me) => ({
      ...me,
      prims: me.prims.map((pr) => {
        const v = new Float32Array(pr.vertices);
        pr.sources.forEach((src, k) => {
          const p = at.get(src);
          if (!p) return;
          v.set(p.pos, k * 8);
          v.set(p.nrm, k * 8 + 3);
        });
        return { ...pr, vertices: v };
      }),
    })),
  };
}
