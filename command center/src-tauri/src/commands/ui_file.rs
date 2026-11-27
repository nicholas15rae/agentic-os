//! Settings → Appearance → Export: saves `agentic-os-ui.json` (layouts + themes) where the user
//! picks in a native Save dialog. The webview hands over only the file's text, never a path, so
//! this can't write anywhere the user didn't choose.

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Largest export accepted (a few hundred KB in practice).
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// Ok(Some(path)) when saved, Ok(None) when the user cancelled.
#[tauri::command]
pub async fn ui_file_save(app: AppHandle, contents: String) -> Result<Option<String>, String> {
    if contents.len() > MAX_BYTES {
        return Err("The export is too large".into());
    }
    if serde_json::from_str::<serde_json::Value>(&contents).is_err() {
        return Err("The export isn't valid JSON".into());
    }
    let picked = app.dialog().file().set_file_name("agentic-os-ui.json").add_filter("Layouts and themes", &["json"]).blocking_save_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("Couldn't save: {e}"))?;
    Ok(Some(path.display().to_string()))
}
