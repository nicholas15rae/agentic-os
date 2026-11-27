import { useEffect, useState } from "react";
import { AlarmClock, CalendarPlus, Hourglass, Repeat, Trash2, CalendarDays, Bell } from "lucide-react";
import { WidgetHeader } from "@/components/WidgetHeader";
import { useCollection, useNow, type Item } from "@/lib/cc-api";
import { cmd, isTauri } from "@/lib/platform";
import { countdown, formatWhen } from "@/features/reminders/when";
import { handleLocalIntent } from "@/features/reminders/intents";
import { cancelOsAlarm } from "@/features/reminders/os-alarm";
import type { Reminder } from "@/features/reminders/types";
import { requestConfirmation } from "@/features/voice/voice-controller";
import type { ActionPlan } from "@/features/orchestrator/plan";
import { useSettings } from "@/stores/settings";
import type { RemindersPanelProps } from "./RemindersPanel.contract";

// Contract: ./RemindersPanel.contract.ts (LOCKED 2026-11-26). List only (decision 34: no MiniMonth).
// The body of the "Alarms & key dates" widget, shared with the top-bar clock popover and the phone HUD sheet.
// Both views read the one "reminders" collection store (useCollection de-duplicates the polling).

const ICON = { alarm: AlarmClock, reminder: Bell, countdown: Hourglass, event: CalendarDays };

export function RemindersPanel({ variant }: RemindersPanelProps) {
  const { items, error, remove, update } = useCollection<Reminder>("reminders");
  const now = useNow(1000);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const canPush = useCalendarCreate();
  const popover = variant === "popover";

  const upcoming = items
    .filter((r) => !r.dismissed && (r.kind === "countdown" ? r.dueAt > now - 86_400_000 : !r.firedAt || r.dueAt > now))
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, 30);

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    // Plain text ("Dentist on Friday at 3") becomes "remind me to Dentist on …".
    const phrased = /^(remind|set|alarm|wake|countdown|start|add|make|timer)\b|^[\w.]+[- ]?(minutes?|mins?|seconds?|secs?|hours?|hrs?) timer\b/i.test(t) ? t : `remind me to ${t}`;
    const res = await handleLocalIntent(phrased).catch((e) => ({ reply: String(e), meta: "" }));
    setMsg(res?.reply ?? null);
    if (res?.meta) setText("");
  };

  return (
    <div className={`flex flex-col ${popover ? "" : "h-full"}`}>
      <WidgetHeader title="Alarms & key dates" status={<span className="label-caps text-ink-3">{upcoming.length} upcoming</span>} />
      {popover && <PopoverClockLine now={now} />}
      <form
        className="mb-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input className="field !h-9 !py-1 text-[13px]" placeholder="“Call Sam in 20 min”, “Alarm at 6:45am”…" value={text} onChange={(e) => setText(e.target.value)} aria-label="New reminder" />
      </form>
      {msg && <p className="mb-2 text-[11px] text-teal">{msg}</p>}
      {error && <p className="mb-2 text-[11px] text-alert">Gateway: {error}</p>}
      <ul aria-label="Upcoming alarms and dates" className={`space-y-1.5 overflow-y-auto ${popover ? "max-h-[55vh]" : "min-h-0 flex-1"}`}>
        {upcoming.map((r) => (
          <Row
            key={r.id}
            r={r}
            now={now}
            canPush={canPush && r.source !== "gcal" && !r.gcalId}
            onRemove={() => {
              void cancelOsAlarm(r.id);
              void remove(r.id);
            }}
            onRepeat={(repeat) => void update(r.id, { repeat })}
          />
        ))}
        {!upcoming.length && <li className="py-4 text-center text-xs text-ink-3">Nothing scheduled. Say “Hey Tony, remind me to…”.</li>}
      </ul>
    </div>
  );
}

/** Popover header line: the full date and the clock (the settings' 12/24 h). */
function PopoverClockLine({ now }: { now: number }) {
  const hourCycle = useSettings((s) => s.clock.hourCycle);
  const d = new Date(now);
  const date = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hourCycle });
  return (
    <p className="-mt-1 mb-2 font-mono text-[11px] text-ink-2 tabular" data-testid="reminders-clock-line">
      {date} · {time}
    </p>
  );
}

