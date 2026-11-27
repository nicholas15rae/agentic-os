//! Business Registry: the N isolated business entities the Operations Manager (`bizops`) serves.
//!
//! - **Storage**: `<config dir>/businesses.json`, one `Mutex`, `deny_unknown_fields`, atomic
//!   tmp + rename; a failed save rolls the in-memory state back.
//! - **Derived, never supplied**: `workspaceSlug`, `ragNamespace`, `memoryPath`, `librarianScope`
//!   and `financeLedgerTag` are computed from the immutable `businessId` here, so neither the
//!   webview nor a model can point one business at another's workspace, folder or ledger.
//! - **Provisioning** (idempotent, resumable): memory folder → AnythingLLM workspace
//!   (`bizops_<id>`, the Ops prompt, the current LM Studio model) → verified read-back → `active`.
//!   Only an `active` business yields a [`BusinessScope`], so nothing half-bound is routable.
//! - **Removal** is `archived` (approval required). Nothing is hard-deleted here: the business's
//!   memory and workspace stay put, unroutable, until the user purges them through the review queue.
//!
//! Isolation itself (path jail, scoped reads / writes, cross-domain checks) lives in
//! `ops_scope.rs`; the per-turn business lock in `agents.rs` (`resolve_business`).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::ops_scope::BusinessScope;

pub const REGISTRY_FILE: &str = "businesses.json";
pub const WORKSPACE_PREFIX: &str = "bizops_";
pub const MAX_BUSINESSES: usize = 32;
const BLOCKLIST_MAX: usize = 200;
const EMAILS_MAX: usize = 10;
/// The file's schema version. 2 = the `acting` seed was added to an existing registry once
/// ([`migrate`]); 3 = the Acting business lost its bare "acting" alias (everyday lines like "my
/// laptop is acting up" named it) for specific phrases. An older app that rewrites the file
/// writes 1 again; the migration is idempotent.
pub const REGISTRY_VERSION: u32 = 3;
/// The Ops prompt template (`{display_name}`, `{business_id}`, `{description}`).
pub const OPS_PROMPT_TEMPLATE: &str = include_str!("../../rules/bizops.prompt.md");

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BusinessStatus {
    /// Registered; memory folder and / or workspace not verified yet. Not routable.
    Provisioning,
    Active,
    /// Removed from routing. Data kept until a reviewed purge.
    Archived,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ProvisionState {
    pub memory_dir: bool,
    pub workspace: bool,
    pub last_error: Option<String>,
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Business {
    pub business_id: String,
    pub display_name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub description: String,
    /// Extra phrases that name this business in a request ("bf supplements", "masonry").
    #[serde(default)]
    pub aliases: Vec<String>,
    pub workspace_slug: String,
    pub rag_namespace: String,
    pub memory_path: String,
    pub librarian_scope: String,
    pub finance_ledger_tag: String,
    /// This business's own client / vendor / product identifiers. Security uses every OTHER
    /// business's list to catch bleed into this one (`ops_scope::cross_domain_hits`).
    #[serde(default)]
    pub cross_domain_blocklist: Vec<String>,
    pub status: BusinessStatus,
    #[serde(default)]
    pub provision: ProvisionState,
    pub created_at: u64,
    /// The email accounts this business's mail arrives on (label + address). Empty = the main
    /// account. Stored and exposed only; Gmail plumbing doesn't read it yet. Omitted from the file
    /// while empty, so a registry nobody linked mail to stays readable by an older app.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub emails: Vec<BusinessEmail>,
}

/// One mailbox linked to a business.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BusinessEmail {
    /// "Born Fortuna orders", "main".
    #[serde(default)]
    pub label: String,
    pub address: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub version: u32,
    pub businesses: Vec<Business>,
}

/// What the user / UI may supply when creating a business.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewBusiness {
    pub business_id: String,
    pub display_name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub cross_domain_blocklist: Vec<String>,
}

/// The editable fields (never the id or anything derived from it).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BusinessPatch {
    pub display_name: Option<String>,
    pub category: Option<String>,
    pub description: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub cross_domain_blocklist: Option<Vec<String>>,
    pub emails: Option<Vec<BusinessEmail>>,
}

// ── Validation (pure) ───────────────────────────────────────────────────────

/// `^[a-z][a-z0-9_]{1,31}$`, not a Windows device name, not an existing agent role id.
pub fn validate_business_id(id: &str) -> Result<(), String> {
    let b = id.as_bytes();
    let shape = (2..=32).contains(&b.len()) && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_');
    if !shape || id.ends_with('_') || id.contains("__") {
        return Err(format!("businessId {id:?}: 2–32 of a-z 0-9 and single inner underscores, starting with a letter"));
    }
    if super::staging::check_rel(id).is_err() {
        return Err(format!("businessId {id:?} is a reserved name"));
    }
    const ROLE_IDS: [&str; 14] = ["general", "tony", "librarian", "coder", "booking", "ops", "bizops", "prompter", "designer", "director", "finance", "finance_librarian", "security", "observer"];
    if ROLE_IDS.contains(&id) {
        return Err(format!("businessId {id:?} is an agent id"));
    }
    // The finance vault's untagged ledger / the Personal finance area, never a business.
    if id == super::finance_vault::UNTAGGED {
        return Err(format!("businessId {id:?} is reserved for personal finances"));
    }
    Ok(())
}

fn clean_line(s: &str, max: usize, what: &str, required: bool) -> Result<String, String> {
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

fn clean_terms(v: &[String], what: &str) -> Result<Vec<String>, String> {
    if v.len() > BLOCKLIST_MAX {
        return Err(format!("{what}: at most {BLOCKLIST_MAX} entries"));
    }
    let mut out: Vec<String> = vec![];
    for t in v {
        let c = clean_line(t, 80, what, false)?;
        // One- and two-letter terms would match everywhere.
        if super::routing::normalize(&c).chars().count() >= 3 && !out.iter().any(|o| o.eq_ignore_ascii_case(&c)) {
            out.push(c);
        }
    }
    Ok(out)
}

/// Trimmed, lower-cased, de-duplicated; each address `local@domain.tld`, one line, no spaces.
pub fn clean_emails(v: &[BusinessEmail]) -> Result<Vec<BusinessEmail>, String> {
    if v.len() > EMAILS_MAX {
        return Err(format!("emails: at most {EMAILS_MAX}"));
    }
    let mut out: Vec<BusinessEmail> = vec![];
    for e in v {
        let address = clean_line(&e.address, 254, "email address", true)?.to_ascii_lowercase();
        let ok = match address.split_once('@') {
            Some((local, domain)) => !local.is_empty() && !domain.contains('@') && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && !address.contains(char::is_whitespace),
            None => false,
        };
        if !ok {
            return Err(format!("email address {address:?} doesn't look like an address"));
        }
        let label = clean_line(&e.label, 40, "email label", false)?;
        if !out.iter().any(|o| o.address == address) {
            out.push(BusinessEmail { label, address });
        }
    }
    Ok(out)
}

/// The business a mailbox belongs to (case-insensitive). `None` = not linked to one business
/// (the main account, shared by every business without its own). Pure.
pub fn business_for_email<'a>(reg: &'a Registry, address: &str) -> Option<&'a Business> {
    let a = address.trim().to_ascii_lowercase();
    if a.is_empty() {
        return None;
    }
    reg.businesses.iter().find(|b| b.emails.iter().any(|e| e.address == a))
}

