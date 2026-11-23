/**
 * Event script player (M9): runs a block's scripts frame by frame at 60 Hz, like `evt_run`, and exposes what
 * they drive — the camera shot, subtitles, the skip sign, scene light & fog — plus a log of every action.
 * See re/notes/overview.md "Event scripts (M9)".
 *
 * Exact (from the exe): command decoding and order; the camera queue (0x30 pushes, `cam_queue_run` @0040ca70 runs
 * the next command in the same frame the previous one finishes); camera time DAT_00a14a30 — a path shot (mode
 * 0x40, `FUN_0040dc20`/`FUN_0040dcd0`) sets it to its start (−1 = keep) and adds 1 per frame up to its end;
 * start = end jumps (`FUN_0040db00`); flag 2 stores a path to resume after the fight (`FUN_0040dba0`);
 * waits: 0x41 N continues once N < camera time, 0x41 0 once the shot has < 1 frame left (DAT_00a39468),
 * 0x40 while camera commands are pending (DAT_00a11924); say(); skippable; light & fog (0x20 / 0x18);
 * 0x45 N waits until flag byte DAT_00a396c0[N] is set (e.g. 248 = DAT_00a397b8, set when the chapter title card
 * ends — the owner sets `flags`); block order by the exe's rules; skipping a scene (`skip_task` @00423da0: Enter while skippable sets
 * DAT_00a11a14 and ends the running path shot; until 0x2C 0 clears it, 0x30 is not queued, the waits
 * 0x40/0x41/0x42/0x74 pass at once, sounds 0x3A/0x3B are dropped and subtitles end).
 * Approximate (gameplay not ported yet): the fight (camera mode 0x21) lasts `holdFrames`, then the stored path
 * resumes; other camera modes (0x11/0x12/0x14/0x60: screen, player state, view, look-at) finish at once and
 * keep the view; game mode 0 and one player are assumed.
 */
import type { BlockRule, EventFile, SpawnRecord } from './events.ts';
import { evtOpName, readSpawnRecords } from './events.ts';
import type { Speech } from './dialogue.ts';
import { DEFAULT_SCENE_LIGHT, type SceneLight } from './scenelight.ts';

export interface CameraShot {
  /** Camera mode (0x40 = play a path between two timer values). */
  mode: number;
  params: number[];
}

export interface ActiveShot {
  /** Global camera path id (cam slot ids) and the camera time to sample it at. */
  pathId: number;
  t: number;
  from: number;
  to: number;
  /** Set while the fight (camera mode 0x21) runs: frames left. */
  fight?: number;
}

export interface EvtLogEntry {
  frame: number;
  timer: number;
  kind: 'camera' | 'say' | 'skip' | 'light' | 'flow' | 'spawn' | 'sound' | 'other';
  text: string;
}

export interface EvtPlayerOptions {
  rules: BlockRule[];
  /** Dialogue lookup (variant already chosen). */
  dialogue: (id: number) => Speech | undefined;
  /** Shared comevtbl, to resolve pointers into it. */
  common?: EventFile;
  /** Frames a fight (camera mode 0x21) lasts here (gameplay not ported yet). */
  holdFrames?: number;
  /** Route choice for branching blocks (index into the rule targets). */
  choice?: number;
  /** Game mode for 0x73 (DAT_00a3e760). */
  gameMode?: number;
  /** Player count (DAT_00a3b844) for the one-/two-player-only commands. */
  players?: number;
  /** Continue into the next block when one ends. */
  followBlocks?: boolean;
}

