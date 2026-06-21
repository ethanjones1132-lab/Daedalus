from __future__ import annotations

import os
from pathlib import Path

from .base import AdapterContext, BaseAdapter
from .jarvis import JarvisAdapter
from .jonesinsrc_products import JonesinSrcProductsAdapter
from .jonesinsrc_website import JonesinSrcWebsiteAdapter
from .prizepicks import PrizePicksAdapter
from .snitch_llc import SnitchLlcAdapter

ADAPTERS: list[BaseAdapter] = [
    JarvisAdapter(),
    JonesinSrcWebsiteAdapter(),
    SnitchLlcAdapter(),
    JonesinSrcProductsAdapter(),
    PrizePicksAdapter(),
]

DEFAULT_PATHS = {
    "home_base_root": "C:/Projects/home-base-recovered",
    "snitch_root": "C:/Projects/snitch-llc",
    "jonesinsrc_root": "C:/Users/ethan/OneDrive/Documents/JonesinSRC",
    "prizepicks_root": "C:/Projects/prizepicks-monster",
}


def default_context(root: Path | None = None) -> AdapterContext:
    workspace_root = Path(root) if root is not None else Path(__file__).resolve().parents[3]
    home_base = Path(os.environ.get("HOME_BASE_ROOT", DEFAULT_PATHS["home_base_root"]))
    if not home_base.exists():
        home_base = workspace_root.parent.parent

    return AdapterContext(
        home_base_root=str(home_base),
        snitch_root=os.environ.get("SNITCH_ROOT", DEFAULT_PATHS["snitch_root"]),
        jonesinsrc_root=os.environ.get("JONESINSRC_ROOT", DEFAULT_PATHS["jonesinsrc_root"]),
        prizepicks_root=os.environ.get("PRIZEPICKS_ROOT", DEFAULT_PATHS["prizepicks_root"]),
    )


def collect_all(ctx: AdapterContext | None = None) -> list[dict]:
    context = ctx or default_context()
    actions: list[dict] = []
    for adapter in ADAPTERS:
        actions.extend(adapter.collect(context))
    return actions