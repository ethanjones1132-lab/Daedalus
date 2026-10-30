//! When a pre-spawn HTTP health probe can prove nothing for the Bun child.
//!
//! `ensure_jarvis_server_started` owns the Bun child and its readiness gate.
//! Before DD-023 it always paid the candidate probe budget (2s per candidate)
//! even when the native listener was provably closed — a guaranteed miss on
//! every cold start. Skipping the probe is only safe when the native port is
//! closed *and* every candidate endpoint is that native listener: a configured
//! remote `JARVIS_API`, a cached WSL URL, or a WSL-launched Bun can all be
//! healthy while Windows loopback is closed, so those stay probe-first.

/// True only for endpoints the native listener check already covers: a
/// loopback host on the native Bun port. Anything else (remote host, another
/// local port, unparseable config) must still be probed before spawning.
pub(crate) fn endpoint_covered_by_native_listener(candidate: &str, native_port: u16) -> bool {
    let Ok(url) = reqwest::Url::parse(candidate.trim()) else {
        return false;
    };
    let loopback_host = matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1")
    );
    loopback_host && url.port_or_known_default() == Some(native_port)
}

/// Decide whether the HTTP health probe still has to run before the owned
/// child is spawned, given that the native listener check reported "closed".
///
/// WSL launching always probes: a closed Windows loopback port does not prove
/// the Linux listener absent, and hostname discovery is part of the probe.
pub(crate) fn pre_spawn_probe_required(
    bun_uses_wsl: bool,
    candidates: &[String],
    native_port: u16,
) -> bool {
    if bun_uses_wsl {
        return true;
    }
    candidates
        .iter()
        .any(|candidate| !endpoint_covered_by_native_listener(candidate, native_port))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidates(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn native_loopback_candidates_are_covered_by_the_listener_check() {
        assert!(endpoint_covered_by_native_listener(
            "http://127.0.0.1:19877",
            19877
        ));
        assert!(endpoint_covered_by_native_listener(
            "http://localhost:19877/",
            19877
        ));
        assert!(endpoint_covered_by_native_listener(
            "http://[::1]:19877",
            19877
        ));
    }

    #[test]
    fn remote_or_otherwise_local_candidates_still_need_a_probe() {
        assert!(!endpoint_covered_by_native_listener(
            "http://192.168.1.20:19877",
            19877
        ));
        assert!(!endpoint_covered_by_native_listener(
            "http://127.0.0.1:19878",
            19877
        ));
        assert!(!endpoint_covered_by_native_listener(
            "https://jarvis.example.com",
            19877
        ));
        assert!(!endpoint_covered_by_native_listener("not a url", 19877));
    }

    #[test]
    fn probe_is_skipped_only_for_local_only_native_launches() {
        let local = candidates(&["http://127.0.0.1:19877", "http://localhost:19877"]);
        assert!(!pre_spawn_probe_required(false, &local, 19877));
        assert!(pre_spawn_probe_required(true, &local, 19877));

        let forward_or_remote = candidates(&["http://127.0.0.1:19877", "http://172.24.16.1:19877"]);
        assert!(pre_spawn_probe_required(false, &forward_or_remote, 19877));

        let remote_configured = candidates(&["http://jarvis.example.com:19877"]);
        assert!(pre_spawn_probe_required(false, &remote_configured, 19877));
    }
}
