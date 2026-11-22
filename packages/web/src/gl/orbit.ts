/** Mouse orbit camera (left-handed, y up) producing D3D-style view/projection matrices. */
import { gameLookAt, perspectiveFovLH, type Mat4 } from '@ttotd/formats';

export const FOV = (45 * Math.PI) / 180;

export class OrbitCamera {
  yaw = 0.6;
  pitch = 0.2;
  dist = 10;
  radius = 1;
  target: [number, number, number] = [0, 0, 0];
  onChange?: () => void;

  fit(center: [number, number, number], radius: number) {
    this.target = [...center];
    this.radius = Math.max(radius, 0.01);
    this.dist = (this.radius / Math.sin(FOV / 2)) * 1.05;
  }

  eye(): [number, number, number] {
    const t = this.target;
    return [
      t[0] + Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist,
      t[1] + Math.sin(this.pitch) * this.dist,
      t[2] - Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist,
    ];
  }

  matrices(aspect: number): { view: Mat4; proj: Mat4; lightDir: [number, number, number] } {
    const eye = this.eye();
    const dir = this.target.map((v, k) => v - eye[k]!);
    return {
      view: gameLookAt(eye, this.target), // the game's own view convention (incl. its z-flip)
      proj: perspectiveFovLH(FOV, aspect, Math.max(this.dist - this.radius * 4, this.dist / 1000), this.dist + this.radius * 4),
      lightDir: [dir[0]! + this.dist * 0.3, dir[1]! - this.dist * 0.5, dir[2]!],
    };
  }

  attach(canvas: HTMLCanvasElement) {
    let drag: { x: number; y: number; pan: boolean } | undefined;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', () => (drag = undefined));
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.pan) {
        const s = (this.dist * Math.tan(FOV / 2) * 2) / canvas.clientHeight;
        const right = [-Math.cos(this.yaw), 0, -Math.sin(this.yaw)]; // screen-right in the game's view
        const up = [-Math.sin(this.pitch) * Math.sin(this.yaw), Math.cos(this.pitch), Math.sin(this.pitch) * Math.cos(this.yaw)];
        for (let k = 0; k < 3; k++) this.target[k] = this.target[k]! - right[k]! * dx * s + up[k]! * dy * s;
      } else {
        this.yaw += dx * 0.01;
        this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + dy * 0.01));
      }
      this.onChange?.();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist *= Math.exp(e.deltaY * 0.001);
      this.onChange?.();
    }, { passive: false });
  }
}
