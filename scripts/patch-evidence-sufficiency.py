#!/usr/bin/env python3
"""One-shot patcher to wire evidence-sufficiency into pipeline.ts.

Plan ref: docs/superpowers/plans/2026-07-12-comprehensive-performance-improvement.md
Phase 2 Task 2.1 (Step 5: Replace both call sites in pipeline.ts).

Note: pipeline.ts uses CRLF line endings on Windows. We use \\r\\n in
all replacement strings to match the file's actual byte content.
"""
import sys

PATH = r"C:\Projects\home-base-recovered\server-jarvis\src\orchestration\pipeline.ts"

with open(PATH, "rb") as f:
    data = f.read().decode("utf-8")

# Verify CRLF (Windows line endings).
assert data.count("\r\n") > 1000, f"Expected CRLF; got {data.count(chr(13))} CR, {data.count(chr(10))} LF"

# ─── 1) Add import for assessWorkspaceEvidence ─────────────────────────
old_imports = (
    'import type { PipelineStageState, PlannerStageOutput, ExecutorStageOutput, ReviewerStageOutput, RewriterStageOutput, ToolCallRecord } from "./stage-output";\r\n'
    'import { parseReviewerVerdict, renderExecutorSummary, renderPlanSummary, renderReviewerSummary, renderRewriterSummary } from "./stage-output";\r\n'
)
new_imports = (
    old_imports
    + 'import { assessWorkspaceEvidence } from "./evidence-sufficiency";\r\n'
)
assert data.count(old_imports) == 1, f"imports block not unique: {data.count(old_imports)}"
data = data.replace(old_imports, new_imports, 1)

# ─── 2) Remove the now-unused hasSuccessfulWorkspaceEvidence function ──
old_func = (
    'function hasSuccessfulWorkspaceEvidence(toolCalls: ToolCallRecord[] | undefined): boolean {\r\n'
    '  return (toolCalls ?? []).some((call) =>\r\n'
    '    WORKSPACE_EVIDENCE_TOOLS.has(call.name) &&\r\n'
    '    !call.is_error &&\r\n'
    '    call.output.trim().length > 0\r\n'
    '  );\r\n'
    '}\r\n'
    '\r\n'
)
assert data.count(old_func) == 1, f"hasSuccessfulWorkspaceEvidence not unique: {data.count(old_func)}"
data = data.replace(old_func, "", 1)

# ─── 3) Update the nudge condition + message ──────────────────────────
old_nudge = (
    '          } else if (\r\n'
    '            requiresWorkspaceEvidence &&\r\n'
    '            !hasSuccessfulWorkspaceEvidence(toolCalls) &&\r\n'
    '            !workspaceEvidenceNudgeSent &&\r\n'
    '            turnCount < maxTurns\r\n'
    '          ) {\r\n'
    '            // A workspace_read stage is not grounded merely because an executor\r\n'
    '            // model produced prose. Give it one bounded repair round to call a\r\n'
    '            // real read tool; if it declines again, the runtime fence below\r\n'
    '            // blocks synthesis instead of laundering stale prose as repo facts.\r\n'
    '            workspaceEvidenceNudgeSent = true;\r\n'
    '            executorMessages.push({\r\n'
    '              role: "user",\r\n'
    '              content:\r\n'
    '                "Workspace evidence is required for this turn. Before answering, call at least one relevant read-only workspace tool (read_file, list_directory, glob, or grep) and ground your findings in its result.",\r\n'
    '            });\r\n'
)
new_nudge = (
    '          } else if (\r\n'
    '            requiresWorkspaceEvidence &&\r\n'
    '            !assessWorkspaceEvidence(toolCalls, request).sufficient &&\r\n'
    '            !workspaceEvidenceNudgeSent &&\r\n'
    '            turnCount < maxTurns\r\n'
    '          ) {\r\n'
    '            // A workspace_read stage is not grounded merely because an executor\r\n'
    '            // model produced prose. Give it one bounded repair round to call a\r\n'
    '            // real read tool; if it declines again, the runtime fence below\r\n'
    '            // blocks synthesis instead of laundering stale prose as repo facts.\r\n'
    '            //\r\n'
    '            // The assessment scales with request depth (Phase 2 Task 2.1): a\r\n'
    '            // "comprehensively diagnose this repo" turn needs 3+ content reads\r\n'
    '            // before synthesis is allowed, so the nudge message tells the\r\n'
    '            // executor model exactly what is missing instead of asking for\r\n'
    '            // a single read.\r\n'
    '            const assessment = assessWorkspaceEvidence(toolCalls, request);\r\n'
    '            workspaceEvidenceNudgeSent = true;\r\n'
    '            executorMessages.push({\r\n'
    '              role: "user",\r\n'
    '              content:\r\n'
    '                `Workspace evidence is required for this turn. ${assessment.reason}. Call the relevant read-only workspace tools (read_file, list_directory, glob, grep, or git_metadata) and ground your findings in their results before answering.`,\r\n'
    '            });\r\n'
)
assert data.count(old_nudge) == 1, f"nudge block not unique: {data.count(old_nudge)}"
data = data.replace(old_nudge, new_nudge, 1)

