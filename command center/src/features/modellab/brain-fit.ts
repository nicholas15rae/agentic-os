/**
 * Will a Model Lab model fit the 12 GB card as Tony's brain? `fit` comes from Rust
 * (modellab.rs `fit_context`): "fits", "tight" or "spills to RAM — slow". `model_use` refuses a
 * model that isn't a comfortable fit with `FIT_WARN:<kind>: <why>` unless `force` is passed,
 * which the UI only does after an explicit confirm. Pure: unit-tested.
 */
export type FitKind = "fits" | "tight" | "spills";

export function fitKind(fit: string): FitKind {
  if (fit === "fits") return "fits";
  if (fit === "tight") return "tight";
  return "spills";
}

/** Short badge for the Model Lab table: "fits · 16k", "TIGHT · 8k", "WON'T FIT · 4k (spills to RAM)". */
export function fitBadge(fit: string, context: number): { text: string; tone: "ok" | "warn" | "bad"; title: string } {
  const k = Math.round(context / 1024);
  switch (fitKind(fit)) {
    case "fits":
      return { text: `fits · ${k}k`, tone: "ok", title: `Weights and a ${k}k context stay inside VRAM.` };
    case "tight":
      return { text: `TIGHT · ${k}k`, tone: "warn", title: `Only fits at a ${k}k context; longer chats slow down or spill into system RAM. Using it for Tony asks first.` };
    default:
      return { text: `WON'T FIT · ${k}k`, tone: "bad", title: "Spills into system RAM even at a small context: every answer crawls. Using it for Tony asks first." };
  }
}

export interface FitWarning {
  kind: "tight" | "spills" | "unknown";
  message: string;
}

/** `FIT_WARN:<kind>: <message>` from `model_use` → the parts; anything else → null. */
export function parseFitWarning(e: unknown): FitWarning | null {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  const m = /^FIT_WARN:(tight|spills|unknown):\s*(.*)$/s.exec(s);
  return m ? { kind: m[1] as FitWarning["kind"], message: m[2] } : null;
}

/** The confirm text before forcing the switch. */
export function fitConfirmText(w: FitWarning): string {
  const head = w.kind === "unknown" ? "Can't confirm this model fits the GPU." : w.kind === "tight" ? "This model is a tight fit on the GPU." : "This model won't fit the GPU.";
  return `${head}\n\n${w.message}.\n\nMake it Tony's brain anyway?`;
}
