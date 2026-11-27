#!/usr/bin/env node
// Frees dev ports before Vite starts (vite.config.ts uses strictPort: true, so an
// orphaned Vite/node process on 1420 would otherwise make `npm run dev` and
// `tauri dev` fail with "Port 1420 is already in use").
//
// Usage: node scripts/kill-port.mjs [port ...]   (default: 1420)
// Node built-ins only. Never kills its own pid or its parent's. Always exits 0.
//
// Only ORPHANS are killed: a listener whose launcher chain (node / cmd / npm / npx â€¦) is
// broken because the `tauri dev` or `npm run dev` that started it has died. A dev server
// still owned by a live terminal or agent session is left alone â€” killing it blacked out
// the running Command Center window every time a second session started its own dev
// server. Vite then fails on strictPort with a clear "port in use" instead. Set
// KILL_PORT_FORCE=1 to kill regardless.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_PORTS = [1420];
// Windows pseudo-processes that can show up as owners of a socket; never touch them.
const PROTECTED_PIDS = new Set([0, 4]);

/** Parse CLI args into a de-duplicated list of valid TCP ports. */
export function parsePorts(args) {
  const ports = [];
  for (const a of args) {
    const n = Number(String(a).trim());
    if (Number.isInteger(n) && n > 0 && n < 65536 && !ports.includes(n)) ports.push(n);
  }
  return ports.length ? ports : [...DEFAULT_PORTS];
}

/**
 * From `netstat -ano` output (Windows), return the PIDs of TCP / TCPv6 sockets
 * LISTENING on `port`. The local address must end in `:<port>` exactly (so
 * 14200 never matches 1420). The state column is localised on non-English
 * Windows, so a row whose foreign address is the wildcard `*:0` also counts.
 */
export function parseNetstatListeners(output, port) {
  const pids = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;
    const [, local, foreign, state, pidCol] = cols;
    if (!local.endsWith(`:${port}`)) continue;
    const listening = state.toUpperCase() === "LISTENING" || /^(0\.0\.0\.0|\[::\]|\*):0$/.test(foreign);
    if (!listening) continue;
    const pid = Number(pidCol);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Parse `lsof -t` output (one pid per line). */
export function parseLsofPids(output) {
  const pids = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (line.trim() && Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Drop pids that must never be killed: this script, its parent, OS pseudo-processes. */
export function killablePids(pids, self = process.pid, parent = process.ppid) {
  return pids.filter((p) => p !== self && p !== parent && !PROTECTED_PIDS.has(p));
}

// Launcher processes that sit between a dev server and whoever started it. A chain made only
// of these ends at a live owner (a shell, terminal, IDE or agent) unless a link has died.
const LAUNCHERS = new Set(["node", "node.exe", "cmd.exe", "conhost.exe", "npm", "npx", "sh", "rustup.exe", "cargo.exe"]);

/**
 * Decide whether the listener `pid` is an orphan. `procs` maps pid -> { ppid, name, created }
 * (`created` is any monotonically comparable start time). Walk up through launcher
 * processes: a missing parent, or a "parent" started AFTER its child (pid reuse), means the
 * chain is broken -> orphan. Reaching a live non-launcher process means it is owned.
 * Returns { orphan, owner } where owner names the live process that owns it, if any.
 */
export function classifyListener(pid, procs) {
  let cur = procs.get(pid);
  if (!cur) return { orphan: false, owner: null }; // can't see it: be conservative, don't kill
  for (let depth = 0; depth < 12; depth++) {
    const parent = procs.get(cur.ppid);
    if (!parent || (parent.created != null && cur.created != null && parent.created > cur.created)) {
      return { orphan: true, owner: null };
    }
    if (!LAUNCHERS.has(String(parent.name).toLowerCase())) {
      return { orphan: false, owner: `${parent.name} (pid ${cur.ppid})` };
    }
    cur = parent;
  }
  return { orphan: false, owner: "a deep launcher chain" };
}

/** Parse the JSON from `Get-CimInstance Win32_Process | ConvertTo-Json` into a pid map. */
export function parseProcessTable(json) {
  const procs = new Map();
  let rows;
  try {
    rows = JSON.parse(json);
  } catch {
    return procs;
  }
  for (const r of Array.isArray(rows) ? rows : [rows]) {
    if (r && Number.isInteger(r.ProcessId)) {
      procs.set(r.ProcessId, { ppid: r.ParentProcessId, name: r.Name ?? "", created: r.C ?? null });
    }
  }
  return procs;
}

export function processTable() {
  if (process.platform === "win32") {
    const ps =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name," +
      "@{n='C';e={if($_.CreationDate){$_.CreationDate.ToFileTimeUtc()}else{$null}}} | ConvertTo-Json -Compress";
    return parseProcessTable(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]));
  }
  // POSIX: `ps` gives pid/ppid/comm; an orphan is reparented to init (ppid 1), which isn't a launcher.
  const procs = new Map();
  for (const line of run("ps", ["-axo", "pid=,ppid=,comm="]).split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), name: m[3].split("/").pop(), created: null });
  }
  return procs;
}

function run(file, args) {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch (e) {
    // lsof exits 1 when nothing matches; its stdout (if any) is still useful.
    return typeof e?.stdout === "string" ? e.stdout : "";
  }
}

export function listeners(port) {
  if (process.platform === "win32") return parseNetstatListeners(run("netstat", ["-ano"]), port);
  return parseLsofPids(run("lsof", ["-nP", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]));
}

function kill(pid) {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ports = parsePorts(process.argv.slice(2));
  const force = process.env.KILL_PORT_FORCE === "1";
  let procs = null;
  for (const port of ports) {
    const found = listeners(port);
    let targets = killablePids(found);
    if (!found.length) continue;
    if (!targets.length) {
      console.log(`[kill-port] port ${port} is held by this process tree or a system process; leaving it alone`);
      continue;
    }
    if (!force) {
      procs ??= processTable();
      const live = [];
      targets = targets.filter((pid) => {
        const c = classifyListener(pid, procs);
        if (!c.orphan) live.push(`pid ${pid}${c.owner ? ` owned by ${c.owner}` : ""}`);
        return c.orphan;
      });
      for (const l of live) {
        console.log(
          `[kill-port] port ${port} is in use by a LIVE dev server (${l}); not killing it. ` +
            `Another Command Center dev session is running â€” stop it first, use another port ` +
            `(npx vite --port 1422 --strictPort), or set KILL_PORT_FORCE=1.`,
        );
      }
    }
    for (const pid of targets) {
      try {
        kill(pid);
        console.log(`[kill-port] killed pid ${pid} listening on port ${port}`);
      } catch (e) {
        console.log(`[kill-port] could not kill pid ${pid} on port ${port}: ${e?.message ?? e}`);
      }
    }
    // Give the OS a moment to release the socket so Vite's strictPort check passes.
    if (targets.length) for (let i = 0; i < 20 && killablePids(listeners(port)).some((p) => targets.includes(p)); i++) await sleep(100);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((e) => console.log(`[kill-port] skipped: ${e?.message ?? e}`))
    .finally(() => process.exit(0));
}
