import { useEffect, useState } from "react";
import { Archive, Briefcase, ChevronDown, ChevronRight, Plus, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { Card, Empty, Field, Input, Stat, SubTabs, money } from "@/components/ui";
import { gated } from "@/features/bridge/gate";
import { useToasts } from "@/features/reminders/notify";
import { ocmd } from "@/features/ops/api";
import { AddBusinessModal } from "@/features/ops/AddBusinessModal";
import { emailsFor, formatEmails, parseEmails, parseTerms, provisionLabel } from "@/features/ops/logic";
import { businessCardStats, type CardInputs, type CardNumber, type PipelineLike, type ProjectLike } from "@/features/ops/card-stats";
import type { Check, Income, Invoice } from "@/features/finance/types";
import type { Reminder } from "@/features/reminders/types";
import { useCollection, useNow } from "@/lib/cc-api";
import { useSettings } from "@/stores/settings";
import { useOps } from "@/features/ops/ops-store";
import type { AuditView, Business, IntegrityStatus, ReviewSettings } from "@/features/ops/types";
import { ReviewQueue } from "@/features/review/ReviewQueue";
import { isTauri } from "@/lib/platform";

type Tab = "businesses" | "review" | "audit" | "settings";

/** One plain line per tab, shown under the tabs. */
const TAB_HELP: Record<Tab, string> = {
  businesses: "Each business you run, kept apart: its own notes, workspace and books. Tony routes a request to the one it names.",
  review: "Things waiting for your yes: notes flagged for mentioning another business, empty or half-written files, and purges. Nothing is deleted until you approve it here.",
  audit: "A tamper-evident log of every flag, quarantine, purge, restore and hand-off, plus a check that the rules files haven't been changed.",
  settings: "When you hear about the Review Queue: a daily digest at your hour (or sooner when it piles up), and optionally a counts-only alert to a webhook.",
};

/** Operations: the business registry, the HITL review queue, the audit trail and digest settings. */
export function OperationsSection() {
  const [tab, setTab] = useState<Tab>("businesses");
  const pending = useOps((s) => s.review?.pending ?? 0);
  const tabs: { id: Tab; label: string }[] = [
    { id: "businesses", label: "Businesses" },
    { id: "review", label: pending ? `Review Queue · ${pending}` : "Review Queue" },
    { id: "audit", label: "Audit" },
    { id: "settings", label: "Digest & alerts" },
  ];
  useEffect(() => {
    void useOps.getState().refresh();
    void useOps.getState().refreshReview();
  }, []);
  return (
    <div className="mx-auto h-full w-full max-w-5xl space-y-4 overflow-y-auto px-4 pb-32 md:px-6 md:pb-8">
      <SubTabs tabs={tabs} value={tab} onChange={setTab} />
      <p className="-mt-2 text-[12px] text-ink-3">{TAB_HELP[tab]}</p>
      {!isTauri() && <Empty>Operations runs on the desktop app.</Empty>}
      {isTauri() && tab === "businesses" && <Businesses />}
      {isTauri() && tab === "review" && <ReviewQueue />}
      {isTauri() && tab === "audit" && <Audit />}
      {isTauri() && tab === "settings" && <DigestSettings />}
    </div>
  );
}

function Businesses() {
  const businesses = useOps((s) => s.businesses);
  const error = useOps((s) => s.error);
  const [adding, setAdding] = useState(false);
  const active = businesses.filter((b) => b.status === "active").length;
  // The collections the cards' numbers come from (pure: features/ops/card-stats.ts).
  const inputs: CardInputs = {
    income: useCollection<Income>("income").items,
    invoices: useCollection<Invoice>("invoices").items,
    checks: useCollection<Check>("checks").items,
    pipeline: useCollection<PipelineLike>("pipeline").items,
    projects: useCollection<ProjectLike>("projects").items,
    reminders: useCollection<Reminder>("reminders").items,
  };
  const now = useNow(60_000);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Businesses" value={businesses.length} sub={`${active} active`} tone="teal" />
        <Stat label="Isolation" value="Per business" sub="workspace · memory · ledger" />
        <div className="col-span-2 flex items-center md:col-span-1">
          <button onClick={() => setAdding(true)} className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-amber text-sm font-semibold text-canvas">
            <Plus size={16} /> Add business
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-alert">{error}</p>}
      {!businesses.length && <Empty>No businesses yet.</Empty>}
      {businesses.map((b) => (
        <BusinessCard key={b.businessId} b={b} inputs={inputs} now={now} />
      ))}
      {adding && <AddBusinessModal onClose={() => setAdding(false)} />}
    </div>
  );
}

