// Jarvis command handlers
mod jarvis_commands;
pub use jarvis_commands::*;

// Settings command handlers (SQLite-backed)
mod settings;
pub use settings::*;

// Session command handlers (SQLite-backed)
pub mod sessions;
pub use sessions::*;

// Memory command handlers (SQLite-backed)
pub mod memory;
pub use memory::*;

// Skills command handlers (SQLite-backed)
pub mod skills;
pub use skills::*;

// Model command handlers (SQLite-backed CRUD + discovery)
pub mod models;
pub use models::*;

// Channel command handlers (SQLite-backed CRUD)
pub mod channels;
pub use channels::*;

// Cron command handlers (SQLite-backed CRUD)
pub mod cron;
pub use cron::*;

// Agent Manager command handlers (SQLite-backed CRUD)
pub mod agents;
pub use agents::*;

// System command handlers
pub mod system;
pub use system::*;

// Action registry command handlers
pub mod action_registry;
pub use action_registry::*;

// Legacy dashboard/get_* command handlers (WSL-backed)
pub mod legacy;
pub use legacy::*;

pub mod recovery_stubs;
pub use recovery_stubs::*;
