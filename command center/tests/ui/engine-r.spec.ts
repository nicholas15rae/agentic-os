/**
 * Engine R panel (Trading section) against a mocked gateway: a pending rule change renders with its diff,
 * untrusted rationale and build/test numbers; approving needs the typed phrase and posts
 * {confirm: "APPROVE", note}; a 423 step-up refusal leaves the change pending. Runs on the desktop and
 * phone projects (playwright.config.ts). Nothing reaches a real gateway: every request is mocked or aborted.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import type { ChangeEvaluation, EvaluationReport, RuleChange, RuleParams, RulesView, SetMetrics } from "../../src/features/trading/EngineRPanel.contract";

const GATEWAY = "http://127.0.0.1:8080";
const CHANGE_ID = "rc-20261125-ab12cd34";

const params: RuleParams = {
  sma_fast: 20, sma_slow: 50, breakout_lookback: 20, min_rel_volume: 1.2, atr_period: 14,
  stop_atr_mult: 2, target_atr_mult: 3, max_atr_pct: 4, risk_per_trade_pct: 0.25, disabled_symbols: [],
};
const m = (over: Partial<SetMetrics>): SetMetrics => ({
  trades: 42, wins: 19, losses: 23, winRate: 0.4524, avgWinR: 1.71, avgLossR: -0.93, avgWinPct: 2.2, avgLossPct: -1.2,
  expectancyR: 0.26, totalR: 10.9, maxDrawdownR: 4.4, maxDrawdownPct: 1.1, from: "2023-02-01", to: "2025-05-30", note: null, ...over,
});
const split = (build: Partial<SetMetrics>, test: Partial<SetMetrics>) => ({
  cutoff: "2025-06-02", range: { from: "2023-01-03", to: "2026-11-24" }, symbols: ["GLD", "IWM", "QQQ", "SLV", "SPY", "UNG", "USO"], openAtEnd: 1,
  build: m(build), test: m({ trades: 18, from: "2025-06-02", to: "2026-11-10", note: "only 18 trade(s): too few to judge", ...test }),
});
const evaluation: ChangeEvaluation = {
  cutoff: "2025-06-02",
  range: { from: "2023-01-03", to: "2026-11-24" },
  current: split({}, { winRate: 0.3889, expectancyR: 0.11 }),
  proposed: split({ trades: 31, winRate: 0.5161, expectancyR: 0.41, maxDrawdownR: 3.1 }, { trades: 13, winRate: 0.4615, expectancyR: 0.19, maxDrawdownR: 2.9, note: "only 13 trade(s): too few to judge" }),
  verdict: { label: "improves_out_of_sample", notes: ["test set has 13 trade(s): too few to trust either way"] },
};
const pending: RuleChange = {
  changeId: CHANGE_ID, created: 1_764_090_000, source: "analyst", actor: "analyst", status: "pending", baseVersion: 1,
  diff: { min_rel_volume: { from: 1.2, to: 1.5 } },
  rationale: { text: "Build-set entries under 1.5x relative volume averaged -0.12R over 14 trades.", untrusted: true },
  evaluation, decided: null, decidedBy: null, note: null, newVersion: null,
};
const noTrades = m({ trades: 0, wins: 0, losses: 0, winRate: null, avgWinR: null, avgLossR: null, avgWinPct: null, avgLossPct: null, expectancyR: null,
  totalR: 0, maxDrawdownR: 0, maxDrawdownPct: 0, from: null, to: null, note: "only 0 trade(s): too few to judge" });
const report: EvaluationReport = {
  at: 1_764_080_000, version: 1, rule: "trend_breakout", params,
  backtest: split({}, { winRate: 0.3889, expectancyR: 0.11 }),
  paper: { cutoff: null, build: noTrades, test: noTrades },
  method: "chronological split by entry date",
};
const schema = Object.fromEntries(Object.keys(params).map((k) => [k, { type: "float", min: 0, max: 10, default: 0, help: k }])) as RulesView["schema"];

function view(approved: boolean): RulesView {
  const active = { version: approved ? 2 : 1, params: approved ? { ...params, min_rel_volume: 1.5 } : params, created: 1_764_000_000, changeId: approved ? CHANGE_ID : null, approvedBy: approved ? "ui:desktop" : "system", reason: approved ? "analyst change approved" : "initial rule set (Engine A defaults)", rule: "trend_breakout" as const };
  return {
    enabled: true, blocked: "bridge not connected to TWS", active,
    limits: { max_daily_loss_base: 1500, on_daily_loss: "stop_entries", max_position_shares: 200, max_position_notional_base: 25000, max_trades_per_day: 3, max_open_positions: 3, scan_time_et: "15:45", universe: ["SPY", "QQQ", "IWM", "GLD", "SLV", "USO", "UNG"] },
    limitsError: null, entriesToday: 0, schema,
    pending: approved ? [] : [pending], recentChanges: [], versions: [active],
    lastScan: { scanId: "20261125-154500-manual", kind: "manual", at: 1_764_100_000, version: 1, submit: false, status: "dry_run", detail: "", finished: 1_764_100_005,
      rows: [{ symbol: "SPY", action: "no_signal", why: "no setup: breakout" }, { symbol: "GLD", action: "skip", why: "no fresh IBKR daily bars (cache)", bars: "cache" }] },
    evaluation: report,
    analyst: { enabled: true, blocked: "inside trading hours", window: "weekdays 16:30-08:45 New York, weekends", runs: [] },
  };
}

interface Mock {
  approveBodies: unknown[];
  approveStatus: 200 | 423;
}

async function mockGateway(page: Page, opts: { oldGateway?: boolean; noBars?: boolean } = {}): Promise<Mock> {
  const mock: Mock = { approveBodies: [], approveStatus: 200 };
  let approved = false;
  // Hermetic: nothing leaves the machine, and no request reaches a real gateway on :8080.
  await page.route((url) => !/^(127\.0\.0\.1|localhost)$/.test(url.hostname), (r) => r.abort());
  await page.route(`${GATEWAY}/**`, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (opts.oldGateway && path.startsWith("/api/trading/rules")) return json({ detail: "Not Found" }, 404); // gateway started before Engine R
    if (req.method() === "GET" && path === "/api/trading/rules") return json(view(approved));
    if (req.method() === "GET" && path === "/api/trading/rules/evaluation")
      return json(opts.noBars ? { ...report, backtest: { ...report.backtest, cutoff: null, range: { from: null, to: null }, symbols: [], build: noTrades, test: noTrades } } : report);
    if (req.method() === "GET" && path === "/api/trading/rules/log") return json({ rows: [] });
    if (req.method() === "GET" && path === "/api/trading/desk")
      return json({ mode: "ADVISORY", agentHalted: false, posture: "normal", financer: {}, lock: null, limits: null, limitsError: null, pending: [], recent: [], audit: { ok: true, note: "", tail: [] } });
    if (req.method() === "GET" && path === "/api/trading/agent")
      return json({ retired: "retired as a trader: the LLM is an after-hours analyst that files pending rule-change suggestions; Engine R (deterministic rules) executes",
        enabled: false, blocked: null, nextSlot: null, eventsToday: 0, eventMax: 3, runs: [], leaderboard: [], callCounts: {},
        config: { model: "qwen/qwen3.5-9b", schedule: "", universe: [], deskMode: "ADVISORY", advisoryStart: null, advisoryEnd: null, isolation: { peer: "finance", broker: "127.0.0.1:7497", localhostOnly: null } } });
    if (req.method() === "POST" && path === `/api/trading/engines/r/changes/${CHANGE_ID}/approve`) {
      mock.approveBodies.push(req.postDataJSON());
      if (mock.approveStatus === 423) return json({ detail: { code: "STEP_UP_REQUIRED", module: "trading", message: "trading is read-only on this device" } }, 423);
      approved = true;
      return json({ ok: true, change: { ...pending, status: "approved", newVersion: 2 }, active: view(true).active });
    }
    if (req.method() === "POST" && path.startsWith("/api/trading/")) return json({ detail: "not mocked" }, 404); // never a trading write by accident
    return json({ detail: "not mocked" }, 404);
  });
  return mock;
}

const panel = (page: Page) => page.locator("section", { has: page.getByRole("heading", { name: "Engine R · rules" }) });

async function openPending(page: Page) {
  await page.goto("/#/trading");
  await expect(page.getByRole("heading", { name: "Engine R · rules" })).toBeVisible({ timeout: 30_000 });
  const card = page.getByRole("article", { name: `Rule change ${CHANGE_ID}` });
  await card.scrollIntoViewIfNeeded();
  return card;
}

test("a pending change shows its diff, untrusted rationale and build/test numbers side by side", async ({ page }) => {
  await mockGateway(page);
  const card = await openPending(page);
  await expect(card.getByText("min_rel_volume", { exact: false }).first()).toBeVisible();
  await expect(card.getByText("Rationale · untrusted model text")).toBeVisible();
  await expect(card.getByText("Better on build and on the unseen test set")).toBeVisible();
  await expect(card.getByText("test set has 13 trade(s): too few to trust either way")).toBeVisible();
  const build = card.getByRole("table", { name: "Build set · oldest ~70%" });
  const testSet = card.getByRole("table", { name: "Test set · newest ~30%, unseen" });
  await expect(build.getByRole("row", { name: /Trades\s+42\s+31/ })).toBeVisible();
  await expect(build.getByRole("row", { name: /Win rate\s+45%\s+52%/ })).toBeVisible();
  await expect(testSet.getByRole("row", { name: /Trades\s+18\s+13/ })).toBeVisible();
  await expect(testSet.getByRole("row", { name: /Max drawdown\s+4\.40R\s+2\.90R/ })).toBeVisible();
  for (const label of ["Avg win", "Avg loss"]) await expect(testSet.getByRole("rowheader", { name: label })).toBeVisible();

  // Phone layout: the panel and its tables stay inside the viewport (no sideways scroll).
  const vw = page.viewportSize()!.width;
  for (const el of [card, build, testSet]) {
    const box = await el.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= vw + 1, `${await el.getAttribute("aria-label")} fits in ${vw}px`).toBeTruthy();
  }
  // The app scrolls an inner container, so shoot each region rather than the whole (taller than the viewport) card.
  for (const region of ["Engine R controls", "Active rule", "Hard limits", "70/30 report", "Last scan"]) {
    const el = panel(page).getByLabel(region, { exact: true });
    const box = (await el.boundingBox())!;
    expect(box.x + box.width, `${region} fits in ${vw}px`).toBeLessThanOrEqual(vw + 1);
    await el.screenshot({ path: test.info().outputPath(`engine-r-${region.replace(/\W+/g, "-").toLowerCase()}.png`) });
  }
});

test("approving needs the typed phrase and posts {confirm: APPROVE, note}", async ({ page }) => {
  const mock = await mockGateway(page);
  const card = await openPending(page);
  await card.getByRole("button", { name: /^Decide on min_rel_volume/ }).click();
  const approve = card.getByRole("button", { name: "Approve change" });
  const phrase = card.getByLabel("Type APPROVE to confirm");
  await expect(approve).toBeDisabled();
  await phrase.fill("approve");
  await expect(approve).toBeDisabled();
  await card.getByLabel("Decision note").fill("build and test both better");
  await phrase.fill("APPROVE");
  await expect(approve).toBeEnabled();
  await card.screenshot({ path: test.info().outputPath("engine-r-decide.png") });
  await approve.click();

  await expect(page.getByText("Rule v2 active")).toBeVisible();
  expect(mock.approveBodies).toEqual([{ confirm: "APPROVE", note: "build and test both better" }]);
  await expect(page.getByText(/^No pending changes/)).toBeVisible();
  await expect(page.getByText("Active rule · v2")).toBeVisible();
});

test("a step-up refusal (423) keeps the change pending and says why", async ({ page }) => {
  const mock = await mockGateway(page);
  mock.approveStatus = 423;
  const card = await openPending(page);
  await card.getByRole("button", { name: /^Decide on min_rel_volume/ }).click();
  await card.getByLabel("Type APPROVE to confirm").fill("APPROVE");
  await card.getByRole("button", { name: "Approve change" }).click();
  await expect(page.getByText("trading is read-only on this device")).toBeVisible();
  expect(mock.approveBodies).toHaveLength(1);
  await expect(page.getByRole("article", { name: `Rule change ${CHANGE_ID}` })).toBeVisible();
});

test("the retired Trading Agent card offers no Run, Enable or Dry run", async ({ page }) => {
  await mockGateway(page);
  await page.goto("/#/trading");
  const agent = page.locator("section", { has: page.getByRole("heading", { name: /Trading Agent/ }) });
  await agent.scrollIntoViewIfNeeded();
  await expect(agent.getByText(/retired as a trader/)).toBeVisible({ timeout: 30_000 });
  for (const name of [/Run now/, /Dry run/, /^ON$/, /^OFF$/]) await expect(agent.getByRole("button", { name })).toHaveCount(0);
  await agent.screenshot({ path: test.info().outputPath("agent-retired.png") });
});

test("a gateway without the Engine R routes (404) says to restart the gateway", async ({ page }) => {
  await mockGateway(page, { oldGateway: true });
  await page.goto("/#/trading");
  const p = panel(page);
  await expect(p.getByText(/doesn't have the Engine R routes yet: restart the gateway/)).toBeVisible({ timeout: 30_000 });
  await expect(p.getByRole("button", { name: /Decide/ })).toHaveCount(0);
});

test("with no daily bars cached the 70/30 report says how to get them instead of empty tables", async ({ page }) => {
  await mockGateway(page, { noBars: true });
  await page.goto("/#/trading");
  const rep = panel(page).getByLabel("70/30 report", { exact: true });
  await expect(rep.getByText(/No daily bars cached yet/)).toBeVisible({ timeout: 30_000 });
  await expect(rep.getByRole("table")).toHaveCount(0);
});
