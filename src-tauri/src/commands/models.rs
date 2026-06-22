// ═══════════════════════════════════════════════════════════════
// Model Manager Commands — SQLite-backed model profile CRUD +
// Ollama / OpenRouter discovery + model import
// ═══════════════════════════════════════════════════════════════

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::AppDb;

// ── Structs ─────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub api_base: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: i64,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default = "default_top_p")]
    pub top_p: f64,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub is_active: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// Inference engine: "native" (Jarvis runtime) or "claude_cli" (Claude Code harness).
    #[serde(default = "default_engine")]
    pub engine: String,
}

fn default_engine() -> String {
    "native".to_string()
}
fn default_max_tokens() -> i64 {
    4096
}
fn default_temperature() -> f64 {
    0.7
}
fn default_top_p() -> f64 {
    1.0
}

fn parse_price(value: &str) -> Option<f64> {
    value.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn discovered_model_bucket(model: &DiscoveredModel) -> i32 {
    if model.is_free {
        0
    } else if model.is_router {
        1
    } else {
        2
    }
}

fn sort_discovered_models(models: &mut [DiscoveredModel]) {
    models.sort_by(|a, b| {
        discovered_model_bucket(a)
            .cmp(&discovered_model_bucket(b))
            .then_with(|| b.context_length.cmp(&a.context_length))
            .then_with(|| a.id.cmp(&b.id))
    });
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiscoveredModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub size_bytes: i64,
    #[serde(default)]
    pub context_length: i64,
    #[serde(default)]
    pub max_completion_tokens: i64,
    #[serde(default)]
    pub already_installed: bool,
    #[serde(default)]
    pub pricing_prompt: String,
    #[serde(default)]
    pub pricing_completion: String,
    #[serde(default)]
    pub is_free: bool,
    #[serde(default)]
    pub is_router: bool,
    #[serde(default)]
    pub modality: String,
    #[serde(default)]
    pub supported_parameters: Vec<String>,
    #[serde(default)]
    pub default_temperature: Option<f64>,
    #[serde(default)]
    pub default_top_p: Option<f64>,
}

// ── Commands ─────────────────────────────────────────────────────

/// List all model profiles from the database
#[tauri::command]
pub async fn list_model_profiles(db: State<'_, AppDb>) -> Result<Vec<ModelProfile>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT id, name, provider, model, api_base, api_key, max_tokens,
                    temperature, top_p, system_prompt, is_active, created_at, updated_at, engine
             FROM model_profiles
             ORDER BY name ASC",
        )
        .map_err(|e| format!("DB prepare error: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ModelProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                provider: row.get(2)?,
                model: row.get(3)?,
                api_base: row.get(4)?,
                api_key: row.get(5)?,
                max_tokens: row.get(6)?,
                temperature: row.get(7)?,
                top_p: row.get(8)?,
                system_prompt: row.get(9)?,
                is_active: {
                    let val: i64 = row.get(10)?;
                    val != 0
                },
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
                engine: row.get(13)?,
            })
        })
        .map_err(|e| format!("DB query error: {}", e))?;

    let mut profiles = Vec::new();
    for row in rows {
        profiles.push(row.map_err(|e| format!("Row error: {}", e))?);
    }
    Ok(profiles)
}

/// Get the currently active model profile (WHERE is_active = 1)
#[tauri::command]
pub async fn get_active_profile(db: State<'_, AppDb>) -> Result<Option<ModelProfile>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT id, name, provider, model, api_base, api_key, max_tokens,
                    temperature, top_p, system_prompt, is_active, created_at, updated_at, engine
             FROM model_profiles
             WHERE is_active = 1
             LIMIT 1",
        )
        .map_err(|e| format!("DB prepare error: {}", e))?;

    let result = stmt
        .query_row([], |row| {
            Ok(ModelProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                provider: row.get(2)?,
                model: row.get(3)?,
                api_base: row.get(4)?,
                api_key: row.get(5)?,
                max_tokens: row.get(6)?,
                temperature: row.get(7)?,
                top_p: row.get(8)?,
                system_prompt: row.get(9)?,
                is_active: {
                    let val: i64 = row.get(10)?;
                    val != 0
                },
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
                engine: row.get(13)?,
            })
        })
        .optional()
        .map_err(|e| format!("DB query error: {}", e))?;

    Ok(result)
}

/// Set a profile as active: first clears all is_active, then sets the given one
#[tauri::command]
pub async fn set_active_profile(db: State<'_, AppDb>, id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    // Clear all active flags
    conn.execute("UPDATE model_profiles SET is_active = 0", [])
        .map_err(|e| format!("DB update error: {}", e))?;
    // Set the chosen one
    let rows = conn
        .execute(
            "UPDATE model_profiles SET is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
            [&id],
        )
        .map_err(|e| format!("DB update error: {}", e))?;
    Ok(rows > 0)
}

/// Create a new model profile
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_profile(
    db: State<'_, AppDb>,
    name: String,
    backend: String,
    model: String,
    temperature: f64,
    max_tokens: i64,
    top_p: f64,
    engine: Option<String>,
) -> Result<ModelProfile, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let engine = engine.unwrap_or_else(|| "native".to_string());

    // Determine api_base from backend
    let api_base = match backend.as_str() {
        "ollama" => "http://localhost:11434/v1".to_string(),
        "openrouter" => "https://openrouter.ai/api/v1".to_string(),
        _ => String::new(),
    };

    conn.execute(
        "INSERT INTO model_profiles (id, name, provider, model, api_base, max_tokens, temperature, top_p, engine, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        [&id, &name, &backend, &model, &api_base, &max_tokens.to_string(), &temperature.to_string(), &top_p.to_string(), &engine, &now],
    )
    .map_err(|e| format!("DB insert error: {}", e))?;

    Ok(ModelProfile {
        id,
        name,
        provider: backend,
        model,
        api_base,
        api_key: String::new(),
        max_tokens,
        temperature,
        top_p,
        system_prompt: String::new(),
        is_active: false,
        created_at: now.clone(),
        updated_at: now,
        engine,
    })
}