/// The mailboxes a business reads: its own, or the main account (label "main", empty address)
/// when it has none. `None` for an unknown business. Pure.
pub fn emails_for(reg: &Registry, business_id: &str) -> Option<Vec<BusinessEmail>> {
    let b = reg.businesses.iter().find(|b| b.business_id == business_id)?;
    Some(if b.emails.is_empty() { vec![BusinessEmail { label: "main".into(), address: String::new() }] } else { b.emails.clone() })
}

pub fn workspace_slug_for(id: &str) -> String {
    format!("{WORKSPACE_PREFIX}{id}")
}

/// Build a full record from user input; every derived field comes from the id.
pub fn build(n: &NewBusiness, memory_root: &Path, now: u64) -> Result<Business, String> {
    let id = n.business_id.trim().to_string();
    validate_business_id(&id)?;
    let slug = workspace_slug_for(&id);
    Ok(Business {
        display_name: clean_line(&n.display_name, 80, "displayName", true)?,
        category: clean_line(&n.category, 60, "category", false)?,
        description: clean_line(&n.description, 400, "description", false)?,
        aliases: clean_terms(&n.aliases, "aliases")?,
        cross_domain_blocklist: clean_terms(&n.cross_domain_blocklist, "crossDomainBlocklist")?,
        workspace_slug: slug.clone(),
        rag_namespace: slug.clone(),
        memory_path: memory_root.join(&id).to_string_lossy().into_owned(),
        librarian_scope: slug,
        finance_ledger_tag: id.clone(),
        business_id: id,
        status: BusinessStatus::Provisioning,
        provision: ProvisionState::default(),
        created_at: now,
        emails: vec![],
    })
}

/// Every record must still be exactly what `build` would derive (a hand-edited file can't
/// re-point a business at another's slug, folder or ledger), with unique ids and names.
pub fn validate_registry(r: &Registry, memory_root: &Path) -> Result<(), String> {
    if r.businesses.len() > MAX_BUSINESSES {
        return Err(format!("at most {MAX_BUSINESSES} businesses"));
    }
    for (i, b) in r.businesses.iter().enumerate() {
        validate_business_id(&b.business_id)?;
        let slug = workspace_slug_for(&b.business_id);
        let want_path = memory_root.join(&b.business_id);
        if b.workspace_slug != slug || b.rag_namespace != slug || b.librarian_scope != slug || b.finance_ledger_tag != b.business_id || Path::new(&b.memory_path) != want_path {
            return Err(format!("business {}: a derived field was changed by hand", b.business_id));
        }
        for o in &r.businesses[..i] {
            if o.business_id == b.business_id {
                return Err(format!("duplicate businessId {}", b.business_id));
            }
            if o.display_name.eq_ignore_ascii_case(&b.display_name) {
                return Err(format!("duplicate displayName {:?}", b.display_name));
            }
            if let Some(e) = b.emails.iter().find(|e| o.emails.iter().any(|x| x.address == e.address)) {
                return Err(format!("{} is already linked to {}", e.address, o.display_name));
            }
        }
    }
    Ok(())
}

/// The Acting business (auditions, self-tapes, bookings through the agency). Seeded for a new
/// registry and added once to an existing one ([`migrate`]).
pub fn acting_seed(memory_root: &Path, now: u64) -> Business {
    build(
        &NewBusiness {
            business_id: "acting".into(),
            display_name: "Acting".into(),
            category: "entertainment".into(),
            description: "Acting work: auditions, self-tapes, callbacks and bookings through the agency, and the agency commission on each job.".into(),
            // Not a bare "agent" / "booking": those words name agents and the Booking desk, and an
            // unrouted line naming a business is routed to the Operations Manager (agents.rs). Not
            // a bare "acting" either ("my laptop is acting up"): only these specific phrases.
            aliases: ACTING_ALIASES.iter().map(|a| a.to_string()).collect(),
            cross_domain_blocklist: vec![],
        },
        memory_root,
        now,
    )
    .expect("the acting seed is valid")
}

/// The Acting business's aliases: specific phrases only (no bare "acting").
pub const ACTING_ALIASES: &[&str] = &[
    "acting business", "acting work", "acting income", "acting gig", "acting gigs", "acting job", "acting jobs", "my acting",
    "auditions", "audition", "bookings", "self-tapes", "self tapes", "self-tape", "my agent", "talent agent", "acting agent",
];

/// One-time upgrades of an existing registry (pure; `true` = it changed and must be saved).
/// v2: add the `acting` business (status `provisioning`: its memory folder and workspace are made
/// by the normal "Finish setup" path, never here). An id or display name already taken is left
/// alone (the user's own record wins).
/// v3: the `acting` business loses exactly its bare "acting" alias (any alias the user added
/// stays) and gains the specific `ACTING_ALIASES` phrases it doesn't have.
pub fn migrate(r: &mut Registry, memory_root: &Path, now: u64) -> bool {
    if r.version >= REGISTRY_VERSION {
        return false;
    }
    if r.version < 2 {
        let taken = r.businesses.iter().any(|b| b.business_id == "acting" || b.display_name.eq_ignore_ascii_case("acting"));
        if !taken && r.businesses.len() < MAX_BUSINESSES {
            r.businesses.push(acting_seed(memory_root, now));
        }
    }
    if r.version < 3 {
        if let Some(b) = r.businesses.iter_mut().find(|b| b.business_id == "acting") {
            b.aliases.retain(|a| !a.trim().eq_ignore_ascii_case("acting"));
            for p in ACTING_ALIASES {
                if !b.aliases.iter().any(|a| a.trim().eq_ignore_ascii_case(p)) {
                    b.aliases.push(p.to_string());
                }
            }
        }
    }
    r.version = REGISTRY_VERSION;
    true
}

/// The businesses the registry starts with (all editable / archivable).
pub fn seeds(memory_root: &Path, now: u64) -> Vec<Business> {
    let s = |id: &str, name: &str, cat: &str, desc: &str, aliases: &[&str]| {
        build(
            &NewBusiness {
                business_id: id.into(),
                display_name: name.into(),
                category: cat.into(),
                description: desc.into(),
                aliases: aliases.iter().map(|a| a.to_string()).collect(),
                cross_domain_blocklist: vec![],
            },
            memory_root,
            now,
        )
        .expect("seed businesses are valid")
    };
    vec![
        s(
            "trades_contracting",
            "Trades & Contracting",
            "construction",
            "General contracting, masonry, self-performed trade work and subcontracted jobs.",
            &["trades and contracting", "contracting", "contractor", "masonry", "general contracting", "trades business"],
        ),
        s(
            "supplements_ecom",
            "Supplements & E-Commerce",
            "ecommerce",
            "Online supplement store: website operations, inventory and fulfillment, and compliance.",
            &["supplements and e-commerce", "supplements and ecommerce", "bf supplements", "supplements", "supplement store", "ecom", "e-commerce", "online store"],
        ),
        acting_seed(memory_root, now),
    ]
}

