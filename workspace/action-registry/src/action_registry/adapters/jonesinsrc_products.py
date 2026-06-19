from __future__ import annotations

from pathlib import Path
from typing import Any

from .base import AdapterContext, BaseAdapter, action_id

PRODUCTS = (
    {
        "slug": "wallslayer",
        "name": "WallSlayer",
        "priority": "P0",
        "risk_level": "high",
        "offer_price": "$19 limited → $39",
        "product_type": "download",
        "lifecycle_stage": "live",
        "context": "Wall Slayer Shopify is live and currently showing zero sales.",
        "action_type": "funnel_diagnostic",
        "title": "WallSlayer zero-sales funnel diagnostic",
    },
    {
        "slug": "prizepicks-monster",
        "name": "PrizePicks Monster",
        "priority": "P1",
        "risk_level": "medium",
        "offer_price": "$25",
        "product_type": "web_app",
        "lifecycle_stage": "built",
        "context": "PrizePicks Monster is a commercial JonesinSRC web app offering.",
        "action_type": "product_track",
        "title": "PrizePicks Monster commercialization track",
    },
    {
        "slug": "kalshi-monster",
        "name": "Kalshi Monster",
        "priority": "P1",
        "risk_level": "medium",
        "offer_price": "$25",
        "product_type": "web_app",
        "lifecycle_stage": "built",
        "context": "Kalshi Monster is a commercial JonesinSRC web app offering.",
        "action_type": "product_track",
        "title": "Kalshi Monster launch and funnel track",
    },
)


class JonesinSrcProductsAdapter(BaseAdapter):
    name = "jonesinsrc-products"

    def collect(self, ctx: AdapterContext) -> list[dict[str, Any]]:
        stamp = ctx.stamp
        date_tag = ctx.now.strftime("%Y%m%d")
        actions: list[dict[str, Any]] = []
        prizepicks_db = Path(ctx.prizepicks_root) / "predictions.db"

        for product in PRODUCTS:
            evidence: list[dict[str, str]] = [
                {"kind": "product", "value": f"{product['offer_price']} {product['product_type']}"},
                {"kind": "context", "value": product["context"]},
            ]
            extra_acceptance: list[str] = []

            if product["slug"] == "prizepicks-monster":
                if prizepicks_db.exists():
                    evidence.append({"kind": "db", "value": str(prizepicks_db)})
                    extra_acceptance.append("Predictions database is reachable for funnel diagnostics")
                else:
                    evidence.append({"kind": "missing", "value": str(prizepicks_db)})
                    extra_acceptance.append("Predictions database path is restored or documented")

            if product["slug"] == "wallslayer":
                extra_acceptance.extend(
                    [
                        "Storefront visit-to-checkout path is traced with evidence",
                        "Zero-sales hypothesis is recorded with at least one diagnostic action",
                    ]
                )

            actions.append(
                {
                    "id": action_id(f"jonesinsrc-{product['slug']}", date_tag),
                    "project": "jonesinsrc",
                    "source_system": "product-adapter",
                    "source_area": product["slug"],
                    "priority": product["priority"],
                    "risk_level": product["risk_level"],
                    "category": "product_registry",
                    "action_type": product["action_type"],
                    "title": product["title"],
                    "description": (
                        f"Product adapter emitted a live track for {product['name']} so storefront, "
                        f"support, and publishing work attach to one stable product record."
                    ),
                    "acceptance_criteria": [
                        "Registry record preserves product identity, price path, and delivery model",
                        "Future funnel and support actions can reference the product slug",
                        *extra_acceptance,
                    ],
                    "dependencies": [],
                    "status": "open",
                    "owner": "shared",
                    "approval_required": product["slug"] == "wallslayer",
                    "created_at": stamp,
                    "updated_at": stamp,
                    "product_name": product["name"],
                    "product_slug": product["slug"],
                    "product_type": product["product_type"],
                    "offer_price": product["offer_price"],
                    "lifecycle_stage": product["lifecycle_stage"],
                    "evidence": evidence,
                }
            )

        return actions