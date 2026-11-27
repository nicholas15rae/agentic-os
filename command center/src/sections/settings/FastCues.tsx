import { useMemo, useState } from "react";
import { Plus, Trash2, Zap } from "lucide-react";
import { Field, Input, Select } from "@/components/ui";
import type { Item } from "@/lib/cc-api";
import { useSettings } from "@/stores/settings";
import { useOs } from "@/features/os/os-store";
import { DEFAULT_ROUTING_CONFIG } from "@/features/dispatcher/router";
import type { CueWidget } from "@/features/cues/types";
import { BUILTIN_PHRASES, FAST_HANDLERS, validateFastCue, type FastCueSpec, type FastTarget, type ValidateCtx } from "@/features/voice/fast-path";

const targetLabel = (t: FastTarget) => (t === "reply" ? "Fixed reply" : (FAST_HANDLERS.find((h) => h.id === t)?.label ?? t));

/** A fast cue stored as a cue document the widget runtime never fires (no phrases / time / startup). */
export function fastCueDoc(spec: FastCueSpec): Partial<CueWidget> {
  return {
    name: `Fast cue: ${spec.phrase}`,
    enabled: true,
    phrases: [],
    time: "",
    days: [],
    startup: false,
    intro: { mode: "static", text: "" },
    soundbite: null,
    theme: null,
    action: { kind: "none", value: "" },
    fast: spec,
  };
}

/**
 * Settings → Voice & Triggers, Section 20.10: the instant-cue switches, the built-in phrases, and
 * "Make this a fast cue" (a phrase → a read-only handler, a Spotify / mode fast path, or a fixed
 * reply — text only). Saved in the "cues" collection next to the widgets.
 */
