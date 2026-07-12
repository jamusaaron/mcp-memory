/**
 * Seed/teach Jamie's mcp-memory namespace with grounded identity + tooling facts.
 * Uses Cloudflare API via wrangler auth is not available here — invoke through
 * cloudflare MCP or: node scripts/teach-jamie-memory.mjs (with CF_API_TOKEN).
 *
 * This file is the source of truth for the memory payload; applied via the agent.
 */

export const USER_ID = "fe542582-e9bc-4f88-8fd8-e49c5672d92a";
export const PERSON_ID = "6aa181f8-ef31-41a7-9796-5097494188e7";

/** Outdated or duplicate memory IDs to soft-suppress */
export const SUPPRESS = [
	{
		id: "bf4ac0e6-e941-492f-9a78-07f4ea27bf3b",
		reason:
			"Outdated: described Jamie as having current public-service work context; superseded by dismissal (Feb 2026) and self-represented litigant status.",
	},
	{
		id: "ad826d6f-72be-42d2-ac86-c6698f5875c7",
		reason: "Duplicate of consolidated daily morning MCP memory update rule.",
	},
	{
		id: "2a33b35c-24b2-4226-903e-e390c628c018",
		reason: "Duplicate of consolidated daily morning MCP memory update rule.",
	},
];

export const NEW_MEMORIES = [
	{
		category: "identity",
		layer: "core",
		confidence: 1,
		salience: 1,
		pinned: 1,
		tags: ["identity", "name", "jamie"],
		subject: "Legal name",
		text: "The user's full name is Jamie Young (aliases: Jamie, JY, jamusaaron). Prefer addressing as Jamie unless formal legal drafting requires full name.",
	},
	{
		category: "identity",
		layer: "core",
		confidence: 0.95,
		salience: 0.85,
		pinned: 1,
		tags: ["contact", "github", "cloudflare", "email"],
		subject: "Accounts and handles",
		text: "Jamie's primary technical accounts: GitHub jamusaaron; Cloudflare account email jamusaaron@gmail.com (account id e90bb5ab9f60c60dff3ab4ad5fba65d9); local macOS username jamieyoung. Claude Desktop device name jymini1-local.",
	},
	{
		category: "identity",
		layer: "core",
		confidence: 1,
		salience: 0.95,
		pinned: 1,
		tags: ["mcp-memory", "namespace", "endpoint"],
		subject: "MCP Memory namespace",
		text: "Jamie's production mcp-memory userId/namespace is fe542582-e9bc-4f88-8fd8-e49c5672d92a. Worker URL: https://mcp-memory.jamusaaron.workers.dev. SSE endpoint: https://mcp-memory.jamusaaron.workers.dev/fe542582-e9bc-4f88-8fd8-e49c5672d92a/sse. Do not use empty placeholder IDs like 1030F75D-... or claude-user for production memory.",
	},
	{
		category: "projects",
		layer: "current",
		confidence: 0.95,
		salience: 0.9,
		pinned: 1,
		tags: ["mcp-memory", "cloudflare", "workers"],
		subject: "Self-hosted MCP Memory",
		text: "Jamie self-hosts mcp-memory on Cloudflare Workers (repo github.com/jamusaaron/mcp-memory) with D1, KV, Vectorize, Workers AI, and Durable Objects. As of 2026-07-11 the live surface is ~110 tools with no R2 dependency (context docs in KV). He invests heavily in improving this personal long-term memory layer across Claude, Grok, and other MCP clients.",
	},
	{
		category: "projects",
		layer: "current",
		confidence: 0.95,
		salience: 0.85,
		pinned: 0,
		tags: ["fair-work", "finance", "litigation"],
		subject: "Young v Department of Finance",
		text: "Jamie has an active Fair Work / employment-related matter styled Young v Department of Finance (including materials referencing C2025:10119 and written submissions). Treat carefully: chronology, evidence, and procedural fairness first; do not invent case outcomes.",
	},
	{
		category: "ai",
		layer: "long_embedded",
		confidence: 0.95,
		salience: 0.9,
		pinned: 1,
		tags: ["ai", "tools", "claude", "grok", "codex"],
		subject: "AI tooling stack",
		text: "Jamie regularly uses multiple AI coding agents in parallel: Claude (Desktop/Code), Grok Build (xAI), and Codex. He builds MCP servers, Claude skills, Grok skills, and Cloudflare Workers. Prefer concrete implementation and deploy verification over abstract advice.",
	},
	{
		category: "preferences",
		layer: "core",
		confidence: 0.95,
		salience: 0.9,
		pinned: 1,
		tags: ["style", "australian", "drafting"],
		subject: "Communication defaults",
		text: "Default communication for Jamie: Australian English spelling, direct declarative prose, adult-to-adult tone, explicit uncertainty, paste-ready outputs for drafting tasks, and structured analysis that separates proven / inferred / vulnerable / opposing-party arguments.",
	},
	{
		category: "likes",
		layer: "long_embedded",
		confidence: 0.9,
		salience: 0.7,
		pinned: 0,
		tags: ["tesla", "ev", "simulation"],
		subject: "Tesla and simulation interests",
		text: "Jamie has ongoing interest in Tesla/EVs (including Model 3 related materials and light-show tooling) and in technical-cinematic simulation projects (e.g. MODEL 3 recursive decoy/agent simulations). Keep fiction/simulation framing explicit when relevant.",
	},
	{
		category: "rules",
		layer: "core",
		confidence: 1,
		salience: 0.95,
		pinned: 1,
		tags: ["daily", "morning", "memory", "mcp"],
		subject: "Daily memory teaching ritual",
		text: "Standing instruction (from 2026-07-10/11): each morning, update Jamie's My Memory MCP (mcp-memory) or teach it something new. Keep the memory bank current, de-duplicated, and useful across Claude/Grok/Codex sessions.",
	},
	{
		category: "preferences",
		layer: "long_embedded",
		confidence: 0.9,
		salience: 0.85,
		pinned: 0,
		tags: ["deploy", "cloudflare", "verification"],
		subject: "Deploy verification habit",
		text: "When deploying Cloudflare Workers for Jamie, verify the actual commit SHA Workers Builds is deploying. Retrying a failed build reuses the old commit and can reintroduce stale wrangler binding IDs. Prefer deploy-from-tip-of-main over Retry on red builds.",
	},
	{
		category: "knowledge",
		layer: "current",
		confidence: 0.95,
		salience: 0.8,
		pinned: 0,
		tags: ["mcp-memory", "d1", "bindings"],
		subject: "Production binding IDs",
		text: "Production Cloudflare resources for mcp-memory: D1 database mcp-memory-db id 1dd6fb6c-76fc-4eae-8fec-0960288933f0; KV namespace 8920cd7c3b2347428da18c2713dbf81d; Vectorize index mcp-memory-vectorize (1024 dims, cosine). Never use the non-existent D1 id a25fc989-398c-40de-9aae-569d662f0455.",
	},
	{
		category: "goals",
		layer: "current",
		confidence: 0.85,
		salience: 0.85,
		pinned: 0,
		tags: ["goals", "memory", "agents"],
		subject: "Memory system goals",
		text: "Jamie wants a durable personal memory layer that remembers who he is, his legal-administrative matters, drafting style, and technical projects across agents. Prefer high-signal core facts, pin critical standing rules, and suppress outdated status claims promptly.",
	},
];

