//! Fit the llama.cpp MoE expert placement to the GPU's shared-memory spill
//! (DD-146).
//!
//! On Windows the display driver spills VRAM overflow into system RAM ("shared
//! GPU memory"). Once a big MoE model starts living there, generation collapses;
//! the measured AgentFast placement keeps the experts of looped layers 6-17 on
//! the GPU, and moving the next-highest layer's experts to the CPU frees VRAM
//! again. The AutoFit loop used to do this by hand: poll the spill, drop expert
//! layers while it is above 300 MiB, and stop at the measured 6-13 floor.
//!
//! This module is the Rust half of that loop:
//!
//! - [`SharedGpuMemoryProbe`] reads the spill, with a Windows implementation and
//!   an injectable trait so tests feed recorded output and never need a GPU;
//! - [`next_gpu_expert_range`] is the pure decision: one probe reading plus the
//!   current GPU expert range in, the next range out;
//! - [`fit`] maps a [`LlamaCppConfig`] to the one to launch with.
//!
//! Everything fails open. A missing probe, a timeout, unparseable output, a
//! non-loopback `base_url`, `auto_fit = false`, or an `-ot` value the operator
//! chose all leave the config byte for byte as it was.

use super::types::LlamaCppConfig;
#[cfg(target_os = "windows")]
use std::time::Duration;

/// Above this much shared GPU memory the driver has spilled enough that the
/// highest GPU expert layer moves to the CPU. Below it, the launch is healthy.
pub const SPILL_THRESHOLD_MIB: u64 = 300;

/// First looped layer whose experts start on the GPU in the AgentFast profile.
pub const GPU_EXPERT_FIRST: u32 = 6;
/// Last looped layer whose experts start on the GPU in the AgentFast profile.
pub const GPU_EXPERT_LAST: u32 = 17;
/// Lowest measured GPU expert range: past this, a spill cannot be cleared by
/// dropping layers, so the fit stops rather than starving the GPU.
pub const GPU_EXPERT_FLOOR_LAST: u32 = 13;

/// Last expert layer in the model (the `-ot` CPU list runs to this layer).
const LAST_EXPERT_LAYER: u32 = 23;

/// The shipped AgentFast `-ot` value. Only this exact value is ours to revise:
/// a stored row that names its own placement keeps it (DD-144).
pub const AGENT_FAST_OVERRIDE_TENSOR: &str =
    r"blk\.(0|1|2|3|4|5|18|19|20|21|22|23)\.ffn_.*_exps\.=CPU";

/// Cap on the shared-memory counter read. A cold PowerShell counter read
/// normally takes about a second; a slower one fails open.
#[cfg(target_os = "windows")]
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// A missing `nvidia-smi` must not burn the whole probe budget.
#[cfg(target_os = "windows")]
const NVIDIA_SMI_TIMEOUT: Duration = Duration::from_millis(1000);

/// Cap on the probe text handed to the parser.
#[cfg(target_os = "windows")]
const PROBE_OUTPUT_LIMIT_CHARS: usize = 4096;

/// Reads how much system RAM the GPU driver currently uses for shared GPU
/// memory. Tests implement this with recorded command output.
pub trait SharedGpuMemoryProbe {
    /// Shared GPU memory in MiB, or `None` when the reading is unavailable
    /// (no probe binary, timeout, error status, unparseable output).
    fn shared_spill_mib(&self) -> Option<u64>;
}

/// The production probe.
///
/// The NVIDIA adapter is identified with `nvidia-smi` (as the AutoFit loop
/// does); a missing binary or no NVIDIA adapter is an unavailable reading.
/// The shared number itself cannot come from `nvidia-smi`: under WDDM its
/// `memory.used` reports dedicated frame-buffer memory only and it has no
/// shared-memory field, so the driver's spill is only visible through the
/// `\GPU Adapter Memory(*)\Shared Usage` performance counter. That is the same
/// figure `scripts/moe-bench/moe_sweep.py` records as `shared_spill_mib` and
/// the one the AutoFit loop polls. The probe is read-only, time-bounded and
/// fails open.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemSharedGpuMemoryProbe;

