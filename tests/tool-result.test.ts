import assert from "node:assert/strict";
import test from "node:test";

import { toolError, toolText } from "../src/utils/tool-result";

test("toolError marks MCP failures with isError", () => {
	assert.deepEqual(toolError(new Error("boom")), {
		isError: true,
		content: [{ type: "text", text: "Error: boom" }],
	});
});

test("toolText returns a normal MCP text result", () => {
	assert.deepEqual(toolText("ok"), {
		content: [{ type: "text", text: "ok" }],
	});
});
