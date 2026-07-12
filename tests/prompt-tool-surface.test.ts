import assert from "node:assert/strict";
import test from "node:test";
import { registerPromptEngineeringTools } from "../src/tools/prompt-engineering";
import { AGENT_ROLES } from "../src/types";
import { getPromptSystemContract } from "../src/utils/agents";
import { z } from "zod";

test("AGENT_ROLES contains prompt", () => {
	assert.ok(AGENT_ROLES.includes("prompt"));
	assert.equal(AGENT_ROLES.length, 1);
});

test("prompt agent system contract is wired", () => {
	const contract = getPromptSystemContract();
	assert.match(contract, /specialized prompt engineering agent/);
	assert.match(contract, /durable principles/);
	assert.match(contract, /structured output/);
	assert.match(contract, /thinking\/effort control/);
	assert.match(contract, /source material before query/);
});

test("registerPromptEngineeringTools registers three tools with correct schemas", async () => {
	const registeredTools: Array<{
		name: string;
		description: string;
		schema: any;
		handler: Function;
	}> = [];

	const mockServer = {
		tool(name: string, description: string, schema: any, handler: Function) {
			registeredTools.push({ name, description, schema, handler });
		}
	} as any;

	registerPromptEngineeringTools(mockServer, {}, "user-123");

	assert.equal(registeredTools.length, 3);

	// 1. prompt_build
	const buildTool = registeredTools.find(t => t.name === "prompt_build");
	assert.ok(buildTool, "prompt_build tool must be registered");
	assert.match(buildTool.description, /Produces a paste-ready prompt/);
	
	// Schema validation checks for prompt_build
	assert.ok(buildTool.schema.target_tool instanceof z.ZodString, "target_tool must be z.string()");
	assert.ok(buildTool.schema.description instanceof z.ZodString, "description must be z.string()");
	assert.ok(buildTool.schema.use_memory instanceof z.ZodDefault, "use_memory must have default");
	assert.ok(buildTool.schema.target_capability instanceof z.ZodOptional, "target_capability must be optional");

	// 2. prompt_improve
	const improveTool = registeredTools.find(t => t.name === "prompt_improve");
	assert.ok(improveTool, "prompt_improve tool must be registered");
	assert.match(improveTool.description, /Identifies failure risks/);
	
	// Schema validation checks for prompt_improve
	assert.ok(improveTool.schema.prompt instanceof z.ZodString, "prompt must be z.string()");
	assert.ok(improveTool.schema.target_capability instanceof z.ZodOptional, "target_capability must be optional");

	// 3. prompt_evaluate
	const evaluateTool = registeredTools.find(t => t.name === "prompt_evaluate");
	assert.ok(evaluateTool, "prompt_evaluate tool must be registered");
	assert.match(evaluateTool.description, /Evaluates a prompt/);
	
	// Schema validation checks for prompt_evaluate
	assert.ok(evaluateTool.schema.prompt instanceof z.ZodString, "prompt must be z.string()");
});

test("prompt tool handlers execute internal logic correctly", async () => {
	const registeredTools: Array<{
		name: string;
		description: string;
		schema: any;
		handler: Function;
	}> = [];

	const mockServer = {
		tool(name: string, description: string, schema: any, handler: Function) {
			registeredTools.push({ name, description, schema, handler });
		}
	} as any;

	registerPromptEngineeringTools(mockServer, { DB: "mock-db" }, "user-123");

	const buildTool = registeredTools.find(t => t.name === "prompt_build")!;
	const improveTool = registeredTools.find(t => t.name === "prompt_improve")!;
	const evaluateTool = registeredTools.find(t => t.name === "prompt_evaluate")!;

	// Test handler for prompt_build
	const buildRes = await buildTool.handler({
		target_tool: "Claude",
		description: "A cool assistant prompt",
		use_memory: true,
		target_capability: "claude"
	});
	assert.ok(!buildRes.isError);
	const buildData = JSON.parse(buildRes.content[0].text);
	assert.match(buildData.prompt, /Claude-specific rules/);
	assert.match(buildData.prompt, /Retrieved Memory: mem-123/);
	assert.deepEqual(buildData.memoryIds, ["mem-123"]);

	// Test handler for prompt_improve
	const improveRes = await improveTool.handler({
		prompt: "Translate this text",
		target_capability: "claude"
	});
	assert.ok(!improveRes.isError);
	const improveData = JSON.parse(improveRes.content[0].text);
	assert.match(improveData.improvedPrompt, /Translate this text \[Improved\] with Claude-specific guidelines\./);

	// Test handler for prompt_evaluate
	const evaluateRes = await evaluateTool.handler({
		prompt: "Translate this text"
	});
	assert.ok(!evaluateRes.isError);
	const evaluateData = JSON.parse(evaluateRes.content[0].text);
	assert.equal(evaluateData.clarity, 0.9);
	assert.equal(evaluateData.operationalSafety, 0.95);
});
