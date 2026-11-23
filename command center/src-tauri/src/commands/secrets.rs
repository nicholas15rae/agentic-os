//! API keys live in the OS credential store (Windows Credential Manager,
//! macOS Keychain, Secret Service on Linux). The webview can set, check and
//! delete a key but can NEVER read one back — `get` is crate-private and only
//! used when Rust itself makes the outbound request.
//!
//! Each key is bound to its provider's host (`<id>@<host>`), so if the webview
//! were compromised and re-pointed a provider at another server, the stored
//! key would simply not be found rather than being sent there.

use std::collections::HashMap;
use tauri::State;

use super::dispatch::DispatchState;

const SERVICE: &str = "agentic-os-command-center";

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Optional second slot per provider, e.g. n8n keeps its webhook token in the
/// default slot and its REST API key in "api". Still bound to the host.
const SLOTS: [&str; 1] = ["api"];

/// Rust-only keychain entries that are not providers.json providers (e.g. the Google Drive
/// refresh token written by gdrive.rs), each bound to a fixed host. The webview commands refuse
/// these ids, so it can neither overwrite nor delete them.
const INTERNAL: [(&str, &str); 1] = [("gdrive-token", "oauth2.googleapis.com")];

fn internal_account(provider: &str) -> Option<String> {
    INTERNAL.iter().find(|(id, _)| *id == provider).map(|(id, host)| format!("{id}@{host}"))
}

fn account_slot(state: &DispatchState, provider: &str, slot: Option<&str>) -> Result<String, String> {
    if !valid_id(provider) {
        return Err("invalid provider id".into());
    }
    if internal_account(provider).is_some() {
        return Err("reserved provider id".into());
    }
    let host = state.provider_host(provider).ok_or("unknown provider")?;
    match slot {
        None => Ok(format!("{provider}@{host}")),
        Some(s) if SLOTS.contains(&s) => Ok(format!("{provider}#{s}@{host}")),
        Some(_) => Err("invalid key slot".into()),
    }
}

fn account(state: &DispatchState, provider: &str) -> Result<String, String> {
    account_slot(state, provider, None)
}

