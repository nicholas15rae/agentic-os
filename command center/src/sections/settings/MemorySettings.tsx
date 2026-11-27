import { useEffect, useState } from "react";
import { Archive, CloudOff, CloudUpload, Download, Eraser, HardDrive, Loader2, Lock, LockOpen, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { Card, Field, Input, Select } from "@/components/ui";
import { cmd, onNativeEvent, type CompactOutcome, type CompactionStatus, type HarvestPeriodName, type HygieneStatus, type IdleBadge, type LedgerEntry, type LifecycleCadence, type MemoryScrollsConfig } from "@/lib/platform";
import { gated } from "@/features/bridge/gate";
import { CfgError, SecretRow, Toggle, useOsCfg } from "./os-ui";
import { archiveSourceLabel, canCompact, clampInt, effectiveScrollsDir, formatBytes, formatOutcome, formatPending, outcomeTone, SCROLLS_BOUNDS } from "./memory-scrolls-format";
import { VAULT_PASSWORD_ROW_ID, VaultPasswordBanner } from "./VaultPasswordBanner";
import { badgeTone, cadenceLabel, cadencePeriod, presetOf, pressureFill, pressureLabel, pressureTone, relTime, SCROLLS_PRESETS, WEEKDAYS } from "./hygiene-format";

/**
 * "Hygiene & Buffer Pressure": the Security/Garbage daemon, the Memory Scrolls buffer against
 * its threshold (Green / Amber / Red at the 2× high-water mark), the last sweep, the next
 * scheduled harvest, and a one-click Quick Hygiene Sweep. Cheap: no CLI call on the poll.
 */
function HygieneBar() {
  const [st, setSt] = useState<HygieneStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void cmd("hygiene_status").then((s) => alive && setSt(s)).catch(() => {});
    load();
    const t = window.setInterval(load, 15_000);
    let off: (() => void) | undefined;
    void onNativeEvent<HygieneStatus>("hygiene-status", (s) => setSt(s)).then((u) => (off = u));
    return () => {
      alive = false;
      window.clearInterval(t);
      off?.();
    };
  }, []);
  const sweep = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await cmd("hygiene_sweep");
      setSt(r.status);
      const g = r.garbage ?? {};
      setNote(`Swept: ${g.scratchPurged ?? 0} scratch · ${g.dumpsPurged ?? 0} dumps · ${g.archivesCompressed ?? 0} archives compressed · compaction ${r.compaction}`);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };
  const next = st?.autoRun ? (st.catchUpQueued ? `catch-up queued${st.waiting ? ` (waiting: ${st.waiting})` : ""}` : relTime(st.nextHarvestAt)) : "auto-regulate off";
  return (
    <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="label-caps flex items-center gap-1.5 text-ink-2">
          <ShieldCheck size={13} className={st?.daemonRunning ? "text-teal" : "text-ink-3"} /> Hygiene & buffer pressure
        </span>
        <span className="text-ink-3">
          Daemon <span className={st?.daemonRunning ? "text-teal" : "text-alert"}>{st ? (st.daemonRunning ? "running" : "stopped") : "—"}</span>
        </span>
        <span className="text-ink-3">
          Last sweep <span className="text-ink-2">{relTime(st?.lastSweepAt)}</span>
        </span>
        <span className="text-ink-3">
          Next harvest <span className="text-ink-2">{st?.harvesting ? "running now…" : next}</span>
        </span>
        <button onClick={() => void sweep()} disabled={busy} className="ml-auto flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[11px] text-ink-2 hover:text-ink">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Eraser size={12} />} Quick Hygiene Sweep
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10" role="meter" aria-label="Memory buffer pressure" aria-valuemin={0} aria-valuemax={200} aria-valuenow={Math.round((st?.pressureRatio ?? 0) * 100)}>
          <div className={`h-full rounded-full transition-[width] duration-500 ${pressureTone(st?.pressure)}`} style={{ width: `${pressureFill(st?.pressureRatio)}%` }} />
        </div>
        <span className="shrink-0 text-[11px] text-ink-3">
          {pressureLabel(st?.pressure)}
          {st?.pendingBytes != null && ` · ${formatBytes(st.pendingBytes)} / ${st.thresholdKb} KB · ${st.pendingTurns ?? 0} / ${st.thresholdTurns} turns`}
        </span>
      </div>
      {st?.lastRun && (
        <p className={`mt-1.5 text-[11px] ${st.lastRun.ok ? "text-ink-3" : "text-alert"}`}>
          Last lifecycle run {relTime(st.lastRun.at)} · {st.lastRun.period}
          {st.lastRun.catchUp ? " (catch-up)" : ""} · {st.lastRun.detail}
        </p>
      )}
      {note && <p className="mt-1.5 text-[11px] text-ink-2">{note}</p>}
    </div>
  );
}