function BusinessCard({ b, inputs, now }: { b: Business; inputs: CardInputs; now: number }) {
  const [editing, setEditing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [form, setForm] = useState(() => draftOf(b));
  const [busy, setBusy] = useState(false);
  const refresh = useOps((s) => s.refresh);
  const toast = useToasts((s) => s.push);
  const currency = useSettings((s) => s.business.currency);
  const stats = businessCardStats(b.businessId, inputs, now);
  const mail = emailsFor([b], b.businessId) ?? [];

  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      await refresh();
    } catch (e) {
      toast({ title: what, body: String(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run("Couldn't save", async () => {
      await ocmd("business_update", {
        businessId: b.businessId,
        patch: { displayName: form.displayName.trim(), category: form.category.trim(), description: form.description.trim(), aliases: parseTerms(form.aliases), crossDomainBlocklist: parseTerms(form.blocklist), emails: parseEmails(form.emails) },
      });
      setEditing(false);
    });

  const provision = () =>
    run("Setup failed", async () => {
      const r = await ocmd("business_provision", { businessId: b.businessId });
      if (r.error) throw new Error(r.error);
    });

  const archive = () =>
    run("Couldn't archive", () =>
      gated(
        { action: "business-archive", summary: `Archive ${b.displayName} (stops routing to it; its data stays until you purge it)`, detail: { businessId: b.businessId } },
        (approved) => ocmd("business_set_archived", { businessId: b.businessId, archived: true, approved }),
        () => `${b.displayName} archived`,
      ),
    );

  const unarchive = () => run("Couldn't restore", () => ocmd("business_set_archived", { businessId: b.businessId, archived: false }));

  const tone = b.status === "active" ? "text-teal-soft" : b.status === "archived" ? "text-ink-3" : b.provision.lastError ? "text-alert" : "text-amber-light";
  const amount = (n: CardNumber) => (n.value === null ? "—" : money(n.value, currency));
  const count = (n: CardNumber) => (n.value === null ? "—" : n.value);

  return (
    <Card
      title={b.displayName}
      action={
        <>
          <span className={`label-caps ${tone}`}>{provisionLabel(b)}</span>
          {b.status === "provisioning" && (
            <button onClick={provision} disabled={busy} className="flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink disabled:opacity-40">
              <RefreshCw size={12} /> Finish setup
            </button>
          )}
          {b.status !== "archived" ? (
            <button onClick={archive} disabled={busy} title="Archive" className="text-ink-3 hover:text-ink disabled:opacity-40">
              <Archive size={14} />
            </button>
          ) : (
            <button onClick={unarchive} disabled={busy} className="text-[12px] text-ink-2 hover:text-ink">
              Restore
            </button>
          )}
        </>
      }
    >
      {(b.description || b.category) && (
        <p className="mb-3 text-sm text-ink-2">
          {b.description}
          {b.category && <span className="ml-2 rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink-3">{b.category}</span>}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <KeyNumber label="Income this month" value={amount(stats.incomeThisMonth)} hint={stats.incomeThisMonth.hint} />
        <KeyNumber label="Pending payments" value={amount(stats.pendingPayments)} hint={stats.pendingPayments.hint} />
        <KeyNumber label={b.businessId === "acting" ? "Open bookings" : "Open jobs"} value={count(stats.openJobs)} hint={stats.openJobs.hint} />
        <KeyNumber label="Unread messages" value={count(stats.unreadMessages)} hint={stats.unreadMessages.hint} />
        <KeyNumber
          label="Next deadline"
          value={stats.nextDeadline.at === null ? "—" : new Date(stats.nextDeadline.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          hint={stats.nextDeadline.at === null ? stats.nextDeadline.hint : stats.nextDeadline.what}
        />
      </div>
      <p className="mt-2 text-[11px] text-ink-3">Mail: {mail.map((e) => (e.address ? (e.label ? `${e.label} <${e.address}>` : e.address) : "the main account")).join(", ")}</p>
      {b.provision.lastError && b.status === "provisioning" && <p className="mt-3 rounded-[10px] border border-alert/30 bg-alert/10 px-3 py-2 text-[12px] text-alert">{b.provision.lastError}</p>}
      {!editing ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {b.aliases.map((a) => (
            <span key={a} className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-ink-2">
              {a}
            </span>
          ))}
          <span className="text-[11px] text-ink-3">· {b.crossDomainBlocklist.length} protected client / vendor names</span>
          <button
            onClick={() => {
              setForm(draftOf(b));
              setEditing(true);
            }}
            className="ml-auto text-[12px] text-amber-light hover:underline"
          >
            Edit
          </button>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} maxLength={80} />
          </Field>
          <Field label="Category">
            <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} maxLength={60} />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={400} />
          </Field>
          <Field label="Other names (comma)">
            <Input value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
          </Field>
          <Field label="Email accounts (one per line; empty = the main account)">
            <textarea value={form.emails} onChange={(e) => setForm({ ...form, emails: e.target.value })} rows={2} placeholder="Born Fortuna <orders@example.com>" className="field resize-none font-mono text-[12px]" />
          </Field>
          <Field label="Its clients, vendors, products (one per line)" className="sm:col-span-2">
            <textarea value={form.blocklist} onChange={(e) => setForm({ ...form, blocklist: e.target.value })} rows={3} className="field resize-none" />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <button onClick={() => setEditing(false)} className="h-9 rounded-full px-3 text-[12px] text-ink-2">
              Cancel
            </button>
            <button onClick={save} disabled={busy || !form.displayName.trim()} className="h-9 rounded-full bg-amber px-4 text-[12px] font-semibold text-canvas disabled:opacity-40">
              Save
            </button>
          </div>
        </div>
      )}
      <button onClick={() => setAdvanced((a) => !a)} className="mt-3 flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink-2" aria-expanded={advanced}>
        {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Advanced
      </button>
      {advanced && (
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-2">
          <Row k="Business id" v={b.businessId} />
          <Row k="Workspace / RAG" v={b.workspaceSlug} />
          <Row k="Ledger tag" v={b.financeLedgerTag} />
          <Row k="Librarian scope" v={b.librarianScope} />
          <Row k="Memory" v={b.memoryPath} wide />
        </dl>
      )}
    </Card>
  );
}

function draftOf(b: Business) {
  return { displayName: b.displayName, category: b.category, description: b.description, aliases: b.aliases.join(", "), blocklist: b.crossDomainBlocklist.join("\n"), emails: formatEmails(b.emails) };
}

function KeyNumber({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
  return (
    <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2" title={hint}>
      <p className="text-[10px] uppercase tracking-wider text-ink-3">{label}</p>
      <p className="mt-0.5 truncate font-mono text-sm text-ink tabular">{value}</p>
      {value === "—" && <p className="truncate text-[10px] text-ink-3">{hint}</p>}
    </div>
  );
}

function Row({ k, v, wide }: { k: string; v: string; wide?: boolean }) {
  return (
    <div className={`flex min-w-0 gap-2 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="shrink-0 text-ink-3">{k}</dt>
      <dd className="truncate font-mono text-ink-2" title={v}>
        {v}
      </dd>
    </div>
  );
}

function Audit() {
  const [audit, setAudit] = useState<AuditView | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      const [a, i] = await Promise.all([ocmd("ops_audit_recent", { limit: 150 }), ocmd("integrity_status")]);
      setAudit(a);
      setIntegrity(i);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-alert">{error}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        <StatusTile ok={!integrity?.failClosed} title={integrity?.failClosed ? "Rules integrity: halted" : "Rules integrity: verified"} detail={integrity?.failClosed ?? `${integrity?.files.length ?? 0} rules files match the copies built into the app`} />
        <StatusTile ok={!!audit?.chain.ok} title={audit?.chain.ok ? "Audit chain: intact" : "Audit chain: broken"} detail={audit?.chain.ok ? `${audit.chain.rows} rows, each linked to the one before` : (audit?.chain.error ?? "…")} />
      </div>
      <Card title="Audit trail" hint="Append-only. Every flag, quarantine, purge, restore, hand-off and webhook digest." action={<button onClick={() => void load()} className="text-[12px] text-ink-3 hover:text-ink">Refresh</button>}>
        {!audit?.rows.length ? (
          <Empty>No audit entries yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="label-caps text-ink-3">
                <tr>
                  <th className="py-1.5 pr-3">#</th>
                  <th className="pr-3">When</th>
                  <th className="pr-3">Who</th>
                  <th className="pr-3">What</th>
                  <th className="pr-3">Business</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {audit.rows.map((r) => (
                  <tr key={r.seq} className="text-ink-2">
                    <td className="py-1.5 pr-3 font-mono text-ink-3">{r.seq}</td>
                    <td className="whitespace-nowrap pr-3">{new Date(r.at).toLocaleString()}</td>
                    <td className="pr-3">{r.actor}</td>
                    <td className="pr-3 font-mono">{r.action}</td>
                    <td className="pr-3 font-mono">{r.businessId || "—"}</td>
                    <td className="max-w-[320px] truncate" title={r.detail}>
                      {r.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function StatusTile({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <div className={`flex items-start gap-3 rounded-[16px] border p-4 ${ok ? "border-teal/25 bg-teal/[0.05]" : "border-alert/40 bg-alert/10"}`}>
      {ok ? <ShieldCheck size={18} className="mt-0.5 shrink-0 text-teal" /> : <ShieldAlert size={18} className="mt-0.5 shrink-0 text-alert" />}
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${ok ? "text-ink" : "text-alert"}`}>{title}</p>
        <p className="mt-0.5 break-words text-[12px] text-ink-3">{detail}</p>
      </div>
    </div>
  );
}

function DigestSettings() {
  const [s, setS] = useState<ReviewSettings | null>(null);
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = async () => {
    try {
      setS(await ocmd("review_settings"));
    } catch (e) {
      setMsg({ text: String(e), bad: true });
    }
  };
  useEffect(() => {
    void load();
  }, []);
  if (!s) return <Empty>Loading…</Empty>;
  const act = async (f: () => Promise<unknown>, ok: string) => {
    try {
      await f();
      setMsg({ text: ok });
      await load();
    } catch (e) {
      setMsg({ text: String(e), bad: true });
    }
  };
  const cfg = s.config;
  const saveCfg = (patch: Partial<typeof cfg>) => act(() => ocmd("review_config_set", { config: { ...cfg, ...patch } }), "Saved");
  return (
    <div className="space-y-4">
      <Card title="Digest" hint="Pending purges and Security flags are batched: one digest when the count reaches the threshold, and one a day at the hour below while anything is waiting. No per-item popups.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Daily digest hour (0–23)">
            <Input type="number" min={0} max={23} defaultValue={cfg.digestHour} onBlur={(e) => Number(e.target.value) !== cfg.digestHour && void saveCfg({ digestHour: Number(e.target.value) })} />
          </Field>
          <Field label="Digest early at this many items">
            <Input type="number" min={1} max={1000} defaultValue={cfg.threshold} onBlur={(e) => Number(e.target.value) !== cfg.threshold && void saveCfg({ threshold: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>
      <Card title="External alert (optional)" hint="Sends the digest as counts only (how many items, per business id, per reason) to a webhook, e.g. a local WhatsApp bridge. Never names, amounts, file names or contents. The URL is kept in the OS keychain.">
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm text-ink-2">
            <Briefcase size={14} className="text-ink-3" />
            {s.webhookConfigured ? `Webhook set (${s.webhookHost ?? "host hidden"})` : "No webhook set"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… or http://127.0.0.1:…/digest" className="min-w-[260px] flex-1" />
            <button onClick={() => void act(() => ocmd("review_webhook_set", { url }).then(() => setUrl("")), "Webhook saved")} disabled={!url.trim()} className="h-10 rounded-full bg-amber px-4 text-sm font-semibold text-canvas disabled:opacity-40">
              Save URL
            </button>
          </div>
          {s.webhookConfigured && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" checked={cfg.webhookEnabled} onChange={(e) => void saveCfg({ webhookEnabled: e.target.checked })} />
                Send digests to the webhook
              </label>
              <button onClick={() => void act(() => ocmd("review_webhook_test"), "Test digest sent")} className="text-[12px] text-ink-2 hover:text-ink">
                Send a test
              </button>
              <button onClick={() => void act(() => ocmd("review_webhook_clear"), "Webhook removed")} className="text-[12px] text-alert/80 hover:text-alert">
                Remove
              </button>
            </div>
          )}
        </div>
      </Card>
      {msg && <p className={`text-sm ${msg.bad ? "text-alert" : "text-teal-soft"}`}>{msg.text}</p>}
    </div>
  );
}
