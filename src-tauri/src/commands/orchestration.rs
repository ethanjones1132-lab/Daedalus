use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

use crate::jarvis::types::JarvisConfig;

const OPERATION_ID_MAX_BYTES: usize = 128;
const ROUTE_TEST_STAGES: &[&str] = &[
    "coordinator",
    "planner",
    "executor",
    "reviewer",
    "rewriter",
    "synthesizer",
];
const STAGE_TARGET_PROVIDERS: &[&str] = &[
    "llama_cpp",
    "ollama",
    "openrouter",
    "opencode_zen",
    "opencode_go",
    "vllm",
];
const DEFAULT_LLAMA_MODEL: &str = "Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf";
const DEFAULT_LLAMA_BASE_URL: &str = "http://127.0.0.1:8080/v1";
const DEFAULT_OLLAMA_MODEL: &str = "qwen3.5-9b:latest";
const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434/v1";
const DEFAULT_OPENROUTER_MODEL: &str = "cohere/north-mini-code:free";
const DEFAULT_OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const DEFAULT_ZEN_BASE_URL: &str = "https://opencode.ai/zen/v1";
const DEFAULT_GO_BASE_URL: &str = "https://opencode.ai/zen/go/v1";

fn config_extra_value<'a>(config: &'a JarvisConfig, key: &str) -> Option<&'a Value> {
    config.orchestrator.extra.get(key)
}

fn object_field<'a>(value: Option<&'a Value>, field: &str) -> Option<&'a Value> {
    value
        .and_then(Value::as_object)
        .and_then(|object| object.get(field))
}

fn string_field(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn bool_field(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

fn validate_stage_keys(value: &Value) -> Result<&Map<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "invalid routing stage map".to_string())?;
    if object
        .keys()
        .any(|key| !ROUTE_TEST_STAGES.contains(&key.as_str()))
    {
        return Err("invalid routing stage map".to_string());
    }
    Ok(object)
}

fn normalized_target(value: &Value, llama_alias: &str) -> Result<Value, String> {
    let target = value
        .as_object()
        .ok_or_else(|| "invalid routing target".to_string())?;
    let provider = target.get("provider").and_then(Value::as_str).unwrap_or("");
    let model = target.get("model").and_then(Value::as_str).unwrap_or("");
    if !STAGE_TARGET_PROVIDERS.contains(&provider) || model.trim().is_empty() || model.len() > 512 {
        return Err("invalid routing target".to_string());
    }
    if provider == "llama_cpp" && model != llama_alias {
        return Err("invalid llama.cpp routing alias".to_string());
    }
    Ok(serde_json::json!({ "provider": provider, "model": model }))
}

/// Validate the Native projection of the Bun-owned route fields before save.
pub fn validate_routing_config(config: &JarvisConfig) -> Result<(), String> {
    let llama_alias = config.llama_cpp.model.as_str();
    if let Some(value) = config_extra_value(config, "stage_models") {
        for route in validate_stage_keys(value)?.values() {
            if route.as_str() == Some("automatic") {
                continue;
            }
            normalized_target(route, llama_alias)?;
        }
    }
    if let Some(value) = config_extra_value(config, "fallback_chains") {
        for chain in validate_stage_keys(value)?.values() {
            if chain.as_str() == Some("automatic") {
                continue;
            }
            let targets = chain
                .as_array()
                .ok_or_else(|| "invalid routing fallback chain".to_string())?;
            if targets.len() > 8 {
                return Err("invalid routing fallback chain".to_string());
            }
            for target in targets {
                normalized_target(target, llama_alias)?;
            }
        }
    }
    Ok(())
}

