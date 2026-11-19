// DD-104: the packaged Diagnostics disk and memory rows must read real values
// on Windows. That needs two things pinned here: the probes run as plain
// `wsl.exe -- bash -lc "<command>"` (never through `wsl_openclaw`, which would
// run `openclaw df`), and the parsers still read today's output formats.
//
// DD-118: on a native install those WSL probes are only the fallback. The disk
// and memory rows come from the Windows API, and what remains of the WSL
// diagnostic is cached instead of being re-probed on every 30 s footer poll.

use super::system::{
    cached_wsl_diagnostic_in, disk_health_from_bytes, disk_health_with, memory_health_from_bytes,
    memory_health_with, parse_df_probe, parse_meminfo, shell_probe_invocation, DF_PROBE_COMMAND,
    MEMINFO_PROBE_COMMAND, WSL_DIAGNOSTIC_TTL,
};

/// The exact `df` argv expected on the target platform.
fn expected_disk_argv() -> (&'static str, Vec<String>) {
    if cfg!(target_os = "windows") {
        (
            "wsl.exe",
            vec![
                "--".to_string(),
                "bash".to_string(),
                "-lc".to_string(),
                DF_PROBE_COMMAND.to_string(),
            ],
        )
    } else {
        (
            "bash",
            vec!["-lc".to_string(), DF_PROBE_COMMAND.to_string()],
        )
    }
}

fn expected_meminfo_argv() -> (&'static str, Vec<String>) {
    if cfg!(target_os = "windows") {
        (
            "wsl.exe",
            vec![
                "--".to_string(),
                "bash".to_string(),
                "-lc".to_string(),
                MEMINFO_PROBE_COMMAND.to_string(),
            ],
        )
    } else {
        (
            "bash",
            vec!["-lc".to_string(), MEMINFO_PROBE_COMMAND.to_string()],
        )
    }
}

#[test]
fn the_disk_probe_runs_as_a_plain_wsl_shell_command() {
    let (program, args) = shell_probe_invocation(DF_PROBE_COMMAND);
    let (expected_program, expected_args) = expected_disk_argv();

    assert_eq!(program, expected_program);
    assert_eq!(args, expected_args);

    // The command reaches bash byte for byte: no `openclaw ` prefix, no
    // re-quoting, no extra subcommand.
    assert_eq!(args.last().map(String::as_str), Some(DF_PROBE_COMMAND));
    assert_eq!(DF_PROBE_COMMAND, "df -BG --output=size,used,avail,pcent /");
    assert!(
        !args.iter().any(|arg| arg.contains("openclaw")),
        "disk probe argv must not mention openclaw: {program} {args:?}"
    );
}

#[test]
fn the_memory_probe_runs_as_a_plain_wsl_shell_command() {
    let (program, args) = shell_probe_invocation(MEMINFO_PROBE_COMMAND);
    let (expected_program, expected_args) = expected_meminfo_argv();

    assert_eq!(program, expected_program);
    assert_eq!(args, expected_args);

    assert_eq!(args.last().map(String::as_str), Some(MEMINFO_PROBE_COMMAND));
    assert_eq!(MEMINFO_PROBE_COMMAND, "cat /proc/meminfo");
    assert!(
        !args.iter().any(|arg| arg.contains("openclaw")),
        "memory probe argv must not mention openclaw: {program} {args:?}"
    );
}

#[test]
fn the_health_probes_do_not_call_wsl_openclaw() {
    // `shell_probe_invocation` can be right while a caller bypasses it. The
    // disk and memory health functions must only use the plain shell probe.
    let source = include_str!("system.rs");
    let start = source
        .find("fn disk_health()")
        .expect("disk_health must exist in system.rs");
    let end = source
        .find("fn claude_proxy_doctor_check")
        .expect("claude_proxy_doctor_check must follow the health probes");
    let probe_region = &source[start..end];
    assert!(
        !probe_region.contains("wsl_openclaw("),
        "disk/memory probes regressed to wsl_openclaw (openclaw prefix)"
    );
    assert!(probe_region.contains("shell_probe("));
}

