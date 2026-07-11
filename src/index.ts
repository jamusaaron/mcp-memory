import { Hono } from "hono";
import { cors } from "hono/cors";
import { runScheduledMaintenance } from "./maintenance";
import { MyMCP } from "./mcp";
import { initializeDatabase } from "./schema";
import {
	deleteMemory,
	getMemoryById,
	getMemoryIndex,
	insertMemory,
	queryMemories,
	updateMemory,
} from "./utils/db";
import { deleteVectorById, storeMemoryVector } from "./utils/vectorize";

const app = new Hono<{
	Bindings: Env;
}>();

let dbInitialized = false;

app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
		exposeHeaders: ["mcp-session-id"],
		maxAge: 86400,
	}),
);

app.use("*", async (c, next) => {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "no-referrer");
	c.header("X-Frame-Options", "DENY");
});

app.use("*", async (c, next) => {
	const path = new URL(c.req.url).pathname;
	if (path !== "/" && path !== "/health") {
		try {
			const tenantKey = path.split("/")[1] || "anonymous";
			const outcome = await c.env.RATE_LIMITER.limit({ key: tenantKey });
			if (!outcome.success) {
				return c.json({ success: false, error: "Rate limit exceeded" }, 429);
			}
		} catch (e) {
			// Fail open if the limiter binding is unavailable so memory stays reachable
			console.error("Rate limiter unavailable (fail-open):", e);
		}

		if (!dbInitialized) {
			try {
				await initializeDatabase(c.env);
				dbInitialized = true;
			} catch (e) {
				console.error("Failed to initialize database:", e);
				return c.json({ success: false, error: "Database unavailable" }, 503);
			}
		}
	}
	await next();
});

app.get("/", async (c) => await c.env.ASSETS.fetch(c.req.raw));

app.get("/health", async (c) => {
	const checks: Record<string, string> = {};
	try {
		await c.env.DB.prepare("SELECT 1").first();
		checks.d1 = "ok";
	} catch (e) {
		checks.d1 = `fail: ${String(e)}`;
	}
	try {
		await c.env.KV.get("__health__");
		checks.kv = "ok";
	} catch (e) {
		checks.kv = `fail: ${String(e)}`;
	}
	try {
		await c.env.VECTORIZE.query(new Array(1024).fill(0), { topK: 1 });
		checks.vectorize = "ok";
	} catch (e) {
		checks.vectorize = `fail: ${String(e)}`;
	}
	const ok = Object.values(checks).every((v) => v === "ok");
	return c.json({ success: ok, checks, version: "enhanced" }, ok ? 200 : 503);
});

app.get("/:userId/health", async (c) => {
	const userId = c.req.param("userId");
	try {
		const index = await getMemoryIndex(userId, c.env);
		return c.json({ success: true, userId, index });
	} catch (error) {
		return c.json({ success: false, error: String(error) }, 500);
	}
});

app.get("/:userId/memories", async (c) => {
	const userId = c.req.param("userId");
	try {
		const category = c.req.query("category") || undefined;
		const layer = c.req.query("layer") || undefined;
		const limit = Number(c.req.query("limit") || 100);
		const memories = await queryMemories(userId, c.env, {
			suppressed: false,
			category,
			layer,
			limit,
		});
		return c.json({
			success: true,
			count: memories.length,
			memories: memories.map((m) => ({
				id: m.id,
				content: m.text,
				category: m.category,
				layer: m.layer,
				confidence: m.confidence,
				salience: m.salience,
				pinned: m.pinned,
				tags: m.tags,
				created_at: m.created_at,
			})),
		});
	} catch (error) {
		console.error("Error retrieving memories:", error);
		return c.json({ success: false, error: "Failed to retrieve memories" }, 500);
	}
});