fn descriptor_stage_routes(config: &JarvisConfig) -> Result<(Value, Value), String> {
    validate_routing_config(config)?;
    let llama_alias = config.llama_cpp.model.as_str();
    let configured_primary = config_extra_value(config, "stage_models").and_then(Value::as_object);
    let configured_fallbacks =
        config_extra_value(config, "fallback_chains").and_then(Value::as_object);
    let mut primaries = Map::new();
    let mut fallbacks = Map::new();
    for stage in ROUTE_TEST_STAGES {
        let primary = configured_primary.and_then(|map| map.get(*stage));
        primaries.insert(
            (*stage).to_string(),
            match primary {
                None => Value::String("automatic".to_string()),
                Some(value) if value.as_str() == Some("automatic") => {
                    Value::String("automatic".to_string())
                }
                Some(value) => normalized_target(value, llama_alias)?,
            },
        );
        let chain = configured_fallbacks.and_then(|map| map.get(*stage));
        fallbacks.insert(
            (*stage).to_string(),
            match chain {
                None => Value::String("automatic".to_string()),
                Some(value) if value.as_str() == Some("automatic") => {
                    Value::String("automatic".to_string())
                }
                Some(value) => Value::Array(
                    value
                        .as_array()
                        .ok_or_else(|| "invalid routing fallback chain".to_string())?
                        .iter()
                        .map(|target| normalized_target(target, llama_alias))
                        .collect::<Result<Vec<_>, _>>()?,
                ),
            },
        );
    }
    Ok((Value::Object(primaries), Value::Object(fallbacks)))
}

fn valid_vllm_endpoint(
    config: &crate::jarvis::types::VllmConfig,
    env: &HashMap<String, String>,
) -> bool {
    if !config.enabled || config.model.trim().is_empty() || config.base_url.trim().is_empty() {
        return false;
    }
    let env_name = config.api_key_env.trim();
    if !env_name.is_empty() {
        let valid_name = env_name.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit())
                || (index == 0 && byte == b'_')
                || (index > 0 && byte == b'_')
        });
        if !valid_name
            || env
                .get(env_name)
                .map(|value| value.trim().is_empty())
                .unwrap_or(true)
        {
            return false;
        }
    }
    let Ok(url) = reqwest::Url::parse(config.base_url.trim().trim_end_matches('/')) else {
        return false;
    };
    (url.scheme() == "http" || url.scheme() == "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn credential_ready(configured: &str, env: &HashMap<String, String>, names: &[&str]) -> bool {
    configured.trim().len() >= 10
        || names.iter().any(|name| {
            env.get(*name)
                .map(|value| value.trim().len() >= 10)
                .unwrap_or(false)
        })
}

