import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The card's buttons only run on click; the gate (and the voice controller behind it) never loads here.
vi.mock("@/features/bridge/gate", () => ({ gated: vi.fn() }));

import { ModelLibraryCard } from "./HubSettings";

describe("ModelLibraryCard", () => {
  it("names Bionic's models folder on C: (the D:\\ model folders are junctioned into it)", () => {
    const html = renderToStaticMarkup(createElement(ModelLibraryCard));
    expect(html).toContain("C:\\Users\\nicho\\.lmstudio\\models");
    expect(html).toContain("junctioned in");
  });
});