#[test]
fn the_df_parser_reads_the_four_columns() {
    // `df -BG --output=size,used,avail,pcent /`: header, then one data line.
    let sample = "1G-blocks Used Avail Use%\n       50G  20G   30G  40%\n";
    let disk = parse_df_probe(sample).expect("data line must parse");

    assert_eq!(disk.total, "50G");
    assert_eq!(disk.used, "20G");
    assert_eq!(disk.available, "30G");
    assert_eq!(disk.use_percent, "40%");
}

#[test]
fn the_df_parser_rejects_output_without_a_data_line() {
    assert!(parse_df_probe("").is_none());
    assert!(parse_df_probe("1G-blocks Used Avail Use%\n").is_none());
}

#[test]
fn the_meminfo_parser_reads_total_and_available() {
    let sample = "MemTotal:       16384000 kB\n\
                  MemFree:         1000000 kB\n\
                  MemAvailable:    8192000 kB\n\
                  Buffers:          100000 kB\n";
    let memory = parse_meminfo(sample).expect("MemTotal/MemAvailable must parse");

    assert_eq!(memory.total_mb, 16_000);
    assert_eq!(memory.available_mb, 8_000);
    assert_eq!(memory.used_mb, 8_000);
    assert_eq!(memory.used_percent, 50);
}

#[test]
fn the_meminfo_parser_rejects_incomplete_output() {
    assert!(parse_meminfo("").is_none());
    assert!(parse_meminfo("MemTotal: 16384000 kB\n").is_none());
    assert!(parse_meminfo("MemAvailable: 8192000 kB\n").is_none());
}

// ── DD-118: native readings and the cached WSL diagnostic ────────────────

/// On a native Windows install the footer's disk and memory rows are read with
/// the Windows API, not by spawning `wsl.exe`. The fallback probe handed to the
/// seam records a spawn and fails, so any regression to the shell on the native
/// path is caught here instead of at runtime, where a `?`/0 row still looks
/// "handled".
#[test]
#[cfg(target_os = "windows")]
fn a_native_install_reads_disk_and_memory_without_spawning_a_shell() {
    use super::system::{native_disk_usage, native_memory_usage};

    let disk_spawned = std::cell::Cell::new(false);
    let disk = disk_health_with(native_disk_usage, || {
        disk_spawned.set(true);
        Err("a native install must not run the WSL disk probe".to_string())
    });
    assert!(
        !disk_spawned.get(),
        "native disk reading spawned a shell: {disk:?}"
    );
    assert_ne!(disk.total, "?", "native disk total is the '?' sentinel");
    assert_ne!(disk.used, "?", "native disk used is the '?' sentinel");
    assert_ne!(disk.available, "?", "native disk available is the '?' sentinel");
    assert!(
        disk.use_percent.ends_with('%'),
        "native disk percent is not a reading: {disk:?}"
    );
    assert!(
        disk.total.ends_with('G') || disk.total.ends_with('M'),
        "native disk total is not a size: {disk:?}"
    );

    let memory_spawned = std::cell::Cell::new(false);
    let memory = memory_health_with(native_memory_usage, || {
        memory_spawned.set(true);
        Err("a native install must not run the WSL memory probe".to_string())
    });
    assert!(
        !memory_spawned.get(),
        "native memory reading spawned a shell: {memory:?}"
    );
    assert!(
        memory.total_mb > 0,
        "native memory total is the zeroed sentinel: {memory:?}"
    );
    assert!(memory.used_percent <= 100, "memory percent out of range: {memory:?}");
    assert!(
        memory.used_mb <= memory.total_mb,
        "memory used exceeds total: {memory:?}"
    );
}