/// Rust-only accessor for a named slot. Never expose through a command.
pub(crate) fn get_slot(state: &DispatchState, provider: &str, slot: &str) -> Option<String> {
    let acct = account_slot(state, provider, Some(slot)).ok()?;
    entry(&acct).ok()?.get_password().ok()
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Rust-only accessor. Never expose through a command.
pub(crate) fn get(state: &DispatchState, provider: &str) -> Option<String> {
    let acct = internal_account(provider).or_else(|| account(state, provider).ok())?;
    entry(&acct).ok()?.get_password().ok()
}

/// Rust-only writer (e.g. the Drive refresh token). Never expose through a command.
pub(crate) fn set(state: &DispatchState, provider: &str, value: &str) -> Result<(), String> {
    let acct = match internal_account(provider) {
        Some(a) => a,
        None => account(state, provider)?,
    };
    check_secret_value(value)?;
    entry(&acct)?.set_password(value).map_err(|e| e.to_string())
}

/// Rust-only delete; a missing entry is fine.
pub(crate) fn delete(state: &DispatchState, provider: &str) -> Result<(), String> {
    let acct = match internal_account(provider) {
        Some(a) => a,
        None => account(state, provider)?,
    };
    match entry(&acct)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// `host[:port]` of a URL (lower-case host), or None when it doesn't parse.
pub(crate) fn url_host(u: &str) -> Option<String> {
    let u = url::Url::parse(u.trim()).ok()?;
    let host = u.host_str()?.to_ascii_lowercase();
    Some(match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host,
    })
}

/// The AnythingLLM key is bound to the providers.json `anythingllm` host, while every
/// AnythingLLM call goes to `os.json anythingllm.baseUrl`. When the two differ the key lookup
/// and the target silently diverge, so say so (hosts only, never the key).
pub(crate) fn allm_host_mismatch(provider_host: Option<&str>, os_base: &str) -> Option<String> {
    let provider_host = provider_host?;
    let os_host = url_host(os_base)?;
    (provider_host.to_ascii_lowercase() != os_host).then(|| {
        format!("the AnythingLLM key is stored for {provider_host} (providers.json) but calls go to {os_host} (os.json anythingllm.baseUrl); make the two match in Settings")
    })
}

/// `allm_host_mismatch` for the live config; logs each distinct mismatch once.
pub(crate) fn warn_allm_host_mismatch(state: &DispatchState, os_base: &str) -> Option<String> {
    let msg = allm_host_mismatch(state.provider_host("anythingllm").as_deref(), os_base)?;
    static SEEN: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let mut seen = SEEN.lock().unwrap_or_else(|p| p.into_inner());
    if !seen.contains(&msg) {
        eprintln!("[secrets] warning: {msg}");
        seen.push(msg.clone());
    }
    Some(msg)
}

/// Longest value Settings accepts. Windows Credential Manager holds at most 2560 bytes
/// of UTF-16 (about 1280 characters); every real key / token / ID is far shorter.
pub(crate) const MAX_SECRET_CHARS: usize = 1024;

/// A pasted secret (already trimmed) is non-empty and fits the OS keychain. The message
/// names the limit only, never the value or its length.
pub(crate) fn check_secret_value(v: &str) -> Result<(), String> {
    if v.is_empty() {
        return Err("paste a value first".into());
    }
    if v.chars().count() > MAX_SECRET_CHARS || v.encode_utf16().count() * 2 > 2560 {
        return Err(format!("too long for the OS keychain (max {MAX_SECRET_CHARS} characters) — check you pasted only the key"));
    }
    Ok(())
}

#[tauri::command]
pub fn secret_set(state: State<'_, DispatchState>, provider: String, value: String, slot: Option<String>) -> Result<(), String> {
    let value = value.trim();
    check_secret_value(value)?;
    entry(&account_slot(&state, &provider, slot.as_deref())?)?.set_password(value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_status(state: State<'_, DispatchState>, providers: Vec<String>) -> HashMap<String, bool> {
    providers
        .into_iter()
        .map(|p| {
            let has = get(&state, &p).is_some();
            (p, has)
        })
        .collect()
}

#[tauri::command]
pub fn secret_delete(state: State<'_, DispatchState>, provider: String, slot: Option<String>) -> Result<(), String> {
    match entry(&account_slot(&state, &provider, slot.as_deref())?)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_value_limits() {
        assert!(check_secret_value("").is_err());
        assert!(check_secret_value("sk-test-123").is_ok());
        assert!(check_secret_value(&"a".repeat(MAX_SECRET_CHARS)).is_ok());
        let e = check_secret_value(&"a".repeat(MAX_SECRET_CHARS + 1)).unwrap_err();
        assert!(e.contains("1024") && !e.contains("aaaa"));
        // 700 non-BMP chars = 1400 UTF-16 units = 2800 bytes: over the Credential Manager limit.
        assert!(check_secret_value(&"\u{1F600}".repeat(700)).is_err());
    }

    #[test]
    fn internal_ids_are_rust_only() {
        let st = DispatchState::default();
        // The webview-facing account resolver refuses the Drive refresh-token id…
        assert_eq!(account_slot(&st, "gdrive-token", None).unwrap_err(), "reserved provider id");
        // …while the Rust-only path binds it to Google's token host.
        assert_eq!(internal_account("gdrive-token").as_deref(), Some("gdrive-token@oauth2.googleapis.com"));
        assert_eq!(internal_account("google"), None);
        assert!(account(&st, "google").unwrap().starts_with("google@"));
    }

    #[test]
    fn allm_host_mismatch_is_reported_without_secrets() {
        assert_eq!(allm_host_mismatch(Some("127.0.0.1:3001"), "http://127.0.0.1:3001"), None);
        assert_eq!(allm_host_mismatch(Some("127.0.0.1:3001"), "http://127.0.0.1:3001/"), None);
        let m = allm_host_mismatch(Some("127.0.0.1:3001"), "http://localhost:3001").unwrap();
        assert!(m.contains("127.0.0.1:3001") && m.contains("localhost:3001"));
        assert!(allm_host_mismatch(Some("127.0.0.1:3001"), "http://127.0.0.1:3002").is_some());
        assert_eq!(allm_host_mismatch(None, "http://x:1"), None);
        assert_eq!(allm_host_mismatch(Some("a:1"), "not a url"), None);
        // The live default config agrees with itself.
        let st = DispatchState::default();
        assert_eq!(allm_host_mismatch(st.provider_host("anythingllm").as_deref(), &super::super::os_core::OsConfig::default().anythingllm.base_url), None);
    }
}

/// One-off setup helper: store a provider key from the environment without it
/// ever being printed. `PROVIDER_ID=droplet PROVIDER_KEY=… cargo test --lib live_store_key -- --ignored`
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_store_key() {
        let id = std::env::var("PROVIDER_ID").expect("PROVIDER_ID");
        let key = std::env::var("PROVIDER_KEY").expect("PROVIDER_KEY");
        let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("os.agentic.commandcenter");
        let state = DispatchState::default();
        state.load_or_init(&dir);
        let acct = account(&state, &id).expect("account");
        entry(&acct).unwrap().set_password(key.trim()).unwrap();
        assert!(get(&state, &id).is_some());
        println!("STORED key for {acct} ({} chars)", key.trim().len());
    }
}
