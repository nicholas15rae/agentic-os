/**
 * Finance & bookkeeping — 100 % local. No bank, Plaid or card connections:
 * every number here is entered by you or read off your own scans by a local
 * model, and it lives in the gateway's SQLite store on your machine.
 */

/**
 * Every finance record carries an `area`: a business-profile id (acting, trades_contracting,
 * supplements_ecom, personal, or one you added). Records from before areas existed have none and
 * show as "Untagged". `question` = a "question for my accountant" note (the app never decides what
 * is deductible). `inReturn` = false leaves the record out of the HST return totals.
 */
export interface Tagged {
  area?: string;
  question?: string;
  inReturn?: boolean;
}

export interface InvoiceLine {
  desc: string;
  qty: number;
  rate: number;
}

export interface Invoice extends Tagged {
  number: string;
  client: string;
  clientEmail?: string;
  clientAddress?: string;
  /** Bill-to picked from the phone book (a link only; client / email stay on the invoice as printed). */
  contactId?: string;
  items: InvoiceLine[];
  /** Sales tax % applied to the subtotal (13 = Ontario HST). */
  taxRate: number;
  issuedAt: number;
  dueAt: number;
  status: "draft" | "sent" | "paid" | "overdue" | "void";
  paidAt?: number;
  notes?: string;
  projectId?: string;
  sentAt?: number;
}

export interface Check extends Tagged {
  payer: string;
  amount: number;
  receivedAt: number;
  chequeNumber?: string;
  memo?: string;
  deposited: boolean;
  depositedAt?: number;
  invoiceNumber?: string;
  imageFileId?: string;
  notes?: string;
  /** The income entry booked from this cheque, if any. */
  incomeId?: string;
}

export interface Receipt extends Tagged {
  vendor: string;
  date: string; // YYYY-MM-DD
  subtotal: number | null;
  gst: number | null;
  hst: number | null;
  pst: number | null;
  qst: number | null;
  tip: number | null;
  total: number | null;
  currency: string;
  category: string;
  regime?: string | null;
  flags?: string[];
  imageFileId?: string;
  ocrEngine?: string;
  ocrText?: string;
  confidence?: number;
  verified: boolean;
  notes?: string;
  /** How it got here: a scan (default), typed in by hand, or from a bank statement line. */
  source?: "scan" | "manual" | "statement";
}

export interface Income extends Tagged {
  date: string;
  client: string;
  description: string;
  amount: number; // before tax
  taxCollected: number;
  /** e-transfer, cheque, cash, card, other — or your own word. */
  method: string;
  invoiceNumber?: string;
  /** Acting: the agency the booking came through, union or not, and the commission. */
  agentId?: string;
  union?: boolean;
  commissionPct?: number;
  commissionOff?: boolean;
  imageFileId?: string;
  phone?: string;
  pendingId?: string;
}

/** What you owe an acting agent for a paid booking. */
export interface Commission extends Tagged {
  agentId: string;
  agentName: string;
  incomeId?: string;
  date: string;
  client: string;
  gross: number;
  pct: number;
  amount: number;
  union?: boolean;
  paid: boolean;
  paidAt?: number;
  /** cheque, e-transfer, cash, "deducted" (the agent kept it from the payment), or your own. */
  paidMethod?: string;
  notes?: string;
}

/** A trip for the mileage log. km from the maps connection is an estimate (no live traffic, shortest driving route). */
export interface MileageTrip extends Tagged {
  date: string;
  from: string;
  to: string;
  purpose: string;
  km: number;
  kmSource: "maps" | "manual";
  roundTrip?: boolean;
  notes?: string;
}

/** Money you're owed but haven't got yet. Marking it paid books it as income. */
export interface Pending extends Tagged {
  amount: number;
  /** When it's expected (YYYY-MM-DD). */
  date: string;
  who: string;
  phone?: string;
  what?: string;
  method?: string;
  paid: boolean;
  paidAt?: number;
  incomeId?: string;
  /** "Save contact" was ticked: the person was filed in the phone book (see contactId). */
  saveContact?: boolean;
  /** The phone-book entry (Communications → Phone book) this is from. A link only: deleting the contact leaves this record as it is. */
  contactId?: string;
}

/** One line of an imported bank / card statement (read-only copy; only the review fields change). */
export interface StatementLine extends Tagged {
  importId: string;
  account: string;
  date: string;
  /** + money in, − money out. */
  amount: number;
  description: string;
  fingerprint?: string;
  status: "unmatched" | "matched" | "reviewed" | "ignored";
  match?: { collection: string; id: string; label: string } | null;
  category?: string;
}

export interface Goal {
  name: string;
  target: number;
  saved: number;
  /** % of each income entry to set aside (e.g. 25 for taxes). 0 = fixed amounts only. */
  percentOfIncome: number;
  monthlyAmount: number;
  /** Day of month to be reminded to transfer (1–28, 0 = off). */
  reminderDay: number;
  deadline?: string;
  color?: string;
}

/** Expense categories (any record may also carry your own word: pick "Other…"). */
export const CATEGORIES = ["meals", "fuel", "vehicle", "office", "equipment", "software", "travel", "wardrobe", "training", "subcontract", "materials", "tools", "rent", "phone", "insurance", "advertising", "commission", "professional fees", "inventory", "shipping", "utilities", "other"];

export const invoiceTotals = (inv: Pick<Invoice, "items" | "taxRate">) => {
  const subtotal = inv.items.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);
  const tax = Math.round(subtotal * (inv.taxRate / 100) * 100) / 100;
  return { subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
};

/** Sales tax paid on a receipt (input tax credits come from GST/HST only). */
export const receiptItc = (r: Pick<Receipt, "gst" | "hst">) => (r.gst ?? 0) + (r.hst ?? 0);

export const PAY_METHODS = ["e-transfer", "cheque", "cash", "card", "direct deposit", "other"];

export const quarterOf = (iso: string) => {
  const d = new Date(iso + "T12:00:00");
  return `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`;
};
