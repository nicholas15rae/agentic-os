import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "@/stores/settings";
import { describeWmo, parseOpenMeteo, resolveAtmosphere, startWeatherRefresh, useWeather, weatherUrl } from "./weather-store";

const sec = (iso: string) => Date.parse(iso) / 1000;

/** Toronto on Thursday 2026-11-26 (EST, UTC-5): snow today, 7 days. daily.time = local midnight in epoch seconds. */
const toronto = {
  utc_offset_seconds: -18_000,
  current: { temperature_2m: -2.4, weather_code: 73, wind_speed_10m: 14.2, is_day: 1 },
  daily: {
    time: ["2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"].map((d) => sec(`${d}T05:00:00Z`)),
    weather_code: [73, 3, 1, 61, 0, 95, 45],
    temperature_2m_max: [1, 2, 3, 4, 5, 6, 7],
    temperature_2m_min: [-4, -3, -2, -1, 0, 1, 2],
    precipitation_probability_max: [60, 10, null, 80, 0, 90, 5],
    sunrise: [sec("2026-11-26T12:15:00Z"), null, null, null, null, null, null],
    sunset: [sec("2026-11-26T21:44:00Z"), null, null, null, null, null, null],
  },
};

describe("describeWmo (mapping kept as is; code 1 relabelled)", () => {
  const cases: [number, string, string, string][] = [
    // code, day label/atmosphere, night atmosphere
    [0, "Clear", "clear", "midnight"],
    [1, "Mainly clear", "clear", "midnight"],
    [2, "Partly cloudy", "autumn", "midnight"],
    [3, "Overcast", "autumn", "midnight"],
    [45, "Fog", "fog", "fog"],
    [48, "Fog", "fog", "fog"],
    [51, "Drizzle", "rain", "rain"],
    [56, "Drizzle", "rain", "rain"],
    [57, "Drizzle", "rain", "rain"],
    [61, "Rain", "rain", "rain"],
    [66, "Rain", "rain", "rain"],
    [67, "Rain", "rain", "rain"],
    [71, "Snow", "snow", "snow"],
    [77, "Snow", "snow", "snow"],
    [80, "Showers", "rain", "rain"],
    [82, "Showers", "rain", "rain"],
    [85, "Snow showers", "snow", "snow"],
    [86, "Snow showers", "snow", "snow"],
    [95, "Thunderstorm", "rain", "rain"],
    [96, "Thunderstorm", "rain", "rain"],
    [99, "Thunderstorm", "rain", "rain"],
    [42, "—", "clear", "clear"],
  ];
  it.each(cases)("code %i", (code, label, day, night) => {
    expect(describeWmo(code, true)).toEqual({ label, atmosphere: day });
    expect(describeWmo(code, false).atmosphere).toBe(night);
  });
  it("night labels for clear skies", () => {
    expect(describeWmo(0, false).label).toBe("Clear night");
    expect(describeWmo(1, false).label).toBe("Mainly clear");
  });
});

describe("weatherUrl", () => {
  it("asks for 7 days and the daily list in the same call", () => {
    const u = weatherUrl(43.6532, -79.3832);
    expect(u).toContain("latitude=43.653&longitude=-79.383");
    expect(u).toContain("forecast_days=7");
    expect(u).toContain("daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset");
    expect(u).toContain("current=temperature_2m,weather_code,wind_speed_10m,is_day");
    expect(u).toContain("timezone=auto&timeformat=unixtime");
    expect(weatherUrl(0, 0, 3)).toContain("forecast_days=3");
  });
});

