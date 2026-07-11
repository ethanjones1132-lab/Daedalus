// ═══════════════════════════════════════════════════════════════
// Model Manager Commands — SQLite-backed model profile CRUD +
// Ollama / OpenRouter discovery + model import
// ═══════════════════════════════════════════════════════════════

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::settings::{load_jarvis_config_conn, persist_jarvis_config_conn};
use crate::db::AppDb;
use crate::jarvis::types::{JarvisBackend, JarvisConfig};

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

// ── Effective runtime config ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EffectiveRuntimeConfig {
    pub provider: String,
    pub model: String,
    pub source: String,
    pub applied_at: String,
    pub restart_required: bool,
}

fn apply_profile_to_config(config: &mut JarvisConfig, profile: &ModelProfile) {
    config.active_profile = profile.name.clone();
    config.temperature = profile.temperature;
    config.max_tokens = profile.max_tokens.max(0) as u32;
    config.top_p = profile.top_p;
    if !profile.system_prompt.is_empty() {
        config.system_prompt = profile.system_prompt.clone();
    }

    if profile.engine == "claude_cli" {
        config.active_backend = JarvisBackend::ClaudeCli;
        config.claude_cli.model = Some(profile.model.clone());
        config.claude_cli.enabled = true;
        return;
    }

    match profile.provider.as_str() {
        "openrouter" => {
            config.active_backend = JarvisBackend::OpenRouter;
            config.openrouter.model = profile.model.clone();
            if !profile.api_base.is_empty() {
                config.openrouter.base_url = profile.api_base.clone();
            }
            if !profile.api_key.is_empty() {
                config.openrouter.api_key = profile.api_key.clone();
            }
        }
        _ => {
            config.active_backend = JarvisBackend::Ollama;
            config.ollama.model = profile.model.clone();
            if !profile.api_base.is_empty() {
                config.ollama.base_url = profile.api_base.clone();
            }
        }
    }
}

/// Atomically activate a model profile and project it onto the canonical runtime
/// configuration. Returns the effective provider/model so the UI never has to
/// infer it from profile labels.
pub fn set_active_profile_and_reconcile(
    db: &AppDb,
    id: &str,
) -> Result<EffectiveRuntimeConfig, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("failed to begin transaction: {e}"))?;

    let profile: ModelProfile = tx
        .query_row(
            "SELECT id, name, provider, model, api_base, api_key, max_tokens,
                    temperature, top_p, system_prompt, is_active, created_at, updated_at, engine
             FROM model_profiles WHERE id = ?1",
            [id],
            |row| {
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
            },
        )
        .map_err(|e| format!("profile not found: {e}"))?;

    tx.execute("UPDATE model_profiles SET is_active = 0", [])
        .map_err(|e| format!("failed to clear active profile: {e}"))?;
    tx.execute(
        "UPDATE model_profiles SET is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
        [id],
    )
    .map_err(|e| format!("failed to set active profile: {e}"))?;

    let mut config = load_jarvis_config_conn(&tx)
        .map_err(|e| format!("failed to load canonical config: {e}"))?;
    apply_profile_to_config(&mut config, &profile);
    persist_jarvis_config_conn(&tx, &config)
        .map_err(|e| format!("failed to persist reconciled config: {e}"))?;

    tx.commit()
        .map_err(|e| format!("failed to commit profile activation: {e}"))?;

    let provider = config.active_backend.to_string();
    Ok(EffectiveRuntimeConfig {
        provider: provider.clone(),
        model: match config.active_backend {
            JarvisBackend::Ollama => config.ollama.model.clone(),
            JarvisBackend::OpenRouter => config.openrouter.model.clone(),
            JarvisBackend::ClaudeCli => config.claude_cli.model.clone().unwrap_or_default(),
        },
        source: profile.name.clone(),
        applied_at: chrono::Utc::now().to_rfc3339(),
        restart_required: profile.engine == "claude_cli" && provider != "claude_cli",
    })
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

/// Set a profile as active and reconcile the canonical runtime configuration.
/// Returns the effective provider/model so the UI never infers it from labels.
#[tauri::command]
pub async fn set_active_profile(
    db: State<'_, AppDb>,
    id: String,
) -> Result<EffectiveRuntimeConfig, String> {
    set_active_profile_and_reconcile(&db, &id)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{run_migrations, AppDb};
    use crate::jarvis::types::JarvisBackend;
    use rusqlite::Connection;
    use std::sync::Mutex;

    fn mem_db() -> AppDb {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run_migrations(&conn).expect("run migrations");
        AppDb {
            conn: Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    fn insert_profile(db: &AppDb, name: &str, provider: &str, model: &str) -> String {
        let conn = db.conn.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO model_profiles (id, name, provider, model, api_base, max_tokens, temperature, top_p, system_prompt, is_active, engine, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, '', 4096, 0.7, 1.0, '', 0, 'native', ?5, ?5)",
            rusqlite::params![&id, name, provider, model, &now],
        )
        .expect("insert profile");
        id
    }

    #[test]
    fn activating_a_profile_writes_the_canonical_config_projection() {
        let db = mem_db();
        let pid = insert_profile(&db, "profile-a", "openrouter", "model-a");

        let effective = set_active_profile_and_reconcile(&db, &pid).expect("activate");

        assert_eq!(effective.provider, "openrouter");
        assert_eq!(effective.model, "model-a");
        assert_eq!(effective.source, "profile-a");

        let config = load_jarvis_config_conn(&db.conn.lock().unwrap()).expect("load config");
        assert!(matches!(config.active_backend, JarvisBackend::OpenRouter));
        assert_eq!(config.openrouter.model, "model-a");
        assert_eq!(config.active_profile, "profile-a");
    }

    #[test]
    fn activating_ollama_profile_updates_ollama_model() {
        let db = mem_db();
        let pid = insert_profile(&db, "local-qwen", "ollama", "qwen3:8b");

        let effective = set_active_profile_and_reconcile(&db, &pid).expect("activate");

        assert_eq!(effective.provider, "ollama");
        assert_eq!(effective.model, "qwen3:8b");

        let config = load_jarvis_config_conn(&db.conn.lock().unwrap()).expect("load config");
        assert!(matches!(config.active_backend, JarvisBackend::Ollama));
        assert_eq!(config.ollama.model, "qwen3:8b");
    }
}
