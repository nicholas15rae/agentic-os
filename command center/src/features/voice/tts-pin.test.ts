import { describe, expect, it, vi } from "vitest";
import { synthArgs } from "./tts-text";
import { PinCache, newPinId, unpinEverywhere } from "./tts-pin";

const bytes = (n: number) => new Uint8Array([n]).buffer;
const first = async (p: Promise<ArrayBuffer>) => new Uint8Array(await p)[0];

/**
 * Fix pass: a cached line (ack / intro / greeting) that Rust answered with Kokoro during a
 * 402/429 cooldown used to stay pinned for the whole session. Now Rust emits `tts-unpin` for
 * that call's `pinId` and the next play synthesizes it again.
 */
describe("PinCache", () => {
  it("a line answered by the cloud voice is synthesized once and replayed from the cache", async () => {
    const c = new PinCache();
    const synth = vi.fn(async () => bytes(1));
    expect(await first(c.get("ack", synth))).toBe(1);
    expect(await first(c.get("ack", synth))).toBe(1);
    expect(synth).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it("a line Rust answered locally (tts-unpin) plays that once, then is synthesized again", async () => {
    const c = new PinCache();
    let n = 0;
    const ids: string[] = [];
    const synth = vi.fn(async (pinId: string) => {
      ids.push(pinId);
      return bytes(++n);
    });
    const p = c.get("Got it, Nic.", synth);
    unpinEverywhere(ids[0]); // Rust emits before the bytes come back
    expect(await first(p)).toBe(1); // this play still has its (Kokoro) audio
    expect(c.has("Got it, Nic.")).toBe(false);
    // ElevenLabs is back: the next play asks again, with a new pin id, and that one is kept.
    expect(await first(c.get("Got it, Nic.", synth))).toBe(2);
    expect(ids[1]).not.toBe(ids[0]);
    expect(await first(c.get("Got it, Nic.", synth))).toBe(2);
    expect(synth).toHaveBeenCalledTimes(2);
    c.dispose();
  });

  it("an unpin after the bytes arrived drops it too; unknown / stale ids change nothing", async () => {
    const c = new PinCache();
    let id = "";
    await c.get("intro", async (pinId) => {
      id = pinId;
      return bytes(7);
    });
    unpinEverywhere("pin-not-ours");
    expect(c.has("intro")).toBe(true);
    unpinEverywhere(id);
    expect(c.has("intro")).toBe(false);
    const again = vi.fn(async () => bytes(8));
    await c.get("intro", again);
    unpinEverywhere(id); // the old id again: the new entry stays
    expect(c.has("intro")).toBe(true);
    c.dispose();
  });

  it("a failed synthesis is retried next time", async () => {
    const c = new PinCache();
    await expect(c.get("x", async () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    expect(c.has("x")).toBe(false);
    c.dispose();
  });

  it("pin ids follow Rust's id rule and the cached args carry them (never utteranceId)", () => {
    for (let i = 0; i < 20; i++) expect(newPinId()).toMatch(/^[A-Za-z0-9-]{1,64}$/);
    expect(synthArgs("Hey Nicky, what's up?", { agent: "general", cache: true, utteranceId: "u-1" }, "pin-1")).toEqual({ text: "Hey Nicky, what's up?", voice: undefined, agent: "general", pinId: "pin-1" });
    expect(synthArgs("live", { agent: "general", utteranceId: "u-1" }, "pin-1")).not.toHaveProperty("pinId");
  });
});
