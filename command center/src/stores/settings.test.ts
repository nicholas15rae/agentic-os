import { describe, expect, it } from "vitest";
import { deepMergeDefaults, MEDIA_DUCK_DEFAULTS, migrateSettings, useSettings } from "./settings";

describe("deepMergeDefaults", () => {
  const defaults = {
    brainstorm: { autoOrganizeEvery: 6, listenProfile: "relaxed" as const },
    vad: { sensitivity: 60, endSilenceMs: 700, maxUtteranceMs: 15000 },
    wakeWords: ["hey tony"],
    weatherLocation: null as { lat: number; lon: number; label: string } | null,
    osName: "Tony",
  };

  it("backfills a missing nested key without touching sibling keys the persisted object already has", () => {
    // Simulates a pre-v5 persisted `brainstorm` object that predates `listenProfile`.
    const persisted = { brainstorm: { autoOrganizeEvery: 9 } };
    const merged = deepMergeDefaults(persisted, defaults);
    expect(merged.brainstorm).toEqual({ autoOrganizeEvery: 9, listenProfile: "relaxed" });
  });

  it("leaves a persisted value in place when it differs from the default", () => {
    const persisted = { vad: { sensitivity: 80, endSilenceMs: 700, maxUtteranceMs: 15000 } };
    const merged = deepMergeDefaults(persisted, defaults);
    expect(merged.vad.sensitivity).toBe(80);
  });

  it("takes an array from the persisted side as-is (arrays replace wholesale, not element-merge)", () => {
    const persisted = { wakeWords: ["yo"] };
    const merged = deepMergeDefaults(persisted, defaults);
    expect(merged.wakeWords).toEqual(["yo"]);
  });

  it("keeps an explicit null from the persisted side rather than overwriting it with the default", () => {
    const persisted = { weatherLocation: null };
    const merged = deepMergeDefaults(persisted, defaults);
    expect(merged.weatherLocation).toBeNull();
  });

  it("fills in an entire missing top-level object", () => {
    const persisted = { osName: "Tony" };
    const merged = deepMergeDefaults(persisted, defaults);
    expect(merged.brainstorm).toEqual(defaults.brainstorm);
  });

  it("returns the defaults untouched when nothing was persisted", () => {
    expect(deepMergeDefaults(null, defaults)).toEqual(defaults);
    expect(deepMergeDefaults(undefined, defaults)).toEqual(defaults);
  });

  it("is idempotent — merging the already-merged result again changes nothing", () => {
    const once = deepMergeDefaults({ brainstorm: { autoOrganizeEvery: 9 } }, defaults);
    const twice = deepMergeDefaults(once, defaults);
    expect(twice).toEqual(once);
  });
});

describe("useSettings defaults (v5)", () => {
  it("defaults the new brainstorm.listenProfile to relaxed", () => {
    expect(useSettings.getState().brainstorm.listenProfile).toBe("relaxed");
  });
});

