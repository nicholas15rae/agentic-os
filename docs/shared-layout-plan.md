# Shared layout system and Appearance control centre (plan)

Status: proposed on `section-pass`, waiting for Nic's go-ahead before any page is converted.
Rule: AGENTS.md, "App-Wide Rule: Everything Is Customizable".

## What exists already (home page, sections 6 and 7 of the pass)

| Piece | Where | Reuse |
|---|---|---|
| 12×8 snap grid, push-aside move / resize, 1×1 minimum | `core/widgets/pages.ts` (`placePushing`), `WidgetGrid.tsx` | The engine for every page |
| Named pages: reorder, duplicate, startup page, link to Tony's mode, per-page wallpaper | `pages.ts`, `PageSwitcher.tsx`, `page-links.ts` | "Per page and per mode preset" |
| Per-widget look: frame, font, size, colour, alignment, opacity per wallpaper | `look.ts`, StylePanel | Panel styling |
| Full / compact / icon, pop-up windows (move, resize, several), badges | `WidgetGrid.tsx`, `layout-store.ts` | "Collapse to an icon", "show on demand" |
| Tap to focus, fit-to-cell, legibility over the wallpaper | `WidgetGrid.tsx`, `wall-tone.ts` | Every panel |
| Searchable widget drawer | `WidgetDrawer.tsx` | "Add back" a hidden panel |
| 30-day Trash with Undo | `trash.rs`, `trash.ts` | Removing panels / builds |

## What's missing

1. **The layout is home-page only.** `useLayout` holds one set of pages. Other pages (Agents, Comms, Play Place, Finance, Trading, Settings…) are hand-written flex / grid JSX.
2. **Window options:** free placement (off-grid), click-through, pop-out to a real OS window, pin on top.
3. **Per mode preset:** today a page can *link* to a mode; a layout can't vary *by* mode.
4. **Phone sync:** the phone keeps its own browser storage.
5. **Appearance:** only a glass-opacity slider and a few per-widget looks; colours, radius, fonts, density, shadows and motion are hard-coded in CSS utilities.
6. **Export / import, Reset per page, locked safety controls.**

## Design

### A. `LayoutSurface` (one component, every page)

```tsx
<LayoutSurface surface="playplace" panels={PLAYPLACE_PANELS} defaults={PLAYPLACE_DEFAULT} />
```

