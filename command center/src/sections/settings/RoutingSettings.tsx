import { useMemo, useState } from "react";
import { RotateCcw, Sparkles, X } from "lucide-react";
import { Card, Field, Input } from "@/components/ui";
import { ROLE_IDS, roleLabel } from "@/features/dispatcher/roles";
import { DEFAULT_ROUTING_CONFIG, resolve } from "@/features/dispatcher/router";
import type { AgentTriggers, FeedbackConfig, FeedbackLevel } from "@/lib/platform";
import { feedbackLevel } from "@/features/voice/narrator";
import { CfgError, Toggle, useOsCfg } from "./os-ui";
import { useSettings } from "@/stores/settings";
import { useModes } from "@/features/modes/modes-store";

/** Add-via-input-and-Enter, remove-via-×. */
function ChipList({ items, onAdd, onRemove, placeholder }: { items: string[]; onAdd: (v: string) => void; onRemove: (v: string) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const v = draft.trim();
    if (v && v.length <= 200 && !items.includes(v)) onAdd(v);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((it) => (
        <span key={it} className="flex h-7 items-center gap-1 rounded-full border border-teal/40 bg-teal/10 px-2.5 text-[12px] text-teal">
          {it}
          <button type="button" aria-label={`Remove ${it}`} onClick={() => onRemove(it)} className="text-teal/70 hover:text-alert">
            <X size={11} />
          </button>
        </span>
      ))}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        onBlur={submit}
        placeholder={placeholder}
        className="!h-7 !w-36 !py-0 !text-[12px]"
      />
    </div>
  );
}

function RoleRow({ role, triggers, onSave }: { role: string; triggers: AgentTriggers; onSave: (t: AgentTriggers) => void }) {
  return (
    <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <p className="mb-1.5 text-sm text-ink">{roleLabel(role)}</p>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
        <Field label="Name triggers">
          <ChipList
            items={triggers.names}
            placeholder="add a name…"
            onAdd={(v) => onSave({ ...triggers, names: [...triggers.names, v] })}
            onRemove={(v) => onSave({ ...triggers, names: triggers.names.filter((x) => x !== v) })}
          />
        </Field>
        <Field label="Domain (topic) triggers">
          <ChipList
            items={triggers.domains}
            placeholder="add a topic…"
            onAdd={(v) => onSave({ ...triggers, domains: [...triggers.domains, v] })}
            onRemove={(v) => onSave({ ...triggers, domains: triggers.domains.filter((x) => x !== v) })}
          />
        </Field>
      </div>
    </div>
  );
}

const LEVELS: { id: FeedbackLevel; label: string; hint: string }[] = [
  { id: 0, label: "Silent", hint: "Nothing is spoken; failures and finished builds still show as toasts and in the chat." },
  { id: 1, label: "Milestones", hint: "Queued, ready for review and failures are spoken (Tony's voice, or the agent's own words in its voice)." },
  { id: 2, label: "Handoffs", hint: "Also every handoff between agents, each in its own roster voice." },
  { id: 3, label: "Verbose", hint: "Everything the worker reports. Chatty, and ElevenLabs voices use quota quickly." },
];

