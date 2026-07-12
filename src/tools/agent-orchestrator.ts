import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_ROLES, AGENT_TASK_STATUSES } from "../types";
import { multiAgentDebate, runRoleAgent } from "../utils/agents";
import {
	createAgentTask,
	getAgentTask,
	listAgentPresence,
	listAgentRuns,
	listAgentTasks,
	listAiAgents,
	listAiNotes,
	updateAgentTask,
	upsertAgentPresence,
	upsertAiNote,
} from "../utils/db";
import { toolError, toolText } from "../utils/tool-result";

/**
 * Specialized AI agents + shared task board for multi-agent workflows.
 * Complements the lower-level ai_note_* tools with role-runners and coordination.
 */
export function registerAgentOrchestratorTools(server: McpServer, env: Env, userId: string) {
	// ── Role agents ──

	server.tool(
		"memory_agent_ask",
		"Ask the Memory Agent a question answered strictly from stored memories (RAG). Use for 'what do we know about X?' before inventing facts.",
		{
			question: z.string().describe("Question to answer from memory"),
			extra_instruction: z
				.string()
				.optional()
				.describe("Optional extra guidance for the agent"),
		},
		async ({ question, extra_instruction }) => {
			try {
				const result = await runRoleAgent(
					"memory",
					userId,
					question,
					env,
					extra_instruction,
				);
				return toolText(
					`# Memory Agent\nRun: ${result.runId} | context memories: ${result.contextUsed}\n\n${result.output}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"research_agent",
		"Run the Research Agent over the personal knowledge base. Synthesizes known facts, gaps, and suggested next verifications/FOI items.",
		{
			topic: z.string().describe("Topic or research question"),
			extra_instruction: z.string().optional(),
		},
		async ({ topic, extra_instruction }) => {
			try {
				const result = await runRoleAgent("research", userId, topic, env, extra_instruction);
				return toolText(
					`# Research Agent\nRun: ${result.runId} | context: ${result.contextUsed}\n\n${result.output}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"drafting_agent",
		"Run the Drafting Agent in Jamie's preferred style (Australian English, paste-ready, evidence-grounded). Provide the drafting brief.",
		{
			brief: z
				.string()
				.describe("What to draft (letter, email, submission para, note, etc.)"),
			extra_instruction: z.string().optional(),
		},
		async ({ brief, extra_instruction }) => {
			try {
				const result = await runRoleAgent("drafting", userId, brief, env, extra_instruction);
				return toolText(
					`# Drafting Agent\nRun: ${result.runId} | context: ${result.contextUsed}\n\n${result.output}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"evidence_agent",
		"Run the Evidence/Chronology Agent for legal-administrative analysis: timeline, admitted facts, exhibit→proposition map, gaps, fairness issues.",
		{
			matter: z.string().describe("Matter or question to analyse evidentially"),
			extra_instruction: z.string().optional(),
		},
		async ({ matter, extra_instruction }) => {
			try {
				const result = await runRoleAgent("evidence", userId, matter, env, extra_instruction);
				return toolText(
					`# Evidence Agent\nRun: ${result.runId} | context: ${result.contextUsed}\n\n${result.output}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"strategy_agent",
		"Run the Strategy Agent: subtext, incentives, likely next moves, multi-pathway options, private vs public framing.",
		{
			situation: z.string().describe("Situation or decision to analyse strategically"),
			extra_instruction: z.string().optional(),
		},
		async ({ situation, extra_instruction }) => {
			try {
				const result = await runRoleAgent(
					"strategy",
					userId,
					situation,
					env,
					extra_instruction,
				);
				return toolText(
					`# Strategy Agent\nRun: ${result.runId} | context: ${result.contextUsed}\n\n${result.output}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"style_check_agent",
		"Run the Style Auditor on a draft against Jamie's writing preferences from memory.",
		{
			draft: z.string().describe("Draft text to audit"),
			extra_instruction: z.string().optional(),
		},
		async ({ draft, extra_instruction }) => {
			try {
				const result = await runRoleAgent(
					"style",
					userId,
					`Audit this draft:\n\n${draft}`,
					env,
					extra_instruction,
				);
				return toolText(
					`# Style Agent\nRun: ${result.runId}\n\n${result.output}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"morning_agent",
		"Morning memory coach: proposes high-value things to teach or update in long-term memory. Call as part of the daily ritual.",
		{
			focus: z
				.string()
				.optional()
				.describe("Optional focus area (e.g. litigation, tooling, preferences)"),
		},
		async ({ focus }) => {
			try {
				const input = focus
					? `Propose morning memory updates with focus: ${focus}`
					: "Propose morning memory updates based on current context and likely gaps.";
				const result = await runRoleAgent("morning", userId, input, env);
				return toolText(
					`# Morning Agent\nRun: ${result.runId}\n\n${result.output}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"run_agent",
		"Run any specialized agent role with a freeform task. Roles: memory, research, drafting, evidence, strategy, style, morning, general.",
		{
			role: z.enum(AGENT_ROLES).describe("Agent role to run"),
			task: z.string().describe("Task or prompt for the agent"),
			extra_instruction: z.string().optional(),
		},
		async ({ role, task, extra_instruction }) => {
			try {
				const result = await runRoleAgent(role, userId, task, env, extra_instruction);
				return toolText(
					`# Agent:${role}\nRun: ${result.runId} | context: ${result.contextUsed}\n\n${result.output}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"multi_agent_debate",
		"Run a FOR / stress-test / synthesis debate between agents using memory context. Useful for contested legal-administrative or strategy questions.",
		{ question: z.string().describe("Question or proposition to debate") },
		async ({ question }) => {
			try {
				const report = await multiAgentDebate(userId, question, env);
				return toolText(report);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	// ── Task board ──

	server.tool(
		"agent_task_create",
		"Create a task on the shared multi-agent task board for handoffs and work tracking.",
		{
			title: z.string().describe("Short task title"),
			description: z.string().optional().describe("Details / acceptance criteria"),
			priority: z.number().min(0).max(1).optional().default(0.5),
			assigned_agent: z
				.string()
				.optional()
				.describe("Preferred agent id (e.g. claude-code, grok-build, research)"),
			tags: z.array(z.string()).optional(),
		},
		async (params) => {
			try {
				const task = await createAgentTask(userId, params, env);
				return toolText(
					`Task created [${task.id}]: ${task.title} (status=${task.status}, priority=${task.priority})`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"agent_task_list",
		"List tasks on the shared board. Filter by status or agent.",
		{
			status: z.enum(AGENT_TASK_STATUSES).optional(),
			agent: z.string().optional().describe("Filter by assigned or claimed agent"),
			limit: z.number().optional().default(30),
		},
		async ({ status, agent, limit }) => {
			try {
				const tasks = await listAgentTasks(userId, env, { status, agent, limit });
				if (tasks.length === 0) return toolText("No tasks match.");
				const lines = tasks.map(
					(t) =>
						`[${t.id}] ${t.status} p=${t.priority.toFixed(2)} ${t.title}` +
						(t.assigned_agent ? ` → ${t.assigned_agent}` : "") +
						(t.claimed_by ? ` (claimed by ${t.claimed_by})` : ""),
				);
				return toolText(`${tasks.length} tasks:\n${lines.join("\n")}`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"agent_task_claim",
		"Claim an open task for a specific agent so others know who is working it.",
		{
			task_id: z.string(),
			agent_id: z.string().describe("Agent claiming the task"),
		},
		async ({ task_id, agent_id }) => {
			try {
				const task = await getAgentTask(task_id, userId, env);
				if (!task) return toolText(`Task ${task_id} not found.`);
				if (task.status !== "open" && task.status !== "claimed") {
					return toolText(`Task is ${task.status}; cannot claim.`);
				}
				await updateAgentTask(
					task_id,
					userId,
					{ status: "claimed", claimed_by: agent_id },
					env,
				);
				return toolText(`Task ${task_id} claimed by ${agent_id}.`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"agent_task_complete",
		"Mark a task done and store the result summary for other agents.",
		{
			task_id: z.string(),
			result: z.string().describe("What was done / outcome"),
			agent_id: z.string().optional().describe("Agent completing the task"),
		},
		async ({ task_id, result, agent_id }) => {
			try {
				const task = await getAgentTask(task_id, userId, env);
				if (!task) return toolText(`Task ${task_id} not found.`);
				await updateAgentTask(
					task_id,
					userId,
					{
						status: "done",
						result,
						claimed_by: agent_id ?? task.claimed_by,
					},
					env,
				);
				return toolText(`Task ${task_id} marked done.`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"agent_task_fail",
		"Mark a task failed with a reason so another agent can retry or replan.",
		{
			task_id: z.string(),
			reason: z.string(),
		},
		async ({ task_id, reason }) => {
			try {
				await updateAgentTask(task_id, userId, { status: "failed", result: reason }, env);
				return toolText(`Task ${task_id} marked failed: ${reason}`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	// ── Presence & handoff ──

	server.tool(
		"agent_register_presence",
		"Register or heartbeat an agent's presence (role, status, capabilities) for multi-agent coordination.",
		{
			agent_id: z.string().describe("Your agent id (e.g. grok-build, claude-code)"),
			role: z
				.enum(AGENT_ROLES)
				.optional()
				.default("general")
				.describe("Primary role"),
			status: z
				.enum(["online", "busy", "idle", "offline"])
				.optional()
				.default("online"),
			capabilities: z
				.array(z.string())
				.optional()
				.describe("Capability tags, e.g. ['deploy','drafting','d1']"),
		},
		async ({ agent_id, role, status, capabilities }) => {
			try {
				const id = await upsertAgentPresence(
					userId,
					agent_id,
					{ role, status, capabilities },
					env,
				);
				return toolText(
					`Presence registered: ${agent_id} as ${role} (${status}) [${id}]`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"agent_handoff",
		"Create a structured handoff package for another agent: writes an ai_note and optionally creates a follow-up task.",
		{
			from_agent: z.string().describe("Your agent id"),
			to_agent: z.string().describe("Target agent id"),
			summary: z.string().describe("What was done and what remains"),
			next_steps: z.string().optional().describe("Concrete next steps"),
			create_task: z
				.boolean()
				.optional()
				.default(true)
				.describe("Also create a board task for the target agent"),
			priority: z.number().min(0).max(1).optional().default(0.7),
		},
		async ({ from_agent, to_agent, summary, next_steps, create_task, priority }) => {
			try {
				const content = [
					`# Handoff ${from_agent} → ${to_agent}`,
					`Time: ${new Date().toISOString()}`,
					"",
					"## Summary",
					summary,
					next_steps ? `\n## Next steps\n${next_steps}` : "",
				].join("\n");

				const noteId = await upsertAiNote(
					userId,
					from_agent,
					`handoff-to-${to_agent}`,
					content,
					env,
					"handoffs",
				);

				let taskLine = "";
				if (create_task) {
					const task = await createAgentTask(
						userId,
						{
							title: `Handoff from ${from_agent}: ${summary.slice(0, 80)}`,
							description: content,
							priority,
							assigned_agent: to_agent,
							tags: ["handoff", from_agent, to_agent],
						},
						env,
					);
					taskLine = `\nTask created: ${task.id}`;
				}

				await upsertAgentPresence(userId, from_agent, { status: "idle" }, env);
				return toolText(`Handoff saved (note ${noteId}).${taskLine}`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"agents_dashboard",
		"Dashboard of multi-agent state: presence, open tasks, recent notes, and recent agent runs.",
		{},
		async () => {
			try {
				const [presence, openTasks, agents, notes, runs] = await Promise.all([
					listAgentPresence(userId, env),
					listAgentTasks(userId, env, { status: "open", limit: 15 }),
					listAiAgents(userId, env),
					listAiNotes(userId, env),
					listAgentRuns(userId, env, undefined, 10),
				]);
				const claimed = await listAgentTasks(userId, env, {
					status: "claimed",
					limit: 15,
				});

				let report = `# Agents Dashboard\n\n`;
				report += `## Presence (${presence.length})\n`;
				if (presence.length === 0) report += "(none registered)\n";
				else {
					for (const p of presence) {
						report += `- ${p.agent_id} [${p.role}] ${p.status} last_seen=${p.last_seen}\n`;
					}
				}

				report += `\n## Note-leaving agents (${agents.length})\n`;
				report += agents.length
					? agents.map((a) => `- ${a}`).join("\n") + "\n"
					: "(none)\n";

				report += `\n## Open tasks (${openTasks.length})\n`;
				report += openTasks.length
					? openTasks.map((t) => `- [${t.id}] ${t.title}`).join("\n") + "\n"
					: "(none)\n";

				report += `\n## Claimed tasks (${claimed.length})\n`;
				report += claimed.length
					? claimed
							.map((t) => `- [${t.id}] ${t.title} @ ${t.claimed_by}`)
							.join("\n") + "\n"
					: "(none)\n";

				report += `\n## Recent notes (${Math.min(notes.length, 12)})\n`;
				for (const n of notes.slice(0, 12)) {
					report += `- [${n.agent_id}] ${n.key}: ${n.content.slice(0, 70).replace(/\n/g, " ")}…\n`;
				}

				report += `\n## Recent agent runs (${runs.length})\n`;
				for (const r of runs) {
					report += `- ${r.created_at} ${r.agent_role}: ${r.input.slice(0, 60).replace(/\n/g, " ")}…\n`;
				}

				return toolText(report);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"agent_runs_list",
		"List recent specialized-agent runs (memory/research/drafting/etc.) for audit and reuse.",
		{
			role: z.enum(AGENT_ROLES).optional(),
			limit: z.number().optional().default(15),
		},
		async ({ role, limit }) => {
			try {
				const runs = await listAgentRuns(userId, env, role, limit);
				if (runs.length === 0) return toolText("No agent runs recorded.");
				const lines = runs.map(
					(r) =>
						`[${r.id}] ${r.created_at} ${r.agent_role}\n  in: ${r.input.slice(0, 100).replace(/\n/g, " ")}\n  out: ${(r.output || "").slice(0, 120).replace(/\n/g, " ")}`,
				);
				return toolText(`${runs.length} runs:\n\n${lines.join("\n\n")}`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"brief_for_agent",
		"Generate a role-specific brief for another agent (context pack + standing rules) so they can start productively.",
		{
			target_role: z.enum(AGENT_ROLES).describe("Role to brief"),
			mission: z.string().describe("What that agent should accomplish"),
		},
		async ({ target_role, mission }) => {
			try {
				const result = await runRoleAgent(
					"general",
					userId,
					`Prepare a handoff brief for a ${target_role} agent.\nMission: ${mission}\nInclude: relevant memory bullets, constraints, success criteria, and first 3 actions.`,
					env,
					`Format as a brief the ${target_role} agent can execute immediately.`,
				);
				const noteId = await upsertAiNote(
					userId,
					"orchestrator",
					`brief-${target_role}`,
					result.output,
					env,
					"briefs",
				);
				return toolText(
					`# Brief for ${target_role}\nSaved note: orchestrator/brief-${target_role} [${noteId}]\n\n${result.output}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);
}
