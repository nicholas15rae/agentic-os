import { useCallback, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Loader2, RotateCcw, Save } from "lucide-react";
import { Card, Chip, Field, Input } from "@/components/ui";
import { CameraCapture } from "@/features/finance/CameraCapture";
import { CATEGORIES, PAY_METHODS, type Check, type Receipt } from "@/features/finance/types";
import { cc, collections, type OcrResult } from "@/lib/cc-api";
import { useSettings } from "@/stores/settings";
import { useProfiles } from "@/features/business/profiles-store";
import { localIso } from "@/features/finance/areas";
import { commissionCalc } from "@/features/finance/commission";
import { SCAN_KINDS, scanTarget, suggestFromScan, type ScanKind } from "@/features/finance/scan-suggest";
import { ActingFields, emptyActing, prefillPct, type ActingValue } from "./ActingFields";
import { AreaSelect, SelectOther } from "./fields";
import { areaTaxRate } from "./LedgerPanels";
import { bookIncome } from "./book";

type Kind = ScanKind;
type SavedTo = "receipts" | "checks" | "income";
type Stage = { s: "capture" } | { s: "working"; msg: string; preview: string } | { s: "review"; preview: string; fileId: string; ocr: OcrResult | null; error?: string } | { s: "saved"; msg: string };

/**
 * Camera → gateway (stored locally) → local vision LLM (or Tesseract) →
 * editable review with HST/GST validation → saved to the tax table / cheque vault.
 */
export function ScanPanel({ onSaved }: { onSaved?: (where: SavedTo) => void }) {
  const [mode, setMode] = useState<"document" | "qr">("document");
  const [kind, setKind] = useState<Kind>("receipt");
  const [stage, setStage] = useState<Stage>({ s: "capture" });
  const [qr, setQr] = useState<string | null>(null);

  const process = useCallback(
    async (blob: Blob) => {
      const preview = URL.createObjectURL(blob);
      setStage({ s: "working", msg: "Saving image locally…", preview });
      try {
        const file = await cc.upload(blob, `${kind}-${new Date().toISOString().slice(0, 10)}.jpg`);
        setStage({ s: "working", msg: "Reading it with your local vision model…", preview });
        try {
          const ocr = await cc.ocr(file.id, kind);
          setStage({ s: "review", preview, fileId: file.id, ocr });
        } catch (e) {
          // Image is saved; let the user type the fields in.
          setStage({ s: "review", preview, fileId: file.id, ocr: null, error: e instanceof Error ? e.message : String(e) });
        }
      } catch (e) {
        setStage({ s: "saved", msg: `Couldn't reach the gateway: ${e instanceof Error ? e.message : e}` });
      }
    },
    [kind],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
      <Card title="Capture" action={<div className="flex gap-1.5"><Chip active={mode === "document"} onClick={() => setMode("document")}>Document</Chip><Chip active={mode === "qr"} onClick={() => setMode("qr")} tone="teal">QR code</Chip></div>}>
        {mode === "document" && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {SCAN_KINDS.map((k) => (
              <Chip key={k.id} active={kind === k.id} onClick={() => setKind(k.id)}>
                {k.label}
              </Chip>
            ))}
          </div>
        )}
        {stage.s === "capture" || mode === "qr" ? (
          <CameraCapture mode={mode} onCapture={(b) => void process(b)} onQr={(t) => setQr(t || "(no QR code found in that image)")} />
        ) : (
          <div className="space-y-3">
            {"preview" in stage && <img src={stage.preview} alt="Captured document" className="max-h-[420px] w-full rounded-[14px] border border-white/10 object-contain" />}
            {stage.s === "working" && (
              <p className="flex items-center gap-2 text-sm text-amber-soft">
                <Loader2 size={15} className="animate-spin" /> {stage.msg}
              </p>
            )}
            {stage.s === "saved" && <p className="text-sm text-teal">{stage.msg}</p>}
            <button onClick={() => setStage({ s: "capture" })} className="pill-glass">
              <RotateCcw size={14} /> Scan another
            </button>
          </div>
        )}
        {mode === "qr" && qr && <QrResult text={qr} onClear={() => setQr(null)} />}
      </Card>

      {stage.s === "review" ? (
        <Review
          kind={kind}
          fileId={stage.fileId}
          ocr={stage.ocr}
          error={stage.error}
          onSaved={(where, msg) => {
            setStage({ s: "saved", msg });
            onSaved?.(where);
          }}
        />
      ) : (
        <Card title="How it works" hint="Everything stays on your machine.">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-2">
            <li>Capture a receipt, bill, cheque, e-Transfer notice or pay stub (or upload a photo). The image is stored by your local gateway and stays attached.</li>
            <li>Your local vision model (LM Studio) reads the amount, date, payer / vendor and HST. No cloud OCR.</li>
            <li>The tax math is checked (13% ON HST, 15% Atlantic HST, 5% GST) and anything odd is flagged.</li>
            <li>It suggests the area, category and agent from the names on it. Nothing is saved until you check it and tap Save.</li>
          </ol>
        </Card>
      )}
    </div>
  );
}

