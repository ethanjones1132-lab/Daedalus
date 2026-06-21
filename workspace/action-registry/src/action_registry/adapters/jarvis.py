from __future__ import annotations

from pathlib import Path
from typing import Any

from .base import AdapterContext, BaseAdapter, action_id


_SOURCE_DIRS: tuple[tuple[str, tuple[str, ...] | None], ...] = (
    ("src-tauri/src", (".rs",)),
    ("src-tauri/capabilities", (".json",)),
    ("src-tauri/icons", None),
    ("src-ui/src", (".ts", ".tsx", ".js", ".jsx", ".css", ".html")),
    ("src-ui/dist", None),
    ("server-jarvis/src", (".ts", ".js")),
    ("server-jarvis/dist", None),
)

_SOURCE_FILES = (
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/build.rs",
    "src-tauri/tauri.conf.json",
    "src-ui/index.html",
    "src-ui/package.json",
    "src-ui/tsconfig.json",
    "src-ui/vite.config.ts",
    "server-jarvis/package.json",
)


def _iter_source_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for rel in _SOURCE_FILES:
        path = root / rel
        if path.is_file():
            files.append(path)

    for rel_dir, suffixes in _SOURCE_DIRS:
        base = root / rel_dir
        if not base.exists() or not base.is_dir():
            continue
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            if suffixes is None or path.suffix in suffixes:
                files.append(path)
    return files


def _newest_source_file(root: Path) -> Path | None:
    files = _iter_source_files(root)
    if not files:
        return None
    return max(files, key=lambda path: path.stat().st_mtime)


class JarvisAdapter(BaseAdapter):
    name = "jarvis"

    def collect(self, ctx: AdapterContext) -> list[dict[str, Any]]:
        root = Path(ctx.home_base_root)
        actions: list[dict[str, Any]] = []
        stamp = ctx.stamp
        date_tag = ctx.now.strftime("%Y%m%d")

        release_binary = root / "target" / "x86_64-pc-windows-gnu" / "release" / "home-base.exe"
        newest_source = _newest_source_file(root)
        if release_binary.exists() and newest_source is not None:
            if release_binary.stat().st_mtime < newest_source.stat().st_mtime:
                actions.append(
                    self._build(
                        action_id("home-base-stale-binary", date_tag),
                        title="Rebuild stale Jarvis binary before release",
                        description=(
                            "The Windows release binary is older than the newest Jarvis source or packaged "
                            "artifact. Rebuild and redeploy to avoid shipping stale platform behavior."
                        ),
                        priority="P0",
                        risk_level="high",
                        action_type="release_guard",
                        category="build_provenance",
                        acceptance_criteria=[
                            "Release binary mtime is newer than all Rust, UI, and bundled server artifacts",
                            "Doctor report shows expected binary freshness",
                        ],
                        evidence=[
                            {"kind": "binary", "value": str(release_binary)},
                            {"kind": "newest_source", "value": str(newest_source)},
                            {"kind": "repo", "value": str(root)},
                        ],
                        approval_required=True,
                        stamp=stamp,
                    )
                )

        inference_csv = root / "inference_metrics.csv"
        if not inference_csv.exists():
            actions.append(
                self._build(
                    action_id("home-base-eval-harness", date_tag),
                    title="Stand up eval harness baseline",
                    description=(
                        "No inference metrics file found. Capture a baseline eval run so "
                        "regressions in the Jarvis inference path are detectable."
                    ),
                    priority="P1",
                    risk_level="medium",
                    action_type="verification_task",
                    category="eval_harness",
                    acceptance_criteria=[
                        "inference_metrics.csv exists with at least one recorded run",
                        "Eval harness documents pass/fail criteria",
                    ],
                    evidence=[{"kind": "missing", "value": str(inference_csv)}],
                    approval_required=False,
                    stamp=stamp,
                )
            )

        agents_md = root / "AGENTS.md"
        if agents_md.exists():
            actions.append(
                self._build(
                    action_id("home-base-platform-track", date_tag),
                    title="Jarvis platform follow-through",
                    description=(
                        "AGENTS.md lists active platform priorities: build provenance, eval harness, "
                        "bridge reliability, profile provisioning UI, frontier scaffolding, and OpenClaw bridge."
                    ),
                    priority="P1",
                    risk_level="high",
                    action_type="project_track",
                    category="project_registry",
                    acceptance_criteria=[
                        "At least one identified platform item has a tracked action with evidence",
                        "Bridge and runtime reliability checks are represented in the registry",
                    ],
                    evidence=[{"kind": "repo", "value": str(root)}, {"kind": "doc", "value": str(agents_md)}],
                    approval_required=False,
                    stamp=stamp,
                )
            )

        return actions

    @staticmethod
    def _build(
        item_id: str,
        *,
        title: str,
        description: str,
        priority: str,
        risk_level: str,
        action_type: str,
        category: str,
        acceptance_criteria: list[str],
        evidence: list[dict[str, str]],
        approval_required: bool,
        stamp: str,
    ) -> dict[str, Any]:
        return {
            "id": item_id,
            "project": "home-base",
            "source_system": "jarvis-adapter",
            "source_area": "jarvis",
            "priority": priority,
            "risk_level": risk_level,
            "category": category,
            "action_type": action_type,
            "title": title,
            "description": description,
            "acceptance_criteria": acceptance_criteria,
            "dependencies": [],
            "status": "open",
            "owner": "shared",
            "approval_required": approval_required,
            "created_at": stamp,
            "updated_at": stamp,
            "evidence": evidence,
        }