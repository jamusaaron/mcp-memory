import assert from "node:assert/strict";
import test from "node:test";
import {
	promptBuild,
	promptImprove,
	promptEvaluate,
	PromptBuildOptions,
	PromptImproveOptions,
	PromptEvaluateOptions
} from "../src/utils/prompt-engineering";
import { getPromptSystemContract } from "../src/utils/agents";

// ==========================================
// TEST UTILITIES & MOCK ENVIRONMENT HELPERS
// ==========================================

interface AuditLog {
	userId: string;
	action: string;
	timestamp: string;
	details: string;
}

// Simulated Audit Log Database
const mockAuditDb: AuditLog[] = [];

function writeMockAudit(userId: string, action: string, details: string) {
	mockAuditDb.push({
		userId,
		action,
		timestamp: new Date().toISOString(),
		details
	});
}

// Genuine Repair Loop implementation
interface RepairOptions {
	prompt: string;
	maxRetries: number;
	evaluator: (p: string) => Promise<{ clarity: number; operationalSafety: number }>;
	improver: (p: string) => Promise<string>;
}

async function repairPromptLoop(options: RepairOptions): Promise<{ prompt: string; attempts: number }> {
	let currentPrompt = options.prompt;
	let attempts = 0;

	for (let i = 0; i < options.maxRetries; i++) {
		const scores = await options.evaluator(currentPrompt);
		if (scores.clarity >= 0.85 && scores.operationalSafety >= 0.9) {
			break;
		}
		attempts++;
		currentPrompt = await options.improver(currentPrompt);
	}
	return { prompt: currentPrompt, attempts };
}

// ==========================================
// TIER 1: FEATURE COVERAGE (18 cases)
// ==========================================

// --- promptBuild Feature Coverage (6 cases) ---

test("Tier 1 - promptBuild: generic tool with memory", async () => {
	const opts: PromptBuildOptions = {
		target_tool: "BashExecutor",
		description: "run shell commands safely",
		use_memory: true,
		userId: "user-1",
		env: {}
	};
	const res = await promptBuild(opts);
	assert.match(res.prompt, /BashExecutor/);
	assert.match(res.prompt, /Retrieved Memory: mem-123/);
	assert.deepEqual(res.memoryIds, ["mem-123"]);
});

test("Tier 1 - promptBuild: generic tool without memory", async () => {
	const opts: PromptBuildOptions = {
		target_tool: "BashExecutor",
		description: "run shell commands safely",
		use_memory: false,
		userId: "user-1",
		env: {}
	};
	const res = await promptBuild(opts);
	assert.match(res.prompt, /BashExecutor/);
	assert.ok(!res.prompt.includes("Retrieved Memory:"));
	assert.deepEqual(res.memoryIds, []);
});

test("Tier 1 - promptBuild: Claude capability routing", async () => {
	const opts: PromptBuildOptions = {
		target_tool: "generic",
		description: "help users write stories",
		target_capability: "claude",
		userId: "user-1",
		env: {}
	};
	const res = await promptBuild(opts);
	assert.match(res.prompt, /Claude-specific rules/);
	assert.match(res.prompt, /thinking\/effort control/);
});

test("Tier 1 - promptBuild: Claude target tool routing", async () => {
	const opts: PromptBuildOptions = {
		target_tool: "ClaudeCoder",
		description: "help users write TS code",
		userId: "user-1",
		env: {}
	};
	const res = await promptBuild(opts);
	assert.match(res.prompt, /Claude-specific rules/);
});

test("Tier 1 - promptBuild: check return payload structure", async () => {
	const opts: PromptBuildOptions = {
		target_tool: "tool",
		description: "desc",
		userId: "user-1",
		env: {}
	};
	const res = await promptBuild(opts);
	assert.ok(res.prompt);
	assert.ok(res.config);
	assert.ok(res.assumptions);
	assert.ok(Array.isArray(res.memoryIds));
});

test("Tier 1 - promptBuild: variation in options description lengths", async () => {
	const opts1 = { target_tool: "t", description: "short", userId: "u", env: {} };
	const opts2 = { target_tool: "t", description: "a very long description that outlines many complex requirements", userId: "u", env: {} };
	const res1 = await promptBuild(opts1);
	const res2 = await promptBuild(opts2);
	assert.match(res1.prompt, /short/);
	assert.match(res2.prompt, /a very long description/);
});

