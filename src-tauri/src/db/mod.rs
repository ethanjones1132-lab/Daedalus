// ═══════════════════════════════════════════════════════════════
// Database Module — Jarvis Native Persistence Layer
// ═══════════════════════════════════════════════════════════════

mod migrations;
pub use migrations::run_migrations;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Thread-safe wrapper around a rusqlite connection.
/// All Tauri commands that access the database should clone the
/// `AppDb` state and lock the mutex for the duration of their query.
pub struct AppDb {
    pub conn: Mutex<rusqlite::Connection>,
    /// Display/legacy path. Never used as the SQLite I/O authority.
    pub db_path: PathBuf,
    /// Retained app-data root directory handle. On supported Unix builds the
    /// SQLite connection was opened through this handle's fd-backed path and
    /// receipt I/O is anchored to the same handle, so both remain rooted to the
    /// held directory inode even if `app_data_dir` is renamed or replaced.
    #[cfg(not(test))]
    pub root: AppDataRoot,
}

/// Retained identity of the app-owned data directory that owns the open SQLite
/// database.
///
/// On Unix this holds an open directory handle. When the SQLite connection was
/// successfully opened through that handle's fd-backed path the root is
/// `supported` and research receipt I/O is anchored to the handle with
/// `openat`/`mkdirat`. When the fd-backed path is unavailable or unusable the
/// database still runs, but the root is marked unsupported and research
/// persistence/readback fails closed rather than falling back to path-only
/// access.
pub struct AppDataRoot {
    /// Display-only path for reporting the receipt destination. Never used as
    /// an I/O authority.
    path: PathBuf,
    #[cfg(unix)]
    dir: std::fs::File,
    supported: bool,
}

impl AppDataRoot {
    /// Display-only root path. Never an I/O authority.
    pub fn display_path(&self) -> &Path {
        &self.path
    }

    /// The retained directory handle's raw fd. Receipt I/O uses it with
    /// `openat`/`mkdirat` so it never reopens a path.
    #[cfg(unix)]
    pub fn raw_dir_fd(&self) -> std::os::fd::RawFd {
        use std::os::fd::AsRawFd as _;
        self.dir.as_raw_fd()
    }

    /// Flush the retained app-data root directory handle so a newly created
    /// child entry (e.g. the `research-history` directory) is durable. A failure
    /// must be surfaced so the caller does not claim persistence.
    #[cfg(unix)]
    pub fn sync_dir(&self) -> Result<(), String> {
        self.dir
            .sync_all()
            .map_err(|error| format!("app data root directory sync failed: {error}"))
    }

    /// Whether the SQLite connection is rooted to this handle and
    /// handle-relative receipt I/O can be secured.
    pub fn is_supported(&self) -> bool {
        self.supported
    }
}

impl AppDb {
    /// Open (or create) `jarvis.db` inside the given app data directory, run
    /// all migrations, and retain the app-data root handle.
    ///
    /// The retained directory handle is opened first; the SQLite connection is
    /// then opened through that handle's fd-backed path so the exact connection
    /// is rooted to the held directory inode. No post-open path metadata is used
    /// as proof of identity.
    pub fn new(app_data_dir: &Path) -> Result<Self, String> {
        // Display/legacy path only; the SQLite I/O path is fd-backed on
        // supported Unix builds.
        let db_path = app_data_dir.join("jarvis.db");

        #[cfg(not(test))]
        let (conn, root) = open_connection_and_root(app_data_dir, &db_path)?;
        #[cfg(test)]
        let conn = {
            std::fs::create_dir_all(app_data_dir)
                .map_err(|e| format!("Failed to create app data dir {:?}: {}", app_data_dir, e))?;
            rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("Failed to open database at {:?}: {}", db_path, e))?
        };

        // Enable WAL mode and set busy timeout and other pragmas for concurrency and speed
        let _ = conn.execute_batch(
            "PRAGMA journal_mode = WAL; \
             PRAGMA foreign_keys = ON; \
             PRAGMA synchronous = NORMAL; \
             PRAGMA temp_store = MEMORY; \
             PRAGMA mmap_size = 30000000000; \
             PRAGMA cache_size = -20000;",
        );
        let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));

        migrations::run_migrations(&conn)
            .map_err(|e| format!("Database migration failed: {}", e))?;

        Ok(Self {
            conn: Mutex::new(conn),
            db_path,
            #[cfg(not(test))]
            root,
        })
    }

    /// The retained app-data root anchor bound to the open SQLite database.
    #[cfg(not(test))]
    pub fn app_data_root(&self) -> Option<&AppDataRoot> {
        Some(&self.root)
    }

    /// Unit-test builds retain no root handle; callers must treat receipt
    /// persistence/readback as unavailable.
    #[cfg(test)]
    pub fn app_data_root(&self) -> Option<&AppDataRoot> {
        None
    }
}

