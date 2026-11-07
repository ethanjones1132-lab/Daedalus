use serde::{Deserialize, Serialize};
use serde_json::Value;

const OPERATION_ID_MAX_BYTES: usize = 128;
const ROUTE_TEST_STAGES: &[&str] = &[
    "coordinator",
    "planner",
    "executor",
    "reviewer",
    "rewriter",
    "synthesizer",
];

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
}