export class EventPlayer {
  readonly ef: EventFile;
  readonly opts: Required<Omit<EvtPlayerOptions, 'common'>> & { common?: EventFile };
  block = 0;
  scriptIndex = 0;
  /** File offset of the next command, or undefined when the block's scripts are done. */
  pc?: number;
  frame = 0;
  /** Camera time DAT_00a14a30 (what waits and path sampling use). */
  timer = 0;
  /** Frames left in the current path shot (DAT_00a39468). */
  remaining = 0x7fffffff;
  /** Camera commands queued or running (DAT_00a11924). */
  pendingCamera = 0;
  /** Path stored by a flag-2 shot, resumed after the fight. */
  resume?: { pathId: number; from: number; to: number };
  halted = false;
  done = false;
  queue: CameraShot[] = [];
  shot?: ActiveShot;
  subtitle?: { speech: Speech; remaining: number; line: number };
  skippable = false;
  /** Flag bytes DAT_00a396c0[N] that op 0x45 waits for; set by game objects (248: title card over). */
  readonly flags = new Uint8Array(0x400);
  /** Stage area to draw (DAT_00a11124, op 0x29). */
  area = 0;
  /** Sky row (DAT_00a118d4, op 0x1b) and mode (DAT_00a3e764, op 0x1c: 0 off, 1 turning, 2 still). */
  skyRow = 0;
  skyMode = 1;
  /** Skipping the current scene (DAT_00a11a14). */
  skipping = false;
  light: SceneLight = { ...DEFAULT_SCENE_LIGHT, color: [...DEFAULT_SCENE_LIGHT.color], fogColor: [...DEFAULT_SCENE_LIGHT.fogColor] };
  /** Spawned objects accumulated during playback. */
  spawns: SpawnRecord[] = [];
  log: EvtLogEntry[] = [];

  constructor(ef: EventFile, opts: EvtPlayerOptions) {
    this.ef = ef;
    this.opts = { holdFrames: 180, choice: 0, gameMode: 0, players: 1, followBlocks: true, ...opts };
  }

  start(block: number) {
    this.block = block;
    this.scriptIndex = 0;
    this.pc = this.ef.blocks()[block]?.scripts[0];
    this.timer = 0;
    this.halted = false;
    this.done = this.pc === undefined;
    this.queue = [];
    this.shot = undefined;
    this.pendingCamera = 0;
    this.resume = undefined;
    this.remaining = 0x7fffffff;
    this.subtitle = undefined;
    this.skippable = false;
    this.skipping = false;
    this.add('flow', `block ${block} starts`);
  }

  private add(kind: EvtLogEntry['kind'], text: string) {
    this.log.push({ frame: this.frame, timer: this.timer, kind, text });
    if (this.log.length > 2000) this.log.splice(0, this.log.length - 2000);
  }

  private f32At(ptr: number): number | undefined {
    for (const f of [this.ef, this.opts.common]) {
      const o = f?.offsetOf(ptr);
      if (f && o !== undefined && o + 4 <= f.data.length) return new DataView(f.data.buffer, f.data.byteOffset).getFloat32(o, true);
    }
    return undefined;
  }

  /** Enter pressed (`skip_task`): skip the scene if it is skippable. Returns whether a skip started. */
  skip(): boolean {
    if (!this.skippable || this.skipping) return false;
    this.skipping = true;
    // DAT_00a14a68 (shot end) = DAT_00a14a64 (shot time): the running path shot ends this frame
    if (this.shot && this.running) this.shot.to = this.counter;
    this.subtitle = undefined;
    this.add('skip', 'scene skipped');
    return true;
  }

  /** Advance one 60 Hz frame. */
  step() {
    if (this.done) return;
    this.interpret();
    this.updateCamera();
    this.stepFades();
    if (this.subtitle) {
      const s = this.subtitle;
      s.remaining--;
      const cur = s.speech.lines[s.line];
      if (cur && cur.nextBelow > 0 && s.remaining < cur.nextBelow && s.line + 1 < s.speech.lines.length) s.line++;
      if (s.remaining <= 0) this.subtitle = undefined;
    }
    this.frame++;
  }

