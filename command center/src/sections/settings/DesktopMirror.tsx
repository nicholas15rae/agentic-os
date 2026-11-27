import { useEffect, useState } from "react";
import { KeyRound, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui";
import type { OsConfig, ProvidersView } from "@/lib/platform";
import { desktopConfig } from "./use-providers";

const KIND: Record<string, string> = {
  local: "Local model",
  cloud: "Cloud",
  "agentic-os": "Agent",
  stt: "Speech-to-text",
  tts: "Voice",
  n8n: "n8n",
  integration: "Integration",
};

/**
 * Phone / browser: the DESKTOP's settings, read-only (`/api/os/desktop-config`). The desktop and
 * the gateway run these services and hold the keys, so the phone shows them instead of its own
 * loopback defaults, and points to the desktop app for changes.
 */
export function DesktopMirrorCard() {
  const [data, setData] = useState<{ providers: ProvidersView; os: OsConfig | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      setData(await desktopConfig());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const chain = data?.providers.policy.chain ?? [];
  const os = data?.os;
  return (
    <Card
      title="Desktop settings"
      hint="What the desktop app uses, read through the gateway. The desktop and the gateway run these services and hold the keys for this phone; change them in the desktop app."
      action={
        <button className="pill-glass !h-8 text-xs" onClick={() => void load()} disabled={busy} aria-label="Refresh desktop settings">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      }
    >
      {error && <p className="text-xs text-alert">Couldn't read the desktop's settings: {error}</p>}
      {!data && !error && <p className="text-sm text-ink-3">Loading…</p>}
      {data && (
        <ul className="mt-2 space-y-1.5">
          {data.providers.providers.map((p) => (
            <li key={p.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink">{p.label}</span>
                <span className="label-caps text-[10px] text-amber-soft">{KIND[p.kind] ?? p.kind}</span>
                {chain.includes(p.id) && <span className="text-[10.5px] text-teal">chat chain #{chain.indexOf(p.id) + 1}</span>}
              </div>
              <div className="break-all font-mono text-[11.5px] text-ink-2">
                {p.baseUrl}
                {p.model ? ` · ${p.model}` : ""}
              </div>
              {p.needsKey && (
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                  {p.hasKey ? <ShieldCheck size={12} className="text-teal" /> : <KeyRound size={12} className="text-amber" />}
                  {p.hasKey ? "Key stored on the desktop" : "No key on the desktop yet"}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {os && (
        <dl className="mt-3 grid gap-x-3 gap-y-1 text-[12px] sm:grid-cols-[auto_1fr]">
          <dt className="text-ink-3">Compute mode</dt>
          <dd className="font-mono text-ink-2">{os.compute.mode}</dd>
          <dt className="text-ink-3">Cloud droplet</dt>
          <dd className="break-all font-mono text-ink-2">
            {os.droplet.enabled ? "enabled" : "off"} · {os.droplet.host} · {os.droplet.modelUrl}
          </dd>
          <dt className="text-ink-3">AnythingLLM</dt>
          <dd className="break-all font-mono text-ink-2">{os.anythingllm.baseUrl}</dd>
          <dt className="text-ink-3">Kill switch</dt>
          <dd className="font-mono text-ink-2">{os.privacy.killSwitch ? "ON (local only)" : "off"}</dd>
        </dl>
      )}
    </Card>
  );
}
