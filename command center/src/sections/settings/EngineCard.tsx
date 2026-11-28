import { useCallback, useEffect, useState } from "react";
import { Cpu, Download, Loader2, Power, RefreshCw, Trash2 } from "lucide-react";
import { Card, Field, Select } from "@/components/ui";
import { engineApi } from "@/features/engine/engine-api";
import {
  deleteConfirmed,
  fitLabel,
  gib,
  healthText,
  KV_TYPES,
  parseHfInput,
  progressText,
  vramBar,
  type DownloadJob,
  type EngineSettings,
  type EngineStatus,
  type Library,
  type LibraryModel,
} from "@/features/engine/engine";
import { Toggle } from "./os-ui";

const TONE = { ok: "text-teal", warn: "text-amber", bad: "text-alert", muted: "text-ink-3" } as const;
const BAR = { ok: "bg-teal/70", warn: "bg-amber/80", bad: "bg-alert/80" } as const;

/**
 * Settings → Services: the built-in llama.cpp engine (Section 26). Off by default; Tony stays on
 * LM Studio until Nic switches him. Every call is desktop-only on the gateway (loopback).
 */
export function EngineCard() {
  const [st, setSt] = useState<EngineStatus | null>(null);
  const [cfg, setCfg] = useState<EngineSettings | null>(null);
  const [lib, setLib] = useState<Library | null>(null);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [hf, setHf] = useState({ repo: "", file: "", dest: "" });
  const [del, setDel] = useState<{ path: string; typed: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([engineApi<EngineStatus>("/api/engine/status"), engineApi<EngineSettings>("/api/engine/settings")]);
      setSt(s);
      setCfg(c);
      setJobs(await engineApi<DownloadJob[]>("/api/engine/downloads"));
    } catch (e) {
      setMsg(`Engine routes not reachable: ${String(e)} (start the engine sidecar: python -m engine.serve, or a gateway with this branch)`);
    }
  }, []);

  const scan = useCallback(async () => {
    setBusy("scan");
    try {
      const l = await engineApi<Library>("/api/engine/models?fit=1", { timeoutMs: 120_000 });
      setLib(l);
      setHf((h) => (h.dest || !l.chat[0] ? h : { ...h, dest: l.chat[0].root }));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void scan();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh, scan]);

  const act = async (label: string, fn: () => Promise<unknown>, after?: () => Promise<void>) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      await refresh();
      if (after) await after();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = (patch: Partial<EngineSettings>) =>
    act("save", async () => setCfg(await engineApi<EngineSettings>("/api/engine/settings", { method: "PUT", body: JSON.stringify(patch) })), scan);

  const load = (m: LibraryModel) => act(`load:${m.path}`, () => engineApi("/api/engine/load", { method: "POST", body: JSON.stringify({ path: m.path }), timeoutMs: 300_000 }), scan);
  const unload = () => act("unload", () => engineApi("/api/engine/unload", { method: "POST" }), scan);

  const startDownload = () => {
    const p = parseHfInput(hf.repo, hf.file);
    if ("error" in p) return setMsg(p.error);
    void act("download", () => engineApi("/api/engine/download", { method: "POST", body: JSON.stringify({ ...p, destRoot: hf.dest }) }));
  };

  const confirmDelete = () => {
    if (!del) return;
    void act("delete", () => engineApi("/api/engine/delete", { method: "POST", body: JSON.stringify({ path: del.path, confirm: del.typed }) }), scan).then(() => setDel(null));
  };

  const bar = st?.vram && !st.vram.error ? vramBar(st.vram) : null;
  const roots = Array.from(new Set((lib?.chat ?? []).map((m) => m.root)));

  return (
    <Card
      title="Built-in engine: models"
      hint="Your model folders. Load or swap the engine's model, pick Tony's, see each model's size and VRAM fit. Desktop only."
      action={
        <button onClick={() => void scan()} className="pill-glass inline-flex items-center gap-1 text-xs" disabled={busy !== null}>
          {busy === "scan" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Rescan
        </button>
      }
    >
      {st && (
        <div className="mb-3 space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Power className={`size-4 ${st.engine.health === "ok" ? "text-teal" : "text-ink-3"}`} />
            <span>{healthText(st.engine)}</span>
            {st.engine.alias && <span className="text-ink-3">· {st.engine.alias}</span>}
            <span className="text-ink-3">· {st.engine.baseUrl}</span>
            {st.engine.health === "ok" && (
              <button onClick={() => void unload()} className="pill-glass inline-flex items-center gap-1 ml-auto text-xs" disabled={busy !== null}>
                Unload
              </button>
            )}
          </div>
          {bar && (
            <div title={st.vram.processes.map((p) => `${p.name}${p.usedMiB != null ? ` ${gib(p.usedMiB)}` : ""}`).join(" · ")}>
              <div className="mb-1 flex justify-between text-xs text-ink-3">
                <span>
                  <Cpu className="mr-1 inline size-3.5" />
                  {st.vram.gpu}
                </span>
                <span>{bar.label}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div className={`h-full ${BAR[bar.tone]}`} style={{ width: `${bar.pct}%` }} />
              </div>
            </div>
          )}
        </div>
      )}

      {cfg && (
        <details className="mb-3 text-sm">
          <summary className="cursor-pointer text-ink-2">Engine settings</summary>
          <div className="mt-2 space-y-1">
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Context (tokens)">
                <input className="field" type="number" min={512} step={1024} defaultValue={cfg.ctx} onBlur={(e) => Number(e.target.value) !== cfg.ctx && void save({ ctx: Number(e.target.value) })} />
              </Field>
              <Field label="GPU layers (999 = all)">
                <input className="field" type="number" min={0} defaultValue={cfg.gpu_layers} onBlur={(e) => Number(e.target.value) !== cfg.gpu_layers && void save({ gpu_layers: Number(e.target.value) })} />
              </Field>
              <Field label="Parallel slots">
                <input className="field" type="number" min={1} max={8} defaultValue={cfg.parallel} onBlur={(e) => Number(e.target.value) !== cfg.parallel && void save({ parallel: Number(e.target.value) })} />
              </Field>
              <Field label="KV cache K">
                <Select value={cfg.kv_type_k} onChange={(e) => void save({ kv_type_k: e.target.value })}>
                  {KV_TYPES.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </Select>
              </Field>
              <Field label="KV cache V">
                <Select value={cfg.kv_type_v} onChange={(e) => void save({ kv_type_v: e.target.value })}>
                  {KV_TYPES.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Prefix reuse chunk (0 = off)">
                <input className="field" type="number" min={0} defaultValue={cfg.cache_reuse} onBlur={(e) => Number(e.target.value) !== cfg.cache_reuse && void save({ cache_reuse: Number(e.target.value) })} />
              </Field>
            </div>
            <Toggle on={cfg.prompt_cache} onChange={(v) => void save({ prompt_cache: v })} label="Prompt cache (slot save / restore)" />
            <Toggle on={cfg.keep_warm} onChange={(v) => void save({ keep_warm: v })} label="Keep warm (warm-up after every load; never unloads on idle)" />
            <Toggle on={cfg.flash_attn} onChange={(v) => void save({ flash_attn: v })} label="Flash attention" />
            <Toggle on={!cfg.thinking_default} onChange={(v) => void save({ thinking_default: !v })} label="Thinking off unless a request asks for it" />
          </div>
        </details>
      )}

      <div className="space-y-1">
        {(lib?.chat ?? []).map((m) => {
          const f = fitLabel(m.fit);
          return (
            <div key={m.path} className="flex flex-wrap items-center gap-2 rounded-[12px] border border-white/5 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate" title={m.path}>
                {m.name}
                <span className="ml-2 text-xs text-ink-3">{gib(m.sizeMiB)} · {m.root}</span>
              </span>
              <span className={`text-xs ${TONE[f.tone]}`} title={f.title}>
                {f.text}
              </span>
              {cfg?.model_path === m.path ? (
                <span className="text-xs text-amber-soft" title="The engine starts this model for Tony">Tony's model</span>
              ) : (
                <button onClick={() => void save({ model_path: m.path })} className="pill-glass inline-flex items-center gap-1 text-xs" disabled={busy !== null || !m.fit?.fitsEmptyCard} title={!m.fit?.fitsEmptyCard ? "Too big for the card at these settings" : "The engine starts this model for Tony (at boot, after a GPU hand-off, and on Load)"}>
                  Set as Tony's model
                </button>
              )}
              {m.loaded ? (
                <span className="text-xs text-teal">loaded</span>
              ) : (
                <button onClick={() => void load(m)} className="pill-glass inline-flex items-center gap-1 text-xs" disabled={busy !== null || !cfg?.enabled || !m.fit?.fits} title={!cfg?.enabled ? "Turn the engine on first (switches card above)" : !m.fit?.fits ? "Won't fit next to what's on the card now: loading is blocked" : "Swap the engine to this model"}>
                  {busy === `load:${m.path}` ? <Loader2 className="size-3.5 animate-spin" /> : "Load"}
                </button>
              )}
              <button onClick={() => setDel({ path: m.path, typed: "" })} className="pill-glass inline-flex items-center gap-1 text-xs text-ink-3" disabled={busy !== null || m.loaded} title="Move to the Recycle Bin">
                <Trash2 className="size-3.5" />
              </button>
            </div>
          );
        })}
        {lib && lib.chat.length === 0 && <p className="text-sm text-ink-3">No chat models found in the library folders.</p>}
      </div>

      {del && (
        <div className="mt-3 rounded-[12px] border border-alert/40 p-3 text-sm">
          <p>
            Move <b>{del.path.split(/[\\/]/).pop()}</b> to the Recycle Bin? Type the file name to confirm.
          </p>
          <div className="mt-2 flex gap-2">
            <input className="field flex-1" value={del.typed} onChange={(e) => setDel({ ...del, typed: e.target.value })} autoFocus />
            <button className="pill-glass inline-flex items-center gap-1 text-xs text-alert" disabled={!deleteConfirmed(del.path, del.typed) || busy !== null} onClick={confirmDelete}>
              Delete
            </button>
            <button className="pill-glass inline-flex items-center gap-1 text-xs" onClick={() => setDel(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-ink-2">Download from Hugging Face</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Field label="owner/repo or file link">
            <input className="field" placeholder="Qwen/Qwen3-8B-GGUF" value={hf.repo} onChange={(e) => setHf({ ...hf, repo: e.target.value })} />
          </Field>
          <Field label="File (.gguf)">
            <input className="field" placeholder="Qwen3-8B-Q4_K_M.gguf" value={hf.file} onChange={(e) => setHf({ ...hf, file: e.target.value })} />
          </Field>
          <Field label="Into">
            <Select value={hf.dest} onChange={(e) => setHf({ ...hf, dest: e.target.value })}>
              {roots.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          </Field>
        </div>
        <button onClick={startDownload} className="pill-glass inline-flex items-center gap-1 mt-2 text-xs" disabled={busy !== null || !hf.dest}>
          <Download className="size-3.5" /> Download (resumes if interrupted)
        </button>
        {jobs.map((j) => (
          <p key={j.key} className="mt-1 text-xs text-ink-3">
            {j.key}: {progressText(j)}
          </p>
        ))}
      </details>

      {msg && <p className="mt-2 text-xs text-amber">{msg}</p>}
    </Card>
  );
}
