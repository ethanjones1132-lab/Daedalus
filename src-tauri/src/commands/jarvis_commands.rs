use crate::jarvis;
use crate::jarvis::bridge::{start_bridge, stop_bridge};
use crate::jarvis::runner::{check_jarvis_status, run_jarvis_message};
use crate::jarvis::types::*;
use crate::jarvis_types::JarvisState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn jarvis_send_message(
    app: AppHandle,
    message: String,
    session_id: String,
    state: State<'_, JarvisState>,
) -> Result<(), String> {
    let config = state.config.lock().await.clone();
    run_jarvis_message(app, config, session_id, message)
}

#[tauri::command]
pub async fn jarvis_new_session(
    name: Option<String>,
    state: State<'_, JarvisState>,
) -> Result<JarvisSession, String> {
    let config = state.config.lock().await;
    jarvis::create_jarvis_session(name, &config.model)
}

#[tauri::command]
pub async fn jarvis_list_sessions() -> Result<Vec<JarvisSession>, String> {
    jarvis::list_jarvis_sessions()
}

#[tauri::command]
pub async fn jarvis_delete_session(session_id: String) -> Result<(), String> {
    jarvis::delete_jarvis_session(&session_id)
}

#[tauri::command]
pub async fn jarvis_get_config(state: State<'_, JarvisState>) -> Result<JarvisConfig, String> {
    Ok(state.config.lock().await.clone())
}

#[tauri::command]
pub async fn jarvis_save_config(
    config: JarvisConfig,
    state: State<'_, JarvisState>,
) -> Result<(), String> {
    jarvis::save_jarvis_config(&config)?;
    let mut guard = state.config.lock().await;
    *guard = config;
    Ok(())
}

#[tauri::command]
pub async fn jarvis_check_status(state: State<'_, JarvisState>) -> Result<JarvisStatus, String> {
    let config = state.config.lock().await;
    Ok(check_jarvis_status(&config))
}

#[tauri::command]
pub async fn jarvis_start_bridge(state: State<'_, JarvisState>) -> Result<(), String> {
    let queue = state.queue.clone();
    start_bridge(19876, queue)
}

#[tauri::command]
pub async fn jarvis_stop_bridge() -> Result<(), String> {
    stop_bridge()
}
