import assert from "node:assert/strict";
import test from "node:test";

import { deleteMemory, updateMemory } from "../src/utils/db";

function envWithChanges(changes: number): Env {
	const statement = {
		bind() {
			return this;
		},
		async run() {
			return { meta: { changes } };
		},
	};

	return {
		DB: {
			prepare() {
				return statement;
			},
		},
	} as unknown as Env;
}

test("updateMemory rejects when the memory does not exist", async () => {
	await assert.rejects(
		updateMemory("missing-id", "user-id", { subject: "test" }, envWithChanges(0)),
		/Memory missing-id not found/,
	);
});

test("deleteMemory rejects when the memory does not exist", async () => {
	await assert.rejects(
		deleteMemory("missing-id", "user-id", envWithChanges(0)),
		/Memory missing-id not found/,
	);
});

test("memory mutations resolve when one row changes", async () => {
	const env = envWithChanges(1);
	await updateMemory("existing-id", "user-id", { subject: "test" }, env);
	await deleteMemory("existing-id", "user-id", env);
});