/// Build the secret-free descriptor used by both Bun reload acknowledgement
/// and Native readback comparison.
pub fn routing_descriptor(
    config: &JarvisConfig,
    env: &HashMap<String, String>,
) -> Result<Value, String> {
    let (stage_models, fallback_chains) = descriptor_stage_routes(config)?;
    let conductor = config_extra_value(config, "conductor");
    let llama_base_url = if config.llama_cpp.base_url.trim().is_empty() {
        DEFAULT_LLAMA_BASE_URL
    } else {
        config.llama_cpp.base_url.as_str()
    };
    let openrouter_ready = credential_ready(
        &config.openrouter.api_key,
        env,
        &["OPENROUTER_API_KEY", "OPENROUTER_KEY"],
    );
    let zen_ready = credential_ready(
        &config.opencode_zen.api_key,
        env,
        &[
            "OPENCODE_ZEN_API_KEY",
            "OPENCODE_ZEN_KEY",
            "OPENCODE_API_KEY",
            "OPENCODE_KEY",
        ],
    );
    let go_ready = credential_ready(
        &config.opencode_go.api_key,
        env,
        &[
            "OPENCODE_GO_API_KEY",
            "OPENCODE_GO_KEY",
            "OPENCODE_API_KEY",
            "OPENCODE_KEY",
        ],
    );
    let descriptor = serde_json::json!({
        "descriptor_version": 1,
        "backend": config.active_backend.to_string(),
        "enabled": config.orchestrator.enabled,
        "allow_cloud_helpers": bool_field(config_extra_value(config, "allow_cloud_helpers"), false),
        "providers": {
            "ollama": {
                "base_url": if config.ollama.base_url.trim().is_empty() { DEFAULT_OLLAMA_BASE_URL } else { config.ollama.base_url.as_str() },
                "model": if config.ollama.model.trim().is_empty() { DEFAULT_OLLAMA_MODEL } else { config.ollama.model.as_str() },
            },
            "llama_cpp": {
                "base_url": llama_base_url,
                "model": if config.llama_cpp.model.trim().is_empty() { DEFAULT_LLAMA_MODEL } else { config.llama_cpp.model.as_str() },
            },
            "openrouter": {
                "base_url": if config.openrouter.base_url.trim().is_empty() { DEFAULT_OPENROUTER_BASE_URL } else { config.openrouter.base_url.as_str() },
                "model": if config.openrouter.model.trim().is_empty() { DEFAULT_OPENROUTER_MODEL } else { config.openrouter.model.as_str() },
            },
            "opencode_zen": { "base_url": if config.opencode_zen.base_url.trim().is_empty() { DEFAULT_ZEN_BASE_URL } else { config.opencode_zen.base_url.as_str() } },
            "opencode_go": { "base_url": if config.opencode_go.base_url.trim().is_empty() { DEFAULT_GO_BASE_URL } else { config.opencode_go.base_url.as_str() } },
            "vllm": {
                "enabled": config.vllm.enabled,
                "base_url": config.vllm.base_url,
                "model": config.vllm.model,
            },
        },
        "stage_models": stage_models,
        "fallback_chains": fallback_chains,
        "conductor": {
            "enabled": bool_field(object_field(conductor, "enabled"), true),
            "model": string_field(object_field(conductor, "model"), DEFAULT_LLAMA_MODEL),
            "fallback_model": string_field(object_field(conductor, "fallback_model"), ""),
            "base_url": string_field(object_field(conductor, "base_url"), llama_base_url),
            "kv_backend": string_field(object_field(conductor, "kv_backend"), "llama_cpp"),
            "fallback_to_api": bool_field(object_field(conductor, "fallback_to_api"), true),
        },
        "provider_readiness": {
            "ollama": true,
            "llama_cpp": !config.llama_cpp.base_url.trim().is_empty() && !config.llama_cpp.model.trim().is_empty(),
            "openrouter": openrouter_ready,
            "opencode_zen": zen_ready,
            "opencode_go": go_ready,
            "vllm": valid_vllm_endpoint(&config.vllm, env),
        },
    });
    Ok(descriptor)
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let sorted: BTreeMap<_, _> = object.iter().collect();
            let fields = sorted
                .into_iter()
                .map(|(key, nested)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical_json(nested)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{fields}}}")
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

