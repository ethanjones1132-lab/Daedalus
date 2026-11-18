//! Process-local credentials for the two owned HTTP services. They live for
//! one Jarvis desktop launch, including supervised child restarts.

use std::sync::OnceLock;

pub(crate) const BUN_TOKEN_ENV: &str = "JARVIS_SERVER_TOKEN";
pub(crate) const PROXY_TOKEN_ENV: &str = "JARVIS_CLAUDE_PROXY_TOKEN";
pub(crate) const BUN_HOST_ENV: &str = "JARVIS_SERVER_HOST";

fn mint_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(crate) fn bun_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(mint_token)
}

pub(crate) fn proxy_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(mint_token)
}

/// Automation that owns this launch can receive the fresh Bun token through
/// its private, randomly named local pipe. Normal desktop launches do not
/// export the token. Never use a file, command-line argument, or stdout.
#[cfg(windows)]
pub(crate) fn handoff_bootstrap_token() -> Result<(), String> {
    use std::io::Write;
    use std::os::windows::fs::OpenOptionsExt;

    let Some(id) = std::env::var_os("JARVIS_BOOTSTRAP_PIPE") else {
        return Ok(());
    };
    let id = id
        .to_str()
        .filter(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("Invalid local automation pipe ID")?;
    let path = format!(r"\\.\pipe\jarvis-bootstrap-{id}");
    let mut pipe = std::fs::OpenOptions::new()
        .write(true)
        .share_mode(0)
        .open(path)
        .map_err(|error| format!("Could not open the local automation pipe: {error}"))?;
    writeln!(pipe, "{}", bun_token())
        .map_err(|error| format!("Could not complete the local automation handshake: {error}"))
}

#[cfg(not(windows))]
pub(crate) fn handoff_bootstrap_token() -> Result<(), String> {
    if std::env::var_os("JARVIS_BOOTSTRAP_PIPE").is_some() {
        return Err("The local automation pipe is supported only on Windows".into());
    }
    Ok(())
}

pub(crate) fn configure_bun(command: &mut std::process::Command, through_wsl: bool) {
    command
        .env(BUN_HOST_ENV, "127.0.0.1")
        .env(BUN_TOKEN_ENV, bun_token())
        .env(PROXY_TOKEN_ENV, proxy_token());
    if through_wsl {
        crate::forward_env_to_wsl(command, &[BUN_HOST_ENV, BUN_TOKEN_ENV, PROXY_TOKEN_ENV]);
    }
}

pub(crate) fn is_loopback_http(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| {
        url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

pub(crate) fn client() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
}

pub(crate) fn blocking_client() -> reqwest::blocking::ClientBuilder {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_capabilities_are_distinct_and_not_in_argv() {
        assert_eq!(bun_token().len(), 32);
        assert_eq!(proxy_token().len(), 32);
        assert_ne!(bun_token(), proxy_token());
        for through_wsl in [false, true] {
            let mut cmd = std::process::Command::new("bun");
            cmd.arg("index.js");
            configure_bun(&mut cmd, through_wsl);
            let env = |name: &str| {
                cmd.get_envs()
                    .find(|(key, _)| *key == std::ffi::OsStr::new(name))
                    .and_then(|(_, value)| value)
                    .and_then(|value| value.to_str())
            };
            assert_eq!(env(BUN_HOST_ENV), Some("127.0.0.1"));
            assert_eq!(env(BUN_TOKEN_ENV), Some(bun_token()));
            assert_eq!(env(PROXY_TOKEN_ENV), Some(proxy_token()));
            assert!(cmd.get_args().all(|arg| {
                let arg = arg.to_string_lossy();
                !arg.contains(bun_token()) && !arg.contains(proxy_token())
            }));
            if through_wsl {
                let forwarded = env("WSLENV").unwrap();
                for name in [BUN_HOST_ENV, BUN_TOKEN_ENV, PROXY_TOKEN_ENV] {
                    assert!(forwarded.split(':').any(|key| key == name));
                }
            }
        }
    }
}
