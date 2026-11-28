import { useCallback, useEffect, useState } from "react";
import { Gauge, Loader2, Zap } from "lucide-react";
import { Card } from "@/components/ui";
import { cmd } from "@/lib/platform";
import { engineApi } from "@/features/engine/engine-api";
import { benchLine, backendRows, routeTonyBlocker, testReplyLine, type BenchLast, type EngineSwitchView, type TestReply } from "@/features/engine/engine";
import { Toggle } from "./os-ui";

const TONE = { ok: "text-teal", warn: "text-amber", muted: "text-ink-3" } as const;

/**
 * Settings → Engine / Models, first card (Section 26): the two switches (Engine on, Route Tony to
 * engine), where Tony's chat and memory run right now, a timed Test reply and the last benchmark.
 * The switches are the desktop's own (engine.json via Rust), so they work whichever gateway runs;
 * everything ships OFF and nothing here turns itself on.
 */
export function EngineSwitchCard() {
  const [v, setV] = useState<EngineSwitchView | null>(null);
  const [bench, setBench] = useState<BenchLast | null>(null);
  const [test, setTest] = useState<TestReply | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setV(await cmd("engine_switch_get"));
    } catch (e) {
      setMsg(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void engineApi<BenchLast>("/api/engine/bench/last").then(setBench, () => setBench(null));
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const flip = async (patch: { enabled?: boolean; routeTony?: boolean; routeAgents?: boolean }) => {
    setBusy("switch");
    setMsg(null);
    try {
      setV(await cmd("engine_switch_set", { patch }));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    setBusy("test");
    setMsg(null);
    try {
      setTest(await engineApi<TestReply>("/api/engine/test", { method: "POST", body: "{}", timeoutMs: 120_000 }));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const on = !!v?.route?.enabled;
  const tony = v?.chat === "engine";
  const blocker = routeTonyBlocker(v);
  const agentsOn = !!v?.route?.routeAgents && on;
  const agentsBlocker = !on ? "Turn the engine on first." : v?.health !== "ok" ? `Load a model first (engine ${v?.health ?? "…"}).` : null;

  return (
    <Card title="Built-in engine: switches" hint="Off by default. Tony, memory and the phone stay on LM Studio / AnythingLLM until you flip these.">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Zap className={`size-4 ${tony ? "text-teal" : "text-ink-3"}`} />
        <span className={tony ? "text-teal" : "text-ink-2"}>{tony ? "Tony is running in-house on the built-in engine" : "Tony is on LM Studio (legacy)"}</span>
        <span className="ml-auto text-xs text-ink-3">
          engine {v?.health ?? "…"}
          {v?.served ? ` · ${v.served}` : ""}
        </span>
      </div>

      <Toggle
        on={on}
        onChange={(x) => void flip({ enabled: x })}
        tone="amber"
        disabled={busy !== null || !v}
        label="Engine on"
        hint="Lets the gateway run llama-server (with its watchdog). Turning it off also switches Tony and the agents back."
      />
      <Toggle
        on={tony}
        onChange={(x) => void flip({ routeTony: x })}
        tone="amber"
        disabled={busy !== null || (!tony && blocker !== null)}
        label="Route Tony to engine"
        hint={!tony && blocker ? blocker : "Desktop and phone Tony answer on the built-in engine. LM Studio is left alone (unload Tony there to free the card)."}
      />
      <Toggle
        on={agentsOn}
        onChange={(x) => void flip({ routeAgents: x })}
        disabled={busy !== null || (!agentsOn && agentsBlocker !== null)}
        label="Gateway agents on the engine"
        hint={!agentsOn && agentsBlocker ? agentsBlocker : "The gateway's agents (with their MCP-registry tools) answer on the engine."}
      />

      <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
        {backendRows(v).map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-ink-3">{r.label}</dt>
            <dd className={TONE[r.tone]}>{r.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <button onClick={() => void runTest()} className="pill-glass inline-flex items-center gap-1 text-xs" disabled={busy !== null || v?.health !== "ok"} title={v?.health !== "ok" ? "Load a model on the engine first" : "One of Tony's real turns on the engine, timed"}>
          {busy === "test" ? <Loader2 className="size-3.5 animate-spin" /> : <Gauge className="size-3.5" />} Test reply
        </button>
        {test && <span className="text-xs text-ink-2">{testReplyLine(test)}</span>}
      </div>
      {test?.text && <p className="mt-1 text-xs italic text-ink-3">“{test.text}”</p>}

      <div className="mt-3 text-xs text-ink-3">
        <div>
          Last benchmark, engine{bench?.engine ? ` (${bench.engine.started})` : ""}: <span className="text-ink-2">{benchLine(bench?.engine?.summary)}</span>
        </div>
        <div>
          LM Studio{bench?.lmstudio ? ` (${bench.lmstudio.started})` : ""}: <span className="text-ink-2">{benchLine(bench?.lmstudio?.summary)}</span>
        </div>
      </div>

      {msg && <p className="mt-2 text-xs text-amber">{msg}</p>}
    </Card>
  );
}
