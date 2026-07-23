mod release_resource_staging;

use std::path::PathBuf;
use std::process::Command;

/// Embed build provenance (git SHA, dirty flag, build time) into the binary so
/// the app can report what it was built from and detect a stale binary vs the
/// current source tree. Falls back to "unknown" when git isn't available (e.g.
/// a source tarball build).
fn main() {
    // Rebuild when HEAD moves so the embedded SHA stays accurate.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/index");
    // Rebuild when runtime resources change so the post-build copy step
    // re-stages them next to the bare release exe.
    println!("cargo:rerun-if-changed=../server-jarvis/dist/index.js");
    println!("cargo:rerun-if-changed=../scripts/claude_cli_proxy.py");
    println!("cargo:rerun-if-changed=../scripts/opencode_go_openai_models.json");

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

    // Best-effort: in release builds, copy runtime resources next to the
    // produced exe. Tauri `bundle.resources` only stages files inside the
    // NSIS installer; a bare `cargo tauri build` output (target/release/home-base.exe)
    // would otherwise ship with no index.js beside it and the runtime's
    // portable lookup would still find the repo-rooted dev copy, masking
    // the issue. Doing it here makes the bare exe self-contained.
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        copy_release_resources_next_to_exe();
    }

    tauri_build::build();
}

fn copy_release_resources_next_to_exe() {
    // OUT_DIR is `target/<profile>/build/<pkg>-<hash>/out`; the release exe
    // lives at `target/<profile>/<exe>`. Two `..` jumps lands us there.
    let out_dir = match std::env::var("OUT_DIR") {
        Ok(p) => PathBuf::from(p),
        Err(_) => return,
    };
    let release_dir = out_dir
        .ancestors()
        .nth(3)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| out_dir.clone());
    let manifest_dir = match std::env::var("CARGO_MANIFEST_DIR") {
        Ok(p) => PathBuf::from(p),
        Err(_) => return,
    };
    let bundle_src = manifest_dir
        .parent()
        .map(|p| p.join("server-jarvis").join("dist").join("index.js"));
    let Some(bundle_src) = bundle_src else { return };
    let proxy_src = manifest_dir
        .parent()
        .map(|path| path.join("scripts").join("claude_cli_proxy.py"))
        .unwrap_or_default();
    let proxy_dest = release_dir.join("resources").join("claude_cli_proxy.py");
    if let Err(error) = release_resource_staging::copy_if_different(&proxy_src, &proxy_dest) {
        println!(
            "cargo:warning=Failed to stage Claude proxy script {} -> {}: {error}",
            proxy_src.display(),
            proxy_dest.display(),
        );
    }
    let proxy_models_src = manifest_dir
        .parent()
        .map(|path| path.join("scripts").join("opencode_go_openai_models.json"))
        .unwrap_or_default();
    let proxy_models_dest = release_dir
        .join("resources")
        .join("opencode_go_openai_models.json");
    if let Err(error) =
        release_resource_staging::copy_if_different(&proxy_models_src, &proxy_models_dest)
    {
        println!(
            "cargo:warning=Failed to stage OpenCode Go proxy model list {} -> {}: {error}",
            proxy_models_src.display(),
            proxy_models_dest.display(),
        );
    }
    if !bundle_src.exists() {
        // The Tauri beforeBuildCommand bakes the bundle; if it isn't there,
        // we can't stage it. Stay quiet — Tauri will already have complained
        // about the missing resource.
        return;
    }
    let dest = release_dir.join("index.js");
    if dest.exists() {
        // Don't clobber a fresher build artifact that another invocation
        // produced. Read-then-write only when the source is newer.
        let src_newer = bundle_src
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .zip(dest.metadata().and_then(|m| m.modified()).ok())
            .map(|(a, b)| a > b)
            .unwrap_or(true);
        if !src_newer {
            return;
        }
    }
    if let Err(e) = std::fs::copy(&bundle_src, &dest) {
        eprintln!(
            "cargo:warning=Failed to copy server bundle {} -> {}: {}",
            bundle_src.display(),
            dest.display(),
            e
        );
    }
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
