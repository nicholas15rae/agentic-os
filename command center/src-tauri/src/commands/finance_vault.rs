//! Finance (Financer / bookkeeping) — the sealed vault, physically apart from the agent mesh.
//!
//! - **Storage**: `<config dir>/vault/finance/ledger.aosv`, AES-256-GCM (`memory::seal`, PBKDF2
//!   600k) under a random 256-bit key kept in the OS keychain under its OWN service
//!   (`agentic-os-finance-vault`), never the shared secrets service. Nothing finance-related is in
//!   tasks.db, the memory tiers, AnythingLLM or training logs.
//! - **State**: `LOCKED_VAULT` by default. It opens only on an explicit user unlock
//!   (`finance_vault_unlock`) or for one strictly schema-validated delegated ledger write, which
//!   opens, writes and re-seals in one call. It re-seals itself after `vault_idle_minutes`.
//! - **No background loop** touches it. The only timer is the re-seal watchdog, which runs while the
//!   vault is open and ends when it seals.
//! - **Scoped Librarian / Garbage**: `finance_search` is a keyword index over the decrypted ledger,
//!   available only while open (the mesh Librarian can't reach it). Sealing drops every decrypted
//!   byte (the scoped Garbage hook).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const KEY_SERVICE: &str = "agentic-os-finance-vault";
const KEY_ACCOUNT: &str = "ledger-key";
pub const LEDGER_FILE: &str = "ledger.aosv";
/// `quote` is a non-posting record (an estimate sent or received): kept in the ledger, never a
/// balance movement.
pub const KINDS: [&str; 4] = ["expense", "income", "transfer", "quote"];
/// The one AnythingLLM workspace finance may have: role `finance` -> slug `finance`, never with
/// embedded documents (the Finance agent gets ledger rows per turn, by tag, from this vault).
pub const FINANCE_WORKSPACE: &str = "finance";
/// The ledger tag of entries written before ledgers were partitioned (personal / untagged).
pub const UNTAGGED: &str = "personal";
const AMOUNT_MAX: i64 = 100_000_000_000; // 1e9 in currency units, as cents

/// One ledger line. Unknown fields are refused (schema-validated writes only).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LedgerInput {
    /// `YYYY-MM-DD`.
    pub date: String,
    /// Signed integer cents (no floats in a ledger).
    pub amount_cents: i64,
    /// ISO 4217, e.g. `CAD`.
    pub currency: String,
    pub kind: String,
    pub payee: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub memo: String,
    /// Where it came from (`manual`, `receipt-scan`, `tony`…).
    #[serde(default)]
    pub source: String,
    /// The ledger partition (a registry `financeLedgerTag`). Missing = [`UNTAGGED`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ledger_tag: Option<String>,
    /// The business event this came from (`invoice`, `receipt`…), for Biz Ops hand-offs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tx_type: Option<String>,
    /// A reference to a supporting file inside the business's own folder (never its content).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ref: Option<String>,
}

impl LedgerInput {
    pub fn tag(&self) -> &str {
        self.ledger_tag.as_deref().unwrap_or(UNTAGGED)
    }
}

