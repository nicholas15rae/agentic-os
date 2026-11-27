// RemindersPanel.contract.ts — LOCKED 2026-11-26 (approved by Nic: all recommended defaults; decision 34 = list only). Changes need a new approval.
// Scope: build plan Section 4 step 8. Implemented in part 2; this file is the spec.
// IPC / HTTP / events: NONE new. The gateway collection "reminders" via useCollection (/api/cc/c/reminders) only;
// "Add to Google Calendar" still goes through requestConfirmation (the ConfirmCard), unchanged.

/** The body of the "Alarms & key dates" widget, extracted so the top-bar clock popover can show it too. */
export interface RemindersPanelProps {
  /** "widget": today's widget, identical behaviour. "popover": the list gets max-h-[55vh] overflow-y-auto, header shows
   *  the full date and the clock. */
  variant: "widget" | "popover";
  /** Popover only: called after an action that should close it (none today besides Escape / outside click). */
  onDone?: () => void;
}
// widgets/reminders/Reminders.tsx default export becomes `() => <RemindersPanel variant="widget" />`.
// reminderCalendarPlan stays exported from widgets/reminders/Reminders.tsx (Reminders.test.ts imports it).
// MiniMonth / dayMarks: NOT built (decision 34). Both views share one useCollection store (polling de-duplicated).
