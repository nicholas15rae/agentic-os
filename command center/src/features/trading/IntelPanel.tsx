import { useState } from "react";
import { Download, Loader2, RefreshCw, Search, Target } from "lucide-react";
import { Card, Chip, Input } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { usePoll } from "@/lib/use-poll";
import { intelApi, money, type DiscordHit, type IntelView, type LeaderRow } from "@/features/trading/ibkr";
import { adjustedHit, bandText, splitBoard } from "@/features/trading/track-record";

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

/** One leaderboard row. `muted` = fewer than MIN_SCORED scored calls: greyed, listed but not ranked. */
function LeaderLine({ r, muted = false }: { r: LeaderRow; muted?: boolean }) {
  const adj = adjustedHit(r);
  return (
    <tr className={`border-t border-white/[0.04] ${muted ? "text-ink-3 opacity-60" : ""}`}
      title={muted ? `${r.calls} scored call(s): not enough to rank` : "Adj. hit = lower bound of the 95% Wilson interval for the hit rate"}>
      <td className="truncate px-2.5 py-1.5">{r.name}</td>
      <td className="px-2.5 py-1.5">{r.calls}</td>
      <td className="px-2.5 py-1.5">{pct(r.hitRate)}</td>
      <td className={`px-2.5 py-1.5 ${muted ? "" : adj > 0.55 ? "text-teal-soft" : adj < 0.45 ? "text-alert" : ""}`}>{pct(adj)}</td>
      <td className="whitespace-nowrap px-2.5 py-1.5">{bandText(r)}</td>
      <td className={`px-2.5 py-1.5 ${muted ? "" : r.avgRet > 0 ? "text-teal-soft" : "text-alert"}`}>{r.avgRet.toFixed(2)}%</td>
    </tr>
  );
}
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : "—");

/**
 * Trading intel (isolated trading_rag): Discord calls as External Signal Hypotheses,
 * their scored track record, and the trade journal the agent learns from.
 */
