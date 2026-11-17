// DD-104: the packaged Diagnostics disk and memory rows must read real values
// on Windows. That needs two things pinned here: the probes run as plain
// `wsl.exe -- bash -lc "<command>"` (never through `wsl_openclaw`, which would
// run `openclaw df`), and the parsers still read today's output formats.

use super::system::{
    parse_df_probe, parse_meminfo, shell_probe_invocation, DF_PROBE_COMMAND,
    MEMINFO_PROBE_COMMAND,
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