const PERIODS: { id: "month" | HarvestPeriodName; label: string }[] = [
  { id: "month", label: "A month…" },
  { id: "previous_day", label: "Previous day" },
  { id: "previous_week", label: "Previous week" },
  { id: "previous_month", label: "Previous month" },
  { id: "since_last_harvest", label: "Since last verified harvest" },
];

const month = () => new Date().toISOString().slice(0, 7);

/**
 * RAG memory lifecycle: Harvest → Condense → Fine-tune dataset → Locked vault,
 * cloud cache flush, and a ledger of Memory Books you can mount into RAG and
 * unmount again.
 */
export function MemoryLifecycleCard({ passwordBanner = true }: { passwordBanner?: boolean } = {}) {
  const { cfg, error, save } = useOsCfg();
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [target, setTarget] = useState(month());
  const [period, setPeriod] = useState<"month" | HarvestPeriodName>("month");
  const [includeLocal, setIncludeLocal] = useState(false);

  const refresh = () => void cmd("memory_ledger").then(setLedger).catch(() => setLedger([]));
  useEffect(() => {
    refresh();
    let off: (() => void) | undefined;
    void onNativeEvent<{ step: string; detail: string }>("memory-progress", (p) => setProgress(`${p.step} · ${p.detail}`)).then((u) => (off = u));
    return () => off?.();
  }, []);
  if (!cfg) return null;
  const m = cfg.memory;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setMsg({ tone: "err", text: String(e) });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const harvest = () =>
    run("harvest", async () => {
      const l = await cmd("memory_harvest", { req: period === "month" ? { month: target } : { period } });
      setMsg({ tone: "ok", text: `Memory Book ${l.month}: ${l.records} records → ${l.pairs} training pairs · sha256 ${l.sha256.slice(0, 12)}… ${l.encrypted ? "· AES-256 locked" : "· NOT encrypted (set a vault password)"}` });
    });

  const flush = (mo: string) =>
    run(`flush-${mo}`, async () => {
      const r = await gated(
        { action: "memory-flush", summary: `Flush cloud / droplet RAG cache for ${mo}`, detail: { month: mo, includeLocal } },
        (approved) => cmd("memory_flush", { req: { month: mo, includeLocal, approved } }),
        (x) => x.join(" · "),
      );
      if (r) setMsg({ tone: "ok", text: r.join(" · ") });
    });

  const mount = (mo: string, t: "local" | "droplet", on: boolean) =>
    run(`mount-${mo}-${t}`, async () => {
      if (on) {
        await gated(
          { action: "memory-mount", summary: `Reload the ${mo} Memory Book into ${t === "droplet" ? "the droplet" : "local"} RAG`, detail: { month: mo, target: t } },
          (approved) => cmd("memory_mount", { req: { month: mo, target: t, approved } }),
          () => "Mounted.",
        );
      } else await cmd("memory_unmount", { req: { month: mo, target: t } });
    });

  return (
    <Card
      title="RAG memory & vault lifecycle"
      hint="Harvest pulls every agent's conversations + training logs (and droplet cache), checksums them, condenses a Memory Book, builds a de-duplicated fine-tuning dataset, and locks it all in your local vault. Then the cloud copy can be wiped and selected books re-mounted whenever you need them."
    >
      {passwordBanner && <VaultPasswordBanner />}
      <HygieneBar />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="RAG storage">
          <Select value={m.storage} onChange={(e) => save({ memory: { storage: e.target.value as typeof m.storage } })}>
            <option value="local">Local storage</option>
            <option value="droplet">Droplet vector DB / remote AnythingLLM</option>
            <option value="hybrid">Hybrid sync</option>
          </Select>
        </Field>
        <Field label="Dataset format">
          <Select value={m.datasetFormat} onChange={(e) => save({ memory: { datasetFormat: e.target.value as typeof m.datasetFormat } })}>
            <option value="chatml">ChatML (messages)</option>
            <option value="sharegpt">ShareGPT</option>
            <option value="alpaca">Alpaca</option>
          </Select>
        </Field>
        <Field label="Mount Memory Books into workspace">
          <Input key={m.mountWorkspace} defaultValue={m.mountWorkspace} onBlur={(e) => e.target.value.trim() !== m.mountWorkspace && save({ memory: { mountWorkspace: e.target.value.trim() } })} className="font-mono !text-[12px]" />
        </Field>
        <Field label="Locked vault folder" className="sm:col-span-2">
          <Input key={m.vaultDir} defaultValue={m.vaultDir} onBlur={(e) => e.target.value.trim() !== m.vaultDir && save({ memory: { vaultDir: e.target.value.trim() } })} className="font-mono !text-[12px]" spellCheck={false} />
        </Field>
        <Field label="Droplet cache collections (Qdrant)">
          <Input
            key={m.cacheCollections.join(",")}
            defaultValue={m.cacheCollections.join(", ")}
            onBlur={(e) => save({ memory: { cacheCollections: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })}
            placeholder="tony-cache, chat-logs"
            className="font-mono !text-[12px]"
          />
        </Field>
      </div>
      <div id={VAULT_PASSWORD_ROW_ID} className="scroll-mt-24">
        <SecretRow
          name="vault"
          label="Vault password (AES-256-GCM)"
          placeholder="10+ characters"
          hint="Stored in the Windows Credential Manager. Without it archives are written unencrypted. Lose it and locked archives can't be opened (there is no recovery key): write it down or keep it in your password manager."
        />
      </div>
      <div className="mt-1">
        <Toggle
          on={m.autoRunEnabled}
          onChange={(v) => save({ memory: { autoRunEnabled: v } })}
          label="Auto-regulate Vault & Lifecycle"
          hint={`${cadenceLabel(m.cadence, m.targetHour, m.weeklyDay)}: harvests ${cadencePeriod(m.cadence)} on the next idle window (never during start-up warm-up or while you talk to ${cfg.osName}). A missed slot runs once as a catch-up covering everything since the last verified harvest. Turning this on is your standing consent.`}
        />
        <div className={`grid gap-3 pl-12 sm:grid-cols-3 ${m.autoRunEnabled ? "" : "opacity-50"}`}>
          <Field label="Cadence">
            <Select value={m.cadence} disabled={!m.autoRunEnabled} onChange={(e) => save({ memory: { cadence: e.target.value as LifecycleCadence } })}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
          </Field>
          <Field label="Target hour">
            <Select value={String(m.targetHour)} disabled={!m.autoRunEnabled} onChange={(e) => save({ memory: { targetHour: Number(e.target.value) } })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </Select>
          </Field>
          {m.cadence === "weekly" && (
            <Field label="Quiet window day">
              <Select value={String(m.weeklyDay)} disabled={!m.autoRunEnabled} onChange={(e) => save({ memory: { weeklyDay: Number(e.target.value) } })}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <p className="pl-12 text-[11px] text-ink-3">Last verified harvest: {m.lastVerifiedHarvestAt ? new Date(m.lastVerifiedHarvestAt * 1000).toLocaleString() : "never"}</p>
        <Toggle on={m.autoFlush} onChange={(v) => save({ memory: { autoFlush: v } })} label="Auto-flush cloud after a verified local backup" hint="Runs only after every vault file passed its SHA-256 re-read; any failed write or checksum aborts it." disabled={!m.autoRunEnabled} />
        <Toggle
          on={m.pruneThreads}
          onChange={(v) => save({ memory: { pruneThreads: v } })}
          label={`Prune ${cfg.osName}'s local AnythingLLM threads after a verified harvest`}
          hint="Only threads the OS created and recorded. The next turn opens a fresh thread seeded with the newest memory summary."
          disabled={!m.autoRunEnabled}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} className="!h-10 !w-52" aria-label="Period to harvest">
          {PERIODS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
        {period === "month" && <Input type="month" value={target} onChange={(e) => setTarget(e.target.value)} className="!h-10 !w-40 font-mono" aria-label="Month to harvest" />}
        <button onClick={() => void harvest()} disabled={!!busy} className="pill-primary !h-10 text-sm">
          {busy === "harvest" ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} Harvest & condense memory now
        </button>
        <label className="flex items-center gap-1.5 text-xs text-ink-3">
          <input type="checkbox" checked={includeLocal} onChange={(e) => setIncludeLocal(e.target.checked)} className="accent-alert" /> flush also clears {cfg.osName}'s local AnythingLLM threads
        </label>
      </div>
      {progress && <p className="mt-2 font-mono text-[11px] text-amber-soft">{progress}</p>}
      {msg && <p className={`mt-2 text-xs ${msg.tone === "ok" ? "text-teal" : "text-alert"}`}>{msg.text}</p>}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="label-caps text-ink-3">
            <tr>
              <th className="py-1.5 font-normal">Memory Book</th>
              <th className="font-normal">Tokens</th>
              <th className="font-normal">Agents</th>
              <th className="font-normal">Status</th>
              <th className="text-right font-normal">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(ledger ?? []).map((l) => {
              const local = l.mounts.some((x) => x.target === "local");
              const remote = l.mounts.some((x) => x.target === "droplet");
              return (
                <tr key={l.id} className="border-t border-white/5 align-top">
                  <td className="py-2">
                    <span className="font-mono text-ink">{l.month}</span>
                    <span className="ml-1.5 inline-flex items-center gap-1 text-ink-3">
                      {l.encrypted ? <Lock size={11} className="text-teal" /> : <LockOpen size={11} className="text-amber-soft" />}
                      {l.records} rec · {l.pairs} pairs
                    </span>
                    {l.topics.length > 0 && <span className="block text-ink-3">{l.topics.slice(0, 4).join(" · ")}</span>}
                  </td>
                  <td className="py-2 font-mono text-ink-2">{l.summaryTokens.toLocaleString()}</td>
                  <td className="py-2 text-ink-2">{l.agents.join(", ") || "—"}</td>
                  <td className="py-2">
                    <span className={remote ? "text-volt" : local ? "text-teal" : "text-ink-2"}>{remote ? "Mounted in cloud RAG" : local ? "Mounted locally" : "Local only"}</span>
                    {l.flushedAt && <span className="block text-ink-3">cloud flushed {new Date(l.flushedAt * 1000).toLocaleDateString()}</span>}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <SmallBtn busy={busy === `mount-${l.month}-local`} onClick={() => void mount(l.month, "local", !local)} title={local ? "Remove from local RAG" : "Load into local AnythingLLM"}>
                        <HardDrive size={11} /> {local ? "Unmount" : "Local RAG"}
                      </SmallBtn>
                      <SmallBtn busy={busy === `mount-${l.month}-droplet`} onClick={() => void mount(l.month, "droplet", !remote)} title={remote ? "Unmount & wipe from cloud" : "Reload to cloud / RAG"}>
                        {remote ? <CloudOff size={11} /> : <CloudUpload size={11} />} {remote ? "Unmount cloud" : "Cloud RAG"}
                      </SmallBtn>
                      <SmallBtn busy={busy === `flush-${l.month}`} onClick={() => void flush(l.month)} title="Flush cloud / droplet RAG cache (after checksum re-verify)" danger>
                        <Trash2 size={11} /> Flush
                      </SmallBtn>
                      {(["summary", "dataset"] as const).map((k) => (
                        <SmallBtn
                          key={k}
                          onClick={() =>
                            void cmd("memory_export", { month: l.month, kind: k })
                              .then((p) => setMsg({ tone: "ok", text: `Unlocked copy: ${p}` }))
                              .catch((e) => setMsg({ tone: "err", text: String(e) }))
                          }
                          title={`Decrypt the ${k} to <vault>/${l.month}/unlocked/`}
                        >
                          <Download size={11} /> {k === "summary" ? "Book" : ".jsonl"}
                        </SmallBtn>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
            {ledger && !ledger.length && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-ink-3">
                  No Memory Books yet — run your first harvest.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <CfgError error={error} />
    </Card>
  );
}

function SmallBtn({ children, onClick, title, busy, danger }: { children: React.ReactNode; onClick: () => void; title: string; busy?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} title={title} disabled={busy} className={`flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] text-ink-2 hover:text-ink ${danger ? "border-alert/30 hover:border-alert/60" : "border-white/10"}`}>
      {busy ? <Loader2 size={11} className="animate-spin" /> : children}
    </button>
  );
}

const SCROLLS_DEFAULTS: MemoryScrollsConfig = { scrollsDir: "", archiveDir: "", workspace: "librarian", embedOnly: false, autoCompact: false, thresholdKb: 50, thresholdTurns: 25, quietMins: 10, checkSecs: 300, maxBatchesAuto: 1 };

/**
 * Phase 3 tiered memory: Tier-1 history is archived losslessly to the cold archive, then
 * distilled into a few living Memory Scrolls (the only layer embedded in RAG). The button runs
 * the host `memory_scrolls compact` now; a busy system (voice, a build, the GPU) defers it.
 */
export function MemoryScrollsCard() {
  const { cfg, error, save } = useOsCfg();
  const [status, setStatus] = useState<CompactionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<CompactOutcome | null>(null);
  const [idle, setIdle] = useState<IdleBadge | null>(null);
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const refresh = () =>
    void cmd("memory_compaction_status")
      .then((s) => {
        setStatus(s);
        if (s.badge) setIdle(s.badge);
      })
      .catch(() => setStatus(null));
  useEffect(() => {
    refresh();
    let alive = true;
    // The badge is cheap (no CLI): poll it so the quiet-window countdown stays live.
    const poll = () => void cmd("memory_idle_state").then((b) => alive && setIdle(b)).catch(() => {});
    poll();
    const t = window.setInterval(poll, 3_000);
    let off: (() => void) | undefined;
    void onNativeEvent<CompactOutcome>("memory-compaction", (o) => {
      setLast(o);
      refresh();
    }).then((u) => (off = u));
    return () => {
      alive = false;
      window.clearInterval(t);
      off?.();
    };
  }, []);
  if (!cfg) return null;
  const sc: MemoryScrollsConfig = { ...SCROLLS_DEFAULTS, ...cfg.memory.scrolls };
  const set = (p: Partial<MemoryScrollsConfig>) => save({ memory: { scrolls: { ...sc, ...p } } });

  const compact = async () => {
    setBusy(true);
    try {
      setLast(await cmd("memory_compact"));
    } catch (e) {
      setLast({ error: String(e), manual: true, at: Date.now() });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const purge = async () => {
    setPurging(true);
    setPurgeMsg(null);
    try {
      const r = await gated(
        { action: "memory-purge-raw", summary: "Purge raw task-note vectors from the Librarian workspace and re-sync Memory Scrolls", detail: { workspace: sc.workspace } },
        (approved) => cmd("memory_purge_raw_vectors", { approved }),
        (x) => `${x.rawNotesRemoved} raw notes removed`,
      );
      if (r) setPurgeMsg({ tone: "ok", text: `${r.compaction} · ${r.rawNotesRemoved} raw note vector(s) removed · ${r.scrollDuplicatesRemoved} duplicate scroll embedding(s) removed · ${r.scrollsKept} scroll(s) kept · Embed scrolls only on` });
    } catch (e) {
      setPurgeMsg({ tone: "err", text: String(e) });
    } finally {
      setPurging(false);
      refresh();
    }
  };

  const activePreset = presetOf(sc.thresholdKb, sc.thresholdTurns);
  const st = status?.status ?? null;
  const shown = last ?? status?.lastResult ?? null;
  const num = (k: keyof typeof SCROLLS_BOUNDS, label: string, unit: string) => (
    <Field label={label}>
      <Input
        key={`${k}-${sc[k]}`}
        type="number"
        min={SCROLLS_BOUNDS[k][0]}
        max={SCROLLS_BOUNDS[k][1]}
        defaultValue={sc[k]}
        onBlur={(e) => {
          const v = clampInt(e.target.value, SCROLLS_BOUNDS[k][0], SCROLLS_BOUNDS[k][1], sc[k]);
          if (v !== sc[k]) set({ [k]: v });
        }}
        className="font-mono !text-[12px]"
        aria-label={`${label} (${unit})`}
      />
    </Field>
  );

  return (
    <Card
      title="Memory Scrolls"
      hint="Raw chats, build logs and task history are archived losslessly to the cold archive (never indexed), then condensed into a few living Memory Scrolls: the only memory embedded in RAG and read first by the Librarian."
    >
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void compact()} disabled={!canCompact({ busy, status })} className="pill-primary !h-10 text-sm">
          {busy || status?.running ? <Loader2 size={15} className="animate-spin" /> : <Archive size={15} />} Compact & Sync Memory
        </button>
        {status && <span className="text-xs text-ink-3">{formatPending(status)}</span>}
      </div>
      {status?.idleReason && !busy && <p className="mt-1.5 text-[11px] text-amber-soft">Would wait right now: {status.idleReason}</p>}
      {shown && <p className={`mt-2 text-xs ${{ error: "text-alert", warn: "text-amber-soft", ok: "text-teal" }[outcomeTone(shown)]}`}>{formatOutcome(shown)}</p>}

      <div className="mt-3">
        <Toggle
          on={sc.autoCompact}
          onChange={(v) => set({ autoCompact: v })}
          label={
            <span className="inline-flex flex-wrap items-center gap-2">
              Auto-compact when idle
              {idle && (
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${badgeTone(idle)}`} aria-live="polite">
                  {idle.label}
                </span>
              )}
              {status?.highWater && <span className="rounded-full border border-alert/40 px-2 py-0.5 text-[10px] text-alert">High-water: compacting between turns</span>}
            </span>
          }
          hint="Only after the pending buffer passes a threshold AND nothing is running: no voice turn or TTS, no LLM generation, no build, no Claude Code fix, and the quiet window over. An armed wake-word mic counts as idle. At 2× the threshold it compacts between turns. Off by default."
        />
        <Toggle
          on={sc.embedOnly}
          onChange={(v) => set({ embedOnly: v })}
          label="Embed scrolls only"
          hint="Stop embedding each task note into the Librarian workspace (notes stay on disk and are distilled into scrolls instead). Turn on after the first RAG offload."
        />
        <div className="mt-1 flex flex-wrap items-center gap-2 pl-12">
          <button onClick={() => void purge()} disabled={purging} className="flex h-8 items-center gap-1.5 rounded-full border border-alert/30 px-3 text-[11px] text-ink-2 hover:border-alert/60 hover:text-ink">
            {purging ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Purge Raw Vectors & Re-sync Scrolls
          </button>
          <span className="text-[11px] text-ink-3">Distills pending notes, removes raw “Idea:” task-note vectors, dedupes scroll embeddings by content hash.</span>
        </div>
        {purgeMsg && <p className={`mt-1 pl-12 text-xs ${purgeMsg.tone === "ok" ? "text-teal" : "text-alert"}`}>{purgeMsg.text}</p>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="label-caps text-ink-3">Threshold preset</span>
        {SCROLLS_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => set({ thresholdKb: p.kb, thresholdTurns: p.turns })}
            aria-pressed={activePreset === p.id}
            className={`flex h-7 items-center rounded-full border px-3 text-[11px] ${activePreset === p.id ? "border-teal/50 text-teal" : "border-white/10 text-ink-2 hover:text-ink"}`}
            title={`${p.kb} KB / ${p.turns} turns`}
          >
            {p.label} · {p.kb} KB / {p.turns}
          </button>
        ))}
        {!activePreset && <span className="text-[11px] text-ink-3">Custom</span>}
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        {num("thresholdKb", "Threshold (KB)", "kilobytes")}
        {num("thresholdTurns", "Threshold (turns)", "turns")}
        {num("quietMins", "Quiet window (min)", "minutes")}
      </div>

      <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
        <dt className="text-ink-3">Scrolls</dt>
        <dd className="break-all font-mono text-ink-2">{st?.scrolls_root ?? effectiveScrollsDir(sc.scrollsDir)}</dd>
        <dt className="text-ink-3">Cold archive</dt>
        <dd className="break-all font-mono text-ink-2">
          {st ? (
            <>
              {st.archive_root} <span className="font-sans text-ink-3">({archiveSourceLabel(st.pinned ? "pinned" : st.archive_root_source)})</span>
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-ink-3">RAG workspace</dt>
        <dd className="font-mono text-ink-2">
          {status?.workspace ?? sc.workspace}
          {st && st.unsynced.length > 0 && <span className="ml-2 font-sans text-amber-soft">{st.unsynced.length} unsynced</span>}
        </dd>
        {st && (
          <>
            <dt className="text-ink-3">LM Studio</dt>
            <dd className="text-ink-2">{st.lm.loaded_model ?? "no model loaded (compaction defers; it never loads one)"}</dd>
          </>
        )}
      </dl>

      {st && st.scrolls.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-xs">
          {st.scrolls.map((x) => (
            <li key={x.rel} className="flex justify-between gap-3 border-t border-white/5 py-1">
              <span className={`font-mono ${x.valid ? "text-ink" : "text-alert"}`}>{x.rel}</span>
              <span className="text-ink-3">
                {x.version != null ? `v${x.version} · ` : "invalid · "}
                {formatBytes(x.bytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {st && st.scrolls.length === 0 && <p className="mt-3 text-xs text-ink-3">No Memory Scrolls yet: the first compaction creates them.</p>}
      <CfgError error={error} />
    </Card>
  );
}
