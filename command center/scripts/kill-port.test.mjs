// Run: node --test scripts/   (or: npm run test:scripts)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePorts,
  parseNetstatListeners,
  parseLsofPids,
  killablePids,
  classifyListener,
  parseProcessTable,
} from "./kill-port.mjs";

// pid -> { ppid, name, created }
const table = (rows) => new Map(rows.map(([pid, ppid, name, created]) => [pid, { ppid, name, created }]));

test("live dev server: vite -> cmd -> node(npm) -> powershell is owned, not an orphan", () => {
  const procs = table([
    [900, 1, "powershell.exe", 10],
    [901, 900, "node.exe", 20], // npx tauri dev
    [902, 901, "cmd.exe", 21],
    [903, 902, "node.exe", 22], // vite
  ]);
  assert.deepEqual(classifyListener(903, procs), { orphan: false, owner: "powershell.exe (pid 900)" });
});

test("orphan: the tauri dev / npm launcher died, leaving cmd -> vite", () => {
  const procs = table([
    [902, 901, "cmd.exe", 21], // 901 (npm) is gone
    [903, 902, "node.exe", 22],
  ]);
  assert.equal(classifyListener(903, procs).orphan, true);
});

test("orphan: parent pid reused by a newer process counts as broken", () => {
  const procs = table([
    [901, 1, "explorer.exe", 99], // started after its "child": pid reuse
    [903, 901, "node.exe", 22],
  ]);
  assert.equal(classifyListener(903, procs).orphan, true);
});

test("unknown listener pid is never treated as an orphan", () => {
  assert.equal(classifyListener(12345, table([])).orphan, false);
});

test("agent-launched dev server is owned by the agent's shell", () => {
  const procs = table([
    [500, 1, "claude.exe", 1],
    [501, 500, "bash.exe", 2],
    [502, 501, "node.exe", 3],
  ]);
  assert.deepEqual(classifyListener(502, procs), { orphan: false, owner: "bash.exe (pid 501)" });
});

test("process table JSON parsing (array and single object)", () => {
  const one = parseProcessTable('{"ProcessId":7,"ParentProcessId":1,"Name":"node.exe","C":5}');
  assert.deepEqual(one.get(7), { ppid: 1, name: "node.exe", created: 5 });
  const many = parseProcessTable('[{"ProcessId":7,"ParentProcessId":1,"Name":"a","C":null},{"ProcessId":8,"ParentProcessId":7,"Name":"b"}]');
  assert.equal(many.size, 2);
  assert.equal(parseProcessTable("not json").size, 0);
});

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100
  TCP    127.0.0.1:1420         0.0.0.0:0              LISTENING       5001
  TCP    127.0.0.1:1420         127.0.0.1:53000        ESTABLISHED     5001
  TCP    127.0.0.1:53000        127.0.0.1:1420         ESTABLISHED     7777
  TCP    0.0.0.0:14200          0.0.0.0:0              LISTENING       6000
  TCP    [::1]:1420             [::]:0                 LISTENING       5002
  TCP    [::]:1421              [::]:0                 ABHÖREN         5003
  TCP    0.0.0.0:1421           0.0.0.0:0              LISTENING       0
  UDP    0.0.0.0:1420           *:*                                    9999
`;

test("netstat: LISTENING tcp + tcpv6 rows on the exact port", () => {
  assert.deepEqual(parseNetstatListeners(NETSTAT, 1420).sort(), [5001, 5002]);
});

test("netstat: localised state recognised via wildcard foreign address; pid 0 dropped", () => {
  assert.deepEqual(parseNetstatListeners(NETSTAT, 1421), [5003]);
});

test("netstat: no match for free port and suffix collisions", () => {
  assert.deepEqual(parseNetstatListeners(NETSTAT, 420), []);
  assert.deepEqual(parseNetstatListeners("", 1420), []);
});

test("lsof pid parsing", () => {
  assert.deepEqual(parseLsofPids("123\n456\n123\n\n"), [123, 456]);
  assert.deepEqual(parseLsofPids(""), []);
});

test("never kills self, parent, or system pids", () => {
  assert.deepEqual(killablePids([4, 10, 11, 12, 0], 10, 11), [12]);
});

test("port args", () => {
  assert.deepEqual(parsePorts([]), [1420]);
  assert.deepEqual(parsePorts(["1420", "1421", "1420", "abc", "70000"]), [1420, 1421]);
});
