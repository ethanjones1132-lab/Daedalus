from __future__ import annotations

from pathlib import Path
from typing import Any

from .base import AdapterContext, BaseAdapter, build_action


class PrizePicksAdapter(BaseAdapter):
    name = "prizepicks"

    def collect(self, ctx: AdapterContext) -> list[dict[str, Any]]:
        root = Path(ctx.prizepicks_root)
        stamp = ctx.stamp
        actions: list[dict[str, Any]] = []

        # Project track — PrizePicks Monster DFS app
        src_tauri = root / "src-tauri" / "src" / "lib.rs"
        src_ui = root / "src-ui" / "src" / "App.tsx"
        cargo_toml = root / "src-tauri" / "Cargo.toml"

        if root.exists():
            actions.append(
                build_action(
                    item_id="prizepicks-monster-track",
                    project="prizepicks-monster",
                    track_key="prizepicks-monster:core",
                    source_system="adapter",
                    source_area="prizepicks-monster",
                    action_kind="track",
                    title="PrizePicks Monster DFS app track",
                    description=(
                        "PrizePicks Monster is a Tauri 2 + Rust desktop app for AI-driven DFS player prop analysis. "
                        "It provides prop board, edge analysis, AI chat, prediction tracking, and paper trading."
                    ),
                    priority="P1",
                    risk_level="medium",
                    category="project_registry",
                    action_type="project_track",
                    acceptance_criteria=[
                        "Repo exists with valid Tauri project structure",
                        "Rust backend compiles (cargo check passes)",
                        "Frontend builds (npm run build succeeds)",
                        "Player prop fetcher returns real data (not mock)",
                    ],
                    evidence=[
                        {"kind": "repo", "value": str(root)},
                        {"kind": "source", "value": str(src_tauri)},
                        {"kind": "frontend", "value": str(src_ui)},
                    ],
                    stamp=stamp,
                    confidence=0.9 if cargo_toml.exists() else 0.5,
                    confidence_reason="Cargo.toml found" if cargo_toml.exists() else "Cargo.toml missing",
                )
            )

            # Check if prop fetcher is still returning mock data
            prop_fetcher = root / "src-tauri" / "src" / "prizepicks" / "prop_fetcher.rs"
            if prop_fetcher.exists():
                content = prop_fetcher.read_text(encoding="utf-8")
                if "Mock" in content or "vec![]" in content:
                    actions.append(
                        build_action(
                            item_id="prizepicks-props-real-data",
                            project="prizepicks-monster",
                            track_key="prizepicks-monster:prop-fetcher",
                            source_system="adapter",
                            source_area="prizepicks-monster",
                            action_kind="signal",
                            title="Wire real prop data sources into PrizePicks fetcher",
                            description=(
                                "The player prop fetcher still returns mock/empty data. "
                                "Integrate OpticOdds, Apify, or Direct API sources for live prop lines."
                            ),
                            priority="P0",
                            risk_level="high",
                            category="data_integration",
                            action_type="integration_task",
                            acceptance_criteria=[
                                "Prop fetcher returns real player prop data from at least one source",
                                "Multi-source failover works (OpticOdds → Apify → Direct → Mock)",
                            ],
                            evidence=[
                                {"kind": "source", "value": str(prop_fetcher)},
                                {"kind": "context", "value": "Fetcher returns mock data"},
                            ],
                            stamp=stamp,
                            confidence=0.95,
                            confidence_reason="Source file contains mock return paths",
                        )
                    )
        else:
            actions.append(
                build_action(
                    item_id="signal-prizepicks-repo",
                    project="prizepicks-monster",
                    track_key="prizepicks-monster:repo",
                    source_system="adapter",
                    source_area="prizepicks-monster",
                    action_kind="signal",
                    title="PrizePicks Monster repo path not found",
                    description="Configured PrizePicks Monster repo path is not reachable.",
                    priority="P1",
                    risk_level="medium",
                    category="project_registry",
                    action_type="repo_access",
                    acceptance_criteria=["PrizePicks Monster repo path exists and is readable"],
                    evidence=[{"kind": "missing", "value": str(root)}],
                    stamp=stamp,
                    confidence=0.9,
                    confidence_reason="Path existence check failed",
                )
            )

        return actions
