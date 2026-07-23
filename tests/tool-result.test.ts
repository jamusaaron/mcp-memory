import assert from "node:assert/strict";
import test from "node:test";

import { toolError, toolStructured, toolText } from "../src/utils/tool-result";

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

test("toolStructured preserves readable text and typed structured content", () => {
	assert.deepEqual(toolStructured("Stored decision d1.", { id: "d1", stored: true }), {
		content: [{ type: "text", text: "Stored decision d1." }],
		structuredContent: { id: "d1", stored: true },
	});
});
