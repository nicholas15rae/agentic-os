import { useEffect, useRef } from "react";
import { Brain, Cpu, Database, HardDrive, Lock, Plug, ShieldCheck, Sparkles, X } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { isTauri } from "@/lib/platform";
import { useMemmapData } from "@/features/memmap/use-memmap-data";
import { fmtMs } from "@/features/arbiter/agent-graph";
import { inspectAgent, isVault, useSysMap, type AgentInspect, type InspectFocus } from "./sysmap-store";
import { agentFor, BOUNDARY, BUSES, hookupsFor, isRoster, modelName, NODE_BUS, NODE_LABEL, skillsFor, surfaceState, SURFACE_TONE } from "./model";

/** Refresh while the drawer is open and the window visible (usePoll skips hidden ticks). */
const POLL_MS = 3000;

const ago = (t: number | null | undefined, now = Date.now()) => {
  if (!t) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

function Section({ id, icon: Icon, title, focus, children }: { id: InspectFocus; icon: typeof Brain; title: string; focus: InspectFocus; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus === id) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focus, id]);
  return (
    <section ref={ref} className={`rounded-[12px] border p-3 ${focus === id ? "border-holo/40 bg-holo/[0.04]" : "border-white/[0.07] bg-white/[0.02]"}`}>
      <h3 className="label-caps mb-2 flex items-center gap-1.5 text-holo">
        <Icon size={12} aria-hidden /> {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) {
  return (
    <div className="flex justify-between gap-3 text-[11.5px]">
      <dt className="text-ink-3">{k}</dt>
      <dd className="text-right font-mono text-ink-2" style={tone ? { color: tone } : undefined}>
        {v}
      </dd>
    </div>
  );
}

/**
 * The Deep Inspector: a slide-over drawer shared by the Schematic Flowchart and the Orbital
 * Ecosystem. Everything is live — `agent_inspect` (state, memtier namespace detail, lifecycle,
 * contracts, recent hand-offs) and the System Map snapshot (model, skills, MCP status). A source
 * that is missing reads "—"; nothing is invented.
 */
export function DeepInspector() {
  const id = useSysMap((s) => s.inspect);
  const focus = useSysMap((s) => s.focus);
  const close = useSysMap((s) => s.close);
  const { snap } = useMemmapData();
  const poll = usePoll<AgentInspect | null>(() => (id && isTauri() ? inspectAgent(id) : Promise.resolve(null)), POLL_MS, [id]);
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, close]);
  if (!id || !isRoster(id)) return null;
  const d = poll.data && poll.data.node.id === id ? poll.data : null;
  const bus = BUSES[NODE_BUS[id]];
  const surface = surfaceState(d?.live ?? undefined);
  const agent = agentFor(id, snap?.agents);
  const skills = skillsFor(id, snap?.skills.items);
  const hooks = hookupsFor(id, snap?.bus);
  const mem = d?.memory ?? null;
  const now = Date.now();
  const memFeed = (d?.feed ?? []).filter((f) => f.kind === "memory_read" || f.kind === "memory_write");
  const handoffs = (d?.feed ?? []).filter((f) => f.kind !== "memory_read" && f.kind !== "memory_write");

  return (
    <aside
      role="dialog"
      aria-label={`Deep inspector: ${NODE_LABEL[id]}`}
      className="sysmap-drawer absolute inset-y-0 right-0 z-30 flex w-[min(420px,100%)] flex-col border-l border-holo/25 bg-[rgba(4,7,12,0.94)] shadow-[-20px_0_60px_rgba(0,0,0,0.55)]"
    >
      <header className="flex items-start gap-3 border-b border-white/[0.07] p-4" style={{ boxShadow: `inset 3px 0 0 ${bus.color}` }}>
        <div className="min-w-0 flex-1">
          <p className="label-caps" style={{ color: bus.color }}>
            {bus.label} bus
          </p>
          <h2 className="truncate text-lg font-semibold text-ink">{d?.node.label ?? NODE_LABEL[id]}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="label-caps rounded-full border px-2 py-0.5" style={{ color: SURFACE_TONE[surface], borderColor: `${SURFACE_TONE[surface]}66` }}>
              {surface}
            </span>
            <span className="flex items-center gap-1 font-mono text-ink-3">
              <Cpu size={11} aria-hidden /> {d?.node.compute.toUpperCase() ?? "—"}
            </span>
            <span className="truncate font-mono text-ink-2" title="Model assignment (AnythingLLM workspace)">
              {modelName(agent) ?? (d?.node.compute === "cpu" ? "deterministic (no model)" : "model —")}
            </span>
            {d?.holder === id && <span className="label-caps text-teal">holds GPU token</span>}
          </div>
        </div>
        <button type="button" onClick={close} className="grid size-8 shrink-0 place-items-center rounded-full border border-white/10 text-ink-3 hover:border-white/30 hover:text-ink" aria-label="Close inspector">
          <X size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {!isTauri() && <p className="text-[12px] text-ink-3">Live inspection needs the desktop engine.</p>}
        {poll.error && <p className="font-mono text-[11px] text-alert">{poll.error}</p>}
        {d?.node.schedule && <p className="text-[11.5px] leading-relaxed text-ink-3">{d.node.schedule}</p>}

        <Section id="rag" icon={Database} title="1 · RAG memory" focus={focus}>
          {!mem ? (
            <p className="text-[11.5px] text-ink-3">{d ? "No memory namespace: this node runs stateless." : isTauri() ? "Loading…" : "—"}</p>
          ) : isVault(mem) ? (
            <dl className="space-y-1">
              <Row k="Namespace" v="finance (vault-internal index)" />
              <Row k="Seal" v={mem.sealed ? "SEALED" : "open"} tone={mem.sealed ? "#c4b5fd" : "#fbbf24"} />
              <Row k="Ledger entries" v={mem.sealed ? "sealed — unlock to count" : (mem.entries ?? "—")} />
              <Row k="Ledger on disk" v={mem.hasLedger ? "yes (AES-GCM)" : "none yet"} />
              <Row k="Key in OS keychain" v={mem.hasKey ? "yes" : "no"} />
              <p className="pt-1 text-[11px] text-ink-3">The vault's index never enters shared memory; its contents are not shown here.</p>
            </dl>
          ) : (
            <>
              <dl className="space-y-1">
                <Row k="Namespace" v={mem.namespace} tone={bus.color} />
                <Row k="Entries (keyword index)" v={`${mem.active} / ${mem.activeMax}`} />
                <Row k="Storage tier" v={`T1 RAM ${mem.activeKb} KB · T2 disk ${mem.archived}`} />
                <Row k="Retrieval hits" v={mem.hits} />
                <Row k="Last write / hit" v={`${ago(mem.lastWriteAt, now)} / ${ago(mem.lastHitAt, now)}`} />
              </dl>
              {mem.collections.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {mem.collections.map((c) => (
                    <span key={c.tag} className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10.5px] text-ink-2">
                      {c.tag} · {c.count}
                    </span>
                  ))}
                </div>
              )}
              <h4 className="label-caps mt-3 mb-1 text-[10px] text-ink-3">Recent retrievals / writes</h4>
              <ol className="space-y-0.5 font-mono text-[10.5px]">
                {memFeed.slice(0, 6).map((f, i) => (
                  <li key={`${f.at}-${i}`} className="flex gap-2">
                    <span className="shrink-0 text-ink-3">{new Date(f.at).toLocaleTimeString([], { hour12: false })}</span>
                    <span className={f.kind === "memory_write" ? "text-amber-light" : "text-teal"}>{f.kind === "memory_write" ? "write" : "read"}</span>
                    <span className="truncate text-ink-3">{f.label}</span>
                    {f.ms != null && <span className="ml-auto shrink-0 text-ink-3">{fmtMs(f.ms)}</span>}
                  </li>
                ))}
                {!memFeed.length && <li className="text-ink-3">None this session.</li>}
              </ol>
              {mem.recent.length > 0 && (
                <>
                  <h4 className="label-caps mt-3 mb-1 text-[10px] text-ink-3">Newest documents</h4>
                  <ul className="space-y-1">
                    {mem.recent.map((e) => (
                      <li key={e.id} className="rounded-[8px] border border-white/[0.06] px-2 py-1 text-[11px]">
                        <p className="line-clamp-2 text-ink-2">{e.preview}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-ink-3">
                          {ago(e.at, now)} · {e.hits} hit{e.hits === 1 ? "" : "s"}
                          {e.done ? " · done (graduates next pass)" : ""}
                          {e.tags.length ? ` · ${e.tags.slice(0, 3).join(", ")}` : ""}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </Section>

        <Section id="memory" icon={HardDrive} title="2 · Memory module" focus={focus}>
          {d ? (
            <dl className="space-y-1">
              {mem && !isVault(mem) && (
                <>
                  <Row k="Ephemeral (Tier 1, RAM)" v={mem.active} />
                  <Row k="Persistent (Tier 2, archive)" v={mem.archived} />
                  <Row k="Marked done" v={mem.done} />
                  <Row
                    k="Next graduation"
                    v={mem.oldestActiveAt ? `oldest in ${Math.max(0, Math.ceil((mem.oldestActiveAt + d.lifecycle.graduateAfterDays * 86_400_000 - now) / 86_400_000))}d` : "—"}
                  />
                </>
              )}
              <Row k="TTL: untouched → archive" v={`${d.lifecycle.graduateAfterDays} days`} />
              <Row k="Garbage Daemon cadence" v={`every ${d.lifecycle.garbageEveryMinutes} min idle`} />
              <Row k="Last Garbage purge" v={ago(d.lifecycle.lastPurgeAt, now)} />
              {id === "finance" && <Row k="Vault re-seals after" v={`${d.lifecycle.vaultIdleMinutes} min idle`} />}
              <Row k="Runs / last active" v={`${d.live?.runs ?? 0} · ${ago(d.live?.lastActiveAt, now)}`} />
            </dl>
          ) : (
            <p className="text-[11.5px] text-ink-3">{isTauri() ? "Loading…" : "—"}</p>
          )}
        </Section>

        <Section id="caps" icon={Plug} title="3 · Capabilities & hookups" focus={focus}>
          <h4 className="label-caps mb-1 flex items-center gap-1 text-[10px] text-ink-3">
            <Sparkles size={10} aria-hidden /> Skills ({skills.length})
          </h4>
          <div className="flex flex-wrap gap-1">
            {skills.slice(0, 18).map((s) => (
              <span key={s.path} title={s.description} className="rounded-full border border-white/10 px-2 py-0.5 text-[10.5px] text-ink-2">
                {s.name}
              </span>
            ))}
            {!skills.length && <span className="text-[11px] text-ink-3">{snap ? "No skills granted (os.json skills.grants)." : "—"}</span>}
          </div>
          <h4 className="label-caps mt-3 mb-1 text-[10px] text-ink-3">MCP servers / APIs</h4>
          <ul className="space-y-0.5 text-[11px]">
            {hooks.map((b) => (
              <li key={b.id} className="flex items-center gap-2">
                <span className={`size-1.5 rounded-full ${b.status === "ok" ? "bg-teal" : b.status === "unknown" || b.status === "off" || b.status === "starting" ? "bg-ink-3" : "bg-alert"}`} />
                <span className="text-ink-2">{b.name}</span>
                <span className="font-mono text-[10px] text-ink-3">{b.transport}</span>
                <span className="ml-auto font-mono text-[10px] text-ink-3">{b.tools != null ? `${b.tools} tools` : b.status}</span>
              </li>
            ))}
            {!hooks.length && <li className="text-ink-3">{snap ? "No external servers on this node." : "—"}</li>}
          </ul>
          <h4 className="label-caps mt-3 mb-1 flex items-center gap-1 text-[10px] text-ink-3">
            {id === "finance" ? <Lock size={10} aria-hidden /> : <ShieldCheck size={10} aria-hidden />} Boundary
          </h4>
          <p className="text-[11.5px] leading-relaxed text-ink-2">{BOUNDARY[id]}</p>
          <h4 className="label-caps mt-3 mb-1 text-[10px] text-ink-3">Hand-off contracts</h4>
          <dl className="space-y-1">
            <Row k="Upstream (receives from)" v={d?.upstream.map((u) => (isRoster(u) ? NODE_LABEL[u] : u)).join(", ") || "—"} />
            <Row k="Downstream (hands to)" v={d?.downstream.map((u) => (isRoster(u) ? NODE_LABEL[u] : u)).join(", ") || "—"} />
          </dl>
          <h4 className="label-caps mt-3 mb-1 text-[10px] text-ink-3">Recent hand-offs</h4>
          <ol className="space-y-0.5 font-mono text-[10.5px]">
            {handoffs.slice(0, 8).map((f, i) => (
              <li key={`${f.at}-${i}`} className="flex gap-2 text-ink-2">
                <span className="shrink-0 text-ink-3">{new Date(f.at).toLocaleTimeString([], { hour12: false })}</span>
                <span className="shrink-0">
                  {f.from} → {f.to}
                </span>
                <span className="truncate text-ink-3">{f.label}</span>
              </li>
            ))}
            {!handoffs.length && <li className="text-ink-3">None this session.</li>}
          </ol>
        </Section>
      </div>
    </aside>
  );
}
