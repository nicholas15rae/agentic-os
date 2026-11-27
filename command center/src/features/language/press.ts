/**
 * Tap / hold logic for the big record buttons, kept pure so the event order a phone produces can
 * be tested. A tap fires down → up → click; the mic needs a second or two to open, so the click
 * that follows a starting tap must NOT stop it (it used to: "Nothing recorded — hold the phone
 * closer", while the real capture ran on to the 90 s cap).
 *   - tap (≤ 400 ms) starts and keeps recording; the next tap stops
 *   - hold (> 400 ms) records while held and stops on release
 *   - keyboard (click with detail 0, no pointer events) toggles
 */
export interface PressDeps {
  recording: () => boolean;
  busy: () => boolean;
  onStart: () => void;
  onStop: () => void;
  now?: () => number;
}

export function pressHandlers(d: PressDeps) {
  const now = d.now ?? (() => performance.now());
  let press: { at: number; started: boolean } | null = null;
  let swallowClick = false;
  return {
    down() {
      press = { at: now(), started: !d.recording() && !d.busy() };
      if (press.started) d.onStart();
    },
    up() {
      const p = press;
      press = null;
      if (!p?.started) return;
      swallowClick = true;
      if (now() - p.at > 400) d.onStop();
    },
    cancel() {
      press = null;
    },
    click(detail: number) {
      if (detail === 0) return d.recording() ? d.onStop() : d.busy() ? undefined : d.onStart();
      if (swallowClick) {
        swallowClick = false;
        return;
      }
      if (d.recording()) d.onStop();
    },
  };
}
