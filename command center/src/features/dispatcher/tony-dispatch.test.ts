import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ROLES, PRIORITIES, looksLikePacket, spokenSoFar, validatePacket } from "./tony-dispatch";

const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/tony_dispatch.rs"), "utf8");

const example = {
  spoken_reply: "Got it. I'm having the Librarian pull the auth module first, then the Coder will patch it.",
  requires_dispatch: true,
  priority: "normal",
  tasks: [
    { task_id: "stage_auth_files", target_agent: "librarian", action: "Locate and stage the auth module", inputs: ["workspace:auth_module"], constraints: ["read_only"], acceptance_criteria: ["paths returned"], depends_on: [] },
    { task_id: "fix_token_refresh", target_agent: "coder", action: "Patch the token refresh failure", inputs: ["output:stage_auth_files"], constraints: [], acceptance_criteria: ["refresh test passes"], depends_on: ["stage_auth_files"] },
  ],
};

describe("schema mirrors tony_dispatch.rs", () => {
  it("agents and priorities match the Rust constants", () => {
    expect(rs).toContain(`pub const AGENTS: [&str; ${AGENT_ROLES.length}] = [${AGENT_ROLES.map((a) => `"${a}"`).join(", ")}];`);
    expect(rs).toContain(`pub const PRIORITIES: [&str; 3] = [${PRIORITIES.map((a) => `"${a}"`).join(", ")}];`);
  });

  it("accepts the spec example and rejects malformed packets", () => {
    const ok = validatePacket(example);
    expect(ok.ok).toBe(true);
    const bad = (patch: (o: typeof example) => unknown) => validatePacket(patch(JSON.parse(JSON.stringify(example)))).ok;
    expect(bad((o) => ({ ...o, spoken_reply: " " }))).toBe(false);
    expect(bad((o) => ({ ...o, priority: "asap" }))).toBe(false);
    expect(bad((o) => ({ ...o, requires_dispatch: "yes" }))).toBe(false);
    expect(bad((o) => ({ ...o, tasks: [{ ...o.tasks[0], target_agent: "garbage" }] }))).toBe(false);
    expect(bad((o) => ({ ...o, tasks: [{ ...o.tasks[0], acceptance_criteria: [] }] }))).toBe(false);
    expect(bad((o) => ({ ...o, tasks: [{ ...o.tasks[0], task_id: "x" }] }))).toBe(false);
    expect(bad((o) => ({ ...o, tasks: [o.tasks[0], o.tasks[0]] }))).toBe(false);
    expect(bad((o) => ({ ...o, tasks: [{ ...o.tasks[1], depends_on: ["ghost"] }] }))).toBe(false);
    expect(bad((o) => ({ ...o, tasks: [{ ...o.tasks[0], depends_on: ["fix_token_refresh"] }, o.tasks[1]] }))).toBe(false);
    const noTasks = validatePacket({ spoken_reply: "Hi", requires_dispatch: true });
    expect(noTasks.ok && noTasks.value.requires_dispatch).toBe(false);
  });
});

describe("spokenSoFar (streaming TTS)", () => {
  it("prose is not a packet", () => {
    expect(spokenSoFar("Sure, on it.")).toBeNull();
    expect(looksLikePacket("  {")).toBe(true);
    expect(looksLikePacket("```json\n{")).toBe(true);
  });

  it("grows monotonically as the packet streams in, escapes decoded", () => {
    const full = JSON.stringify({ spoken_reply: 'Got it. "Auth" first,\nthen the fix.', requires_dispatch: false, priority: "normal", tasks: [] });
    let prev = "";
    for (let i = 1; i <= full.length; i++) {
      const s = spokenSoFar(full.slice(0, i));
      expect(s).not.toBeNull();
      expect(s!.startsWith(prev)).toBe(true);
      prev = s!;
    }
    expect(prev).toBe('Got it. "Auth" first,\nthen the fix.');
    expect(spokenSoFar('{"spoken_reply": "caf\\u00e9')).toBe("café");
    expect(spokenSoFar('{"spoken_reply": "half \\')).toBe("half ");
    expect(spokenSoFar('{"requires_dispatch": true, ')).toBe("");
  });
});
