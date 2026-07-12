# Prompt Intelligence — Behaviour Evaluation Cases

**Date:** 12 July 2026

## Overview

This document records five behaviour-evaluation cases for the Prompt Intelligence MCP tools (`prompt_build`, `prompt_improve`, `prompt_evaluate`) and the `prompt` agent role. These cases validate that the tools behave correctly under representative scenarios.

---

## Case 1: Basic Prompt Build with Memory Injection

**Scenario:** Build a prompt for a generic tool with `use_memory: true`.

**Expected Behaviour:**
- Output includes a generated prompt text referencing the target tool and description.
- Memory-derived context appears as a clearly delimited block (`[Retrieved Memory: ...]`).
- `memoryIds` array is non-empty and contains the injected memory IDs.
- Config and assumptions fields are populated.

**Observed Result:** ✅ Pass — all assertions hold in Tier 1 tests.

---

## Case 2: Claude-Specific Target Routing

**Scenario:** Build a prompt targeting `Claude API` or a tool with "claude" in the name.

**Expected Behaviour:**
- Claude-specific rules (thinking/effort control, tag structures) are injected.
- General rules are not used when Claude routing is active.
- `policyForTarget` appends `CLAUDE_POLICY` to `PROMPT_POLICY` only for Claude/Anthropic targets.

**Observed Result:** ✅ Pass — Tier 1 routing tests confirm Claude-specific and non-Claude divergence.

---

## Case 3: Memory Opt-Out (use_memory: false)

**Scenario:** Build a prompt with `use_memory` explicitly set to `false`.

**Expected Behaviour:**
- No memory block appears in the generated prompt.
- `memoryIds` array is empty (`[]`).
- Prompt is otherwise complete and well-formed.

**Observed Result:** ✅ Pass — Tier 2 memory opt-out test confirms empty memory IDs and no memory block.

---

## Case 4: Prompt Evaluation Score Validation

**Scenario:** Evaluate a non-empty prompt via `prompt_evaluate`.

**Expected Behaviour:**
- Returns all seven score dimensions: clarity, grounding, scope, outputContract, targetToolFit, tokenEfficiency, operationalSafety.
- All scores are numeric values between 0 and 1.
- Schema is consistent for any non-empty input.

**Observed Result:** ✅ Pass — Tier 1 and Tier 2 evaluation tests confirm score structure and range.

---

## Case 5: Cross-Feature Pipeline (Build → Improve → Evaluate)

**Scenario:** Build a prompt, improve it, then evaluate the improved version.

**Expected Behaviour:**
- `prompt_build` produces a valid prompt.
- `prompt_improve` accepts the built prompt and returns an improved version with `[Improved]` marker and `changesMade` populated.
- `prompt_evaluate` accepts the improved prompt and returns valid evaluation scores.
- The pipeline completes without errors.

**Observed Result:** ✅ Pass — Tier 3 cross-feature and Tier 4 scenario tests confirm pipeline integrity.