export function FastCues({ cues, create, update, remove }: { cues: Item<CueWidget>[]; create: (d: Partial<CueWidget>) => Promise<unknown>; update: (id: string, p: Partial<CueWidget>) => Promise<unknown>; remove: (id: string) => Promise<unknown> }) {
  const fastPath = useSettings((s) => s.fastPath) ?? { builtins: true, userCues: true };
  const osName = useSettings((s) => s.osName) || "Tony";
  const wakeWords = useSettings((s) => s.wakeWords);
  const routing = useOs((s) => s.cfg?.routing) ?? DEFAULT_ROUTING_CONFIG;
  const [phrase, setPhrase] = useState("");
  const [target, setTarget] = useState<FastTarget>("time");
  const [reply, setReply] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const fastCues = cues.filter((c) => c.fast);
  const ctx: ValidateCtx = useMemo(
    () => ({
      existing: fastCues.map((c) => ({ id: c.id, ...(c.fast as FastCueSpec) })),
      names: [osName, ...(wakeWords ?? [])],
      routingNames: Object.entries(routing.agents ?? {}).flatMap(([agent, t]) => (t.names ?? []).map((name) => ({ name, agent: agent.charAt(0).toUpperCase() + agent.slice(1) }))),
      cuePhrases: cues.filter((c) => !c.fast && c.enabled).flatMap((c) => c.phrases),
    }),
    [cues, fastCues, osName, wakeWords, routing],
  );
  const check = phrase.trim() ? validateFastCue({ phrase, target, reply }, ctx) : null;
  const setFast = (p: Partial<{ builtins: boolean; userCues: boolean }>) => useSettings.getState().set({ fastPath: { ...fastPath, ...p } });

  const add = async () => {
    if (!check?.ok) return;
    setErr(null);
    try {
      await create(fastCueDoc({ phrase: check.phrase, target, ...(target === "reply" ? { reply: check.reply } : {}) }));
      setPhrase("");
      setReply("");
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <section className="mt-4 r-16 border border-white/10 bg-white/[0.02] p-4" aria-label="Instant cues">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <Zap size={13} /> Instant cues — answered without a model
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" checked={fastPath.builtins} onChange={(e) => setFast({ builtins: e.target.checked })} aria-label="Built-in instant cues" className="accent-teal" /> Built-ins
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" checked={fastPath.userCues} onChange={(e) => setFast({ userCues: e.target.checked })} aria-label="My fast cues" className="accent-teal" /> My fast cues
        </label>
      </div>
      <p className="text-xs text-ink-3">
        Whole-line matches only. Read-only answers (time, date, weather from the clock's last reading, what's pending) or the existing Spotify / mode fast paths; anything else — or an answer that isn't
        loaded yet — goes to Tony as usual. Stops, the kill switch and every confirmation card keep their own handling.
      </p>
      <details className="mt-2 text-xs text-ink-3">
        <summary className="cursor-pointer text-ink-2">Built-in phrases</summary>
        <ul className="mt-1 space-y-0.5">
          {Object.entries(BUILTIN_PHRASES).map(([h, ps]) => (
            <li key={h}>
              <span className="text-ink-2">{targetLabel(h as FastTarget)}:</span> {ps.join(" · ")}
            </li>
          ))}
        </ul>
      </details>

      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_220px]">
        <Field label="Make this a fast cue — phrase">
          <Input value={phrase} maxLength={120} onChange={(e) => setPhrase(e.target.value)} placeholder="what's my day look like" />
        </Field>
        <Field label="It does">
          <Select value={target} onChange={(e) => setTarget(e.target.value as FastTarget)}>
            {FAST_HANDLERS.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
            <option value="reply">Say a fixed reply</option>
          </Select>
        </Field>
      </div>
      {target === "reply" && (
        <Field label="Tony says (text only)" className="mt-2">
          <Input value={reply} maxLength={300} onChange={(e) => setReply(e.target.value)} placeholder="Locked in, Nic. Let's get it." />
        </Field>
      )}
      {check && (check.errors.length > 0 || check.warnings.length > 0) && (
        <ul className="mt-2 space-y-0.5 text-xs" aria-live="polite">
          {check.errors.map((e) => (
            <li key={e} className="text-alert">
              {e}
            </li>
          ))}
          {check.warnings.map((w) => (
            <li key={w} className="text-amber-light">
              {w}
            </li>
          ))}
        </ul>
      )}
      {err && <p className="mt-1 text-xs text-alert">{err}</p>}
      <div className="mt-2 flex items-center gap-2">
        {check?.phrase && <span className="font-mono fs-11 text-ink-3">matches “{check.phrase}”</span>}
        <button onClick={() => void add()} disabled={!check?.ok} className="pill-primary ml-auto !h-8 text-xs disabled:opacity-50">
          <Plus size={13} /> Make this a fast cue
        </button>
      </div>

      {fastCues.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {fastCues.map((c) => {
            const f = c.fast as FastCueSpec;
            return (
              <li key={c.id} className={`flex flex-wrap items-center gap-2 r-10 border border-white/[0.06] px-3 py-1.5 text-sm ${c.enabled ? "" : "opacity-60"}`}>
                <button role="switch" aria-checked={c.enabled} aria-label={`Enable fast cue ${f.phrase}`} onClick={() => void update(c.id, { enabled: !c.enabled })} className={`relative h-4 w-7 shrink-0 rounded-full ${c.enabled ? "bg-teal/80" : "bg-white/15"}`}>
                  <span className={`absolute top-0.5 size-3 rounded-full bg-white transition-[left] ${c.enabled ? "left-[14px]" : "left-0.5"}`} />
                </button>
                <span className="font-mono fs-12 text-ink">“{f.phrase}”</span>
                <span className="text-xs text-ink-3">→ {targetLabel(f.target)}</span>
                {f.target === "reply" && f.reply && <span className="truncate text-xs text-ink-2">“{f.reply}”</span>}
                <button onClick={() => confirm(`Delete the fast cue “${f.phrase}”?`) && void remove(c.id)} aria-label={`Delete fast cue ${f.phrase}`} className="pill-glass ml-auto !h-7 !w-7 !p-0 hover:!border-alert/50">
                  <Trash2 size={11} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
