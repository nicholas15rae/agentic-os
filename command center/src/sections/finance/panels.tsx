import { lazy } from "react";
import { BarChart3, Camera, Car, FileSpreadsheet, FileText, Filter, Hourglass, Landmark, ListTodo, PiggyBank, Receipt, Target, Users, Wallet, Calculator } from "lucide-react";
import { registerWidget } from "@/core/widgets/registry";
import { surfaceStore } from "@/core/widgets/layout-store";
import type { WidgetDefinition, WidgetInstance, WidgetProps } from "@/core/widgets/types";

/**
 * The Finance page on the shared layout system (AGENTS.md, "Everything Is Customizable"): the
 * area filters, the overview, the to-do list and each book that used to be a tab are panels.
 */
export const FINANCE_SURFACE = "finance";

type Size = { w: number; h: number };

const panel = (id: string, title: string, description: string, icon: WidgetDefinition["icon"], load: () => Promise<React.ComponentType<WidgetProps>>, size: Size, compactOrder: number, minSize: Size = { w: 3, h: 1 }): WidgetDefinition => ({
  id,
  title,
  description,
  icon,
  defaultSize: size,
  minSize,
  defaultConfig: {},
  surfaces: [FINANCE_SURFACE],
  panel: true,
  compactOrder,
  component: lazy(async () => ({ default: await load() })),
});

const section = () => import("@/sections/FinanceSection");

/** A book (table / list): a long-press selects its text instead of starting Edit layout. */
const book = (load: () => Promise<React.ComponentType>) => async () => {
  const Block = await load();
  return function FinanceBookPanel() {
    return (
      <div data-no-hold>
        <Block />
      </div>
    );
  };
};

export const FINANCE_PANELS: WidgetDefinition[] = [
  panel("fi-filters", "Area filters", "The area switcher and agent / month / year filters every Finance panel follows; areas and rates.", Filter, async () => (await section()).FinanceFilters, { w: 12, h: 1 }, 1, { w: 6, h: 1 }),
  panel("fi-stats", "Overview", "Income this month and YTD, HST/GST owing this quarter, outstanding invoices.", BarChart3, async () => (await section()).FinanceStats, { w: 8, h: 2 }, 2),
  panel("fi-todo", "To do", "Cheques to deposit, money owed, invoices to chase, commissions, HST returns; each opens its panel.", ListTodo, async () => (await section()).FinanceTodo, { w: 4, h: 2 }, 3),
  panel("fi-savings", "Savings goals", "Progress bars for each savings goal.", PiggyBank, async () => (await section()).SavingsSummary, { w: 4, h: 3 }, 4),
  panel("fi-scan", "Scan", "Capture a receipt, bill, cheque, e-Transfer or pay stub; it is read locally and filed.", Camera, async () => {
    const [{ ScanPanel }, { goTo }] = await Promise.all([import("./ScanPanel"), section()]);
    return function FinanceScanPanel() {
      // Saved: show the panel it was filed in (it used to switch tabs).
      return (
        <ScanPanel
          onSaved={(where) => {
            // The Scan window steps aside so the book it filed into is in view.
            const L = useFinanceLayout.getState();
            const scan = L.pages.flatMap((p) => p.items).find((i) => i.widgetId === "fi-scan");
            if (scan && L.windows.some((w) => w.instanceId === scan.instanceId)) L.closeWindow(scan.instanceId);
            goTo(where === "checks" ? "cheques" : where === "income" ? "income" : "receipts");
          }}
        />
      );
    };
  }, { w: 6, h: 5 }, 5),
  panel("fi-income", "Income", "Income records by area, with the tax collected.", Wallet, book(async () => (await import("./LedgerPanels")).IncomePanel), { w: 6, h: 5 }, 6),
  panel("fi-receipts", "Tax table", "Receipts and their ITCs: what goes in the return.", Receipt, book(async () => (await import("./ReceiptsTable")).ReceiptsTable), { w: 6, h: 5 }, 7),
  panel("fi-expenses", "Expenses and mileage", "Expenses and kilometres driven.", Car, book(async () => (await import("./MoneyPanels")).ExpensesPanel), { w: 6, h: 5 }, 8),
  panel("fi-invoices", "Invoices", "Draft, send, print and follow up invoices.", FileText, book(async () => (await import("./InvoicesPanel")).InvoicesPanel), { w: 6, h: 5 }, 9),
  panel("fi-cheques", "Cheques", "Cheques received and deposited.", Landmark, book(async () => (await import("./LedgerPanels")).ChequesPanel), { w: 6, h: 4 }, 10),
  panel("fi-pending", "Pending", "Money people owe you.", Hourglass, book(async () => (await import("./MoneyPanels")).PendingPanel), { w: 6, h: 4 }, 11),
  panel("fi-commissions", "Commissions", "Agent commissions owed and paid.", Users, book(async () => (await import("./MoneyPanels")).CommissionsPanel), { w: 6, h: 4 }, 12),
  panel("fi-bank", "Bank import", "Import a bank statement file (no bank connection).", FileSpreadsheet, book(async () => (await import("./BankImportPanel")).BankImportPanel), { w: 6, h: 5 }, 13),
  panel("fi-taxes", "Taxes", "HST returns, the small-supplier limit and set-asides.", Calculator, book(async () => (await import("./TaxPanel")).TaxPanel), { w: 6, h: 5 }, 14),
  panel("fi-goals", "Goals", "Set up savings goals by % of income or a monthly amount.", Target, book(async () => (await import("./LedgerPanels")).GoalsPanel), { w: 6, h: 5 }, 15),
];
for (const p of FINANCE_PANELS) registerWidget(p);