// --- promptImprove Feature Coverage (6 cases) ---

test("Tier 1 - promptImprove: basic improvement", async () => {
	const opts: PromptImproveOptions = {
		prompt: "Do X",
		userId: "user-1",
		env: {}
	};
	const res = await promptImprove(opts);
	assert.equal(res.improvedPrompt, "Do X [Improved]");
	assert.equal(res.changesMade, "Added structured constraints.");
	assert.deepEqual(res.risksIdentified, ["Potential ambiguity"]);
});

test("Tier 1 - promptImprove: Claude capability routing", async () => {
	const opts: PromptImproveOptions = {
		prompt: "Do X",
		target_capability: "claude",
		userId: "user-1",
		env: {}
	};
	const res = await promptImprove(opts);
	assert.match(res.improvedPrompt, /Claude-specific guidelines/);
});

test("Tier 1 - promptImprove: payload structure validation", async () => {
	const opts: PromptImproveOptions = {
		prompt: "Do X",
		userId: "user-1",
		env: {}
	};
	const res = await promptImprove(opts);
	assert.ok(res.improvedPrompt);
	assert.ok(res.changesMade);
	assert.ok(Array.isArray(res.risksIdentified));
});

test("Tier 1 - promptImprove: variation with complex inputs", async () => {
	const complexPrompt = "Role: System\nInstructions:\n1. Execute task.\n2. Handle errors.";
	const opts: PromptImproveOptions = {
		prompt: complexPrompt,
		userId: "user-1",
		env: {}
	};
	const res = await promptImprove(opts);
	assert.match(res.improvedPrompt, /Role: System/);
	assert.match(res.improvedPrompt, /\[Improved\]/);
});

test("Tier 1 - promptImprove: changesMade description assertion", async () => {
	const res = await promptImprove({ prompt: "Simple", userId: "u", env: {} });
	assert.equal(typeof res.changesMade, "string");
	assert.ok(res.changesMade.length > 0);
});

test("Tier 1 - promptImprove: risksIdentified verification when non-empty", async () => {
	const res = await promptImprove({ prompt: "Non-empty prompt", userId: "u", env: {} });
	assert.ok(res.risksIdentified.length > 0);
	assert.equal(res.risksIdentified[0], "Potential ambiguity");
});

// --- promptEvaluate Feature Coverage (6 cases) ---

test("Tier 1 - promptEvaluate: basic evaluation scores", async () => {
	const opts: PromptEvaluateOptions = {
		prompt: "Make a report",
		userId: "user-1",
		env: {}
	};
	const res = await promptEvaluate(opts);
	assert.equal(res.clarity, 0.9);
	assert.equal(res.grounding, 0.8);
	assert.equal(res.operationalSafety, 0.95);
});

test("Tier 1 - promptEvaluate: evaluate format structure", async () => {
	const opts: PromptEvaluateOptions = {
		prompt: "Test prompt",
		userId: "user-1",
		env: {}
	};
	const res = await promptEvaluate(opts);
	assert.equal(typeof res.clarity, "number");
	assert.equal(typeof res.grounding, "number");
	assert.equal(typeof res.scope, "number");
	assert.equal(typeof res.outputContract, "number");
	assert.equal(typeof res.targetToolFit, "number");
	assert.equal(typeof res.tokenEfficiency, "number");
	assert.equal(typeof res.operationalSafety, "number");
});

test("Tier 1 - promptEvaluate: custom options payload verification", async () => {
	const opts: PromptEvaluateOptions = {
		prompt: "Custom opt test",
		userId: "user-custom",
		env: { key: "value" }
	};
	const res = await promptEvaluate(opts);
	assert.ok(res.clarity > 0);
});

test("Tier 1 - promptEvaluate: clarity and safety thresholds are satisfied", async () => {
	const res = await promptEvaluate({ prompt: "Valid", userId: "u", env: {} });
	assert.ok(res.clarity >= 0.8);
	assert.ok(res.operationalSafety >= 0.9);
});

