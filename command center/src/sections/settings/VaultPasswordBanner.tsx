import { ShieldAlert } from "lucide-react";
import { useKeySources } from "@/features/integrations/key-sources";
import { VAULT_PASSWORD_COPY, vaultPasswordState } from "@/features/vault/safety";

/** The element id of the vault password row (MemoryLifecycleCard's SecretRow). */
export const VAULT_PASSWORD_ROW_ID = "vault-password-row";

/** Scroll to the vault password row and put the cursor in it. */
export function focusVaultPasswordRow(): boolean {
  const row = typeof document !== "undefined" ? document.getElementById(VAULT_PASSWORD_ROW_ID) : null;
  if (!row) return false;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.querySelector<HTMLInputElement>("input[type=password]")?.focus({ preventScroll: true });
  return true;
}

/**
 * Section 16.3: shown while no vault password is in the keychain (presence only, the same
 * `os_secret_sources` read every key row uses; the value is never read). Says what it protects,
 * that archives are written unencrypted without it, and that a lost password can't be recovered.
 * Desktop only (the keychain lives there); renders nothing once the password is set.
 */
export function VaultPasswordBanner({ onSet }: { onSet?: () => void }) {
  const { data } = useKeySources();
  if (vaultPasswordState(data) !== "missing") return null;
  const c = VAULT_PASSWORD_COPY;
  return (
    <div role="alert" className="mb-4 rounded-xl border border-alert/40 bg-alert/10 px-3 py-2.5 text-xs text-ink">
      <p className="flex items-center gap-1.5 font-semibold text-alert">
        <ShieldAlert size={14} /> {c.title}
      </p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-ink-2">
        <li>{c.protects}</li>
        <li>{c.unencrypted}</li>
        <li>{c.lost}</li>
      </ul>
      <p className="mt-1.5 text-ink-3">{c.writeItDown}</p>
      <button type="button" className="pill-glass !h-8 mt-2 text-xs" onClick={() => (onSet ? onSet() : focusVaultPasswordRow())}>
        Set the vault password
      </button>
    </div>
  );
}
