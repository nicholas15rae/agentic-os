//! The agents of the TaskEnvelope pipeline, and what each agent id may do.
//!
//! `Role` is who is *acting* (the permission subject: only `Coder` may write staging, the
//! `Librarian` may never write anything). `as_owner()` maps it onto the envelope's
//! `current_owner` vocabulary (`tony|prompter|designer|coder|staging`): the Librarian is a
//! read-only research gateway and never owns a task, so it has no owner value.
//!
//! [`RolePolicy`] (Part 4) is looked up by agent id STRING ([`policy_for`]), not by the enum,
//! so a future read-only specialist (Security Patrol, Finance...) needs no code change: any
//! valid id that is not Tony, the Coder or the Librarian gets [`RolePolicy::READ_ONLY`].
//! - Tony (`tony` / `general` / a self alias / a missing id): unrestricted, as before.
//! - Librarian: an EXACT tool allowlist ([`LIBRARIAN_TOOLS`]), no file writes, AnythingLLM
//!   read-only. Never extended by a verb heuristic.
//! - Coder: no MCP mutation; files only through `staging::write_artifact`.
//! - Prompter, Designer and every other id: no mutation at all.
//!
//! Enforced in `mcp::call_tool_with` (`role_refusal`) and `mcp::tool_set`, in
//! `staging::write_artifact` and in `documenter::ingest`.
#![cfg_attr(not(test), allow(dead_code))] // consumed by the sequential worker (Part 5)

use serde::{Deserialize, Serialize};

/// The only tools the Librarian may call (reads; `web.search` / `fetch.url` still honour the
/// kill switch in `call_tool_with`). Extend ONLY by editing this list.
pub const LIBRARIAN_TOOLS: [&str; 11] = [
    "fs.list",
    "fs.read",
    "kg.search",
    "web.search",
    "fetch.url",
    "time.now",
    "weather.current",
    "skills.read",
    "sqlite.read_query",
    "sqlite.list_tables",
    "sqlite.describe_table",
];

/// Where an agent may write files.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FsWrite {
    None,
    /// `staging/<slug>/` only, through `staging::write_artifact`.
    Staging,
}

/// What an agent may do to AnythingLLM.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AllmAccess {
    /// Chat (sanitised, `AllmReader`) and reads only.
    ReadOnly,
    /// May ingest / embed (Tony's documenter via `AllmWriter`).
    Write,
}

/// What one agent id may do.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RolePolicy {
    /// May call tools that change data (`mcp::changes_data`).
    pub may_mutate: bool,
    /// `Some`: ONLY these exact tool names (checked before anything else).
    pub tool_allowlist: Option<&'static [&'static str]>,
    pub fs_write: FsWrite,
    pub allm: AllmAccess,
}

impl RolePolicy {
    pub const TONY: RolePolicy = RolePolicy { may_mutate: true, tool_allowlist: None, fs_write: FsWrite::None, allm: AllmAccess::Write };
    pub const LIBRARIAN: RolePolicy = RolePolicy { may_mutate: false, tool_allowlist: Some(&LIBRARIAN_TOOLS), fs_write: FsWrite::None, allm: AllmAccess::ReadOnly };
    pub const CODER: RolePolicy = RolePolicy { may_mutate: false, tool_allowlist: None, fs_write: FsWrite::Staging, allm: AllmAccess::ReadOnly };
    /// Prompter, Designer, Booking, Ops and any future agent id.
    pub const READ_ONLY: RolePolicy = RolePolicy { may_mutate: false, tool_allowlist: None, fs_write: FsWrite::None, allm: AllmAccess::ReadOnly };

    /// May this agent call `tool` (`mutating` = the tool changes data)?
    pub fn allows_tool(&self, tool: &str, mutating: bool) -> bool {
        if let Some(list) = self.tool_allowlist {
            if !list.contains(&tool) {
                return false;
            }
        }
        self.may_mutate || !mutating
    }
}

/// An agent id: `^[a-z][a-z0-9_-]{0,31}$` (stored as a validated string, never a closed enum).
pub fn valid_agent_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty() && b.len() <= 32 && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// Tony: a missing / blank id (callers default to Tony), `general`, `tony` or another self
/// alias (`routing::SELF_ROLE_IDS`), any case.
pub fn is_tony_id(agent: &str) -> bool {
    let a = agent.trim().to_ascii_lowercase();
    a.is_empty() || super::os_core::canon_agent(&a) == "general"
}

/// The policy for an agent id (trimmed, any case). `None` = not a valid agent id (refuse).
pub fn policy_for(agent: &str) -> Option<RolePolicy> {
    if is_tony_id(agent) {
        return Some(RolePolicy::TONY);
    }
    let a = agent.trim().to_ascii_lowercase();
    if !valid_agent_id(&a) {
        return None;
    }
    Some(match a.as_str() {
        "librarian" => RolePolicy::LIBRARIAN,
        "coder" => RolePolicy::CODER,
        _ => RolePolicy::READ_ONLY,
    })
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Tony,
    Prompter,
    Librarian,
    Designer,
    Coder,
}

