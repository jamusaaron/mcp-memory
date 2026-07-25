import assert from "node:assert/strict";
import test from "node:test";

import {
	PROMPT_POLICY,
	buildPrompt,
	evaluatePrompt,
	improvePrompt,
	missingSections,
	parsePromptEvaluation,
	policyForTarget,
	type PromptRuntimeDependencies,
} from "../src/utils/prompt-engineering";

function runtimeHarness(outputs: string[]) {
	const calls: string[] = [];
	const logged: Array<{ role: string; memoryIds: string[] }> = [];
	const deps: PromptRuntimeDependencies = {
		buildContext: async () => ({
			summary: "Jamie prefers Australian English.",
			selfProfile: null,
			contextCurrent: null,
			pinned: [{ id: "m1", text: "Use Australian English", category: "preferences" }],
			related: [],
			highSalience: [],
			memoryIds: ["m1"],
		}),
		callModel: async (_system, user) => {
			calls.push(user);
			return outputs.shift() ?? "";
		},
		logRun: async (_userId, role, _input, _output, memoryIds) => {
			logged.push({ role, memoryIds });
			return "run-1";
		},
	};
	return { deps, calls, logged };
}

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

test("prompt build uses memory and logs provenance", async () => {
	const { deps, calls, logged } = runtimeHarness([
		"# Prompt\nWrite it.\n# Configuration\nNone.\n# Assumptions\nUses m1.\n# Quality check\nPass.",
	]);
	const result = await buildPrompt(
		"user",
		{
			objective: "Draft a note",
			target: { tool: "Claude" },
			useMemory: true,
		},
		{} as Env,
		deps,
	);
	assert.deepEqual(result.memoryIds, ["m1"]);
	assert.match(calls[0] ?? "", /Use Australian English/);
	assert.deepEqual(logged, [{ role: "prompt", memoryIds: ["m1"] }]);
});

test("prompt build opt-out avoids memory retrieval", async () => {
	let contextCalls = 0;
	const { deps } = runtimeHarness([
		"# Prompt\nDo it.\n# Configuration\nNone.\n# Assumptions\nNone.\n# Quality check\nPass.",
	]);
	deps.buildContext = async () => {
		contextCalls += 1;
		throw new Error("must not run");
	};
	await buildPrompt(
		"user",
		{
			objective: "Do it",
			target: { tool: "Generic chat" },
			useMemory: false,
		},
		{} as Env,
		deps,
	);
	assert.equal(contextCalls, 0);
});

test("malformed build output receives exactly one repair call", async () => {
	const { deps, calls } = runtimeHarness([
		"# Prompt\nIncomplete",
		"# Prompt\nFixed.\n# Configuration\nNone.\n# Assumptions\nNone.\n# Quality check\nPass.",
	]);
	await buildPrompt(
		"user",
		{
			objective: "Do it",
			target: { tool: "Claude" },
			useMemory: false,
		},
		{} as Env,
		deps,
	);
	assert.equal(calls.length, 2);
});

test("evaluation repairs invalid scores once", async () => {
	const valid = JSON.stringify({
		scores: {
			clarity: 80,
			grounding: 80,
			scope: 80,
			output_contract: 80,
			tool_fit: 80,
			token_efficiency: 80,
			safety: 80,
		},
		strengths: [],
		risks: [],
		recommended_changes: [],
		verdict: "ready",
	});
	const { deps, calls } = runtimeHarness([
		JSON.stringify({ scores: { clarity: 101 }, verdict: "ready" }),
		valid,
	]);
	const result = await evaluatePrompt(
		"user",
		"Do it",
		{ tool: "Claude" },
		undefined,
		{} as Env,
		deps,
	);
	assert.equal(result.evaluation.verdict, "ready");
	assert.equal(calls.length, 2);
});
