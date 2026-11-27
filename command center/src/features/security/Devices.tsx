import { useEffect, useState } from "react";
import { ClipboardCopy, Laptop, Loader2, LogOut, Monitor, Plus, Smartphone, Users } from "lucide-react";
import { gateway } from "@/lib/gateway";
import { Input, Select } from "@/components/ui";

/** One row of the gateway's device registry (device_registry.py `public`). */
export interface DeviceRow {
  id: string;
  name: string;
  kind: "phone" | "laptop" | "desktop" | "tablet" | "other" | "shared" | "local";
  createdAt: number;
  lastSeen: number | null;
  lastIp: string | null;
  userAgent: string | null;
  revokedAt: number | null;
}

/** "just now" / "5 min ago" / "3 h ago" / "2 days ago" / "never". Pure. */
export function seenAgo(ts: number | null, now = Date.now() / 1000): string {
  if (!ts) return "never";
  const s = Math.max(0, now - ts);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

/** Can this row be signed out on its own? (Not this PC, not shared-token rows, not already out.) Pure. */
export const canSignOut = (d: Pick<DeviceRow, "kind" | "revokedAt">) => !d.revokedAt && d.kind !== "local" && d.kind !== "shared";

const ICON = { phone: Smartphone, tablet: Smartphone, laptop: Laptop, desktop: Monitor, local: Monitor, shared: Users, other: Monitor } as const;

/**
 * Settings → Security → "Where you're logged in" (desktop only: the gateway answers these routes
 * for this PC alone). Each remote device gets its own token, so one can be signed out without
 * cutting off the others; the old shared phone token keeps working and shows as "shared token".
 */
export function DevicesCard() {
  const [rows, setRows] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"phone" | "laptop" | "tablet" | "other">("phone");
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const load = () =>
    void gateway<{ devices: DeviceRow[] }>("/api/devices")
      .then((r) => {
        setRows(r.devices);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(load, []);

  const add = async () => {
    setBusy("add");
    try {
      const r = await gateway<{ device: DeviceRow; token: string }>("/api/devices", { method: "POST", body: JSON.stringify({ name: name.trim() || "Phone", kind }) });
      setIssued({ name: r.device.name, token: r.token });
      setName("");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const signOut = async (d: DeviceRow) => {
    if (!confirm(`Sign out “${d.name}”? Its token stops working right away; it needs a new one to connect again.`)) return;
    setBusy(d.id);
    try {
      await gateway(`/api/devices/${encodeURIComponent(d.id)}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 rounded-[12px] border border-white/[0.06] p-3" aria-label="Where you're logged in">
      <p className="label-caps mb-2 text-ink-3">Where you're logged in</p>
      {error && <p className="mb-2 font-mono text-[11px] text-alert">{error}</p>}
      {!rows ? (
        <p className="text-[11px] text-ink-3">Loading…</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((d) => {
            const Icon = ICON[d.kind] ?? Monitor;
            return (
              <li key={d.id} className={`flex flex-wrap items-center gap-2 text-[12px] ${d.revokedAt ? "opacity-50" : ""}`} data-device={d.id}>
                <Icon size={13} className="text-ink-3" aria-hidden />
                <span className="text-ink">{d.name}</span>
                <span className="text-ink-3">
                  {d.revokedAt ? "signed out" : `seen ${seenAgo(d.lastSeen)}`}
                  {d.lastIp && !d.revokedAt ? ` · ${d.lastIp}` : ""}
                  {d.kind === "shared" ? " · uses the shared token (sign out = New phone token in Settings → OS)" : ""}
                </span>
                {canSignOut(d) && (
                  <button className="pill-glass ml-auto !h-7 !px-2.5 text-[11px] hover:!border-alert/50 hover:!text-alert" disabled={busy === d.id} onClick={() => void signOut(d)}>
                    {busy === d.id ? <Loader2 size={11} className="animate-spin" /> : <LogOut size={11} />} Sign out
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input className="!h-8 flex-1 text-[12px]" placeholder="New device name (e.g. Galaxy S22)" value={name} onChange={(e) => setName(e.target.value)} aria-label="New device name" />
        <Select className="!h-8 !w-auto text-[12px]" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Device kind">
          <option value="phone">Phone</option>
          <option value="laptop">Laptop</option>
          <option value="tablet">Tablet</option>
          <option value="other">Other</option>
        </Select>
        <button className="pill-glass !h-8 text-[11px]" disabled={busy === "add"} onClick={() => void add()}>
          {busy === "add" ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} Add device
        </button>
      </div>
      {issued && (
        <div className="mt-2 rounded-[10px] border border-amber/30 bg-amber/[0.06] p-2 text-[11px] text-ink-2">
          Token for <b>{issued.name}</b> (shown once; paste it into that device's gateway token field):
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 break-all font-mono text-amber-light">{issued.token}</code>
            <button className="pill-glass !h-7 !px-2" onClick={() => void navigator.clipboard?.writeText(issued.token)} aria-label="Copy the token">
              <ClipboardCopy size={11} />
            </button>
            <button className="pill-glass !h-7 !px-2 text-[11px]" onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
