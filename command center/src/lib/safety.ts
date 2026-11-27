/**
 * App-wide rule: safety controls can't be hidden or removed. Every one carries `data-safety`;
 * `styles/index.css` forces it visible, opaque and clickable whatever a layout, look, theme or
 * import says, and `lib/safety.test.ts` checks each control still carries its mark.
 */
export const SAFETY_CONTROLS = {
  "kill-switch": "Outbound kill switch (top bar)",
  "trading-estop": "Trading kill switch / E-stop",
  "tony-stop": "Tony's stop / interrupt",
  "confirm-card": "Send and action confirmation cards",
} as const;

export type SafetyControl = keyof typeof SAFETY_CONTROLS | "panel";

/** Spread onto the control's root element: `<button {...safety("tony-stop")}>`. */
export const safety = (id: SafetyControl) => ({ "data-safety": id });
