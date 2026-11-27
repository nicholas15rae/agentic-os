import { describe, expect, it, vi } from "vitest";
import { clearOnSuccess } from "./hub-store";

describe("review #21: inputs survive a failed command", () => {
  it("clears only when the command returned something", async () => {
    const clear = vi.fn();
    expect(await clearOnSuccess(Promise.resolve(undefined), clear)).toBeUndefined();
    expect(clear).not.toHaveBeenCalled();
    await clearOnSuccess(Promise.resolve({ build_id: "b-1" }), clear);
    expect(clear).toHaveBeenCalledOnce();
  });
});
