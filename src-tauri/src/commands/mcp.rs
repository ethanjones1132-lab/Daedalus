// MCP server config UI (P5.3c). No UI-facing endpoint existed for `.mcp.json`
// before this — it was read only by the Bun orchestrator's own mcp-tools.ts,
// used exclusively by the agent's own tool-calling runtime (mcp_list_servers /
// mcp_call_tool etc. are LLM tool-calls, not HTTP routes or Tauri commands).
//
// Mirrors the shape `server-jarvis/src/mcp-tools.ts` already reads:
// `{"mcpServers": {"<name>": {command?, args?, env?, cwd?, url?, disabled?, type?}}}`
// at `<jarvis_path>/.mcp.json`. A missing file is treated as "no servers yet"
// (not an error) on read, matching `loadMcpServers`'s existing behavior.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct McpServerEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "type")]
    pub server_type: Option<String>,
}

pub type McpServerMap = HashMap<String, McpServerEntry>;

#[derive(Debug, Serialize, Deserialize, Default)]
struct McpFile {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: McpServerMap,
}

pub(crate) fn mcp_config_path(jarvis_path: &str) -> PathBuf {
    if jarvis_path.trim().is_empty() {
        return std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".mcp.json");
    }
    Path::new(jarvis_path).join(".mcp.json")
}

/// Pure parse — given raw file text (or `None` for a missing file), return the
/// server map. Never errors: malformed JSON or a missing `mcpServers` key both
/// yield an empty map, matching the TS reader's fail-open behavior (a broken
/// `.mcp.json` should not crash config loading).
pub(crate) fn parse_mcp_servers(raw: Option<&str>) -> McpServerMap {
    let Some(text) = raw else { return HashMap::new() };
    serde_json::from_str::<McpFile>(text)
        .map(|f| f.mcp_servers)
        .unwrap_or_default()
}

pub(crate) fn render_mcp_file(servers: &McpServerMap) -> Result<String, String> {
    serde_json::to_string_pretty(&McpFile { mcp_servers: servers.clone() }).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_mcp_servers(
    state: State<'_, crate::jarvis::types::JarvisState>,
) -> Result<McpServerMap, String> {
    let jarvis_path = state.config.lock().await.jarvis_path.clone();
    let path = mcp_config_path(&jarvis_path);
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(parse_mcp_servers(Some(&text)))
}

#[tauri::command]
pub async fn save_mcp_servers(
    servers: McpServerMap,
    state: State<'_, crate::jarvis::types::JarvisState>,
) -> Result<(), String> {
    let jarvis_path = state.config.lock().await.jarvis_path.clone();
    let path = mcp_config_path(&jarvis_path);
    let text = render_mcp_file(&servers)?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_yields_no_servers() {
        assert_eq!(parse_mcp_servers(None), HashMap::new());
    }

    #[test]
    fn malformed_json_fails_open_to_no_servers() {
        assert_eq!(parse_mcp_servers(Some("{not valid json")), HashMap::new());
    }

    #[test]
    fn round_trips_the_shape_mcp_tools_ts_already_reads() {
        let mut servers = HashMap::new();
        servers.insert(
            "filesystem".to_string(),
            McpServerEntry {
                command: Some("npx".to_string()),
                args: vec!["-y".to_string(), "@modelcontextprotocol/server-filesystem".to_string()],
                env: HashMap::new(),
                cwd: None,
                url: None,
                disabled: false,
                server_type: None,
            },
        );
        let text = render_mcp_file(&servers).expect("render");
        assert!(text.contains("\"mcpServers\""));
        assert!(text.contains("\"filesystem\""));
        let parsed = parse_mcp_servers(Some(&text));
        assert_eq!(parsed, servers);
    }

    #[test]
    fn a_disabled_server_round_trips_its_flag() {
        let mut servers = HashMap::new();
        servers.insert(
            "disabled_one".to_string(),
            McpServerEntry { disabled: true, ..Default::default() },
        );
        let text = render_mcp_file(&servers).expect("render");
        let parsed = parse_mcp_servers(Some(&text));
        assert!(parsed["disabled_one"].disabled);
    }

    #[test]
    fn accepts_the_alternate_top_level_key_shape_gracefully() {
        // mcp-tools.ts also tolerates a bare `servers` key as a fallback; this
        // Rust side does not need to (the UI always writes `mcpServers`), but
        // it must not error on a file it didn't write, e.g. one with only a
        // `servers` key -- treat as empty rather than crash.
        let parsed = parse_mcp_servers(Some(r#"{"servers": {"x": {}}}"#));
        assert_eq!(parsed, HashMap::new());
    }

    #[test]
    fn empty_path_falls_back_to_cwd_join_dot_mcp_json() {
        let path = mcp_config_path("");
        assert_eq!(path.file_name().unwrap(), ".mcp.json");
    }

    #[test]
    fn nonempty_path_joins_directly() {
        let path = mcp_config_path("C:\\Users\\ethan\\myproject");
        assert_eq!(path, PathBuf::from("C:\\Users\\ethan\\myproject\\.mcp.json"));
    }
}