function Row({ r, now, canPush, onRemove, onRepeat }: { r: Item<Reminder>; now: number; canPush: boolean; onRemove: () => void; onRepeat: (v: Reminder["repeat"]) => void }) {
  const Icon = ICON[r.kind] ?? Bell;
  const soon = r.dueAt - now < 3_600_000 && r.dueAt > now;
  const past = r.dueAt <= now;
  return (
    <li className={`group flex items-center gap-2.5 rounded-[12px] border px-2.5 py-2 ${soon ? "border-amber/40 bg-amber/[0.07]" : "border-white/[0.06] bg-white/[0.02]"} ${past ? "opacity-55" : ""}`}>
      <Icon size={14} className={r.kind === "countdown" ? "text-violet" : r.source === "gcal" ? "text-teal" : "text-amber-soft"} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink">{r.title}</p>
        <p className="truncate font-mono text-[10.5px] text-ink-3">
          {formatWhen(r.dueAt, now)}
          {r.repeat !== "none" && ` · ${r.repeat}`}
          {r.source === "gcal" && " · Google"}
        </p>
      </div>
      <span className={`shrink-0 font-mono text-[12px] tabular ${soon ? "text-amber-light" : "text-ink-2"}`}>{past ? "done" : countdown(r.dueAt, now)}</span>
      <div className="flex shrink-0 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        {r.kind !== "countdown" && r.source !== "gcal" && (
          <button
            aria-label="Cycle repeat"
            title={`Repeat: ${r.repeat}`}
            onClick={() => onRepeat(NEXT_REPEAT[r.repeat])}
            className={`grid size-7 place-items-center rounded-full hover:bg-white/10 ${r.repeat !== "none" ? "text-teal" : "text-ink-3"}`}
          >
            <Repeat size={12} />
          </button>
        )}
        {canPush && (
          <button aria-label="Add to Google Calendar" title="Add to Google Calendar (asks first)" onClick={() => void pushToCalendar(r)} className="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-white/10 hover:text-ink">
            <CalendarPlus size={12} />
          </button>
        )}
        <button aria-label={`Delete ${r.title}`} onClick={onRemove} className="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-white/10 hover:text-alert">
          <Trash2 size={12} />
        </button>
      </div>
    </li>
  );
}

const NEXT_REPEAT: Record<Reminder["repeat"], Reminder["repeat"]> = { none: "daily", daily: "weekdays", weekdays: "weekly", weekly: "monthly", monthly: "none" };

function useCalendarCreate() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    void cmd("n8n_workflows")
      .then((w) => setOk(w.some((x) => x.name === "calendar-create")))
      .catch(() => undefined);
  }, []);
  return ok;
}

/**
 * The n8n `calendar-create` card for a reminder, built directly from the reminder (Nic's own data).
 * Never through `heuristicPlan`: its "add … to my Google Calendar" text is the calendar-add parser's
 * line, whose `plan.run` (Tony's "what date…?" / frozen reply) `execute()` runs first, so the n8n
 * workflow never fired (A2 review). Pure. Re-exported from widgets/reminders/Reminders.tsx.
 */
export function reminderCalendarPlan(r: Pick<Item<Reminder>, "id" | "title" | "dueAt" | "notes">): ActionPlan {
  const when = new Date(r.dueAt);
  return {
    id: crypto.randomUUID(),
    utterance: `add "${r.title}" to my Google Calendar on ${when.toLocaleString()}`,
    role: "booking",
    intent: `add “${r.title}” to your Google Calendar ${formatWhen(r.dueAt)}`,
    summary: `Add “${r.title}” to Google Calendar — ${formatWhen(r.dueAt)}`,
    readBack: `Add ${r.title} to your Google Calendar, ${formatWhen(r.dueAt)}. Proceed?`,
    mutating: true,
    target: { kind: "n8n", workflow: "calendar-create" },
    payload: { reminderId: r.id, title: r.title, start: when.toISOString(), end: new Date(r.dueAt + 30 * 60_000).toISOString(), notes: r.notes ?? "" },
    missing: [],
    verification: { status: "verified", notes: [], by: "built from your own reminder" },
    planner: "heuristic",
    plannerNote: "built from your own reminder",
  };
}

/** Writing to Google Calendar changes something outside this machine → the confirmation gate. */
async function pushToCalendar(r: Item<Reminder>) {
  await requestConfirmation(reminderCalendarPlan(r), "text");
}