describe("settings v6 migration (P4: spotifyDuck → mediaDuck)", () => {
  it("keeps enabled / onWakeListen, forces BY 15 %, and drops the old absolute level", () => {
    const v5 = { conversation: { followUp: true, followUpSecs: 6, bargeIn: false, bargeEndSilenceMs: 500, audioRoute: "speakers", spotifyDuck: { enabled: false, level: 25, restoreMs: 4000, onWakeListen: false } } };
    const s = migrateSettings(v5, 5);
    const c = s.conversation as unknown as Record<string, unknown>;
    expect(c.spotifyDuck).toBeUndefined();
    expect(s.conversation.mediaDuck).toEqual({ ...MEDIA_DUCK_DEFAULTS, enabled: false, onWakeListen: false, reductionPct: 15 });
    expect(s.conversation.mediaDuck).not.toHaveProperty("level");
    expect(s.conversation.bargeIn).toBe(false); // siblings untouched
    expect(s.conversation.audioRoute).toBe("speakers");
    // …and the load-time deep merge leaves it that way.
    const merged = deepMergeDefaults(s, useSettings.getState());
    expect(merged.conversation.mediaDuck.reductionPct).toBe(15);
    expect(merged.conversation.mediaDuck).not.toHaveProperty("level");
    expect(merged.conversation).not.toHaveProperty("spotifyDuck");
  });

  it("a partial old duck object still migrates; a missing one is backfilled by the merge", () => {
    expect(migrateSettings({ conversation: { spotifyDuck: { level: 10 } } }, 5).conversation.mediaDuck).toEqual(MEDIA_DUCK_DEFAULTS);
    const none = migrateSettings({ conversation: { followUp: false } }, 5);
    expect(deepMergeDefaults(none, useSettings.getState()).conversation.mediaDuck).toEqual(MEDIA_DUCK_DEFAULTS);
    expect(migrateSettings(undefined, 5)).toEqual({});
  });

  it("v6 data is left alone; a fresh install gets BY 15 %", () => {
    const v6 = { conversation: { mediaDuck: { ...MEDIA_DUCK_DEFAULTS, reductionPct: 35 } } };
    expect(migrateSettings(v6, 6).conversation.mediaDuck.reductionPct).toBe(35);
    expect(useSettings.getState().conversation.mediaDuck).toEqual({ enabled: true, reductionPct: 15, restoreMs: 800, onWakeListen: true, webApiFallback: true });
    expect(useSettings.getState().conversation).not.toHaveProperty("spotifyDuck");
  });
});

describe("settings v8 (top-bar clock + weather effects)", () => {
  it("resets a saved manual atmosphere to Live once, for any older snapshot", () => {
    expect(migrateSettings({ weatherMode: "rain" }, 7).weatherMode).toBe("auto");
    expect(migrateSettings({ weatherMode: "snow", osName: "Tony" }, 3).weatherMode).toBe("auto");
    expect(migrateSettings({ weatherMode: "rain", osName: "Tony" }, 7).osName).toBe("Tony"); // siblings untouched
  });

  it("leaves a v8 manual pick alone (the reset runs once only)", () => {
    expect(migrateSettings({ weatherMode: "rain" }, 8).weatherMode).toBe("rain");
  });

  it("does not invent a weatherMode for an empty snapshot", () => {
    expect(migrateSettings(undefined, 7)).toEqual({});
    expect(migrateSettings({}, 7)).not.toHaveProperty("weatherMode");
  });

  it("defaults: effects on at normal, 12-hour clock with date and temperature", () => {
    const s = useSettings.getState();
    expect(s.effects).toEqual({ enabled: true, intensity: "normal" });
    expect(s.clock).toEqual({ hourCycle: "h12", showDate: true, showTemp: true });
    expect(s.weatherMode).toBe("auto");
  });

  it("an old snapshot without effects / clock gets them backfilled; partial objects keep their values", () => {
    const old = migrateSettings({ weatherMode: "fog", osName: "Tony" }, 7);
    const merged = deepMergeDefaults(old, useSettings.getState());
    expect(merged.effects).toEqual({ enabled: true, intensity: "normal" });
    expect(merged.clock).toEqual({ hourCycle: "h12", showDate: true, showTemp: true });
    const partial = deepMergeDefaults({ clock: { hourCycle: "h23" }, effects: { enabled: false } } as never, useSettings.getState());
    expect(partial.clock).toEqual({ hourCycle: "h23", showDate: true, showTemp: true });
    expect(partial.effects).toEqual({ enabled: false, intensity: "normal" });
  });
});

describe("v9: Agent Chatter off by default", () => {
  it("is off for a fresh install and reset once for an existing one", () => {
    expect(useSettings.getInitialState?.().routing.vocalHandoffs ?? false).toBe(false);
    const s = migrateSettings({ routing: { announcerHandoff: true, vocalHandoffs: true } }, 8);
    expect(s.routing).toEqual({ announcerHandoff: true, vocalHandoffs: false });
    // Turned back on after v9: kept.
    expect(migrateSettings({ routing: { announcerHandoff: true, vocalHandoffs: true } }, 9).routing.vocalHandoffs).toBe(true);
  });
});
