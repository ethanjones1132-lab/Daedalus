"""Text shared by the Laya worker (Laya's venv) and the runners (main venv) for Laya v3 (spec §3): the evidence
question's options, the note each option gives Qwen, and the plain-text states Laya reads. Standard library only."""

EVIDENCE_OPTIONS = {
    "scale": "units or scale differ",
    "sign": "sign or direction differs",
    "base": "counting starts at a different number",
    "order": "order differs",
    "type": "type or format differs",
    "missing": "missing values are signalled differently",
    "none": "nothing unexpected",
}
NOTE_PHRASES = {
    "scale": "units or scale differ",
    "sign": "sign or direction differs",
    "base": "starting index or count differs",
    "order": "ordering differs",
    "type": "return type or format differs",
    "missing": "way of signalling missing values differs",
}
CAP = 700


def note_text(choice):
    return f"Note: the probe output suggests the helper's {NOTE_PHRASES[choice]} from what the entry file assumes."


def evidence_state(requirement, script, output):
    return (f"Requirement: {requirement}\n\nProbe script:\n{script[:CAP]}\n\nIts output:\n{output[:CAP]}")


def valid_state(requirement, imports, assert_src):
    return f"Requirement: {requirement}\n\nCheck:\n{imports}\n{assert_src}".replace("\n\n\n", "\n\n")
