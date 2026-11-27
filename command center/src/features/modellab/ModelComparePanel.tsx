import { useCallback, useEffect, useState } from "react";
import { CircleStop, GitCompare, Loader2 } from "lucide-react";
import type { LabModel } from "@/lib/platform";
import { cancelCompare, compareRows, compareStatus, reportVariants, restoreLine, startCompare, VARIANT_LABEL, type CompareStatus, type CompareVariant } from "./compare";

/** Huihui, when Bionic lists it: the candidate the compare was built for. */
const DEFAULT_B = "huihui-qwen3.5-9b-abliterated";

/**
 * Model Lab's A/B compare: "Compare with Tony's model" runs `model_compare` (one maintenance GPU
 * slot for the whole run, Tony's real prompts, Tony's model put back at the end; Tony is never
 * switched), then shows the newest report as a compact A-vs-B table.
 */
export function ModelComparePanel({ models }: { models: LabModel[] | null }) {
  const [status, setStatus] = useState<CompareStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [variant, setVariant] = useState<CompareVariant>("base");
  const [pick, setPick] = useState("");
  const candidates = (models ?? []).filter((m) => !m.tony && !/(^|[^a-z0-9])b?f(16|32)([^a-z0-9]|$)/i.test(`${m.key} ${m.quant}`));
  const b = pick || candidates.find((m) => m.key === DEFAULT_B)?.key || candidates[0]?.key || "";
  const tony = models?.find((m) => m.tony);

  const refresh = useCallback(
    () =>
      compareStatus()
        .then(setStatus)
        .catch((e) => setMsg(String(e))),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const running = !!status?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [running, refresh]);

  const start = async () => {
    setArmed(false);
    try {
      const r = await startCompare(b);
      setMsg(`Comparing ${b} with Tony's model: about ${r.estMinutes} minutes.`);
    } catch (e) {
      setMsg(String(e));
    } finally {
      void refresh();
    }
  };
  const stop = async () => {
    await cancelCompare().catch(() => false);
    setMsg("Stopping after the current case; Tony's model goes back afterwards.");
    void refresh();
  };

  const p = status?.progress;
  const latest = status?.latest ?? null;
  const variants = reportVariants(latest);
  const shown = variants.includes(variant) ? variant : (variants[0] ?? "base");
  const rows = compareRows(latest, shown);
  const restore = restoreLine(latest);
  const A = latest?.summary?.A;
  const B = latest?.summary?.B;

  return (
    <section className="mt-4 border-t border-white/5 pt-3" aria-label="Compare with Tony's model">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink">A/B against Tony's model</span>
        <select
          value={b}
          onChange={(e) => setPick(e.target.value)}
          disabled={running || !candidates.length}
          aria-label="Model to compare"
          className="h-8 max-w-[260px] rounded-lg border border-white/10 bg-transparent px-2 font-mono fs-11 text-ink-2"
        >
          {candidates.map((m) => (
            <option key={m.key} value={m.key}>
              {m.name || m.key} {m.quant}
            </option>
          ))}
        </select>
        {running ? (
          <button onClick={() => void stop()} className="pill-glass !h-8 text-xs">
            <CircleStop size={13} /> Stop
          </button>
        ) : armed ? (
          <>
            <button onClick={() => void start()} className="pill-primary !h-8 text-xs">
              <GitCompare size={13} /> Start (about 10–15 min)
            </button>
            <button onClick={() => setArmed(false)} className="pill-glass !h-8 text-xs">
              Not now
            </button>
          </>
        ) : (
          <button disabled={!b || !tony} onClick={() => setArmed(true)} className="pill-glass !h-8 text-xs">
            <GitCompare size={13} /> Compare with Tony's model
          </button>
        )}
      </div>
      {armed && !running && (
        <p className="mt-1.5 fs-11 text-amber-soft">
          Holds the GPU for the whole run: desktop turns wait, phone turns get “testing a model, right back”, and gateway LLM jobs skip. Loads {tony?.key ?? "Tony's model"} and {b} in the order A, B, B, A at 32k × 2, then puts Tony's model back. Tony is never switched.
        </p>
      )}
      {msg && <p className="mt-1.5 text-xs text-teal">{msg}</p>}
      {running && p && (
        <div className="mt-2" role="status">
          <div className="flex items-center gap-2 fs-11 text-ink-2">
            <Loader2 size={11} className="animate-spin" />
            <span className="truncate">{p.phase}</span>
            <span className="ml-auto font-mono text-ink-3">
              {p.done}/{p.total}
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/5">
            <div className="h-full bg-teal/60 transition-[width] duration-500" style={{ width: `${p.total ? Math.min(100, (p.done / p.total) * 100) : 0}%` }} />
          </div>
        </div>
      )}
      {latest && rows.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex flex-wrap items-center gap-1.5 fs-11 text-ink-3">
            <span className="font-mono">{latest.runId}</span>
            {latest.wallMs ? <span>· {Math.round(latest.wallMs / 60000)} min</span> : null}
            {variants.map((v) => (
              <button key={v} onClick={() => setVariant(v)} aria-pressed={shown === v} className={`rounded-full border px-2 py-0.5 ${shown === v ? "border-teal/50 text-teal" : "border-white/10 text-ink-3"}`}>
                {VARIANT_LABEL[v]}
              </button>
            ))}
          </div>
          {restore && <p className={`mb-1.5 fs-11 ${restore.ok ? "text-ink-3" : "text-alert"}`}>{restore.text}</p>}
          {latest.plan?.warnings?.map((w) => (
            <p key={w} className="mb-1 fs-11 text-amber-soft">
              {w}
            </p>
          ))}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead className="label-caps text-ink-3">
                <tr>
                  <th className="py-1 font-normal">Metric</th>
                  <th className="font-normal">A · {A?.model ?? "—"}</th>
                  <th className="font-normal">B · {B?.model ?? "—"}</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((r) => (
                  <tr key={r.label} className="border-t border-white/5">
                    <td className="py-1 font-sans text-ink-2">{r.label}</td>
                    <td className={r.badA ? "text-alert" : r.better === "a" ? "text-teal" : "text-ink-2"}>{r.a}</td>
                    <td className={r.badB ? "text-alert" : r.better === "b" ? "text-teal" : "text-ink-2"}>{r.b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {status?.dir && <p className="mt-1 font-mono fs-10 text-ink-3">Full report: {status.dir}\{latest.runId}.json</p>}
        </div>
      )}
    </section>
  );
}
