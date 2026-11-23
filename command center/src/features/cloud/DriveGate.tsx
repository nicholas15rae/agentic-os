import { useEffect, useState, type ReactNode } from "react";
import { Cloud, KeyRound, Loader2, LogOut, RefreshCw, Settings2 } from "lucide-react";
import { useNav } from "@/stores/nav";
import { requestSettingsTab } from "@/sections/settings/settings-tab";
import type { CloudStatus } from "./contract";
import { connect, disconnect, driveView, refreshStatus, startCloud, useCloud, type DriveView } from "./cloud-store";

/** Status + events for as long as the calling surface is mounted (ref-counted). */
export function useCloudSession() {
  useEffect(() => startCloud(), []);
}

export const CLIENT_MISSING_TEXT = "Add your Google OAuth client in Settings → Integrations → Google.";
export const CONNECTING_TEXT = "Waiting for you in the browser…";

export interface DriveGateViewProps {
  view: DriveView;
  status: CloudStatus | null;
  error: string | null;
  connecting: boolean;
  compact?: boolean;
  onConnect: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
  onDisconnect: () => void;
  /** Drawn under the account chip when connected. */
  children?: ReactNode;
}

/** The four §4 states (props only, so it renders statically in tests). */
export function DriveGateView({ view, status, error, connecting, compact, onConnect, onRetry, onOpenSettings, onDisconnect, children }: DriveGateViewProps) {
  if (view === "loading")
    return (
      <div className="grid flex-1 place-items-center py-6 text-ink-3" role="status" aria-label="Checking Google Drive">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  if (view === "client-missing")
    return (
      <div className="flex flex-1 flex-col items-start gap-2 py-2">
        <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-ink-2">
          <KeyRound size={14} className="mt-0.5 shrink-0 text-amber-soft" /> {CLIENT_MISSING_TEXT}
        </p>
        <button onClick={onOpenSettings} className="pill-glass !h-8 !px-3 text-xs">
          <Settings2 size={13} /> Open Settings
        </button>
      </div>
    );
  if (view === "disconnected" || (view === "error" && connecting))
    return (
      <div className="flex flex-1 flex-col items-start gap-2 py-2">
        {connecting ? (
          <p className="flex items-center gap-2 text-[13px] text-ink-2" role="status">
            <Loader2 size={14} className="animate-spin text-teal" /> {CONNECTING_TEXT}
          </p>
        ) : (
          <>
            {!compact && <p className="text-[13px] leading-relaxed text-ink-3">Browse your Drive folders, import footage into a project and upload verified renders.</p>}
            <button onClick={onConnect} className="pill-primary !h-9 !px-3.5 text-xs">
              <Cloud size={13} /> Connect Google Drive
            </button>
          </>
        )}
      </div>
    );
  if (view === "error") {
    const canConnect = !!status?.clientConfigured && !status.connected && !error;
    return (
      <div className="flex flex-1 flex-col items-start gap-2 py-2">
        <p className="text-[13px] leading-relaxed text-alert" role="alert">
          {error ?? status?.error ?? "Google Drive isn't answering."}
        </p>
        <div className="flex flex-wrap gap-2">
          <button onClick={onRetry} className="pill-glass !h-8 !px-3 text-xs">
            <RefreshCw size={13} /> Retry
          </button>
          {canConnect && (
            <button onClick={onConnect} className="pill-primary !h-8 !px-3 text-xs">
              <Cloud size={13} /> Connect Google Drive
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <AccountChip account={status?.account ?? null} onDisconnect={onDisconnect} />
      {children}
    </div>
  );
}

function AccountChip({ account, onDisconnect }: { account: string | null; onDisconnect: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-teal/40 bg-[rgba(11,13,17,0.45)] px-2.5 text-[12px] text-teal-soft" title={account ?? "Connected"}>
        <Cloud size={12} className="shrink-0" />
        <span className="truncate">{account ?? "Connected"}</span>
      </span>
      {asking ? (
        <span className="flex items-center gap-1 text-[12px] text-ink-2">
          Disconnect?
          <button
            onClick={() => {
              setAsking(false);
              onDisconnect();
            }}
            className="pill-glass !h-7 !px-2 text-[11px] text-alert"
          >
            Yes, disconnect
          </button>
          <button onClick={() => setAsking(false)} className="pill-glass !h-7 !px-2 text-[11px]">
            Keep
          </button>
        </span>
      ) : (
        <button onClick={() => setAsking(true)} className="pill-glass !h-7 !w-7 !p-0" title="Disconnect Google Drive" aria-label="Disconnect Google Drive">
          <LogOut size={12} />
        </button>
      )}
    </div>
  );
}

/** Store-wired gate: subscribes for its lifetime and draws the right state around `children`. */
export function DriveGate({ compact, children }: { compact?: boolean; children?: ReactNode }) {
  useCloudSession();
  const status = useCloud((s) => s.status);
  const error = useCloud((s) => s.statusError);
  const connecting = useCloud((s) => s.connecting);
  const go = useNav((s) => s.go);
  return (
    <DriveGateView
      view={driveView(status, error)}
      status={status}
      error={error}
      connecting={connecting}
      compact={compact}
      onConnect={() => void connect()}
      onRetry={() => void refreshStatus()}
      onDisconnect={() => void disconnect()}
      onOpenSettings={() => {
        requestSettingsTab("integrations");
        go("settings");
      }}
    >
      {children}
    </DriveGateView>
  );
}