  private nextScript(): boolean {
    const b = this.ef.blocks()[this.block];
    this.scriptIndex++;
    this.pc = b?.scripts[this.scriptIndex];
    if (this.pc !== undefined) return true;
    const rule = this.opts.rules[this.block];
    let next = -1;
    if (rule?.kind === 0) next = rule.targets[0]!;
    else if (rule?.kind === 1) next = rule.targets[this.opts.choice] ?? rule.targets[0]!;
    else if (rule?.kind === 2) next = this.block + 1;
    this.add('flow', `block ${this.block} done → ${next >= 0 && next < this.ef.blocks().length ? `block ${next}` : 'end of stage'}`);
    if (this.opts.followBlocks && next >= 0 && next < this.ef.blocks().length) {
      const keepFrame = this.frame;
      this.start(next);
      this.frame = keepFrame;
      return true;
    }
    this.done = true;
    return false;
  }

  private interpret() {
    if (this.halted) return;
    for (let guard = 0; guard < 512 && this.pc !== undefined; guard++) {
      const o = this.pc;
      const w = (k: number) => this.ef.word(o + k * 4);
      const op = w(0);
      const len = this.ef.commandLength(o);
      const advance = () => (this.pc = o + len);
      switch (op) {
        case 0x4d:
          this.timer = 0;
          this.remaining = 0x7fffffff;
          this.add('flow', 'segment start (camera time = 0)');
          advance();
          break;
        case 0x40:
          // FUN_0044f5a0: yield while camera commands are pending (DAT_00a11924)
          if (this.pendingCamera !== 0 && !this.skipping) {
            if (!this.yieldFlag) this.add('flow', 'wait for the camera');
            this.yieldFlag = true;
            return;
          }
          this.yieldFlag = false;
          advance();
          break;
        case 0x38:
        case 0x3a:
          if (op === 0x38 || !this.skipping) this.add('sound', `play sound 0x${(w(1) >>> 0).toString(16)}`);
          advance();
          break;
        case 0x42:
          // FUN_0044f650: reached mid-frame → store N and yield; later frames count down, continue once < 0
          if (this.skipping) {
            this.yieldFlag = false;
            advance();
            break;
          }
          if (!this.yieldFlag) {
            this.countdown = w(1);
            this.yieldFlag = true;
            this.add('flow', `wait ${w(1)} frames (${(w(1) / 60).toFixed(2)} s)`);
            return;
          }
          if (this.countdown >= 0 && --this.countdown >= 0) return;
          this.yieldFlag = false;
          advance();
          break;
        case 0x45: {
          // FUN_0044f7f0: reached mid-frame → yield once; later frames continue once the flag is set
          const n = w(1);
          if (!this.yieldFlag) {
            this.yieldFlag = true;
            this.add('flow', `wait for flag ${n}`);
            return;
          }
          if (!this.flags[n]) return;
          this.yieldFlag = false;
          advance();
          break;
        }
        case 0x41: {
          // FUN_0044f5e0: reached mid-frame → yield once; later frames check the condition
          const n = w(1);
          if (this.skipping) {
            this.yieldFlag = false;
            advance();
            break;
          }
          if (!this.yieldFlag) {
            this.yieldFlag = true;
            this.add('flow', n === 0 ? 'wait until the camera shot ends' : `wait until camera time ${n}`);
            return;
          }
          if (!(n === 0 ? this.remaining < 1 : n < this.timer)) return;
          this.yieldFlag = false;
          advance();
          break;
        }
        case 0x30:
        case 0x6c:
        case 0x6d: {
          // 0x6C / 0x6D queue only with one / two players (DAT_00a3b844)
          const mine = op === 0x30 || (op === 0x6c && this.opts.players === 1) || (op === 0x6d && this.opts.players === 2);
          if (mine && !this.skipping) {
            const mode = w(1);
            const params = Array.from({ length: len / 4 - 2 }, (_, k) => w(2 + k));
            this.queue.push({ mode, params });
            this.pendingCamera++;
          }
          advance();
          break;
        }
        case 0x2d: {
          const id = w(1) & 0xffff;
          const speech = this.opts.dialogue(id);
          if (speech && !this.skipping) this.subtitle = { speech, remaining: speech.durationFrames, line: 0 };
          this.add('say', `say ${id}${speech ? `: “${speech.lines.map((l) => l.text).join(' / ')}”` : ''}`);
          advance();
          break;
        }
        case 0x2c:
          this.skippable = w(1) !== 0;
          if (!this.skippable) this.skipping = false;
          this.add('skip', this.skippable ? 'skippable scene starts (skip sign on)' : 'skippable scene ends');
          advance();
          break;
        case 0x20:
          this.setLight(w(1), [w(2), w(3), w(4)]);
          advance();
          break;
        case 0x23:
          this.startFade(w(1), w(2), w(3));
          advance();
          break;
        case 0x18:
          this.light.pitch = w(1);
          this.light.yaw = w(2);
          this.add('light', `light direction pitch ${w(1)} yaw ${w(2)}`);
          advance();
          break;
        case 0x29:
          this.area = (w(1) << 16) >> 16;
          this.add('other', `stage area ${this.area}`);
          advance();
          break;
        case 0x1b:
          this.skyRow = w(1);
          this.add('light', `sky row ${this.skyRow}`);
          advance();
          break;
        case 0x1c:
          this.skyMode = w(1);
          this.add('light', `sky ${['off', 'on', 'on (still)'][this.skyMode] ?? this.skyMode}`);
          advance();
          break;
        case 0x73: {
          const m = w(1), mode = this.opts.gameMode;
          const cont = m < 100 ? m === mode : m - 100 !== mode;
          if (cont) advance();
          else {
            const target = this.ef.offsetOf(w(2));
            this.add('flow', `game mode branch → 0x${(target ?? 0).toString(16)}`);
            this.pc = target;
          }
          break;
        }
        case 0x4f:
        case 0x71:
          // evt_next_script does not yield: the next script runs on in the same frame
          if (!this.nextScript()) return;
          break;
        case 0x4e:
          this.halted = true;
          this.yieldFlag = true;
          this.add('flow', 'halt');
          return;
        case 0x03:
        case 0x07:
        case 0x09:
        case 0x0a:
        case 0x0b: {
          // 0x03 / 0x07 spawn only with one / two players (FUN_0041fdd0 / FUN_0041fe10, DAT_00a3b844)
          if ((op === 0x03 && this.opts.players !== 1) || (op === 0x07 && this.opts.players !== 2)) {
            advance();
            break;
          }
          const records = readSpawnRecords(this.ef, this.opts.common, o);
          for (const r of records) {
            this.spawns.push(r);
            const typeName = r.type === 0x41 ? `placed[${r.kind}]` : r.type === 0x63 ? 'skip_task' : r.type === 0x60 ? 'title_card' : `type_0x${r.type.toString(16)}`;
            const posStr = r.pos ? ` (${r.pos.map((v) => v.toFixed(0)).join(', ')})` : '';
            const chrStr = r.pos ? ` skel=${r.skeleton} hp=${r.hp}` : '';
            this.add('spawn', `${evtOpName(op)} ${typeName}${chrStr}${posStr}`);
          }
          advance();
          break;
        }
        default: {
          const kind: EvtLogEntry['kind'] =
            op === 0x72 ? 'spawn' : op >= 0x50 && op <= 0x5a ? 'sound' : op === 0x19 || op === 0x24 ? 'light' : 'other';
          const args = Array.from({ length: Math.min(len / 4 - 1, 6) }, (_, k) => w(1 + k));
          this.add(kind, `${evtOpName(op)} ${args.map((a) => (Math.abs(a) < 0x10000 ? a : '0x' + (a >>> 0).toString(16))).join(' ')}${len / 4 - 1 > 6 ? ' …' : ''}`);
          advance();
        }
      }
    }
  }

