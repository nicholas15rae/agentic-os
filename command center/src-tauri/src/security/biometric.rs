//! Native biometrics.
//!
//! - Windows: Windows Hello (`UserConsentVerifier`, fingerprint / face / Hello PIN), shown over
//!   the main window via `IUserConsentVerifierInterop`.
//! - Android / iOS: `tauri-plugin-biometric` (fingerprint / face), called from Rust so no
//!   webview permission is needed.
//! - Elsewhere: unavailable (use the companion phone or the PIN).

use tauri::AppHandle;

/// Can this device verify the user biometrically right now?
pub fn available(app: &AppHandle) -> bool {
    let _ = app;
    #[cfg(windows)]
    {
        win::available()
    }
    #[cfg(mobile)]
    {
        use tauri_plugin_biometric::BiometricExt;
        app.biometric().status().map(|s| s.is_available).unwrap_or(false)
    }
    #[cfg(not(any(windows, mobile)))]
    {
        false
    }
}

/// Prompt for biometric verification; Ok only on a verified match.
pub async fn verify(app: &AppHandle, reason: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let hwnd = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
        let reason = reason.to_string();
        tauri::async_runtime::spawn_blocking(move || win::verify(hwnd, &reason)).await.map_err(|e| e.to_string())?
    }
    #[cfg(mobile)]
    {
        use tauri_plugin_biometric::{AuthOptions, BiometricExt};
        let opts = AuthOptions { allow_device_credential: false, ..Default::default() };
        app.biometric().authenticate(reason.to_string(), opts).map_err(|e| e.to_string())
    }
    #[cfg(not(any(windows, mobile)))]
    {
        let _ = (app, reason);
        Err("BIOMETRIC_UNAVAILABLE: no biometric hardware support on this platform".into())
    }
}

#[cfg(windows)]
mod win {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows_future::IAsyncOperation;

    pub fn available() -> bool {
        UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join()).map(|a| a == UserConsentVerifierAvailability::Available).unwrap_or(false)
    }

    pub fn verify(hwnd: Option<isize>, reason: &str) -> Result<(), String> {
        if !available() {
            return Err("BIOMETRIC_UNAVAILABLE: Windows Hello is not set up on this PC".into());
        }
        let msg = HSTRING::from(reason);
        let op: IAsyncOperation<UserConsentVerificationResult> = match hwnd {
            Some(h) => {
                let interop = windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(|e| e.to_string())?;
                // SAFETY: `h` is the live main window handle; the call only reads it.
                unsafe { interop.RequestVerificationForWindowAsync(HWND(h as *mut core::ffi::c_void), &msg) }.map_err(|e| e.to_string())?
            }
            None => UserConsentVerifier::RequestVerificationAsync(&msg).map_err(|e| e.to_string())?,
        };
        let r = op.join().map_err(|e| e.to_string())?;
        if r == UserConsentVerificationResult::Verified {
            Ok(())
        } else if r == UserConsentVerificationResult::Canceled {
            Err("BIOMETRIC_CANCELLED: verification was cancelled".into())
        } else {
            Err(format!("BIOMETRIC_FAILED: Windows Hello did not verify (code {})", r.0))
        }
    }
}
