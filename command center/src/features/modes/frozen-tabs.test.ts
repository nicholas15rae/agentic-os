import { describe, expect, it } from "vitest";
import { splitFrozen } from "@/features/modes/frozen-tabs";

describe("Agents tabs: frozen group", () => {
  it("tucks frozen agents away, never Auto-route or Tony", () => {
    const frozen = new Set(["booking", "librarian"]);
    const r = splitFrozen(["auto", "general", "coder", "booking", "librarian"], (t) => (frozen.has(t) ? `${t} is frozen on the master switchboard` : null));
    expect(r.live).toEqual(["auto", "general", "coder"]);
    expect(r.frozen.map((f) => f.t)).toEqual(["booking", "librarian"]);
    expect(splitFrozen(["auto", "general"], () => "frozen").live).toEqual(["auto", "general"]);
  });
});