  /**
   * 0x23 (FUN_00450be0(0)): fade one light/fog value towards a target by a fixed step per frame
   * ({active, current, target, step} records @00a3b3a0, stepped by FUN_00450240 each frame).
   * Targets: subs 0/1/6/7/8/10 point at a float; 2/3/4 (fog colour channel) are ints; 9 = all light channels.
   */
  private fades = new Map<string, { target: number; step: number }>();
  private startFade(sub: number, a: number, step: number) {
    const keys: Record<number, string[]> = { 0: ['fogStart'], 1: ['fogEnd'], 2: ['fogR'], 3: ['fogG'], 4: ['fogB'], 6: ['r'], 7: ['g'], 8: ['b'], 9: ['r', 'g', 'b'], 10: ['intensity'] };
    const ks = keys[sub];
    if (!ks) {
      this.add('light', `fade sub ${sub} ${a} ${step} (not decoded)`);
      return;
    }
    const target = sub >= 2 && sub <= 4 ? a / 255 : this.f32At(a);
    if (target === undefined) return;
    for (const k of ks) this.fades.set(k, { target, step: sub >= 2 && sub <= 4 ? step / 255 : step });
    if (sub <= 1) this.light.fog = true;
    this.add('light', `fade ${ks.join('/')} → ${target.toFixed(2)} by ${step}/frame`);
  }

