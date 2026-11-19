/**
 * The session cache for `cache: true` lines (intros, acks, the greeting), split out of
 * `engines.ts` so it is node-testable.
 *
 * Every first synthesis of a cached line sends a fresh `pinId`. When Rust answers that call
 * with a local engine instead of the configured cloud voice (a breaker cooldown, an
 * ElevenLabs failure, the kill switch), it emits `tts-unpin { pinId }` and the entry is
 * dropped: the fallback audio plays that once and the next time the line is synthesized
 * again, so a 429 window can't leave "Got it, Nic." in Kokoro for the rest of the session.
 */

type Entry = { pinId: string; p: Promise<ArrayBuffer> };

/** Every live cache, so one `tts-unpin` listener can reach whichever cache sent the id. */
const live = new Set<PinCache>();

let seq = 0;
/** `[A-Za-z0-9-]{1,64}` (Rust's id rule), unique per call. */
export function newPinId(): string {
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `pin-${(++seq).toString(36)}-${rnd}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64);
}

export class PinCache {
  private entries = new Map<string, Entry>();
  /** pinId → key, for the entries still pinned. */
  private byPin = new Map<string, string>();

  constructor(private makeId: () => string = newPinId) {
    live.add(this);
  }

  /** The cached bytes for `key` (a copy: decodeAudioData detaches the buffer it's given), or a
   * new synthesis via `synth(pinId)`. A failed synthesis is retried next time. */
  get(key: string, synth: (pinId: string) => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
    let e = this.entries.get(key);
    if (!e) {
      const pinId = this.makeId();
      const p = synth(pinId);
      const entry: Entry = { pinId, p };
      e = entry;
      this.entries.set(key, entry);
      this.byPin.set(pinId, key);
      p.catch(() => this.drop(key, entry));
    }
    return e.p.then((b) => b.slice(0));
  }

  /** Rust answered `pinId` locally: forget it (whether or not its bytes have arrived yet). */
  unpin(pinId: string): boolean {
    const key = this.byPin.get(pinId);
    if (key === undefined) return false;
    const e = this.entries.get(key);
    if (e) this.drop(key, e);
    else this.byPin.delete(pinId);
    return true;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Stop receiving unpins (an engine being replaced). */
  dispose() {
    live.delete(this);
    this.entries.clear();
    this.byPin.clear();
  }

  private drop(key: string, e: Entry) {
    if (this.entries.get(key) === e) this.entries.delete(key);
    this.byPin.delete(e.pinId);
  }
}

/** A `tts-unpin` event: whichever cache sent this id drops it. */
export function unpinEverywhere(pinId: string): void {
  if (typeof pinId !== "string" || !pinId) return;
  for (const c of live) if (c.unpin(pinId)) return;
}
