import { describe, expect, it } from "vitest";
import { pressHandlers } from "./press";

/** A record button whose `recording` flips as soon as start() is called (the recorder's
 * "starting" state), like the real one on a phone where the mic then takes a while to open. */
function rig() {
  let t = 0;
  const log: string[] = [];
  const st = { recording: false, busy: false };
  const h = pressHandlers({
    recording: () => st.recording,
    busy: () => st.busy,
    onStart: () => {
      log.push("start");
      st.recording = true;
    },
    onStop: () => {
      log.push("stop");
      st.recording = false;
    },
    now: () => t,
  });
  return { h, log, st, at: (ms: number) => (t = ms) };
}

describe("record button tap / hold", () => {
  it("a quick tap starts and KEEPS recording (the bug: its own click stopped it at once)", () => {
    const { h, log, at } = rig();
    at(0);
    h.down();
    at(120);
    h.up();
    h.click(1);
    expect(log).toEqual(["start"]);
  });

  it("the next tap stops", () => {
    const { h, log, at } = rig();
    at(0);
    h.down();
    at(100);
    h.up();
    h.click(1);
    at(3000);
    h.down();
    at(3100);
    h.up();
    h.click(1);
    expect(log).toEqual(["start", "stop"]);
  });

  it("hold-to-talk: held over 400 ms stops on release, and its click does nothing more", () => {
    const { h, log, at } = rig();
    at(0);
    h.down();
    at(2500);
    h.up();
    h.click(1);
    expect(log).toEqual(["start", "stop"]);
  });

  it("keyboard toggles; a busy button doesn't start; a cancelled press leaves things alone", () => {
    const k = rig();
    k.h.click(0);
    k.h.click(0);
    expect(k.log).toEqual(["start", "stop"]);
    const b = rig();
    b.st.busy = true;
    b.h.down();
    b.h.up();
    b.h.click(1);
    expect(b.log).toEqual([]);
    const c = rig();
    c.st.recording = true;
    c.h.down();
    c.h.cancel();
    expect(c.log).toEqual([]);
  });
});
