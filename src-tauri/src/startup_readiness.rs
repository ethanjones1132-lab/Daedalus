//! Cold-start stage stamps (DD-140).
//!
//! Packaged startup is currently measured by inference: the log says when
//! pieces started, but nothing says how long the whole boot took or which
//! stage owned the time between process start, a healthy bundled server and a
//! window the user can actually see. This module records that path.
//!
//! Five stages are stamped with a monotonic millisecond offset from the point
//! `run()` is entered (the first line of `main`, so effectively process start):
//!
//! 1. [`Stage::ProcessStart`] — `run()` entry.
//! 2. [`Stage::SidecarSpawnIssued`] — immediately before `spawn_managed` is
//!    called for the bundled Bun server (whichever of the three launch paths).
//! 3. [`Stage::ServerHealthy`] — the first successful `/health` probe
//!    (`mark_healthy` inside `ensure_jarvis_server_started_outcome`).
//! 4. [`Stage::BootstrapReturned`] — the end of the boot work in
//!    `bootstrap_services`, immediately before the cron scheduler loop takes
//!    the thread forever. `bootstrap_services` has no actual `return`, so this
//!    is the honest stand-in: everything boot does is done at this point.
//! 5. [`Stage::WindowShown`] — the first finished page load of the `main`
//!    webview (`Builder::on_page_load`). The Tauri window itself is created and
//!    shown from `tauri.conf.json` before this fires; a finished page load is
//!    the earliest "the window actually has the app in it" signal the app
//!    exposes without changing its boot order.
//!
//! Each new stamp logs the current summary on one `jarvis::startup` line with
//! a stable `cold-start:` prefix, so a probe can parse it. Earlier lines of a
//! boot are partial (`complete=no`, unreached stages read `missing`); the line
//! with `complete=yes` carries every stage. Stamps are first-write-wins, so a
//! restart or a reload later in the process lifetime cannot overwrite the
//! cold-start numbers.
//!
//! Field order is fixed by [`Stage::ORDER`] and pinned by the tests below: a
//! future edit cannot drop or reorder a stage without failing them.

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Number of cold-start stages; the stamp array and summary are sized by it.
pub(crate) const STAGE_COUNT: usize = 5;

/// A point in the cold-start path. Declaration order is the order the summary
/// prints, and the discriminant indexes the stamp array.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    ProcessStart = 0,
    SidecarSpawnIssued = 1,
    ServerHealthy = 2,
    BootstrapReturned = 3,
    WindowShown = 4,
}

impl Stage {
    /// The stages in report order. Any edit here is a visible change to every
    /// cold-start line, which `summary_field_order_is_fixed` pins.
    pub(crate) const ORDER: [Stage; STAGE_COUNT] = [
        Stage::ProcessStart,
        Stage::SidecarSpawnIssued,
        Stage::ServerHealthy,
        Stage::BootstrapReturned,
        Stage::WindowShown,
    ];

    /// The summary key for this stage's absolute stamp.
    pub(crate) const fn key(self) -> &'static str {
        match self {
            Stage::ProcessStart => "process_start_ms",
            Stage::SidecarSpawnIssued => "sidecar_spawn_ms",
            Stage::ServerHealthy => "server_health_ms",
            Stage::BootstrapReturned => "bootstrap_return_ms",
            Stage::WindowShown => "window_shown_ms",
        }
    }

    const fn index(self) -> usize {
        self as usize
    }
}

/// One boot's stamps, measured from a monotonic origin.
///
/// The clock is injectable through [`ColdStart::record_at`] and
/// [`ColdStart::summary_at`]; production code uses the [`Instant`] origin.
pub(crate) struct ColdStart {
    origin: Instant,
    stamps: Mutex<[Option<u64>; STAGE_COUNT]>,
}

impl ColdStart {
    pub(crate) fn new(origin: Instant) -> Self {
        Self {
            origin,
            stamps: Mutex::new([None; STAGE_COUNT]),
        }
    }

    /// Milliseconds since this boot's origin.
    pub(crate) fn elapsed_ms(&self) -> u64 {
        self.origin.elapsed().as_millis() as u64
    }

    /// Record `stage` at the current monotonic time. Returns whether this call
    /// set the stage for the first time; a stage already stamped is left alone
    /// (first-write-wins).
    pub(crate) fn record(&self, stage: Stage) -> bool {
        let now = self.elapsed_ms();
        self.record_at(stage, now)
    }

