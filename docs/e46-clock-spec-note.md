# E46 clock faces — spec note for Play Place

Paste everything between the two lines below into a new Brainstorm note titled **E46 clock faces**. Then select it together with the original Nov 22, 10:48 PM note and push both to Play Place on the Claude Code lane. Keep the note under 2,800 characters, because longer notes get cut off at the end.

---
E46 clock faces. One self-contained HTML file, an internal desktop widget, frameless. The wallpaper must show through: no card, no border, no background fill.

Five faces, one visible at a time:
1. E46: inspired by a 2000s German sports-sedan instrument cluster. Black dial, white-on-black ticks, a thin red needle, and a classic orange (#FF7A1A) glow on the numerals plus a small orange LCD strip with the digital time. No car-maker logos or badges.
2. Classic: a clean analog dial with hour, minute and second hands.
3. Minimal: a thin ring, two hands, no numerals.
4. LCD: a 7-segment digital readout.
5. Stacked: large hours over minutes, with the date underneath.

Settings (gear button at the TOP-RIGHT, panel anchored right; the tile's Fix pill sits top-left):
- face buttons
- accent colour (default #FF7A1A)
- font: System, Consolas, Georgia, Segoe UI
- 24-hour toggle (default 12-hour)
Choices last for the session only. Wrap every storage call in try/catch, because the sandbox blocks storage.

Behaviour: tick aligned to the wall-clock second (setTimeout to the next second, not a drifting setInterval). Scale to the tile from 2x2 to 6x4 using SVG viewBox. Controls appear only on hover or keyboard focus. Keep CPU low: no canvas loops and no blur filters on the moving hands.

Style: dark glass to match the app. Text colour rgba(255,255,255,.9), muted rgba(255,255,255,.55), amber accent for actions, 8px radius on the settings panel.

Colours as JS constants or SVG attributes, not only in CSS. The html and body elements carry an inline style="background:transparent".

ID CONTRACT (exact ids, keep these):
#face-e46 #face-classic #face-minimal #face-lcd #face-stack (the visible face has class is-active)
#btn-e46 #btn-classic #btn-minimal #btn-lcd #btn-stack (the pressed button has class is-active)
#e46-lcd (HH:MM) #time-digital (gets class font-<id>, e.g. font-consolas) #time-ampm (empty in 24h)
#btn-settings #panel-settings (class is-open when shown)
#inp-accent #accent-value (shows the hex) #sel-font #chk-24h
---

## Acceptance criteria (paste these 9 lines in the Play Place interview)

1. Clicking #btn-e46, #btn-classic, #btn-minimal, #btn-lcd or #btn-stack gives the matching face class is-active and only one face has it
2. On load #face-e46 has class is-active
3. #e46-lcd shows the time as HH:MM
4. After setting #inp-accent to #00ff00, #accent-value reads #00ff00
5. After choosing Consolas in #sel-font, #time-digital has class font-consolas
6. After clicking #chk-24h, #time-ampm is empty
7. The html and body elements carry an inline style background:transparent
8. #panel-settings gets class is-open only after #btn-settings is clicked
9. With storage blocked the page loads with no errors

## How to queue it

1. Brainstorm → create the note above.
2. Select both notes (this one and the Nov 22 note) → **Push to Play Place**.
3. Change the title from "E46 clock faces (+1)" to "E46 clock faces".
4. In the interview, answer **Internal widget** and **single HTML file**, then paste the 9 criteria.
5. Approve the card, then approve the **Claude Code** run.
6. If the build fails, use Fix note or Re-queue. Never press Delete: it removes the folder permanently.

The orange glow and the absence of logos are checked by eye.