// ── Business resolution (the per-turn lock) ─────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum Resolution {
    One(Business),
    /// Nothing named a business (and none was selected).
    None,
    /// More than one business is named: ask, never guess.
    Ambiguous(Vec<Business>),
    /// An explicit id that isn't an active business.
    Unknown(String),
}

/// Single everyday words (verbs, generic nouns) a business's display name or id may be, but which
/// never name it ON THEIR OWN in a line ("my laptop is acting up", "back to work"): such a
/// business is named by its aliases (or a longer display name) instead. Aliases are never
/// filtered: an alias is a deliberate trigger.
const COMMON_NAME_WORDS: &[&str] = &[
    "acting", "action", "art", "building", "business", "cleaning", "coaching", "consulting", "design", "film", "general", "home", "job", "jobs", "main", "marketing",
    "media", "money", "music", "office", "operations", "personal", "play", "projects", "running", "sales", "service", "services", "shop", "store", "studio", "team", "trading",
    "work", "working", "writing",
];

/// A display name / id phrase that is one common word (`COMMON_NAME_WORDS`) never names a
/// business by itself.
fn generic_name(phrase: &str) -> bool {
    !phrase.contains(' ') && COMMON_NAME_WORDS.contains(&phrase)
}

/// Phrases that name `b` (normalised): its display name, its id as words (unless that is a single
/// common word, `generic_name`), and its aliases.
fn names_of(b: &Business) -> Vec<String> {
    let mut v: Vec<String> = [super::routing::normalize(&b.display_name), super::routing::normalize(&b.business_id.replace('_', " "))].into_iter().filter(|p| !generic_name(p)).collect();
    v.extend(b.aliases.iter().map(|a| super::routing::normalize(a)));
    v.retain(|s| !s.is_empty());
    v
}

fn mentions(text_norm: &str, phrase: &str) -> bool {
    format!(" {text_norm} ").contains(&format!(" {phrase} "))
}

/// Which business a turn is about. `explicit` (the Business Switcher's selection, or a caller's
/// `activeBusinessId`) wins when it names an active business — unless the text names a
/// DIFFERENT business, which is ambiguous (ask). Otherwise exactly one active business must be
/// named in the text. Pure.
pub fn resolve_business(reg: &Registry, explicit: Option<&str>, text: &str) -> Resolution {
    let active: Vec<&Business> = reg.businesses.iter().filter(|b| b.status == BusinessStatus::Active).collect();
    let norm = super::routing::normalize(text);
    let named: Vec<&Business> = active.iter().copied().filter(|b| names_of(b).iter().any(|p| mentions(&norm, p))).collect();
    if let Some(id) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let Some(sel) = active.iter().find(|b| b.business_id == id) else { return Resolution::Unknown(id.to_string()) };
        if named.iter().any(|b| b.business_id != sel.business_id) {
            let mut both: Vec<Business> = vec![(*sel).clone()];
            both.extend(named.iter().filter(|b| b.business_id != sel.business_id).map(|b| (*b).clone()));
            return Resolution::Ambiguous(both);
        }
        return Resolution::One((*sel).clone());
    }
    match named.len() {
        0 => Resolution::None,
        1 => Resolution::One(named[0].clone()),
        _ => Resolution::Ambiguous(named.into_iter().cloned().collect()),
    }
}

/// Tony's clarification line when a business turn can't be locked to one business.
pub fn clarification(reg: &Registry, res: &Resolution) -> String {
    let list = |bs: Vec<&Business>| bs.iter().map(|b| b.display_name.clone()).collect::<Vec<_>>();
    let join = |v: Vec<String>| match v.len() {
        0 => String::new(),
        1 => v[0].clone(),
        _ => format!("{} or {}", v[..v.len() - 1].join(", "), v[v.len() - 1]),
    };
    let active: Vec<&Business> = reg.businesses.iter().filter(|b| b.status == BusinessStatus::Active).collect();
    match res {
        Resolution::Ambiguous(bs) => format!("That mentions more than one business. Which one is this for: {}?", join(bs.iter().map(|b| b.display_name.clone()).collect())),
        Resolution::Unknown(id) => format!("I don't have an active business called {id}. Which business is this for: {}?", join(list(active))),
        _ if active.is_empty() => "No business is set up and active yet. Add one under Operations → Add Business first.".into(),
        _ => format!("Which business is this for: {}?", join(list(active))),
    }
}

// ── Store ───────────────────────────────────────────────────────────────────

/// One registry file and its memory root. The app has one ([`store`]); tests build their own.
pub struct Store {
    path: PathBuf,
    memory_root: PathBuf,
    reg: Mutex<Registry>,
}