export const LIVING_SUMMARY = `Jamie Young (aliases Jamie, JY, jamusaaron) is based in Melbourne, Victoria, Australia (born 25 March 1991). He is a former APS Policy Adviser (~9 years Commonwealth experience across NDIS Quality and Safeguards Commission, ACCC, and ACMA; most recently APS 5 Policy Adviser at the Department of Finance). He was dismissed from Finance in February 2026 and is now a self-represented litigant across active legal-administrative and employment-related matters (including NDIS Commission process issues and Young v Department of Finance / Fair Work materials). He is not a currently serving public servant.

His work with assistants is document-heavy and systems-oriented: chronology, admitted facts, procedural fairness, actor roles, FOI/missing-record analysis, controlled formal drafting, and multi-pathway remedy strategy. He wants accuracy over fluency, Australian English, direct adult-to-adult tone, and paste-ready outputs. Separate private blunt issue-spotting from controlled public drafts.

Technically he builds and operates a self-hosted Cloudflare mcp-memory worker (namespace fe542582-e9bc-4f88-8fd8-e49c5672d92a), uses Claude, Grok Build, and Codex in parallel, and invests in MCP tooling, skills, Workers, and creative/technical media workflows (Tesla/EV aesthetics, simulation projects, prompt engineering).

Standing rule: update or teach mcp-memory something useful each morning.`;

export const SELF_PROFILE = `# Jamie Young — self profile

## Identity
- Name: Jamie Young (Jamie, JY, jamusaaron)
- Location: Melbourne, VIC, Australia
- Background: Former APS Policy Adviser; self-represented litigant; deep public-sector process expertise

## How to work with Jamie
- Evidence-first: chronology, exhibits → propositions, fairness issues
- Tone: direct, capable adult-to-adult; no vague reassurance
- Drafts: controlled, Australian English, paste-ready; no AI-slop cadence
- Always mark uncertainty and verify unstable facts

## Active domains
- Legal-administrative / employment matters
- NDIS Commission process history and remedy pathways
- Personal MCP memory infrastructure on Cloudflare
- AI agent tooling (Claude, Grok, Codex)

## Production memory
- userId: fe542582-e9bc-4f88-8fd8-e49c5672d92a
- endpoint: https://mcp-memory.jamusaaron.workers.dev/{userId}/sse
`;