impl SharedGpuMemoryProbe for SystemSharedGpuMemoryProbe {
    fn shared_spill_mib(&self) -> Option<u64> {
        system_shared_spill_mib()
    }
}

#[cfg(target_os = "windows")]
fn system_shared_spill_mib() -> Option<u64> {
    use std::process::Command;

    if !nvidia_gpu_present() {
        return None;
    }

    let mut command = Command::new("powershell");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // The counter exposes one sample per adapter, including the iGPU; the
        // AutoFit loop takes the maximum, which is the NVIDIA adapter's spill.
        r"((Get-Counter '\GPU Adapter Memory(*)\Shared Usage' -ErrorAction Stop).CounterSamples | Measure-Object CookedValue -Maximum).Maximum",
    ]);
    let output = crate::wsl::command_output_timeout(command, PROBE_TIMEOUT)?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let bounded: String = stdout.chars().take(PROBE_OUTPUT_LIMIT_CHARS).collect();
    parse_shared_usage_mib(&bounded)
}

/// Whether `nvidia-smi` can name an NVIDIA adapter. Also the fail-open gate for
/// "no NVIDIA GPU" and "nvidia-smi missing": either is an unavailable reading.
#[cfg(target_os = "windows")]
fn nvidia_gpu_present() -> bool {
    use std::process::Command;

    let mut command = Command::new("nvidia-smi");
    command.args(["--query-gpu=name", "--format=csv,noheader"]);
    match crate::wsl::command_output_timeout(command, NVIDIA_SMI_TIMEOUT) {
        Some(output) if output.status.success() => !String::from_utf8_lossy(&output.stdout)
            .trim()
            .is_empty(),
        _ => false,
    }
}

/// Daedalus ships for Windows; elsewhere the shared-memory concept does not
/// apply to this placement, so the probe stays unavailable and the fit no-ops.
#[cfg(not(target_os = "windows"))]
fn system_shared_spill_mib() -> Option<u64> {
    None
}

/// Parse the probe's output: the counter is printed in bytes, so one decimal
/// number on its own line. Anything else (empty output, `N/A`, an error line)
/// is unavailable rather than zero.
fn parse_shared_usage_mib(output: &str) -> Option<u64> {
    let line = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .last()?;
    let bytes: f64 = line.parse().ok()?;
    if !bytes.is_finite() || bytes < 0.0 {
        return None;
    }
    Some((bytes / (1024.0 * 1024.0)).floor() as u64)
}

/// The GPU expert layers, inclusive. Dropping a layer moves it into the CPU
/// half of the `-ot` override; it never changes the layer numbering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GpuExpertRange {
    /// First layer whose experts stay on the GPU.
    pub first: u32,
    /// Last layer whose experts stay on the GPU.
    pub last: u32,
}

impl GpuExpertRange {
    /// The shipped AgentFast placement: experts of looped layers 6-17 on the
    /// GPU, every other expert layer on the CPU.
    pub const AGENT_FAST: Self = Self {
        first: GPU_EXPERT_FIRST,
        last: GPU_EXPERT_LAST,
    };

    /// The measured floor: dropping further than this does not clear a spill
    /// and only makes decoding slower.
    pub const FLOOR: Self = Self {
        first: GPU_EXPERT_FIRST,
        last: GPU_EXPERT_FLOOR_LAST,
    };

    /// The `-ot` override that keeps `[first, last]` on the GPU and names every
    /// other expert layer for the CPU.
    pub fn override_tensor(&self) -> String {
        let cpu_layers: Vec<String> = (0..=LAST_EXPERT_LAYER)
            .filter(|layer| *layer < self.first || *layer > self.last)
            .map(|layer| layer.to_string())
            .collect();
        format!(r"blk\.({})\.ffn_.*_exps\.=CPU", cpu_layers.join("|"))
    }

