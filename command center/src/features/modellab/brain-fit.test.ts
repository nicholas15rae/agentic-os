import { describe, expect, it } from "vitest";
import { fitBadge, fitConfirmText, fitKind, parseFitWarning } from "./brain-fit";

describe("Model Lab brain fit", () => {
  it("maps Rust's fit labels", () => {
    expect(fitKind("fits")).toBe("fits");
    expect(fitKind("tight")).toBe("tight");
    expect(fitKind("spills to RAM — slow")).toBe("spills");
  });

  it("marks tight and spilling models clearly", () => {
    expect(fitBadge("fits", 16_384)).toMatchObject({ text: "fits · 16k", tone: "ok" });
    expect(fitBadge("tight", 8_192)).toMatchObject({ text: "TIGHT · 8k", tone: "warn" });
    expect(fitBadge("spills to RAM — slow", 4_096)).toMatchObject({ text: "WON'T FIT · 4k", tone: "bad" });
  });

  it("parses model_use's FIT_WARN refusals and nothing else", () => {
    expect(parseFitWarning("FIT_WARN:spills: X won't fit")).toEqual({ kind: "spills", message: "X won't fit" });
    expect(parseFitWarning(new Error("FIT_WARN:unknown: can't check"))?.kind).toBe("unknown");
    expect(parseFitWarning("STEP_UP_REQUIRED:settings: nope")).toBeNull();
    expect(parseFitWarning(undefined)).toBeNull();
  });

  it("asks before forcing", () => {
    const t = fitConfirmText({ kind: "tight", message: "only 8k" });
    expect(t).toContain("tight fit");
    expect(t).toContain("anyway?");
  });
});
