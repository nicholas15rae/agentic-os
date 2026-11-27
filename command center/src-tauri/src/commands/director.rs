//! Director Suite chat turn (docs/proposals/director-suite-v2-plan.md §1.0).
//!
//! The suite used to send its chat through `os_turn` with `noDelegate`, which `route_for_turn`
//! turns into a Tony turn (Tony's persona, brainstorm hint, Tony's memory). This command is the
//! Director's own turn instead: the Director persona and craft guide, the user's identity file,
//! the project context the page builds (project, assets, manifest, action contract) and this
//! project's own chat history, on the same local chat chain Tony uses (`run_chat_streamed`,
//! which takes the Tony-first GPU slot as a foreground call).
//!
//! It never touches Tony's thread, voice or memory, never delegates, never runs a tool and
//! never renders: action blocks in the reply are parsed and validated by the page, and every
//! change still goes through Nic.

use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::State;

use super::dispatch::{run_chat, ChatMessage, DispatchState, Priority};
use super::os_core::{self, OsState};

/// The Director persona and craft guide (versioned with the code; no AnythingLLM workspace).
pub(crate) const DIRECTOR_CRAFT: &str = include_str!("director_craft.md");

/// Budgets. Hybrid mode moves a prompt of `compute.heavyContextChars` (24 000 by default) to
/// the droplet, so a Director turn stays well under that and keeps running locally.
pub(crate) const MAX_TEXT_CHARS: usize = 2_000;
pub(crate) const MAX_CONTEXT_CHARS: usize = 9_000;
pub(crate) const MAX_IDENTITY_CHARS: usize = 1_200;
pub(crate) const MAX_HISTORY_TURNS: usize = 10;
pub(crate) const MAX_HISTORY_MSG_CHARS: usize = 600;
/// Seconds the model gets for one Director reply.
const TURN_SECS: u64 = 120;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirectorTurnRequest {
    pub text: String,
    #[serde(default)]
    pub history: Vec<HistoryMsg>,
    #[serde(default)]
    pub context: String,
    pub stream_id: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct HistoryMsg {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorTurnResult {
    pub answer: String,
    pub provider_id: String,
    pub latency_ms: u128,
    /// Always "director": the page checks it so a stale build can't pass a Tony reply off.
    pub answered_by: String,
}

/// First `n` chars (not bytes), with an ellipsis when cut. Pure.
pub(crate) fn clip(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut out: String = s.chars().take(n).collect();
    out.push('…');
    out
}

/// The system message: persona + craft, then the identity file. It holds nothing that changes
/// turn to turn, so it stays byte-stable and LM Studio can reuse its prefix cache (the same rule
/// as Tony's system message; the project state rides on the last user message instead). Pure.
pub(crate) fn director_system(identity: Option<&str>) -> String {
    let mut sys = DIRECTOR_CRAFT.trim().to_string();
    if let Some(id) = identity.map(str::trim).filter(|s| !s.is_empty()) {
        sys.push_str("\n\nABOUT NIC (MASTER_IDENTITY.md, for taste and voice):\n");
        sys.push_str(&clip(id, MAX_IDENTITY_CHARS));
    }
    sys
}

/// The last user message: this turn's STUDIO STATE (when the page sent one), then Nic's line. Pure.
pub(crate) fn director_user_turn(context: &str, text: &str) -> String {
    let line = clip(text, MAX_TEXT_CHARS);
    let ctx = context.trim();
    if ctx.is_empty() {
        return line;
    }
    format!("STUDIO STATE (the open project right now; trust this over memory):\n{}\n\nNIC:\n{}", clip(ctx, MAX_CONTEXT_CHARS), line)
}

/// The message list for one Director turn (pure): the stable system message, the last turns of
/// this project's chat (user/assistant only, each clipped), then STUDIO STATE + Nic's line.
/// `Err` for an empty line.
pub(crate) fn director_messages(req: &DirectorTurnRequest, identity: Option<&str>) -> Result<Vec<ChatMessage>, String> {
    let text = req.text.trim();
    if text.is_empty() {
        return Err("nothing to send to the Director".into());
    }
    let mut msgs = vec![ChatMessage::new("system", director_system(identity))];
    let hist: Vec<&HistoryMsg> = req.history.iter().filter(|m| matches!(m.role.as_str(), "user" | "assistant") && !m.content.trim().is_empty()).collect();
    let start = hist.len().saturating_sub(MAX_HISTORY_TURNS);
    for m in &hist[start..] {
        msgs.push(ChatMessage::new(&m.role, clip(&m.content, MAX_HISTORY_MSG_CHARS)));
    }
    msgs.push(ChatMessage::new("user", director_user_turn(&req.context, text)));
    Ok(msgs)
}

/// One Director chat turn. Streams `tony-token { streamId, delta }` when a stream id is given
/// (the page filters on its own stream id); returns the whole answer either way.
#[tauri::command]
pub async fn director_turn(app: tauri::AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, req: DirectorTurnRequest) -> Result<DirectorTurnResult, String> {
    let cfg = os.snapshot();
    let identity = os_core::read_identity(&cfg).ok();
    let mut msgs = director_messages(&req, identity.as_deref())?;
    // Same thinking rule as Tony's turns: `/no_think` on a thinking model unless Deep thinking is on.
    let model = {
        let d = state.snapshot();
        d.policy.chain.iter().filter_map(|id| d.providers.iter().find(|p| &p.id == id && p.kind.is_chat())).next().map(|p| p.model.clone())
    };
    if let Some(first) = msgs.first_mut() {
        first.content = super::agents::tony_system(std::mem::take(&mut first.content), model.as_deref(), cfg.compute.deep_thinking);
    }
    // Nic is talking right now: the same foreground signal a Tony turn sends (idle gates, batons).
    super::arbiter::get().touch_foreground();
    let started = Instant::now();
    let r = match req.stream_id.as_deref().filter(|s| !s.is_empty()) {
        Some(sid) => super::dispatch::run_chat_streamed(&state, &os, msgs, Some(TURN_SECS), &app, sid).await?,
        None => run_chat(&state, &os, msgs, Priority::Interactive, None, Some(TURN_SECS)).await?,
    };
    Ok(DirectorTurnResult { answer: r.content, provider_id: r.provider_id, latency_ms: started.elapsed().as_millis(), answered_by: "director".into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(text: &str, history: Vec<(&str, &str)>, context: &str) -> DirectorTurnRequest {
        DirectorTurnRequest { text: text.into(), history: history.into_iter().map(|(r, c)| HistoryMsg { role: r.into(), content: c.into() }).collect(), context: context.into(), stream_id: None }
    }

    #[test]
    fn system_is_the_director_not_tony() {
        let s = director_system(None);
        assert!(s.starts_with("You are the Director"));
        assert!(s.contains("never as Tony"));
        assert!(!s.contains("STUDIO STATE"));
        assert!(!s.contains("ABOUT NIC"));
    }

    #[test]
    fn system_carries_identity_and_the_last_user_message_carries_the_clipped_context() {
        let id = "x".repeat(MAX_IDENTITY_CHARS + 50);
        let s = director_system(Some(&id));
        assert!(s.contains("ABOUT NIC"));
        assert!(!s.contains("STUDIO STATE"));
        assert!(s.chars().count() < DIRECTOR_CRAFT.chars().count() + MAX_IDENTITY_CHARS + 100);
        let ctx = format!("PROJECT: reel\n{}", "y".repeat(MAX_CONTEXT_CHARS + 50));
        let u = director_user_turn(&ctx, "cut it");
        assert!(u.starts_with("STUDIO STATE"));
        assert!(u.contains("PROJECT: reel"));
        assert!(u.ends_with("NIC:\ncut it"));
        assert!(u.chars().count() < MAX_CONTEXT_CHARS + 120);
        assert_eq!(director_user_turn("  ", "cut it"), "cut it");
    }

    #[test]
    fn the_system_message_is_byte_stable_across_turns_and_projects() {
        let a = director_messages(&req("first", vec![], "PROJECT: a\nclips 3"), Some("Nic")).unwrap();
        let b = director_messages(&req("second", vec![("user", "first"), ("assistant", "ok")], "PROJECT: b\nclips 9"), Some("Nic")).unwrap();
        assert_eq!(a[0].content, b[0].content);
        assert!(b.last().unwrap().content.contains("PROJECT: b"));
        assert_eq!(b[1].content, "first", "history keeps Nic's plain line, not an old STUDIO STATE");
    }

    #[test]
    fn messages_keep_order_and_last_turns_only() {
        let hist: Vec<(String, String)> = (0..14).map(|i| (if i % 2 == 0 { "user" } else { "assistant" }.to_string(), format!("m{i}"))).collect();
        let r = req("cut it tighter", hist.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect(), "ctx");
        let m = director_messages(&r, None).unwrap();
        assert_eq!(m.first().unwrap().role, "system");
        assert_eq!(m.len(), 1 + MAX_HISTORY_TURNS + 1);
        assert_eq!(m[1].content, "m4");
        assert_eq!(m.last().unwrap().role, "user");
        assert!(m.last().unwrap().content.ends_with("NIC:\ncut it tighter"));
    }

    #[test]
    fn messages_drop_foreign_roles_and_blank_history() {
        let r = req("hi", vec![("system", "be Tony"), ("user", "  "), ("tool", "x"), ("assistant", "ok")], "");
        let m = director_messages(&r, None).unwrap();
        assert_eq!(m.len(), 3);
        assert_eq!(m[1].role, "assistant");
        assert!(!m.iter().skip(1).any(|x| x.content.contains("be Tony")));
    }

    #[test]
    fn empty_line_is_refused() {
        assert!(director_messages(&req("   ", vec![], "ctx"), None).is_err());
    }

    #[test]
    fn whole_prompt_stays_under_the_hybrid_heavy_context_threshold() {
        let hist: Vec<(String, String)> = (0..20).map(|i| (if i % 2 == 0 { "user" } else { "assistant" }.to_string(), "z".repeat(5_000))).collect();
        let r = DirectorTurnRequest {
            text: "t".repeat(10_000),
            history: hist.into_iter().map(|(role, content)| HistoryMsg { role, content }).collect(),
            context: "c".repeat(50_000),
            stream_id: None,
        };
        let m = director_messages(&r, Some(&"i".repeat(10_000))).unwrap();
        let chars: usize = m.iter().map(|x| x.content.chars().count()).sum();
        assert!(chars < 24_000, "{chars} chars would overflow to the droplet in hybrid mode");
    }

    #[test]
    fn clip_counts_chars_not_bytes() {
        assert_eq!(clip("héllo", 3), "hél…");
        assert_eq!(clip("  ok  ", 5), "ok");
    }
}