    /// Drop the highest GPU expert layer, clamped at [`Self::FLOOR`]. The
    /// result is never empty and never below the floor.
    pub fn drop_one(self) -> Self {
        if self.last <= GPU_EXPERT_FLOOR_LAST {
            return Self {
                first: self.first,
                last: GPU_EXPERT_FLOOR_LAST,
            };
        }
        Self {
            first: self.first,
            last: self.last - 1,
        }
    }
}

/// The pure decision helper: one probe reading and the current GPU expert
/// range in, the range to launch with out.
///
/// A reading above [`SPILL_THRESHOLD_MIB`] drops one more layer; the caller
/// re-probes after the next launch (that is how the AutoFit loop converges
/// without inventing a MiB-per-layer estimate). A missing reading, or one at
/// or below the threshold, leaves the range unchanged. The result never goes
/// below [`GpuExpertRange::FLOOR`].
pub fn next_gpu_expert_range(
    reading_mib: Option<u64>,
    current: GpuExpertRange,
) -> GpuExpertRange {
    match reading_mib {
        Some(spill) if spill > SPILL_THRESHOLD_MIB => current.drop_one(),
        _ => current,
    }
}

/// Map a llama.cpp config to the one to launch.
///
/// Operates only on the shipped AgentFast `-ot` value; every other field, and
/// every explicit operator placement, is returned unchanged. Safe to call on
/// every spawn: when the probe cannot answer, the input comes back as-is.
pub fn fit(config: LlamaCppConfig) -> LlamaCppConfig {
    fit_with_probe(&config, &SystemSharedGpuMemoryProbe)
}

/// [`fit`] with an injected probe, so tests (and the spawn follow-up) can feed
/// recorded output instead of running PowerShell.
pub fn fit_with_probe(
    config: &LlamaCppConfig,
    probe: &dyn SharedGpuMemoryProbe,
) -> LlamaCppConfig {
    if !eligible_for_fit(config) {
        return config.clone();
    }

    let next = next_gpu_expert_range(probe.shared_spill_mib(), GpuExpertRange::AGENT_FAST);
    if next == GpuExpertRange::AGENT_FAST {
        return config.clone();
    }

    let mut fitted = config.clone();
    fitted.override_tensor = next.override_tensor();
    fitted
}

/// Only the shipped AgentFast placement is the fit's to revise: `auto_fit` must
/// be on, the server must be local, and the row must carry exactly the shipped
/// `-ot` value (not blank, not a legacy placement, not the operator's own).
fn eligible_for_fit(config: &LlamaCppConfig) -> bool {
    config.auto_fit
        && is_loopback_base_url(&config.base_url)
        && config.override_tensor.trim() == AGENT_FAST_OVERRIDE_TENSOR
}