- `panels`: the page's building blocks registered as widgets (`defineWidget`, `category: "Play Place"`). Today's cards become panels with no change to what they render (StagingHub, PipelineBars, PlayCards, IdeasLedger…).
- `defaults`: the finished-template layout (what Reset restores).
- The store becomes keyed by surface: `surfaces[surface][modeId | "default"] = PagesState`. The home page is surface `home`; its saved layout migrates in place.
- Same Edit layout toggle, drawer, Look panel, icons and windows as the home page. Long-press (500 ms) on touch enters edit mode.
- `locked: true` panels (kill switch, Tony's stop, confirmation cards) can move but never hide, remove or go click-through.

### B. Window options (per panel)

| Option | How |
|---|---|
| Snap / free | `place: "grid" \| "free"`; free stores a px rect relative to the surface, drawn absolutely above the grid |
| Clickable or not | `clickThrough: true` → `pointer-events: none` (never for locked panels) |
| Pop out | Tauri `WebviewWindow` with `?panel=<surface>/<id>` rendering just that panel; closing returns it |
| Pin on top / on demand | pop-out `alwaysOnTop`; "on demand" = icon mode + window (exists) |
| Collapse to icon | exists (display: icon) |

### C. Per mode and phone

- Layout key = (surface, mode). A mode with no layout of its own uses the default one; "Customize for this mode" copies it.
- Phone sync: the desktop pushes layouts and themes to the gateway (`/api/cc/ui-state`, one JSON per surface); the phone pulls them and keeps its compact column order, icons and looks (it ignores grid positions it can't show).

### D. Appearance control centre (Settings → Appearance)

- Theme = design tokens as CSS variables: colours and accents, glass alpha and blur, card style (glass / solid / outline), border width and colour, corner radius, shadow depth, font family and scale, spacing and density, icon set and stroke, widget default look, motion (on / reduced / off, speed).
- Components read tokens (`var(--cc-radius)` etc.); the utilities in `styles/index.css` (`glass`, `pill-glass`, `field`…) move onto the tokens, so one change restyles the app.
- Live preview (a sample page rendered with the draft theme), app-wide values with per-page overrides, saved themes, Reset to default.
- This is also the **style kit** from step 8: generated widgets get the same tokens injected into their iframe, and the Designer is told to use them.

### E. Export / import

One JSON file (`agentic-os-ui.json`): `{ version, themes, activeTheme, surfaces }`, validated and sanitised on import (unknown panels dropped, locked panels forced visible), with a backup of the current state before applying.

## Order of work (each step tested and committed on its own)

1. **Shared engine:** extract `LayoutSurface` from `WidgetGrid`; store keyed by surface and mode; migrate the home page; Reset per page; long-press; locked panels. (L)
2. **Appearance tokens + control centre + saved themes + export / import.** (L) This is also the style kit.
3. **Widget builder (step 8):** brief checklist, routing described widgets into the pipeline, style-kit tokens in generated widgets; the fortune-cookie end-to-end test. (M)
4. **Convert pages one at a time:** Play Place → Agents → Comms → Operations → Finance → Trading → Settings → the rest. (M each)
5. **Window options:** free placement, click-through, pop-out windows, pin on top. (M)
6. **Phone sync** of layouts and themes. (M)

## Decisions (Nic, 2026-11-27)

- Order: as above (engine, Appearance/style kit, builder, pages one by one, window options, phone sync).
- Pop-out: native Tauri windows per popped-out panel (pin on top possible).
- Per mode: every mode uses the page's shared default layout until "Customize for this mode".
- Section 7 "hold-to-switch": press and hold Tony's button (or the phone shortcut) to pick a mode instead of talking. It uses the same mode list and, where a page is linked to a mode, the same page switch.
- Plan approved with two additions:
  1. **Reset to default comes first**, before any page is converted: per page (Reset this page, Reset all pages, Undo) in step 1, and at the token / theme level as the first part of step 2.
  2. **Safety controls are locked from the start** (step 1): the trading kill switch, Tony's stop / interrupt and the send confirmations can't be hidden, moved off-screen, made click-through or styled invisible.
- Commit after each step and update STATUS.md.

## Step 1 as built

- `createLayoutStore(spec)` / `surfaceStore(spec)` (`core/widgets/layout-store.ts`): one store per surface, home stays `cc.layout`, others `cc.layout.<surface>`.
- `LayoutSurface` + `LayoutControls` (`core/widgets/LayoutSurface.tsx`): the grid from a context (`surface-context.ts`); the top bar's edit toggle acts on the page on screen; press and hold (500 ms, touch) enters edit mode.
- Per-mode layouts (`variants.ts`): shared until "Customize for <mode>", "Use the shared layout" drops the copy; `page-links.ts` applies the mode to every surface.
- Reset: Reset this page, Reset all pages, Undo reset (this session).
- Locks: `locked` widgets (`locks.ts`) can move and resize but are never removed, made an icon, moved to another page, deleted with their page, recoloured or shrunk below 90 %, click-through or off-screen; lost ones are put back on load. The real controls carry `data-safety` (`lib/safety.ts`) and a CSS rule keeps them visible, opaque and clickable whatever a theme sets.

## Step 2 as built

- Tokens (`features/appearance/theme.ts`): accents, background, three text colours, card opacity / blur / style, border width and brightness, corner radius, shadow, font, text size, spacing, icon weight, default widget frame, motion. Defaults are exactly the shipped look.
- Applied as CSS variables on `<html>` (`install.ts`, from `main.tsx`); Tailwind's `--color-*`, `--font-sans`, `--spacing` are overridden directly. Every `text-[Npx]` / `rounded-[Npx]` became `fs-N` / `r-N` (scaled by the text size / radius tokens).
- Settings → Appearance (`AppearanceStudio.tsx`): Reset to default first (with Undo), per-page Reset, per-token ↺, themes (4 built in, save / update / rename / delete), app-wide or one page, live preview.
- Readability guard: text and accent colours are checked against the cards they sit on (and the background) and fall back one by one.
- Safety controls: `[data-safety]` re-declares every default token, so no theme restyles them.
- Motion Off / Reduced also drives the canvas loops (`lib/motion.ts`).
- Export / import `agentic-os-ui.json` (`ui-file.ts`): layouts of every surface and mode + themes; desktop saves through a native Save dialog (`ui_file_save`, Rust writes only where you pick); import is validated, drops unknown widgets, keeps safety controls, backs up first ("Restore what was there before").

## Step 3 as built (widget builder)

- "Describe a widget" (home tray): an interactive or multi-point description becomes an editable checklist (`features/buildhub/brief-points.ts`, `BriefChecklistCard.tsx`) on the desktop; "Build it" stages an internal-widget Play Place build behind the confirmation card, every point an acceptance criterion; "Quick card instead" keeps the template generator.
- Rust (`taskworker.rs`): `contract_criteria` / `build_criteria` pin the brief's points first for the Coder, the audit and the verifier (each must be proven in a real browser); the spec's own criteria fill what is left.
- Style kit: `STYLE_KIT` in the design and code prompts of dashboard widgets (CSS variables + a `cc-theme` listener); `SandboxFrame` posts the live theme (`styleKitVars`) into the widget, `--cc-page` transparent on the dashboard tile, dark in previews.
- Fortune cookie: checklist split, envelope and pinned verify plan tested; the five points probed in a real headless Edge (a correct page passes all five, a broken one fails exactly its two broken points). A live build with the models is still to run (needs the app rebuilt from this branch).
