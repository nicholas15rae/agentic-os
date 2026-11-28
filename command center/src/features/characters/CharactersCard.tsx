import { Card } from "@/components/ui";
import { useCharacters } from "./character-store";
import { CHARACTERS } from "./roster";
import { DRAWINGS } from "./drawings";
import { CORNERS, FREQUENCIES, FREQUENCY_LABEL, type Corner } from "./logic";

const CORNER_LABEL: Record<Corner, string> = { br: "Bottom right", bl: "Bottom left", tr: "Top right", tl: "Top left" };

/** Settings → Appearance → Live characters: show / hide, mute, how often, and each one's corner. */
export function CharactersCard() {
  const visible = useCharacters((s) => s.visible);
  const muted = useCharacters((s) => s.muted);
  const frequency = useCharacters((s) => s.frequency);
  const chars = useCharacters((s) => s.chars);
  const S = useCharacters.getState();
  const seg = (on: boolean) => `rounded-full border px-2.5 py-1 fs-11 ${on ? "border-teal/60 bg-teal/15 text-teal" : "border-white/10 text-ink-2 hover:text-ink"}`;
  return (
    <Card
      title="Live characters"
      hint="Small characters tucked in a corner over the app. They pop up when you get something done (and on streaks), or when you tap them. They never take a click meant for the page and never sit on a safety control. Right-click or press and hold one for Mute / Hide."
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-40 shrink-0 fs-12 text-ink-2">Show characters</span>
          <button role="switch" aria-checked={visible} onClick={() => S.setVisible(!visible)} className={seg(visible)}>
            {visible ? "On" : "Off"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-40 shrink-0 fs-12 text-ink-2">Pop-ups</span>
          <button role="switch" aria-checked={!muted} onClick={() => S.setMuted(!muted)} className={seg(!muted)} title="Muted: they stay in their corner; taps still work">
            {muted ? "Muted" : "On"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-40 shrink-0 fs-12 text-ink-2">How often</span>
          <div role="group" aria-label="How often characters pop up on their own" className="flex flex-wrap gap-1.5">
            {FREQUENCIES.map((f) => (
              <button key={f} aria-pressed={frequency === f} onClick={() => S.setFrequency(f)} className={seg(frequency === f)}>
                {FREQUENCY_LABEL[f]}
              </button>
            ))}
          </div>
        </div>
        {CHARACTERS.map((c) => {
          const Drawing = DRAWINGS[c.id];
          const p = chars[c.id] ?? { on: true, corner: c.corner };
          return (
            <div key={c.id} className="flex flex-wrap items-center gap-3 r-12 border border-white/[0.06] bg-white/[0.02] p-2.5">
              <span className="size-10 shrink-0">{Drawing && <Drawing title={c.name} />}</span>
              <span className="min-w-0 flex-1">
                <span className="block fs-13 text-ink">{c.name}</span>
                <span className="block fs-11 text-ink-3">{c.description}</span>
              </span>
              <button role="switch" aria-checked={p.on} aria-label={`Show ${c.name}`} onClick={() => S.setChar(c.id, { on: !p.on })} className={seg(p.on)}>
                {p.on ? "On" : "Off"}
              </button>
              <select className="field !h-8 !w-auto !py-0 fs-12" value={p.corner} onChange={(e) => S.setChar(c.id, { corner: e.target.value as Corner })} aria-label={`${c.name}'s corner`}>
                {CORNERS.map((k) => (
                  <option key={k} value={k}>
                    {CORNER_LABEL[k]}
                  </option>
                ))}
              </select>
              <button className="pill-glass !h-8 !px-3 fs-12" onClick={() => S.tap(c.id)} disabled={!visible || !p.on} title="Make it pop up now">
                Try it
              </button>
            </div>
          );
        })}
        <button className="pill-glass !h-9 fs-13" onClick={() => S.reset()} title="Shown, pop-ups on, now and then, each in its own corner">
          Reset characters
        </button>
      </div>
    </Card>
  );
}
