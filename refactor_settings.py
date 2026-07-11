from pathlib import Path
p = Path('src-tauri/src/commands/settings.rs')
text = p.read_text(encoding='utf-8')

old_load = text[text.find('pub fn load_jarvis_config(db: &AppDb)'):text.find('fn normalize_jarvis_config')]
# include normalize function? We'll leave it.
start = text.find('pub fn load_jarvis_config(db: &AppDb)')
end = text.find('fn normalize_jarvis_config')
block = text[start:end]

# We want to replace load_jarvis_config implementation with wrapper + conn version.
# Simpler: insert conn version after load_jarvis_config, and change load to wrapper.

# Change load_jarvis_config signature body
old_load_sig = '''pub fn load_jarvis_config(db: &AppDb) -> Result<JarvisConfig, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());'''
new_load_sig = '''pub fn load_jarvis_config(db: &AppDb) -> Result<JarvisConfig, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    load_jarvis_config_conn(&conn)
}

/// Connection-based loader so callers already holding the DB lock can read
/// the canonical config without re-entering the mutex.
pub fn load_jarvis_config_conn(conn: &rusqlite::Connection) -> Result<JarvisConfig, String> {'''

if old_load_sig not in text:
    print('load sig not found')
    raise SystemExit(1)
text = text.replace(old_load_sig, new_load_sig, 1)

# Change persist_jarvis_config signature body
old_persist_sig = '''pub fn persist_jarvis_config(db: &AppDb, config: &JarvisConfig) -> Result<(), String> {
    let mut config = config.clone();'''
new_persist_sig = '''pub fn persist_jarvis_config(db: &AppDb, config: &JarvisConfig) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    persist_jarvis_config_conn(&conn, config)
}

/// Connection-based persister so callers already holding the DB lock can write
/// the canonical config without re-entering the mutex.
pub fn persist_jarvis_config_conn(
    conn: &rusqlite::Connection,
    config: &JarvisConfig,
) -> Result<(), String> {
    let mut config = config.clone();'''

if old_persist_sig not in text:
    print('persist sig not found')
    raise SystemExit(1)
text = text.replace(old_persist_sig, new_persist_sig, 1)

# Remove the inner lock block in persist_jarvis_config_conn
old_inner = '''    {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

        for (key, value) in &pairs {'''
new_inner = '''    for (key, value) in &pairs {'''
if old_inner not in text:
    print('inner lock block not found')
    raise SystemExit(1)
text = text.replace(old_inner, new_inner, 1)

# Remove closing brace of inner block
old_close = '''        }
    }

    // Project the canonical config'''
new_close = '''    }

    // Project the canonical config'''
if old_close not in text:
    print('inner close not found')
    raise SystemExit(1)
text = text.replace(old_close, new_close, 1)

p.write_text(text, encoding='utf-8')
print('refactored settings.rs')