impl Store {
    /// `<config>/businesses.json`, memory under `<config>/memory/ops/<id>/`. A missing file is
    /// seeded; an invalid one is NOT overwritten (kept for the user, registry empty, error logged).
    pub fn open(config_dir: &Path) -> Store {
        let path = config_dir.join(REGISTRY_FILE);
        let memory_root = config_dir.join("memory").join("ops");
        let now = super::arbiter::now_ms();
        let (reg, seed) = match std::fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str::<Registry>(&s).map_err(|e| e.to_string()).and_then(|r| validate_registry(&r, &memory_root).map(|_| r)) {
                Ok(mut r) => {
                    let changed = migrate(&mut r, &memory_root, now) && validate_registry(&r, &memory_root).is_ok();
                    (r, changed)
                }
                Err(e) => {
                    eprintln!("[bizops] {REGISTRY_FILE} invalid ({e}); left untouched, no business is routable until it's fixed");
                    (Registry { version: 1, businesses: vec![] }, false)
                }
            },
            Err(_) => (Registry { version: REGISTRY_VERSION, businesses: seeds(&memory_root, now) }, true),
        };
        let store = Store { path, memory_root, reg: Mutex::new(reg) };
        if seed {
            let r = store.reg.lock().unwrap().clone();
            if let Err(e) = store.save(&r) {
                eprintln!("[bizops] seeding / migrating {REGISTRY_FILE}: {e}");
            }
        }
        store
    }

    pub fn snapshot(&self) -> Registry {
        self.reg.lock().unwrap().clone()
    }

    fn save(&self, r: &Registry) -> Result<(), String> {
        if let Some(d) = self.path.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let bytes = serde_json::to_vec_pretty(r).map_err(|e| e.to_string())?;
        super::staging::atomic_write(&self.path, &bytes)
    }

    /// Validate and persist a change; the in-memory state only moves if the save succeeds.
    pub fn update<T>(&self, f: impl FnOnce(&mut Registry) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.reg.lock().unwrap();
        let mut next = guard.clone();
        let out = f(&mut next)?;
        next.version = REGISTRY_VERSION;
        validate_registry(&next, &self.memory_root)?;
        self.save(&next)?;
        *guard = next;
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Option<Business> {
        self.reg.lock().unwrap().businesses.iter().find(|b| b.business_id == id).cloned()
    }

    /// The scope for an ACTIVE business (the only way ops code gets one).
    pub fn scope(&self, id: &str) -> Result<BusinessScope, String> {
        let b = self.get(id).ok_or_else(|| format!("unknown business {id:?}"))?;
        BusinessScope::from_business(&b, &self.memory_root)
    }

    pub fn create(&self, n: &NewBusiness) -> Result<Business, String> {
        let b = build(n, &self.memory_root, super::arbiter::now_ms())?;
        self.update(|r| {
            if r.businesses.iter().any(|o| o.business_id == b.business_id) {
                return Err(format!("business {} already exists", b.business_id));
            }
            r.businesses.push(b.clone());
            Ok(())
        })?;
        Ok(b)
    }

    pub fn patch(&self, id: &str, p: &BusinessPatch) -> Result<Business, String> {
        self.update(|r| {
            let b = r.businesses.iter_mut().find(|b| b.business_id == id).ok_or_else(|| format!("unknown business {id:?}"))?;
            if let Some(v) = &p.display_name {
                b.display_name = clean_line(v, 80, "displayName", true)?;
            }
            if let Some(v) = &p.category {
                b.category = clean_line(v, 60, "category", false)?;
            }
            if let Some(v) = &p.description {
                b.description = clean_line(v, 400, "description", false)?;
            }
            if let Some(v) = &p.aliases {
                b.aliases = clean_terms(v, "aliases")?;
            }
            if let Some(v) = &p.cross_domain_blocklist {
                b.cross_domain_blocklist = clean_terms(v, "crossDomainBlocklist")?;
            }
            if let Some(v) = &p.emails {
                b.emails = clean_emails(v)?;
            }
            Ok(b.clone())
        })
    }

    pub fn set_status(&self, id: &str, status: BusinessStatus) -> Result<Business, String> {
        self.update(|r| {
            let b = r.businesses.iter_mut().find(|b| b.business_id == id).ok_or_else(|| format!("unknown business {id:?}"))?;
            if status == BusinessStatus::Active && !(b.provision.memory_dir && b.provision.workspace) {
                return Err(format!("business {id} isn't fully provisioned yet"));
            }
            b.status = status;
            Ok(b.clone())
        })
    }

    fn record_step(&self, id: &str, f: impl FnOnce(&mut ProvisionState)) -> Result<Business, String> {
        self.update(|r| {
            let b = r.businesses.iter_mut().find(|b| b.business_id == id).ok_or_else(|| format!("unknown business {id:?}"))?;
            f(&mut b.provision);
            b.provision.updated_at = super::arbiter::now_ms();
            if b.status == BusinessStatus::Provisioning && b.provision.memory_dir && b.provision.workspace {
                b.status = BusinessStatus::Active;
                b.provision.last_error = None;
            }
            Ok(b.clone())
        })
    }

    /// Step 1: the business's own memory folder (refusing links / junctions anywhere on the way).
    pub fn provision_memory(&self, id: &str) -> Result<Business, String> {
        let b = self.get(id).ok_or_else(|| format!("unknown business {id:?}"))?;
        std::fs::create_dir_all(&self.memory_root).map_err(|e| format!("create {}: {e}", self.memory_root.display()))?;
        let dir = super::staging::safe_join(&self.memory_root, &b.business_id)?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        super::staging::safe_join(&self.memory_root, &b.business_id)?; // re-check after creating
        self.record_step(id, |p| p.memory_dir = true)
    }

    /// Step 2: the business's own AnythingLLM workspace. Idempotent: an existing workspace with
    /// the exact slug is adopted; a different slug coming back (a name clash on the server) is
    /// refused rather than silently bound.
    pub async fn provision_workspace_for(&self, id: &str, w: &super::allm::AllmWriter, chat_model: Option<&str>) -> Result<Business, String> {
        let b = self.get(id).ok_or_else(|| format!("unknown business {id:?}"))?;
        let res: Result<(), String> = async {
            if w.find_workspace(&b.workspace_slug, 15).await?.is_none() {
                let got = w.create_workspace(&b.workspace_slug, &ops_prompt(&b), chat_model, 30).await?;
                if got != b.workspace_slug {
                    return Err(format!("AnythingLLM named the workspace {got:?}, not {:?}: rename or remove the clashing workspace, then retry", b.workspace_slug));
                }
            }
            match w.find_workspace(&b.workspace_slug, 15).await? {
                Some(_) => Ok(()),
                None => Err(format!("workspace {} didn't read back after creating it", b.workspace_slug)),
            }
        }
        .await;
        match res {
            Ok(()) => self.record_step(id, |p| p.workspace = true),
            Err(e) => {
                let _ = self.record_step(id, |p| p.last_error = Some(e.clone()));
                Err(e)
            }
        }
    }
}

/// The Finance agent's prompt (checksummed with the other rules, `integrity.rs`).
pub const FINANCE_PROMPT: &str = include_str!("../../rules/finance.prompt.md");

/// The number of documents embedded in a workspace object.
fn doc_count(ws: &Value) -> usize {
    ws["documents"].as_array().map(Vec::len).unwrap_or(0)
}

/// Create (or adopt) the one `finance` chat workspace. It must come back with exactly that slug
/// and hold NO documents: Finance answers only from tag-filtered ledger rows given per turn, so
/// a ledger is never embedded anywhere. Returns `"created"` or `"exists"`.
pub async fn provision_finance_workspace(w: &super::allm::AllmWriter, chat_model: Option<&str>) -> Result<&'static str, String> {
    let slug = super::finance_vault::FINANCE_WORKSPACE;
    let outcome = match w.find_workspace(slug, 15).await? {
        Some(_) => "exists",
        None => {
            let got = w.create_workspace("Finance", FINANCE_PROMPT.trim(), chat_model, 30).await?;
            if got != slug {
                return Err(format!("AnythingLLM named the workspace {got:?}, not {slug:?}: rename or remove the clashing workspace, then retry"));
            }
            "created"
        }
    };
    let ws = w.find_workspace(slug, 15).await?.ok_or_else(|| format!("workspace {slug} didn't read back"))?;
    let n = doc_count(&ws);
    if n > 0 {
        return Err(format!("SECURITY_FAIL_CLOSED: the {slug} workspace holds {n} embedded document(s); Finance must have none"));
    }
    Ok(outcome)
}

/// The Ops system prompt for one business.
pub fn ops_prompt(b: &Business) -> String {
    OPS_PROMPT_TEMPLATE.replace("{display_name}", &b.display_name).replace("{business_id}", &b.business_id).replace("{description}", &b.description).trim().to_string()
}

static STORE: OnceLock<Store> = OnceLock::new();

/// lib.rs setup.
pub fn init(config_dir: &Path) {
    let _ = STORE.set(Store::open(config_dir));
}

pub fn store() -> Result<&'static Store, String> {
    STORE.get().ok_or_else(|| "the business registry isn't initialised".into())
}

