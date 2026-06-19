//! HermesProcess — owns the child Python process and the IPC pipes.
//!
//! Lifecycle states transition as: Cold → Starting → Ready ⇄ Draining → (Cold | Crashed)
//! Crashed is a terminal state; the user must explicitly restart.

use crate::jarvis::hermes::protocol::{BridgeError, IncomingMessage, OutgoingMessage, Rid};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::process::Command;
use std::process::Stdio;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

#[derive(Debug, Clone)]
pub enum HermesState {
    Cold,
    Starting,
    Ready,
    Draining,
    Crashed { reason: String },
}

impl std::fmt::Display for HermesState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cold => f.write_str("cold"),
            Self::Starting => f.write_str("starting"),
            Self::Ready => f.write_str("ready"),
            Self::Draining => f.write_str("draining"),
            Self::Crashed { reason } => write!(f, "crashed: {reason}"),
        }
    }
}

/// Configuration for spawning a Hermes child process.
#[derive(Debug, Clone)]
pub struct HermesConfig {
    /// HERMES_HOME — pinned to Jarvis's dedicated profile.
    pub hermes_home: PathBuf,
    /// Path to the