/// `^[a-z][a-z0-9_]{1,31}$` (a registry business id) or `personal`.
pub fn valid_ledger_tag(t: &str) -> bool {
    let b = t.as_bytes();
    (2..=32).contains(&b.len()) && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

/// Observer / health: a finance-named workspace mapping other than exactly `finance -> finance`
/// is an anomaly (no finance RAG store anywhere else, no ledger embedded under another role).
pub fn finance_mapping_anomaly(workspaces: &std::collections::BTreeMap<String, String>) -> bool {
    workspaces.iter().any(|(k, v)| {
        let named = k.contains("financ") || v.to_ascii_lowercase().contains("financ");
        named && !(k == FINANCE_WORKSPACE && v == FINANCE_WORKSPACE)
    })
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub id: String,
    #[serde(flatten)]
    pub input: LedgerInput,
    /// Unix ms.
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Ledger {
    pub version: u32,
    pub entries: Vec<LedgerEntry>,
}

fn clean(s: &str, max: usize, what: &str, required: bool) -> Result<String, String> {
    let t = s.trim();
    if t.chars().any(char::is_control) {
        return Err(format!("{what}: one line, no control characters"));
    }
    if required && t.is_empty() {
        return Err(format!("{what} is required"));
    }
    if t.chars().count() > max {
        return Err(format!("{what}: at most {max} characters"));
    }
    Ok(t.to_string())
}

/// The schema check every write passes (pure).
pub fn validate(i: &LedgerInput) -> Result<LedgerInput, String> {
    let d = i.date.trim();
    let ok_date = d.len() == 10 && d.chars().enumerate().all(|(k, c)| if k == 4 || k == 7 { c == '-' } else { c.is_ascii_digit() }) && chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok();
    if !ok_date {
        return Err("date: YYYY-MM-DD".into());
    }
    if i.amount_cents == 0 || i.amount_cents.abs() > AMOUNT_MAX {
        return Err("amountCents: a non-zero integer number of cents".into());
    }
    let cur = i.currency.trim().to_ascii_uppercase();
    if cur.len() != 3 || !cur.chars().all(|c| c.is_ascii_uppercase()) {
        return Err("currency: a 3-letter ISO code (CAD, USD…)".into());
    }
    let kind = i.kind.trim().to_ascii_lowercase();
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("kind: one of {}", KINDS.join(", ")));
    }
    Ok(LedgerInput {
        date: d.into(),
        amount_cents: i.amount_cents,
        currency: cur,
        kind,
        payee: clean(&i.payee, 120, "payee", true)?,
        category: clean(&i.category, 40, "category", false)?,
        memo: clean(&i.memo, 500, "memo", false)?,
        source: clean(if i.source.trim().is_empty() { "manual" } else { &i.source }, 40, "source", false)?,
        ledger_tag: match i.ledger_tag.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(t) if valid_ledger_tag(t) => Some(t.to_string()),
            Some(t) => return Err(format!("ledgerTag {:?}: a business id (a-z 0-9 _)", t.chars().take(40).collect::<String>())),
        },
        tx_type: match i.tx_type.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(t) => Some(clean(t, 32, "txType", true)?),
        },
        attachment_ref: match i.attachment_ref.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(t) => Some(clean(t, 200, "attachmentRef", true)?),
        },
    })
}

// ── Sealing ─────────────────────────────────────────────────────────────────

pub fn seal_ledger(l: &Ledger, key: &str) -> Result<Vec<u8>, String> {
    super::memory::seal(&serde_json::to_vec(l).map_err(|e| e.to_string())?, key)
}

pub fn open_ledger(bytes: &[u8], key: &str) -> Result<Ledger, String> {
    serde_json::from_slice(&super::memory::open(bytes, key)?).map_err(|e| format!("ledger unreadable: {e}"))
}

fn read_ledger(path: &Path, key: &str) -> Result<Ledger, String> {
    match std::fs::read(path) {
        Ok(b) => open_ledger(&b, key),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Ledger { version: 1, entries: vec![] }),
        Err(e) => Err(format!("ledger: {e}")),
    }
}

fn write_ledger(path: &Path, l: &Ledger, key: &str) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    super::staging::atomic_write(path, &seal_ledger(l, key)?)
}

/// The vault key from its own keychain service, created (32 random bytes) on first unlock.
fn vault_key(create: bool) -> Result<String, String> {
    use aes_gcm::aead::rand_core::RngCore;
    use base64::Engine;
    let e = keyring::Entry::new(KEY_SERVICE, KEY_ACCOUNT).map_err(|e| e.to_string())?;
    match e.get_password() {
        Ok(k) => Ok(k),
        Err(keyring::Error::NoEntry) if create => {
            let mut b = [0u8; 32];
            aes_gcm::aead::OsRng.fill_bytes(&mut b);
            let k = base64::engine::general_purpose::STANDARD.encode(b);
            e.set_password(&k).map_err(|e| format!("keychain: {e}"))?;
            Ok(k)
        }
        Err(keyring::Error::NoEntry) => Err("the Finance vault has no key yet: unlock it once to create one".into()),
        Err(e) => Err(format!("keychain: {e}")),
    }
}

