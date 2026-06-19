// ═══════════════════════════════════════════════════════════════
// Learning Session Engine — Autonomous research job for Jarvis
// ═══════════════════════════════════════════════════════════════
//
// Pure library module: no tauri dependency. Provides the source quality
// gate, subtopic rotation, finding format, and file output for learning
// sessions. Tauri command wrappers live in commands/jarvis_commands.rs.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── Source Quality Rules ─────────────────────────────────────

/// Credibility tier for a source. Only Tier 1 sources are retained.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum CredibilityTier {
    Tier1,
    Rejected,
}

/// Result of evaluating a URL against the quality gate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceEvaluation {
    pub url: String,
    pub tier: CredibilityTier,
    pub credibility_note: String,
}

/// Evaluate a URL against the source quality allowlist.
pub fn evaluate_source(url: &str) -> SourceEvaluation {
    let lower = url.to_lowercase();

    // Academic venues
    if lower.contains("arxiv.org") {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "arXiv is the standard preprint repository for ML/CS academic papers".to_string() };
    }
    if lower.contains("aclanthology.org") {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "ACL Anthology is the official archive of ACL/EMNLP/NAACL peer-reviewed papers".to_string() };
    }
    for venue in &["neurips.cc", "icml.cc", "iclr.cc"] {
        if lower.contains(venue) {
            return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
                credibility_note: format!("{} is a top-tier peer-reviewed ML conference venue", venue) };
        }
    }

    // Recognized ML engineering blogs
    if lower.contains("anthropic.com/engineering") || lower.contains("ai.anthropic.com") {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "Anthropic Engineering publishes first-party research and engineering insights".to_string() };
    }
    if lower.contains("deepmind.google") || lower.contains("blog.deepmind") || lower.contains("deepmind.com/blog") {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "DeepMind Blog publishes peer-reviewed research summaries with methodology".to_string() };
    }
    if lower.contains("huggingface.co/blog") {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "HuggingFace Engineering publishes reproducible model and infrastructure benchmarks".to_string() };
    }
    if lower.contains("lilianweng.github.io") || lower.contains("lilianweng.com") {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "Lilian Weng's blog is a recognized reference in RL/LLM research with rigorous citations".to_string() };
    }
    if lower.contains("sebastianraschka.com") {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "Sebastian Raschka is an ML professor who publishes reproducible research and code".to_string() };
    }
    if lower.contains("karpathy.ai") || lower.contains("youtube.com/@karpathy") {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "Andrej Karpathy is a recognized ML educator and former Tesla AI lead".to_string() };
    }
    if lower.contains("pytorch.org/blog") {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "PyTorch blog publishes official engineering deep-dives with reproducible benchmarks".to_string() };
    }

    // Official project docs
    for project in &["vllm.ai", "vllm-project", "llama.cpp", "ollama.com/docs", "lmstudio.ai"] {
        if lower.contains(project) {
            return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
                credibility_note: format!("{} official project documentation with verified benchmarks", project) };
        }
    }
    if lower.contains("ggml.ai") || lower.contains("ggerganov/llama.cpp") || lower.contains("github.com/ggerganov") {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "GGML/GGUF by Georgi Gerganov is the reference implementation for quantized local inference".to_string() };
    }
    if lower.contains("huggingface.co/docs") || (lower.contains("huggingface.co/") && !lower.contains("/blob/")) {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "HuggingFace official documentation and model cards provide verified benchmarks".to_string() };
    }
    if lower.contains("nvidia.com") && (lower.contains("tensorrt") || lower.contains("/deep-learning/")) {
        return SourceEvaluation { url: url.to_string(), tier: CredibilityTier::Tier1,
            credibility_note: "NVIDIA developer documentation covers TensorRT-LLM with measured inference benchmarks".to_string() };
    }

    // Edge/mobile AI (engineering only)