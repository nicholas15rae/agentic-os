import { Mail } from "lucide-react";
import { Card } from "@/components/ui";
import { useOsCfg } from "./os-ui";
import { GMAIL_SCOPES, gmailInboxScope, gmailScopePatch } from "./comms-settings";

/** Settings → Comms: the saved Gmail inbox scope (default Primary only). */
export function GmailInboxCard() {
  const { cfg, error, saving, save } = useOsCfg();
  if (!cfg) return null;
  const scope = gmailInboxScope(cfg);
  return (
    <Card title="Gmail inbox" hint="Which inbox Tony reads and searches. Saved here, so he doesn't have to remember it.">
      <div role="radiogroup" aria-label="Gmail inbox Tony reads" className="space-y-1.5">
        {GMAIL_SCOPES.map((s) => (
          <label key={s.id} className="flex cursor-pointer items-start gap-3 rounded-[12px] border border-white/[0.07] px-3 py-2 text-sm">
            <input
              type="radio"
              name="gmail-inbox-scope"
              className="mt-1"
              checked={scope === s.id}
              disabled={saving}
              onChange={() => save(gmailScopePatch(s.id))}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-ink">
                {s.id === "primary" && <Mail size={13} className="text-teal" />}
                {s.label}
              </span>
              <span className="block text-xs leading-relaxed text-ink-3">{s.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-alert">{error}</p>}
    </Card>
  );
}
