import assert from "node:assert/strict";
import test from "node:test";

import { llmCall, llmCallSystem } from "../src/utils/ai";

const ACTIVE_TEXT_MODEL = "@cf/zai-org/glm-4.7-flash";

function fakeEnv(
	calls: Array<{ model: string; input: unknown }>,
	result: unknown = { response: "ok" },
): Env {
	return {
		AI: {
			run: async (model: string, input: unknown) => {
				calls.push({ model, input });
				return result;
			},
		},
	} as unknown as Env;
}

test("text generation helpers use the active Workers AI model", async () => {
	const calls: Array<{ model: string; input: unknown }> = [];
	const env = fakeEnv(calls);

	await llmCall("hello", env);
	await llmCallSystem("system", "hello", env);

	assert.deepEqual(
		calls.map(({ model }) => model),
		[ACTIVE_TEXT_MODEL, ACTIVE_TEXT_MODEL],
	);
	for (const { input } of calls) {
		assert.deepEqual(
			(input as { chat_template_kwargs?: unknown }).chat_template_kwargs,
			{ enable_thinking: false },
		);
	}
});

test("text generation helpers read OpenAI-compatible Workers AI responses", async () => {
	const calls: Array<{ model: string; input: unknown }> = [];
	const env = fakeEnv(calls, {
		choices: [{ message: { content: "generated text" } }],
	});

	assert.equal(await llmCall("hello", env), "generated text");
	assert.equal(await llmCallSystem("system", "hello", env), "generated text");
});

test("text generation helpers reject empty responses before callers persist them", async () => {
	const calls: Array<{ model: string; input: unknown }> = [];
	const env = fakeEnv(calls, {
		choices: [{ message: { content: "" } }],
	});

	await assert.rejects(
		() => llmCall("hello", env),
		/Workers AI returned no generated text/,
	);
});