  private stepFades() {
    const L = this.light;
    const get = (k: string) => ({ fogStart: L.fogStart, fogEnd: L.fogEnd, fogR: L.fogColor[0], fogG: L.fogColor[1], fogB: L.fogColor[2], r: L.color[0], g: L.color[1], b: L.color[2], intensity: L.intensity })[k]!;
    const set = (k: string, v: number) => {
      if (k === 'fogStart') L.fogStart = v;
      else if (k === 'fogEnd') L.fogEnd = v;
      else if (k === 'fogR') L.fogColor[0] = v;
      else if (k === 'fogG') L.fogColor[1] = v;
      else if (k === 'fogB') L.fogColor[2] = v;
      else if (k === 'intensity') L.intensity = v;
      else L.color['rgb'.indexOf(k)] = v;
    };
    for (const [k, f] of this.fades) {
      const cur = get(k);
      // FUN_00450240: move by step towards the target; snap and stop once reached
      const next = f.target - cur >= 0 ? Math.min(cur + f.step, f.target) : Math.max(cur - f.step, f.target);
      set(k, next);
      if (next === f.target) this.fades.delete(k);
    }
  }

  private setLight(sub: number, a: number[]) {
    const L = this.light;
    const f = (p: number) => this.f32At(p);
    const set = (desc: string) => this.add('light', desc);
    const cancel: Record<number, string[]> = { 0: ['fogStart'], 1: ['fogEnd'], 2: ['fogR'], 3: ['fogG'], 4: ['fogB'], 5: ['fogR', 'fogG', 'fogB'], 6: ['r'], 7: ['g'], 8: ['b'], 9: ['r', 'g', 'b'], 10: ['intensity'] };
    for (const k of cancel[sub] ?? []) this.fades.delete(k);
    switch (sub) {
      case 0: { const v = f(a[0]!); if (v !== undefined) { L.fogStart = v; L.fog = true; } set(`fog start ${v?.toFixed(0)}`); break; }
      case 1: { const v = f(a[0]!); if (v !== undefined) { L.fogEnd = v; L.fog = true; } set(`fog end ${v?.toFixed(0)}`); break; }
      case 2: L.fogColor[0] = a[0]! / 255; set(`fog red ${a[0]}`); break;
      case 3: L.fogColor[1] = a[0]! / 255; set(`fog green ${a[0]}`); break;
      case 4: L.fogColor[2] = a[0]! / 255; set(`fog blue ${a[0]}`); break;
      case 5: L.fogColor = [a[0]! / 255, a[1]! / 255, a[2]! / 255]; set(`fog colour ${a.join(', ')}`); break;
      case 6: case 7: case 8: { const v = f(a[0]!); if (v !== undefined) L.color[sub - 6] = v; set(`light ${'rgb'[sub - 6]} ${v?.toFixed(2)}`); break; }
      case 9: { const v = a.map(f); v.forEach((x, k) => { if (x !== undefined) L.color[k] = x; }); set(`light colour ${v.map((x) => x?.toFixed(2)).join(', ')}`); break; }
      case 10: { const v = f(a[0]!); if (v !== undefined) L.intensity = v; set(`light intensity ${v?.toFixed(2)}`); break; }
      default: set(`light/fog sub ${sub}`);
    }
  }