/// The UI's view of a business (everything is non-secret config).
fn view(b: &Business) -> Value {
    serde_json::to_value(b).unwrap_or(Value::Null)
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn business_list() -> Result<Value, String> {
    let s = store()?;
    Ok(json!({ "businesses": s.snapshot().businesses.iter().map(view).collect::<Vec<_>>() }))
}

/// Register a business, then provision it (memory folder, then the workspace). A provisioning
/// failure keeps the record (status `provisioning`, the error on it) for `business_provision`.
#[tauri::command]
pub async fn business_create(business: Value, state: tauri::State<'_, super::dispatch::DispatchState>, os: tauri::State<'_, super::os_core::OsState>) -> Result<Value, String> {
    let n: NewBusiness = serde_json::from_value(business).map_err(|e| format!("business schema: {e}"))?;
    let s = store()?;
    let b = s.create(&n)?;
    provision(s, &b.business_id, &state, &os).await
}

/// (Re)run the remaining provisioning steps for one business.
#[tauri::command]
pub async fn business_provision(business_id: String, state: tauri::State<'_, super::dispatch::DispatchState>, os: tauri::State<'_, super::os_core::OsState>) -> Result<Value, String> {
    provision(store()?, &business_id, &state, &os).await
}

async fn provision(s: &Store, id: &str, state: &super::dispatch::DispatchState, os: &super::os_core::OsState) -> Result<Value, String> {
    let mut b = s.get(id).ok_or_else(|| format!("unknown business {id:?}"))?;
    if b.status == BusinessStatus::Archived {
        return Err(format!("business {id} is archived; restore it first"));
    }
    if !b.provision.memory_dir {
        b = s.provision_memory(id)?;
    }
    if !b.provision.workspace {
        let cfg = os.snapshot();
        let conn = match super::allm::AllmConn::local(state, &cfg) {
            Ok(c) => c,
            Err(e) => {
                let b = s.record_step(id, |p| p.last_error = Some(e.clone()))?;
                return Ok(json!({ "business": view(&b), "error": e }));
            }
        };
        let model = state.snapshot().providers.iter().find(|p| p.id == "lmstudio").map(|p| p.model.clone()).filter(|m| !m.is_empty() && m != "local-model");
        let w = super::allm::AllmWriter::for_ops_provision(conn);
        match s.provision_workspace_for(id, &w, model.as_deref()).await {
            Ok(nb) => b = nb,
            Err(e) => return Ok(json!({ "business": view(&s.get(id).unwrap_or(b)), "error": e })),
        }
    }
    super::events::publish_note("bizops", "business_provisioned", "milestone", &format!("business {} provisioned", b.business_id), None);
    Ok(json!({ "business": view(&b), "error": Value::Null }))
}

#[tauri::command]
pub fn business_update(business_id: String, patch: Value) -> Result<Value, String> {
    let p: BusinessPatch = serde_json::from_value(patch).map_err(|e| format!("patch schema: {e}"))?;
    Ok(view(&store()?.patch(&business_id, &p)?))
}

/// Archive (unroutable, data kept) or restore a business. Archiving needs the user's approval.
#[tauri::command]
pub fn business_set_archived(business_id: String, archived: bool, approved: Option<bool>) -> Result<Value, String> {
    let s = store()?;
    if archived {
        if approved != Some(true) {
            return Err("PERMISSION_REQUIRED:business-archive".into());
        }
        return Ok(view(&s.set_status(&business_id, BusinessStatus::Archived)?));
    }
    let b = s.get(&business_id).ok_or_else(|| format!("unknown business {business_id:?}"))?;
    let to = if b.provision.memory_dir && b.provision.workspace { BusinessStatus::Active } else { BusinessStatus::Provisioning };
    Ok(view(&s.set_status(&business_id, to)?))
}

/// Live provisioning against the user's real config dir and AnythingLLM. Writes: it needs
/// `--ignored` AND `ALLM_LIVE_WRITE=1`. Run with the desktop app closed (it holds the registry
/// in memory).
/// `ALLM_LIVE_WRITE=1 cargo test --lib live_provision_seed_businesses -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_provision_seed_businesses() {
        if !std::env::var("ALLM_LIVE_WRITE").is_ok_and(|v| v == "1") {
            println!("SKIPPED: set ALLM_LIVE_WRITE=1 to let this test write to AnythingLLM");
            return;
        }
        let dir = PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
        let state = super::super::dispatch::DispatchState::default();
        state.load_or_init(&dir);
        let key = super::super::secrets::get(&state, "anythingllm").expect("AnythingLLM key in the keychain");
        let mut os = super::super::os_core::OsConfig::default();
        if let Ok(s) = std::fs::read_to_string(dir.join("os.json")) {
            if let Ok(c) = serde_json::from_str(&s) {
                os = c;
            }
        }
        let model = state.snapshot().providers.iter().find(|p| p.id == "lmstudio").map(|p| p.model.clone()).filter(|m| !m.is_empty() && m != "local-model");
        println!("ALLM {} · model {:?}", os.anythingllm.base_url, model);
        let w = super::super::allm::AllmWriter::for_ops_provision(super::super::allm::AllmConn::with_key(&state, &os.anythingllm.base_url, key));
        let store = Store::open(&dir);
        tauri::async_runtime::block_on(async {
            for b in store.snapshot().businesses {
                if b.status == BusinessStatus::Archived {
                    continue;
                }
                let id = b.business_id.clone();
                if !b.provision.memory_dir {
                    store.provision_memory(&id).unwrap();
                }
                match store.provision_workspace_for(&id, &w, model.as_deref()).await {
                    Ok(nb) => println!("OK {id}: {:?} workspace {} memory {}", nb.status, nb.workspace_slug, nb.memory_path),
                    Err(e) => println!("FAILED {id}: {e}"),
                }
            }
        });
    }

    /// The empty `finance` chat workspace only (AnythingLLM; never touches the registry file, so
    /// it's safe while the app runs).
    /// `ALLM_LIVE_WRITE=1 cargo test --lib live_provision_finance_workspace -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_provision_finance_workspace() {
        if !std::env::var("ALLM_LIVE_WRITE").is_ok_and(|v| v == "1") {
            println!("SKIPPED: set ALLM_LIVE_WRITE=1 to let this test write to AnythingLLM");
            return;
        }
        let dir = PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
        let state = super::super::dispatch::DispatchState::default();
        state.load_or_init(&dir);
        let key = super::super::secrets::get(&state, "anythingllm").expect("AnythingLLM key in the keychain");
        let base = std::fs::read_to_string(dir.join("os.json")).ok().and_then(|s| serde_json::from_str::<super::super::os_core::OsConfig>(&s).ok()).map(|c| c.anythingllm.base_url).unwrap_or_else(|| "http://127.0.0.1:3001".into());
        let model = state.snapshot().providers.iter().find(|p| p.id == "lmstudio").map(|p| p.model.clone()).filter(|m| !m.is_empty() && m != "local-model");
        let w = super::super::allm::AllmWriter::for_ops_provision(super::super::allm::AllmConn::with_key(&state, &base, key));
        tauri::async_runtime::block_on(async {
            match provision_finance_workspace(&w, model.as_deref()).await {
                Ok(o) => println!("OK finance: workspace {o}, 0 documents (model {model:?})"),
                Err(e) => println!("FAILED finance: {e}"),
            }
            if let Ok(Some(ws)) = w.find_workspace("finance", 10).await {
                println!("READBACK slug={} chatMode={} model={} documentsField={} promptStartsOk={}", ws["slug"], ws["chatMode"], ws["chatModel"], ws.get("documents").is_some(), ws["openAiPrompt"].as_str().is_some_and(|p| p.starts_with("You are the Finance agent")));
            }
        });
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bizreg-{tag}-{}-{}", std::process::id(), super::super::arbiter::now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A store whose two seeds are provisioned locally and marked active (no AnythingLLM).
    pub(crate) fn active_store(tag: &str) -> (Store, PathBuf) {
        super::super::integrity::init_for_test();
        let dir = temp_dir(tag);
        let s = Store::open(&dir);
        for id in ["trades_contracting", "supplements_ecom"] {
            s.provision_memory(id).unwrap();
            s.record_step(id, |p| p.workspace = true).unwrap();
        }
        (s, dir)
    }

    #[test]
    fn seeds_are_derived_and_valid() {
        let dir = temp_dir("seed");
        let s = Store::open(&dir);
        let r = s.snapshot();
        assert_eq!(r.businesses.iter().map(|b| b.business_id.as_str()).collect::<Vec<_>>(), ["trades_contracting", "supplements_ecom", "acting"]);
        assert_eq!(r.version, REGISTRY_VERSION);
        let a = &r.businesses[2];
        assert_eq!((a.display_name.as_str(), a.workspace_slug.as_str(), a.finance_ledger_tag.as_str()), ("Acting", "bizops_acting", "acting"));
        assert_eq!(PathBuf::from(&a.memory_path), dir.join("memory").join("ops").join("acting"));
        assert!(!a.aliases.iter().any(|x| x == "agent" || x == "booking"), "no alias that names an agent or the Booking desk");
        let t = &r.businesses[0];
        assert_eq!((t.workspace_slug.as_str(), t.rag_namespace.as_str(), t.librarian_scope.as_str(), t.finance_ledger_tag.as_str()), ("bizops_trades_contracting", "bizops_trades_contracting", "bizops_trades_contracting", "trades_contracting"));
        assert_eq!(PathBuf::from(&t.memory_path), dir.join("memory").join("ops").join("trades_contracting"));
        assert!(r.businesses.iter().all(|b| b.status == BusinessStatus::Provisioning), "seeds aren't routable before provisioning");
        assert!(dir.join(REGISTRY_FILE).exists());
        // Reopen: same registry, not re-seeded.
        assert_eq!(Store::open(&dir).snapshot(), r);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An existing two-business registry (version 1, as written before Acting) gets `acting`
    /// added once, unprovisioned (no folder, no workspace made), and keeps everything else.
    #[test]
    fn v1_registry_gains_acting_once() {
        let dir = temp_dir("migrate");
        let root = dir.join("memory").join("ops");
        let mut old = Registry { version: 1, businesses: seeds(&root, 1).into_iter().filter(|b| b.business_id != "acting").collect() };
        old.businesses[0].aliases.push("stonework".into());
        std::fs::write(dir.join(REGISTRY_FILE), serde_json::to_vec_pretty(&old).unwrap()).unwrap();
        // The old file has no `emails` key and must still parse (serde default).
        assert!(!std::fs::read_to_string(dir.join(REGISTRY_FILE)).unwrap().contains("emails"));
        let s = Store::open(&dir);
        let r = s.snapshot();
        assert_eq!(r.version, REGISTRY_VERSION);
        assert_eq!(r.businesses.iter().map(|b| b.business_id.as_str()).collect::<Vec<_>>(), ["trades_contracting", "supplements_ecom", "acting"]);
        assert!(r.businesses[0].aliases.iter().any(|a| a == "stonework"), "the user's edits survive");
        let acting = s.get("acting").unwrap();
        assert_eq!(acting.status, BusinessStatus::Provisioning);
        assert!(!root.join("acting").exists(), "the migration provisions nothing");
        // Persisted, and a reopen doesn't add a second one.
        let reopened = Store::open(&dir).snapshot();
        assert_eq!(reopened, r);
        // Pure migrate: idempotent; a user's own "Acting" (other id) is left alone.
        let mut v = old.clone();
        assert!(migrate(&mut v, &root, 2) && !migrate(&mut v, &root, 3));
        assert_eq!(v.businesses.len(), 3);
        let mut mine = old.clone();
        mine.businesses.push(build(&NewBusiness { business_id: "acting_work".into(), display_name: "acting".into(), category: "".into(), description: "".into(), aliases: vec![], cross_domain_blocklist: vec![] }, &root, 1).unwrap());
        migrate(&mut mine, &root, 2);
        assert_eq!(mine.businesses.iter().filter(|b| b.display_name.eq_ignore_ascii_case("acting")).count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn emails_link_mailboxes_to_one_business() {
        let dir = temp_dir("emails");
        let s = Store::open(&dir);
        let mail = |label: &str, address: &str| BusinessEmail { label: label.into(), address: address.into() };
        let p = BusinessPatch { emails: Some(vec![mail("Born Fortuna", "  Orders@BornFortuna.ca "), mail("dup", "orders@bornfortuna.ca")]), ..Default::default() };
        let b = s.patch("supplements_ecom", &p).unwrap();
        assert_eq!(b.emails, [mail("Born Fortuna", "orders@bornfortuna.ca")], "trimmed, lower-cased, de-duplicated");
        let r = s.snapshot();
        assert_eq!(business_for_email(&r, "ORDERS@bornfortuna.ca").map(|b| b.business_id.as_str()), Some("supplements_ecom"));
        assert!(business_for_email(&r, "someone@gmail.com").is_none());
        assert!(business_for_email(&r, " ").is_none());
        assert_eq!(emails_for(&r, "supplements_ecom").unwrap(), [mail("Born Fortuna", "orders@bornfortuna.ca")]);
        assert_eq!(emails_for(&r, "acting").unwrap(), [mail("main", "")], "no link = the main account");
        assert!(emails_for(&r, "nope").is_none());
        // One mailbox, one business; malformed addresses refused.
        assert!(s.patch("acting", &BusinessPatch { emails: Some(vec![mail("", "orders@bornfortuna.ca")]), ..Default::default() }).unwrap_err().contains("already linked"));
        for bad in ["nope", "a@b", "@x.ca", "a b@x.ca", "a@x.ca.", "a@@x.ca"] {
            assert!(s.patch("acting", &BusinessPatch { emails: Some(vec![mail("", bad)]), ..Default::default() }).is_err(), "{bad}");
        }
        assert!(serde_json::from_value::<BusinessPatch>(json!({ "emails": [{ "address": "a@x.ca", "secret": 1 }] })).is_err());
        // Display name / category / description edits (the card's editor).
        let b = s.patch("acting", &BusinessPatch { display_name: Some("Acting & Voice".into()), category: Some("film".into()), description: Some("Screen and voice work.".into()), ..Default::default() }).unwrap();
        assert_eq!((b.display_name.as_str(), b.category.as_str(), b.workspace_slug.as_str()), ("Acting & Voice", "film", "bizops_acting"));
        assert!(validate_business_id("personal").is_err(), "personal is the finance area, never a business");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ids_and_derived_fields_are_locked() {
        for bad in ["", "a", "Trades", "9shop", "shop-1", "shop_", "a__b", "con", "nul", "ops", "bizops", "finance", "general", &"x".repeat(33)] {
            assert!(validate_business_id(bad).is_err(), "{bad:?}");
        }
        assert!(validate_business_id("bakery_2").is_ok());
        let dir = temp_dir("lock");
        let s = Store::open(&dir);
        // A hand edit re-pointing a business at another's slug / folder / ledger is refused.
        for f in [
            |b: &mut Business| b.workspace_slug = "bizops_supplements_ecom".into(),
            |b: &mut Business| b.finance_ledger_tag = "supplements_ecom".into(),
            |b: &mut Business| b.memory_path = r"C:\elsewhere".into(),
            |b: &mut Business| b.librarian_scope = "librarian".into(),
        ] {
            let e = s.update(|r| {
                f(&mut r.businesses[0]);
                Ok(())
            });
            assert!(e.unwrap_err().contains("derived field"));
        }
        // A failed save / validation leaves the live state unchanged.
        assert_eq!(s.get("trades_contracting").unwrap().workspace_slug, "bizops_trades_contracting");
        // Unknown fields in user input are refused; derived fields can't be supplied.
        assert!(serde_json::from_value::<NewBusiness>(json!({ "businessId": "bakery", "displayName": "Bakery", "workspaceSlug": "librarian" })).is_err());
        assert!(serde_json::from_value::<BusinessPatch>(json!({ "businessId": "x" })).is_err());
        // Duplicates.
        assert!(s.create(&NewBusiness { business_id: "trades_contracting".into(), display_name: "X".into(), category: "".into(), description: "".into(), aliases: vec![], cross_domain_blocklist: vec![] }).is_err());
        assert!(s.create(&NewBusiness { business_id: "other".into(), display_name: "trades & contracting".into(), category: "".into(), description: "".into(), aliases: vec![], cross_domain_blocklist: vec![] }).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_business_is_dynamic_and_needs_provisioning() {
        let dir = temp_dir("add");
        let s = Store::open(&dir);
        let b = s.create(&NewBusiness { business_id: "bakery".into(), display_name: "Corner Bakery".into(), category: "food".into(), description: "".into(), aliases: vec!["bakery".into()], cross_domain_blocklist: vec!["Flour Co".into(), "ab".into()] }).unwrap();
        assert_eq!(b.cross_domain_blocklist, ["Flour Co"], "too-short terms are dropped");
        assert!(s.scope("bakery").is_err(), "not routable while provisioning");
        assert!(s.set_status("bakery", BusinessStatus::Active).is_err());
        s.provision_memory("bakery").unwrap();
        assert!(dir.join("memory").join("ops").join("bakery").is_dir());
        let b = s.record_step("bakery", |p| p.workspace = true).unwrap();
        assert_eq!(b.status, BusinessStatus::Active);
        assert!(s.scope("bakery").is_ok());
        assert!(business_set_archived_on(&s, "bakery", None).unwrap_err().starts_with("PERMISSION_REQUIRED"));
        assert_eq!(business_set_archived_on(&s, "bakery", Some(true)).unwrap().status, BusinessStatus::Archived);
        assert!(s.scope("bakery").is_err(), "archived isn't routable");
        assert!(dir.join("memory").join("ops").join("bakery").is_dir(), "archiving deletes nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn business_set_archived_on(s: &Store, id: &str, approved: Option<bool>) -> Result<Business, String> {
        if approved != Some(true) {
            return Err("PERMISSION_REQUIRED:business-archive".into());
        }
        s.set_status(id, BusinessStatus::Archived)
    }

    /// "acting" as an everyday verb never names the Acting business; its specific phrases do.
    #[test]
    fn acting_is_named_only_by_its_specific_phrases() {
        let (s, dir) = active_store("acting-words");
        s.provision_memory("acting").unwrap();
        s.record_step("acting", |p| p.workspace = true).unwrap();
        s.set_status("acting", BusinessStatus::Active).unwrap();
        let r = s.snapshot();
        assert!(!r.businesses.iter().find(|b| b.business_id == "acting").unwrap().aliases.iter().any(|a| a == "acting"));
        for text in ["my laptop is acting up", "the gateway is acting weird", "Spotify keeps acting strange", "why is docker acting like this", "Acting up again, the build"] {
            assert_eq!(resolve_business(&r, None, text), Resolution::None, "{text}");
        }
        for text in [
            "how much acting income did I make this month",
            "any acting gigs this week",
            "log the acting job from tuesday",
            "how's my acting business doing",
            "how is my acting going",
            "did I get any auditions",
            "send the self-tape to my agent",
            "what did my talent agent say",
            "check the bookings",
        ] {
            assert!(matches!(resolve_business(&r, None, text), Resolution::One(ref b) if b.business_id == "acting"), "{text}");
        }
        // A multi-word display name still names its business by itself.
        assert!(matches!(resolve_business(&r, None, "check trades & contracting"), Resolution::One(ref b) if b.business_id == "trades_contracting"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v3: a v2 registry's Acting business loses exactly the bare "acting" alias (the user's own
    /// aliases stay) and gains the specific phrases; once.
    #[test]
    fn v2_registry_drops_the_bare_acting_alias_once() {
        let dir = temp_dir("migrate-v3");
        let root = dir.join("memory").join("ops");
        let mut v2 = Registry { version: 2, businesses: seeds(&root, 1) };
        let a = v2.businesses.iter_mut().find(|b| b.business_id == "acting").unwrap();
        a.aliases = vec!["acting".into(), "auditions".into(), "voice work".into(), "Acting".into()];
        let mut v = v2.clone();
        assert!(migrate(&mut v, &root, 2));
        assert_eq!(v.version, REGISTRY_VERSION);
        let al = &v.businesses.iter().find(|b| b.business_id == "acting").unwrap().aliases;
        assert!(!al.iter().any(|x| x.eq_ignore_ascii_case("acting")), "{al:?}");
        assert!(al.iter().any(|x| x == "voice work") && al.iter().any(|x| x == "auditions") && al.iter().any(|x| x == "acting income"), "{al:?}");
        assert_eq!(al.iter().filter(|x| *x == "auditions").count(), 1);
        // Once: a bare alias the user puts back afterwards stays.
        v.businesses.iter_mut().find(|b| b.business_id == "acting").unwrap().aliases.push("acting".into());
        assert!(!migrate(&mut v, &root, 3));
        assert!(v.businesses.iter().find(|b| b.business_id == "acting").unwrap().aliases.iter().any(|x| x == "acting"));
        // The other businesses are untouched.
        assert_eq!(v.businesses[0], v2.businesses[0]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolution_never_guesses() {
        let (s, dir) = active_store("resolve");
        let r = s.snapshot();
        let id = |res: Resolution| match res {
            Resolution::One(b) => b.business_id,
            other => format!("{other:?}"),
        };
        assert_eq!(id(resolve_business(&r, None, "what invoices are overdue for the contracting business")), "trades_contracting");
        assert_eq!(id(resolve_business(&r, None, "how is BF Supplements inventory looking?")), "supplements_ecom");
        assert_eq!(id(resolve_business(&r, Some("supplements_ecom"), "any open orders?")), "supplements_ecom");
        assert_eq!(resolve_business(&r, None, "any open orders?"), Resolution::None);
        assert!(matches!(resolve_business(&r, None, "compare masonry jobs with supplement store sales"), Resolution::Ambiguous(v) if v.len() == 2));
        // Selected one business but the text names the other: ask.
        assert!(matches!(resolve_business(&r, Some("trades_contracting"), "check the supplements stock"), Resolution::Ambiguous(_)));
        assert_eq!(resolve_business(&r, Some("bakery"), "x"), Resolution::Unknown("bakery".into()));
        // "contracting" is only a whole-word match.
        assert_eq!(resolve_business(&r, None, "subcontractingly"), Resolution::None);
        assert!(clarification(&r, &Resolution::None).contains("Trades & Contracting or Supplements & E-Commerce"));
        // An archived business is never resolved.
        s.set_status("supplements_ecom", BusinessStatus::Archived).unwrap();
        assert_eq!(resolve_business(&s.snapshot(), None, "bf supplements stock"), Resolution::None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn provisioning_creates_and_verifies_the_workspace() {
        tauri::async_runtime::block_on(async {
            use super::super::allm::mock::{start, Resp};
            use std::sync::atomic::{AtomicBool, Ordering};
            use std::sync::Arc;
            let created = Arc::new(AtomicBool::new(false));
            let c2 = created.clone();
            let srv = start(move |r| {
                if r.method == "POST" && r.path == "/api/v1/workspace/new" {
                    c2.store(true, Ordering::SeqCst);
                    return Resp::json(json!({ "workspace": { "slug": r.body["name"] } }));
                }
                if r.method == "GET" && r.path.starts_with("/api/v1/workspace/") {
                    return if c2.load(Ordering::SeqCst) { Resp::json(json!({ "workspace": [{ "slug": "bizops_trades_contracting" }] })) } else { Resp::status(404, json!({ "error": "no" })) };
                }
                Resp::status(500, json!({}))
            })
            .await;
            let dir = temp_dir("prov");
            let s = Store::open(&dir);
            s.provision_memory("trades_contracting").unwrap();
            let w = super::super::allm::AllmWriter::for_ops_provision(super::super::allm::AllmConn::test(&srv.base));
            let b = s.provision_workspace_for("trades_contracting", &w, Some("qwen/qwen3.5-9b")).await.unwrap();
            assert_eq!(b.status, BusinessStatus::Active);
            let new = srv.reqs().into_iter().find(|r| r.path == "/api/v1/workspace/new").unwrap();
            assert_eq!(new.body["name"], "bizops_trades_contracting");
            assert_eq!(new.body["chatMode"], "chat");
            assert_eq!(new.body["chatModel"], "qwen/qwen3.5-9b");
            let prompt = new.body["openAiPrompt"].as_str().unwrap();
            assert!(prompt.contains("Trades & Contracting") && prompt.contains("trades_contracting") && !prompt.contains("{display_name}"));
            // Idempotent: a second run adopts the existing workspace, no second create.
            s.provision_workspace_for("trades_contracting", &w, None).await.unwrap();
            assert_eq!(srv.count("POST", "/workspace/new"), 1);
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn the_finance_workspace_is_created_empty_or_refused() {
        tauri::async_runtime::block_on(async {
            use super::super::allm::mock::{start, Resp};
            use std::sync::atomic::{AtomicUsize, Ordering};
            use std::sync::Arc;
            // 0 = absent, 1 = created empty, 2 = created but someone embedded a document.
            let state = Arc::new(AtomicUsize::new(0));
            let s2 = state.clone();
            let srv = start(move |r| {
                if r.method == "POST" && r.path == "/api/v1/workspace/new" {
                    s2.store(1, Ordering::SeqCst);
                    return Resp::json(json!({ "workspace": { "slug": "finance" } }));
                }
                match s2.load(Ordering::SeqCst) {
                    0 => Resp::status(404, json!({ "error": "no" })),
                    1 => Resp::json(json!({ "workspace": [{ "slug": "finance", "documents": [] }] })),
                    _ => Resp::json(json!({ "workspace": [{ "slug": "finance", "documents": [{ "docpath": "custom-documents/ledger.json" }] }] })),
                }
            })
            .await;
            let w = super::super::allm::AllmWriter::for_ops_provision(super::super::allm::AllmConn::test(&srv.base));
            assert_eq!(provision_finance_workspace(&w, Some("qwen/qwen3.5-9b")).await.unwrap(), "created");
            let new = srv.reqs().into_iter().find(|r| r.path == "/api/v1/workspace/new").unwrap();
            assert_eq!((new.body["name"].as_str(), new.body["chatMode"].as_str()), (Some("Finance"), Some("chat")));
            assert!(new.body["openAiPrompt"].as_str().unwrap().contains("LEDGER rows"));
            // Idempotent.
            assert_eq!(provision_finance_workspace(&w, None).await.unwrap(), "exists");
            assert_eq!(srv.count("POST", "/workspace/new"), 1);
            // A document in it fails closed.
            state.store(2, Ordering::SeqCst);
            assert!(provision_finance_workspace(&w, None).await.unwrap_err().starts_with("SECURITY_FAIL_CLOSED"));
        });
    }

    #[test]
    fn provisioning_refuses_a_renamed_workspace() {
        tauri::async_runtime::block_on(async {
            use super::super::allm::mock::{start, Resp};
            let srv = start(|r| {
                if r.method == "POST" {
                    return Resp::json(json!({ "workspace": { "slug": "bizops_supplements_ecom-x1" } }));
                }
                Resp::status(404, json!({ "error": "no" }))
            })
            .await;
            let dir = temp_dir("prov2");
            let s = Store::open(&dir);
            s.provision_memory("supplements_ecom").unwrap();
            let w = super::super::allm::AllmWriter::for_ops_provision(super::super::allm::AllmConn::test(&srv.base));
            assert!(s.provision_workspace_for("supplements_ecom", &w, None).await.is_err());
            let b = s.get("supplements_ecom").unwrap();
            assert_eq!(b.status, BusinessStatus::Provisioning);
            assert!(b.provision.last_error.unwrap().contains("not \"bizops_supplements_ecom\""));
            let _ = std::fs::remove_dir_all(&dir);
        });
    }
}