/** Part 6: how much of the background build is spoken (os.json `feedback`, shared with the phone HUD). */
export function NarrationControl({
  feedback,
  save,
  modeName,
}: {
  feedback: Pick<FeedbackConfig, "sensitivity" | "narrationEngine"> | undefined;
  save: (p: { feedback: Partial<FeedbackConfig> }) => unknown;
  /** Tony's active mode: a mode switch rewrites the level (Phase 2 D17). */
  modeName?: string;
}) {
  const level = feedbackLevel(feedback ? { feedback: { sensitivity: feedback.sensitivity, narrationEngine: feedback.narrationEngine } } : null);
  const engine = feedback?.narrationEngine ?? "roster";
  return (
    <div className="border-b border-white/5 py-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">Narration</p>
          <p className="text-xs text-ink-3">{LEVELS.find((l) => l.id === level)?.hint} Never over you or over Tony's reply: a line waits for quiet and is dropped when stale. Ask “where's the build at?” anytime.</p>
          {modeName && <p className="mt-0.5 text-[11px] text-amber-soft">Set by {modeName} on switch; your change holds until the next mode switch.</p>}
        </div>
        <div role="radiogroup" aria-label="Narration" className="well flex rounded-full p-0.5">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={level === l.id}
              onClick={() => level !== l.id && save({ feedback: { sensitivity: l.id } })}
              className={`h-7 rounded-full px-3 font-mono text-[11px] uppercase tracking-wider transition-colors ${level === l.id ? "bg-teal/25 text-teal" : "text-ink-3 hover:text-ink"}`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink-2">Narration voices</p>
          <p className="text-[11px] text-ink-3">Roster: each agent speaks in its own voice from Settings → Voice. Local Kokoro: the same per-agent voices on Kokoro only, sparing the ElevenLabs quota.</p>
        </div>
        <div role="radiogroup" aria-label="Narration voices" className="well flex rounded-full p-0.5">
          {(
            [
              ["roster", "Roster"],
              ["kokoro", "Local Kokoro"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={engine === id}
              disabled={level === 0}
              onClick={() => engine !== id && save({ feedback: { narrationEngine: id } })}
              className={`h-7 rounded-full px-3 font-mono text-[11px] uppercase tracking-wider transition-colors disabled:opacity-40 ${engine === id ? "bg-amber/25 text-amber-light" : "text-ink-3 hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RoutingSettings() {
  const { cfg, error, save } = useOsCfg();
  const [testPhrase, setTestPhrase] = useState("");
  const routing = cfg?.routing;
  // Voice-only preference, kept in the app settings (not os.json): see voice-controller `osRun`.
  const announcerHandoff = useSettings((s) => s.routing.announcerHandoff);
  const setSettings = useSettings((s) => s.set);
  const osName = useSettings((st) => st.osName || "Tony");
  const modeName = useModes((st) => st.effective.name);
  // Same inputs as the live resolver (Rust reads `os_name`): "thanks <OS name>" is Self.
  const result = useMemo(() => (routing && testPhrase.trim() ? resolve(testPhrase, routing, osName) : null), [routing, testPhrase, osName]);
  if (!cfg || !routing) return null;

  const saveAgents = (agents: Record<string, AgentTriggers>) => save({ routing: { agents } });

  return (
    <Card
      title="Agent routing & triggers"
      hint="Name an agent directly (“tell my booking agent to…”) and it always wins. Otherwise a topic trigger below routes Auto-route's requests to the right specialist."
      action={
        <button onClick={() => save({ routing: DEFAULT_ROUTING_CONFIG })} className="pill-glass !h-8 text-xs">
          <RotateCcw size={13} /> Reset to defaults
        </button>
      }
    >
      <Toggle
        on={routing.autoSwitch}
        onChange={(v) => save({ routing: { autoSwitch: v } })}
        label="Switch the visible tab automatically"
        hint="When a request is routed to a sub-agent while you're on the Agents section, jump to that agent's tab instead of leaving a link behind. Off: stay put, show a “View in …” link."
      />
      <Toggle
        on={announcerHandoff}
        onChange={(v) => setSettings({ routing: { ...useSettings.getState().routing, announcerHandoff: v } })}
        label="Agents speak their own answers"
        hint="Voice: Tony says a short intro (“Here's Booking Desk.”), also when you talk to an agent's own tab, then the agent answers in its own roster voice and Tony doesn't repeat it. Off: Tony speaks his summary of the agent's answer (the old behaviour)."
      />
      <NarrationControl feedback={cfg.feedback} save={save} modeName={modeName} />

      <div className="mt-3 space-y-2">
        {ROLE_IDS.map((role) => {
          const triggers = routing.agents[role] ?? { names: [], domains: [] };
          return <RoleRow key={role} role={role} triggers={triggers} onSave={(t) => saveAgents({ ...routing.agents, [role]: t })} />;
        })}
      </div>

      <div className="mt-3 rounded-[12px] border border-amber/20 bg-amber/[0.04] px-3 py-2.5">
        <p className="label-caps mb-1.5 flex items-center gap-1.5 text-amber-soft">
          <Sparkles size={12} /> Test a phrase
        </p>
        <Input value={testPhrase} onChange={(e) => setTestPhrase(e.target.value)} placeholder="tell my booking agent to check my last 5 whatsapp messages" className="!text-[13px]" />
        {result && (
          <p className="mt-2 text-xs text-ink-2">
            → <span className="font-mono text-ink">{result.role ? roleLabel(result.role) : "no agent (default)"}</span>
            <span className="text-ink-3"> · {result.kind} · {result.reason}</span>
            {result.kind === "Named" && result.task !== testPhrase.trim() && (
              <>
                <br />
                task sent: <span className="font-mono text-ink-3">{result.task}</span>
              </>
            )}
          </p>
        )}
      </div>
      <CfgError error={error} />
    </Card>
  );
}
