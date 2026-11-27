import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, Lock, Moon, RefreshCw, Snowflake } from "lucide-react";
import { Card } from "@/components/ui";
import { cmd, type McpServer, type OsConfig, type ServerTools } from "@/lib/platform";
import { isDesktopApp } from "@/stores/settings";
import { roleLabel, subAgentIds } from "@/features/dispatcher/roles";
import { useModes } from "@/features/modes/modes-store";
import { ModeIcon } from "@/features/modes/ModeIcon";
import { ALWAYS_LIVE_TOOLS, NOVELTY_MODE_ID, isAlwaysLiveServer, isBuiltinMode, type TonyMode } from "@/features/modes/modes";
import { switchboardSummary, toggleOverlayItem, validateModeDraft, withOverlay } from "@/features/modes/mode-ui";
import { osSwitchboard, ownsServer, toggleFrozen, toggleOwner, type OsSwitchboard } from "@/features/os/switchboard";
import { agentServers, loadOf, loadSharedOk, saveSharedOk, sharedKey, sharedServers, TOOL_WARN, tonyModeTools, toggleTonyModeTool, type TonyModeTools } from "@/features/os/tool-load";
import { CfgError, Toggle, useOsCfg } from "./os-ui";
import { desktopConfig, PHONE_READ_ONLY } from "./use-providers";

/**
 * Settings → Modes & Switchboard: the MASTER SWITCHBOARD.
 *   1. Global freezes (os.json `switchboard.frozenAgents / frozenTools`): frozen in every mode.
 *   2. Mode presets: which agents and tool servers each mode keeps on duty (`TonyMode.switchboard`);
 *      the built-ins are read-only (Rust re-seeds them), custom modes are editable here.
 *   3. Tool ownership: which agents may use each server (`mcps[].agents`, the grant list). Tony
 *      respects these too.
 * Freezing is a runtime mask: a frozen agent or server keeps every setting and comes back exactly
 * as it was. Desktop: writes go through `os_config_update` / `tony_mode_upsert`. Phone: the
 * desktop's settings, read-only.
 */

type SwitchboardCfg = Pick<OsConfig, "osName" | "mcps" | "routing"> & { switchboard?: OsSwitchboard; tonyModeTools?: TonyModeTools | null };

export interface SwitchboardViewProps {
  cfg: SwitchboardCfg;
  modes: readonly TonyMode[];
  activeId: string;
  readOnly: boolean;
  onFreeze?: (next: OsSwitchboard) => void;
  onMode?: (next: TonyMode) => void;
  onMcps?: (mcps: McpServer[]) => void;
  /** Tony's per-mode extras (os.json `tonyModeTools`): editable for presets too. */
  onTonyTools?: (next: TonyModeTools) => void;
  /** The cached tool listings (`mcp_list_tools`), for the per-agent tool counts. */
  serverTools?: readonly ServerTools[];
  /** Shared servers Nic said are shared on purpose (`sharedKey`s). */
  sharedOk?: readonly string[];
  onSharedOk?: (key: string) => void;
}

type PillState = "live" | "frozen" | "locked" | "off";

const PILL: Record<PillState, string> = {
  live: "border-teal/60 bg-teal/15 text-teal",
  locked: "border-teal/40 bg-teal/10 text-teal",
  frozen: "border-sky-300/30 bg-sky-300/[0.06] text-ink-3 line-through decoration-ink-3/60",
  off: "border-white/10 text-ink-3",
};

