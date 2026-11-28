/**
 * Built-in llama.cpp engine (Section 26): types for the gateway's /api/engine/* routes and the
 * pure helpers the Models screen uses. Unit-tested; no I/O here.
 *
 * The engine is OFF by default and nothing routes to it until Nic switches Tony over; the screen
 * shows that state plainly and never turns it on by itself.
 */

export interface EngineSettings {
  enabled: boolean;
  exe: string;
  host: string;
  port: number;
  model_path: string;
  alias: string;
  mmproj: string;
  ctx: number;
  parallel: number;
  gpu_layers: number;
  flash_attn: boolean;
  kv_type_k: string;
  kv_type_v: string;
  cache_reuse: number;
  prompt_cache: boolean;
  keep_warm: boolean;
  jinja: boolean;
  thinking_default: boolean;
  /** Switchboard rows (off by default; Nic's call): gateway agents / gateway Tony on the engine. */
  route_agents: boolean;
  route_tony: boolean;
  threads: number;
  extra_args: string[];
}

export interface Fit {
  weightsMiB: number;
  kvCacheMiB: number;
  recurrentMiB: number;
  projectorMiB: number;
  computeMiB: number;
  totalMiB: number;
  freeMiB: number;
  reclaimMiB: number;
  availableMiB: number;
  fits: boolean;
  fitsEmptyCard: boolean;
  shortMiB: number;
  ctx: number;
  kv: string;
  error?: string;
}

export interface LibraryModel {
  path: string;
  name: string;
  sizeMiB: number;
  root: string;
  fit?: Fit | null;
  loaded?: boolean;
}

export interface Library {
  chat: LibraryModel[];
  projectors: LibraryModel[];
  embedders: LibraryModel[];
  vramError?: string;
}

export interface Vram {
  gpu: string;
  totalMiB: number;
  usedMiB: number;
  freeMiB: number;
  processes: { pid: number | string; name: string; usedMiB: number | null }[];
  error?: string;
}

export interface EngineStatus {
  engine: { enabled: boolean; health: "ok" | "loading" | "error" | "down"; baseUrl: string; pid?: number | null; model?: string | null; alias?: string | null; startedAt?: number | null };
  vram: Vram;
}

export interface DownloadJob {
  key: string;
  state: "running" | "done" | "exists" | "partial" | "failed";
  done: number;
  total: number | null;
  error?: string;
}

export const KV_TYPES = ["f16", "bf16", "q8_0", "q5_1", "q5_0", "q4_1", "q4_0", "iq4_nl"] as const;

export function gib(mib: number): string {
  return `${(mib / 1024).toFixed(mib >= 10240 ? 0 : 1)} GB`;
}

/** VRAM bar: used share 0-100 and a tone (amber past 85 %, alert past 95 %). */
export function vramBar(v: Pick<Vram, "totalMiB" | "usedMiB">): { pct: number; tone: "ok" | "warn" | "bad"; label: string } {
  const pct = v.totalMiB > 0 ? Math.min(100, Math.max(0, Math.round((v.usedMiB / v.totalMiB) * 100))) : 0;
  return { pct, tone: pct > 95 ? "bad" : pct > 85 ? "warn" : "ok", label: `${gib(v.usedMiB)} of ${gib(v.totalMiB)} used` };
}

/** The badge next to a model: fits now / fits once the card is free / too big / unknown. */
export function fitLabel(fit: Fit | null | undefined): { text: string; tone: "ok" | "warn" | "bad" | "muted"; title: string } {
  if (!fit || fit.error) return { text: "fit unknown", tone: "muted", title: fit?.error ?? "No VRAM reading" };
  const parts = `${gib(fit.weightsMiB)} weights + ${gib(fit.kvCacheMiB + fit.recurrentMiB)} cache (${Math.round(fit.ctx / 1024)}k, ${fit.kv}) + ${gib(fit.computeMiB)} compute`;
  if (fit.fits) return { text: `fits · ${gib(fit.totalMiB)}`, tone: "ok", title: `${parts}. ${gib(fit.availableMiB)} available now.` };
  if (fit.fitsEmptyCard)
    return { text: `needs ${gib(fit.totalMiB)} · card busy`, tone: "warn", title: `${parts}. Short by ${gib(fit.shortMiB)} while other models hold the card (Bionic, speech-to-text).` };
  return { text: `too big · ${gib(fit.totalMiB)}`, tone: "bad", title: `${parts}. More than the whole card; lower the context or pick a smaller quant.` };
}

/** Health → words for the status line. */
export function healthText(s: EngineStatus["engine"]): string {
  if (!s.enabled && s.health === "down") return "Off (Tony stays on LM Studio)";
  switch (s.health) {
    case "ok":
      return s.enabled ? "Running" : "Running (test only: switched off, nothing routes here)";
    case "loading":
      return "Loading the model…";
    case "error":
      return "Not healthy (the watchdog restarts it)";
    default:
      return s.enabled ? "Stopped" : "Off";
  }
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._ +-]{0,200}\.gguf$/;

