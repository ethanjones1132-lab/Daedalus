use crate::types::*;
use serde_json::Value;

// ═══════════════════════════════════════════════════════════════
// ── Helpers ──
// ═══════════════════════════════════════════════════════════════

pub fn s(val: &Value, key: &str, default: impl AsRef<str>) -> String {
    val.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| default.as_ref())
        .to_string()
}

pub fn b(val: &Value, key: &str, default: bool) -> bool {
    val.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

pub fn u(val: &Value, key: &str, default: u64) -> u64 {
    val.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
}

// ═══════════════════════════════════════════════════════════════
// ── Parsers ──
// ═══════════════════════════════════════════════════════════════

pub fn parse_dashboard_status(raw: &Value) -> Result<DashboardStatus, String> {
    let gateway = raw.get("gateway").unwrap_or(&Value::Null);
    let gw_service = raw.get("gatewayService").unwrap_or(&Value::Null);
    let node_service = raw.get("nodeService").unwrap_or(&Value::Null);
    let os = raw.get("os").unwrap_or(&Value::Null);
    let update = raw.get("update").unwrap_or(&Value::Null);
    let mem_plugin = raw.get("memoryPlugin").unwrap_or(&Value::Null);
    let agents = raw.get("agents").unwrap_or(&Value::Null);
    let sessions = raw.get("sessions").unwrap_or(&Value::Null);
    let gw_runtime = gw_service.get("runtime").unwrap_or(&Value::Null);
    let node_runtime = node_service.get("runtime").unwrap_or(&Value::Null);
    let registry = update.get("registry").unwrap_or(&Value::Null);

    Ok(DashboardStatus {
        runtime_version: s(raw, "runtimeVersion", ""),
        os: OsInfo { platform: s(os, "platform", ""), arch: s(os, "arch", ""), release: s(os, "release", ""), label: s(os, "label", "") },
        gateway: GatewayInfo { mode: s(gateway, "mode", ""), url: s(gateway, "url", ""), reachable: b(gateway, "reachable", false), connect_latency_ms: gateway.get("connectLatencyMs").and_then(|v| v.as_i64()), error: gateway.get("error").and_then(|v| v.as_str()).map(String::from) },
        gateway_service: GatewayService { installed: b(gw_service, "installed", false), loaded: b(gw_service, "loaded", false), status: s(gw_runtime, "status", "unknown"), state: s(gw_runtime, "state", "unknown"), pid: gw_runtime.get("pid").and_then(|v| v.as_i64()), runtime_short: s(gw_service, "runtimeShort", "") },
        node_service: NodeService { installed: b(node_service, "installed", false), loaded: b(node_service, "loaded", false), status: s(node_runtime, "status", "unknown"), state: s(node_runtime, "state", "unknown"), runtime_short: s(node_service, "runtimeShort", "") },
        update: UpdateInfo { available: registry.get("latestVersion").and_then(|v| v.as_str()).map(|v| !v.is_empty()).unwrap_or(false), latest_version: s(registry, "latestVersion", ""), channel: s(raw, "updateChannel", "stable"), install_kind: s(update, "installKind", ""), package_manager: s(update, "packageManager", "") },
        memory: MemoryInfo { enabled: b(mem_plugin, "enabled", false), slot: s(mem_plugin, "slot", "") },
        agents_total: agents.get("agents").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
        sessions_total: u(sessions, "count", 0),
        default_agent_id: s(agents, "defaultId", "main"),
        bootstrap_pending_count: u(agents, "bootstrapPendingCount", 0),
        model_defaults: sessions.get("defaults").cloned().unwrap_or(Value::Null),
    })
}

pub fn parse_agents(raw: &Value) -> Vec<AgentSummary> {
    let agents_array = raw.get("agents").and_then(|a| a.get("agents")).and_then(|a| a.as_array());
    match agents_array {
        Some(arr) => arr.iter().map(|item| AgentSummary {
            id: s(item, "id", ""), name: s(item, "name", s(item, "id", "")),
            workspace_dir: s(item, "workspaceDir", ""), sessions_count: u(item, "sessionsCount", 0),
            last_updated_at: item.get("lastUpdatedAt").and_then(|v| v.as_i64()).unwrap_or(0),
            last_active_age_ms: item.get("lastActiveAgeMs").and_then(|v| v.as_i64()).unwrap_or(0),
            bootstrap_pending: b(item, "bootstrapPending", false),
        }).collect(),
        None => vec![],
    }
}

pub fn parse_session_item(item: &Value) -> SessionSummary {
    let percent_used = if let (Some(used), Some(total)) = (item.get("totalTokens").and_then(|v| v.as_u64()), item.get("contextTokens").and_then(|v| v.as_u64())) {
        if total > 0 { Some((used as f64 / total as f64) * 100.0) } else { None }
    } else { None };

    let flags: Vec<String> = item.get("flags").and_then(|f| f.as_array()).map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();

    SessionSummary {
        key: s(item, "key", ""), agent_id: s(item, "agentId", ""), session_id: s(item, "sessionId", ""),
        kind: s(item, "kind", "direct"), updated_at: item.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0),
        age_ms: item.get("ageMs").and_then(|v| v.as_i64()).unwrap_or(0), model: s(item, "model", "unknown"),
        model_provider: s(item, "modelProvider", ""), thinking_level: s(item, "thinkingLevel", ""),
        input_tokens: item.get("inputTokens").and_then(|v| v.as_u64()), output_tokens: item.get("outputTokens").and_then(|v| v.as_u64()),
        total_tokens: item.get("totalTokens").and_then(|v| v.as_u64()), context_tokens: item.get("contextTokens").and_then(|v| v.as_u64()),
        percent_used, remaining_tokens: item.get("remainingTokens").and_then(|v| v.as_u64()),
        total_tokens_fresh: b(item, "totalTokensFresh", false), system_sent: b(item, "systemSent", false),
        aborted_last_run: b(item, "abortedLastRun", false), flags,
    }
}

