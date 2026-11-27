mod audio;
mod commands;
mod exe_resolve;
mod proc;
/// Sovereign security layer (app lock, step-up, audit, alerts, failsafe). `pub` so the
/// `gabagool-cli` binary (src/bin) shares the exact same code.
pub mod security;

use commands::{buildhub, diagnostics, handoff_cues, language_hub, lifecycle};
use commands::{arbiter, business_registry, finance_handoff, finance_vault, gdrive, integrity, media, memtier, ops_audit, ops_scope, quarantine, review_queue};
use commands::{agents, allm, allm_audit, bridge, calendar, claude_fix, clihub, devqueue, envelope, events, introspect, instagram, modellab, modes, dispatch, gmail, maps, market, mcp, memory, n8n, os_core, pipeline, pipelines, secrets, services, spotify, system, taskworker, telemetry, voice};

/// Event the webview listens for to start/stop a voice session.
pub const VOICE_TOGGLE_EVENT: &str = "voice-toggle";

/// Tray menu ids.
const TRAY_SHOW: &str = "tray-show";
const TRAY_AWAY: &str = "tray-away";
const TRAY_QUIT: &str = "tray-quit";

/// Keeps the tray's Away Mode check item in step with the UI toggle. Desktop only: mobile
/// builds have no tray (tauri::menu is configured out there).
#[cfg(desktop)]
static TRAY_AWAY_ITEM: std::sync::OnceLock<tauri::menu::CheckMenuItem<tauri::Wry>> = std::sync::OnceLock::new();

/// The tray check mark follows Away Mode (called from `arbiter_set_away`). No-op on mobile.
pub fn tray_set_away(_app: &tauri::AppHandle, _on: bool) {
    #[cfg(desktop)]
    if let Some(item) = TRAY_AWAY_ITEM.get() {
        let _ = item.set_checked(_on);
    }
}

fn show_main(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(desktop)]
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// A second launch handed over to this engine. In `tauri dev` the window loads its UI from
/// the Vite dev server; if that server died (or was killed) while the engine kept running
/// hidden in the tray, the page is a blank error page and every relaunch just re-showed a
/// black window. So in dev builds, when the dev server is answering again, reload from it.
/// Release builds load the bundled UI and only show the window.
fn on_second_launch(app: &tauri::AppHandle) {
    #[cfg(dev)]
    {
        use tauri::Manager;
        if let (Some(w), Some(url)) = (app.get_webview_window("main"), app.config().build.dev_url.clone()) {
            if dev_server_up(&url) {
                eprintln!("[dev] second launch: reloading the window from {url}");
                let _ = w.navigate(url);
            } else {
                eprintln!("[dev] second launch: dev server {url} is not answering; run `npx tauri dev` again");
            }
        }
    }
    show_main(app);
}

/// Can we open a TCP connection to the dev server's host:port within half a second?
#[cfg(dev)]
fn dev_server_up(url: &url::Url) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else { return false };
    let Ok(addrs) = (host, port).to_socket_addrs() else { return false };
    addrs.into_iter().any(|a| TcpStream::connect_timeout(&a, std::time::Duration::from_millis(500)).is_ok())
}