export function IntelPanel() {
  const { data, refresh } = usePoll<IntelView>(intelApi.view, 15_000);
  const toast = useToasts((s) => s.push);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<DiscordHit[] | null>(null);
  const [horizon, setHorizon] = useState(5);
  const [board, setBoard] = useState<IntelView["leaderboards"] | null>(null);
  const [tab, setTab] = useState<"authors" | "channels">("authors");

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast({ title: "Intel", body: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const d = data?.discord;
  const lb = board ?? data?.leaderboards;
  const rows: LeaderRow[] = (tab === "authors" ? lb?.authors : lb?.channels) ?? [];
  const split = splitBoard(rows);
  const j = data?.journal;

  return (
    <Card title="Intel · Discord hypotheses, track record & trade journal">
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="min-w-0" aria-label="Discord">
          <div className="flex flex-wrap items-center gap-2">
            <p className="label-caps text-ink-3">Discord</p>
            <span className="text-[11px] text-ink-3">
              {d ? `${d.messages.toLocaleString()} msgs · ${d.calls.toLocaleString()} calls · ${day(d.from)} → ${day(d.to)}` : "…"}
            </span>
            <div className="ml-auto flex gap-1.5">
              <button className="pill-glass !h-8 text-[11px]" disabled={!!busy} title={d ? `Imports DiscordChatExporter JSON/CSV from ${d.inbox}` : ""} onClick={() => void run("import", async () => {
                const r = await intelApi.importInbox();
                const ok = r.files.filter((f) => !f.error);
                toast({ title: r.files.length ? `Imported ${ok.length}/${r.files.length} file(s)` : "Inbox is empty", body: r.files.length ? r.files.map((f) => (f.error ? `${f.file}: ${f.error}` : `${f.file}: ${f.kept} kept, ${f.calls} calls, ${f.dup} dup`)).join("\n") : `Drop exports in ${d?.inbox}`, tone: r.files.some((f) => f.error) ? "warn" : "info" });
              })}>
                {busy === "import" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Import inbox
              </button>
              <button className="pill-glass !h-8 text-[11px]" disabled={!!busy || !d?.live.token} title={d?.live.token ? "Poll the configured channels now" : "Set DISCORD_BOT_TOKEN and DISCORD_TRADING_CHANNEL_IDS in .env"} onClick={() => void run("poll", async () => void (await intelApi.poll()))}>
                {busy === "poll" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Poll live
              </button>
            </div>
          </div>
          <p className="mt-1 text-[11px] text-ink-3">
            Live: {d?.live.token ? `bot token set · ${d.live.channels.length} channel(s) · every ${d.live.pollSeconds}s` : "not configured (history import works without it)"}
            {d?.liveStatus?.skipped ? ` · ${d.liveStatus.skipped}` : ""}
            {d?.liveStatus?.channels?.some((c) => c.error) ? <span className="text-alert"> · {d.liveStatus.channels.find((c) => c.error)?.error}</span> : null}
          </p>
          {d?.sources.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {d.sources.map((s) => (
                <span key={s.channelId} className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[11px] text-ink-2" title={`${s.guild} · ${s.channelId}`}>
                  #{s.channel || s.channelId} <span className="font-mono text-ink-3">{s.messages}</span>
                </span>
              ))}
            </div>
          ) : null}

          <form className="mt-3 flex gap-1.5" onSubmit={(e) => {
            e.preventDefault();
            void run("search", async () => {
              const tick = q.trim().match(/^\$?([A-Za-z]{1,5})$/)?.[1];
              setHits((await intelApi.search(tick ? "" : q, tick?.toUpperCase())).results);
            });
          }}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search calls: $SPY, CPI, breakout…" aria-label="Search Discord" className="!h-8 !py-1 text-[12px]" />
            <button className="pill-glass !h-8 !px-2.5" aria-label="Search">{busy === "search" ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}</button>
          </form>
          {hits && (
            <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-[12px]">
              {hits.length ? hits.map((h) => (
                <li key={h.key} className="rounded-[10px] border border-white/[0.05] px-2.5 py-1.5">
                  <p className="text-[11px] text-ink-3">
                    #{h.channel} · {h.author} · {new Date(h.ts).toLocaleString()}
                    {h.direction ? <span className={h.direction === "bullish" ? " text-teal-soft" : h.direction === "bearish" ? " text-alert" : ""}> · {h.direction}</span> : null}
                    {h.tickers.length ? <span className="font-mono"> · {h.tickers.join(" ")}</span> : null}
                  </p>
                  <p className="line-clamp-2 text-ink-2">{h.content}</p>
                </li>
              )) : <li className="text-ink-3">No matches.</li>}
            </ul>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <p className="label-caps text-ink-3">Track record</p>
            <Chip active={tab === "authors"} onClick={() => setTab("authors")}>Authors</Chip>
            <Chip active={tab === "channels"} onClick={() => setTab("channels")}>Channels</Chip>
            {[1, 5, 20].map((h) => (
              <Chip key={h} tone="teal" active={horizon === h} onClick={() => void run(`h${h}`, async () => { setHorizon(h); setBoard(await intelApi.leaderboards(h)); })}>{h}d</Chip>
            ))}
            <button className="pill-glass ml-auto !h-7 text-[11px]" disabled={!!busy} title="Score every call whose horizon has played out against real daily closes" onClick={() => void run("score", async () => {
              const r = await intelApi.score();
              toast({ title: "Outcomes scored", body: `${r.scored} call(s) scored (${r.rows} rows)${r.errors.length ? ` · ${r.errors[0]}` : ""}`, tone: "info" });
            })}>
              {busy === "score" ? <Loader2 size={12} className="animate-spin" /> : <Target size={12} />} Score now
            </button>
          </div>
          <div className="mt-2 overflow-x-auto rounded-[12px] border border-white/[0.06]">
            <table className="w-full text-[12px]" aria-label="Track record ranking">
              <thead>
                <tr className="text-left text-ink-3">
                  {[tab === "authors" ? "Author" : "Channel", "n", "Hit", "Adj. hit", "95% band", "Avg ret"].map((h) => <th key={h} className="px-2.5 py-1.5 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody className="font-mono tabular">
                {split.ranked.slice(0, 10).map((r) => <LeaderLine key={r.id} r={r} />)}
                {rows.length && !split.ranked.length ? (
                  <tr className="border-t border-white/[0.04]"><td colSpan={6} className="px-2.5 py-2 text-center font-sans text-[11px] text-ink-3">No {tab === "authors" ? "author" : "channel"} has {split.minScored} scored calls yet, so nothing is ranked.</td></tr>
                ) : null}
                {split.notEnough.length ? (
                  <tr className="border-t border-white/[0.08]"><th colSpan={6} scope="rowgroup" className="px-2.5 pb-0.5 pt-2 text-left font-sans text-[10.5px] font-medium uppercase tracking-wide text-ink-3">Not enough calls yet (under {split.minScored} scored) · not ranked</th></tr>
                ) : null}
                {split.notEnough.slice(0, 10).map((r) => <LeaderLine key={r.id} r={r} muted />)}
                {!rows.length ? <tr><td colSpan={6} className="px-2.5 py-4 text-center text-ink-3">No scored calls yet — import history, then Score now.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[10.5px] text-ink-3">Ranked by adj. hit = lower bound of the 95% Wilson band; a source needs {split.minScored} scored calls to be ranked. n = scored calls at this horizon.</p>
        </section>

        <section className="min-w-0" aria-label="Trade journal">
          <div className="flex items-center gap-2">
            <p className="label-caps text-ink-3">Trade journal</p>
            <span className="text-[11px] text-ink-3">
              {j ? `${j.trades} closed · ${j.wins} wins · ` : ""}
              {j ? <span className={j.pnl >= 0 ? "text-teal-soft" : "text-alert"}>{money(j.pnl)} (instrument ccy)</span> : null}
            </span>
          </div>
          <ul className="mt-2 max-h-[420px] space-y-1.5 overflow-y-auto text-[12px]">
            {j?.recent.length ? j.recent.map((r) => (
              <li key={r.intentId} className="rounded-[12px] border border-white/[0.06] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-[11px] ${r.outcome === "win" ? "text-teal-soft" : r.outcome === "loss" ? "text-alert" : "text-ink-3"}`}>{r.outcome.toUpperCase()}</span>
                  <span className="font-mono">{r.action} {r.units} {r.symbol}</span>
                  <span className="text-[11px] text-ink-3">{r.exitReason.replace("_", " ")} · {r.holdHours.toFixed(1)}h · {r.source}</span>
                  <span className={`ml-auto font-mono ${r.pnl >= 0 ? "text-teal-soft" : "text-alert"}`}>{money(r.pnl)}{r.rMultiple != null ? ` · ${r.rMultiple.toFixed(2)}R` : ""}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-3" title={r.postMortem}>{r.postMortem}</p>
              </li>
            )) : <li className="rounded-[12px] border border-dashed border-white/[0.08] px-3 py-6 text-center text-ink-3">No closed paper trades yet. Each one is journaled here and written back to trading_rag.</li>}
          </ul>
          <p className="mt-3 text-[11px] text-ink-3">
            trading_rag: {data?.rag.active ?? "…"} active · {data?.rag.archived ?? 0} archived
            {data?.rag.byClass ? ` · ${Object.entries(data.rag.byClass).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ")}` : ""}
          </p>
        </section>
      </div>
      <p className="mt-3 text-[11px] text-ink-3">Discord calls are External Signal Hypotheses: context for the agent, scored after the fact — never a trade on their own (the Security Detail rejects hypothesis-only intents).</p>
    </Card>
  );
}
