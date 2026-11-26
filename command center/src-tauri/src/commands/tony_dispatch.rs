//! Tony's dispatch packet: every Tony turn (outside Learning mode) answers with ONE object,
//! `{spoken_reply, requires_dispatch, priority, tasks[]}` (Nic's `TonyDispatch` / `TaskPacket`
//! schema, mirrored here and in `src/features/dispatcher/tony-dispatch.ts`).
//!
//! - `spoken_reply` is what the chat shows and TTS speaks (the webview pulls it out of the stream
//!   as it arrives). A reply that isn't a valid packet falls back to prose, as before.
//! - `tasks` never run from the model's say-so alone: Tony's mode decides. Solo / Learning hold
//!   them; Ask (`ask_before_dispatch`) parks them for one approval card; Builder (`auto_dispatch`)
//!   queues them at once. Every path goes through `modes::check_dispatch`.
//! - **Execution** goes to the packet queue dispatcher (`packet_queue.rs`): tasks run in
//!   `depends_on` order, GPU lanes (prompter / coder / designer) one at a time through the relay
//!   and the shared GPU slot, CPU lanes (librarian staging, security, observer) at once, each
//!   output through the Security (fail closed) and Observer (acceptance criteria, retry cap 2)
//!   gates. A Financer task is held: Finance never wakes from a model's request, only Nic's unlock
//!   or a validated ledger write.
//! - The prompt never names the format word that flips the provider chain (`dispatch::
//!   skip_agentic_os`): the contract describes "one object" and shows its shape.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, OnceLock};

/// Tony's dispatch targets. `trading` is deliberately NOT here: the Trading Agent is isolated and
/// only the Financer may talk to it (arbiter::ISOLATED, trading/comms.py), so `validate` refuses
/// any packet aimed at it.
pub const AGENTS: [&str; 8] = ["librarian", "prompter", "coder", "designer", "director", "financer", "observer", "security"];
pub const PRIORITIES: [&str; 3] = ["low", "normal", "urgent"];
pub const TASKS_MAX: usize = 12;
const FIELD_MAX: usize = 600;
const LIST_MAX: usize = 12;