    /// Record `stage` at an explicit millisecond offset. Returns whether the
    /// stamp was set by this call. Test seam for a mocked clock.
    pub(crate) fn record_at(&self, stage: Stage, at_ms: u64) -> bool {
        let mut stamps = self
            .stamps
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let slot = &mut stamps[stage.index()];
        if slot.is_some() {
            return false;
        }
        *slot = Some(at_ms);
        true
    }

    /// The stamp for `stage`, if it was recorded.
    #[cfg(test)]
    pub(crate) fn stamp(&self, stage: Stage) -> Option<u64> {
        self.stamps
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())[stage.index()]
    }

    /// Whether every stage has been stamped.
    #[cfg(test)]
    pub(crate) fn complete(&self) -> bool {
        self.stamps
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .all(Option::is_some)
    }

    /// The summary line at the current monotonic time.
    pub(crate) fn summary(&self) -> String {
        self.summary_at(self.elapsed_ms())
    }

    /// The summary line at an explicit millisecond offset. Pure: it reads only
    /// the recorded stamps and `now_ms`, so a test can pin it against a
    /// scripted clock.
    ///
    /// Shape (one log line, stable keys, fixed order):
    ///
    /// ```text
    /// cold-start: complete=yes process_start_ms=0 sidecar_spawn_ms=42 \
    ///   server_health_ms=1840 bootstrap_return_ms=2103 window_shown_ms=964 \
    ///   total_ms=2103 spawn_after_start_ms=42 health_after_spawn_ms=1798 \
    ///   bootstrap_after_health_ms=263 window_after_health_ms=-876
    /// ```
    ///
    /// A stage that has not been reached reads `missing`, and any delta that
    /// needs it reads `missing` too. Deltas are signed: a window that finished
    /// loading before the server answered `/health` reports a negative
    /// `window_after_health_ms` instead of hiding the ordering.
    pub(crate) fn summary_at(&self, now_ms: u64) -> String {
        let stamps = *self
            .stamps
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut line = String::from("cold-start: complete=");
        line.push_str(if stamps.iter().all(Option::is_some) {
            "yes"
        } else {
            "no"
        });
        for stage in Stage::ORDER {
            push_stamp(&mut line, stage.key(), stamps[stage.index()]);
        }
        push_stamp(&mut line, "total_ms", Some(now_ms));

        let start = stamps[Stage::ProcessStart.index()];
        let spawn = stamps[Stage::SidecarSpawnIssued.index()];
        let health = stamps[Stage::ServerHealthy.index()];
        let bootstrap = stamps[Stage::BootstrapReturned.index()];
        let window = stamps[Stage::WindowShown.index()];

        push_delta(&mut line, "spawn_after_start_ms", start, spawn);
        push_delta(&mut line, "health_after_spawn_ms", spawn, health);
        push_delta(&mut line, "bootstrap_after_health_ms", health, bootstrap);
        // The stage the measurement exists for: how far the window trails the
        // server being ready. Negative means the window was already loaded.
        push_delta(&mut line, "window_after_health_ms", health, window);
        line
    }
}

fn push_stamp(line: &mut String, key: &str, value: Option<u64>) {
    line.push(' ');
    line.push_str(key);
    line.push('=');
    match value {
        Some(millis) => line.push_str(&millis.to_string()),
        None => line.push_str("missing"),
    }
}

fn push_delta(line: &mut String, key: &str, from: Option<u64>, to: Option<u64>) {
    line.push(' ');
    line.push_str(key);
    line.push('=');
    match (from, to) {
        (Some(from), Some(to)) => line.push_str(&(to as i64 - from as i64).to_string()),
        _ => line.push_str("missing"),
    }
}

/// The process-wide cold-start record. Created on the first stamp, which is
/// `run()` entry, so the origin is process start as this app can observe it.
static COLD_START: OnceLock<ColdStart> = OnceLock::new();

fn cold_start() -> &'static ColdStart {
    COLD_START.get_or_init(|| ColdStart::new(Instant::now()))
}

fn note(stage: Stage) {
    let boot = cold_start();
    // Before `tauri-plugin-log` is installed the log macro is a no-op; the
    // stamp is still recorded and appears in the next line that is logged.
    if boot.record(stage) {
        log::info!(target: "jarvis::startup", "{}", boot.summary());
    }
}

/// `run()` has been entered. Call once, first thing.
pub(crate) fn note_process_start() {
    note(Stage::ProcessStart);
}

