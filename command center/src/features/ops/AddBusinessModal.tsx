import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { Field, Input } from "@/components/ui";
import { ocmd } from "./api";
import { businessIdError, newBusinessFrom, suggestId } from "./logic";
import { useOps } from "./ops-store";
import type { Business } from "./types";

/**
 * Register a business, then watch Rust provision it: its own memory folder, then its own
 * AnythingLLM workspace (`bizops_<id>`). The id is permanent; everything derived from it is
 * computed in Rust, so the form never sends a slug, path or ledger tag.
 */
export function AddBusinessModal({ onClose }: { onClose: () => void }) {
  const existing = useOps((s) => s.businesses);
  const [form, setForm] = useState({ displayName: "", businessId: "", category: "", description: "", aliases: "", blocklist: "" });
  const [idTouched, setIdTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Business | null>(null);

  const id = idTouched ? form.businessId : suggestId(form.displayName);
  const idErr = id ? businessIdError(id) ?? (existing.some((b) => b.businessId === id) ? "already registered" : null) : null;
  const nameTaken = existing.some((b) => b.displayName.toLowerCase() === form.displayName.trim().toLowerCase());
  const canSave = !busy && !result && form.displayName.trim().length > 0 && !!id && !idErr && !nameTaken;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await ocmd("business_create", { business: newBusinessFrom({ ...form, businessId: id }) });
      setResult(r.business);
      if (r.error) setError(r.error);
      await useOps.getState().refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const r = await ocmd("business_provision", { businessId: result.businessId });
      setResult(r.business);
      if (r.error) setError(r.error);
      await useOps.getState().refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const steps = useMemo(
    () => [
      { label: "Registered", done: !!result },
      { label: "Memory folder", done: !!result?.provision.memoryDir },
      { label: `Workspace ${result?.workspaceSlug ?? `bizops_${id || "…"}`}`, done: !!result?.provision.workspace },
    ],
    [result, id],
  );

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-3" role="dialog" aria-modal="true" aria-label="Add business" onClick={() => !busy && onClose()}>
      <div className="glass max-h-[92vh] w-full max-w-lg overflow-y-auto r-22 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-ink">Add business</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">
          It gets its own workspace, memory folder, librarian scope and ledger. Nothing is shared with your other businesses.
        </p>

        {!result && (
          <div className="mt-4 space-y-3">
            <Field label="Name">
              <Input value={form.displayName} onChange={set("displayName")} placeholder="Corner Bakery" autoFocus maxLength={80} />
              {nameTaken && <span className="fs-11 text-alert">A business with this name already exists.</span>}
            </Field>
            <Field label="Business id (permanent)">
              <Input
                value={id}
                onChange={(e) => {
                  setIdTouched(true);
                  setForm((f) => ({ ...f, businessId: e.target.value }));
                }}
                placeholder="corner_bakery"
                className="font-mono"
                maxLength={32}
              />
              <span className={`fs-11 ${idErr ? "text-alert" : "text-ink-3"}`}>{idErr ?? (id ? `Workspace bizops_${id} · ledger ${id}` : "Lowercase letters, digits and underscores")}</span>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <Input value={form.category} onChange={set("category")} placeholder="food" maxLength={60} />
              </Field>
              <Field label="Other names (comma)">
                <Input value={form.aliases} onChange={set("aliases")} placeholder="the bakery, bakeshop" />
              </Field>
            </div>
            <Field label="Description">
              <textarea value={form.description} onChange={set("description")} rows={2} maxLength={400} className="field resize-none" placeholder="What this business does" />
            </Field>
            <Field label="Its own clients, vendors, products (one per line)">
              <textarea value={form.blocklist} onChange={set("blocklist")} rows={3} className="field resize-none" placeholder={"Flour Co\nMain St Market"} />
              <span className="fs-11 text-ink-3">If one of these shows up in another business's notes, Security holds that write for your review.</span>
            </Field>
          </div>
        )}

        {result && (
          <ol className="mt-4 space-y-2">
            {steps.map((s, i) => {
              const failed = !s.done && !!error && steps.slice(0, i).every((p) => p.done);
              return (
                <li key={s.label} className="flex items-center gap-2 text-sm">
                  {s.done ? <CheckCircle2 size={16} className="text-teal" /> : failed ? <XCircle size={16} className="text-alert" /> : busy ? <Loader2 size={16} className="animate-spin text-ink-3" /> : <Circle size={16} className="text-ink-3" />}
                  <span className={s.done ? "text-ink" : "text-ink-2"}>{s.label}</span>
                </li>
              );
            })}
          </ol>
        )}

        {error && <p className="mt-3 r-10 border border-alert/30 bg-alert/10 px-3 py-2 fs-12 text-alert">{error}</p>}
        {result?.status === "active" && <p className="mt-3 fs-12 text-teal-soft">{result.displayName} is ready. Pick it in the top bar to lock Operations and Finance to it.</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="h-10 rounded-full px-4 text-sm text-ink-2 hover:text-ink disabled:opacity-40">
            {result ? "Close" : "Cancel"}
          </button>
          {!result && (
            <button onClick={save} disabled={!canSave} className="h-10 rounded-full bg-amber px-5 text-sm font-semibold text-canvas disabled:opacity-40">
              {busy ? "Adding…" : "Add business"}
            </button>
          )}
          {result && result.status === "provisioning" && (
            <button onClick={retry} disabled={busy} className="h-10 rounded-full bg-amber px-5 text-sm font-semibold text-canvas disabled:opacity-40">
              Retry setup
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
