/** Free-fly camera: drag to look, WASD to move, Q/E down/up, shift = fast. D3D-style (left-handed, y up). */
import { lookAtLH, perspectiveFovLH, type Mat4 } from '@ttotd/formats';

export class FlyCamera {
  pos: [number, number, number] = [0, 50, 0];
  yaw = 0; // 0 = looking along +z
  pitch = 0;
  speed = 120; // units per second
  fovY = (60 * Math.PI) / 180;
  near = 2;
  far = 12000;
  onChange?: () => void;
  private keys = new Set<string>();

  dir(): [number, number, number] {
    return [Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch)];
  }

  matrices(aspect: number): { view: Mat4; proj: Mat4; lightDir: [number, number, number] } {
    const d = this.dir();
    const at = this.pos.map((v, k) => v + d[k]!);
    return {
      view: lookAtLH(this.pos, at, [0, 1, 0]),
      proj: perspectiveFovLH(this.fovY, aspect, this.near, this.far),
      lightDir: [0.3, -1, 0.5],
    };
  }

  attach(canvas: HTMLCanvasElement, isActive: () => boolean) {
    let drag: { x: number; y: number } | undefined;
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      canvas.focus();
    });
    canvas.addEventListener('pointerup', () => (drag = undefined));
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.yaw += (e.clientX - drag.x) * 0.004;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY };
      this.onChange?.();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.speed = Math.max(5, Math.min(5000, this.speed * Math.exp(-e.deltaY * 0.001)));
      this.onChange?.();
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (!isActive() || (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      if ('wasdqe'.includes(e.key.toLowerCase())) { this.keys.add(e.key.toLowerCase()); e.preventDefault(); }
      if (e.key === 'Shift') this.keys.add('shift');
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.key.toLowerCase()); if (e.key === 'Shift') this.keys.delete('shift'); });
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Advance by dt seconds; returns true if the camera moved. */
  update(dt: number): boolean {
    if (!this.keys.size) return false;
    const d = this.dir(), right = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    const v = this.speed * dt * (this.keys.has('shift') ? 4 : 1);
    const k = this.keys;
    const f = (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0), r = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0), u = (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0);
    if (!f && !r && !u) return false;
    for (let i = 0; i < 3; i++) this.pos[i] = this.pos[i]! + (d[i]! * f + right[i]! * r) * v + (i === 1 ? u * v : 0);
    return true;
  }
}
