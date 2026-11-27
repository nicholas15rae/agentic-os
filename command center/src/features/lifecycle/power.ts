/**
 * Power controls on the rail (Section 19): Standby hides the window to the tray (same as the
 * window's X) and everything keeps running; Exit is the full shutdown, and the phone loses Tony
 * until the Command Center starts again (the gateway stays up, but phone turns wait for this
 * app to claim them). Pure: unit-tested.
 */

export const STANDBY_TITLE = "Standby: hide to the tray. Tony, the gateway, the model, STT, trading, backups and scheduled jobs keep running (same as the window's X).";

export const EXIT_TITLE = "Exit: shut Tony down completely (the phone loses Tony until you start the Command Center again)";

/** The Exit confirm: always asked, with what a quit would interrupt mid-commit. */
export function exitConfirmText(busy: string[]): string {
  const head =
    "Exit shuts Tony down completely.\n\nYour phone loses Tony until the Command Center starts again: the gateway stays up, but phone turns wait for this app.\n\nTo hide the window and keep everything running, cancel and use Standby instead.";
  if (!busy.length) return head;
  return `${head}\n\nExiting now would also interrupt:\n\n• ${busy.join("\n• ")}\n\nInterrupted builds resume from their last checkpoint next launch.`;
}