function QrResult({ text, onClear }: { text: string; onClear: () => void }) {
  const [saved, setSaved] = useState(false);
  const isUrl = /^https?:\/\//i.test(text);
  return (
    <div className="mt-3 rounded-[14px] border border-teal/40 bg-teal/[0.07] p-3">
      <p className="label-caps mb-1 text-teal">QR content</p>
      <p className="break-all font-mono text-[13px] text-ink">{text}</p>
      {isUrl && <p className="mt-1 text-[11px] text-ink-3">Link not opened automatically — check it before visiting.</p>}
      <div className="mt-2 flex gap-2">
        <button className="pill-glass !h-8 text-xs" onClick={() => void navigator.clipboard?.writeText(text)}>
          <Copy size={12} /> Copy
        </button>
        <button
          className="pill-glass !h-8 text-xs"
          disabled={saved}
          onClick={async () => {
            await collections.create("documents", { title: `QR ${new Date().toLocaleString()}`, notes: text, kind: "qr" });
            setSaved(true);
          }}
        >
          <Save size={12} /> {saved ? "Saved to vault" : "Save to vault"}
        </button>
        <button className="pill-glass !h-8 text-xs" onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
}

const num = (v: string) => (v.trim() === "" ? null : Math.round(Number(v.replace(/[$,\s]/g, "")) * 100) / 100);
const str = (v: number | null | undefined) => (v == null ? "" : String(v));

function Review({ kind, fileId, ocr, error, onSaved }: { kind: Kind; fileId: string; ocr: OcrResult | null; error?: string; onSaved: (where: SavedTo, msg: string) => void }) {
  const f = ocr?.fields ?? {};
  const currency = useSettings((s) => s.business.currency);
  const target = scanTarget(kind);
  // A suggestion from fixed name rules only; the scanned text never drives anything else.
  const [sug] = useState(() => suggestFromScan(kind, f, { agencies: useProfiles.getState().doc.profiles.acting?.agencies, profiles: useProfiles.getState().doc }));
  const [area, setArea] = useState(sug.area ?? "");
  const [acting, setActing] = useState<ActingValue>(() => (sug.agentId ? { ...emptyActing(), agentId: sug.agentId, union: !!sug.union, pct: prefillPct(sug.agentId, !!sug.union) } : { ...emptyActing(), union: !!sug.union }));
  const [alsoIncome, setAlsoIncome] = useState(true);
  const [method, setMethod] = useState(kind === "paystub" ? "direct deposit" : kind === "check" ? "cheque" : "e-transfer");
  const [d, setD] = useState({
    vendor: f.vendor ?? f.payer ?? "",
    date: f.date ?? localIso(Date.now()),
    subtotal: str(f.subtotal),
    gst: str(f.gst),
    hst: str(f.hst),
    pst: str(f.pst),
    qst: str(f.qst),
    tip: str(f.tip),
    total: str(f.total),
    category: sug.category ?? (f.category && CATEGORIES.includes(f.category) ? f.category : "other"),
    chequeNumber: f.chequeNumber ?? "",
    memo: f.memo ?? "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const up = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setD({ ...d, [k]: e.target.value });
  const moneyIn = target !== "receipts";
  // Money in: the pre-tax amount is the subtotal, else the total less the HST printed on it. With
  // no HST printed and an HST-registered area, the amount received is taken to include it.
  const rate = areaTaxRate(area || undefined);
  const noTaxShown = d.hst === "" && d.gst === "" && d.subtotal === "";
  const received = num(d.total) ?? 0;
  const inGross = noTaxShown && rate > 0 ? Math.round((received / (1 + rate / 100)) * 100) / 100 : (num(d.subtotal) ?? Math.max(0, Math.round((received - (num(d.hst) ?? 0) - (num(d.gst) ?? 0)) * 100) / 100));
  const inHst = noTaxShown && rate > 0 ? Math.round((received - inGross) * 100) / 100 : (num(d.hst) ?? 0) + (num(d.gst) ?? 0);
  const book = (imageNote: string) =>
    bookIncome(
      {
        date: d.date,
        client: d.vendor || "Unknown payer",
        description: [imageNote, d.memo, d.notes].filter(Boolean).join(" · "),
        amount: inGross,
        taxCollected: inHst,
        method,
        area: area || undefined,
        imageFileId: fileId,
      },
      area === "acting" ? acting : null,
    );

  // Live re-check as fields are corrected.
  const sub = num(d.subtotal) ?? 0;
  const taxes = (num(d.gst) ?? 0) + (num(d.hst) ?? 0) + (num(d.pst) ?? 0) + (num(d.qst) ?? 0);
  const total = num(d.total) ?? 0;
  const mismatch = sub > 0 && total > 0 && Math.abs(sub + taxes + (num(d.tip) ?? 0) - total) > 0.05;

  const save = async () => {
    setSaving(true);
    try {
      if (kind === "check") {
        const inc = alsoIncome ? await book(`Cheque${d.chequeNumber ? ` #${d.chequeNumber}` : ""}`) : null;
        await collections.create<Check>("checks", {
          payer: d.vendor || "Unknown payer",
          amount: num(d.total) ?? 0,
          receivedAt: Date.parse(d.date + "T12:00:00") || Date.now(),
          chequeNumber: d.chequeNumber || undefined,
          memo: d.memo || undefined,
          deposited: false,
          imageFileId: fileId,
          notes: d.notes || undefined,
          area: area || undefined,
          incomeId: inc?.id,
        });
        onSaved("checks", `Cheque from ${d.vendor || "payer"} logged in the vault${inc ? " and in Income" : ""}.`);
      } else if (moneyIn) {
        await book(kind === "paystub" ? "Pay stub" : "e-Transfer");
        onSaved("income", `${kind === "paystub" ? "Pay stub" : "e-Transfer"} from ${d.vendor || "payer"} saved to Income.`);
      } else {
        await collections.create<Receipt>("receipts", {
          vendor: d.vendor || "Unknown vendor",
          date: d.date,
          subtotal: num(d.subtotal),
          gst: num(d.gst),
          hst: num(d.hst),
          pst: num(d.pst),
          qst: num(d.qst),
          tip: num(d.tip),
          total: num(d.total),
          currency: f.currency ?? currency,
          category: d.category,
          regime: ocr?.check.regime ?? null,
          flags: [...(ocr?.check.flags ?? []), ...(mismatch ? ["Totals don't add up"] : [])],
          imageFileId: fileId,
          ocrEngine: ocr?.engine,
          ocrText: ocr?.raw?.slice(0, 2000),
          confidence: f.confidence,
          verified: true,
          notes: [kind === "invoice" ? "Bill / supplier invoice" : "", d.notes].filter(Boolean).join(" · ") || undefined,
          area: area || undefined,
          source: "scan",
        });
        onSaved("receipts", `${d.vendor || "Receipt"} saved to the tax table.`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={kind === "check" ? "Review cheque" : moneyIn ? "Review payment" : "Review & confirm"}
      hint={ocr ? `Read by ${ocr.engine}${f.confidence != null ? ` · confidence ${Math.round(f.confidence * 100)}%` : ""}. Check every number against the paper.` : undefined}
    >
      {error && (
        <p className="mb-3 flex gap-2 rounded-[12px] border border-amber/40 bg-amber/10 p-2.5 text-xs text-amber-light">
          <AlertTriangle size={14} className="shrink-0" /> {error} The image is saved — fill the fields in by hand.
        </p>
      )}
      {ocr && (ocr.check.regime || ocr.check.flags.length > 0 || mismatch) && (
        <div className="mb-3 space-y-1">
          {ocr.check.regime && (
            <p className="flex items-center gap-1.5 text-xs text-teal">
              <CheckCircle2 size={13} /> {ocr.check.regime}
            </p>
          )}
          {[...ocr.check.flags, ...(mismatch ? ["Subtotal + tax + tip ≠ total"] : [])].map((fl) => (
            <p key={fl} className="flex items-center gap-1.5 text-xs text-alert">
              <AlertTriangle size={13} /> {fl}
            </p>
          ))}
        </div>
      )}
      {sug.reasons.length > 0 && (
        <p className="mb-3 rounded-[12px] border border-teal/30 bg-teal/[0.06] p-2.5 text-xs text-ink-2">
          <span className="text-teal">Suggested</span> from the names on it: {sug.reasons.join(" · ")}. Check the area{moneyIn ? " and agent" : " and category"} below before saving.
        </p>
      )}
      <form
        className="grid grid-cols-2 gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={moneyIn ? "Payer" : "Vendor"} className="col-span-2">
          <Input value={d.vendor} onChange={up("vendor")} required />
        </Field>
        <Field label="Date">
          <Input type="date" value={d.date} onChange={up("date")} />
        </Field>
        <Field label="Area">
          <AreaSelect value={area || undefined} onChange={setArea} className="" />
        </Field>
        {moneyIn ? (
          <>
            <Field label={kind === "paystub" ? "Gross pay" : "Amount"}>
              <Input inputMode="decimal" value={d.total} onChange={up("total")} className="font-mono" />
            </Field>
            <Field label="HST on it (if any)">
              <Input inputMode="decimal" value={d.hst} onChange={up("hst")} className="font-mono" placeholder="—" />
            </Field>
            {kind === "check" && (
              <Field label="Cheque #">
                <Input value={d.chequeNumber} onChange={up("chequeNumber")} className="font-mono" />
              </Field>
            )}
            <Field label={kind === "paystub" ? "Pay period" : "Memo / message"}>
              <Input value={d.memo} onChange={up("memo")} />
            </Field>
            <Field label="How paid">
              <SelectOther label="How paid" value={method} options={PAY_METHODS} onChange={setMethod} className="" />
            </Field>
            {kind === "check" && (
              <label className="col-span-2 flex items-center gap-1.5 text-[12px] text-ink-2">
                <input type="checkbox" checked={alsoIncome} onChange={(e) => setAlsoIncome(e.target.checked)} className="accent-teal" /> Also log it as income (and any agent commission)
              </label>
            )}
            {area === "acting" && (kind !== "check" || alsoIncome) && <ActingFields gross={inGross} value={acting} onChange={setActing} currency={currency} />}
            <p className="col-span-2 font-mono text-[11px] text-ink-3">
              Books {inGross.toFixed(2)} before tax + {inHst.toFixed(2)} HST{area === "acting" && acting.agentId ? ` · commission on ${inGross.toFixed(2)}: ${commissionCalc(inGross, acting.pct, acting.off).commission.toFixed(2)}` : ""}
            </p>
          </>
        ) : (
          <>
            <Field label="Category">
              <SelectOther label="Category" value={d.category} options={CATEGORIES} onChange={(category) => setD({ ...d, category })} className="" />
            </Field>
            {(["subtotal", "gst", "hst", "pst", "qst", "tip", "total"] as const).map((k) => (
              <Field key={k} label={k.toUpperCase()}>
                <Input inputMode="decimal" value={d[k]} onChange={up(k)} className={`font-mono ${k === "total" ? "text-amber-light" : ""}`} placeholder="—" />
              </Field>
            ))}
          </>
        )}
        <Field label="Notes" className="col-span-2">
          <Input value={d.notes} onChange={up("notes")} placeholder="Client / project, what it was for…" />
        </Field>
        <button className="pill-primary col-span-2" disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save {kind === "check" ? "to cheque vault" : moneyIn ? "to income" : "to tax table"}
        </button>
      </form>
    </Card>
  );
}
