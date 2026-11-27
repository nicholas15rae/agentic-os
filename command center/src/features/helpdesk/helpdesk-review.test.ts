import { describe, expect, it } from "vitest";
import type { VoiceTurn } from "@/features/voice/voice-store";
import { diagnosisTitle, HELPDESK_ENGINE, helpdeskTranscript, noProblem, ticketBody } from "./helpdesk-review";

const turn = (o: Partial<VoiceTurn>): VoiceTurn => ({ id: String(Math.random()), who: "user", text: "", thread: "auto", at: 0, ...o }) as VoiceTurn;

describe("help desk review", () => {
  it("always uses the Claude CLI", () => expect(HELPDESK_ENGINE).toBe("claude-cli"));

  it("sends only the thread's last user / agent turns, with the timing tags", () => {
    const turns = [
      turn({ text: "old", thread: "auto" }),
      turn({ text: "other tab", thread: "coder" }),
      turn({ who: "system", text: "noise" }),
      turn({ text: "check my messages" }),
      turn({ who: "agent", from: "os", text: "No new messages, Nic.", meta: "lmstudio · 3811ms" }),
    ];
    const t = helpdeskTranscript(turns, "auto", 2);
    expect(t).toEqual([
      { role: "user", content: "check my messages" },
      { role: "assistant", content: "No new messages, Nic.\n[meta: os · lmstudio · 3811ms]" },
    ]);
  });

  it("titles the ticket from the TITLE line", () => {
    expect(diagnosisTitle("TITLE: Messages read the agent inbox\nWHAT HAPPENED: …")).toBe("Messages read the agent inbox");
    expect(diagnosisTitle("")).toBe("Something's off (help desk)");
    expect(diagnosisTitle(`TITLE: ${"x".repeat(200)}`).length).toBe(100);
  });

  it("never files 'no problem found'", () => {
    expect(noProblem("TITLE: No problem found\nAll good.")).toBe(true);
    expect(noProblem("TITLE: Wrong source")).toBe(false);
  });

  it("puts the diagnosis first, then the reviewed turns", () => {
    const b = ticketBody("TITLE: x", [{ role: "user", content: "hi" }], "auto");
    expect(b.startsWith("TITLE: x")).toBe(true);
    expect(b).toContain("Nic: hi");
  });
});