pub fn parse_sessions_from_list(raw: &Value) -> Vec<SessionSummary> {
    let sessions_array = raw.get("sessions").and_then(|s| s.as_array());
    match sessions_array { Some(arr) => arr.iter().map(parse_session_item).collect(), None => vec![] }
}

pub fn parse_cron_jobs(raw: &Value) -> Vec<CronJob> {
    let jobs_array = raw.get("jobs").and_then(|j| j.as_array());
    match jobs_array {
        Some(arr) => arr.iter().map(|item| {
            let schedule = item.get("schedule").unwrap_or(&Value::Null);
            let state = item.get("state").unwrap_or(&Value::Null);
            let payload = item.get("payload").unwrap_or(&Value::Null);
            let delivery = item.get("delivery").unwrap_or(&Value::Null);
            CronJob {
                id: s(item, "id", ""), agent_id: s(item, "agentId", ""), name: s(item, "name", ""),
                description: s(item, "description", ""), enabled: b(item, "enabled", true),
                created_at_ms: item.get("createdAtMs").and_then(|v| v.as_i64()).unwrap_or(0),
                updated_at_ms: item.get("updatedAtMs").and_then(|v| v.as_i64()).unwrap_or(0),
                schedule: CronSchedule { kind: s(schedule, "kind", ""), expr: s(schedule, "expr", "") },
                session_target: s(item, "sessionTarget", ""), wake_mode: s(item, "wakeMode", ""),
                payload_kind: s(payload, "kind", ""),
                delivery_mode: s(delivery, "mode", ""),
                delivery_channel: delivery.get("channel").and_then(|v| v.as_str()).map(String::from),
                state: CronState {
                    next_run_at_ms: state.get("nextRunAtMs").and_then(|v| v.as_i64()),
                    last_run_at_ms: state.get("lastRunAtMs").and_then(|v| v.as_i64()),
                    last_run_status: state.get("lastRunStatus").and_then(|v| v.as_str()).map(String::from),
                    last_status: state.get("lastStatus").and_then(|v| v.as_str()).map(String::from),
                    last_duration_ms: state.get("lastDurationMs").and_then(|v| v.as_i64()),
                    last_delivery_status: state.get("lastDeliveryStatus").and_then(|v| v.as_str()).map(String::from),
                    consecutive_errors: state.get("consecutiveErrors").and_then(|v| v.as_i64()).unwrap_or(0),
                    consecutive_skipped: state.get("consecutiveSkipped").and_then(|v| v.as_i64()).unwrap_or(0),
                    last_delivered: state.get("lastDelivered").and_then(|v| v.as_bool()),
                    last_error: state.get("lastError").and_then(|v| v.as_str()).map(String::from),
                    last_error_reason: state.get("lastErrorReason").and_then(|v| v.as_str()).map(String::from),
                },
            }
        }).collect(),
        None => vec![],
    }
}

