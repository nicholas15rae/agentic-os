/**
 * Security status in the webview + the step-up queue. The store is a view: Rust decides. A
 * refused invoke (`STEP_UP_REQUIRED:<module>`) or gateway 423 lands in `onSecurityRefusal`,
 * which opens the PIN modal and lets the caller retry once after a successful step-up.
 */
import { create } from "zustand";
import { isTauri } from "@/lib/platform";
import { securityApi, parseSecurityError, type SecurityStatus } from "./api";

interface StepUp {
  module: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
}

interface SecurityStore {
  status: SecurityStatus | null;
  stepUp: StepUp | null;
  setStatus: (s: SecurityStatus) => void;
  refresh: () => Promise<SecurityStatus | null>;
  /** Open the PIN modal for `module`; resolves once it's unlocked (rejects on cancel). */
  requestStepUp: (module: string) => Promise<void>;
  finishStepUp: (ok: boolean) => void;
}

export class StepUpCancelled extends Error {
  constructor(module: string) {
    super(`${module} stays read-only (step-up cancelled)`);
  }
}

export const useSecurity = create<SecurityStore>((set, get) => ({
  status: null,
  stepUp: null,
  setStatus: (status) => set({ status }),
  refresh: async () => {
    if (!isTauri()) return null;
    try {
      const status = await securityApi.status();
      set({ status });
      return status;
    } catch {
      return null;
    }
  },
  requestStepUp: (module) => {
    const cur = get().stepUp;
    if (cur && cur.module === module) return cur.promise;
    if (cur) cur.reject(new StepUpCancelled(cur.module));
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    set({ stepUp: { module, promise, resolve, reject } });
    return promise;
  },
  finishStepUp: (ok) => {
    const cur = get().stepUp;
    if (!cur) return;
    set({ stepUp: null });
    if (ok) cur.resolve();
    else cur.reject(new StepUpCancelled(cur.module));
  },
}));

/** Modules with a live elevation right now (per the last status). */
export function elevatedModules(s: SecurityStatus | null, nowSec = Date.now() / 1000): string[] {
  return (s?.modules ?? []).filter((m) => m.elevatedUntil !== null && m.elevatedUntil > nowSec).map((m) => m.module);
}

/**
 * Called by `native()` / `gateway()` with a refusal. Returns true when the caller should retry
 * (a step-up just succeeded); false otherwise (the lock screen takes over on LOCKED).
 */
export async function onSecurityRefusal(raw: string): Promise<boolean> {
  const p = parseSecurityError(raw);
  if (!p) return false;
  if (p.code === "STEP_UP_REQUIRED" && p.arg) {
    await useSecurity.getState().requestStepUp(p.arg);
    return true;
  }
  if (p.code === "LOCKED" || p.code === "HARD_LOCKED") await useSecurity.getState().refresh();
  return false;
}

/** Fresh `X-CC-Elevation` token for a module that is elevated (null when it isn't). */
export async function elevationHeader(module: string): Promise<string | null> {
  if (!isTauri() || !elevatedModules(useSecurity.getState().status).includes(module)) return null;
  try {
    return (await securityApi.elevationToken(module)).token;
  } catch {
    return null;
  }
}