/// A local llama.cpp server. Fitting a remote server to this machine's GPU
/// spill would be meaningless, so a non-loopback `base_url` disables the fit.
fn is_loopback_base_url(base_url: &str) -> bool {
    let trimmed = base_url.trim();
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let authority = without_scheme.split('/').next().unwrap_or("");
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

#[cfg(test)]
mod gpu_fit_tests {
    use super::*;

    /// Recorded probe output, parsed by the same code the production probe uses.
    struct RecordedOutput(&'static str);

    impl SharedGpuMemoryProbe for RecordedOutput {
        fn shared_spill_mib(&self) -> Option<u64> {
            parse_shared_usage_mib(self.0)
        }
    }

    /// A probe that could not run at all (missing binary, spawn error, timeout).
    struct UnavailableProbe;

    impl SharedGpuMemoryProbe for UnavailableProbe {
        fn shared_spill_mib(&self) -> Option<u64> {
            None
        }
    }

    fn launch_config() -> LlamaCppConfig {
        LlamaCppConfig {
            model_path: "inkling.gguf".to_string(),
            ..LlamaCppConfig::default()
        }
    }

    fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .map(String::as_str)
    }

    /// "Byte for byte": the whole config, not just the `-ot` field.
    fn as_json(config: &LlamaCppConfig) -> String {
        serde_json::to_string(config).expect("LlamaCppConfig serializes")
    }

    /// 260 MiB, recorded from a healthy AgentFast launch.
    const HEALTHY_SHARED_BYTES: &str = "272629760";
    /// 1000 MiB, recorded from a launch that spilled to shared GPU memory.
    const SPILLED_SHARED_BYTES: &str = "1048576000";

    const ONE_LAYER_DROPPED: &str =
        r"blk\.(0|1|2|3|4|5|17|18|19|20|21|22|23)\.ffn_.*_exps\.=CPU";
    const FLOOR_OVERRIDE: &str =
        r"blk\.(0|1|2|3|4|5|14|15|16|17|18|19|20|21|22|23)\.ffn_.*_exps\.=CPU";

    #[test]
    fn shipped_default_is_the_agent_fast_range() {
        assert_eq!(
            GpuExpertRange::AGENT_FAST.override_tensor(),
            AGENT_FAST_OVERRIDE_TENSOR
        );
        assert_eq!(
            LlamaCppConfig::default().override_tensor,
            AGENT_FAST_OVERRIDE_TENSOR
        );
        assert!(LlamaCppConfig::default().auto_fit);
    }

    #[test]
    fn healthy_reading_leaves_the_agent_fast_range_unchanged() {
        let original = launch_config();
        let fitted = fit_with_probe(&original, &RecordedOutput(HEALTHY_SHARED_BYTES));

        assert_eq!(fitted.override_tensor, AGENT_FAST_OVERRIDE_TENSOR);
        assert_eq!(flag(&fitted.server_args(false), "-ot"), Some(AGENT_FAST_OVERRIDE_TENSOR));
        assert_eq!(as_json(&fitted), as_json(&original));
    }

    #[test]
    fn reading_at_the_threshold_is_not_a_spill() {
        let original = launch_config();
        // Exactly 300 MiB is healthy: only *above* the threshold drops a layer.
        let fitted = fit_with_probe(&original, &RecordedOutput("314572800"));
        assert_eq!(as_json(&fitted), as_json(&original));
    }

    #[test]
    fn recorded_counter_output_is_read_in_bytes() {
        // `Get-Counter` prints bytes with a trailing newline.
        assert_eq!(parse_shared_usage_mib("272629760\r\n"), Some(260));
        assert_eq!(parse_shared_usage_mib("1048576000\n"), Some(1000));
        assert_eq!(parse_shared_usage_mib("0"), Some(0));
        assert_eq!(parse_shared_usage_mib("-1"), None);
    }

    #[test]
    fn spill_drops_a_gpu_expert_layer_into_the_ot_cpu_list() {
        let fitted = fit_with_probe(&launch_config(), &RecordedOutput(SPILLED_SHARED_BYTES));

        // 6-17 becomes 6-16; the `-ot` CPU list gains 17 at the bottom.
        assert_eq!(fitted.override_tensor, ONE_LAYER_DROPPED);
        assert_eq!(flag(&fitted.server_args(false), "-ot"), Some(ONE_LAYER_DROPPED));
        // Every other launch value is untouched.
        assert_eq!(flag(&fitted.server_args(false), "-c"), Some("57344"));
        assert_eq!(flag(&fitted.server_args(false), "-ctk"), Some("q4_0"));
    }

    #[test]
    fn repeated_spills_stop_at_the_6_to_13_floor() {
        let mut range = GpuExpertRange::AGENT_FAST;
        for _ in 0..50 {
            range = next_gpu_expert_range(Some(5000), range);
            assert!(
                range.last >= GPU_EXPERT_FLOOR_LAST,
                "the GPU expert range fell below the measured floor: {range:?}"
            );
        }
        assert_eq!(range, GpuExpertRange::FLOOR);
        assert_eq!(range.override_tensor(), FLOOR_OVERRIDE);
    }

    #[test]
    fn an_above_floor_spill_that_cannot_be_cleared_still_returns_the_floor() {
        let range = next_gpu_expert_range(Some(4096), GpuExpertRange::FLOOR);
        assert_eq!(range, GpuExpertRange::FLOOR);
        assert_eq!(range.override_tensor(), FLOOR_OVERRIDE);
    }

    #[test]
    fn unavailable_probe_returns_the_agent_fast_config_byte_for_byte() {
        let original = launch_config();
        // Missing binary / spawn failure / timeout: the probe never answered.
        let fitted = fit_with_probe(&original, &UnavailableProbe);
        assert_eq!(as_json(&fitted), as_json(&original));
        assert_eq!(fitted.server_args(false), original.server_args(false));
        assert_eq!(flag(&fitted.server_args(false), "-ot"), Some(AGENT_FAST_OVERRIDE_TENSOR));
    }

    #[test]
    fn unparseable_probe_output_returns_the_agent_fast_config_byte_for_byte() {
        let original = launch_config();
        for garbage in ["", "N/A", "not a number", "12 MiB", "NaN"] {
            let fitted = fit_with_probe(&original, &RecordedOutput(garbage));
            assert_eq!(
                as_json(&fitted),
                as_json(&original),
                "garbage probe output {garbage:?} changed the launch"
            );
        }
    }

    #[test]
    fn a_stored_row_without_auto_fit_defaults_it_on() {
        // A row saved before DD-146 must not silently opt out of fitting; the
        // shipped `-ot` gate still keeps its own placement untouched.
        let stored = r#"{"server_path":"s","model_path":"p"}"#;
        let config: LlamaCppConfig = serde_json::from_str(stored).unwrap();
        assert!(config.auto_fit);
    }

    #[test]
    fn a_config_that_names_its_own_ot_value_keeps_it() {
        let mut original = launch_config();
        // DD-144 "Agent" placement: the operator's own value, not the shipped one.
        original.override_tensor =
            r"blk\.(0|1|2|3|4|5|15|16|17|18|19|20|21|22|23)\.ffn_.*_exps\.=CPU".to_string();

        let fitted = fit_with_probe(&original, &RecordedOutput(SPILLED_SHARED_BYTES));
        assert_eq!(as_json(&fitted), as_json(&original));
        assert_eq!(fitted.override_tensor, original.override_tensor);
    }

    #[test]
    fn auto_fit_off_keeps_the_shipped_override() {
        let mut original = launch_config();
        original.auto_fit = false;

        let fitted = fit_with_probe(&original, &RecordedOutput(SPILLED_SHARED_BYTES));
        assert_eq!(as_json(&fitted), as_json(&original));
        assert_eq!(fitted.override_tensor, AGENT_FAST_OVERRIDE_TENSOR);
    }

    #[test]
    fn a_non_local_server_is_not_fitted() {
        let mut original = launch_config();
        original.base_url = "http://192.168.1.10:8080/v1".to_string();

        let fitted = fit_with_probe(&original, &RecordedOutput(SPILLED_SHARED_BYTES));
        assert_eq!(as_json(&fitted), as_json(&original));
    }

    #[test]
    fn loopback_base_urls_are_recognized() {
        for local in [
            "http://127.0.0.1:8080/v1",
            "https://localhost:8080/v1",
            "http://[::1]:8080/v1",
            "127.0.0.1:8080",
        ] {
            assert!(is_loopback_base_url(local), "{local} should be local");
        }
        for remote in [
            "http://192.168.1.10:8080/v1",
            "https://llama.example.com/v1",
            "",
        ] {
            assert!(!is_loopback_base_url(remote), "{remote} should not be local");
        }
    }
}