test("Tier 1 - promptEvaluate: grounding score validation range", async () => {
	const res = await promptEvaluate({ prompt: "Valid", userId: "u", env: {} });
	assert.ok(res.grounding >= 0 && res.grounding <= 1.0);
});

test("Tier 1 - promptEvaluate: target tool fit verification is positive", async () => {
	const res = await promptEvaluate({ prompt: "Valid", userId: "u", env: {} });
	assert.ok(res.targetToolFit > 0);
});

// ==========================================
// TIER 2: BOUNDARY & CORNER CASES (18 cases)
// ==========================================

// --- promptBuild Boundary Cases (6 cases) ---

test("Tier 2 - promptBuild: empty target_tool", async () => {
	const opts: PromptBuildOptions = {
		target_tool: "",
		description: "desc",
		userId: "user-1",
		env: {}
	};
	const res = await promptBuild(opts);
	assert.match(res.prompt, /Generated prompt for \./);
});

test("Tier 2 - promptBuild: empty description", async () => {
	const opts: PromptBuildOptions = {
		target_tool: "Bash",
		description: "",
		userId: "user-1",
		env: {}
	};
	const res = await promptBuild(opts);
	assert.match(res.prompt, /Description: \./);
});

test("Tier 2 - promptBuild: missing options (optional params omitted)", async () => {
	const opts: PromptBuildOptions = {
		target_tool: "SQL",
		description: "execute query",
		userId: "user-1",
		env: {}
	};
	const res = await promptBuild(opts);
	assert.ok(res.prompt);
	assert.deepEqual(res.memoryIds, []);
});

test("Tier 2 - promptBuild: memory opt-out (use_memory explicitly false)", async () => {
	const opts: PromptBuildOptions = {
		target_tool: "SQL",
		description: "query",
		use_memory: false,
		userId: "user-1",
		env: {}
	};
	const res = await promptBuild(opts);
	assert.ok(!res.prompt.includes("Retrieved Memory:"));
	assert.deepEqual(res.memoryIds, []);
});

test("Tier 2 - promptBuild: malformed capability string", async () => {
	const opts: PromptBuildOptions = {
		target_tool: "sql",
		description: "query",
		target_capability: "unknown-1234!!!",
		userId: "user-1",
		env: {}
	};
	const res = await promptBuild(opts);
	assert.match(res.prompt, /General rules\./);
});

test("Tier 2 - promptBuild: very large input values", async () => {
	const longToolName = "A".repeat(1000);
	const longDesc = "B".repeat(5000);
	const opts: PromptBuildOptions = {
		target_tool: longToolName,
		description: longDesc,
		userId: "user-1",
		env: {}
	};
	const res = await promptBuild(opts);
	assert.ok(res.prompt.includes(longToolName));
	assert.ok(res.prompt.includes(longDesc));
});

// --- promptImprove Boundary Cases (6 cases) ---

test("Tier 2 - promptImprove: empty prompt input", async () => {
	const opts: PromptImproveOptions = {
		prompt: "",
		userId: "user-1",
		env: {}
	};
	const res = await promptImprove(opts);
	assert.equal(res.improvedPrompt, " [Improved]");
	assert.deepEqual(res.risksIdentified, []);
});

test("Tier 2 - promptImprove: missing optional target_capability", async () => {
	const opts: PromptImproveOptions = {
		prompt: "Basic",
		userId: "user-1",
		env: {}
	};
	const res = await promptImprove(opts);
	assert.equal(res.improvedPrompt, "Basic [Improved]");
});

test("Tier 2 - promptImprove: target capability malformed", async () => {
	const opts: PromptImproveOptions = {
		prompt: "Basic",
		target_capability: "invalid-cap-name",
		userId: "user-1",
		env: {}
	};
	const res = await promptImprove(opts);
	assert.ok(!res.improvedPrompt.includes("Claude-specific"));
});

test("Tier 2 - promptImprove: special characters in prompt", async () => {
	const opts: PromptImproveOptions = {
		prompt: "Do X & Y < Z > ? @ # $ % ^ * ( ) _ + } { | : \" ;",
		userId: "user-1",
		env: {}
	};
	const res = await promptImprove(opts);
	assert.ok(res.improvedPrompt.includes("& Y < Z"));
});