app.post("/:userId/memories", async (c) => {
	const userId = c.req.param("userId");
	try {
		const body = await c.req.json();
		const text = typeof body?.content === "string" ? body.content : body?.text;
		if (!text || typeof text !== "string" || text.trim() === "") {
			return c.json({ success: false, error: "Invalid or missing content/text" }, 400);
		}
		const memory = await insertMemory(
			{
				userId,
				text: text.trim(),
				category: body.category,
				layer: body.layer,
				tags: body.tags,
				confidence: body.confidence,
				salience: body.salience,
				subject: body.subject,
			},
			c.env,
		);
		try {
			await storeMemoryVector(memory.id, memory.text, userId, c.env, {
				category: memory.category,
				layer: memory.layer,
				salience: memory.salience,
			});
			await updateMemory(memory.id, userId, { embedding_status: "embedded" } as any, c.env);
		} catch (e) {
			console.error("POST embed failed:", e);
		}
		return c.json({ success: true, id: memory.id, memory }, 201);
	} catch (error) {
		console.error("Error creating memory:", error);
		return c.json({ success: false, error: "Failed to create memory" }, 500);
	}
});

app.get("/:userId/memories/:memoryId", async (c) => {
	const userId = c.req.param("userId");
	const memoryId = c.req.param("memoryId");
	try {
		const memory = await getMemoryById(memoryId, userId, c.env);
		if (!memory) return c.json({ success: false, error: "Not found" }, 404);
		return c.json({ success: true, memory });
	} catch (error) {
		return c.json({ success: false, error: String(error) }, 500);
	}
});

app.delete("/:userId/memories/:memoryId", async (c) => {
	const userId = c.req.param("userId");
	const memoryId = c.req.param("memoryId");
	try {
		await deleteMemory(memoryId, userId, c.env);
		try {
			await deleteVectorById(memoryId, c.env);
		} catch {
			/* best effort */
		}
		return c.json({ success: true });
	} catch (error) {
		console.error("Error deleting memory:", error);
		const message = error instanceof Error ? error.message : String(error);
		return c.json(
			{ success: false, error: message },
			message.includes("not found") ? 404 : 500,
		);
	}
});

app.put("/:userId/memories/:memoryId", async (c) => {
	const userId = c.req.param("userId");
	const memoryId = c.req.param("memoryId");
	let updatedContent: string;

	try {
		const body = await c.req.json();
		if (!body || typeof body.content !== "string" || body.content.trim() === "") {
			return c.json({ success: false, error: "Invalid or missing content" }, 400);
		}
		updatedContent = body.content.trim();
	} catch {
		return c.json({ success: false, error: "Failed to parse request body" }, 400);
	}

	try {
		await updateMemory(
			memoryId,
			userId,
			{ text: updatedContent, embedding_status: "pending" } as any,
			c.env,
		);
		let embeddingStatus = "pending";
		try {
			const mem = await getMemoryById(memoryId, userId, c.env);
			await storeMemoryVector(memoryId, updatedContent, userId, c.env, {
				category: mem?.category ?? "knowledge",
				layer: mem?.layer ?? "current",
				salience: mem?.salience ?? 0.5,
			});
			await updateMemory(memoryId, userId, { embedding_status: "embedded" } as any, c.env);
			embeddingStatus = "embedded";
		} catch (error) {
			console.error("Failed to refresh memory embedding:", error);
		}
		return c.json({ success: true, embedding_status: embeddingStatus });
	} catch (error) {
		const msg = error instanceof Error ? error.message : "Failed to update memory";
		return c.json({ success: false, error: msg }, msg.includes("not found") ? 404 : 500);
	}
});

app.mount("/", async (req, env, ctx) => {
	const url = new URL(req.url);
	const pathSegments = url.pathname.split("/");
	const userId = pathSegments[1];

	if (!userId) {
		return new Response("Bad Request: Could not extract userId from URL path", { status: 400 });
	}

	// Reserve non-MCP routes
	if (["health"].includes(userId)) {
		return new Response("Not Found", { status: 404 });
	}

	ctx.props = { userId };

	const response = await MyMCP.mount(`/${userId}/sse`).fetch(req, env, ctx);
	if (response) return response;

	return new Response("Not Found within MCP mount", { status: 404 });
});

const worker = {
	fetch: app.fetch,
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			(async () => {
				try {
					await initializeDatabase(env);
					await runScheduledMaintenance(env);
				} catch (e) {
					console.error("Scheduled maintenance failed:", e);
				}
			})(),
		);
	},
};

export default worker;

export { MyMCP };
