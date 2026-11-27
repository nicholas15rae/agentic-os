import { RemindersPanel } from "@/features/reminders/RemindersPanel";
import type { WidgetProps } from "@/core/widgets/types";

// The body lives in features/reminders/RemindersPanel.tsx (shared with the top-bar clock popover).
// reminderCalendarPlan stays importable from here (Reminders.test.ts).
export { reminderCalendarPlan } from "@/features/reminders/RemindersPanel";

export default function Reminders({ setBadge }: Partial<WidgetProps>) {
  // App-icon badge: how many are coming up (section pass).
  return <RemindersPanel variant="widget" onCount={setBadge ? (n) => setBadge(n ? String(n) : null) : undefined} />;
}
