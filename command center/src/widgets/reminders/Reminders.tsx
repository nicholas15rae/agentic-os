import { RemindersPanel } from "@/features/reminders/RemindersPanel";

// The body lives in features/reminders/RemindersPanel.tsx (shared with the top-bar clock popover).
// reminderCalendarPlan stays importable from here (Reminders.test.ts).
export { reminderCalendarPlan } from "@/features/reminders/RemindersPanel";

export default function Reminders() {
  return <RemindersPanel variant="widget" />;
}
