... 64 lines not shown ...
    }
}

/// Load the full JarvisConfig from the Native surface settings table.
///
    /// This is the canonical loader used by both Tauri commands and the chat
/// turn path before it delegates inference streaming to the Bun server.
pub fn load_jarvis_config(db: &AppDb) -> Result<JarvisConfig, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
        .map_err(|e| e.to_string())?;

    let mut settings = HashMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        settings.insert(k, v);
    }

    // Start from defaults, then overlay any stored JSON blobs
        let mut config = JarvisConfig::default();

    if let Some(v) = settings.get("version") {
        config.version = v.clone();
    }
... 202 lines not shown ...