/// System tray: closing the window hides it here and the engine keeps running (scheduled
/// workers, Booking, Garbage, Observer). "Quit Engine Completely" is the only real exit.
#[cfg(desktop)]
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::Manager;
    let away_on = app.state::<os_core::OsState>().snapshot().scheduler.away_mode;
    let show = MenuItem::with_id(app, TRAY_SHOW, "Show Command Center", true, None::<&str>)?;
    let away = CheckMenuItem::with_id(app, TRAY_AWAY, "Away Mode (background gets the GPU)", true, away_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit Engine Completely", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &away, &PredefinedMenuItem::separator(app)?, &quit])?;
    let _ = TRAY_AWAY_ITEM.set(away);
    let mut b = TrayIconBuilder::with_id("engine").tooltip("Tony · Agentic OS engine").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.on_menu_event(|app, ev| match ev.id().as_ref() {
        TRAY_SHOW => show_main(app),
        TRAY_AWAY => {
            use tauri::Emitter;
            let os = app.state::<os_core::OsState>();
            let on = !os.snapshot().scheduler.away_mode;
            if arbiter::set_away(&os, on).is_ok() {
                tray_set_away(app, on);
                let _ = app.emit(arbiter::STATE_EVENT, arbiter::get().snapshot());
            }
        }
        TRAY_QUIT => {
            QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
            app.exit(0);
        }
        _ => {}
    })
    .on_tray_icon_event(|tray, ev| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
            show_main(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

/// Set by "Quit Engine Completely": the next close really exits.
static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // First: a second launch hands over to this engine (one GPU arbiter per machine).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| on_second_launch(app)));
    // Fingerprint / face on Android and iOS (called from Rust: security::biometric).
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_biometric::init());
    // The phone's Keystore-encrypted secret store (gateway token): commands::phone_secrets.
    #[cfg(mobile)]
    let builder = builder.plugin(commands::phone_secrets::plugin());
    builder
        .plugin(tauri_plugin_notification::init())
        // Director Suite file picker: open-file dialogs only (capability `dialog:allow-open`).
        .plugin(tauri_plugin_dialog::init())
        .manage(system::SysState::default())
        .manage(dispatch::DispatchState::default())
        .manage(bridge::BridgeState::default())
        .manage(pipelines::PipelineState::default())
        .manage(os_core::OsState::default())
        .manage(devqueue::DevQueueState::default())
        .manage(envelope::TaskStore::default())
        .manage(taskworker::WorkerState::default())
        .manage(claude_fix::ClaudeFixState::default())
        .manage(audio::commands::AudioEngineState::default())
        .manage(introspect::IntrospectState::default())
        .manage(lifecycle::LifecycleState::default())
        .manage(buildhub::HubState::default())
        .manage(media::MediaState::default())
        .manage(gdrive::GdriveState::default())
        .manage(language_hub::LangHubState::default())
        .setup(|app| {
            use tauri::Manager;
            // System Map: app uptime counts from here.
            introspect::mark_started();
            // System Map live routing trace: `os-trace` events from os_turn / mcp::call_tool.
            commands::trace::install(app.handle());
            // Agent event bus (`agent-event` + phone HUD mirror); events queue until this runs.
            events::install(app.handle());
            // Compute arbiter: `arbiter-state` / `arbiter-handoff` for the System Map.
            arbiter::get().install(app.handle());
            modes::install(app.handle());
            // AnythingLLM client: Tony's monthly thread map lives in tasks.db (Part 3).
            allm::install(app.handle());
            // Provider endpoints live in a file the user edits, not in the webview.
            if let Ok(dir) = app.path().app_config_dir() {
                let state = app.state::<dispatch::DispatchState>();
                state.load_or_init(&dir);
                // Permission Bridge policy + synaptic training log in <repo>/training_logs.
                let repo = std::path::PathBuf::from(state.snapshot().gateway.workdir);
                app.state::<bridge::BridgeState>().init(&dir, repo.join("training_logs"));
                // OS identity, compute mode, skills/MCP registry, privacy shield, memory lifecycle.
                app.state::<os_core::OsState>().load_or_init(&dir, &repo);
                // App lock / step-up / audit / failsafe watcher (<repo>/data/security, shared with
                // the gateway and gabagool-cli). After OsState: a held hard lock re-engages the
                // privacy kill switch at start.
                security::commands::install(app.handle(), Some(repo.clone()), &dir);
                // Two-tier agent memory (<config dir>/memory-tiers) and the sealed Finance vault
                // (<config dir>/vault/finance, sealed at start).
                memtier::init(&dir);
                // Hot-reloadable orchestration policy (<config dir>/telemetry/orchestrator_policy.json).
                commands::policy::init(&dir);
                // GPU capacity follows the policy hot; Live Observer stays OFF until toggled.
                commands::scheduler::install_policy(&app.state::<os_core::OsState>().slot);
                commands::live::init(app.handle());
                // Diagnostic probe reports (<config dir>/telemetry/diagnostics) + their schedule /
                // request.json loop.
                #[cfg(desktop)]
                diagnostics::init(app.handle(), &dir);
                // Model Lab A/B compare reports (<config dir>/telemetry/modellab) + its request.json loop.
                #[cfg(desktop)]
                modellab::compare::init(app.handle(), &dir);
                finance_vault::init(&dir);
                // Operations Manager: the business registry (<config dir>/businesses.json, memory/ops/<id>).
                business_registry::init(&dir);
                // Zero-trust layer: append-only audit (<config>/security/ops-audit.db), the
                // quarantine (<config>/staging/quarantine) and the checksum-verified rules
                // (<resource dir>/rules; a mismatch latches fail-closed).
                ops_audit::init(&dir);
                quarantine::init(&dir);
                #[cfg(desktop)]
                match app.path().resource_dir() {
                    Ok(res) => integrity::init(res.join("rules")),
                    Err(e) => eprintln!("[integrity] no resource dir ({e}); automated purge / flag / ops writes stay halted"),
                }
                // Android: bundle resources stay inside the signed APK (an `asset://` URL that
                // std::fs can't open), so the rules are written from the compiled-in copies to
                // app-private storage, which no other app or agent can write to.
                #[cfg(mobile)]
                match integrity::materialize(&dir.join("rules")) {
                    Ok(rules) => integrity::init(rules),
                    Err(e) => eprintln!("[integrity] could not write rules ({e}); automated purge / flag / ops writes stay halted"),
                }
                // Away Mode survives a restart (an overnight run keeps going).
                {
                    let os = app.state::<os_core::OsState>();
                    let away = os.snapshot().scheduler.away_mode;
                    os.slot.set_away(away);
                    arbiter::get().set_away_flag(away);
                }
                if app.state::<os_core::OsState>().snapshot().privacy.network_lock {
                    os_core::ensure_gateway_token(&state);
                }
                pipelines::load_last_sync(&state, &app.state::<pipelines::PipelineState>());
                // System Map dev task queue: <config dir>/devqueue.db (works without the gateway).
                app.state::<devqueue::DevQueueState>().init(&dir);
                // Director Suite index: <config dir>/media.db (projects live in C:i-hub\media\projects).
                app.state::<media::MediaState>().init(&dir);
                // P6: a run the last session left "running" died with it (its job was killed).
                claude_fix::recover_interrupted(&app.state::<devqueue::DevQueueState>());
                // TaskEnvelope store: <config dir>/tasks.db (separate from devqueue.db). A failure
                // is logged and leaves the worker disabled; the app keeps running.
                {
                    let osc = app.state::<os_core::OsState>().snapshot();
                    events::set_filter(&osc.os_name, &osc.wake_words);
                    let tasks = app.state::<envelope::TaskStore>();
                    // Agent Conversation transcripts: <config dir>/transcripts.db (its own file; the
                    // Librarian never reads it). Opened before recovery so the "interrupted" rows
                    // are recorded too; a failure only turns the feed off (hooks become no-ops).
                    let _ = commands::transcript::store().init(&dir);
                    if tasks.init(&dir).is_ok() {
                        // In-flight tasks keep their stage and get an `interrupted` row; the
                        // worker re-runs only that stage.
                        match tasks.recover_interrupted() {
                            Ok(ids) if !ids.is_empty() => eprintln!("[tasks] {} interrupted task(s) to resume", ids.len()),
                            Ok(_) => {}
                            Err(e) => eprintln!("[tasks] recovery: {e}"),
                        }
                    }
                }
                // Play Place staging hub: <config dir>/build-hub.json (Thought-to-Product Phases 2–4).
                app.state::<buildhub::HubState>().init(&dir);
                // Undo a Spotify session duck a crash left behind (<config dir>/media-duck.json).
                audio::ducker::recover(&dir);
            }
            // The engine's background work runs on the desktop only. On the phone (Android) these loops
            // would poll 127.0.0.1 (= the phone) every few seconds: battery drain and UI lag, for nothing.
            #[cfg(desktop)]
            {
                // Spotify: load the saved session / refresh silently so the widget's first status
                // check is instant. Never opens a browser; no-op when not connected.
                tauri::async_runtime::spawn(spotify::warm(app.handle().clone()));
                // MCP: start listing enabled stdio servers ~5 s after launch (into the cache, in
                // the background). No HTTP / token-gated server is contacted.
                tauri::async_runtime::spawn(mcp::warm(app.handle().clone()));
                // Section pass: the Librarian workspace is kept on Query mode (checked once at start).
                tauri::async_runtime::spawn(mcp::librarian_lock_at_start(app.handle().clone()));
                tauri::async_runtime::spawn(pipelines::auto_sync_loop(app.handle().clone()));
                tauri::async_runtime::spawn(commands::hygiene::lifecycle_loop(app.handle().clone()));
                // Phase 3: idle auto-compaction of Tier-1 memory into Memory Scrolls (off by default).
                tauri::async_runtime::spawn(commands::compaction::compaction_loop(app.handle().clone()));
                // Phone HUD → desktop: Tony turns, pipelines, kill switch / compute mode.
                tauri::async_runtime::spawn(pipeline::inbox_loop(app.handle().clone()));
                // The sequential TaskEnvelope worker: one stage of one task at a time (Part 5).
                tauri::async_runtime::spawn(taskworker::worker_loop(app.handle().clone()));
                // Thought-to-Product Phase 1: the gateway heartbeat (`gateway-health`, off the UI thread).
                tauri::async_runtime::spawn(lifecycle::health_loop(app.handle().clone()));
                // Play Place hub orchestration: FIFO hand-off, worker sync, smoke tests, peeks.
                tauri::async_runtime::spawn(buildhub::hub_loop(app.handle().clone()));
                // P6: pick up Claude Code's edits to <repo>/.agenticos/claude-fix-queue.json (10 s poll).
                tauri::async_runtime::spawn(devqueue::queue_file_loop(app.handle().clone()));
                // Renew the Instagram long-lived token before its 60 days run out.
                tauri::async_runtime::spawn(instagram::refresh_loop(app.handle().clone()));
                // GPU baton events → top-bar "ACTIVE GPU SLOT" pill; droplet auto-reconnect.
                {
                    use tauri::Emitter;
                    let h = app.handle().clone();
                    app.state::<os_core::OsState>().slot.set_notify(move |v| {
                        arbiter::get().on_slot(&v);
                        let _ = h.emit("gpu-slot", v);
                    });
                }
                // GPU baton → gateway cooperative lease (PUT /api/os/gpu), best-effort, latest-wins.
                tauri::async_runtime::spawn(commands::scheduler::gpu_mirror_loop(app.handle().clone()));
                // Loopback GPU lease API for the gateway (Trading = Tier 1), 127.0.0.1:8792.
                commands::lease::init(app.handle());
                tauri::async_runtime::spawn(os_core::droplet_link_loop(app.handle().clone()));
                // Keep the local model sized to fit VRAM even after Bionic auto-reloads it.
                tauri::async_runtime::spawn(services::whisper_keepalive_loop(app.handle().clone()));
                tauri::async_runtime::spawn(services::local_fit_loop(app.handle().clone()));
                tauri::async_runtime::spawn(services::tts_warm_loop(app.handle().clone()));
                // Zero-VRAM roster scripts (Security, Garbage, Observer, Booking) on idle / Away Mode.
                tauri::async_runtime::spawn(commands::downtime::downtime_loop(app.handle().clone()));
                // Garbage daemon: deterministic purge on schedule / quota / Security's handshake (0 VRAM).
                tauri::async_runtime::spawn(commands::garbage::daemon(app.handle().clone()));
                // HITL review queue: Garbage's business sweep + the batched digest / webhook.
                tauri::async_runtime::spawn(commands::review_queue::daemon(app.handle().clone()));
                #[cfg(desktop)]
                if let Err(e) = build_tray(app) {
                    eprintln!("[tray] {e}");
                }
                // Bring up the gateway (sync hub for the phone) and bind n8n to its
                // Docker container in the background, so the window opens instantly.
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let st = handle.state::<dispatch::DispatchState>();
                    match services::gateway_ensure(st.clone()).await {
                        Ok(s) => eprintln!("[gateway] {}", if s.is_up() { "up" } else { "down" }),
                        Err(e) => eprintln!("[gateway] {e}"),
                    }
                    let _ = n8n::n8n_discover(st, Some(true)).await;
                });
            }
            #[cfg(desktop)]
            register_voice_hotkey(app)?;
            Ok(())
        })
        // Close → hide to the tray (the engine keeps running); "Quit Engine Completely" exits.
        .on_window_event(|w, ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                if w.label() == "main" && !QUITTING.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        // Keep this list in sync with `NativeCommands` in src/lib/platform.ts.
        // Every invoke passes the security gate first (security::gate): locked / hard-locked
        // apps refuse everything but `security_*`; protected modules need a step-up.
        .invoke_handler({
            fn typed<F: Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool>(f: F) -> F {
                f
            }
            let handler = typed(tauri::generate_handler![
            security::commands::security_status,
            security::commands::security_touch,
            security::commands::security_unlock_pin,
            security::commands::security_biometric,
            security::commands::security_companion_request,
            security::commands::security_companion_poll,
            security::commands::security_lock,
            security::commands::security_elevate,
            security::commands::security_elevation_token,
            security::commands::security_drop_elevation,
            security::commands::security_lockdown_engage,
            security::commands::security_audit_recent,
            security::commands::security_companion_sign,
            security::commands::security_companion_store_key,
            security::commands::security_companion_check_alerts,
            security::commands::security_pin_setup,
            system::system_stats,
            arbiter::arbiter_snapshot,
            arbiter::arbiter_set_away,
            diagnostics::diag_run,
            diagnostics::diag_abort,
            diagnostics::diag_latest,
            diagnostics::diag_reports,
            diagnostics::diag_schedule_get,
            diagnostics::diag_schedule_set,
            commands::policy::policy_get,
            commands::policy::policy_set_mode,
            commands::live::live_set,
            commands::live::live_status,
            commands::live::live_ui_event,
            commands::live::agent_speech_event,
            arbiter::system_health,
            finance_vault::finance_vault_status,
            finance_vault::finance_vault_unlock,
            finance_vault::finance_vault_lock,
            finance_vault::finance_ledger_list,
            finance_vault::finance_ledger_write,
            finance_vault::finance_search,
            finance_vault::finance_librarian_search,
            business_registry::business_list,
            business_registry::business_create,
            business_registry::business_provision,
            business_registry::business_update,
            business_registry::business_set_archived,
            ops_scope::bizops_memory_list,
            ops_scope::bizops_memory_read,
            ops_scope::bizops_memory_write,
            ops_scope::bizops_memory_search,
            finance_handoff::bizops_finance_handoff,
            integrity::integrity_status,
            ops_audit::ops_audit_recent,
            quarantine::quarantine_flag_note,
            review_queue::review_list,
            review_queue::review_inspect,
            review_queue::review_approve,
            review_queue::review_reject,
            review_queue::review_settings,
            review_queue::review_config_set,
            review_queue::review_webhook_set,
            review_queue::review_webhook_clear,
            review_queue::review_webhook_test,
            commands::tony_dispatch::tony_dispatch_approve,
            commands::tony_dispatch::tony_dispatch_discard,
            secrets::secret_set,
            commands::phone_secrets::phone_secret_get,
            commands::phone_secrets::phone_secret_set,
            secrets::secret_status,
            secrets::secret_delete,
            dispatch::providers_list,
            dispatch::providers_update,
            dispatch::provider_add,
            dispatch::provider_remove,
            dispatch::policy_update,
            dispatch::agent_voice_update,
            dispatch::agent_voices_all_tony,
            dispatch::dispatch_chat,
            services::services_health,
            services::provider_models,
            services::gateway_ensure,
            voice::stt_transcribe,
            voice::stt_partial,
            language_hub::lang_status,
            language_hub::lang_library_list,
            language_hub::lang_library_save,
            language_hub::lang_library_update,
            language_hub::lang_library_delete,
            language_hub::lang_tracks_list,
            language_hub::lang_track_save,
            language_hub::lang_stt,
            language_hub::lang_tts,
            language_hub::lang_llm_json,
            language_hub::lang_release,
            language_hub::lang_voice_engines,
            language_hub::lang_settings_get,
            language_hub::lang_settings_set,
            voice::mic_set_enabled,
            voice::mic_get,
            voice::stt_configure,
            voice::tts_synthesize,
            voice::tts_voices,
            voice::tts_voice_upload,
            audio::commands::audio_engine_devices,
            audio::commands::audio_engine_start,
            audio::commands::audio_engine_stop,
            audio::commands::audio_engine_status,
            audio::commands::audio_engine_barge_in,
            audio::commands::audio_engine_test_tone,
            audio::commands::media_duck,
            audio::commands::media_unduck,
            audio::commands::media_duck_status,
            n8n::n8n_workflows,
            n8n::n8n_workflows_set,
            n8n::n8n_trigger,
            n8n::n8n_fetch,
            n8n::n8n_discover,
            bridge::bridge_get,
            bridge::bridge_set,
            pipelines::pipelines_status,
            pipelines::pipeline_run,
            pipelines::pipeline_set_active,
            pipelines::pipelines_settings,
            pipelines::pipelines_settings_update,
            pipelines::n8n_instance_add,
            pipelines::trigger_gdrive_sync,
            telemetry::docker_ps,
            telemetry::netbird_status,
            os_core::os_config_get,
            os_core::os_config_update,
            os_core::os_identity,
            os_core::os_secret_set,
            os_core::os_secret_status,
            commands::envfile::os_secret_sources,
            os_core::os_secret_delete,
            os_core::privacy_last_payload,
            os_core::privacy_preview,
            os_core::droplet_test,
            os_core::network_audit,
            os_core::gateway_token_rotate,
            agents::anythingllm_workspaces,
            allm_audit::anythingllm_workspace_audit,
            agents::os_turn,
            agents::os_turn_cancel,
            agents::learning_approve,
            agents::learning_discard,
            agents::overseer_ask,
            mcp::mcp_list_tools,
            media::media_projects,
            media::media_project_create,
            media::media_project_get,
            media::media_ingest_paths,
            media::media_ingest_begin,
            media::media_ingest_chunk,
            media::media_ingest_finish,
            media::media_voiceover_save,
            media::media_manifest_save,
            media::media_chat_log,
            media::media_render_plan,
            media::media_render_execute,
            media::media_render_cancel,
            media::media_readiness,
            media::media_reveal,
            gdrive::cloud_status,
            gdrive::cloud_connect,
            gdrive::cloud_disconnect,
            gdrive::cloud_list,
            gdrive::cloud_set_folders,
            gdrive::cloud_pull,
            gdrive::cloud_push,
            gdrive::cloud_share,
            gdrive::cloud_cancel,
            gdrive::cloud_transfers,
            gdrive::cloud_history,
            agents::tony_tools_preview,
            mcp::mcp_call,
            mcp::mcp_sync_anythingllm,
            mcp::librarian_preflight,
            mcp::skills_scan,
            gmail::gmail_status,
            gmail::gmail_import_anythingllm,
            gmail::gmail_create_draft,
            gmail::gmail_booking_instructions,
            gmail::gmail_booking_instructions_open,
            gmail::gmail_last_bookings,
            calendar::gcal_status,
            calendar::gcal_import_anythingllm,
            calendar::gcal_create_event,
            maps::map_route,
            maps::map_geocode,
            maps::map_reverse,
            maps::maps_status,
            maps::map_open_in_maps,
            instagram::instagram_status,
            instagram::instagram_refresh_token,
            instagram::instagram_reply_comment,
            instagram::instagram_publish_post,
            spotify::spotify_auth_start,
            spotify::spotify_status,
            spotify::spotify_disconnect,
            spotify::spotify_now_playing,
            spotify::spotify_control,
            spotify::spotify_play,
            spotify::spotify_play_uri,
            spotify::spotify_recent,
            spotify::spotify_playlists,
            spotify::spotify_tool,
            spotify::spotify_duck,
            spotify::spotify_unduck,
            commands::spotify_intent::spotify_parse,
            commands::alarm::alarm_os_schedule,
            commands::alarm::alarm_os_cancel,
            commands::alarm::alarm_os_prune,
            memory::memory_harvest,
            memory::memory_flush,
            memory::memory_ledger,
            memory::memory_mount,
            memory::memory_unmount,
            memory::memory_export,
            commands::compaction::memory_compact,
            commands::compaction::memory_compaction_status,
            commands::compaction::memory_idle_state,
            memory::memory_purge_raw_vectors,
            commands::hygiene::hygiene_status,
            commands::hygiene::hygiene_sweep,
            commands::hygiene::memory_scrolls_preset,
            market::market_candles,
            pipeline::idea_capture,
            pipeline::idea_pipeline_run,
            pipeline::playplace_iterate,
            pipeline::playplace_approve,
            pipeline::playplace_commit,
            pipeline::comms_whatsapp,
            pipeline::comms_whatsapp_send,
            clihub::cli_status,
            modellab::model_lab_list,
            modellab::model_bench,
            modellab::model_use,
            modellab::compare::model_compare,
            modellab::compare::model_compare_status,
            modellab::compare::model_compare_cancel,
            pipeline::pipeline_resume,
            taskworker::task_create,
            modes::tony_modes_get,
            modes::tony_mode_set_active,
            modes::tony_mode_override,
            modes::tony_mode_reset,
            modes::tony_mode_upsert,
            modes::tony_mode_duplicate,
            modes::tony_mode_delete,
            taskworker::task_get,
            taskworker::task_list,
            taskworker::task_status,
            taskworker::task_retry,
            taskworker::task_cancel,
            events::agent_events_replay,
            commands::transcript::transcript_conversations,
            commands::transcript::transcript_get,
            commands::transcript::transcript_message,
            os_core::droplet_link,
            os_core::gpu_slot_view,
            clihub::cli_install,
            devqueue::dev_task_add,
            devqueue::dev_task_list,
            devqueue::dev_task_update,
            devqueue::dev_task_delete,
            devqueue::dev_brief_export,
            devqueue::dev_fix_queue,
            claude_fix::dev_fix_dispatch,
            claude_fix::dev_fix_cancel,
            introspect::system_introspect,
            introspect::app_uptime,
            lifecycle::gateway_health,
            lifecycle::gateway_reconnect,
            lifecycle::app_exit_check,
            lifecycle::app_exit,
            buildhub::build_hub_view,
            buildhub::build_runtime_config,
            buildhub::build_set_external_base,
            buildhub::build_enqueue,
            buildhub::build_reorder,
            buildhub::build_pause,
            buildhub::build_resume,
            buildhub::build_steer,
            buildhub::build_to_repair,
            buildhub::build_set_max_iterations,
            buildhub::build_requeue,
            buildhub::build_rework,
            buildhub::build_smoke,
            buildhub::build_promote,
            buildhub::build_remove,
            buildhub::cancel_build_job,
            commands::net_telemetry::get_network_telemetry,
            commands::net_telemetry::network_telemetry_stop,
            commands::net_telemetry::run_speed_test,
            arbiter::agent_inspect,
            buildhub::delete_build_job,
            buildhub::clear_failed_jobs,
            buildhub::runner_dismiss,
            buildhub::build_widget_url,
            buildhub::build_peek_status,
            buildhub::build_open_window,
            buildhub::build_open_browser,
            buildhub::build_intake_questions,
            handoff_cues::handoff_pool_get,
            ]);
            move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
                let decision = {
                    let args = match invoke.message.payload() {
                        tauri::ipc::InvokeBody::Json(v) => Some(v),
                        _ => None,
                    };
                    security::gate::decide(invoke.message.command(), args)
                };
                match decision {
                    Ok(()) => handler(invoke),
                    Err(e) => {
                        invoke.resolver.reject(e);
                        true
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Jarvis Command Center")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                // Never leave Spotify at the duck level: its session volume back now, before
                // anything slow (no-op unless something was ducked this run).
                audio::ducker::restore_now();
            }
            // Clean exit → one last Drive sync, if auto-sync (the standing consent) is on.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                let state = app.state::<dispatch::DispatchState>();
                let cfg = state.snapshot().pipelines;
                if cfg.auto_sync_enabled && cfg.sync_on_exit && !cfg.gdrive_sync_webhook_url.is_empty() {
                    let bridge = app.state::<bridge::BridgeState>();
                    let pipes = app.state::<pipelines::PipelineState>();
                    // Bounded by the 3 s network timeout inside the sync.
                    let _ = tauri::async_runtime::block_on(pipelines::run_gdrive_sync(&state, &bridge, &pipes, bridge::Actor::Scheduler, false, "app-exit"));
                }
            }
            // Android: once the activity is destroyed, tao ends the process with
            // std::process::exit. exit() runs C++ static destructors while Android's own
            // RenderThread / hwuiTask threads are still drawing, and they abort on a destroyed
            // mutex (FORTIFY, "app keeps stopping"). Our cleanup above is done and Tauri's
            // cleanup only clears in-memory tables, so finish with _exit, which skips them.
            #[cfg(target_os = "android")]
            if let tauri::RunEvent::Exit = event {
                use std::io::Write;
                app.cleanup_before_exit();
                let _ = std::io::stdout().flush();
                let _ = std::io::stderr().flush();
                extern "C" {
                    fn _exit(code: std::os::raw::c_int) -> !;
                }
                // SAFETY: bionic's _exit; nothing runs after it.
                unsafe { _exit(0) }
            }
        });
}

/// System-wide Ctrl+Shift+Space: bring Jarvis forward and toggle listening,
/// even when the window is minimised or another app has focus.
#[cfg(desktop)]
fn register_voice_hotkey(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &hotkey && event.state() == ShortcutState::Pressed {
                    show_main(app);
                    // Phase 2 Part B: a locked-off mic never opens from the hotkey. The webview
                    // handles `mic-locked` as a stop-only toggle: it can still stop Tony speaking
                    // or a turn in flight; from rest it toasts and never listens.
                    if voice::mic_enabled() {
                        let _ = app.emit(VOICE_TOGGLE_EVENT, ());
                    } else {
                        let _ = app.emit(voice::MIC_LOCKED_EVENT, ());
                    }
                }
            })
            .build(),
    )?;
    // Another app may already own the combo; the in-window shortcut still works then.
    if let Err(e) = app.global_shortcut().register(hotkey) {
        eprintln!("[hotkey] Ctrl+Shift+Space unavailable: {e}");
    }
    Ok(())
}