pub fn parse_skills(raw: &Value) -> Result<SkillsList, String> {
    let skills_array = raw.get("skills").and_then(|s| s.as_array());
    let skills = match skills_array {
        Some(arr) => arr.iter().map(|item| {
            let missing = item.get("missing").unwrap_or(&Value::Null);
            SkillInfo {
                name: s(item, "name", ""), description: s(item, "description", ""), emoji: s(item, "emoji", ""),
                eligible: b(item, "eligible", false), disabled: b(item, "disabled", false),
                blocked_by_allowlist: b(item, "blockedByAllowlist", false), source: s(item, "source", ""),
                bundled: b(item, "bundled", false), homepage: item.get("homepage").and_then(|v| v.as_str()).map(String::from),
                missing: SkillMissing {
                    bins: missing.get("bins").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default(),
                    env: missing.get("env").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default(),
                    config: missing.get("config").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default(),
                    os: missing.get("os").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default(),
                },
            }
        }).collect(),
        None => vec![],
    };
    Ok(SkillsList { workspace_dir: s(raw, "workspaceDir", ""), managed_skills_dir: s(raw, "managedSkillsDir", ""), skills })
}

pub fn parse_plugins(raw: &Value) -> Vec<PluginInfo> {
    let plugins_array = raw.get("plugins").and_then(|p| p.as_array());
    match plugins_array {
        Some(arr) => arr.iter().map(|item| PluginInfo {
            id: s(item, "id", ""), name: s(item, "name", s(item, "id", "")), version: s(item, "version", ""),
            description: s(item, "description", ""), enabled: b(item, "enabled", false),
            status: s(item, "status", "unknown"), origin: s(item, "origin", ""), format: s(item, "format", ""),
        }).collect(),
        None => vec![],
    }
}

pub fn parse_models(raw: &Value) -> Vec<ModelInfo> {
    let models_array = raw.get("models").and_then(|m| m.as_array());
    match models_array {
        Some(arr) => arr.iter().map(|item| ModelInfo {
            key: s(item, "key", ""), name: s(item, "name", ""), input: s(item, "input", "text"),
            context_window: u(item, "contextWindow", 0), local: b(item, "local", false),
            available: b(item, "available", false),
            tags: item.get("tags").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default(),
            missing: b(item, "missing", false),
        }).collect(),
        None => vec![],
    }
}

pub fn parse_hooks(raw: &Value) -> Vec<HookInfo> {
    let hooks_array = raw.get("hooks").and_then(|h| h.as_array());
    match hooks_array {
        Some(arr) => arr.iter().map(|item| HookInfo {
            name: s(item, "name", ""), description: s(item, "description", ""), emoji: s(item, "emoji", ""),
            eligible: b(item, "eligible", false), disabled: b(item, "disabled", false),
            enabled_by_config: b(item, "enabledByConfig", false), requirements_satisfied: b(item, "requirementsSatisfied", false),
            loadable: b(item, "loadable", false), source: s(item, "source", ""),
            events: item.get("events").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default(),
            homepage: item.get("homepage").and_then(|v| v.as_str()).map(String::from),
            missing_bins: item.get("missing").and_then(|m| m.get("bins")).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default(),
            managed_by_plugin: b(item, "managedByPlugin", false),
        }).collect(),
        None => vec![],
    }
}

pub fn parse_commitments(raw: &Value) -> Vec<CommitmentInfo> {
    let items = raw.get("commitments").and_then(|c| c.as_array());
    match items {
        Some(items) => items
            .iter()
            .filter_map(|item| {
                Some(CommitmentInfo {
                    id: item.get("id").and_then(|v| v.as_str())?.to_string(),
                    title: item.get("title").and_then(|v| v.as_str())?.to_string(),
                    description: item.get("description").and_then(|v| v.as_str()).map(String::from),
                    status: item.get("status").and_then(|v| v.as_str()).unwrap_or("pending").to_string(),
                    due_date: item.get("dueDate").and_then(|v| v.as_str()).map(String::from),
                    completed: item.get("completed").and_then(|v| v.as_bool()).unwrap_or(false),
                })
            })
            .collect(),
        None => vec![],
    }
}