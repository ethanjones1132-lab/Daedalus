"""One-shot: append the 10 engineering-roadmap actions to the action registry.

Idempotent — re-running skips IDs already present. Safe to delete after use.
"""
import json
import os

PATH = os.path.join(
    os.path.dirname(__file__), "..", "workspace", "action-registry", "data", "active.json"
)
NOW = "2026-06-21T16:45:00"


def action(slug, area, priority, risk, category, atype, title, desc, accept, due, evidence, deps=None):
    return {
        "id": "jarvis-eng-%s-20260621-001" % slug,
        "project": "jarvis",
        "source_system": "engineering-roadmap",
        "source_area": area,
        "priority": priority,
        "risk_level": risk,
        "category": category,
        "action_type": atype,
        "title": title,
        "description": desc,
        "acceptance_criteria": accept,
        "dependencies": deps or [],
        "status": "open",
        "owner": "shared",
        "approval_required": False,
        "next_due": due,
        "created_at": NOW,
        "updated_at": NOW,
        "action_kind": "task",
        "confidence": 0.9,
        "confidence_reason": "Planned from verified codebase audit (2026-06-21)",
        "evidence": evidence,
    }


NEW = [
    action(
        "theme-toggle", "src-ui/theme", "P1", "low", "frontend", "feature",
        "Wire a light/dark theme toggle",
        "index.css ships a complete [data-theme=light] palette but nothing sets data-theme, "
        "so the finished light mode is unreachable. Add a toggle that flips "
        "documentElement[data-theme] and persists via set_setting/get_setting.",
        [
            "Toggle control in the UI flips between dark and light",
            "Choice persists across restarts via the settings commands",
            "Both palettes render correctly (verified in build)",
        ],
        "2026-06-24T18:00:00",
        [
            {"kind": "file", "value": "src-ui/src/index.css:259"},
            {"kind": "context", "value": "grep confirms zero code sets data-theme; light palette is dead until a toggle is wired."},
        ],
    ),
    action(
        "command-palette", "src-ui/navigation", "P2", "low", "frontend", "feature",
        "Add a Cmd+K command palette",
        "The sidebar now has ~19 nav items across 4 sections with no keyboard navigation. Add a "
        "Cmd/Ctrl+K palette that fuzzy-searches views (and later actions) and navigates on select.",
        [
            "Cmd/Ctrl+K opens a searchable palette",
            "Selecting a result navigates via the existing onNavigate(ViewId)",
            "Esc closes; arrow keys move selection",
        ],
        "2026-06-28T18:00:00",
        [
            {"kind": "file", "value": "src-ui/src/App.tsx:43"},
            {"kind": "context", "value": "NAV_SECTIONS holds all ViewId targets; palette can map over them."},
        ],
    ),
    action(
        "ci-pipeline", "ci", "P0", "low", "infrastructure", "feature",
        "Add a CI pipeline with a theme-husk guard",
        "No .github/workflows exists. The session began with a green build hiding a dead theme and "
        "14 dead views. Add CI running cargo check + tsc + vite build + bun test on push/PR, plus a "
        "guard asserting custom color tokens appear in the generated CSS.",
        [
            "Workflow runs cargo check, bunx tsc -b, vite build, and bun test",
            "A step greps dist CSS for --color-bone/.text-bone and fails if absent",
            "CI is green on the current branch",
        ],
        "2026-06-25T18:00:00",
        [
            {"kind": "context", "value": "ls .github/workflows -> none. Theme-husk bug (fix 58d9c19) would have been caught by a CSS-generation assertion."},
        ],
    ),
    action(
        "dry-resource-list", "src-ui/hooks", "P2", "low", "frontend", "refactor",
        "Extract a useResourceList hook to DRY CRUD views",
        "The 9 list views added this session (Skills, Agents, Channels, Devices, Nodes, Hooks, "
        "Commitments, Approvals, Plugins) repeat the same fetch/loading/error/optimistic-toggle "
        "block. Extract a useResourceList<T> hook and refactor the views onto it.",
        [
            "useResourceList encapsulates fetch + loading + error + refetch",
            "At least the 9 new views consume it with no behavior change",
            "tsc + vite build stay green",
        ],
        "2026-06-30T18:00:00",
        [
            {"kind": "file", "value": "src-ui/src/components/jarvis/DevicesView.tsx"},
            {"kind": "context", "value": "Boilerplate duplicated across all list views authored this session."},
        ],
    ),
    action(
        "confirm-modal", "src-ui/ui", "P2", "low", "frontend", "feature",
        "Replace window.confirm with a styled confirm modal",
        "Delete/remove flows in the new views use native window.confirm (blocking, off-brand). Build "
        "a reusable ConfirmModal (reuse the ToolApprovalModal pattern) and route destructive actions "
        "through it.",
        [
            "A reusable confirm modal exists in components/ui",
            "All window.confirm calls in jarvis views use it",
            "Confirm/cancel paths verified",
        ],
        "2026-06-30T18:00:00",
        [
            {"kind": "file", "value": "src-ui/src/components/jarvis/ToolApprovalModal.tsx"},
            {"kind": "context", "value": "window.confirm used in Agents/Channels/Devices/Nodes/Hooks/ControlCenter views."},
        ],
    ),
    action(
        "a11y-pass", "src-ui/accessibility", "P2", "medium", "frontend", "quality",
        "Accessibility and keyboard pass on tabbed/modal views",
        "New tabbed (Skills, ControlCenter) and modal surfaces lack focus trapping, aria-selected on "
        "tabs, and Esc-to-close. Add roving focus, aria roles, and keyboard handling.",
        [
            "Tabs expose role=tab/aria-selected and are arrow-navigable",
            "Modals trap focus and close on Esc",
            "No keyboard traps; visible focus rings",
        ],
        "2026-07-07T18:00:00",
        [
            {"kind": "file", "value": "src-ui/src/components/jarvis/SkillsView.tsx"},
            {"kind": "context", "value": "Custom tab/modal markup added this session without aria or focus management."},
        ],
    ),
    action(
        "eval-harness", "eval", "P1", "medium", "platform", "feature",
        "Build an eval / regression harness",
        "AGENTS.md names an eval/regression harness as a current priority; none exists. Define a "
        "harness that exercises the inference path and tool runtime against fixed prompts and asserts "
        "on structured outputs, runnable in CI.",
        [
            "Harness runs a fixed suite against the tool runtime / inference path",
            "Pass/fail is deterministic and CI-runnable",
            "Baseline captured for regression comparison",
        ],
        "2026-07-12T18:00:00",
        [
            {"kind": "file", "value": "AGENTS.md:27"},
            {"kind": "context", "value": "server-jarvis has 191 unit tests but no end-to-end eval/regression harness."},
        ],
        ["jarvis-eng-ci-pipeline-20260621-001"],
    ),
    action(
        "build-provenance", "build", "P1", "medium", "infrastructure", "feature",
        "Add build provenance and stale-binary prevention",
        "AGENTS.md names build provenance / stale-binary prevention as a priority. Stamp builds with "
        "commit + timestamp, surface it in-app (e.g. HealthBanner/Gateway), and warn when the running "
        "binary lags the source tree.",
        [
            "Build embeds git SHA + build time",
            "Version/provenance is visible in the UI",
            "A check flags a stale binary vs current source",
        ],
        "2026-07-12T18:00:00",
        [
            {"kind": "file", "value": "AGENTS.md:25"},
            {"kind": "context", "value": "APP_VERSION is a hardcoded '3.0.0' string in App.tsx with no git provenance."},
        ],
    ),
    action(
        "test-coverage", "testing", "P1", "medium", "quality", "feature",
        "Close the Rust and UI test-coverage gap",
        "Only 3 Rust files have #[cfg(test)] and the UI has zero tests. Add Rust unit/integration "
        "tests for the native command surface (sessions, memory tiers, agents) and set up a UI test "
        "runner (vitest) with tests for the new views and useResourceList.",
        [
            "Rust tests cover sessions, memory tier, and agent CRUD commands",
            "A UI test runner is configured with passing component tests",
            "Both suites run in CI",
        ],
        "2026-07-12T18:00:00",
        [
            {"kind": "context", "value": "grep: 3 Rust test files, 0 UI test files, 30 server test files."},
        ],
        ["jarvis-eng-ci-pipeline-20260621-001"],
    ),
    action(
        "contract-mismatches", "src-tauri/contracts", "P1", "medium", "platform", "fix",
        "Reconcile the remaining recovery contract mismatches",
        "jarvis_save_companion still errors because the Bun POST /companion is an interaction action, "
        "not a state save; and cold-memory Google Drive archival in engine.rs is a placeholder. "
        "Reconcile the companion save contract and implement (or formally defer) Drive archival.",
        [
            "jarvis_save_companion persists companion state through a defined contract",
            "Cold-memory archival path is implemented or explicitly stubbed with a tracked decision",
            "No silent 'not wired' errors on user-reachable paths",
        ],
        "2026-07-07T18:00:00",
        [
            {"kind": "file", "value": "src-tauri/src/commands/recovery_stubs.rs:161"},
            {"kind": "file", "value": "src-tauri/src/jarvis/memory/engine.rs:2270"},
        ],
    ),
]


def main():
    with open(PATH, encoding="utf-8") as f:
        data = json.load(f)

    existing = {a.get("id") for a in data["actions"]}
    added = [a for a in NEW if a["id"] not in existing]
    data["actions"].extend(added)

    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print("Added %d actions. Total now: %d" % (len(added), len(data["actions"])))
    for a in added:
        print(" -", a["id"], "|", a["priority"], "|", a["title"])


if __name__ == "__main__":
    main()
