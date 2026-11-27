//! Per-task abort tokens: the hard stop behind Play Place's Cancel / Delete.
//!
//! `taskworker::cancel_task` only marks a task failed in `tasks.db`; the worker notices at its
//! next checkpoint, so a model call already in flight would keep the GPU slot (and LM Studio
//! generating) until it returned. Every worker model call races `aborted(task_id)`: when Cancel
//! fires `abort(task_id)` the call's future is dropped at once — the HTTP request goes (LM
//! Studio stops generating), the `SlotGuard` drops (the GPU permit is released, after its settle
//! window if one was armed), and an offloaded CLI is killed with its whole process tree.
//!
//! Tokens are tiny and in-memory only: nothing survives a restart, and nothing needs to — a
//! restart kills every in-flight call anyway (the CLI children run in kill-on-close jobs).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// The error text an aborted call returns (the worker treats it like any failed step; the task
/// is already terminal in `tasks.db`, so nothing is retried).
pub const CANCELLED: &str = "CANCELLED: build cancelled by user";

/// Above this many tokens, ones nobody waits on and that were never aborted are pruned.
const PRUNE_AT: usize = 256;

#[derive(Default)]
pub struct Token {
    flag: AtomicBool,
    notify: tokio::sync::Notify,
}

impl Token {
    pub fn is_aborted(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Resolves once this token is aborted (immediately if it already was). Cancel-safe.
    pub async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_aborted() {
                return;
            }
            notified.await;
        }
    }

    fn fire(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Token>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<Token>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// The token for `task_id` (created on first use).
pub fn token(task_id: &str) -> Arc<Token> {
    let mut g = registry().lock().unwrap();
    if g.len() >= PRUNE_AT {
        g.retain(|_, t| t.is_aborted() || Arc::strong_count(t) > 1);
    }
    g.entry(task_id.to_string()).or_default().clone()
}

/// Abort every in-flight call of `task_id` now (and any it starts later, until `clear`).
pub fn abort(task_id: &str) {
    token(task_id).fire();
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn is_aborted(task_id: &str) -> bool {
    registry().lock().unwrap().get(task_id).is_some_and(|t| t.is_aborted())
}

/// Forget `task_id`'s token (a retried task runs again).
pub fn clear(task_id: &str) {
    registry().lock().unwrap().remove(task_id);
}

/// Run `fut` unless `task_id` is aborted first; an abort drops `fut` and returns `CANCELLED`.
pub async fn race<T>(task_id: &str, fut: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    let t = token(task_id);
    if t.is_aborted() {
        return Err(CANCELLED.into());
    }
    tokio::select! {
        r = fut => r,
        _ = t.wait() => Err(CANCELLED.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn abort_drops_the_in_flight_future() {
        tauri::async_runtime::block_on(abort_drops());
    }

    async fn abort_drops() {
        let id = "t-abort-drop";
        clear(id);
        let dropped = Arc::new(AtomicBool::new(false));
        struct OnDrop(Arc<AtomicBool>);
        impl Drop for OnDrop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let guard = OnDrop(dropped.clone());
        let slow = async move {
            let _g = guard;
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok::<_, String>(1)
        };
        let killer = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            abort(id);
        };
        let (r, _) = tokio::join!(race(id, slow), killer);
        assert_eq!(r.unwrap_err(), CANCELLED);
        assert!(dropped.load(Ordering::SeqCst), "the call's resources (GPU guard, HTTP request) are dropped");
        assert!(is_aborted(id));
        clear(id);
        assert!(!is_aborted(id));
    }

    #[test]
    fn an_aborted_task_starts_nothing_new() {
        tauri::async_runtime::block_on(async {
        let id = "t-abort-pre";
        abort(id);
        let r = race(id, async { Ok::<_, String>(7) }).await;
        assert!(r.is_err());
        clear(id);
        assert_eq!(race(id, async { Ok::<_, String>(7) }).await.unwrap(), 7);
        clear(id);
        });
    }

    #[test]
    fn untouched_tasks_run_normally() {
        assert_eq!(tauri::async_runtime::block_on(race("t-abort-none", async { Ok::<_, String>(3) })).unwrap(), 3);
        clear("t-abort-none");
    }
}
