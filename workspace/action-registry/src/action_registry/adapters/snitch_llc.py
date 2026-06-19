from __future__ import annotations

from pathlib import Path
from typing import Any

from .base import AdapterContext, BaseAdapter, build_action


class SnitchLlcAdapter(BaseAdapter):
    name = "snitch-llc"

    def collect(self, ctx: AdapterContext) -> list[dict[str, Any]]:
        root = Path(ctx.snitch_root)
        stamp = ctx.stamp
        parcel_dir = root / "data" / "parcels"
        output_dir = root / "output"
        parcel_count = len(list(parcel_dir.glob("**/*"))) if parcel_dir.exists() else 0
        output_count = len(list(output_dir.glob("**/*"))) if output_dir.exists() else 0

        action = build_action(
            item_id="snitch-llc-20260616-001",
            project="snitch-llc",
            track_key="snitch-llc:snitch-llc",
            source_system="pipeline-adapter",
            source_area="snitch-llc",
            action_kind="track",
            title="Snitch LLC application track",
            description="Validate pool-detection outputs, address matching, and assessor-report generation.",
            priority="P1",
            risk_level="medium",
            category="data_pipeline",
            action_type="pipeline_review",
            acceptance_criteria=[
                "Pipeline outputs are enumerated with counts and freshness",
                "Address matching spot-check passes on a sample set",
            ],
            evidence=[
                {"kind": "repo", "value": ctx.snitch_root},
                {"kind": "parcels", "value": str(parcel_count)},
                {"kind": "outputs", "value": str(output_count)},
            ],
            stamp=stamp,
            confidence=0.8 if root.exists() else 0.4,
            confidence_reason="Pipeline directories enumerated" if root.exists() else "Repo missing",
        )
        if not root.exists():
            action["status"] = "blocked"
        return [action]