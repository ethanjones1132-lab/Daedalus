// This module contains legacy age/scoring utilities that are no longer used.
// The engine now uses recency_score_ms() with integer timestamps for better performance.
// Kept for reference but can be removed if no longer needed.
#![allow(dead_code)]

use crate::jarvis::memory::types::MemoryType;

/// Memory age score: newer is better, decays over time
pub fn memory_age_score(mtime_ms: u64, now_ms: u64) -> f64 {
    let age_days = now_ms.saturating_sub(mtime_ms) as f64 / (24.0 * 3600.0 * 1000.0);
    // Exponential decay: half-life of 30 days
    (-0.693 * age_days / 30.0).exp()
}

/// Combined relevance score: age + type bonus
pub fn combined_score(
    mtime_ms: u64,
    memory_type: Option<&MemoryType>,
    query_relevance: f64,
) -> f64 {
    combined_score_at(mtime_ms, current_time_ms(), memory_type, query_relevance)
}

/// Combined relevance score using an explicit clock value.
pub fn combined_score_at(
    mtime_ms: u64,
    now_ms: u64,
    memory_type: Option<&MemoryType>,
    query_relevance: f64,
) -> f64 {
    let age_score = memory_age_score(mtime_ms, now_ms);
    let type_bonus = match memory_type {
        Some(MemoryType::User) => 0.3,
        Some(MemoryType::Feedback) => 0.2,
        Some(MemoryType::Project) => 0.1,
        Some(MemoryType::Reference) => 0.05,
        None => 0.0,
    };
    age_score * 0.4 + type_bonus * 0.3 + query_relevance * 0.3
}

/// Check if a memory is considered stale (older than 90 days)
pub fn is_stale(mtime_ms: u64) -> bool {
    is_stale_at(mtime_ms, current_time_ms())
}

pub fn is_stale_at(mtime_ms: u64, now_ms: u64) -> bool {
    let age_days = now_ms.saturating_sub(mtime_ms) as f64 / (24.0 * 3600.0 * 1000.0);
    age_days > 90.0
}

fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_age_score_fresh() {
        let now = 1_000_000_000_000;
        let score = memory_age_score(now, now);
        assert!(
            (score - 1.0).abs() < 0.001,
            "Fresh memory should score ~1.0"
        );
    }

    #[test]
    fn test_memory_age_score_30_days() {
        let now = 1_000_000_000_000;
        let mtime = now - 30 * 24 * 3600 * 1000;
        let score = memory_age_score(mtime, now);
        assert!(
            (score - 0.5).abs() < 0.01,
            "30-day-old memory should score ~0.5"
        );
    }

    #[test]
    fn test_combined_score_user_type() {
        let now = 1_000_000_000_000;
        let score = combined_score_at(now, now, Some(&MemoryType::User), 1.0);
        assert!(score > 0.78 && score < 0.80);
    }
}
