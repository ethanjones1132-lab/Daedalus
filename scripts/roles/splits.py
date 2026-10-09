"""Frozen field splits for the role-adapter experiment (spec 2026-10-09-role-adapters-design.md, section 2).
Fixed on 2026-10-09 by random.Random(20261009).shuffle over teacher_gen.FIELDS (test: first 4, dev: next 2, train: the
rest), before any teacher data was looked at; test_splits.py checks this table against that rule."""

SPLITS = {
    "developer tooling": "test", "accessibility": "test", "small business operations": "test",
    "security and privacy": "test",
    "media and libraries": "dev", "team collaboration": "dev",
    "casual games and puzzles": "train", "hobbies and crafts": "train", "personal productivity": "train",
    "open-source maintenance": "train", "system administration": "train", "documentation and writing": "train",
    "health and fitness": "train", "home and family organisation": "train", "data analysis": "train",
    "education and study": "train", "science and mathematics": "train", "creative tools": "train",
    "travel and maps": "train", "networking and the web": "train",
}


def split_of(field):
    return SPLITS[field]
