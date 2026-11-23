//! Append-only audit trail for Operations, Security, Garbage and the review queue.
//!
//! - `<config dir>/security/ops-audit.db` (SQLite). `BEFORE UPDATE` / `BEFORE DELETE` triggers
//!   abort any change to a written row (the `envelope.rs` handoff_log pattern). No command
//!   exposes an update or a delete.
//! - **Hash chain**: each row stores `prev_hash` and `row_hash = sha256(prev | seq | at | actor |
//!   action | business | item | detail)`, so editing or removing a row with an outside tool
//!   (after dropping the triggers) breaks [`verify_chain`], which runs at startup and is
//!   shown to the Observer and the user.
//! - Details are clipped and refused if they look like a secret. The log records what happened
//!   and to which item, never note contents.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

const GENESIS: &str = "genesis";
const DETAIL_MAX: usize = 600;

pub struct AuditLog {
    conn: Mutex<Connection>,
}

fn row_hash(prev: &str, seq: i64, at: i64, actor: &str, action: &str, business: &str, item: &str, detail: &str) -> String {
    super::integrity::sha256_hex(format!("{prev}|{seq}|{at}|{actor}|{action}|{business}|{item}|{detail}").as_bytes())
}

impl AuditLog {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| format!("audit db: {e}"))?;
        Self::with_conn(conn)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn in_memory() -> Result<Self, String> {
        Self::with_conn(Connection::open_in_memory().map_err(|e| e.to_string())?)
    }

    fn with_conn(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS audit (
                seq INTEGER PRIMARY KEY,
                at INTEGER NOT NULL,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                business_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                detail TEXT NOT NULL,
                prev_hash TEXT NOT NULL,
                row_hash TEXT NOT NULL
             );
             CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
             CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;",
        )
        .map_err(|e| format!("audit schema: {e}"))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn append(&self, actor: &str, action: &str, business: &str, item: &str, detail: &str) -> Result<i64, String> {
        let clip = |s: &str, n: usize| s.chars().filter(|c| !c.is_control() || *c == ' ').take(n).collect::<String>();
        let mut detail = clip(detail, DETAIL_MAX);
        if !super::security_gate::scan_secrets(&detail, &[]).is_empty() {
            detail = "[detail withheld: it looked like a secret]".into();
        }
        let (actor, action, business, item) = (clip(actor, 40), clip(action, 60), clip(business, 40), clip(item, 80));
        let c = self.conn.lock().unwrap();
        let last: Option<(i64, String)> = c.query_row("SELECT seq, row_hash FROM audit ORDER BY seq DESC LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
        let (seq, prev) = match last {
            Some((s, h)) => (s + 1, h),
            None => (1, GENESIS.to_string()),
        };
        let at = super::arbiter::now_ms() as i64;
        let h = row_hash(&prev, seq, at, &actor, &action, &business, &item, &detail);
        c.execute("INSERT INTO audit (seq, at, actor, action, business_id, item_id, detail, prev_hash, row_hash) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![seq, at, actor, action, business, item, detail, prev, h])
            .map_err(|e| format!("audit append: {e}"))?;
        Ok(seq)
    }

    pub fn recent(&self, limit: usize) -> Result<Vec<Value>, String> {
        let c = self.conn.lock().unwrap();
        let mut st = c.prepare("SELECT seq, at, actor, action, business_id, item_id, detail FROM audit ORDER BY seq DESC LIMIT ?1").map_err(|e| e.to_string())?;
        let rows = st
            .query_map([limit.clamp(1, 1000) as i64], |r| {
                Ok(json!({ "seq": r.get::<_, i64>(0)?, "at": r.get::<_, i64>(1)?, "actor": r.get::<_, String>(2)?, "action": r.get::<_, String>(3)?, "businessId": r.get::<_, String>(4)?, "itemId": r.get::<_, String>(5)?, "detail": r.get::<_, String>(6)? }))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Walk the chain: `Ok(rows)` or the first broken row.
    pub fn verify_chain(&self) -> Result<usize, String> {
        let c = self.conn.lock().unwrap();
        let mut st = c.prepare("SELECT seq, at, actor, action, business_id, item_id, detail, prev_hash, row_hash FROM audit ORDER BY seq").map_err(|e| e.to_string())?;
        let mut rows = st.query([]).map_err(|e| e.to_string())?;
        let (mut prev, mut want_seq, mut n) = (GENESIS.to_string(), 1i64, 0usize);
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            let seq: i64 = r.get(0).map_err(|e| e.to_string())?;
            let g = |i: usize| r.get::<_, String>(i).map_err(|e| e.to_string());
            let at: i64 = r.get(1).map_err(|e| e.to_string())?;
            let (actor, action, biz, item, detail, p, h) = (g(2)?, g(3)?, g(4)?, g(5)?, g(6)?, g(7)?, g(8)?);
            if seq != want_seq {
                return Err(format!("audit chain broken: row {want_seq} is missing (next is {seq})"));
            }
            if p != prev || h != row_hash(&p, seq, at, &actor, &action, &biz, &item, &detail) {
                return Err(format!("audit chain broken at row {seq}: it was changed"));
            }
            prev = h;
            want_seq += 1;
            n += 1;
        }
        Ok(n)
    }
}

static LOG: OnceLock<AuditLog> = OnceLock::new();

/// lib.rs setup. Verifies the chain at once; a broken chain is reported, never "repaired".
pub fn init(config_dir: &Path) {
    match AuditLog::open(&config_dir.join("security").join("ops-audit.db")) {
        Ok(l) => {
            if let Err(e) = l.verify_chain() {
                eprintln!("[audit] {e}");
                super::events::publish_note("observer", "audit_chain_broken", "milestone", &e, None);
            }
            let _ = LOG.set(l);
        }
        Err(e) => eprintln!("[audit] {e}"),
    }
}

#[cfg(test)]
pub fn init_for_test() {
    let _ = LOG.get_or_init(|| AuditLog::in_memory().unwrap());
}

pub fn append(actor: &str, action: &str, business: &str, item: &str, detail: &str) -> Result<i64, String> {
    LOG.get().ok_or("the audit log isn't open")?.append(actor, action, business, item, detail)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn recent(limit: usize) -> Result<Vec<Value>, String> {
    LOG.get().ok_or("the audit log isn't open")?.recent(limit)
}

#[tauri::command]
pub fn ops_audit_recent(limit: Option<usize>) -> Result<Value, String> {
    let log = LOG.get().ok_or("the audit log isn't open")?;
    Ok(json!({ "rows": log.recent(limit.unwrap_or(100))?, "chain": log.verify_chain().map(|n| json!({ "ok": true, "rows": n })).unwrap_or_else(|e| json!({ "ok": false, "error": e })) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_are_append_only_and_chained() {
        let d = std::env::temp_dir().join(format!("audit-{}-{}", std::process::id(), super::super::arbiter::now_ms()));
        let p = d.join("ops-audit.db");
        let log = AuditLog::open(&p).unwrap();
        for i in 0..5 {
            log.append("garbage", "quarantine", "supplements_ecom", &format!("q-{i}"), "empty file").unwrap();
        }
        assert_eq!(log.verify_chain().unwrap(), 5);
        {
            let c = log.conn.lock().unwrap();
            assert!(c.execute("UPDATE audit SET detail = 'nothing to see' WHERE seq = 2", []).is_err());
            assert!(c.execute("DELETE FROM audit WHERE seq = 3", []).is_err());
        }
        // Secrets never land in the log.
        log.append("bizops", "write", "x", "y", "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
        assert!(log.recent(1).unwrap()[0]["detail"].as_str().unwrap().contains("withheld"));
        drop(log);
        // An outside edit (triggers dropped first) is caught by the chain.
        {
            let c = Connection::open(&p).unwrap();
            c.execute_batch("DROP TRIGGER audit_no_update; UPDATE audit SET detail = 'tampered' WHERE seq = 2;").unwrap();
        }
        let log = AuditLog::open(&p).unwrap();
        assert!(log.verify_chain().unwrap_err().contains("row 2"));
        drop(log);
        {
            let c = Connection::open(&p).unwrap();
            c.execute_batch("DROP TRIGGER IF EXISTS audit_no_update; DROP TRIGGER audit_no_delete; DELETE FROM audit WHERE seq = 2;").unwrap();
        }
        let log = AuditLog::open(&p).unwrap();
        assert!(log.verify_chain().unwrap_err().contains("missing"));
        drop(log);
        let _ = std::fs::remove_dir_all(&d);
    }
}