/// The bundled Bun child spawn is being issued.
pub(crate) fn note_sidecar_spawn_issued() {
    note(Stage::SidecarSpawnIssued);
}

/// A `/health` probe answered successfully for the first time.
pub(crate) fn note_server_healthy() {
    note(Stage::ServerHealthy);
}

/// The boot work in `bootstrap_services` is done; the thread now belongs to
/// the cron scheduler loop.
pub(crate) fn note_bootstrap_returned() {
    note(Stage::BootstrapReturned);
}

/// The `main` webview finished its first page load.
pub(crate) fn note_window_shown() {
    note(Stage::WindowShown);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamped(pairs: &[(Stage, u64)]) -> ColdStart {
        let boot = ColdStart::new(std::time::Instant::now());
        for (stage, at_ms) in pairs {
            assert!(boot.record_at(*stage, *at_ms), "{stage:?} stamped twice");
        }
        boot
    }

    /// The full line, with a mocked clock: a scripted sequence of stamps and a
    /// scripted `now` must produce exactly this line. Any dropped or reordered
    /// stage changes the string and fails here.
    #[test]
    fn summary_line_is_built_from_recorded_stamps() {
        let boot = stamped(&[
            (Stage::ProcessStart, 0),
            (Stage::SidecarSpawnIssued, 42),
            (Stage::ServerHealthy, 1_840),
            (Stage::BootstrapReturned, 2_103),
            (Stage::WindowShown, 964),
        ]);

        assert_eq!(
            boot.summary_at(2_103),
            "cold-start: complete=yes \
             process_start_ms=0 sidecar_spawn_ms=42 server_health_ms=1840 \
             bootstrap_return_ms=2103 window_shown_ms=964 total_ms=2103 \
             spawn_after_start_ms=42 health_after_spawn_ms=1798 \
             bootstrap_after_health_ms=263 window_after_health_ms=-876"
        );
    }

    /// A partial boot still reports the reached stages and marks the rest, so
    /// an early failure cannot be silently mistaken for a complete measurement.
    #[test]
    fn partial_boot_reports_missing_stages_and_deltas() {
        let boot = stamped(&[(Stage::ProcessStart, 0), (Stage::SidecarSpawnIssued, 17)]);

        assert_eq!(
            boot.summary_at(25),
            "cold-start: complete=no \
             process_start_ms=0 sidecar_spawn_ms=17 server_health_ms=missing \
             bootstrap_return_ms=missing window_shown_ms=missing total_ms=25 \
             spawn_after_start_ms=17 health_after_spawn_ms=missing \
             bootstrap_after_health_ms=missing window_after_health_ms=missing"
        );
        assert!(!boot.complete());
    }

    /// Stamps are first-write-wins: a supervisor restart or a page reload must
    /// not overwrite the cold-start measurement.
    #[test]
    fn first_stamp_wins_and_is_not_overwritten() {
        let boot = stamped(&[
            (Stage::ProcessStart, 0),
            (Stage::ServerHealthy, 1_500),
        ]);
        assert!(
            !boot.record_at(Stage::ServerHealthy, 90_000),
            "a second /health success must not replace the first"
        );
        assert_eq!(boot.stamp(Stage::ServerHealthy), Some(1_500));
        assert!(!boot.record(Stage::ServerHealthy));
    }

    /// The summary's field order and keys are part of the probe contract.
    #[test]
    fn summary_field_order_is_fixed() {
        let boot = stamped(&[
            (Stage::ProcessStart, 0),
            (Stage::SidecarSpawnIssued, 5),
            (Stage::ServerHealthy, 6),
            (Stage::BootstrapReturned, 7),
            (Stage::WindowShown, 8),
        ]);
        let line = boot.summary_at(9);

        let mut keys: Vec<&str> = Vec::new();
        for token in line.split_whitespace() {
            if token == "cold-start:" || token == "complete=yes" {
                continue;
            }
            let key = token
                .split_once('=')
                .map(|(key, _)| key)
                .expect("every field is key=value");
            keys.push(key);
        }
        assert_eq!(
            keys,
            vec![
                "process_start_ms",
                "sidecar_spawn_ms",
                "server_health_ms",
                "bootstrap_return_ms",
                "window_shown_ms",
                "total_ms",
                "spawn_after_start_ms",
                "health_after_spawn_ms",
                "bootstrap_after_health_ms",
                "window_after_health_ms",
            ],
            "stage order is part of the cold-start contract"
        );
        assert!(boot.complete());
    }
}
