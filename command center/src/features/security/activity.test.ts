import { beforeEach, describe, expect, it, vi } from "vitest";

const touch = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/platform", () => ({ isTauri: () => true }));

import { ACTIVITY_EVERY_MS, reportActivity, resetActivityForTests } from "./activity";

describe("activity reporting (talking to Tony counts)", () => {
  beforeEach(() => {
    resetActivityForTests();
    touch.mockClear();
  });

  it("touches Rust at most once per window", () => {
    expect(reportActivity(1_000_000, touch)).toBe(true);
    expect(reportActivity(1_000_000 + 1_000, touch)).toBe(false);
    expect(reportActivity(1_000_000 + ACTIVITY_EVERY_MS, touch)).toBe(true);
    expect(touch).toHaveBeenCalledTimes(2);
  });
});
