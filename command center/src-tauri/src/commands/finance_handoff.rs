//! Ops → Finance: the ONLY way a business's financial event reaches the ledger.
//!
//! - A strict payload ([`FinanceHandoff`], `deny_unknown_fields`). It carries the event's facts
//!   only: no RAG chunks, notes or operational context ever travel with it.
//! - Rust checks that `businessId` / `financeLedgerTag` match the business the turn is locked to
//!   (a mismatch is refused, never re-tagged), checks the text fields for another business's
//!   identifiers and for secrets, and jails `attachmentRef` inside the business's own folder.
//! - The user confirms every hand-off (`approved: true`, else `PERMISSION_REQUIRED:finance-handoff`).
//!   It is then written through `finance_vault::write_input` (a delegated open-write-reseal when
//!   the vault is sealed) into that business's ledger partition.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::business_registry::Registry;
use super::finance_vault::LedgerInput;
use super::ops_scope::BusinessScope;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransactionType {
    Invoice,
    Receipt,
    Expense,
    Quote,
    SubcontractorPayout,
    EcomOrder,
}

impl TransactionType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invoice => "invoice",
            Self::Receipt => "receipt",
            Self::Expense => "expense",
            Self::Quote => "quote",
            Self::SubcontractorPayout => "subcontractor_payout",
            Self::EcomOrder => "ecom_order",
        }
    }

    /// The ledger kind and the sign of the amount.
    fn ledger_kind(self) -> (&'static str, i64) {
        match self {
            Self::Invoice | Self::EcomOrder => ("income", 1),
            Self::Receipt | Self::Expense | Self::SubcontractorPayout => ("expense", -1),
            Self::Quote => ("quote", 1),
        }
    }
}

/// The hand-off payload. Mirrored in TS (`src/features/ops/types.ts`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinanceHandoff {
    pub business_id: String,
    pub finance_ledger_tag: String,
    pub transaction_type: TransactionType,
    /// Positive integer cents; the sign comes from the transaction type.
    pub amount_cents: i64,
    pub currency: String,
    /// `YYYY-MM-DD`.
    pub date: String,
    pub counterparty: String,
    #[serde(default)]
    pub category: String,
    /// A file inside this business's folder (relative), e.g. `receipts/2026-11-20.png`.
    #[serde(default)]
    pub attachment_ref: Option<String>,
    #[serde(default)]
    pub memo: String,
}

/// Validate a hand-off against the locked business and build the ledger line.
pub fn to_ledger(scope: &BusinessScope, reg: &Registry, h: &FinanceHandoff, known_secrets: &[String]) -> Result<LedgerInput, String> {
    if h.business_id != scope.id() {
        return Err(format!("HANDOFF_REFUSED: businessId {:?} isn't the business this turn is locked to ({})", h.business_id, scope.id()));
    }
    if h.finance_ledger_tag != scope.ledger_tag() {
        return Err(format!("HANDOFF_REFUSED: financeLedgerTag {:?} doesn't belong to {}", h.finance_ledger_tag, scope.id()));
    }
    if h.amount_cents <= 0 {
        return Err("amountCents: a positive integer number of cents (the type sets the sign)".into());
    }
    let text = format!("{}\n{}\n{}\n{}", h.counterparty, h.category, h.memo, h.attachment_ref.as_deref().unwrap_or(""));
    let hits = super::ops_scope::cross_domain_hits(scope, reg, &text);
    if !hits.is_empty() {
        return Err(super::ops_scope::cross_domain_error(&hits));
    }
    let secrets = super::security_gate::scan_secrets(&text, known_secrets);
    if !secrets.is_empty() {
        return Err(format!("SECURITY_FAIL_CLOSED: the hand-off matched {}; it was dropped", secrets.join(", ")));
    }
    let attachment_ref = match h.attachment_ref.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(rel) => {
            let p = scope.jail(rel)?;
            if !std::fs::symlink_metadata(&p).map(|m| m.is_file()).unwrap_or(false) {
                return Err(format!("attachmentRef {rel:?}: no such file in {}'s folder", scope.id()));
            }
            Some(rel.replace('\\', "/"))
        }
    };
    let (kind, sign) = h.transaction_type.ledger_kind();
    let input = LedgerInput {
        date: h.date.clone(),
        amount_cents: sign * h.amount_cents,
        currency: h.currency.clone(),
        kind: kind.into(),
        payee: h.counterparty.clone(),
        category: h.category.clone(),
        memo: h.memo.clone(),
        source: "bizops".into(),
        ledger_tag: Some(scope.ledger_tag().to_string()),
        tx_type: Some(h.transaction_type.as_str().into()),
        attachment_ref,
    };
    super::finance_vault::validate(&input)
}

/// Hand a financial event to Finance. Needs the user's confirmation.
#[tauri::command]
pub async fn bizops_finance_handoff(handoff: Value, approved: Option<bool>, state: tauri::State<'_, super::dispatch::DispatchState>, os: tauri::State<'_, super::os_core::OsState>) -> Result<Value, String> {
    let h: FinanceHandoff = serde_json::from_value(handoff).map_err(|e| format!("HANDOFF_REFUSED: schema: {e}"))?;
    let store = super::business_registry::store()?;
    let scope = store.scope(&h.business_id)?;
    let known = super::devqueue::known_secrets(state.inner(), os.inner());
    let input = to_ledger(&scope, &store.snapshot(), &h, &known)?;
    if approved != Some(true) {
        return Err("PERMISSION_REQUIRED:finance-handoff".into());
    }
    super::integrity::ensure()?;
    let e = super::finance_vault::write_input(input, true, "bizops").await?;
    let _ = super::ops_audit::append("bizops", "finance_handoff", scope.id(), &e.id, &format!("{} {}", h.transaction_type.as_str(), e.input.currency));
    Ok(json!({ "id": e.id, "ledgerTag": e.input.tag(), "kind": e.input.kind, "amountCents": e.input.amount_cents, "currency": e.input.currency, "date": e.input.date }))
}