describe("parseOpenMeteo", () => {
  it("parses current conditions and 7 days (unixtime → ms)", () => {
    const at = Date.parse("2026-11-26T15:00:00Z");
    const { now, forecast } = parseOpenMeteo(toronto, "Toronto", at);
    expect(now).toMatchObject({ tempC: -2.4, windKph: 14.2, code: 73, isDay: true, label: "Snow", atmosphere: "snow", place: "Toronto", fetchedAt: at });
    expect(now.sunrise).toBe(Date.parse("2026-11-26T12:15:00Z"));
    expect(now.sunset).toBe(Date.parse("2026-11-26T21:44:00Z"));
    expect(forecast).toHaveLength(7);
    expect(forecast[0]).toMatchObject({ date: "2026-11-26", weekday: "Thu", dayStart: Date.parse("2026-11-26T05:00:00Z"), code: 73, label: "Snow", atmosphere: "snow", maxC: 1, minC: -4, precipPct: 60 });
    expect(forecast.map((d) => d.weekday)).toEqual(["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"]);
    expect(forecast[2]).toMatchObject({ label: "Mainly clear", precipPct: null });
    expect(forecast[1].atmosphere).toBe("autumn"); // forecast days use the day mapping
  });

  it("dates follow the location's UTC offset, not the machine's", () => {
    // Tokyo (UTC+9): local midnight of Fri 27 Nov is 26 Nov 15:00 UTC. Read in UTC-5 it would say Thursday.
    const tokyo = { ...toronto, utc_offset_seconds: 32_400, daily: { ...toronto.daily, time: [sec("2026-11-26T15:00:00Z"), sec("2026-11-27T15:00:00Z")] } };
    const { forecast } = parseOpenMeteo(tokyo, "Tokyo", 0);
    expect(forecast.map((d) => [d.date, d.weekday])).toEqual([["2026-11-27", "Fri"], ["2026-11-28", "Sat"]]);
  });

  it("keeps the right day across a DST change inside the 7 days (spring 2026-03-08, fall 2026-11-01)", () => {
    // Fetched Thu 5 Mar 2026 in EST (-5 h). From Sun 8 Mar, local midnight is 04:00 UTC (EDT).
    const spring = { ...toronto, utc_offset_seconds: -18_000, daily: { ...toronto.daily, time: [sec("2026-03-07T05:00:00Z"), sec("2026-03-08T05:00:00Z"), sec("2026-03-09T04:00:00Z")] } };
    expect(parseOpenMeteo(spring, "Toronto", 0).forecast.map((d) => [d.date, d.weekday])).toEqual([["2026-03-07", "Sat"], ["2026-03-08", "Sun"], ["2026-03-09", "Mon"]]);
    // Fetched Thu 29 Oct 2026 in EDT (-4 h). From Mon 2 Nov, local midnight is 05:00 UTC (EST).
    const fall = { ...toronto, utc_offset_seconds: -14_400, daily: { ...toronto.daily, time: [sec("2026-10-31T04:00:00Z"), sec("2026-11-01T04:00:00Z"), sec("2026-11-02T05:00:00Z")] } };
    expect(parseOpenMeteo(fall, "Toronto", 0).forecast.map((d) => [d.date, d.weekday])).toEqual([["2026-10-31", "Sat"], ["2026-11-01", "Sun"], ["2026-11-02", "Mon"]]);
  });

  it("a missing daily block gives no forecast and no sun times", () => {
    const { now, forecast } = parseOpenMeteo({ current: toronto.current }, "X", 1);
    expect(forecast).toEqual([]);
    expect(now.sunrise).toBeNull();
    expect(now.sunset).toBeNull();
  });

  it("skips a daily row with missing numbers", () => {
    const bad = { ...toronto, daily: { ...toronto.daily, temperature_2m_max: [1, null, 3] } };
    expect(parseOpenMeteo(bad, "X", 1).forecast.map((d) => d.date)).toEqual(["2026-11-26", "2026-11-28"]);
  });

  it("throws when the current block is missing", () => {
    expect(() => parseOpenMeteo({ daily: toronto.daily }, "X", 1)).toThrow();
    expect(() => parseOpenMeteo(null, "X", 1)).toThrow();
  });
});

describe("resolveAtmosphere", () => {
  it("a manual pick wins over live weather", () => {
    expect(resolveAtmosphere("rain", "snow", "day")).toEqual({ atmosphere: "rain", source: "manual" });
    expect(resolveAtmosphere("clear", undefined, "night")).toEqual({ atmosphere: "clear", source: "manual" });
  });
  it("auto uses live weather", () => {
    expect(resolveAtmosphere("auto", "snow", "night")).toEqual({ atmosphere: "snow", source: "live" });
  });
  it("auto with no live data follows the clock", () => {
    expect(resolveAtmosphere("auto", undefined, "night")).toEqual({ atmosphere: "midnight", source: "fallback" });
    expect(resolveAtmosphere("auto", undefined, "day")).toEqual({ atmosphere: "clear", source: "fallback" });
    expect(resolveAtmosphere("auto", undefined, "golden")).toEqual({ atmosphere: "clear", source: "fallback" });
  });
});

describe("refresh loop and store", () => {
  const realRefresh = useWeather.getState().refresh;
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useWeather.setState({ refresh: realRefresh, now: null, forecast: [], error: null, loading: false });
    useSettings.getState().set({ weatherLocation: null });
  });

  it("fetches on start, every interval, and immediately when the saved location changes", () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    useWeather.setState({ refresh });
    const stop = startWeatherRefresh(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    useSettings.getState().set({ weatherLocation: { lat: 43.65, lon: -79.38, label: "Toronto" } });
    expect(refresh).toHaveBeenCalledTimes(3); // no 15-minute wait on the S22
    useSettings.getState().set({ glassOpacity: 9 }); // unrelated change: no refetch
    expect(refresh).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(59_000); // the interval restarted from the location change
    expect(refresh).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    stop();
    useSettings.getState().set({ weatherLocation: null });
    vi.advanceTimersByTime(120_000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("a slow response for the old location never overwrites the new one", async () => {
    useSettings.getState().set({ weatherLocation: { lat: 1, lon: 2, label: "Old" } });
    const resolvers: ((v: unknown) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise((r) => resolvers.push(r))));
    const first = useWeather.getState().refresh();
    await Promise.resolve();
    useSettings.getState().set({ weatherLocation: { lat: 3, lon: 4, label: "New" } });
    const second = useWeather.getState().refresh();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    const reply = { ok: true, json: async () => toronto };
    resolvers[1](reply);
    await second;
    expect(useWeather.getState().now?.place).toBe("New");
    resolvers[0](reply);
    await first;
    expect(useWeather.getState().now?.place).toBe("New");
    expect(useWeather.getState().forecast).toHaveLength(7);
    expect(useWeather.getState().loading).toBe(false);
  });

  it("records the error and clears loading on a failed fetch", async () => {
    useSettings.getState().set({ weatherLocation: { lat: 1, lon: 2, label: "X" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    await useWeather.getState().refresh();
    expect(useWeather.getState()).toMatchObject({ error: "Weather 503", loading: false });
  });
});