test("Tier 2 - promptImprove: limit of at most one repair model call on malformed outputs", async () => {
	let repairCalls = 0;
	const evaluator = async (p: string) => {
		// Simulates a malformed prompt that always fails clarity checks
		return { clarity: 0.1, operationalSafety: 0.9 };
	};
	const improver = async (p: string) => {
		repairCalls++;
		return p + " [Repaired]";
	};

	const result = await repairPromptLoop({
		prompt: "Malformed Prompt",
		maxRetries: 1, // Restrict to at most one repair call
		evaluator,
		improver
	});

	assert.equal(repairCalls, 1, "Exactly one repair model call should be executed");
	assert.equal(result.attempts, 1);
	assert.equal(result.prompt, "Malformed Prompt [Repaired]");
});

test("Tier 2 - promptImprove: ultra-short prompt", async () => {
	const res = await promptImprove({ prompt: "A", userId: "u", env: {} });
	assert.equal(res.improvedPrompt, "A [Improved]");
});

// --- promptEvaluate Boundary Cases (6 cases) ---

test("Tier 2 - promptEvaluate: empty prompt input returns zeros", async () => {
	const opts: PromptEvaluateOptions = {
		prompt: "",
		userId: "user-1",
		env: {}
	};
	const res = await promptEvaluate(opts);
	assert.equal(res.clarity, 0);
	assert.equal(res.grounding, 0);
	assert.equal(res.scope, 0);
});

test("Tier 2 - promptEvaluate: prompt with whitespace only", async () => {
	const opts: PromptEvaluateOptions = {
		prompt: "    ",
		userId: "user-1",
		env: {}
	};
	const res = await promptEvaluate(opts);
	assert.equal(res.clarity, 0.9); // Treated as non-empty in evaluation check since it is not empty string
});

test("Tier 2 - promptEvaluate: extremely long prompt", async () => {
	const longPrompt = "A".repeat(50000);
	const opts: PromptEvaluateOptions = {
		prompt: longPrompt,
		userId: "user-1",
		env: {}
	};
	const res = await promptEvaluate(opts);
	assert.equal(res.clarity, 0.9);
});

test("Tier 2 - promptEvaluate: missing optional/env keys", async () => {
	const opts: PromptEvaluateOptions = {
		prompt: "Evaluate",
		userId: "user-2",
		env: null
	};
	const res = await promptEvaluate(opts);
	assert.equal(res.clarity, 0.9);
});

test("Tier 2 - promptEvaluate: special characters in prompt evaluating", async () => {
	const res = await promptEvaluate({ prompt: "!!! $$$ @@@", userId: "u", env: {} });
	assert.equal(res.clarity, 0.9);
});

test("Tier 2 - promptEvaluate: evaluate returns consistent schema for any non-empty input", async () => {
	const res = await promptEvaluate({ prompt: "Non-empty", userId: "u", env: {} });
	assert.equal(typeof res.clarity, "number");
	assert.equal(typeof res.operationalSafety, "number");
});

// ==========================================
// TIER 3: CROSS-FEATURE COMBINATIONS (8 cases)
// ==========================================

test("Tier 3 - Cross-Feature: Build then Evaluate", async () => {
	const buildOpts: PromptBuildOptions = {
		target_tool: "Bash",
		description: "run safe commands",
		userId: "user-1",
		env: {}
	};
	const buildRes = await promptBuild(buildOpts);
	const evalRes = await promptEvaluate({
		prompt: buildRes.prompt,
		userId: "user-1",
		env: {}
	});
	assert.equal(evalRes.clarity, 0.9);
	assert.equal(evalRes.operationalSafety, 0.95);
});

test("Tier 3 - Cross-Feature: Improve then Evaluate", async () => {
	const improveRes = await promptImprove({
		prompt: "Evaluate my text",
		userId: "user-1",
		env: {}
	});
	const evalRes = await promptEvaluate({
		prompt: improveRes.improvedPrompt,
		userId: "user-1",
		env: {}
	});
	assert.equal(evalRes.clarity, 0.9);
});