/// The fd-backed directory path for a retained directory handle, if this target
/// supports it: `/proc/self/fd/<fd>` on Linux/Android, `/dev/fd/<fd>` on
/// macOS/iOS. Other targets return `None` and are treated as unsupported.
#[cfg(all(unix, not(test)))]
fn fd_dir_path(dir: &std::fs::File) -> Option<PathBuf> {
    use std::os::fd::AsRawFd as _;
    let fd = dir.as_raw_fd();
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        return Some(PathBuf::from(format!("/proc/self/fd/{fd}")));
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return Some(PathBuf::from(format!("/dev/fd/{fd}")));
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    )))]
    {
        let _ = fd;
        return None;
    }
}

/// Securely acquire the final `app_data_dir` component as a real directory.
///
/// Ancestor components follow the OS-resolved parent path policy: ancestors may
/// be created and ancestor symlinks may be followed. Only the final component is
/// opened with `O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`. When the final component
/// is absent it is created with `mkdirat` relative to the held parent-directory
/// fd and then opened the same way, so a pre-existing final symlink is never
/// created through or followed. Any other failure (symlink, non-directory, or
/// acquisition error) returns `Err` so the caller can fall back to path-based DB
/// startup with receipts disabled.
#[cfg(all(unix, not(test)))]
fn acquire_secure_root(app_data_dir: &Path) -> Result<std::fs::File, String> {
    #[cfg(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))]
    {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd as _, FromRawFd as _};
        use std::os::raw::{c_char, c_int};
        use std::os::unix::ffi::OsStrExt as _;

        #[cfg(any(target_os = "linux", target_os = "android"))]
        type mode_t = u32;
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        type mode_t = u16;

        extern "C" {
            fn openat(dirfd: c_int, pathname: *const c_char, flags: c_int, ...) -> c_int;
            fn mkdirat(dirfd: c_int, pathname: *const c_char, mode: mode_t) -> c_int;
        }

        #[cfg(any(target_os = "linux", target_os = "android"))]
        const O_DIRECTORY: c_int = 0o200000;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        const O_NOFOLLOW: c_int = 0o400000;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        const O_CLOEXEC: c_int = 0o2000000;
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        const O_DIRECTORY: c_int = 0x100000;
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        const O_NOFOLLOW: c_int = 0x0100;
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        const O_CLOEXEC: c_int = 0x1000000;
        const O_RDONLY: c_int = 0;

        let parent = match app_data_dir.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => return Err("app data root has no parent directory".to_string()),
        };
        let name = app_data_dir
            .file_name()
            .ok_or_else(|| "app data root has no final path component".to_string())?;
        let cname = CString::new(name.as_bytes().to_vec())
            .map_err(|_| "app data root name contains an interior NUL".to_string())?;

        // Ancestors may be created and ancestor symlinks followed.
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app data parent {:?}: {}", parent, e))?;
        let parent_file = std::fs::File::open(parent)
            .map_err(|e| format!("Failed to open app data parent {:?}: {}", parent, e))?;
        let parent_fd = parent_file.as_raw_fd();

        let open_flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
        let fd = unsafe { openat(parent_fd, cname.as_ptr(), open_flags) };
        if fd < 0 {
            let open_error = std::io::Error::last_os_error();
            if open_error.kind() != std::io::ErrorKind::NotFound {
                // A pre-existing symlink (ELOOP) or non-directory final
                // component is refused; never create through it.
                return Err(format!(
                    "app data root {:?} is not a real directory: {}",
                    app_data_dir, open_error
                ));
            }

            // The final component is absent: create it relative to the held
            // parent fd, then open it without following a symlink.
            let made = unsafe { mkdirat(parent_fd, cname.as_ptr(), 0o700 as mode_t) };
            if made < 0 {
                let mkdir_error = std::io::Error::last_os_error();
                if mkdir_error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(format!(
                        "Failed to create app data root {:?}: {}",
                        app_data_dir, mkdir_error
                    ));
                }
            }
            let fd = unsafe { openat(parent_fd, cname.as_ptr(), open_flags) };
            if fd < 0 {
                return Err(format!(
                    "Failed to open app data root {:?}: {}",
                    app_data_dir,
                    std::io::Error::last_os_error()
                ));
            }
            let dir = unsafe { std::fs::File::from_raw_fd(fd) };
            if !dir
                .metadata()
                .map_err(|e| format!("Failed to stat app data root {:?}: {}", app_data_dir, e))?
                .is_dir()
            {
                return Err(format!("app data root {:?} is not a directory", app_data_dir));
            }
            return Ok(dir);
        }

        let dir = unsafe { std::fs::File::from_raw_fd(fd) };
        if !dir
            .metadata()
            .map_err(|e| format!("Failed to stat app data root {:?}: {}", app_data_dir, e))?
            .is_dir()
        {
            return Err(format!("app data root {:?} is not a directory", app_data_dir));
        }
        return Ok(dir);
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    )))]
    {
        let _ = app_data_dir;
        return Err(
            "secure app-data root acquisition is unsupported on this platform".to_string()
        );
    }
}

