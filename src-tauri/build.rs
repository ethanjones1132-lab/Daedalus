use std::process::Command;

/// Embed build provenance (git SHA, dirty flag, build time) into the binary so
/// the app can report what it was built from and detect a stale binary vs the
/// current source tree. Falls back to "unknown" when git isn't available (e.g.
/// a source tarball build).
fn main() {
    // Rebuild when HEAD moves so the embedded SHA stays accurate.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/index");

    let sha = git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    let dirty = match git(&["status", "--porcelain"]) {
        Some(s) if !s.trim().is_empty() => "1",
        _ => "0",
    };
    let build_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    println!("cargo:rustc-env=JARVIS_GIT_SHA={sha}");
    println!("cargo:rustc-env=JARVIS_GIT_DIRTY={dirty}");
    println!("cargo:rustc-env=JARVIS_BUILD_UNIX={build_unix}");

    tauri_build::build();
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