# ─── 4) Update the missingRequiredEvidence flag ───────────────────────
old_mre = '          const missingRequiredEvidence = requiresWorkspaceEvidence && !hasSuccessfulWorkspaceEvidence(toolCalls);\r\n'
new_mre = '          const missingRequiredEvidence = requiresWorkspaceEvidence && !assessWorkspaceEvidence(toolCalls, request).sufficient;\r\n'
assert data.count(old_mre) == 1, f"missingRequiredEvidence line not unique: {data.count(old_mre)}"
data = data.replace(old_mre, new_mre, 1)

# ─── 5) Update the post-loop fence inside runExecutorStage ────────────
old_fence = '      if (requiresWorkspaceEvidence && !hasSuccessfulWorkspaceEvidence(toolCalls)) {\r\n'
new_fence = '      if (requiresWorkspaceEvidence && !assessWorkspaceEvidence(toolCalls, request).sufficient) {\r\n'
assert data.count(old_fence) == 1, f"fence not unique: {data.count(old_fence)}"
data = data.replace(old_fence, new_fence, 1)

# ─── 6) Update the executeSegment call site ──────────────────────────
old_seg = (
    '      !hasSuccessfulWorkspaceEvidence(state.executor?.toolCalls)\r\n'
    '    ) {\r\n'
    '      return {\r\n'
    '        state,\r\n'
    '        synthesizerAnswer: "",\r\n'
    '        synthesizerFatalError: MISSING_WORKSPACE_EVIDENCE,\r\n'
    '        synthesizerEmptyCompletion: false,\r\n'
    '        fatalErrorCode: "missing_workspace_evidence",\r\n'
    '        effectGate,\r\n'
    '        partialStage,\r\n'
    '      };\r\n'
    '    }\r\n'
)
new_seg = (
    '      !assessWorkspaceEvidence(state.executor?.toolCalls, request).sufficient\r\n'
    '    ) {\r\n'
    '      return {\r\n'
    '        state,\r\n'
    '        synthesizerAnswer: "",\r\n'
    '        synthesizerFatalError: MISSING_WORKSPACE_EVIDENCE,\r\n'
    '        synthesizerEmptyCompletion: false,\r\n'
    '        fatalErrorCode: "missing_workspace_evidence",\r\n'
    '        effectGate,\r\n'
    '        partialStage,\r\n'
    '      };\r\n'
    '    }\r\n'
)
assert data.count(old_seg) == 1, f"executeSegment block not unique: {data.count(old_seg)}"
data = data.replace(old_seg, new_seg, 1)

# ─── 7) Update the final execute() call site ─────────────────────────
old_final = '    if (requiresWorkspaceEvidence && !hasSuccessfulWorkspaceEvidence(state.executor?.toolCalls)) {\r\n'
new_final = '    if (requiresWorkspaceEvidence && !assessWorkspaceEvidence(state.executor?.toolCalls, request).sufficient) {\r\n'
assert data.count(old_final) == 1, f"final execute block not unique: {data.count(old_final)}"
data = data.replace(old_final, new_final, 1)

# Write back as binary to avoid the Windows newline translation layer.
with open(PATH, "wb") as f:
    f.write(data.encode("utf-8"))

print("pipeline.ts patched: 7 edits applied")
remaining = data.count("hasSuccessfulWorkspaceEvidence")
if remaining != 0:
    print(f"WARNING: {remaining} references to hasSuccessfulWorkspaceEvidence remain!", file=sys.stderr)
    sys.exit(1)
print("OK: no remaining hasSuccessfulWorkspaceEvidence references")
print(f"WORKSPACE_EVIDENCE_TOOLS usage: still {data.count('WORKSPACE_EVIDENCE_TOOLS')} (kept for the git_metadata preflight discoverability check at line ~523)")