/// Open the retained app-data root handle first, then open SQLite through that
/// handle's fd-backed directory path so the exact connection is rooted to the
/// held directory inode (not a reopened pathname). If the root cannot be
/// securely acquired or the fd-backed open fails, the database is opened via the
/// plain path for app availability and the root is marked unsupported so
/// research receipt I/O fails closed.
#[cfg(all(unix, not(test)))]
fn open_connection_and_root(
    app_data_dir: &Path,
    db_path: &Path,
) -> Result<(rusqlite::Connection, AppDataRoot), String> {
    match acquire_secure_root(app_data_dir) {
        Ok(dir) => {
            if let Some(name) = db_path.file_name() {
                if let Some(io_path) = fd_dir_path(&dir).map(|dir_path| dir_path.join(name)) {
                    // Refuse a symlinked final `jarvis.db` component: `SQLITE_OPEN_NOFOLLOW`
                    // makes `sqlite3_open_v2` fail (SQLITE_CANTOPEN) rather than
                    // resolve the database through a symlink.
                    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                        | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
                        | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW;
                    match rusqlite::Connection::open_with_flags(&io_path, flags) {
                        Ok(conn) => {
                            return Ok((
                                conn,
                                AppDataRoot {
                                    path: app_data_dir.to_path_buf(),
                                    dir,
                                    supported: true,
                                },
                            ));
                        }
                        Err(error) => {
                            log::warn!(
                                target: "jarvis::db",
                                "fd-backed SQLite path {:?} is unusable or a symlink ({error}); \
                                 opening the database by path for general app use and disabling \
                                 research receipts",
                                io_path
                            );
                        }
                    }
                }
            }

            // Secure root acquired but the fd-backed open failed: keep the
            // database running via the plain path with receipts disabled.
            let conn = rusqlite::Connection::open(db_path)
                .map_err(|e| format!("Failed to open database at {:?}: {}", db_path, e))?;
            Ok((
                conn,
                AppDataRoot {
                    path: app_data_dir.to_path_buf(),
                    dir,
                    supported: false,
                },
            ))
        }
        Err(secure_error) => {
            log::warn!(
                target: "jarvis::db",
                "app data root {:?} is not securely acquirable ({secure_error}); opening the \
                 database by path for general app use and disabling research receipts",
                app_data_dir
            );

            // Preserve normal DB startup via the existing path if possible, but
            // never create through a pre-existing final symlink.
            let final_is_symlink = std::fs::symlink_metadata(app_data_dir)
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(false);
            if !final_is_symlink {
                std::fs::create_dir_all(app_data_dir).map_err(|e| {
                    format!("Failed to create app data dir {:?}: {}", app_data_dir, e)
                })?;
            }
            let conn = rusqlite::Connection::open(db_path)
                .map_err(|e| format!("Failed to open database at {:?}: {}", db_path, e))?;
            let dir = std::fs::File::open(app_data_dir).map_err(|e| {
                format!("Failed to open app data root {:?}: {}", app_data_dir, e)
            })?;
            Ok((
                conn,
                AppDataRoot {
                    path: app_data_dir.to_path_buf(),
                    dir,
                    supported: false,
                },
            ))
        }
    }
}

/// Non-Unix platforms cannot root SQLite to a retained directory handle with the
/// APIs available to this crate; the database runs normally but the root is
/// marked unsupported so research receipt I/O fails closed.
#[cfg(all(not(unix), not(test)))]
fn open_connection_and_root(
    app_data_dir: &Path,
    db_path: &Path,
) -> Result<(rusqlite::Connection, AppDataRoot), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("Failed to create app data dir {:?}: {}", app_data_dir, e))?;
    let conn = rusqlite::Connection::open(db_path)
        .map_err(|e| format!("Failed to open database at {:?}: {}", db_path, e))?;
    Ok((
        conn,
        AppDataRoot {
            path: app_data_dir.to_path_buf(),
            supported: false,
        },
    ))
}