impl Role {
    pub const ALL: [Role; 5] = [Role::Tony, Role::Prompter, Role::Librarian, Role::Designer, Role::Coder];

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Tony => "tony",
            Role::Prompter => "prompter",
            Role::Librarian => "librarian",
            Role::Designer => "designer",
            Role::Coder => "coder",
        }
    }

    /// `"tony"` and its routing alias `"general"` both name Tony.
    pub fn parse(s: &str) -> Option<Role> {
        match s.trim().to_ascii_lowercase().as_str() {
            "tony" | "general" => Some(Role::Tony),
            "prompter" => Some(Role::Prompter),
            "librarian" => Some(Role::Librarian),
            "designer" => Some(Role::Designer),
            "coder" => Some(Role::Coder),
            _ => None,
        }
    }

    /// The `os.json` `anythingllm.workspaces` / routing key for this role.
    pub fn workspace_key(self) -> &'static str {
        match self {
            Role::Tony => "general",
            other => other.as_str(),
        }
    }

    /// The envelope `current_owner` value, `None` for the Librarian (never an owner).
    pub fn as_owner(self) -> Option<&'static str> {
        match self {
            Role::Librarian => None,
            other => Some(other.as_str()),
        }
    }

    /// This role's policy (`policy_for(self.as_str())`).
    pub fn policy(self) -> RolePolicy {
        policy_for(self.as_str()).unwrap_or(RolePolicy::READ_ONLY)
    }

    /// Only the Coder produces files (staging writes): `fs_write == Staging`.
    pub fn may_write_staging(self) -> bool {
        self.policy().fs_write == FsWrite::Staging
    }
}

impl std::fmt::Display for Role {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_round_trips_and_aliases() {
        for r in Role::ALL {
            assert_eq!(Role::parse(r.as_str()), Some(r));
        }
        assert_eq!(Role::parse("General"), Some(Role::Tony));
        assert_eq!(Role::parse("booking"), None);
        assert_eq!(Role::Tony.workspace_key(), "general");
        assert_eq!(Role::Librarian.as_owner(), None);
        assert_eq!(Role::Coder.as_owner(), Some("coder"));
        assert!(Role::ALL.iter().filter(|r| r.may_write_staging()).eq([Role::Coder].iter()));
        assert_eq!(serde_json::to_string(&Role::Designer).unwrap(), "\"designer\"");
    }

    #[test]
    fn policies_per_agent_id() {
        for t in ["", "  ", "tony", "Tony", "general", "dispatcher", "jarvis"] {
            assert!(is_tony_id(t), "{t:?}");
            assert_eq!(policy_for(t), Some(RolePolicy::TONY), "{t:?}");
        }
        assert_eq!(policy_for("librarian"), Some(RolePolicy::LIBRARIAN));
        assert_eq!(policy_for(" Librarian "), Some(RolePolicy::LIBRARIAN));
        assert_eq!(policy_for("coder"), Some(RolePolicy::CODER));
        for r in ["prompter", "designer", "booking", "ops", "security-patrol", "finance_2"] {
            assert_eq!(policy_for(r), Some(RolePolicy::READ_ONLY), "{r}");
        }
        let long = "x".repeat(33);
        for bad in ["9lives", "-x", "a b", "a/b", "../x", long.as_str(), "librarian\u{0}"] {
            assert_eq!(policy_for(bad), None, "{bad:?}");
        }
        assert!(valid_agent_id(&"a".repeat(32)) && !valid_agent_id(&"a".repeat(33)));
        // Only the Coder writes files, only Tony writes AnythingLLM, only Tony mutates.
        for r in Role::ALL {
            let p = r.policy();
            assert_eq!(p.fs_write == FsWrite::Staging, r == Role::Coder, "{r}");
            assert_eq!(p.allm == AllmAccess::Write, r == Role::Tony, "{r}");
            assert_eq!(p.may_mutate, r == Role::Tony, "{r}");
        }
    }

    #[test]
    fn librarian_is_an_exact_read_allowlist() {
        let lib = RolePolicy::LIBRARIAN;
        for t in LIBRARIAN_TOOLS {
            assert!(lib.allows_tool(t, false), "{t}");
            assert!(!lib.allows_tool(t, true), "a mutating tool is refused even when listed: {t}");
        }
        for t in ["fs.write", "git.status", "github.get_file_contents", "sqlite.write_query", "serena.find_symbol", "spotify.now_playing", "unknown.foo"] {
            assert!(!lib.allows_tool(t, false), "{t}");
        }
        assert_eq!(lib.fs_write, FsWrite::None);
        assert_eq!(lib.allm, AllmAccess::ReadOnly);
        // Read-only roles take any non-mutating tool, Tony anything.
        assert!(RolePolicy::READ_ONLY.allows_tool("github.get_file_contents", false));
        assert!(!RolePolicy::READ_ONLY.allows_tool("github.merge_pull_request", true));
        assert!(!RolePolicy::CODER.allows_tool("serena.replace_symbol_body", true));
        assert!(RolePolicy::TONY.allows_tool("github.merge_pull_request", true));
    }
}