#[cfg(test)]
mod tests {
    use super::super::business_registry::tests::active_store;
    use super::*;

    fn h(business: &str, tag: &str) -> FinanceHandoff {
        FinanceHandoff {
            business_id: business.into(),
            finance_ledger_tag: tag.into(),
            transaction_type: TransactionType::SubcontractorPayout,
            amount_cents: 125_000,
            currency: "cad".into(),
            date: "2026-11-20".into(),
            counterparty: "Ridge Electric".into(),
            category: "subcontract".into(),
            attachment_ref: None,
            memo: "rough-in, Smith reno".into(),
        }
    }

    #[test]
    fn a_handoff_lands_only_in_its_own_ledger() {
        let (s, dir) = active_store("handoff");
        let reg = s.snapshot();
        let t = s.scope("trades_contracting").unwrap();
        let l = to_ledger(&t, &reg, &h("trades_contracting", "trades_contracting"), &[]).unwrap();
        assert_eq!((l.ledger_tag.as_deref(), l.kind.as_str(), l.amount_cents, l.currency.as_str(), l.tx_type.as_deref()), (Some("trades_contracting"), "expense", -125_000, "CAD", Some("subcontractor_payout")));
        // Locked to Trades: E-commerce's id or tag is refused, never re-tagged.
        assert!(to_ledger(&t, &reg, &h("supplements_ecom", "supplements_ecom"), &[]).unwrap_err().starts_with("HANDOFF_REFUSED"));
        assert!(to_ledger(&t, &reg, &h("trades_contracting", "supplements_ecom"), &[]).unwrap_err().starts_with("HANDOFF_REFUSED"));
        // Another business named in the text.
        let leak = FinanceHandoff { memo: "split with BF Supplements".into(), ..h("trades_contracting", "trades_contracting") };
        assert!(to_ledger(&t, &reg, &leak, &[]).unwrap_err().starts_with("CROSS_DOMAIN"));
        // Secrets, unknown fields, bad amounts.
        let secret = FinanceHandoff { memo: "card sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(), ..h("trades_contracting", "trades_contracting") };
        assert!(to_ledger(&t, &reg, &secret, &[]).is_err());
        assert!(to_ledger(&t, &reg, &FinanceHandoff { amount_cents: -5, ..h("trades_contracting", "trades_contracting") }, &[]).is_err());
        let extra = json!({ "businessId": "trades_contracting", "financeLedgerTag": "trades_contracting", "transactionType": "invoice", "amountCents": 1, "currency": "CAD", "date": "2026-11-20", "counterparty": "x", "ragChunks": ["…"] });
        assert!(serde_json::from_value::<FinanceHandoff>(extra).is_err(), "no context can ride along");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn attachments_are_jailed_and_must_exist() {
        let (s, dir) = active_store("attach");
        let reg = s.snapshot();
        let t = s.scope("trades_contracting").unwrap();
        let e = s.scope("supplements_ecom").unwrap();
        t.write_note(&reg, "receipts/r1.txt", "receipt").unwrap();
        let ok = FinanceHandoff { attachment_ref: Some(r"receipts\r1.txt".into()), ..h("trades_contracting", "trades_contracting") };
        assert_eq!(to_ledger(&t, &reg, &ok, &[]).unwrap().attachment_ref.as_deref(), Some("receipts/r1.txt"));
        for bad in ["receipts/missing.txt", "../supplements_ecom/x.txt", "C:/Windows/win.ini", "/etc/passwd"] {
            let x = FinanceHandoff { attachment_ref: Some(bad.into()), ..h("trades_contracting", "trades_contracting") };
            assert!(to_ledger(&t, &reg, &x, &[]).is_err(), "{bad}");
        }
        // E-commerce can't reference Trades' receipt.
        let x = FinanceHandoff { attachment_ref: Some("../trades_contracting/receipts/r1.txt".into()), ..h("supplements_ecom", "supplements_ecom") };
        assert!(to_ledger(&e, &reg, &x, &[]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn types_map_to_kinds_and_signs() {
        let (s, dir) = active_store("kinds");
        let reg = s.snapshot();
        let e = s.scope("supplements_ecom").unwrap();
        for (t, kind, sign) in [(TransactionType::EcomOrder, "income", 1), (TransactionType::Invoice, "income", 1), (TransactionType::Receipt, "expense", -1), (TransactionType::Expense, "expense", -1), (TransactionType::Quote, "quote", 1)] {
            let x = FinanceHandoff { transaction_type: t, counterparty: "Shopify payout".into(), memo: "".into(), category: "sales".into(), ..h("supplements_ecom", "supplements_ecom") };
            let l = to_ledger(&e, &reg, &x, &[]).unwrap();
            assert_eq!((l.kind.as_str(), l.amount_cents.signum()), (kind, sign), "{t:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