pub fn routing_descriptor_fingerprint(
    config: &JarvisConfig,
    env: &HashMap<String, String>,
) -> Result<(Value, String), String> {
    let descriptor = routing_descriptor(config, env)?;
    let digest = Sha256::digest(canonical_json(&descriptor).as_bytes());
    let fingerprint = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((descriptor, fingerprint))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrationRouteTestStatus {
    Success,
    Failed,
    Cancelled,
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestrationRouteAttempt {
    pub stage: String,
    pub provider: String,
    pub model: String,
    pub choice: String,
    pub outcome: String,
    pub answered: bool,
    pub cloud: bool,
    pub duration_ms: u64,
    #[serde(default)]
    pub first_token_ms: Option<u64>,
    #[serde(default)]
    pub fallback_reason: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestrationRouteRejectedCandidate {
    pub stage: String,
    pub provider: String,
    pub model: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestrationRouteAnsweredBy {
    pub stage: String,
    pub provider: String,
    pub model: String,
    pub cloud: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestrationRouteTestResult {
    pub operation_id: String,
    pub stage: String,
    pub status: OrchestrationRouteTestStatus,
    #[serde(default)]
    pub attempts: Vec<OrchestrationRouteAttempt>,
    #[serde(default)]
    pub rejected_candidates: Vec<OrchestrationRouteRejectedCandidate>,
    #[serde(default)]
    pub answered_by: Option<OrchestrationRouteAnsweredBy>,
    pub left_machine: bool,
    pub duration_ms: u64,
    #[serde(default)]
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestrationRouteCancelResult {
    pub operation_id: String,
    pub cancelled: bool,
}

pub fn valid_route_test_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= OPERATION_ID_MAX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

pub fn valid_route_test_stage(value: &str) -> bool {
    ROUTE_TEST_STAGES.contains(&value)
}

fn unavailable_result(
    operation_id: String,
    stage: String,
    reason: &str,
) -> OrchestrationRouteTestResult {
    OrchestrationRouteTestResult {
        operation_id,
        stage,
        status: OrchestrationRouteTestStatus::Failed,
        attempts: Vec::new(),
        rejected_candidates: Vec::new(),
        answered_by: None,
        left_machine: false,
        duration_ms: 0,
        reason_code: Some(reason.to_string()),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn jarvis_test_orchestration_route(
    operation_id: String,
    stage: String,
    config: Value,
) -> Result<OrchestrationRouteTestResult, String> {
    if !valid_route_test_operation_id(&operation_id) {
        return Err("invalid orchestration route test operation id".to_string());
    }
    if !valid_route_test_stage(&stage) {
        return Err("invalid orchestration route test stage".to_string());
    }
    let operation_for_error = operation_id.clone();
    let stage_for_error = stage.clone();
    let request = crate::jarvis::memory::transport::OrchestrationRouteTestRequest {
        operation_id,
        stage,
        config,
    };
    match tauri::async_runtime::spawn_blocking(move || {
        crate::jarvis::memory::transport::execute_orchestration_route_test(
            crate::jarvis::memory::transport::native_memory_transport(),
            &request,
        )
    })
    .await
    {
        Ok(Ok(Some(result))) => Ok(result),
        Ok(Ok(None)) => Ok(unavailable_result(
            operation_for_error,
            stage_for_error,
            "owned_runtime_unavailable",
        )),
        Ok(Err(_)) => Ok(unavailable_result(
            operation_for_error,
            stage_for_error,
            "route_test_transport_unavailable",
        )),
        Err(_) => Ok(unavailable_result(
            operation_for_error,
            stage_for_error,
            "route_test_transport_unavailable",
        )),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn jarvis_cancel_orchestration_route_test(
    operation_id: String,
) -> Result<OrchestrationRouteCancelResult, String> {
    if !valid_route_test_operation_id(&operation_id) {
        return Err("invalid orchestration route test operation id".to_string());
    }
    let operation_for_error = operation_id.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        crate::jarvis::memory::transport::cancel_orchestration_route_test(
            crate::jarvis::memory::transport::native_memory_transport(),
            &operation_id,
        )
    })
    .await
    {
        Ok(Ok(Some(result))) => Ok(result),
        Ok(Ok(None)) | Ok(Err(_)) | Err(_) => Ok(OrchestrationRouteCancelResult {
            operation_id: operation_for_error,
            cancelled: false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jarvis::types::JarvisConfig;

    #[test]
    fn orchestration_route_command_rejects_invalid_identity_and_stage() {
        assert!(valid_route_test_operation_id("probe-123"));
        assert!(!valid_route_test_operation_id(""));
        assert!(!valid_route_test_operation_id("probe/../../secret"));
        assert!(!valid_route_test_operation_id(
            &"x".repeat(OPERATION_ID_MAX_BYTES + 1)
        ));
        assert!(valid_route_test_stage("executor"));
        assert!(!valid_route_test_stage("agent_loop"));
    }

    #[test]
    fn orchestration_route_status_wire_is_snake_case() {
        let encoded = serde_json::to_string(&OrchestrationRouteTestStatus::Timeout).unwrap();
        assert_eq!(encoded, "\"timeout\"");
    }

    fn merge_json(target: &mut Value, source: &Value) {
        match (target, source) {
            (Value::Object(target), Value::Object(source)) => {
                for (key, value) in source {
                    merge_json(target.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
            (target, source) => *target = source.clone(),
        }
    }

    #[test]
    fn shared_routing_descriptor_fixture_matches_fingerprint() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../docs/orchestration/fixtures/routing-descriptor.json"
        ))
        .unwrap();
        let mut raw = serde_json::to_value(JarvisConfig::default()).unwrap();
        merge_json(&mut raw, &fixture["config"]);
        let mut config: JarvisConfig = serde_json::from_value(raw).unwrap();
        config.openrouter.api_key = "fixture-openrouter-secret".to_string();
        config.opencode_zen.api_key = "fixture-opencode-zen-secret".to_string();
        config.opencode_go.api_key = "fixture-opencode-go-secret".to_string();
        let env = std::collections::HashMap::new();

        let (descriptor, fingerprint) =
            routing_descriptor_fingerprint(&config, &env).expect("descriptor is valid");

        assert_eq!(descriptor, fixture["expected_descriptor"]);
        assert_eq!(fingerprint, fixture["expected_sha256"]);
        let encoded = serde_json::to_string(&descriptor).unwrap();
        assert!(!encoded.contains("fixture-openrouter-secret"));
        assert!(!encoded.contains("fixture-opencode-zen-secret"));
        assert!(!encoded.contains("fixture-opencode-go-secret"));
    }

    #[test]
    fn omitted_route_defaults_match_explicit_defaults_and_array_order_is_significant() {
        let defaults = JarvisConfig::default();
        let mut explicit = defaults.clone();
        explicit
            .orchestrator
            .extra
            .insert("allow_cloud_helpers".to_string(), Value::Bool(false));
        for stage in [
            "coordinator",
            "planner",
            "executor",
            "reviewer",
            "rewriter",
            "synthesizer",
        ] {
            explicit.orchestrator.extra.insert(
                "stage_models".to_string(),
                explicit
                    .orchestrator
                    .extra
                    .get("stage_models")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            );
            explicit.orchestrator.extra.insert(
                "fallback_chains".to_string(),
                explicit
                    .orchestrator
                    .extra
                    .get("fallback_chains")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            );
            if let Some(Value::Object(stages)) = explicit.orchestrator.extra.get_mut("stage_models")
            {
                stages.insert(stage.to_string(), Value::String("automatic".to_string()));
            }
            if let Some(Value::Object(stages)) =
                explicit.orchestrator.extra.get_mut("fallback_chains")
            {
                stages.insert(stage.to_string(), Value::String("automatic".to_string()));
            }
        }
        let env = std::collections::HashMap::new();

        assert_eq!(
            routing_descriptor_fingerprint(&defaults, &env).unwrap().1,
            routing_descriptor_fingerprint(&explicit, &env).unwrap().1
        );
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../docs/orchestration/fixtures/routing-descriptor.json"
        ))
        .unwrap();
        let (default_descriptor, default_fingerprint) =
            routing_descriptor_fingerprint(&defaults, &env).unwrap();
        assert_eq!(default_descriptor, fixture["expected_default_descriptor"]);
        assert_eq!(default_fingerprint, fixture["expected_default_sha256"]);

        let mut ordered = defaults.clone();
        ordered.orchestrator.extra.insert(
            "fallback_chains".to_string(),
            serde_json::json!({
                "planner": [
                    { "provider": "ollama", "model": "local/a" },
                    { "provider": "ollama", "model": "local/b" }
                ]
            }),
        );
        let mut reversed = ordered.clone();
        reversed.orchestrator.extra.insert(
            "fallback_chains".to_string(),
            serde_json::json!({
                "planner": [
                    { "provider": "ollama", "model": "local/b" },
                    { "provider": "ollama", "model": "local/a" }
                ]
            }),
        );
        assert_ne!(
            routing_descriptor_fingerprint(&ordered, &env).unwrap().1,
            routing_descriptor_fingerprint(&reversed, &env).unwrap().1
        );
    }
}
