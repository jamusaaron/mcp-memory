import assert from "node:assert/strict";
import test from "node:test";

import {
	PROMPT_POLICY,
	missingSections,
	parsePromptEvaluation,
	policyForTarget,
} from "../src/utils/prompt-engineering";

test("prompt policy encodes current durable guidance", () => {
	assert.match(PROMPT_POLICY, /native structured output/i);
	assert.match(PROMPT_POLICY, /adaptive thinking|effort control/i);
	assert.match(PROMPT_POLICY, /source material before the query/i);
	assert.match(PROMPT_POLICY, /over-engineer/i);
	assert.match(PROMPT_POLICY, /prompt chaining/i);
	assert.doesNotMatch(PROMPT_POLICY, /never use prompt chaining/i);
	assert.doesNotMatch(PROMPT_POLICY, /prefill the final assistant/i);
});

test("Claude routing adds current Claude-specific constraints", () => {
	const policy = policyForTarget({ tool: "Claude API", model: "Claude 4.6", mode: "api" });
	assert.match(policy, /XML/i);
	assert.match(policy, /do not use.*final assistant.*prefill.*4\.6 or later/is);
	assert.match(policy, /adaptive thinking/i);
});

test("section validation reports only missing required sections", () => {
	const output = "# Prompt\nDo the task.\n\n# Configuration\nNone.";
	assert.deepEqual(missingSections(output, ["Prompt", "Configuration", "Assumptions"]), [
		"Assumptions",
	]);
});

test("section validation treats required names as literal text", () => {
	const output = '# Output (JSON)\n{"status":"ready"}';
	assert.deepEqual(missingSections(output, ["Output (JSON)"]), []);
});

test("evaluation parser validates all seven scores", () => {
	const parsed = parsePromptEvaluation(
		JSON.stringify({
			scores: {
				clarity: 90,
				grounding: 80,
				scope: 70,
				output_contract: 60,
				tool_fit: 50,
				token_efficiency: 40,
				safety: 100,
			},
			strengths: ["Clear objective"],
			risks: [],
			recommended_changes: ["Specify length"],
			verdict: "revise",
		}),
	);
	assert.equal(parsed.scores.safety, 100);
	assert.throws(
		() =>
			parsePromptEvaluation(
				JSON.stringify({ ...parsed, scores: { ...parsed.scores, clarity: 101 } }),
			),
		/clarity.*0 and 100/i,
	);
});

test("evaluation parser rejects missing required list fields", () => {
	const evaluation = {
		scores: {
			clarity: 90,
			grounding: 80,
			scope: 70,
			output_contract: 60,
			tool_fit: 50,
			token_efficiency: 40,
			safety: 100,
		},
		strengths: ["Clear objective"],
		risks: [],
		recommended_changes: ["Specify length"],
		verdict: "revise",
	};

	for (const field of ["strengths", "risks", "recommended_changes"] as const) {
		assert.throws(
			() => parsePromptEvaluation(JSON.stringify({ ...evaluation, [field]: undefined })),
			new RegExp(`${field}.*array of strings`, "i"),
		);
	}
});

test("evaluation parser rejects non-string required list entries", () => {
	const evaluation = {
		scores: {
			clarity: 90,
			grounding: 80,
			scope: 70,
			output_contract: 60,
			tool_fit: 50,
			token_efficiency: 40,
			safety: 100,
		},
		strengths: ["Clear objective"],
		risks: [],
		recommended_changes: ["Specify length"],
		verdict: "revise",
	};

	for (const field of ["strengths", "risks", "recommended_changes"] as const) {
		assert.throws(
			() => parsePromptEvaluation(JSON.stringify({ ...evaluation, [field]: [42] })),
			new RegExp(`${field}.*array of strings`, "i"),
		);
	}
});
