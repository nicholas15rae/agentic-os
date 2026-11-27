import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isTauri, onNativeEvent } from "@/lib/platform";
import { ocmd } from "./api";
import { keepActive } from "./logic";
import type { Business, ReviewDigestEvent, ReviewList } from "./types";

interface OpsState {
  businesses: Business[];
  /** The Business Switcher's selection; rides on every OS turn as `activeBusinessId`. */
  activeBusinessId: string | null;
  review: ReviewList | null;
  /** Set by a `review-digest` event; cleared when the Review Queue is opened. */
  digestUnseen: boolean;
  error: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
  refreshReview: () => Promise<void>;
  setActive: (id: string | null) => void;
  markDigestSeen: () => void;
}

export const useOps = create<OpsState>()(
  persist(
    (set, get) => ({
      businesses: [],
      activeBusinessId: null,
      review: null,
      digestUnseen: false,
      error: null,
      loaded: false,
      refresh: async () => {
        if (!isTauri()) return;
        try {
          const { businesses } = await ocmd("business_list");
          set({ businesses, activeBusinessId: keepActive(get().activeBusinessId, businesses), error: null, loaded: true });
        } catch (e) {
          set({ error: String(e), loaded: true });
        }
      },
      refreshReview: async () => {
        if (!isTauri()) return;
        try {
          set({ review: await ocmd("review_list") });
        } catch (e) {
          set({ error: String(e) });
        }
      },
      setActive: (id) => set({ activeBusinessId: id && get().businesses.some((b) => b.businessId === id && b.status === "active") ? id : null }),
      markDigestSeen: () => set({ digestUnseen: false }),
    }),
    { name: "cc.ops", version: 1, partialize: ({ activeBusinessId }) => ({ activeBusinessId }) },
  ),
);

/** The id the next OS turn is locked to (undefined = resolve from the text). */
export function activeBusinessForTurn(): string | undefined {
  return useOps.getState().activeBusinessId ?? undefined;
}

let booted = false;
/** Load once and follow `review-digest` events (App boot). */
export function bootOps(): void {
  if (booted || !isTauri()) return;
  booted = true;
  void useOps.getState().refresh();
  void useOps.getState().refreshReview();
  void onNativeEvent<ReviewDigestEvent>("review-digest", () => {
    useOps.setState({ digestUnseen: true });
    void useOps.getState().refreshReview();
  });
}
