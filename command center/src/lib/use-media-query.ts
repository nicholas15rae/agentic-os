import { useSyncExternalStore } from "react";
import { PHONE_LITE } from "./phone-lite";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Reduced motion: the OS setting, and always in the Android app (phone performance mode). */
export const usePrefersReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)") || PHONE_LITE;