  /** One frame of the camera queue (`cam_queue_run` @0040ca70 with the mode handlers @005a2a30). */
  private updateCamera() {
    for (let guard = 0; guard < 64; guard++) {
      const s = this.shot;
      if (s && s.fight !== undefined) {
        if (--s.fight > 0) return;
        this.add('camera', 'fight over' + (this.resume ? ` → resume path ${this.resume.pathId}` : ''));
        this.pendingCamera--;
        s.fight = undefined;
        if (this.resume) {
          const r = this.resume;
          this.resume = undefined;
          this.shot = { pathId: r.pathId, from: r.from, to: r.to, t: r.from };
          this.counter = r.from;
          this.running = true;
          this.ownsCount = false;
        } else this.running = false;
        continue;
      }
      if (s && this.running) {
        // FUN_0040dcd0: time = counter; sample; remaining = end − counter; done when end ≤ counter; counter++
        this.timer = this.counter;
        s.t = this.counter;
        this.remaining = s.to - this.counter;
        const done = s.to <= this.counter;
        this.counter++;
        if (!done) return;
        this.running = false;
        if (this.ownsCount) this.pendingCamera--;
        if (!this.queue.length) return;
        continue;
      }
      const c = this.queue.shift();
      if (!c) return;
      if (c.mode === 0x40) {
        const [a, b, path, flag] = c.params as [number, number, number, number];
        if (a === b) {
          this.timer = a;
          this.shot = { pathId: path, from: a, to: b, t: a };
          this.pendingCamera--;
          this.add('camera', `camera jumps to path ${path} at ${a}`);
          continue;
        }
        if (flag & 2) {
          this.resume = { pathId: path, from: a < 0 ? this.timer + 1 : a, to: b };
          this.pendingCamera--;
          this.add('camera', `after the fight: path ${path} ${this.resume.from}–${b}`);
          continue;
        }
        const from = a < 0 ? this.timer : a;
        this.shot = { pathId: path, from, to: b, t: from };
        this.counter = from;
        this.running = true;
        this.ownsCount = true;
        this.add('camera', `camera path ${path}, time ${from}–${b}`);
        continue;
      }
      if (c.mode === 0x21) {
        this.shot = { ...(this.shot ?? { pathId: -1, from: 0, to: 0, t: 0 }), fight: this.opts.holdFrames };
        this.running = false;
        this.add('camera', `fight ${c.params[0]} — enemies attack (gameplay not ported yet; holding ${(this.opts.holdFrames / 60).toFixed(0)} s)`);
        return;
      }
      this.pendingCamera--;
      const what = { 0x11: 'screen/effect', 0x12: 'player state', 0x14: 'view player', 0x60: 'look-at set-up' }[c.mode] ?? 'not decoded yet';
      this.add('camera', `camera mode 0x${c.mode.toString(16)} [${c.params.join(', ')}] (${what})`);
    }
  }

  private countdown = 0;
  /** The interpreter's yield flag DAT_00a3b860 (kept across frames, as in the exe). */
  private yieldFlag = false;
  private counter = 0;
  private running = false;
  private ownsCount = false;
}