// ── Live state ──────────────────────────────────────────────────────────────

struct Open {
    key: String,
    ledger: Ledger,
    last_use: Instant,
}

#[derive(Default)]
struct Vault {
    dir: Option<PathBuf>,
    open: Option<Open>,
}

fn vault() -> &'static Mutex<Vault> {
    static V: OnceLock<Mutex<Vault>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(Vault::default()))
}

/// `<config dir>/vault/finance` (lib.rs setup).
pub fn init(config_dir: &Path) {
    vault().lock().unwrap().dir = Some(config_dir.join("vault").join("finance"));
    super::arbiter::get().set_vault_open(false);
}

fn path() -> Result<PathBuf, String> {
    vault().lock().unwrap().dir.as_ref().map(|d| d.join(LEDGER_FILE)).ok_or_else(|| "the Finance vault isn't initialised".into())
}

pub fn is_open() -> bool {
    vault().lock().unwrap().open.is_some()
}

fn unlock_with(key: String) -> Result<usize, String> {
    let p = path()?;
    let ledger = read_ledger(&p, &key)?;
    let n = ledger.entries.len();
    vault().lock().unwrap().open = Some(Open { key, ledger, last_use: Instant::now() });
    super::arbiter::get().set_vault_open(true);
    Ok(n)
}

/// Seal: drop every decrypted byte (the scoped Garbage hook).
pub fn lock() {
    let was = vault().lock().unwrap().open.take();
    if let Some(mut o) = was {
        o.key.clear();
        o.ledger.entries.clear();
    }
    super::arbiter::get().set_vault_open(false);
}

fn with_open<T>(f: impl FnOnce(&mut Open) -> Result<T, String>) -> Result<T, String> {
    let mut v = vault().lock().unwrap();
    let o = v.open.as_mut().ok_or("LOCKED_VAULT: the Finance vault is sealed; unlock it first")?;
    o.last_use = Instant::now();
    f(o)
}

fn add_entry(o: &mut Open, input: LedgerInput, p: &Path) -> Result<LedgerEntry, String> {
    let now = super::arbiter::now_ms();
    let e = LedgerEntry { id: format!("fin-{now}-{}", o.ledger.entries.len()), input, created_at: now };
    let mut next = o.ledger.clone();
    next.version = 1;
    next.entries.push(e.clone());
    write_ledger(p, &next, &o.key)?;
    o.ledger = next;
    Ok(e)
}

/// The scoped Librarian over one partition: `tag` keeps only that ledger's rows.
pub fn search_tagged(l: &Ledger, tag: Option<&str>, q: &str, k: usize) -> Vec<LedgerEntry> {
    let part = Ledger { version: l.version, entries: l.entries.iter().filter(|e| tag.map_or(true, |t| e.input.tag() == t)).cloned().collect() };
    search(&part, q, k)
}

/// The scoped Librarian: keyword match over payee / category / memo / date (open vault only).
pub fn search(l: &Ledger, q: &str, k: usize) -> Vec<LedgerEntry> {
    let terms: Vec<String> = q.to_lowercase().split_whitespace().filter(|w| !w.is_empty()).map(str::to_string).collect();
    let mut hits: Vec<(usize, &LedgerEntry)> = l
        .entries
        .iter()
        .map(|e| {
            let hay = format!("{} {} {} {} {}", e.input.payee, e.input.category, e.input.memo, e.input.date, e.input.kind).to_lowercase();
            (terms.iter().filter(|t| hay.contains(t.as_str())).count(), e)
        })
        .filter(|(n, _)| *n > 0 || terms.is_empty())
        .collect();
    hits.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.input.date.cmp(&a.1.input.date)));
    hits.into_iter().take(k).map(|(_, e)| e.clone()).collect()
}

/// Re-seal after `idle` without use: a watchdog that lives only while the vault is open.
fn spawn_relock(idle: Duration) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let idle_for = vault().lock().unwrap().open.as_ref().map(|o| o.last_use.elapsed());
            match idle_for {
                None => return,
                Some(d) if d >= idle => {
                    lock();
                    return;
                }
                Some(_) => {}
            }
        }
    });
}