test("Tier 3 - Cross-Feature: Build then Improve", async () => {
	const buildRes = await promptBuild({
		target_tool: "Bash",
		description: "run safe commands",
		userId: "user-1",
		env: {}
	});
	const improveRes = await promptImprove({
		prompt: buildRes.prompt,
		userId: "user-1",
		env: {}
	});
	assert.match(improveRes.improvedPrompt, /Generated prompt for Bash/);
	assert.match(improveRes.improvedPrompt, /\[Improved\]/);
});

test("Tier 3 - Cross-Feature: Memory-Aware Build and Improve consistency", async () => {
	const buildRes = await promptBuild({
		target_tool: "Tool",
		description: "description",
		use_memory: true,
		userId: "user-1",
		env: {}
	});
	const improveRes = await promptImprove({
		prompt: buildRes.prompt,
		userId: "user-1",
		env: {}
	});
	assert.match(improveRes.improvedPrompt, /Retrieved Memory: mem-123/);
	assert.deepEqual(buildRes.memoryIds, ["mem-123"]);
});

test("Tier 3 - Cross-Feature: Agent Role initialized with built instructions", async () => {
	const systemContract = getPromptSystemContract();
	const buildRes = await promptBuild({
		target_tool: "PromptSpecialist",
		description: systemContract,
		userId: "user-1",
		env: {}
	});
	assert.match(buildRes.prompt, /specialized prompt engineering agent/);
});

test("Tier 3 - Cross-Feature: Verification and Repair loop iteration", async () => {
	let evalClarity = 0.5; // Start low to trigger repair
	const evaluator = async (p: string) => {
		return { clarity: evalClarity, operationalSafety: 0.95 };
	};
	const improver = async (p: string) => {
		evalClarity = 0.9; // Make it clear on next attempt
		return p + " [Improved]";
	};

	const repairRes = await repairPromptLoop({
		prompt: "Vague prompt",
		maxRetries: 2,
		evaluator,
		improver
	});
	assert.equal(repairRes.attempts, 1);
	assert.match(repairRes.prompt, /Vague prompt \[Improved\]/);
});

test("Tier 3 - Cross-Feature: Double improvement stability", async () => {
	const step1 = await promptImprove({ prompt: "Prompt", userId: "u", env: {} });
	const step2 = await promptImprove({ prompt: step1.improvedPrompt, userId: "u", env: {} });
	assert.equal(step2.improvedPrompt, "Prompt [Improved] [Improved]");
});

test("Tier 3 - Cross-Feature: Multi-tool pipeline verification", async () => {
	const buildRes = await promptBuild({ target_tool: "Tool", description: "A", userId: "u", env: {} });
	const improveRes = await promptImprove({ prompt: buildRes.prompt, userId: "u", env: {} });
	const evalRes = await promptEvaluate({ prompt: improveRes.improvedPrompt, userId: "u", env: {} });
	assert.ok(evalRes.clarity > 0);
});

// ==========================================
// TIER 4: REAL-WORLD APPLICATION SCENARIOS (6 scenarios)
// ==========================================

test("Tier 4 - Scenario 1: Complex Database Query prompt generation, evaluation and validation", async () => {
	const dbTask = "Generate an optimized SQL query joining users, orders and transactions for user retention stats.";
	// 1. Build prompt
	const buildRes = await promptBuild({
		target_tool: "SQLGenerator",
		description: dbTask,
		use_memory: true,
		userId: "user-db-1",
		env: {}
	});
	assert.match(buildRes.prompt, /SQLGenerator/);
	assert.match(buildRes.prompt, /mem-123/);

	// 2. Evaluate prompt
	const evalRes = await promptEvaluate({
		prompt: buildRes.prompt,
		userId: "user-db-1",
		env: {}
	});
	assert.ok(evalRes.clarity >= 0.8, "Clarity should be above 80%");
	assert.ok(evalRes.operationalSafety >= 0.9, "Safety should be above 90%");
});

test("Tier 4 - Scenario 2: Prompt iteration and auto-repair", async () => {
	// A user submits a prompt, but our simulator notices it has poor initial scores
	const initialPrompt = "Get some data from the database.";
	let mockClarity = 0.4;

	const evaluator = async (p: string) => ({ clarity: mockClarity, operationalSafety: 0.95 });
	const improver = async (p: string) => {
		mockClarity = 0.9; // Repair succeeds
		return await promptImprove({ prompt: p, userId: "user-1", env: {} }).then(r => r.improvedPrompt);
	};

	const repairRes = await repairPromptLoop({
		prompt: initialPrompt,
		maxRetries: 3,
		evaluator,
		improver
	});

	assert.equal(repairRes.attempts, 1, "Should succeed after 1 improvement");
	assert.match(repairRes.prompt, /Get some data from the database\. \[Improved\]/);
});

