import { useState } from "react";
import { ChevronDown, FlaskConical, Loader2, Power, RefreshCw, ShieldAlert } from "lucide-react";
import { Card, Input } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { usePoll } from "@/lib/use-poll";
import { engineRApi, tradingApi, type AuditRow, type DeskView } from "@/features/trading/ibkr";
import {
  canApprove,
  isChangeEvaluation,
  isEvaluationReport,
  needsEnableConfirm,
  APPROVE_PHRASE,
  type AnalystView,
  type EngineRBusy,
  type EngineRPanelProps,
  type EngineRPanelState,
  type EvaluationReport,
  type NoEvaluation,
  type RuleChange,
  type RuleScan,
  type RulesView,
  type SetMetrics,
} from "@/features/trading/EngineRPanel.contract";
import { METRIC_ROWS, PARAM_ORDER, VERDICT, compareTone, diffLines, diffText, errorText, logLine, metricText, paramValue, scanRowView, viewErrorText, type Tone } from "@/features/trading/engine-r-format";

const TONE_TEXT: Record<"teal" | "alert" | "amber", string> = { teal: "text-teal-soft", alert: "text-alert", amber: "text-amber-light" };
const CELL_TONE: Record<Exclude<Tone, null>, string> = { better: "text-teal-soft", worse: "text-alert", same: "text-ink-2" };
const when = (s: number) => new Date(s * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const empty = "rounded-[12px] border border-dashed border-white/[0.08] px-3 py-4 text-center text-[12px] text-ink-3";

/** Engine R: the deterministic rule engine. Pending rule changes (typed APPROVE), the 70/30 report, limits, scans, the log. */
export function EngineRPanel(_props: EngineRPanelProps) {
  const { data, error, loading, refresh } = usePoll<RulesView>(engineRApi.view, 15_000);
  const evalPoll = usePoll<EvaluationReport | NoEvaluation>(engineRApi.evaluation, 60_000);
  const desk = usePoll<DeskView>(tradingApi.desk, 15_000);
  const toast = useToasts((s) => s.push);
  const [ui, setUi] = useState<Omit<EngineRPanelState, "status">>({ busy: null, confirm: null, deciding: null, logOpen: false });
  const status: EngineRPanelState["status"] = error && !data ? "error" : loading && !data ? "loading" : "ready";
  const mode = desk.data?.mode ?? null;
  const lim = data?.limits ?? null;

  const act = async (busy: NonNullable<EngineRBusy>, fn: () => Promise<void>) => {
    setUi((u) => ({ ...u, busy, confirm: null }));
    try {
      await fn();
    } catch (e) {
      toast({ title: "Engine R", body: errorText(e, busy.action), tone: "error" });
      if (busy.action === "approve" || busy.action === "reject") setUi((u) => ({ ...u, deciding: null }));
    } finally {
      setUi((u) => ({ ...u, busy: null }));
      refresh();
    }
  };

  const toggle = (on: boolean) =>
    act({ action: "toggle" }, async () => {
      const r = await engineRApi.enable(on);
      toast({ title: `Engine R ${r.enabled ? "ON" : "OFF"}`, body: r.enabled ? `The ${lim?.scan_time_et ?? "15:45"} ET scan runs on weekdays.` : "No scheduled scans until you turn it back on.", tone: "info" });
    });
  const onToggle = () => {
    if (!data) return;
    const on = !data.enabled;
    return needsEnableConfirm(on, mode) ? setUi((u) => ({ ...u, confirm: "enable" })) : void toggle(on);
  };

  const scan = () =>
    act({ action: "scan" }, async () => {
      const r = await engineRApi.dryScan();
      const would = r.rows.filter((x) => x.action === "would_submit").map((x) => x.symbol);
      toast({ title: `Dry-run scan: ${r.status.replace("_", " ")}`, body: r.detail || (would.length ? `Would submit: ${would.join(" ")}` : "No setups. Nothing was sent."), tone: r.status === "blocked" ? "warn" : "info" });
    });

  const evaluate = () =>
    act({ action: "evaluate" }, async () => {
      const r = await engineRApi.evaluate();
      toast({ title: `70/30 report refreshed · v${r.version}`, body: `build ${r.backtest.build.trades} · test ${r.backtest.test.trades} trades`, tone: "info" });
      evalPoll.refresh();
    });

  const approve = (c: RuleChange, phrase: string, note: string) =>
    act({ action: "approve", changeId: c.changeId }, async () => {
      const r = await engineRApi.approve(c.changeId, phrase, note);
      setUi((u) => ({ ...u, deciding: null }));
      toast({ title: `Rule v${r.active.version} active`, body: diffText(c.diff), tone: "info" });
    });

  const reject = (c: RuleChange, note: string) =>
    act({ action: "reject", changeId: c.changeId }, async () => {
      await engineRApi.reject(c.changeId, note);
      setUi((u) => ({ ...u, deciding: null }));
      toast({ title: "Rule change rejected", body: diffText(c.diff), tone: "info" });
    });

  const busyIs = (a: "toggle" | "scan" | "evaluate") => ui.busy?.action === a;
  const ev = evalPoll.data ?? data?.evaluation ?? null;

  return (
    <Card title="Engine R · rules">
      {status === "loading" && <div className="h-5 w-2/3 animate-pulse rounded bg-white/[0.06]" aria-label="Loading Engine R" />}
      {status === "error" && error && <p className="text-[12px] text-alert">{viewErrorText(error)}</p>}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Engine R controls">
            <button
              className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11px] font-semibold ${data.enabled ? "border-teal/50 bg-teal/15 text-teal-soft" : "border-white/15 bg-white/[0.04] text-ink-3"}`}
              disabled={!!ui.busy}
              aria-pressed={data.enabled}
              aria-label={data.enabled ? "Engine R is on: turn off" : "Engine R is off: turn on"}
              onClick={onToggle}
              title="The daily scan. Desk mode decides what its intents become."
            >
              {busyIs("toggle") ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />} {data.enabled ? "ON" : "OFF"}
            </button>
            <button className="pill-glass !h-8 text-[11px]" disabled={!!ui.busy} onClick={() => void scan()} title="Evaluate the active rule now and show what it would do. Sends nothing to the desk.">
              {busyIs("scan") ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />} Dry-run scan
            </button>
            <button className="pill-glass !h-8 text-[11px]" disabled={!!ui.busy} onClick={() => void evaluate()} title="Re-fetch ~3 years of IBKR daily bars (TWS must be up) and rebuild the 70/30 report. Can take minutes.">
              {busyIs("evaluate") ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh 70/30
            </button>
          </div>

          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-3">
            <span>active <span className="font-mono text-ink-2">v{data.active.version}</span> {data.active.rule}</span>
            {lim && <span>scan <span className="text-ink-2">{lim.scan_time_et} ET</span> weekdays</span>}
            <span>entries today <span className="font-mono text-ink-2">{data.entriesToday}{lim ? `/${lim.max_trades_per_day}` : ""}</span></span>
            <span>desk mode <span className="text-ink-2">{mode ?? "…"}</span></span>
          </p>
          {data.blocked && <p className="mt-1.5 text-[12px] text-amber-light">Blocked: {data.blocked}</p>}
          {data.limitsError && <p className="mt-1.5 text-[12px] text-alert">limits.json: {data.limitsError}. Engine R won't scan until it's fixed.</p>}

          {ui.confirm === "enable" && (
            <div className="mt-3 rounded-[14px] border border-amber/50 bg-amber/10 p-3 text-[12px]">
              <p className="text-ink">
                {mode === "FULL_AUTO"
                  ? "The desk is in FULL_AUTO: once on, Engine R's daily scan sends its entries to the paper account without asking. Turn it on?"
                  : "The desk mode is unknown right now. Turn Engine R on anyway?"}
              </p>
              <div className="mt-2 flex gap-2">
                <button className="pill-primary !h-8 text-[11px]" onClick={() => void toggle(true)}>Confirm</button>
                <button className="pill-glass !h-8 text-[11px]" onClick={() => setUi((u) => ({ ...u, confirm: null }))}>Cancel</button>
              </div>
            </div>
          )}

          <section className="mt-4" aria-label="Pending rule changes">
            <p className="label-caps mb-1.5 text-ink-3">Pending rule changes ({data.pending.length})</p>
            {data.pending.length ? (
              <div className="space-y-3">
                {data.pending.map((c) => (
                  <PendingCard
                    key={c.changeId}
                    c={c}
                    activeVersion={data.active.version}
                    busy={ui.busy && "changeId" in ui.busy && ui.busy.changeId === c.changeId ? ui.busy.action : null}
                    locked={!!ui.busy}
                    deciding={ui.deciding?.changeId === c.changeId ? ui.deciding : null}
                    onOpen={() => setUi((u) => ({ ...u, deciding: { changeId: c.changeId, phrase: "", note: "" } }))}
                    onEdit={(patch) => setUi((u) => (u.deciding ? { ...u, deciding: { ...u.deciding, ...patch } } : u))}
                    onCancel={() => setUi((u) => ({ ...u, deciding: null }))}
                    onApprove={(phrase, note) => void approve(c, phrase, note)}
                    onReject={(note) => void reject(c, note)}
                  />
                ))}
              </div>
            ) : (
              <p className={empty}>No pending changes. The analyst files one-parameter suggestions after the close; nothing changes until you approve one.</p>
            )}
          </section>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <section className="min-w-0" aria-label="Active rule">
              <p className="label-caps mb-1.5 text-ink-3">Active rule · v{data.active.version}</p>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                {PARAM_ORDER.map((k) => (
                  <span key={k} className="rounded-full border border-white/[0.08] px-2 py-0.5 text-ink-3" title={data.schema[k]?.help}>
                    {k} <span className="font-mono text-ink-2">{paramValue(data.active.params[k])}</span>
                  </span>
                ))}
              </div>
              <p className="mt-1.5 break-words text-[11px] text-ink-3">
                {when(data.active.created)} · by {data.active.approvedBy} · {data.active.reason}
              </p>
            </section>
            <section className="min-w-0" aria-label="Hard limits">
              <p className="label-caps mb-1.5 text-ink-3">Hard limits · yours only</p>
              {lim ? (
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {(
                    [
                      ["Daily loss", `${lim.max_daily_loss_base.toLocaleString()} → ${lim.on_daily_loss === "kill_switch" ? "kill switch" : "stop entries"}`],
                      ["Trades / day", String(lim.max_trades_per_day)],
                      ["Open positions", String(lim.max_open_positions)],
                      ["Shares / entry", String(lim.max_position_shares)],
                      ["Notional / entry", lim.max_position_notional_base.toLocaleString()],
                      ["Universe", lim.universe.join(" ")],
                    ] as const
                  ).map(([k, v]) => (
                    <span key={k} className="rounded-full border border-white/[0.08] px-2 py-0.5 text-ink-3">
                      {k} <span className="font-mono text-ink-2">{v}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-alert">No valid limits loaded.</p>
              )}
            </section>
          </div>

          <EvaluationSection ev={ev} activeVersion={data.active.version} error={evalPoll.error} />

          <ScanSection scan={data.lastScan} />

          {data.analyst && <AnalystSection a={data.analyst} />}

          <details className="mt-4" open={ui.logOpen} onToggle={(e) => { const open = (e.currentTarget as HTMLDetailsElement).open; setUi((u) => (u.logOpen === open ? u : { ...u, logOpen: open })); }}>
            <summary className="label-caps cursor-pointer text-ink-3">Trade &amp; rule-change log</summary>
            {ui.logOpen && <LogList />}
          </details>
        </>
      )}
    </Card>
  );
}

function PendingCard({
  c,
  activeVersion,
  busy,
  locked,
  deciding,
  onOpen,
  onEdit,
  onCancel,
  onApprove,
  onReject,
}: {
  c: RuleChange;
  activeVersion: number;
  busy: "approve" | "reject" | null;
  locked: boolean;
  deciding: { phrase: string; note: string } | null;
  onOpen: () => void;
  onEdit: (patch: { phrase?: string; note?: string }) => void;
  onCancel: () => void;
  onApprove: (phrase: string, note: string) => void;
  onReject: (note: string) => void;
}) {
  const ev = c.evaluation;
  return (
    <article className="min-w-0 rounded-[14px] border border-amber/30 bg-amber/[0.05] p-3" aria-label={`Rule change ${c.changeId}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {diffLines(c.diff).map((d) => (
          <span key={d.param} className="font-mono text-[12.5px] text-ink">
            {d.param} <span className="text-ink-3">{d.from}</span> → <span className="text-amber-light">{d.to}</span>
          </span>
        ))}
        <span className="ml-auto text-[11px] text-ink-3">
          {c.source} · {when(c.created)} · on v{c.baseVersion}
        </span>
      </div>
      {c.baseVersion !== activeVersion && (
        <p className="mt-1 text-[11px] text-amber-light">Written against v{c.baseVersion}; the active rule is v{activeVersion}. Approving re-checks it and refuses it as stale if the parameter has moved.</p>
      )}

      <div className="mt-2">
        <p className={`flex items-center gap-1 text-[10.5px] uppercase tracking-wide ${c.rationale.untrusted ? "text-amber-light" : "text-ink-3"}`}>
          {c.rationale.untrusted && <ShieldAlert size={11} />} Rationale{c.rationale.untrusted ? " · untrusted model text" : ""}
        </p>
        <p className={`mt-0.5 whitespace-pre-wrap break-words text-[12px] text-ink-2 ${c.rationale.untrusted ? "border-l-2 border-amber/40 pl-2" : ""}`}>{c.rationale.text || "—"}</p>
      </div>

      {isChangeEvaluation(ev) ? (
        <div className="mt-3">
          <p className={`text-[12px] font-semibold ${TONE_TEXT[VERDICT[ev.verdict.label].tone]}`}>{VERDICT[ev.verdict.label].text}</p>
          {ev.verdict.notes.length > 0 && (
            <ul className="mt-0.5 list-disc pl-4 text-[11.5px] text-ink-2">
              {ev.verdict.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <CompareTable title="Build set · oldest ~70%" current={ev.current.build} proposed={ev.proposed.build} />
            <CompareTable title="Test set · newest ~30%, unseen" current={ev.current.test} proposed={ev.proposed.test} />
          </div>
          <p className="mt-1 text-[10.5px] text-ink-3">
            cutoff {ev.cutoff ?? "—"} · {ev.range.from ?? "?"} to {ev.range.to ?? "?"} · same cutoff for both sets
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-amber-light">No backtest for this change: {ev && "error" in ev ? ev.error : "not scored"}</p>
      )}

      {deciding ? (
        <form
          className="mt-3 space-y-2 rounded-[12px] border border-white/[0.08] bg-black/20 p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (canApprove(deciding.phrase)) onApprove(deciding.phrase, deciding.note);
          }}
        >
          <Input value={deciding.note} onChange={(e) => onEdit({ note: e.target.value })} placeholder="Note (optional): why" aria-label="Decision note" maxLength={300} className="!h-8 !w-full !py-1 text-[12px]" />
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={deciding.phrase}
              onChange={(e) => onEdit({ phrase: e.target.value })}
              placeholder={`Type ${APPROVE_PHRASE}`}
              aria-label={`Type ${APPROVE_PHRASE} to confirm`}
              autoComplete="off"
              spellCheck={false}
              className="!h-8 !w-40 !py-1 font-mono text-[12px]"
            />
            <button type="submit" className="pill-primary !h-8 text-[11px]" disabled={!canApprove(deciding.phrase) || locked} aria-label="Approve change">
              {busy === "approve" ? <Loader2 size={12} className="animate-spin" /> : null} Approve
            </button>
            <button type="button" className="pill-glass !h-8 text-[11px]" disabled={locked} onClick={() => onReject(deciding.note)} aria-label="Reject change">
              {busy === "reject" ? <Loader2 size={12} className="animate-spin" /> : null} Reject
            </button>
            <button type="button" className="pill-glass !h-8 text-[11px]" disabled={locked} onClick={onCancel}>
              Cancel
            </button>
          </div>
          <p className="text-[10.5px] text-ink-3">Approving writes a new rule version that Engine R uses from its next scan. Asks for your PIN.</p>
        </form>
      ) : (
        <button className="pill-glass mt-3 !h-8 text-[11px]" disabled={locked} onClick={onOpen} aria-label={`Decide on ${diffText(c.diff)}`}>
          Decide…
        </button>
      )}
    </article>
  );
}

function CompareTable({ title, current, proposed }: { title: string; current: SetMetrics; proposed: SetMetrics }) {
  const notes = [...new Set([current.note && `current: ${current.note}`, proposed.note && `proposed: ${proposed.note}`].filter(Boolean))];
  return (
    <div className="min-w-0 rounded-[10px] border border-white/[0.06] p-2">
      <table className="w-full text-[11.5px]" aria-label={title}>
        <caption className="pb-1 text-left text-[10.5px] uppercase tracking-wide text-ink-3">{title}</caption>
        <thead>
          <tr className="text-left text-ink-3">
            <th className="py-0.5 pr-1 font-medium" scope="col">Metric</th>
            <th className="py-0.5 pr-1 text-right font-medium" scope="col">Current</th>
            <th className="py-0.5 text-right font-medium" scope="col">Proposed</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular">
          {METRIC_ROWS.map((r) => {
            const tone = compareTone(r, current, proposed);
            return (
              <tr key={r.key} className="border-t border-white/[0.04]">
                <th scope="row" className="py-0.5 pr-1 text-left font-sans font-normal text-ink-2">{r.label}</th>
                <td className="py-0.5 pr-1 text-right text-ink-2">{metricText(r.key, current)}</td>
                <td className={`py-0.5 text-right ${tone ? CELL_TONE[tone] : "text-ink-2"}`}>{metricText(r.key, proposed)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {notes.length > 0 && <p className="mt-1 text-[10.5px] text-ink-3">{notes.join(" · ")}</p>}
    </div>
  );
}

function SplitTable({ title, build, test }: { title: string; build: SetMetrics; test: SetMetrics }) {
  return (
    <div className="min-w-0 rounded-[10px] border border-white/[0.06] p-2">
      <table className="w-full text-[11.5px]" aria-label={title}>
        <caption className="pb-1 text-left text-[10.5px] uppercase tracking-wide text-ink-3">{title}</caption>
        <thead>
          <tr className="text-left text-ink-3">
            <th className="py-0.5 pr-1 font-medium" scope="col">Metric</th>
            <th className="py-0.5 pr-1 text-right font-medium" scope="col">Build 70%</th>
            <th className="py-0.5 text-right font-medium" scope="col">Test 30%</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular">
          {METRIC_ROWS.map((r) => (
            <tr key={r.key} className="border-t border-white/[0.04]">
              <th scope="row" className="py-0.5 pr-1 text-left font-sans font-normal text-ink-2">{r.label}</th>
              <td className="py-0.5 pr-1 text-right text-ink-2">{metricText(r.key, build)}</td>
              <td className="py-0.5 text-right text-ink-2">{metricText(r.key, test)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(build.note || test.note) && <p className="mt-1 text-[10.5px] text-ink-3">{[build.note && `build: ${build.note}`, test.note && `test: ${test.note}`].filter(Boolean).join(" · ")}</p>}
    </div>
  );
}

function EvaluationSection({ ev, activeVersion, error }: { ev: EvaluationReport | NoEvaluation | null; activeVersion: number; error: string | null }) {
  return (
    <section className="mt-4" aria-label="70/30 report">
      <p className="label-caps mb-1.5 text-ink-3">70/30 report{isEvaluationReport(ev) ? ` · v${ev.version} · ${when(ev.at)}` : ""}</p>
      {isEvaluationReport(ev) && ev.backtest.symbols.length === 0 && ev.paper.build.trades + ev.paper.test.trades === 0 ? (
        <p className={empty}>No daily bars cached yet, so there is nothing to backtest. Press Refresh 70/30 while TWS is up; the bars are cached after that.</p>
      ) : isEvaluationReport(ev) ? (
        <>
          {ev.version !== activeVersion && <p className="mb-1.5 text-[11px] text-amber-light">This report is for v{ev.version}; the active rule is v{activeVersion}. Refresh 70/30 to score it.</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            <SplitTable title="Backtest · IBKR daily bars" build={ev.backtest.build} test={ev.backtest.test} />
            <SplitTable title="Paper journal · Engine R trades" build={ev.paper.build} test={ev.paper.test} />
          </div>
          <p className="mt-1 break-words text-[10.5px] text-ink-3">
            {[
              `cutoff ${ev.backtest.cutoff ?? "—"}`,
              ev.backtest.range.from && ev.backtest.range.to ? `${ev.backtest.range.from} to ${ev.backtest.range.to}` : "",
              ev.backtest.symbols.join(" "),
              ev.method,
            ].filter(Boolean).join(" · ")}
          </p>
        </>
      ) : (
        <p className={empty}>{ev?.note ?? (error ? `Report unavailable (${error})` : "Loading…")} · Refresh 70/30 needs TWS up the first time; the bars are cached after that.</p>
      )}
    </section>
  );
}

/** Exported for its render test (engine-r-scan.test.ts). */
export function ScanSection({ scan }: { scan: RuleScan | null }) {
  return (
    <section className="mt-4" aria-label="Last scan">
      <p className="label-caps mb-1.5 text-ink-3">Last scan{scan ? ` · ${scan.kind}${scan.submit ? "" : " dry run"} · ${when(scan.at)}` : ""}</p>
      {scan ? (
        <>
          <p className={`text-[12px] ${scan.status === "blocked" ? "text-amber-light" : "text-ink-2"}`}>
            {scan.status.replace("_", " ")}{scan.version != null ? ` · v${scan.version}` : ""}{scan.detail ? ` · ${scan.detail}` : ""}
          </p>
          {scan.rows.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-[11.5px]">
              {scan.rows.map((r) => {
                const v = scanRowView(r); // a desk-refused row says so, in the alert tone, and its order line reads "not sent"
                return (
                  <li key={r.symbol} className="flex min-w-0 flex-wrap gap-x-2">
                    <span className="w-12 font-mono text-ink">{r.symbol}</span>
                    <span className={v.tone}>{v.label}</span>
                    {r.intent && (
                      <span
                        className={`font-mono ${v.refused ? "text-ink-3 line-through" : "text-ink-2"}`}
                        title={v.refused ? "Not sent: the desk refused it" : v.unsure ? "The cancel couldn't be sent: this order may still be working at TWS" : undefined}
                      >
                        BUY {r.intent.quantity} @ {r.intent.limit_price} · stop {r.intent.stop_loss} · tp {r.intent.take_profit}
                      </span>
                    )}
                    {r.why && <span className="min-w-0 break-words text-ink-3">{r.why}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        <p className={empty}>No scan since the bridge started.</p>
      )}
    </section>
  );
}

function AnalystSection({ a }: { a: AnalystView }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <details className="mt-4">
      <summary className="label-caps cursor-pointer text-ink-3">
        After-hours analyst · {a.enabled ? "on" : "off"} · {a.runs.length} recent run{a.runs.length === 1 ? "" : "s"}
      </summary>
      <p className="mt-1.5 text-[11px] text-ink-3">{a.window}{a.blocked ? ` · now: ${a.blocked}` : ""}. It can only file pending suggestions; it never sees the test set.</p>
      {a.runs.length ? (
        <ul className="mt-1.5 space-y-1.5">
          {a.runs.map((r) => (
            <li key={r.runId} className="rounded-[12px] border border-white/[0.06]">
              <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]" onClick={() => setOpen((o) => (o === r.runId ? null : r.runId))} aria-expanded={open === r.runId}>
                <span className="font-mono text-[11px] text-ink-3">{when(r.started)}</span>
                <span className={r.status === "done" ? "text-teal-soft" : r.status === "error" ? "text-alert" : "text-ink-3"}>{r.status}</span>
                <span className="min-w-0 truncate text-ink-3">{r.detail}</span>
                <ChevronDown size={12} className={`ml-auto shrink-0 text-ink-3 transition-transform ${open === r.runId ? "rotate-180" : ""}`} />
              </button>
              {open === r.runId && (
                <div className="space-y-1.5 border-t border-white/[0.04] px-2.5 py-2 text-[12px]">
                  {r.review && (
                    <div>
                      <p className={`text-[10.5px] uppercase tracking-wide ${r.review.untrusted ? "text-amber-light" : "text-ink-3"}`}>Review{r.review.untrusted ? " · untrusted model text" : ""}</p>
                      <p className="whitespace-pre-wrap break-words text-ink-2">{r.review.summary}</p>
                      {r.review.observations.length > 0 && <ul className="list-disc pl-4 text-[11.5px] text-ink-2">{r.review.observations.map((o, i) => <li key={i}>{o}</li>)}</ul>}
                    </div>
                  )}
                  {r.results?.length ? <p className="text-[11.5px] text-ink-2">Filed: {r.results.map((x) => diffText(x.diff)).join(" · ")}</p> : null}
                  {r.suggestions?.errors.length ? <p className="text-[11px] text-alert">Refused: {r.suggestions.errors.join(" · ")}</p> : null}
                  {r.modelS != null && <p className="font-mono text-[10.5px] text-ink-3">model {r.modelS.toFixed(0)} s{r.waitedS ? ` · waited ${r.waitedS.toFixed(0)} s for the GPU` : ""}</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={`mt-1.5 ${empty}`}>No analyst runs yet.</p>
      )}
    </details>
  );
}

/** Mounted only while the log is open, so it polls only then. */
function LogList() {
  const { data, error } = usePoll<{ rows: AuditRow[] }>(() => engineRApi.log(100), 30_000);
  if (error && !data) return <p className="mt-2 text-[12px] text-alert">Log unavailable ({error})</p>;
  if (!data) return <p className="mt-2 text-[12px] text-ink-3">Loading…</p>;
  if (!data.rows.length) return <p className={`mt-2 ${empty}`}>Nothing logged yet.</p>;
  return (
    <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto text-[11.5px]">
      {data.rows.map((row) => {
        const l = logLine(row);
        return (
          <li key={row.id} className="min-w-0 rounded-[8px] border border-white/[0.04] px-2 py-1" title={l.title || undefined}>
            <p className="flex flex-wrap gap-x-2 font-mono text-[10.5px] text-ink-3">
              <span>#{row.id} {when(row.ts)}</span>
              <span className="text-ink-2">{row.kind}</span>
              <span>{row.verdict}</span>
              <span className="min-w-0 break-all">{row.ref} · {row.actor}</span>
            </p>
            {l.text && (
              <p className="break-words text-ink-2">
                {l.untrusted && <span className="mr-1 text-[10px] uppercase text-amber-light">untrusted ·</span>}
                {l.text}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