fn summary(e: &LedgerEntry) -> Value {
    json!({ "id": e.id, "date": e.input.date, "amountCents": e.input.amount_cents, "currency": e.input.currency, "kind": e.input.kind, "payee": e.input.payee, "category": e.input.category, "memo": e.input.memo, "source": e.input.source, "ledgerTag": e.input.tag(), "txType": e.input.tx_type, "attachmentRef": e.input.attachment_ref })
}

/// The isolation check (system health): the vault sits apart from the mesh and is sealed at rest.
pub fn isolation_check(cfg: &super::os_core::OsConfig, mesh_roots: &[PathBuf]) -> Value {
    let dir = vault().lock().unwrap().dir.clone();
    let mut checks = vec![];
    let mut ok = true;
    let mut check = |name: &str, pass: bool, why: String| {
        ok &= pass;
        checks.push(json!({ "check": name, "pass": pass, "detail": why }));
    };
    match &dir {
        Some(d) => {
            let ledger = d.join(LEDGER_FILE);
            let sealed = std::fs::read(&ledger).map(|b| b.starts_with(b"AOSV1")).unwrap_or(true);
            check("ledger sealed at rest", sealed, if ledger.exists() { "AES-256-GCM vault file".into() } else { "no ledger yet".into() });
            let blocked = super::security_gate::MESH_AGENTS.iter().all(|a| super::security_gate::check_path(a, &ledger, mesh_roots).is_err());
            check("mesh agents blocked from vault/finance", blocked, format!("{} mesh agent(s) checked against the path gate", super::security_gate::MESH_AGENTS.len()));
        }
        None => check("vault initialised", false, "the vault dir is not set".into()),
    }
    check("not a shared memory namespace", !super::memtier::valid_ns("finance"), "memtier refuses `finance`".into());
    let mapped = finance_mapping_anomaly(&cfg.anythingllm.workspaces);
    check("no finance RAG workspace (only the empty `finance` chat workspace)", !mapped, if mapped { "a finance-named workspace other than finance -> finance is mapped".into() } else { "none besides finance -> finance".into() });
    check("key in its own keychain service", true, KEY_SERVICE.into());
    json!({ "ok": ok, "open": is_open(), "checks": checks })
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn finance_vault_status() -> Value {
    let v = vault().lock().unwrap();
    let key = keyring::Entry::new(KEY_SERVICE, KEY_ACCOUNT).ok().map(|e| e.get_password().is_ok()).unwrap_or(false);
    let file = v.dir.as_ref().map(|d| d.join(LEDGER_FILE).exists()).unwrap_or(false);
    json!({
        "open": v.open.is_some(),
        "entries": v.open.as_ref().map(|o| o.ledger.entries.len()),
        "hasKey": key,
        "hasLedger": file,
        "idleSecs": v.open.as_ref().map(|o| o.last_use.elapsed().as_secs()),
    })
}

/// The user's explicit unlock (the only way the vault opens for reading).
#[tauri::command]
pub async fn finance_vault_unlock(os: tauri::State<'_, super::os_core::OsState>) -> Result<Value, String> {
    let idle = Duration::from_secs(os.snapshot().roster.vault_idle_minutes.clamp(1, 240) as u64 * 60);
    let was_open = is_open();
    let n = super::arbiter::get().run_task("finance", "vault unlock", async { tauri::async_runtime::spawn_blocking(|| unlock_with(vault_key(true)?)).await.map_err(|e| e.to_string())? }).await?;
    if !was_open {
        spawn_relock(idle);
    }
    Ok(json!({ "open": true, "entries": n }))
}

#[tauri::command]
pub fn finance_vault_lock() -> Value {
    lock();
    json!({ "open": false })
}

/// The user's ledger view (open vault). `ledgerTag` narrows it to one partition.
#[tauri::command]
pub fn finance_ledger_list(limit: Option<usize>, ledger_tag: Option<String>) -> Result<Value, String> {
    let tag = ledger_tag.filter(|t| !t.trim().is_empty());
    with_open(|o| Ok(json!(o.ledger.entries.iter().rev().filter(|e| tag.as_deref().map_or(true, |t| e.input.tag() == t)).take(limit.unwrap_or(100).min(1000)).map(summary).collect::<Vec<_>>())))
}

#[tauri::command]
pub fn finance_search(q: String, k: Option<usize>, ledger_tag: Option<String>) -> Result<Value, String> {
    let tag = ledger_tag.filter(|t| !t.trim().is_empty());
    with_open(|o| Ok(json!(search_tagged(&o.ledger, tag.as_deref(), &q, k.unwrap_or(10).min(50)).iter().map(summary).collect::<Vec<_>>())))
}

/// The Finance Librarian: deterministic retrieval over ONE ledger partition. The tag is
/// mandatory, so no caller can pull every business's rows into one context.
pub fn librarian_rows(ledger_tag: &str, q: &str, k: usize) -> Result<Vec<Value>, String> {
    if !valid_ledger_tag(ledger_tag) {
        return Err("finance_librarian: a valid ledgerTag is required".into());
    }
    with_open(|o| Ok(search_tagged(&o.ledger, Some(ledger_tag), q, k.clamp(1, 50)).iter().map(summary).collect()))
}

#[tauri::command]
pub fn finance_librarian_search(ledger_tag: String, q: String, k: Option<usize>) -> Result<Value, String> {
    Ok(json!({ "ledgerTag": ledger_tag, "rows": librarian_rows(ledger_tag.trim(), &q, k.unwrap_or(10))? }))
}

/// A ledger write. Open vault: written at once. Sealed vault: only with `delegated: true` (a
/// strictly schema-validated hand-off), which opens, writes and re-seals in one step.
#[tauri::command]
pub async fn finance_ledger_write(entry: Value, delegated: Option<bool>) -> Result<Value, String> {
    let input: LedgerInput = serde_json::from_value(entry).map_err(|e| format!("ledger schema: {e}"))?;
    write_input(input, delegated == Some(true), "tony").await.map(|e| summary(&e))
}

/// The one ledger write path (the command above and the Biz Ops -> Finance hand-off). Sealed vault:
/// only `delegated`, which opens, writes and re-seals in one step.
pub(crate) async fn write_input(input: LedgerInput, delegated: bool, from: &'static str) -> Result<LedgerEntry, String> {
    let input = validate(&input)?;
    let p = path()?;
    if is_open() {
        let e = with_open(|o| add_entry(o, input, &p))?;
        super::arbiter::get().handoff(from, "finance", "ledger write");
        return Ok(e);
    }
    if !delegated {
        return Err("LOCKED_VAULT: the Finance vault is sealed; unlock it or send a delegated write".into());
    }
    let e = super::arbiter::get()
        .run_task("finance", "delegated ledger write", async move {
            tauri::async_runtime::spawn_blocking(move || {
                unlock_with(vault_key(true)?)?;
                let r = with_open(|o| add_entry(o, input, &p));
                lock();
                r
            })
            .await
            .map_err(|e| e.to_string())?
        })
        .await?;
    super::arbiter::get().handoff(from, "finance", "delegated ledger write");
    Ok(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> LedgerInput {
        LedgerInput { date: "2026-11-20".into(), amount_cents: -4599, currency: "cad".into(), kind: "Expense".into(), payee: " Staples ".into(), category: "office".into(), memo: "".into(), source: "".into(), ledger_tag: None, tx_type: None, attachment_ref: None }
    }

    #[test]
    fn schema_is_strict() {
        let v = validate(&input()).unwrap();
        assert_eq!((v.currency.as_str(), v.kind.as_str(), v.payee.as_str(), v.source.as_str()), ("CAD", "expense", "Staples", "manual"));
        for bad in [
            LedgerInput { date: "2026-13-01".into(), ..input() },
            LedgerInput { date: "20-11-2026".into(), ..input() },
            LedgerInput { amount_cents: 0, ..input() },
            LedgerInput { currency: "C$".into(), ..input() },
            LedgerInput { kind: "gift".into(), ..input() },
            LedgerInput { payee: "".into(), ..input() },
            LedgerInput { memo: "a\nb".into(), ..input() },
        ] {
            assert!(validate(&bad).is_err(), "{bad:?}");
        }
        let extra = json!({ "date": "2026-11-20", "amountCents": 100, "currency": "CAD", "kind": "income", "payee": "x", "secretField": 1 });
        assert!(serde_json::from_value::<LedgerInput>(extra).is_err(), "unknown fields are refused");
    }

    #[test]
    fn sealed_file_is_not_plaintext_and_needs_the_key() {
        let l = Ledger { version: 1, entries: vec![LedgerEntry { id: "a".into(), input: validate(&input()).unwrap(), created_at: 1 }] };
        let b = seal_ledger(&l, "k1").unwrap();
        assert!(!String::from_utf8_lossy(&b).contains("Staples"));
        assert_eq!(open_ledger(&b, "k1").unwrap(), l);
        assert!(open_ledger(&b, "k2").is_err());
        assert_eq!(search(&l, "staples", 5).len(), 1);
        assert!(search(&l, "groceries", 5).is_empty());
    }

    #[test]
    fn ledgers_are_partitioned_by_tag() {
        let t = |tag: Option<&str>, payee: &str| LedgerEntry { id: payee.into(), input: validate(&LedgerInput { ledger_tag: tag.map(String::from), payee: payee.into(), ..input() }).unwrap(), created_at: 1 };
        let l = Ledger { version: 1, entries: vec![t(Some("trades_contracting"), "Ridge Electric"), t(Some("supplements_ecom"), "Whey Wholesale"), t(None, "Staples")] };
        let payees = |tag: Option<&str>| search_tagged(&l, tag, "", 10).into_iter().map(|e| e.input.payee).collect::<Vec<_>>();
        assert_eq!(payees(Some("trades_contracting")), ["Ridge Electric"]);
        assert_eq!(payees(Some("supplements_ecom")), ["Whey Wholesale"]);
        assert_eq!(payees(Some(UNTAGGED)), ["Staples"], "pre-partition rows read as personal");
        assert_eq!(payees(None).len(), 3, "only the user's own unfiltered view sees every ledger");
        // A keyword that only exists in another ledger finds nothing.
        assert!(search_tagged(&l, Some("supplements_ecom"), "ridge electric", 10).is_empty());
        // Tag validation, and old sealed files without the new fields still open.
        assert!(validate(&LedgerInput { ledger_tag: Some("../x".into()), ..input() }).is_err());
        let old = json!({ "date": "2026-11-20", "amountCents": 100, "currency": "CAD", "kind": "income", "payee": "x" });
        assert_eq!(serde_json::from_value::<LedgerInput>(old).unwrap().tag(), UNTAGGED);
        assert!(librarian_rows("", "x", 5).is_err(), "the Finance Librarian needs a tag");
        // Only finance → finance is allowed.
        let ws = |pairs: &[(&str, &str)]| pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<std::collections::BTreeMap<_, _>>();
        assert!(!finance_mapping_anomaly(&ws(&[("finance", "finance"), ("coder", "coder")])));
        for bad in [&[("finance_librarian", "finance-rag")][..], &[("finance", "finance-ledger")], &[("coder", "finance")], &[("financer", "x")]] {
            assert!(finance_mapping_anomaly(&ws(bad)), "{bad:?}");
        }
    }

    #[test]
    fn locked_by_default_and_lock_drops_plaintext() {
        let dir = std::env::temp_dir().join(format!("finvault-{}-{}", std::process::id(), super::super::arbiter::now_ms()));
        init(&dir);
        assert!(!is_open());
        assert!(finance_ledger_list(None, None).unwrap_err().starts_with("LOCKED_VAULT"));
        unlock_with("test-key".into()).unwrap();
        let p = path().unwrap();
        with_open(|o| add_entry(o, validate(&input()).unwrap(), &p)).unwrap();
        assert_eq!(finance_search("staples".into(), None, None).unwrap().as_array().unwrap().len(), 1);
        lock();
        assert!(!is_open());
        assert!(finance_search("staples".into(), None, None).is_err());
        // Reopen with the same key: the entry is there; the file on disk is sealed.
        assert_eq!(unlock_with("test-key".into()).unwrap(), 1);
        lock();
        assert!(!String::from_utf8_lossy(&std::fs::read(&p).unwrap()).contains("Staples"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
