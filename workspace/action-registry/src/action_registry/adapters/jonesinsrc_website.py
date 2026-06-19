from __future__ import annotations

from pathlib import Path
from typing import Any

from .base import AdapterContext, BaseAdapter, build_action


class JonesinSrcWebsiteAdapter(BaseAdapter):
    name = "jonesinsrc-website"

    def collect(self, ctx: AdapterContext) -> list[dict[str, Any]]:
        stamp = ctx.stamp
        repo = Path(ctx.jonesinsrc_root)
        evidence: list[dict[str, str]] = [{"kind": "repo", "value": ctx.jonesinsrc_root}]
        actions: list[dict[str, Any]] = []

        actions.append(
            build_action(
                item_id="jonesinsrc-website-20260616-001",
                project="jonesinsrc",
                track_key="jonesinsrc:website",
                source_system="website-adapter",
                source_area="website",
                action_kind="track",
                title="JonesinSRC website track",
                description="Verify trust signals, lead capture, and checkout paths on the live Shopify portfolio store.",
                priority="P0",
                risk_level="high",
                category="funnel_triage",
                action_type="website_track",
                acceptance_criteria=[
                    "Lead capture form submission path is verified end-to-end",
                    "Trust signals are visible on the live storefront",
                ],
                evidence=evidence
                + [
                    {
                        "kind": "context",
                        "value": "Trust signals and lead capture were added; zero-sales WallSlayer keeps website conversion urgent.",
                    }
                ],
                stamp=stamp,
                next_due=ctx.now.replace(hour=18, minute=0, second=0).isoformat(timespec="seconds"),
                confidence=0.7 if repo.exists() else 0.5,
                confidence_reason="Repo reachable" if repo.exists() else "Repo path missing in environment",
            )
        )

        if not repo.exists():
            blocked = build_action(
                item_id="signal-jonesinsrc-website-repo",
                project="jonesinsrc",
                track_key="jonesinsrc:website-repo",
                source_system="website-adapter",
                source_area="website",
                action_kind="signal",
                title="Restore JonesinSRC repo access for website adapter",
                description="Configured JonesinSRC repo path is not reachable from this environment.",
                priority="P1",
                risk_level="medium",
                category="web_registry",
                action_type="repo_access",
                acceptance_criteria=["JonesinSRC repo path exists and is readable by adapters"],
                evidence=[{"kind": "missing", "value": ctx.jonesinsrc_root}],
                stamp=stamp,
                confidence=0.9,
                confidence_reason="Path existence check failed",
            )
            blocked["status"] = "blocked"
            actions.append(blocked)

        return actions