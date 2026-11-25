//! Phone-only secrets: the gateway token, kept across app restarts on Android.
//!
//! The desktop never stores the token in the webview (it reaches the gateway on loopback). The
//! Android app has no keyring backend, so the token is encrypted by `SecureStorePlugin.kt` with an
//! Android Keystore key (AES-256-GCM, not exportable) and only the ciphertext is kept in the app's
//! private storage. Only allow-listed keys can be read or written.

use serde::{Deserialize, Serialize};

/// The only secrets the phone may keep.
const ALLOWED: [&str; 1] = ["gateway-token"];

fn check(key: &str) -> Result<(), String> {
    if ALLOWED.contains(&key) {
        Ok(())
    } else {
        Err(format!("unknown phone secret '{key}'"))
    }
}

#[cfg(target_os = "android")]
pub struct SecureStore<R: tauri::Runtime>(tauri::plugin::PluginHandle<R>);

/// Registers the Kotlin store (Android); a no-op plugin elsewhere on mobile.
#[cfg(mobile)]
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("secure-store")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("os.agentic.commandcenter", "SecureStorePlugin")?;
                _app.manage(SecureStore(handle));
            }
            Ok(())
        })
        .build()
}

#[derive(Serialize)]
#[allow(dead_code)]
struct Args<'a> {
    key: &'a str,
    value: Option<&'a str>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct GetResp {
    value: String,
}

/// The stored value, or `None` when nothing is saved. Errors with PHONE_ONLY off Android.
#[tauri::command]
pub fn phone_secret_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    check(&key)?;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let store = app.try_state::<SecureStore<tauri::Wry>>().ok_or("secure store not ready")?;
        let r: GetResp = store.0.run_mobile_plugin("get", Args { key: &key, value: None }).map_err(|e| e.to_string())?;
        Ok(Some(r.value).filter(|v| !v.is_empty()))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("PHONE_ONLY: secrets are only kept on the Android app".into())
    }
}

/// Save (or, with an empty value, forget) a phone secret.
#[tauri::command]
pub fn phone_secret_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    check(&key)?;
    let value = value.trim();
    if value.len() > 4096 {
        return Err("value too long".into());
    }
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let store = app.try_state::<SecureStore<tauri::Wry>>().ok_or("secure store not ready")?;
        store.0.run_mobile_plugin::<()>("set", Args { key: &key, value: Some(value) }).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, value);
        Err("PHONE_ONLY: secrets are only kept on the Android app".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allow_listed_keys() {
        assert!(check("gateway-token").is_ok());
        assert!(check("elevenlabs").is_err());
        assert!(check("../x").is_err());
    }
}