/// Delete a model profile by id
#[tauri::command]
pub async fn delete_profile(db: State<'_, AppDb>, id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let rows = conn
        .execute("DELETE FROM model_profiles WHERE id = ?1", [&id])
        .map_err(|e| format!("DB delete error: {}", e))?;
    Ok(rows > 0)
}

/// Discover models from a running Ollama instance via HTTP GET /api/tags
#[tauri::command]
pub async fn discover_models_ollama(
    base_url: Option<String>,
) -> Result<Vec<DiscoveredModel>, String> {
    let ollama_url = base_url
        .filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("OLLAMA_BASE_URL").ok())
        .unwrap_or_else(|| "http://localhost:11434".to_string())
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .get(format!("{}/api/tags", ollama_url))
        .send()
        .await
        .map_err(|e| format!("Ollama API error: {}. Is Ollama running?", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {}", e))?;

    let mut models: Vec<DiscoveredModel> = json
        .get("models")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let name = v.get("name")?.as_str()?.to_string();
                    let size = v.get("size").and_then(|s| s.as_i64()).unwrap_or(0);
                    Some(DiscoveredModel {
                        id: name.clone(),
                        name,
                        provider: "ollama".to_string(),
                        description: String::new(),
                        size_bytes: size,
                        context_length: 0,
                        max_completion_tokens: 0,
                        already_installed: true,
                        pricing_prompt: String::new(),
                        pricing_completion: String::new(),
                        is_free: true,
                        is_router: false,
                        modality: "text".to_string(),
                        supported_parameters: Vec::new(),
                        default_temperature: None,
                        default_top_p: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    sort_discovered_models(&mut models);
    Ok(models)
}

/// Discover models from OpenRouter via HTTP GET /v1/models
#[tauri::command]
pub async fn discover_models_openrouter(api_key: String) -> Result<Vec<DiscoveredModel>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut req = client
        .get("https://openrouter.ai/api/v1/models")
        .header("HTTP-Referer", "http://localhost:19877")
        .header("X-Title", "Jarvis Home-Base");
    if !api_key.trim().is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("OpenRouter API error: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {}", e))?;

    let mut models: Vec<DiscoveredModel> = json
        .get("data")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let id = v.get("id")?.as_str()?.to_string();
                    let name = v
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let pricing_prompt = v
                        .get("pricing")
                        .and_then(|p| p.get("prompt"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let pricing_completion = v
                        .get("pricing")
                        .and_then(|p| p.get("completion"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string();
                    let is_free = id == "openrouter/free"
                        || id.ends_with(":free")
                        || (parse_price(&pricing_prompt) == Some(0.0)
                            && parse_price(&pricing_completion) == Some(0.0));
                    let tokenizer_is_router = v
                        .get("architecture")
                        .and_then(|a| a.get("tokenizer"))
                        .and_then(|t| t.as_str())
                        .map(|t| t == "Router")
                        .unwrap_or(false);
                    let is_router =
                        id == "openrouter/free" || id == "openrouter/fusion" || tokenizer_is_router;
                    let modality = v
                        .get("architecture")
                        .and_then(|a| a.get("modality"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("text")
                        .to_string();
                    let supported_parameters = v
                        .get("supported_parameters")
                        .and_then(|p| p.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|item| item.as_str().map(ToString::to_string))
                                .collect()
                        })
                        .unwrap_or_default();
                    let default_temperature = v
                        .get("default_parameters")
                        .and_then(|p| p.get("temperature"))
                        .and_then(|t| t.as_f64());
                    let default_top_p = v
                        .get("default_parameters")
                        .and_then(|p| p.get("top_p"))
                        .and_then(|t| t.as_f64());
                    let description = v
                        .get("description")
                        .and_then(|d| d.as_str())
                        .unwrap_or("")
                        .to_string();
                    let context_length = v
                        .get("context_length")
                        .and_then(|c| c.as_i64())
                        .unwrap_or(0);
                    let max_completion_tokens = v
                        .get("top_provider")
                        .and_then(|p| p.get("max_completion_tokens"))
                        .and_then(|c| c.as_i64())
                        .or_else(|| v.get("max_completion_tokens").and_then(|c| c.as_i64()))
                        .unwrap_or(0);
                    Some(DiscoveredModel {
                        id: id.clone(),
                        name,
                        provider: "openrouter".to_string(),
                        description,
                        size_bytes: 0,
                        context_length,
                        max_completion_tokens,
                        already_installed: false,
                        pricing_prompt,
                        pricing_completion,
                        is_free,
                        is_router,
                        modality,
                        supported_parameters,
                        default_temperature,
                        default_top_p,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    sort_discovered_models(&mut models);
    Ok(models)
}

/// Import (pull) a model via Ollama HTTP POST /api/pull
#[tauri::command]
pub async fn import_model(name: String) -> Result<bool, String> {
    let ollama_url =
        std::env::var("OLLAMA_BASE_URL").unwrap_or_else(|_| "http://localhost:11434".to_string());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .post(format!("{}/api/pull", ollama_url))
        .json(&serde_json::json!({ "name": name, "stream": false }))
        .send()
        .await
        .map_err(|e| format!("Ollama pull error: {}. Is Ollama running?", e))?;

    if resp.status().is_success() {
        Ok(true)
    } else {
        let err_text = resp.text().await.unwrap_or_default();
        Err(format!("Ollama pull failed: {}", err_text))
    }
}
