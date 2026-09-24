// ═══════════════════════════════════════════════════════════════
// Skills Commands — SQLite-backed skill management
// ═══════════════════════════════════════════════════════════════

use crate::db::AppDb;
use crate::jarvis::memory::engine::{self, SkillRevision};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

/// A skill stored in the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub enabled: bool,
    #[serde(default)]
    pub metadata: Option<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default = "default_skill_version")]
    pub version: i64,
    #[serde(default)]
    pub last_improved_at: Option<String>,
    #[serde(default)]
    pub improvement_score: f64,
    pub created_at: String,
    pub updated_at: String,
}

fn default_skill_version() -> i64 {
    1
}

// ── Bundled skills seed data ─────────────────────────────────

struct BundledSkillSeed {
    name: &'static str,
    description: &'static str,
    category: &'static str,
    body: &'static str,
}

const BUNDLED_SKILLS: &[BundledSkillSeed] = &[
    BundledSkillSeed {
        name: "code-review",
        description: "Review code for correctness, maintainability, and regression risk",
        category: "development",
        body: r#"# code-review

Use a code-review stance. Prioritize defects over style.

Process:
- Inspect the referenced code before judging it.
- Look for correctness bugs, data loss, races, security issues, regressions, and missing tests.
- Ground every finding in a concrete file, function, command, or behavior.
- Do not pad the review with low-value nits.

Output:
- Lead with findings, ordered by severity.
- Include file and line references when available.
- Add open questions only when they block confidence.
- If no issues are found, say so clearly and name residual test risk.
"#,
    },
    BundledSkillSeed {
        name: "debug",
        description: "Diagnose and fix a reported failure with evidence",
        category: "development",
        body: r#"# debug

Use a disciplined debugging loop.

Process:
- Reproduce or narrow the failure before changing code.
- State the smallest observed symptom and the likely boundary where it starts.
- Inspect logs, tests, traces, and inputs that directly affect the failure.
- Prefer one targeted fix over broad rewrites.
- Verify the fix with the narrowest useful command, then a broader check if risk warrants it.

Output:
- Explain the root cause in plain terms.
- Name the changed files and verification commands.
- Mention any scenario that remains untested.
"#,
    },
    BundledSkillSeed {
        name: "test-gen",
        description: "Generate focused tests for existing behavior or new changes",
        category: "development",
        body: r#"# test-gen

Generate tests that protect behavior, not implementation details.

Process:
- Identify the public contract under test.
- Cover the happy path, one realistic edge case, and the highest-risk failure path.
- Match the repository's existing test framework, naming, fixtures, and assertions.
- Avoid brittle timing, snapshots, and mocks unless the codebase already uses them for this boundary.

Output:
- Add or propose concrete tests.
- Explain what each test protects.
- Run the relevant test command when possible.
"#,
    },
    BundledSkillSeed {
        name: "docs",
        description: "Write useful documentation for code, workflows, or APIs",
        category: "documentation",
        body: r#"# docs

Write documentation that helps someone act.

Process:
- Identify the audience: user, operator, contributor, or future maintainer.
- Prefer examples, commands, inputs, outputs, and failure notes over abstract prose.
- Keep docs aligned with the current code, not intended future behavior.
- Avoid repeating code comments unless they explain a workflow.

Output:
- Use short sections with clear headings.
- Include exact commands or API examples where useful.
- Call out prerequisites and gotchas.
"#,
    },
    BundledSkillSeed {
        name: "refactor",
        description: "Improve structure without changing observable behavior",
        category: "development",
        body: r#"# refactor

Refactor only where it reduces real complexity.

Process:
- Preserve behavior and public interfaces unless the user asks otherwise.
- Prefer local simplification over new abstractions.
- Follow existing naming, module boundaries, and error-handling style.
- Keep changes small enough to review.
- Verify with existing tests or a targeted smoke check.

Output:
- Name the complexity removed.
- List behavior-preservation checks.
- Avoid unrelated cleanup.
"#,
    },
    BundledSkillSeed {
        name: "security-audit",
        description: "Find practical security risks and unsafe defaults",
        category: "security",
        body: r#"# security-audit

Review for exploitable risk, not theoretical noise.

Process:
- Identify trust boundaries, secrets, filesystem/network access, command execution, and auth checks.
- Look for injection, path traversal, SSRF, insecure deserialization, weak permissions, and unsafe logging.
- Consider how an attacker controls inputs.
- Do not disclose or print secrets found in files or environment variables.

Output:
- Findings first, ordered by severity and exploitability.
- For each finding, include impact, evidence, and a concrete fix.
- If no high-risk issues are found, state the remaining assumptions.
"#,
    },
    BundledSkillSeed {
        name: "git-helper",
        description: "Assist with safe git inspection, staging, commits, and PR prep",
        category: "workflow",
        body: r#"# git-helper

Help with git while protecting user work.

Process:
- Inspect status before staging, committing, rebasing, or switching branches.
- Never revert or discard changes unless explicitly requested.
- Separate unrelated work and explain what is being included.
- Prefer non-interactive git commands.
- Use concise commit messages that describe intent and effect.

Output:
- Summarize branch, changed files, and staged scope.
- Mention untracked or unrelated dirty files that were left alone.
"#,
    },
    BundledSkillSeed {
        name: "explain",
        description: "Explain code or concepts clearly for the user's current level",
        category: "learning",
        body: r#"# explain

Explain by connecting the specific artifact to the larger idea.

Process:
- Start from the user's concrete question or selected code.
- Define unfamiliar terms only when needed.
- Prefer one small example over broad theory.
- Call out why the design matters and what can go wrong.

Output:
- Use clear prose and short code excerpts.
- End with the practical takeaway, not a lecture.
"#,
    },
    BundledSkillSeed {
        name: "sql",
        description: "Write, review, and optimize SQL with attention to correctness",
        category: "data",
        body: r#"# sql

Treat SQL as production data logic.

Process:
- Identify tables, keys, cardinality, null behavior, and expected result shape.
- Prefer explicit joins and predicates.
- Check aggregation, grouping, ordering, limits, and timezone/date boundaries.
- Consider indexes and query plan implications for large tables.

Output:
- Provide the query and explain important clauses.
- Mention assumptions about schema or dialect.
- Include index or migration suggestions only when justified.
"#,
    },
    BundledSkillSeed {
        name: "api-design",
        description: "Design APIs with clear contracts, errors, and evolution paths",
        category: "development",
        body: r#"# api-design

Design APIs as stable contracts.

Process:
- Clarify resources, operations, callers, permissions, and latency expectations.
- Define request and response shapes, validation, pagination, idempotency, and error formats.
- Choose REST, RPC, GraphQL, or events based on usage, not fashion.
- Plan versioning and backward compatibility.

Output:
- Provide endpoint or schema examples.
- Include error cases and status codes.
- Note tradeoffs and migration concerns.
"#,
    },
    BundledSkillSeed {
        name: "batch",
        description: "Plan and execute repeated changes safely across files",
        category: "workflow",
        body: r#"# batch

Handle repetitive work with guardrails.

Process:
- Define the exact file set before editing.
- Use search or structured tooling to identify candidates.
- Apply the smallest repeatable transformation.
- Spot-check representative files.
- Run a verification command that can catch broad mistakes.

Output:
- State the selection rule and number of affected files.
- Summarize the mechanical change.
- Mention any skipped ambiguous cases.
"#,
    },
    BundledSkillSeed {
        name: "remember",
        description: "Use durable memory carefully and only for useful facts",
        category: "memory",
        body: r#"# remember

Save durable knowledge conservatively.

Process:
- Remember stable user preferences, project facts, recurring workflows, and corrections.
- Do not store secrets, credentials, sensitive personal data, or one-off transient details.
- When recalling memory, apply it quietly unless it affects the answer materially.
- If a memory may be wrong or stale, verify before relying on it.

Output:
- Be explicit when the user asks what was remembered.
- Keep remembered facts short, specific, and revisable.
"#,
    },
    BundledSkillSeed {
        name: "verify",
        description: "Validate that a change or claim works end to end",
        category: "development",
        body: r#"# verify

Verify behavior with evidence.

Process:
- Identify the claim being verified.
- Choose the cheapest reliable check first.
- Include build, typecheck, tests, lint, browser, or manual smoke checks as appropriate.
- Distinguish passed checks from checks that were not run.

Output:
- List commands run and outcomes.
- Explain failures or skipped checks.
- State remaining risk plainly.
"#,
    },
    BundledSkillSeed {
        name: "simplify",
        description: "Reduce complexity in code, text, or plans while preserving meaning",
        category: "development",
        body: r#"# simplify

Simplify without flattening important nuance.

Process:
- Identify the core purpose.
- Remove duplication, incidental detail, and ambiguous phrasing.
- Preserve constraints, edge cases, and user-visible behavior.
- Prefer direct names and obvious structure.

Output:
- Provide the simpler version.
- Briefly note what was removed or consolidated.
- Avoid changing intent unless the user asks for a stronger rewrite.
"#,
    },
    BundledSkillSeed {
        name: "loop",
        description: "Run bounded iterative work with a clear stop condition",
        category: "workflow",
        body: r#"# loop

Use iteration deliberately and stop cleanly.

Process:
- Define the goal, maximum iterations, and stop condition.
- After each pass, compare evidence against the goal.
- Change one meaningful variable at a time.
- Stop when the goal is met, the limit is h

Output:
- Show iteration count and current status.
- Summarize what changed each pass.
- End with the final result or the blocker.
"#,
    },
    BundledSkillSeed {
        name: "performance-profile",
        description: "Analyze performance bottlenecks and resource utilization",
        category: "performance",
        body: r#"# performance-profile

Perform a comprehensive performance audit and profile of the target system, code, or query.

Process:
- Analyze time complexity (Big O) and space complexity of algorithms and data structures.
- Identify potential bottlenecks: CPU-intensive tasks, excessive object allocations (GC pressure), unnecessary I/O, database queries in loops (N+1 queries), blocking main thread operations, and serialization/deserialization overhead.
- Check resource utilization: connection pool exhaustion, file handle leaks, memory leaks, and thread locking/contention.
- Recommend optimizations: caching strategies, parallel/concurrent execution, batching, lazy evaluation, indexing, and memory-efficient data structures.

Output:
- Findings ordered by performance impact (High/Medium/Low).
- Concrete code or configuration changes with estimated speedups.
- Recommended benchmarking commands or profiling tools (e.g., Flamegraphs, Chrome DevTools, cargo bench, or EXPLAIN ANALYZE) to verify improvements.
"#,
    },
    BundledSkillSeed {
        name: "architecture-review",
        description: "Analyze system structure, boundaries, and dependencies for scalability, modularity, and alignment with clean architecture",
        category: "architecture",
        body: r#"# architecture-review

Analyze system structure, boundaries, and dependencies for scalability, modularity, and clean architecture.

Process:
- Map components, modules, dependencies, and data flow.
- Look for circular dependencies, high coupling, leaky abstractions, and violation of layering or boundaries.
- Assess single points of failure, scalability bottlenecks, concurrency safety, and state management.
- Check compliance with design principles (SOLID, DDD, Clean Architecture) and repository style.

Output:
- Architectural diagram (Mermaid/ASCII) if helpful.
- Severity-ordered findings (Critical/Major/Minor/Info).
- Actionable refactoring or restructuring plan.
"#,
    },
    BundledSkillSeed {
        name: "enterprise-resilience",
        description: "Audit and design system resilience patterns including circuit breakers, retries, rate limiting, bulkheads, and fallbacks",
        category: "architecture",
        body: r#"# enterprise-resilience

Audit and design system resilience patterns to guarantee high availability and fault tolerance in enterprise architectures.

Process:
- Identify critical dependencies (APIs, databases, external services) and failure points.
- Map out execution paths and isolate risks using bulkheads (e.g., thread pool or connection pool boundaries).
- Define circuit breaker thresholds: fail-fast triggers, error rate percentages, slow call rates, and cool-down (half-open) durations.
- Design retries with exponential backoff and randomized jitter to prevent thundering herd problems.
- Implement rate limiting and load shedding to protect local resource availability.
- Define explicit, graceful fallback responses for degraded states.

Output:
- Detailed resilience blueprint explaining breaker states, limits, and timeouts.
- Structural changes showing bulkhead boundaries and isolation strategies.
- Code examples or configuration parameters (e.g., Polly, Resilience4j, or custom TS/Rust wrappers).
"#,
    },
    BundledSkillSeed {
        name: "enterprise-observability",
        description: "Audit, design, and configure production-grade telemetry (structured logging, metrics, and distributed tracing) for enterprise systems",
        category: "architecture",
        body: r#"# enterprise-observability

Audit, design, and configure production-grade telemetry (structured logging, metrics, and distributed tracing) for enterprise systems.

Process:
- Identify key telemetry collection points: incoming request boundaries, database queries, downstream service calls, background tasks, and unhandled exception boundaries.
- Enforce structured logging: log in JSON, ensure key-value context is passed as fields rather than string interpolation, define tracing context propagation (traceId, spanId) in log context, and mask sensitive fields (PII, tokens, credentials).
- Standardize metrics collection: define core SLIs/SLOs (latency, error rate, throughput, saturation), use appropriate metric types (counters, gauges, histograms), and avoid high-cardinality labels (e.g., raw IDs or user-specific strings).
- Design distributed tracing: define span boundaries, trace context propagation headers (e.g., W3C Trace Context, B3), record relevant span events and tags (HTTP method, status code, db statement), and handle sampling strategies.
- Verify observability configuration: ensure open-telemetry SDK, exporter endpoint, or APM instrumentation is properly initialized and configured.

Output:
- Architectural diagram showing trace propagation and telemetry ingestion paths.
- Concrete recommendations or fixes for logger configuration, metrics instrumentation, and span creation.
- Code snippets (e.g., OpenTelemetry, Winston/Pino/Log4j configuration) to implement the designs.
"#,
    },
    BundledSkillSeed {
        name: "inference-optimization",
        description: "Audit, design, and optimize LLM inference pathways, prompt formatting, context compaction, and response streaming",
        category: "performance",
        body: r#"# inference-optimization

Optimize inference pipeline latency, prompt boundaries, context compaction, and response streaming.

Process:
- Analyze context window utilization: verify prompt token count, trim redundant conversational history, and apply prefix-caching alignment (e.g., place static system prompts and system schemas at the top).
- Enforce stream chunk processing: ensure chunks are processed and emitted as they arrive (no buffering/batching of tokens before emitting).
- Audit JSON schema serialization overhead: check for redundant schema conversions, deep object nesting, and repetitive reflection.
- Validate model parameters: configure optimal temp, top_p, and frequency_penalty to prevent repetitive reasoning loop stalls.
- Implement token-budgeting policies: dynamically compact prompt payloads based on maximum context limit.

Output:
- Identified bottlenecks in formatting, serialization, or streaming.
- Concrete configuration changes (e.g., system prompt restructuring, model parameters, buffer size adjustments).
- Before/after TTFT (Time To First Token) and throughput projections.
"#,
    },
];

