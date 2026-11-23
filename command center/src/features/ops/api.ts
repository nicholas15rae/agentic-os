/**
 * Operations Manager, review queue and integrity commands. Feature-local typed contract over the
 * same `native()` invoke as `lib/platform.ts` (desktop only).
 */
import { native } from "@/lib/platform";
import type { AuditView, BatchResult, Business, BusinessPatch, FinanceHandoff, IntegrityStatus, NewBusiness, QItem, ReviewConfig, ReviewList, ReviewSettings } from "./types";

interface Commands {
  business_list: { args: undefined; result: { businesses: Business[] } };
  business_create: { args: { business: NewBusiness }; result: { business: Business; error: string | null } };
  business_provision: { args: { businessId: string }; result: { business: Business; error: string | null } };
  business_update: { args: { businessId: string; patch: BusinessPatch }; result: Business };
  business_set_archived: { args: { businessId: string; archived: boolean; approved?: boolean }; result: Business };
  bizops_memory_list: { args: { businessId: string }; result: { businessId: string; notes: string[] } };
  bizops_memory_write: { args: { businessId: string; rel: string; text: string }; result: { businessId: string; rel: string; bytes: number } };
  bizops_finance_handoff: { args: { handoff: FinanceHandoff; approved?: boolean }; result: { id: string; ledgerTag: string; kind: string; amountCents: number; currency: string; date: string } };
  quarantine_flag_note: { args: { businessId: string; rel: string; reason?: string }; result: QItem };
  review_list: { args: undefined; result: ReviewList };
  review_inspect: { args: { itemId: string }; result: { item: QItem; preview: string | null } };
  review_approve: { args: { itemIds: string[]; approved?: boolean }; result: BatchResult };
  review_reject: { args: { itemIds: string[] }; result: BatchResult };
  review_settings: { args: undefined; result: ReviewSettings };
  review_config_set: { args: { config: ReviewConfig }; result: { config: ReviewConfig } };
  review_webhook_set: { args: { url: string }; result: { webhookConfigured: boolean; webhookHost: string | null } };
  review_webhook_clear: { args: undefined; result: { webhookConfigured: boolean } };
  review_webhook_test: { args: undefined; result: { sent: boolean; pending: number } };
  ops_audit_recent: { args: { limit?: number }; result: AuditView };
  integrity_status: { args: undefined; result: IntegrityStatus };
}

export function ocmd<K extends keyof Commands>(name: K, ...args: Commands[K]["args"] extends undefined ? [] : [Commands[K]["args"]]): Promise<Commands[K]["result"]> {
  return native<Commands[K]["result"]>(name, args[0] as Record<string, unknown> | undefined);
}
