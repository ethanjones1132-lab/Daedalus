// ═══════════════════════════════════════════════════════════════
// Database Module — Jarvis Native Persistence Layer
// ═══════════════════════════════════════════════════════════════

mod migrations;
pub use migrations::run_migrations;

use std::sync::Mutex;

/// Thread-safe wrapper around a rusqlite connection.
/// All Tauri commands that access the database should clone the
/// `AppDb` state and lock the mutex for the duration of their query.
pub struct AppDb {
    pub conn: Mutex<rusqlite::Connection>,
    pub db_path: std::path::PathBuf,
}

impl AppDb {
    /// Open (or create) `jarvis.db` inside the given app data directory
    /// and run all migrations.
    pub fn new(app_data_dir: &std::path::Path) -> Result<Self, String> {
        // Ensure the directory exists
        std::fs::create_dir_all(app_data_dir)
            .map_err(|e| format!("Failed to create app data dir {:?}: {}", app_data_dir, e))?;

        let db_path = app_data_dir.join("jarvis.db");
        let conn = rusqlite::Connection::open(&db_path)
            .map_err(|e| format!("Failed to open database at {:?}: {}", db_path, e))?;

        // Enable WAL mode and set busy timeout for concurrency
        let _ = conn.execute("PRAGMA journal_mode = WAL;", []);
        let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));

        migrations::run_migrations(&conn)
            .map_err(|e| format!("Database migration failed: {}", e))?;

        Ok(Self {
            conn: Mutex::new(conn),
            db_path,
        })
    }
}