import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	appAccessMiddleware,
	clearSessionCookie,
	createSessionCookie,
	createSessionToken,
	SESSION_MAX_AGE_SECONDS,
	verifyAccessKey,
} from "./app-access";
import { loginPage } from "./login-page";
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

export type McpDispatcher = (
	userId: string,
	request: Request,
	env: Env,
	ctx: ExecutionContext,
) => Promise<Response | undefined>;

function assetRequest(request: Request, pathname: string): Request {
	const url = new URL(request.url);
	url.pathname = pathname;
	const headers = new Headers(request.headers);
	// Assets treats browser navigation requests for *.html as canonicalizable pages.
	// These routes already have canonical public paths, so fetch the file as an asset
	// and retain the response's own Content-Type rather than accepting a redirect.
	headers.set("Accept", "application/octet-stream");
	return new Request(url, { method: request.method, headers });
}

function safeNext(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
	return value;
}

export function createApp(mcpDispatcher: McpDispatcher) {
	const app = new Hono<{
		Bindings: Env;
	}>();
	let dbInitialized = false;

	app.use("*", appAccessMiddleware());

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
		if (path !== "/" && path !== "/health" && !path.startsWith("/auth/")) {
			try {
				const tenantKey = path.split("/")[1] || "anonymous";
				const outcome = await c.env.RATE_LIMITER.limit({ key: tenantKey });
				if (!outcome.success) {
					return c.json({ success: false, error: "Rate limit exceeded" }, 429);
				}
			} catch (error) {
				// Fail open if the limiter binding is unavailable so memory stays reachable.
				console.error("Rate limiter unavailable (fail-open):", error);
			}

			if (!dbInitialized) {
				try {
					const initialization = await initializeDatabase(c.env);
					if (!initialization.ready || initialization.changed) {
						return c.json(
							{ success: false, error: "Database upgrade in progress" },
							503,
						);
					}
					dbInitialized = true;
				} catch (error) {
					console.error("Failed to initialize database:", error);
					return c.json({ success: false, error: "Database unavailable" }, 503);
				}
			}
		}
		await next();
	});

	app.get("/auth/login", (c) => c.html(loginPage, 200, { "Cache-Control": "no-store" }));

	app.post("/auth/session", async (c) => {
		let body: { accessKey?: unknown; next?: unknown };
		try {
			body = await c.req.json();
		} catch {
			return c.text("Invalid login request", 400, { "Cache-Control": "no-store" });
		}

		const accessKey = typeof body.accessKey === "string" ? body.accessKey : undefined;
		if (!(await verifyAccessKey(accessKey, c.env.APP_ACCESS_KEY))) {
			return c.text("Invalid access key", 401, { "Cache-Control": "no-store" });
		}

		const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
		const token = await createSessionToken(c.env.COOKIE_ENCRYPTION_KEY, expiresAt);
		c.header("Set-Cookie", createSessionCookie(token));
		c.header("Cache-Control", "no-store");
		return c.json({ success: true, next: safeNext(body.next) });
	});

	app.get("/auth/logout", (c) => {
		c.header("Set-Cookie", clearSessionCookie());
		c.header("Cache-Control", "no-store");
		return c.redirect("/auth/login");
	});

	app.get("/", (c) => c.env.ASSETS.fetch(assetRequest(c.req.raw, "/index.html")));
	app.get("/console", (c) => c.env.ASSETS.fetch(assetRequest(c.req.raw, "/console.html")));
	app.get("/docs", (c) => c.env.ASSETS.fetch(assetRequest(c.req.raw, "/docs.html")));

	app.get("/health", async (c) => {
		const checks: Record<string, string> = {};
		try {
			await c.env.DB.prepare("SELECT 1").first();
			checks.d1 = "ok";
		} catch (error) {
			checks.d1 = `fail: ${String(error)}`;
		}
		try {
			await c.env.KV.get("__health__");
			checks.kv = "ok";
		} catch (error) {
			checks.kv = `fail: ${String(error)}`;
		}
		try {
			await c.env.VECTORIZE.query(new Array(1024).fill(0), { topK: 1 });
			checks.vectorize = "ok";
		} catch (error) {
			checks.vectorize = `fail: ${String(error)}`;
		}
		const ok = Object.values(checks).every((value) => value === "ok");
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
				memories: memories.map((memory) => ({
					id: memory.id,
					content: memory.text,
					category: memory.category,
					layer: memory.layer,
					confidence: memory.confidence,
					salience: memory.salience,
					pinned: memory.pinned,
					tags: memory.tags,
					created_at: memory.created_at,
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
			} catch (error) {
				console.error("POST embed failed:", error);
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
				// Vector deletion is best effort after the memory record is removed.
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
				const memory = await getMemoryById(memoryId, userId, c.env);
				await storeMemoryVector(memoryId, updatedContent, userId, c.env, {
					category: memory?.category ?? "knowledge",
					layer: memory?.layer ?? "current",
					salience: memory?.salience ?? 0.5,
				});
				await updateMemory(memoryId, userId, { embedding_status: "embedded" } as any, c.env);
				embeddingStatus = "embedded";
			} catch (error) {
				console.error("Failed to refresh memory embedding:", error);
			}
			return c.json({ success: true, embedding_status: embeddingStatus });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to update memory";
			return c.json(
				{ success: false, error: message },
				message.includes("not found") ? 404 : 500,
			);
		}
	});

	app.mount("/", async (request, env, ctx) => {
		const url = new URL(request.url);
		const userId = url.pathname.split("/")[1];

		if (!userId) {
			return new Response("Bad Request: Could not extract userId from URL path", { status: 400 });
		}
		if (userId === "health") {
			return new Response("Not Found", { status: 404 });
		}

		ctx.props = { userId };
		const response = await mcpDispatcher(userId, request, env, ctx);
		return response ?? new Response("Not Found within MCP mount", { status: 404 });
	});

	return app;
}
