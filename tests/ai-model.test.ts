import assert from "node:assert/strict";
import test from "node:test";

import { llmCall, llmCallSystem } from "../src/utils/ai";

const ACTIVE_TEXT_MODEL = "@cf/zai-org/glm-4.7-flash";

function fakeEnv(calls: Array<{ model: string; input: unknown }>): Env {
	return {
		AI: {
			run: async (model: string, input: unknown) => {
				calls.push({ model, input });
				return { response: "ok" };
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
});