/** Accepts "owner/repo" + "file.gguf", or a pasted huggingface.co …/resolve|blob/<rev>/<file>.gguf URL. */
export function parseHfInput(repoOrUrl: string, file = ""): { repo: string; filename: string; revision: string } | { error: string } {
  const s = repoOrUrl.trim();
  const m = s.match(/^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(?:resolve|blob)\/([^/]+)\/([^?#]+)$/);
  const [repo, revision, filename] = m ? [m[1], m[2], decodeURIComponent(m[3])] : [s, "main", file.trim()];
  if (!REPO.test(repo) || repo.includes("..")) return { error: "Use owner/repo, e.g. Qwen/Qwen3-8B-GGUF" };
  if (!FILE.test(filename) || filename.includes("..") || filename.includes("/")) return { error: "One .gguf file name, no folders" };
  return { repo, filename, revision };
}

/** Delete needs the file name typed exactly (the gateway checks it again). */
export function deleteConfirmed(path: string, typed: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.length > 0 && typed === name;
}

export function progressText(j: DownloadJob): string {
  const mb = (n: number) => `${Math.round(n / 1048576)} MB`;
  if (j.state === "failed") return `failed: ${j.error ?? "unknown error"}`;
  if (j.state === "done" || j.state === "exists") return j.state === "exists" ? "already on disk" : "done";
  if (j.total) return `${mb(j.done)} / ${mb(j.total)} (${Math.floor((j.done / j.total) * 100)} %)`;
  return mb(j.done);
}

// ── Section 26: switches, backend indicators, test reply, last benchmark ─────

/** engine_route.rs `SwitchView` (the desktop reads engine.json itself, so it works on any gateway). */
export interface EngineSwitchView {
  route: { enabled: boolean; routeTony: boolean; routeAgents: boolean; baseUrl: string; alias: string } | null;
  chat: "engine" | "lmstudio";
  memory: "anythingllm";
  compaction: "engine" | "lmstudio";
  health: "ok" | "loading" | "down" | "error";
  served: string | null;
  path: string;
}

export interface BenchSummary {
  ttft_median?: number;
  ttft_p90?: number;
  total_median?: number;
  total_p90?: number;
  hit_target?: number;
  ok?: number;
  n?: number;
}

export interface BenchLast {
  engine: { started: string; summary: BenchSummary; vramMiB?: number | null; file: string } | null;
  lmstudio: { started: string; summary: BenchSummary | null; file: string } | null;
}

export interface TestReply {
  firstTokenSecs: number | null;
  totalSecs: number;
  text: string;
  model: string;
  baseUrl: string;
}

/** The at-a-glance row: who answers Tony's chat, who holds memory / documents. */
export function backendRows(v: EngineSwitchView | null): { label: string; value: string; tone: "ok" | "warn" | "muted" }[] {
  if (!v) return [{ label: "Chat", value: "checking…", tone: "muted" }];
  const onEngine = v.chat === "engine";
  const engineNote = onEngine && v.health !== "ok" ? ` (engine ${v.health}: replies fall back down the chain)` : "";
  return [
    { label: "Tony's chat", value: onEngine ? `Built-in engine${engineNote}` : "LM Studio (legacy)", tone: onEngine ? (v.health === "ok" ? "ok" : "warn") : "muted" },
    { label: "Memory compaction", value: v.compaction === "engine" ? "Built-in engine" : "LM Studio (legacy)", tone: v.compaction === "engine" ? "ok" : "muted" },
    { label: "Memory & documents (RAG)", value: "AnythingLLM + vault (legacy; the engine's doc store is ready on the gateway, not joined yet)", tone: "muted" },
    { label: "Gateway agents", value: v.route?.routeAgents && v.route.enabled ? "Built-in engine" : "AnythingLLM workspaces (legacy)", tone: v.route?.routeAgents && v.route.enabled ? "ok" : "muted" },
  ];
}

/** Why the Route-Tony switch can't be turned on yet, or null when it can (the Rust side checks too). */
export function routeTonyBlocker(v: EngineSwitchView | null): string | null {
  if (!v) return "Checking the engine…";
  if (v.chat === "engine") return null; // turning OFF is always allowed
  if (!v.route?.enabled) return "Turn the engine on first.";
  if (v.health !== "ok" || !v.served) return `Load a model first (engine ${v.health}).`;
  return null;
}

const s = (n: number | undefined) => (n == null ? "–" : `${n.toFixed(2)} s`);

/** "first word 0.38 s (p90 1.61) · reply 1.93 s · 10/12 under 1.5 s". */
export function benchLine(b: BenchSummary | null | undefined): string {
  if (!b || b.ttft_median == null) return "no run yet";
  const hit = b.hit_target != null && b.ok != null ? ` · ${b.hit_target}/${b.ok} under 1.5 s` : "";
  return `first word ${s(b.ttft_median)} (p90 ${s(b.ttft_p90)}) · reply ${s(b.total_median)}${hit}`;
}

export function testReplyLine(t: TestReply): string {
  return `first word ${t.firstTokenSecs == null ? "–" : `${t.firstTokenSecs.toFixed(2)} s`} · whole reply ${t.totalSecs.toFixed(2)} s`;
}

/** fastpath.rs `FastPath` (all false by default). */
export interface FastPathSettings {
  smallTalkSkipsTools: boolean;
  /** Latency pass: Tony's history window moves in steps so the engine keeps it cached. */
  stableHistory?: boolean;
  instantCues: boolean;
  statsCache: boolean;
}