/// The contract with EVERY target live (no overlay, nothing frozen). [`contract`] is the per-turn
/// text, naming only the targets the switchboard leaves live this turn; this is exactly what it
/// returns when all of them are (`contract_with_everyone_live_is_the_full_text`).
pub const CONTRACT: &str = "\n\nOUTPUT CONTRACT (overrides the STYLE format rules): reply with ONE object and nothing else, no code fences, in this exact shape:
{\"spoken_reply\": \"...\", \"requires_dispatch\": false, \"priority\": \"normal\", \"tasks\": []}
- spoken_reply: 1-3 short plain sentences for speech; no markdown, lists or code.
- Chat, a question, or a missing critical detail: requires_dispatch false, tasks empty; ask one direct question if something is missing.
- Never do heavy coding, file analysis or multi-step builds in spoken_reply: dispatch them. Never say a task is finished; say it is queued or staged.
- priority: low, normal or urgent.
- Each task: {\"task_id\": \"short_snake_case\", \"target_agent\": \"librarian|prompter|coder|designer|director|financer|observer|security\", \"action\": \"imperative verb + exact deliverable\", \"inputs\": [\"exact paths, keys or output:task_id\"], \"constraints\": [\"hard limits\"], \"acceptance_criteria\": [\"at least one objective pass/fail check\"], \"depends_on\": [\"earlier task_id\"]}. Blunt and specific, no chatter.
- Chain with depends_on: librarian stages context, prompter locks the spec, coder or designer builds, observer verifies, security audits and purges.
- librarian finds and stages files, docs and memory; prompter writes specs and acceptance tests; coder writes and runs code; designer does UI/UX; director plans video and photo edits (self-tapes, YouTube, shorts, headshots): shot lists and edit plans; financer tracks budgets and spend; observer checks outputs against acceptance_criteria; security enforces boundaries and purges scratch data.";

/// The contract's fixed opening (the same in every mode).
const CONTRACT_HEAD: &str = "\n\nOUTPUT CONTRACT (overrides the STYLE format rules): reply with ONE object and nothing else, no code fences, in this exact shape:
{\"spoken_reply\": \"...\", \"requires_dispatch\": false, \"priority\": \"normal\", \"tasks\": []}
- spoken_reply: 1-3 short plain sentences for speech; no markdown, lists or code.
- Chat, a question, or a missing critical detail: requires_dispatch false, tasks empty; ask one direct question if something is missing.
- Never do heavy coding, file analysis or multi-step builds in spoken_reply: dispatch them. Never say a task is finished; say it is queued or staged.
- priority: low, normal or urgent.
";

/// What each target does (the contract's last line), in `AGENTS` order.
const DUTIES: [&str; 8] = [
    "librarian finds and stages files, docs and memory",
    "prompter writes specs and acceptance tests",
    "coder writes and runs code",
    "designer does UI/UX",
    "director plans video and photo edits (self-tapes, YouTube, shorts, headshots): shot lists and edit plans",
    "financer tracks budgets and spend",
    "observer checks outputs against acceptance_criteria",
    "security enforces boundaries and purges scratch data",
];

/// The targets that stage, spec or build (everyone but Finance and the two checkers).
const BUILDERS: [&str; 5] = ["librarian", "prompter", "coder", "designer", "director"];

/// Added when none of `BUILDERS` is live (e.g. Operations, Executive): Tony must not dispatch a
/// build to a checker or promise it was queued.
pub const NO_BUILDERS_LINE: &str = "- Nobody who stages, specs or builds is on duty now: keep builds out of tasks and never say one is queued.";

/// The dispatch targets the switchboard leaves live this turn (`modes::agent_live`: the mode's
/// overlay and the master switchboard), in `AGENTS` order. Observer and Security are system
/// scripts, so they are always live (pure).
pub fn live_targets(e: &super::modes::Effective, g: &super::os_core::SwitchboardConfig) -> Vec<&'static str> {
    AGENTS.iter().copied().filter(|a| super::modes::agent_live(e, g, a)).collect()
}

/// Tony's output contract for this turn: its `target_agent` list, its chain line and its duty
/// line name only the live targets, so Tony is never told to start a chain with a frozen agent.
/// It sits in the prompt tail (after the cached prefix, before the MODE block), so a mode switch
/// or a switchboard change never breaks the cache. Deterministic (pure).
pub fn contract(e: &super::modes::Effective, g: &super::os_core::SwitchboardConfig) -> String {
    let live = live_targets(e, g);
    let on = |a: &str| live.contains(&a);
    let builds = match (on("coder"), on("designer")) {
        (true, true) => Some("coder or designer builds"),
        (true, false) => Some("coder builds"),
        (false, true) => Some("designer builds"),
        (false, false) => None,
    };
    let chain: Vec<&str> = [
        on("librarian").then_some("librarian stages context"),
        on("prompter").then_some("prompter locks the spec"),
        builds,
        on("observer").then_some("observer verifies"),
        on("security").then_some("security audits and purges"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let duties: Vec<&str> = AGENTS.iter().zip(DUTIES).filter(|(a, _)| on(**a)).map(|(_, d)| d).collect();
    let mut s = format!(
        "{CONTRACT_HEAD}- Each task: {{\"task_id\": \"short_snake_case\", \"target_agent\": \"{}\", \"action\": \"imperative verb + exact deliverable\", \"inputs\": [\"exact paths, keys or output:task_id\"], \"constraints\": [\"hard limits\"], \"acceptance_criteria\": [\"at least one objective pass/fail check\"], \"depends_on\": [\"earlier task_id\"]}}. Blunt and specific, no chatter.\n",
        live.join("|")
    );
    if !chain.is_empty() {
        s.push_str(&format!("- Chain with depends_on: {}.\n", chain.join(", ")));
    }
    if !BUILDERS.iter().any(|a| on(a)) {
        s.push_str(NO_BUILDERS_LINE);
        s.push('\n');
    }
    s.push_str(&format!("- {}.", duties.join("; ")));
    s
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TaskPacket {
    pub task_id: String,
    pub target_agent: String,
    pub action: String,
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TonyDispatch {
    pub spoken_reply: String,
    pub requires_dispatch: bool,
    #[serde(default = "normal")]
    pub priority: String,
    #[serde(default)]
    pub tasks: Vec<TaskPacket>,
}

fn normal() -> String {
    "normal".into()
}

fn clean_list(v: &[String], what: &str) -> Result<Vec<String>, String> {
    if v.len() > LIST_MAX {
        return Err(format!("{what}: at most {LIST_MAX} items"));
    }
    Ok(v.iter().map(|s| super::envelope::clip(&super::envelope::one_line(s), FIELD_MAX)).filter(|s| !s.is_empty()).collect())
}

/// The `TaskPacket` / `TonyDispatch` rules, plus what the schema can't say: unique ids,
/// dependencies inside the packet, no cycles. Returns the packet normalised (pure).
pub fn validate(d: &TonyDispatch) -> Result<TonyDispatch, String> {
    let spoken = d.spoken_reply.trim();
    if spoken.is_empty() {
        return Err("spoken_reply is empty".into());
    }
    if !PRIORITIES.contains(&d.priority.as_str()) {
        return Err(format!("priority must be one of {}", PRIORITIES.join(", ")));
    }
    if d.tasks.len() > TASKS_MAX {
        return Err(format!("at most {TASKS_MAX} tasks"));
    }
    let mut seen = BTreeSet::new();
    let mut tasks = vec![];
    for t in &d.tasks {
        let id = t.task_id.trim();
        if id.chars().count() < 2 || id.chars().count() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(format!("task_id {id:?}: 2-64 letters, digits, _ or -"));
        }
        if !seen.insert(id.to_string()) {
            return Err(format!("task_id {id:?} is used twice"));
        }
        if !AGENTS.contains(&t.target_agent.as_str()) {
            return Err(format!("{id}: target_agent {:?} is not one of {}", t.target_agent, AGENTS.join(", ")));
        }
        let action = super::envelope::one_line(&t.action);
        if action.chars().count() < 5 {
            return Err(format!("{id}: action needs at least 5 characters"));
        }
        let acceptance = clean_list(&t.acceptance_criteria, "acceptance_criteria")?;
        if acceptance.is_empty() {
            return Err(format!("{id}: at least one acceptance criterion"));
        }
        tasks.push(TaskPacket {
            task_id: id.into(),
            target_agent: t.target_agent.clone(),
            action: super::envelope::clip(&action, FIELD_MAX),
            inputs: clean_list(&t.inputs, "inputs")?,
            constraints: clean_list(&t.constraints, "constraints")?,
            acceptance_criteria: acceptance,
            depends_on: t.depends_on.iter().map(|s| s.trim().to_string()).collect(),
        });
    }
    for t in &tasks {
        for dep in &t.depends_on {
            if dep == &t.task_id || !seen.contains(dep) {
                return Err(format!("{}: depends_on {dep:?} is not another task in this packet", t.task_id));
            }
        }
    }
    order(&tasks)?;
    Ok(TonyDispatch { spoken_reply: spoken.into(), requires_dispatch: d.requires_dispatch && !tasks.is_empty(), priority: d.priority.clone(), tasks })
}

/// Tasks in dependency order (stable); Err on a cycle (pure).
pub fn order(tasks: &[TaskPacket]) -> Result<Vec<TaskPacket>, String> {
    let mut done: BTreeSet<&str> = BTreeSet::new();
    let mut out = vec![];
    while out.len() < tasks.len() {
        let before = out.len();
        for t in tasks {
            if !done.contains(t.task_id.as_str()) && t.depends_on.iter().all(|d| done.contains(d.as_str())) {
                done.insert(&t.task_id);
                out.push(t.clone());
            }
        }
        if out.len() == before {
            return Err("depends_on has a cycle".into());
        }
    }
    Ok(out)
}

/// The packet inside a reply, if the reply is one (code fences / stray text around it tolerated).
pub fn parse(answer: &str) -> Option<Result<TonyDispatch, String>> {
    let t = answer.trim();
    let start = t.find('{')?;
    let end = t.rfind('}')?;
    if end <= start {
        return None;
    }
    // Only a reply that IS the object (prose that merely contains braces stays prose).
    let before = t[..start].trim().trim_start_matches("```").trim_start_matches("json").trim();
    if !before.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(&t[start..=end]).ok()?;
    v.get("spoken_reply")?;
    Some(serde_json::from_value::<TonyDispatch>(v).map_err(|e| format!("packet schema: {e}")).and_then(|d| validate(&d)))
}

/// `spoken_reply` of a reply that looks like a packet but failed validation (so the chat never
/// shows raw braces).
pub fn spoken_of(answer: &str) -> Option<String> {
    let t = answer.trim();
    let (s, e) = (t.find('{')?, t.rfind('}')?);
    let v: Value = serde_json::from_str(t.get(s..=e)?).ok()?;
    v["spoken_reply"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

// ── Pending packets (Ask mode) ──────────────────────────────────────────────

fn pending() -> &'static Mutex<BTreeMap<String, TonyDispatch>> {
    static P: OnceLock<Mutex<BTreeMap<String, TonyDispatch>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

/// What the webview shows under Tony's reply.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DispatchView {
    pub id: String,
    /// `held` (mode) · `pending` (needs your yes) · `queued` (done dispatching) · `invalid`.
    pub state: String,
    pub priority: String,
    pub reason: String,
    pub tasks: Vec<Value>,
}

fn task_rows(d: &TonyDispatch, status: &BTreeMap<String, (String, String)>) -> Vec<Value> {
    d.tasks
        .iter()
        .map(|t| {
            let (st, detail) = status.get(&t.task_id).cloned().unwrap_or_else(|| ("held".into(), String::new()));
            json!({ "taskId": t.task_id, "targetAgent": t.target_agent, "action": t.action, "acceptance": t.acceptance_criteria, "dependsOn": t.depends_on, "status": st, "detail": detail })
        })
        .collect()
}

/// Decide what happens to a validated packet under the current mode. Ask: parked for approval.
/// Auto: executed. Solo / Learning: held.
pub fn route(app: Option<&tauri::AppHandle>, os: &super::os_core::OsState, d: &TonyDispatch) -> Option<DispatchView> {
    if !d.requires_dispatch {
        return None;
    }
    let id = format!("pkt-{}", super::arbiter::now_ms());
    let e = os.modes.effective();
    use super::modes::DispatchPolicy::*;
    match e.dispatch {
        SurfaceOnly => Some(DispatchView {
            id,
            state: "held".into(),
            priority: d.priority.clone(),
            reason: if super::modes::is_learning(&e) { "Learning mode: nothing is dispatched".into() } else { "Solo mode: nothing is dispatched; switch modes to send it".into() },
            tasks: task_rows(d, &BTreeMap::new()),
        }),
        AskBeforeDispatch => {
            pending().lock().unwrap().insert(id.clone(), d.clone());
            // A frozen target shows as held already: a yes won't run it (`execute`).
            let frozen = frozen_targets(d, &e, &os.snapshot().switchboard);
            let st = d.tasks.iter().map(|t| (t.task_id.clone(), frozen.get(&t.target_agent).map_or_else(|| ("pending".to_string(), String::new()), |w| ("held".to_string(), w.clone())))).collect();
            Some(DispatchView { id, state: "pending".into(), priority: d.priority.clone(), reason: "Waiting for your yes".into(), tasks: task_rows(d, &st) })
        }
        AutoDispatch => Some(execute(app, &id, d, true)),
    }
}

/// The packet's targets the switchboard froze this turn (target agent → "<Agent> is frozen in
/// <Mode> mode"). Their tasks are held, never run; tasks that depend on them are blocked (pure).
pub fn frozen_targets(d: &TonyDispatch, e: &super::modes::Effective, g: &super::os_core::SwitchboardConfig) -> BTreeMap<String, String> {
    d.tasks.iter().filter_map(|t| super::modes::agent_frozen_reason(e, g, &t.target_agent).map(|why| (t.target_agent.clone(), why))).collect()
}

/// One task's row when the packet is dispatched (`refused`: the mode gate said no) (pure).
fn dispatch_row(refused: Option<&str>, frozen: &BTreeMap<String, String>, target: &str) -> (String, String) {
    match (refused, target) {
        (Some(e), _) => ("refused".to_string(), super::envelope::clip(e, 160)),
        (None, "financer") => ("held".to_string(), "Finance is a sealed vault: unlock it to act on this".to_string()),
        (None, a) if frozen.contains_key(a) => ("held".to_string(), frozen[a].clone()),
        (None, a) => ("queued".to_string(), if super::packet_queue::is_gpu(a) { "waits for the GPU relay".to_string() } else { "CPU lane".to_string() }),
    }
}

/// Run a packet now (Builder mode, or Nic approved it in Ask mode): the packet queue
/// dispatcher takes it in the background (`packet_queue::spawn`); this returns at once. A task
/// whose target the switchboard froze is held (shown, never run).
pub fn execute(app: Option<&tauri::AppHandle>, id: &str, d: &TonyDispatch, auto: bool) -> DispatchView {
    use tauri::Manager;
    let gate = app.map(|a| super::modes::check_dispatch(a.state::<super::os_core::OsState>().modes.effective().dispatch, super::modes::DispatchKind::BuildPipeline { auto }));
    let refused = match gate {
        Some(Err(e)) => Some(e),
        None => Some("no app handle".to_string()),
        Some(Ok(())) => None,
    };
    let frozen = app
        .map(|a| {
            let os = a.state::<super::os_core::OsState>();
            frozen_targets(d, &os.modes.effective(), &os.snapshot().switchboard)
        })
        .unwrap_or_default();
    let st: BTreeMap<String, (String, String)> = d.tasks.iter().map(|t| (t.task_id.clone(), dispatch_row(refused.as_deref(), &frozen, &t.target_agent))).collect();
    if let (None, Some(app)) = (&refused, app) {
        for t in d.tasks.iter().filter(|t| !frozen.contains_key(&t.target_agent)) {
            super::arbiter::get().handoff("tony", &t.target_agent.replace("financer", "finance"), &t.action);
        }
        super::packet_queue::spawn(app.clone(), id.to_string(), d.clone());
    }
    DispatchView {
        id: id.into(),
        state: if refused.is_some() { "held".into() } else { "queued".into() },
        priority: d.priority.clone(),
        reason: refused.unwrap_or_else(|| format!("{} task(s) queued in dependency order", d.tasks.len())),
        tasks: task_rows(d, &st),
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Nic's yes on a pending packet (Ask mode): dispatched as an approved (non-auto) build.
#[tauri::command]
pub fn tony_dispatch_approve(app: tauri::AppHandle, id: String) -> Result<DispatchView, String> {
    let d = pending().lock().unwrap().remove(&id).ok_or("that dispatch is no longer pending")?;
    Ok(execute(Some(&app), &id, &d, false))
}

/// Nic said no: the packet is dropped.
#[tauri::command]
pub fn tony_dispatch_discard(id: String) -> bool {
    pending().lock().unwrap().remove(&id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(id: &str, agent: &str, deps: &[&str]) -> TaskPacket {
        TaskPacket { task_id: id.into(), target_agent: agent.into(), action: format!("Do the {id} step"), inputs: vec![], constraints: vec![], acceptance_criteria: vec!["it passes".into()], depends_on: deps.iter().map(|s| s.to_string()).collect() }
    }

    fn example() -> String {
        json!({
            "spoken_reply": "Got it. Librarian first, then the Coder patches it while Security audits.",
            "requires_dispatch": true,
            "priority": "normal",
            "tasks": [
                { "task_id": "stage_auth_files", "target_agent": "librarian", "action": "Locate and stage the auth module", "inputs": ["workspace:auth_module"], "constraints": ["read_only"], "acceptance_criteria": ["paths returned"], "depends_on": [] },
                { "task_id": "fix_token_refresh", "target_agent": "coder", "action": "Patch the token refresh failure", "inputs": ["output:stage_auth_files"], "constraints": ["no_new_external_dependencies"], "acceptance_criteria": ["refresh test passes"], "depends_on": ["stage_auth_files"] },
                { "task_id": "verify_and_purge", "target_agent": "security", "action": "Scan the diff for leaked credentials", "inputs": ["output:fix_token_refresh"], "constraints": [], "acceptance_criteria": ["zero credential matches"], "depends_on": ["fix_token_refresh"] }
            ]
        })
        .to_string()
    }

    #[test]
    fn tony_cannot_dispatch_to_the_isolated_trading_agent() {
        for target in ["trading", "trading_agent"] {
            let d = TonyDispatch { spoken_reply: "ok".into(), requires_dispatch: true, priority: "normal".into(), tasks: vec![pkt("t1", target, &[])] };
            let err = validate(&d).unwrap_err();
            assert!(err.contains("target_agent"), "{err}");
        }
    }

    #[test]
    fn the_spec_example_parses_and_validates() {
        let d = parse(&example()).unwrap().unwrap();
        assert!(d.requires_dispatch);
        assert_eq!(d.tasks.len(), 3);
        assert_eq!(order(&d.tasks).unwrap().iter().map(|t| t.task_id.as_str()).collect::<Vec<_>>(), vec!["stage_auth_files", "fix_token_refresh", "verify_and_purge"]);
        // Fenced and with a leading word: still a packet. Prose with braces: not one.
        assert!(parse(&format!("```json\n{}\n```", example())).unwrap().is_ok());
        assert!(parse("Sure, the set {a, b} is fine.").is_none());
        assert!(parse("plain prose").is_none());
    }

    #[test]
    fn schema_rules_match_the_pydantic_model_plus_graph_checks() {
        let base = TonyDispatch { spoken_reply: "ok".into(), requires_dispatch: true, priority: "normal".into(), tasks: vec![pkt("a1", "prompter", &[])] };
        assert!(validate(&base).is_ok());
        let bad = |f: &dyn Fn(&mut TonyDispatch)| {
            let mut d = base.clone();
            f(&mut d);
            validate(&d).is_err()
        };
        assert!(bad(&|d| d.spoken_reply = " ".into()));
        assert!(bad(&|d| d.priority = "asap".into()));
        assert!(bad(&|d| d.tasks[0].task_id = "a".into()));
        assert!(bad(&|d| d.tasks[0].target_agent = "booking".into()));
        assert!(bad(&|d| d.tasks[0].action = "do".into()));
        assert!(bad(&|d| d.tasks[0].acceptance_criteria.clear()));
        assert!(bad(&|d| d.tasks.push(pkt("a1", "coder", &[]))), "duplicate id");
        assert!(bad(&|d| d.tasks[0].depends_on = vec!["ghost".into()]), "unknown dependency");
        assert!(bad(&|d| {
            d.tasks = vec![pkt("x1", "coder", &["y1"]), pkt("y1", "designer", &["x1"])];
        }), "cycle");
        // Default priority, and requires_dispatch without tasks is a conversation.
        let v: TonyDispatch = serde_json::from_str(r#"{"spoken_reply":"hi","requires_dispatch":true}"#).unwrap();
        let v = validate(&v).unwrap();
        assert_eq!((v.priority.as_str(), v.requires_dispatch), ("normal", false));
        assert_eq!(order(&[pkt("b2", "coder", &["a1"]), pkt("a1", "librarian", &[])]).unwrap()[0].task_id, "a1");
    }

    fn eff(id: &str) -> super::super::modes::Effective {
        super::super::modes::effective(&super::super::modes::ModesFile { active_mode_id: id.into(), ..Default::default() }, &Default::default())
    }

    fn global(frozen: &[&str]) -> super::super::os_core::SwitchboardConfig {
        super::super::os_core::SwitchboardConfig { version: 1, frozen_agents: frozen.iter().map(|s| s.to_string()).collect(), frozen_tools: vec![] }
    }

    /// The `target_agent` list of a contract.
    fn targets_of(c: &str) -> Vec<String> {
        let (_, rest) = c.split_once("\"target_agent\": \"").unwrap();
        rest.split('"').next().unwrap().split('|').map(str::to_string).collect()
    }

    fn chain_of(c: &str) -> String {
        c.lines().find_map(|l| l.strip_prefix("- Chain with depends_on: ")).unwrap_or_default().to_string()
    }

    #[test]
    fn contract_with_everyone_live_is_the_full_text() {
        // No overlay and nothing frozen: every target is live, the text is the full contract.
        assert_eq!(contract(&eff("brainstorm"), &global(&[])), CONTRACT);
        assert_eq!(live_targets(&eff("brainstorm"), &global(&[])), AGENTS.to_vec());
        // Booking isn't a packet target, so freezing it changes nothing here.
        assert_eq!(contract(&eff("surface"), &global(&["booking"])), CONTRACT);
    }

    #[test]
    fn the_contract_names_only_live_agents_and_never_starts_a_chain_with_a_frozen_one() {
        let g = super::super::os_core::SwitchboardConfig::default();
        // Builder: the pipeline and the checkers; the Librarian (master switchboard), the Director
        // and Finance (off duty) are never named, so the chain starts with the Prompter.
        let b = contract(&eff("builder"), &g);
        assert_eq!(targets_of(&b), vec!["prompter", "coder", "designer", "observer", "security"]);
        assert_eq!(chain_of(&b), "prompter locks the spec, coder or designer builds, observer verifies, security audits and purges.");
        for frozen in ["librarian", "director", "financer"] {
            assert!(!b.contains(frozen), "{frozen}: {b}");
        }
        assert!(!b.contains(NO_BUILDERS_LINE));
        // No overlay, the default master switchboard: everyone but the Librarian.
        let s = contract(&eff("brainstorm"), &g);
        assert!(!s.contains("librarian"), "{s}");
        assert_eq!(chain_of(&s), "prompter locks the spec, coder or designer builds, observer verifies, security audits and purges.");
        assert!(s.contains("director plans video") && s.contains("financer tracks budgets"));
        // Thawed on the master switchboard: the Librarian leads the chain again.
        assert!(chain_of(&contract(&eff("brainstorm"), &global(&["booking"]))).starts_with("librarian stages context, "));
        // Operations / Executive: nobody stages, specs or builds; only live targets are named.
        let o = contract(&eff("operations"), &g);
        assert_eq!(targets_of(&o), vec!["observer", "security"]);
        assert_eq!(chain_of(&o), "observer verifies, security audits and purges.");
        assert!(o.contains(NO_BUILDERS_LINE));
        let x = contract(&eff("executive"), &g);
        assert_eq!(targets_of(&x), vec!["financer", "observer", "security"]);
        assert!(x.contains(NO_BUILDERS_LINE) && !x.contains("librarian") && !x.contains("coder"));
        // One builder only: the chain says so.
        let coder_only = super::super::modes::Effective { switchboard: Some(super::super::modes::ModeSwitchboard { agents: vec!["coder".into()], tools: vec![] }), ..eff("builder") };
        assert_eq!(chain_of(&contract(&coder_only, &g)), "coder builds, observer verifies, security audits and purges.");
        // Every preset: each named target is live, and so is the agent the chain starts with.
        for m in super::super::modes::presets() {
            let e = eff(&m.id);
            let c = contract(&e, &g);
            for t in targets_of(&c) {
                assert!(super::super::modes::agent_live(&e, &g, &t), "{}: {t}", m.id);
            }
            let first = chain_of(&c).split(' ').next().unwrap().to_string();
            assert!(super::super::modes::agent_live(&e, &g, &first), "{}: the chain starts with {first}", m.id);
            assert_eq!(contract(&e, &g), c, "deterministic");
        }
    }

    #[test]
    fn a_frozen_target_is_held_never_queued() {
        // The Librarian thawed on the master switchboard (Booking alone frozen).
        let g = global(&["booking"]);
        let d = TonyDispatch {
            spoken_reply: "ok".into(),
            requires_dispatch: true,
            priority: "normal".into(),
            tasks: vec![pkt("stage", "librarian", &[]), pkt("spec", "prompter", &["stage"]), pkt("build", "coder", &["spec"]), pkt("audit", "security", &["build"]), pkt("cut", "director", &[])],
        };
        // Builder: the Librarian and the Director are frozen; the pipeline and Security are not.
        let f = frozen_targets(&d, &eff("builder"), &g);
        assert_eq!(f.keys().map(String::as_str).collect::<Vec<_>>(), vec!["director", "librarian"]);
        assert_eq!(f["librarian"], "Librarian is frozen in Builder mode");
        assert_eq!(dispatch_row(None, &f, "librarian"), ("held".to_string(), "Librarian is frozen in Builder mode".to_string()));
        assert_eq!(dispatch_row(None, &f, "coder").0, "queued");
        assert_eq!(dispatch_row(None, &f, "security").0, "queued", "system scripts are never frozen");
        // Operations: the whole pipeline is held; Finance stays its own sealed-vault hold.
        let f = frozen_targets(&d, &eff("operations"), &g);
        for a in ["librarian", "prompter", "coder", "director"] {
            assert_eq!(dispatch_row(None, &f, a).0, "held", "{a}");
        }
        assert!(dispatch_row(None, &f, "financer").1.contains("sealed vault"));
        // No overlay: nothing frozen; a refusal still wins over everything.
        assert!(frozen_targets(&d, &eff("brainstorm"), &g).is_empty());
        assert_eq!(dispatch_row(Some("MODE_SURFACE_ONLY: x"), &f, "coder").0, "refused");
        // The default master switchboard freezes the Librarian in every mode.
        let f = frozen_targets(&d, &eff("brainstorm"), &super::super::os_core::SwitchboardConfig::default());
        assert_eq!(f.keys().map(String::as_str).collect::<Vec<_>>(), vec!["librarian"]);
        assert_eq!(f["librarian"], "Librarian is frozen on the master switchboard");
    }

    #[test]
    fn the_contract_never_names_the_format_word() {
        let mut texts = vec![CONTRACT.to_string()];
        texts.extend(super::super::modes::presets().iter().map(|m| contract(&eff(&m.id), &super::super::os_core::SwitchboardConfig::default())));
        for c in &texts {
            let l = c.to_lowercase();
            assert!(!l.contains("json") && !l.contains("/no_think") && !l.contains("gabagool"), "{c}");
        }
        for a in AGENTS {
            assert!(CONTRACT.contains(a), "{a}");
        }
    }
}