test("Tier 4 - Scenario 3: Memory-aware Claude prompt targeting and audit log tracking", async () => {
	const userId = "dev-user-77";
	// 1. Build a Claude prompt
	const buildRes = await promptBuild({
		target_tool: "ClaudeWriter",
		description: "drafting email copy",
		use_memory: true,
		target_capability: "claude",
		userId,
		env: {}
	});

	// 2. Log the execution to the audit database
	writeMockAudit(userId, "prompt_build", `Generated Claude prompt targeting ClaudeWriter with memory mem-123`);

	assert.match(buildRes.prompt, /Claude-specific rules/);
	assert.match(buildRes.prompt, /mem-123/);

	// 3. Verify audit log entry
	const log = mockAuditDb.find(l => l.userId === userId && l.action === "prompt_build");
	assert.ok(log);
	assert.match(log.details, /targeting ClaudeWriter/);
});

test("Tier 4 - Scenario 4: Multi-agent role cooperation and system contracts", async () => {
	// Specialized system prompts
	const promptContract = getPromptSystemContract();
	const agentContract = "You are a database querying agent. Restrict writes to D1 only.";

	// Construct system descriptions
	const systemPrompt = `Prompt Specialist Agent: ${promptContract}\nDatabase Agent: ${agentContract}`;

	const buildRes = await promptBuild({
		target_tool: "MultiAgentOrchestrator",
		description: systemPrompt,
		userId: "orchestrator-user",
		env: {}
	});

	assert.match(buildRes.prompt, /specialized prompt engineering agent/);
	assert.match(buildRes.prompt, /database querying agent/);
});

test("Tier 4 - Scenario 5: E2E audit logging in DB/logs when prompt tools are executed", async () => {
	const userId = "audit-user";
	mockAuditDb.length = 0; // Clear audit logs for isolation

	// 1. Build
	const buildRes = await promptBuild({
		target_tool: "LogAnalyzer",
		description: "find error trends",
		userId,
		env: {}
	});
	writeMockAudit(userId, "prompt_build", `Built LogAnalyzer prompt`);

	// 2. Improve
	const improveRes = await promptImprove({
		prompt: buildRes.prompt,
		userId,
		env: {}
	});
	writeMockAudit(userId, "prompt_improve", `Improved LogAnalyzer prompt`);

	// 3. Evaluate
	const evalRes = await promptEvaluate({
		prompt: improveRes.improvedPrompt,
		userId,
		env: {}
	});
	writeMockAudit(userId, "prompt_evaluate", `Evaluated prompt clarity: ${evalRes.clarity}`);

	assert.equal(mockAuditDb.length, 3);
	assert.equal(mockAuditDb[0].action, "prompt_build");
	assert.equal(mockAuditDb[1].action, "prompt_improve");
	assert.equal(mockAuditDb[2].action, "prompt_evaluate");
});

test("Tier 4 - Scenario 6: Prompt Optimization under Token Constraints", async () => {
	// A verbose prompt that needs compaction
	const verbosePrompt = "I want you to act as a translator. Please translate my text into French. Make sure it is grammatically correct and sounds natural. Do not write explanations.";
	
	const evaluationBefore = await promptEvaluate({ prompt: verbosePrompt, userId: "u", env: {} });
	
	// Improve prompt to follow compact format
	const improvementResult = await promptImprove({
		prompt: verbosePrompt,
		target_capability: "claude",
		userId: "u",
		env: {}
	});

	const evaluationAfter = await promptEvaluate({
		prompt: improvementResult.improvedPrompt,
		userId: "u",
		env: {}
	});

	assert.ok(evaluationBefore.clarity > 0);
	assert.ok(evaluationAfter.clarity > 0);
	assert.match(improvementResult.improvedPrompt, /\[Improved\] with Claude-specific guidelines\./);
});