function Pill({ state, children, title, onClick, disabled, pressed }: { state: PillState; children: ReactNode; title?: string; onClick?: () => void; disabled?: boolean; pressed?: boolean }) {
  const icon = state === "locked" ? <Lock size={10} aria-hidden /> : state === "frozen" ? <Snowflake size={10} aria-hidden /> : null;
  const cls = `inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors ${PILL[state]}`;
  // A plain chip shows a fact; a toggle (it has a pressed state) stays a button, disabled when it
  // can't be changed here (the phone, the last owner), so its state still reads as a switch.
  if (pressed === undefined)
    return (
      <span className={cls} title={title}>
        {icon}
        {children}
      </span>
    );
  const off = disabled || !onClick;
  return (
    <button type="button" aria-pressed={pressed} disabled={off} onClick={off ? undefined : onClick} title={title} className={`${cls} ${off ? "cursor-default opacity-80" : "hover:text-ink"}`}>
      {icon}
      {children}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-1">
      <p className="label-caps mb-1 text-ink-3">{label}</p>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

/** The whole switchboard (presentational: no store hooks, unit-tested with static markup). */
export function SwitchboardView({ cfg, modes, activeId, readOnly, onFreeze, onMode, onMcps, onTonyTools, serverTools, sharedOk = [], onSharedOk }: SwitchboardViewProps) {
  const sb = osSwitchboard(cfg);
  const agents = subAgentIds(cfg.routing?.agents);
  const servers = cfg.mcps ?? [];
  const tony = cfg.osName || "Tony";
  const label = (id: string) => (id === "general" ? tony : roleLabel(id));
  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? id;
  const agentFrozen = (id: string) => sb.frozenAgents.includes(id);
  const toolFrozen = (id: string) => !isAlwaysLiveServer(id) && sb.frozenTools.includes(id);
  const edit = !readOnly;
  const work = modes.filter((m) => !m.is_novelty && m.id !== NOVELTY_MODE_ID);
  const owners = ["general", ...agents];
  const tonyTools = tonyModeTools(cfg);
  const tonyBase = servers.filter((s) => !isAlwaysLiveServer(s.id) && ownsServer(s.agents, "general")).map((s) => s.id);
  // Tool load in the ACTIVE mode: what each agent is handed per turn.
  const activeMode = modes.find((m) => m.id === activeId);
  const modeTools = activeMode?.switchboard?.tools ?? null;
  const modeAgents = activeMode?.switchboard?.agents ?? null;
  const loads = owners.map((id) =>
    loadOf(id, agentServers(cfg, id, { modeId: activeId, modeTools, frozenTools: sb.frozenTools, frozen: id !== "general" && (agentFrozen(id) || (!!modeAgents && !modeAgents.includes(id))) }), serverTools ?? []),
  );
  const shared = sharedServers(servers, owners.filter((id) => id === "general" || !agentFrozen(id)));

  return (
    <div className="space-y-4">
      {readOnly && <p className="text-xs text-ink-3">{PHONE_READ_ONLY}</p>}

      <section aria-label="Master switchboard">
        <h3 className="text-sm font-semibold text-ink">Master switchboard</h3>
        <p className="text-xs text-ink-3">Frozen here means frozen in every mode, even when you ask for it by name. Nothing about it is deleted: thaw it and it comes back exactly as it was.</p>
        <Group label="Agents">
          <Pill state="locked" title={`${tony} is always live`}>
            {tony}
          </Pill>
          {agents.map((id) => {
            const frozen = agentFrozen(id);
            return (
              <Pill
                key={id}
                state={frozen ? "frozen" : "live"}
                pressed={!frozen}
                disabled={!edit}
                title={frozen ? `${label(id)} is frozen in every mode: click to thaw` : `Freeze ${label(id)} in every mode`}
                onClick={edit ? () => onFreeze?.({ ...sb, frozenAgents: toggleFrozen(sb.frozenAgents, id) }) : undefined}
              >
                {label(id)}
              </Pill>
            );
          })}
        </Group>
        <Group label="Tool servers">
          {servers.map((s) => {
            if (isAlwaysLiveServer(s.id))
              return (
                <Pill key={s.id} state="locked" title={`${s.name} is always live`}>
                  {s.name}
                </Pill>
              );
            const frozen = toolFrozen(s.id);
            return (
              <Pill
                key={s.id}
                state={frozen ? "frozen" : s.enabled ? "live" : "off"}
                pressed={!frozen}
                disabled={!edit}
                title={frozen ? `${s.name} is frozen in every mode: click to thaw` : `Freeze ${s.name} in every mode${s.enabled ? "" : " (it is also switched off in the MCP registry)"}`}
                onClick={edit ? () => onFreeze?.({ ...sb, frozenTools: toggleFrozen(sb.frozenTools, s.id) }) : undefined}
              >
                {s.name}
                {!s.enabled && <span className="text-[10px] text-ink-3"> · off</span>}
              </Pill>
            );
          })}
        </Group>
        <p className="mt-1 text-[11px] text-ink-3">Always live: {ALWAYS_LIVE_TOOLS.join(", ")} (so you can always switch modes by voice).</p>
      </section>

      <section aria-label="Mode presets">
        <h3 className="text-sm font-semibold text-ink">Mode presets</h3>
        <p className="text-xs text-ink-3">Who is on duty in each mode. Tony never hands work to a frozen agent and never sees a frozen tool; naming an agent, or typing on its tab, still reaches it (except one frozen on the master switchboard). Presets are read-only: duplicate one under Tony modes to make your own.</p>
        <ul className="mt-2 space-y-2">
          {work.map((m) => {
            const preset = isBuiltinMode(m.id);
            const overlay = m.switchboard ?? null;
            const canEdit = edit && !preset;
            const agentPill = (id: string) => {
              const on = !overlay || overlay.agents.includes(id);
              const state: PillState = agentFrozen(id) ? "frozen" : on ? "live" : "off";
              return canEdit && overlay ? (
                <Pill key={id} state={state} pressed={on} title={`${on ? "Freeze" : "Put on duty:"} ${label(id)} in ${m.name}`} onClick={() => onMode?.(toggleOverlayItem(m, "agents", id))}>
                  {label(id)}
                </Pill>
              ) : on ? (
                <Pill key={id} state={state} title={agentFrozen(id) ? `${label(id)} is frozen on the master switchboard` : undefined}>
                  {label(id)}
                </Pill>
              ) : null;
            };
            const toolPill = (id: string) => {
              const on = isAlwaysLiveServer(id) || !overlay || overlay.tools.includes(id);
              const state: PillState = toolFrozen(id) ? "frozen" : on ? "live" : "off";
              return canEdit && overlay && !isAlwaysLiveServer(id) ? (
                <Pill key={id} state={state} pressed={on} title={`${on ? "Freeze" : "Put on duty:"} ${serverName(id)} in ${m.name}`} onClick={() => onMode?.(toggleOverlayItem(m, "tools", id))}>
                  {serverName(id)}
                </Pill>
              ) : on ? (
                <Pill key={id} state={state}>
                  {serverName(id)}
                </Pill>
              ) : null;
            };
            // A preset lists its own ids (even ones not in this registry); a custom mode the registry.
            const agentIds = overlay && !canEdit ? overlay.agents : agents;
            const toolIds = overlay && !canEdit ? overlay.tools : servers.map((s) => s.id);
            return (
              <li key={m.id} className={`rounded-[14px] border p-3 ${m.id === activeId ? "border-teal/40 bg-teal/[0.04]" : "border-white/[0.06] bg-white/[0.02]"}`} data-mode={m.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full border border-white/10 text-ink">
                    <ModeIcon icon={m.icon} size={13} />
                  </span>
                  <span className="text-sm font-semibold text-ink">{m.name}</span>
                  <span className="label-caps rounded-full border border-white/15 px-1.5 py-0.5 text-ink-3">{preset ? "Preset" : "Custom"}</span>
                  {m.id === activeId && <span className="label-caps rounded-full border border-teal/50 bg-teal/15 px-2 py-0.5 text-teal">Active</span>}
                  {m.night_training && (
                    <span className="label-caps inline-flex items-center gap-1 rounded-full border border-amber/40 bg-amber/10 px-2 py-0.5 text-amber-light" title="Queues an overnight training run of Tony's model">
                      <Moon size={10} aria-hidden /> Night training
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink-3">{switchboardSummary(m)}</p>
                {canEdit && (
                  <Toggle
                    on={!!overlay}
                    onChange={(v) => onMode?.(withOverlay(m, v, { agents, tools: servers.map((s) => s.id) }))}
                    label="Use a switchboard in this mode"
                    hint="Off: every agent and tool stays live. On: untick what this mode should freeze."
                  />
                )}
                {overlay && (
                  <>
                    <Group label={`On duty with ${tony}`}>{agentIds.map(agentPill)}</Group>
                    <Group label="Tools">{toolIds.map(toolPill)}</Group>
                  </>
                )}
                <Group label={`${tony} adds in this mode (on top of his base)`}>
                  {servers
                    .filter((s) => !isAlwaysLiveServer(s.id) && !tonyBase.includes(s.id))
                    .map((s) => {
                      const on = (tonyTools[m.id] ?? []).includes(s.id);
                      return (
                        <Pill
                          key={s.id}
                          state={toolFrozen(s.id) ? "frozen" : on ? "live" : "off"}
                          pressed={on}
                          disabled={!edit}
                          title={`${on ? "Take" : "Give"} ${s.name} ${on ? "from" : "to"} ${tony} in ${m.name}`}
                          onClick={edit ? () => onTonyTools?.(toggleTonyModeTool(tonyTools, m.id, s.id)) : undefined}
                        >
                          {s.name}
                        </Pill>
                      );
                    })}
                </Group>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="Tool ownership">
        <h3 className="text-sm font-semibold text-ink">Tool ownership</h3>
        <p className="text-xs text-ink-3">Which agents may use each server's tools. {tony}'s pills here are his always-on base (on in every mode, Learning included); each mode adds its own on top (Mode presets above). For everyone else a mode can freeze a server but never grants one. A frozen agent gets no tools at all. Every server keeps at least one owner; switch it off in the MCP registry instead.</p>
        <p className="mt-1 text-[11px] text-ink-3">{tony}'s base: {tonyBase.map(serverName).join(", ") || "none"}.</p>
        <ul className="mt-2 space-y-1.5">
          {servers.map((s) => (
            <li key={s.id} className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2" data-server={s.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink">{s.name}</span>
                {!s.enabled && <span className="label-caps text-ink-3">off</span>}
                {toolFrozen(s.id) && (
                  <span className="label-caps inline-flex items-center gap-1 text-ink-3">
                    <Snowflake size={10} aria-hidden /> frozen
                  </span>
                )}
              </div>
              {(() => {
                const sh = shared.find((x) => x.server === s.id);
                if (!sh || sharedOk.includes(sharedKey(sh))) return null;
                return (
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-amber-soft" data-shared={s.id}>
                    <AlertTriangle size={11} aria-hidden /> One owner per tool: {s.name} is on for {sh.owners.map(label).join(" and ")}. Is that intended?
                    {edit && onSharedOk && (
                      <button type="button" onClick={() => onSharedOk(sharedKey(sh))} className="rounded-full border border-amber/40 px-2 py-0.5 text-[11px] text-amber-soft hover:text-ink">
                        Yes, shared on purpose
                      </button>
                    )}
                  </p>
                );
              })()}
              <div className="mt-1 flex flex-wrap gap-1">
                {owners.map((id, _i, all) => {
                  const owns = ownsServer(s.agents, id);
                  const last = owns && all.filter((o) => ownsServer(s.agents, o)).length === 1;
                  return (
                    <Pill
                      key={id}
                      state={owns ? "live" : "off"}
                      pressed={owns}
                      disabled={!edit || last}
                      title={last ? `${label(id)} is the last owner` : `${owns ? "Take" : "Give"} ${s.name} ${owns ? "from" : "to"} ${label(id)}`}
                      onClick={edit && !last ? () => onMcps?.(servers.map((x) => (x.id === s.id ? { ...x, agents: toggleOwner(x.agents, id, owners) } : x))) : undefined}
                    >
                      {label(id)}
                    </Pill>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Tool load">
        <h3 className="text-sm font-semibold text-ink">Tool load ({activeMode?.name ?? activeId})</h3>
        <p className="text-xs text-ink-3">How many tools each agent is handed per turn in the active mode, and roughly how many prompt tokens their descriptions add. Over {TOOL_WARN} tools, models pick the wrong one more often.</p>
        <ul className="mt-2 space-y-1">
          {loads.map((l) => (
            <li key={l.agent} className="flex flex-wrap items-center gap-2 text-xs" data-load={l.agent}>
              <span className="w-28 shrink-0 text-ink">{label(l.agent)}</span>
              {l.servers.length === 0 ? (
                <span className="text-ink-3">no tools{l.agent !== "general" && agentFrozen(l.agent) ? " (frozen)" : ""}</span>
              ) : (
                <>
                  <span className={`font-mono ${l.warn ? "text-alert" : "text-ink-2"}`}>
                    {l.tools} tool{l.tools === 1 ? "" : "s"} · ~{l.tokens} tokens
                  </span>
                  <span className="text-ink-3">({l.servers.map(serverName).join(", ")})</span>
                  {l.unlisted.length > 0 && <span className="text-ink-3">· not listed yet: {l.unlisted.map(serverName).join(", ")}</span>}
                  {l.warn && (
                    <span className="inline-flex items-center gap-1 text-alert">
                      <AlertTriangle size={11} aria-hidden /> over {TOOL_WARN}
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** The Settings card: the desktop edits, the phone shows the desktop's switchboard read-only. */
export function SwitchboardCard() {
  return isDesktopApp() ? <DesktopSwitchboard /> : <PhoneSwitchboard />;
}

const HINT = "Freeze agents and tools everywhere, choose who is on duty in each mode, and who owns each tool server. Frozen = paused, never deleted.";

function useModesLoaded() {
  const modes = useModes((s) => s.modes);
  const activeId = useModes((s) => s.activeId);
  const error = useModes((s) => s.error);
  useEffect(() => {
    if (!useModes.getState().loaded) void useModes.getState().load();
  }, []);
  return { modes, activeId, error };
}

function DesktopSwitchboard() {
  const { cfg, error, save } = useOsCfg();
  const { modes, activeId, error: modeError } = useModesLoaded();
  const [draftError, setDraftError] = useState<string | null>(null);
  const [serverTools, setServerTools] = useState<ServerTools[]>([]);
  const [sharedOk, setSharedOk] = useState<string[]>(() => loadSharedOk());
  useEffect(() => {
    void cmd("mcp_list_tools", {})
      .then(setServerTools)
      .catch(() => undefined);
  }, []);
  if (!cfg) return null;
  return (
    <Card title="Master switchboard" hint={HINT}>
      <SwitchboardView
        cfg={cfg}
        modes={modes}
        activeId={activeId}
        readOnly={false}
        onFreeze={(next) => save({ switchboard: next })}
        onMode={(next) => {
          // The same rules Rust's validate_mode applies (caught here before a refused save).
          const bad = validateModeDraft(next);
          setDraftError(bad);
          if (!bad) void useModes.getState().upsert(next, false).catch(() => undefined);
        }}
        serverTools={serverTools}
        sharedOk={sharedOk}
        onSharedOk={(key) => {
          const next = [...sharedOk, key];
          setSharedOk(next);
          saveSharedOk(next);
        }}
        onTonyTools={(tonyModeTools) => save({ tonyModeTools })}
        onMcps={(mcps) => {
          save({ mcps });
          // Keep AnythingLLM's own MCP file in step, as the MCP registry card does on a grant edit.
          void cmd("mcp_sync_anythingllm").catch(() => undefined);
        }}
      />
      <CfgError error={draftError ?? error ?? modeError} />
    </Card>
  );
}

function PhoneSwitchboard() {
  const { modes, activeId } = useModesLoaded();
  const [cfg, setCfg] = useState<SwitchboardCfg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      const os = (await desktopConfig()).os;
      setCfg(os);
      setError(os ? null : "The desktop's switchboard isn't available");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <Card
      title="Master switchboard"
      hint={HINT}
      action={
        <button className="pill-glass !h-8 text-xs" onClick={() => void load()} disabled={busy} aria-label="Refresh the switchboard">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      }
    >
      {cfg ? <SwitchboardView cfg={cfg} modes={modes} activeId={activeId} readOnly /> : !error && <p className="text-sm text-ink-3">Loading…</p>}
      <CfgError error={error} />
    </Card>
  );
}