/** An app icon in the default layout: opens its panel in a window at its full size. */
const icon = (instanceId: string, widgetId: string, col: number): WidgetInstance => {
  const def = FINANCE_PANELS.find((p) => p.id === widgetId)!;
  return { instanceId, widgetId, col, row: 8, w: 1, h: 1, config: {}, display: "icon", fullSize: def.defaultSize };
};

/**
 * The finished template (what Reset restores): filters across the top, the overview and to-do,
 * the three busiest books, and the other books as icons along the bottom (a tap opens each).
 * Every block works in the browser too, so desktop and web share it.
 */
export const FINANCE_DEFAULT_DESKTOP: WidgetInstance[] = [
  // Two rows for the filters: the chips wrap, and "Areas & rates" opens its form below them.
  { instanceId: "filters", widgetId: "fi-filters", col: 1, row: 1, w: 12, h: 2, config: {} },
  { instanceId: "stats", widgetId: "fi-stats", col: 1, row: 3, w: 8, h: 2, config: {} },
  { instanceId: "todo", widgetId: "fi-todo", col: 9, row: 3, w: 4, h: 2, config: {} },
  { instanceId: "income", widgetId: "fi-income", col: 1, row: 5, w: 4, h: 3, config: {} },
  { instanceId: "receipts", widgetId: "fi-receipts", col: 5, row: 5, w: 5, h: 3, config: {} },
  { instanceId: "invoices", widgetId: "fi-invoices", col: 10, row: 5, w: 3, h: 4, config: {} },
  icon("savings", "fi-savings", 1),
  icon("scan", "fi-scan", 2),
  icon("expenses", "fi-expenses", 3),
  icon("cheques", "fi-cheques", 4),
  icon("pending", "fi-pending", 5),
  icon("commissions", "fi-commissions", 6),
  icon("bank", "fi-bank", 7),
  icon("taxes", "fi-taxes", 8),
  icon("goals", "fi-goals", 9),
];
export const FINANCE_DEFAULT_WEB: WidgetInstance[] = FINANCE_DEFAULT_DESKTOP;
export const FINANCE_DEFAULT = FINANCE_DEFAULT_DESKTOP;

export const useFinanceLayout = surfaceStore({ surface: FINANCE_SURFACE, defaults: FINANCE_DEFAULT });