#[test]
fn the_native_readings_are_real_numbers() {
    // The byte-to-row arithmetic is pure, so it is pinned without the OS: a
    // 1 TB volume with 400 GB free and 350 GB available to callers.
    let disk = disk_health_from_bytes(1_000_000_000_000, 400_000_000_000, 350_000_000_000);
    assert_eq!(disk.total, "1000G");
    assert_eq!(disk.used, "600G");
    assert_eq!(disk.available, "350G");
    assert_eq!(disk.use_percent, "60%");

    let memory = memory_health_from_bytes(16 * 1024 * 1024 * 1024, 8 * 1024 * 1024 * 1024);
    assert_eq!(memory.total_mb, 16_384);
    assert_eq!(memory.available_mb, 8_192);
    assert_eq!(memory.used_mb, 8_192);
    assert_eq!(memory.used_percent, 50);
}

#[test]
fn the_health_rows_prefer_the_native_reader_and_cache_the_wsl_fallback() {
    // The seams can be right while a caller bypasses them. `shell_probe` can be
    // pinned to the right argv and still be called on every poll, so the row
    // builders themselves must route the fallback through the cache (DD-118).
    let source = include_str!("system.rs");
    let start = source
        .find("fn disk_health()")
        .expect("disk_health must exist in system.rs");
    let end = source
        .find("fn claude_proxy_doctor_check")
        .expect("claude_proxy_doctor_check must follow the health probes");
    let region = &source[start..end];

    assert!(
        region.contains("disk_health_with(native_disk_usage"),
        "disk_health must prefer the Windows API reading"
    );
    assert!(
        region.contains("memory_health_with(native_memory_usage"),
        "memory_health must prefer the Windows API reading"
    );

    let shell_probe_lines: Vec<&str> = region
        .lines()
        .filter(|line| line.contains("shell_probe("))
        .collect();
    assert_eq!(
        shell_probe_lines.len(),
        2,
        "disk and memory each keep exactly one WSL fallback probe"
    );
    for line in shell_probe_lines {
        assert!(
            line.contains("cached_wsl_diagnostic("),
            "health row spawned the WSL probe uncached: {line}"
        );
    }
}

#[test]
fn a_wsl_diagnostic_is_cached_instead_of_reprobed_on_every_poll() {
    let cache = std::sync::Mutex::new(std::collections::HashMap::new());
    let ttl = WSL_DIAGNOSTIC_TTL;
    let fetched_at = std::time::Instant::now();
    let mut probes = 0u32;

    let first = cached_wsl_diagnostic_in(&cache, ttl, DF_PROBE_COMMAND, fetched_at, || {
        probes += 1;
        Ok("first answer".to_string())
    });
    assert_eq!(first.as_deref().ok(), Some("first answer"));

    // The next footer poll, 30 s later, replays the cached answer: no spawn.
    let second = cached_wsl_diagnostic_in(
        &cache,
        ttl,
        DF_PROBE_COMMAND,
        fetched_at + std::time::Duration::from_secs(30),
        || {
            probes += 1;
            Ok("second answer".to_string())
        },
    );
    assert_eq!(second.as_deref().ok(), Some("first answer"));
    assert_eq!(probes, 1, "a cached WSL diagnostic was re-probed");

    // A failure is cached too: a broken or absent WSL must not pay its timeout
    // on every 30 s tick.
    let failure = cached_wsl_diagnostic_in(&cache, ttl, MEMINFO_PROBE_COMMAND, fetched_at, || {
        probes += 1;
        Err("wsl.exe is not available".to_string())
    });
    assert!(failure.is_err());
    let repeated = cached_wsl_diagnostic_in(
        &cache,
        ttl,
        MEMINFO_PROBE_COMMAND,
        fetched_at + std::time::Duration::from_secs(30),
        || {
            probes += 1;
            Ok("unexpected re-probe".to_string())
        },
    );
    assert!(repeated.is_err(), "a cached WSL failure was re-probed inside the TTL");
    assert_eq!(probes, 2, "a cached WSL failure was re-probed");

    // Past the TTL the diagnostic is refreshed once.
    let refreshed = cached_wsl_diagnostic_in(
        &cache,
        ttl,
        DF_PROBE_COMMAND,
        fetched_at + ttl + std::time::Duration::from_secs(1),
        || {
            probes += 1;
            Ok("third answer".to_string())
        },
    );
    assert_eq!(refreshed.as_deref().ok(), Some("third answer"));
    assert_eq!(probes, 3);
}