/// Seed the skills table with bundled skills if they don't already exist.
/// Called once on first run (after migrations).
pub fn seed_skills(db: &AppDb) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    for skill in BUNDLED_SKILLS {
        let meta = serde_json::json!({ "category": skill.category, "source": "bundled", "quality": "prompt-body-v2" });
        let placeholder = format!("# {}\n\n{}\n", skill.name, skill.description);
        let _ = conn.execute(
            "INSERT OR IGNORE INTO skills
             (id, name, description, path, enabled, metadata, body, version, created_at, updated_at)
             VALUES (?, ?, ?, '', 1, ?, ?, 2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![skill.name, skill.name, skill.description, meta.to_string(), skill.body],
        );
        let _ = conn.execute(
            "UPDATE skills
             SET description = ?, metadata = ?, body = ?,
                 version = CASE WHEN version < 2 THEN 2 ELSE version END,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE name = ? AND (
                 body = ''
                 OR body = ?
                 OR body = '# ' || name || char(10) || char(10) || description || char(10)
             )",
            params![
                skill.description,
                meta.to_string(),
                skill.body,
                skill.name,
                placeholder
            ],
        );
    }

    Ok(())
}

// ── Commands ─────────────────────────────────────────────────

/// List all skills ordered by name.
#[tauri::command]
pub fn list_skills(db: State<AppDb>) -> Result<Vec<Skill>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, path, enabled, metadata, body, version,
                    last_improved_at, improvement_score, created_at, updated_at
             FROM skills ORDER BY name",
        )
        .map_err(|e| e.to_string())?;

    let skills = stmt
        .query_map([], |row| {
            Ok(Skill {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                path: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                metadata: row.get(5)?,
                body: row.get(6).unwrap_or_default(),
                version: row.get(7).unwrap_or(1),
                last_improved_at: row.get(8).ok(),
                improvement_score: row.get(9).unwrap_or(0.0),
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(skills)
}

/// Get a single skill by name.
#[tauri::command]
pub fn get_skill(db: State<AppDb>, name: String) -> Result<Skill, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    conn.query_row(
        "SELECT id, name, description, path, enabled, metadata, body, version,
                last_improved_at, improvement_score, created_at, updated_at
         FROM skills WHERE name = ?",
        [&name],
        |row| {
            Ok(Skill {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                path: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                metadata: row.get(5)?,
                body: row.get(6).unwrap_or_default(),
                version: row.get(7).unwrap_or(1),
                last_improved_at: row.get(8).ok(),
                improvement_score: row.get(9).unwrap_or(0.0),
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        },
    )
    .map_err(|e| format!("Skill '{}' not found: {}", name, e))
}

/// Enable a skill (set enabled = 1).
#[tauri::command]
pub fn enable_skill(db: State<AppDb>, name: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    conn.execute(
        "UPDATE skills SET enabled = 1, updated_at = datetime('now') WHERE name = ?",
        [&name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Disable a skill (set enabled = 0).
#[tauri::command]
pub fn disable_skill(db: State<AppDb>, name: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    conn.execute(
        "UPDATE skills SET enabled = 0, updated_at = datetime('now') WHERE name = ?",
        [&name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Invoke a skill by name — returns the stored skill record (body + metadata).
#[tauri::command]
pub fn invoke_skill(db: State<AppDb>, name: String) -> Result<Skill, String> {
    get_skill(db, name)
}

/// List skill revisions, optionally filtered by skill id.
#[tauri::command]
pub fn skill_revisions_list(
    db: State<AppDb>,
    skill_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<SkillRevision>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::list_skill_revisions(&conn, skill_id, limit)
}

#[tauri::command]
pub fn skill_restore_revision(db: State<AppDb>, revision_id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::restore_skill_revision(&conn, &revision_id)
}

#[derive(Debug, Deserialize)]
struct DistilledSkillCandidateFile {
    id: String,
    name: String,
    description: String,
    body: String,
    status: String,
    source_session_id: Option<String>,
    confidence: f64,
}

/// Import distilled skill candidates written by the Bun orchestrator into SQLite.
#[tauri::command]
pub fn sync_distilled_skill_candidates(db: State<AppDb>) -> Result<usize, String> {
    use std::path::PathBuf;

    let dir = PathBuf::from(crate::get_home_dir()).join(".openclaw/jarvis/skills/candidates");
    sync_distilled_skill_candidates_from_dir(db.inner(), &dir)
}

fn distilled_candidate_id(metadata: Option<&str>) -> Option<String> {
    let raw = metadata?;
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    if value.get("source")?.as_str()? != "trajectory_distillation" {
        return None;
    }
    value
        .get("candidate_id")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn is_distilled_metadata(metadata: Option<&str>) -> bool {
    let Some(raw) = metadata else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    value.get("source").and_then(|v| v.as_str()) == Some("trajectory_distillation")
}

fn sync_distilled_skill_candidates_from_dir(db: &AppDb, dir: &std::path::Path) -> Result<usize, String> {
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::path::PathBuf;

    if !dir.exists() {
        return Ok(0);
    }

    let mut files: Vec<(PathBuf, DistilledSkillCandidateFile)> = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_names = HashSet::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let file: DistilledSkillCandidateFile = serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid candidate {}: {}", path.display(), e))?;
        if !seen_ids.insert(file.id.clone()) {
            return Err(format!("Duplicate candidate id: {}", file.id));
        }
        if !seen_names.insert(file.name.clone()) {
            return Err(format!("Duplicate candidate name: {}", file.name));
        }
        files.push((path, file));
    }

    let current_ids: HashSet<String> = files.iter().map(|(_, file)| file.id.clone()).collect();
    let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let existing_rows: Vec<(String, String, Option<String>)> = {
        let mut stmt = tx
            .prepare("SELECT id, name, metadata FROM skills")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let mut by_candidate: HashMap<String, String> = HashMap::new();
    let mut by_name: HashMap<String, (String, Option<String>)> = HashMap::new();
    for (id, name, metadata) in &existing_rows {
        if let Some(candidate_id) = distilled_candidate_id(metadata.as_deref()) {
            by_candidate.insert(candidate_id, id.clone());
        }
        by_name.insert(name.clone(), (id.clone(), metadata.clone()));
    }

    let mut retained_ids = HashSet::new();
    let mut synced = 0usize;
    for (_, file) in &files {
        let existing_id = by_candidate.get(&file.id).cloned();
        let existing_name = by_name.get(&file.name).cloned();
        if let Some((name_id, name_metadata)) = &existing_name {
            let same_candidate = existing_id.as_deref() == Some(name_id.as_str());
            if !same_candidate && !is_distilled_metadata(name_metadata.as_deref()) {
                return Err(format!("Candidate name conflicts with existing skill: {}", file.name));
            }
        }
        if let (Some(candidate_id), Some((name_id, _))) = (&existing_id, &existing_name) {
            if candidate_id != name_id {
                return Err(format!("Candidate name conflicts with another distilled skill: {}", file.name));
            }
        }

        let enabled = if file.status == "promoted" { 1 } else { 0 };
        let metadata = serde_json::json!({
            "category": "distilled",
            "source": "trajectory_distillation",
            "status": file.status,
            "confidence": file.confidence,
            "candidate_id": file.id,
        })
        .to_string();
        let target_id = existing_id.or_else(|| existing_name.as_ref().map(|(id, _)| id.clone()));
        if let Some(target_id) = target_id {
            tx.execute(
                "UPDATE skills SET name = ?, description = ?, body = ?, enabled = ?, metadata = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
                params![file.name, file.description, file.body, enabled, metadata, target_id],
            )
            .map_err(|e| e.to_string())?;
            retained_ids.insert(target_id);
        } else {
            tx.execute(
                "INSERT INTO skills (id, name, description, path, enabled, metadata, body, version, created_at, updated_at)
                 VALUES (?, ?, ?, '', ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![file.id, file.name, file.description, enabled, metadata, file.body],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO skill_revisions (id, skill_id, version, body_before, body_after, change_reason, source_session_id, created_at)
                 VALUES (?, ?, 1, '', ?, 'trajectory_distillation', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    file.id,
                    file.body,
                    file.source_session_id,
                ],
            )
            .map_err(|e| e.to_string())?;
            retained_ids.insert(file.id.clone());
        }
        synced += 1;
    }

    let stale_ids: Vec<String> = existing_rows
        .iter()
        .filter_map(|(id, _, metadata)| {
            let candidate_id = distilled_candidate_id(metadata.as_deref())?;
            if current_ids.contains(&candidate_id) || retained_ids.contains(id) {
                None
            } else {
                Some(id.clone())
            }
        })
        .collect();
    for id in stale_ids {
        tx.execute("DELETE FROM skills WHERE id = ?", [&id])
            .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(synced)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::run_migrations;
    use rusqlite::Connection;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn mem_db() -> AppDb {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run_migrations(&conn).expect("run migrations");
        AppDb {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("jarvis-skills-sync-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn insert_skill(db: &AppDb, id: &str, name: &str, source: &str, candidate_id: Option<&str>) {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        let metadata = serde_json::json!({
            "source": source,
            "candidate_id": candidate_id,
        });
        conn.execute(
            "INSERT INTO skills (id, name, description, path, enabled, metadata, body, version, created_at, updated_at)
             VALUES (?, ?, ?, '', 1, ?, ?, 1, '', '')",
            params![id, name, source, metadata.to_string(), "body"],
        )
        .expect("insert skill");
    }

    fn skill_exists(db: &AppDb, id: &str) -> bool {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM skills WHERE id = ?)",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .expect("query skill")
            != 0
    }

    fn candidate_json(id: &str, name: &str, status: &str) -> String {
        serde_json::json!({
            "id": id,
            "name": name,
            "description": "candidate",
            "body": "body",
            "status": status,
            "source_session_id": "session",
            "confidence": 0.9,
        })
        .to_string()
    }

    #[test]
    fn sync_removes_only_stale_distilled_rows() {
        let db = mem_db();
        insert_skill(&db, "stale", "stale-skill", "trajectory_distillation", Some("stale"));
        insert_skill(&db, "bundled", "bundled-skill", "bundled", None);
        let dir = temp_dir();
        fs::write(
            dir.join("current.json"),
            candidate_json("current", "current-skill", "promoted"),
        )
        .expect("write current candidate");

        assert_eq!(sync_distilled_skill_candidates_from_dir(&db, &dir).unwrap(), 1);
        assert!(skill_exists(&db, "current"));
        assert!(!skill_exists(&db, "stale"));
        assert!(skill_exists(&db, "bundled"));
        fs::remove_dir_all(dir).expect("remove temp dir");
    }

    #[test]
    fn missing_directory_preserves_existing_distilled_rows() {
        let db = mem_db();
        insert_skill(&db, "stale", "stale-skill", "trajectory_distillation", Some("stale"));
        let dir = temp_dir();
        fs::remove_dir_all(&dir).expect("remove temp dir");

        assert_eq!(sync_distilled_skill_candidates_from_dir(&db, &dir).unwrap(), 0);
        assert!(skill_exists(&db, "stale"));
    }

    #[test]
    fn malformed_directory_does_not_partially_reconcile_rows() {
        let db = mem_db();
        insert_skill(&db, "stale", "stale-skill", "trajectory_distillation", Some("stale"));
        let dir = temp_dir();
        fs::write(dir.join("valid.json"), candidate_json("valid", "valid-skill", "candidate"))
            .expect("write valid candidate");
        fs::write(dir.join("broken.json"), "{").expect("write broken candidate");

        assert!(sync_distilled_skill_candidates_from_dir(&db, &dir).is_err());
        assert!(skill_exists(&db, "stale"));
        assert!(!skill_exists(&db, "valid"));
        fs::remove_dir_all(dir).expect("remove temp dir");
    }
}
