import { Hono } from "hono";
import { MyMCP } from "./mcp";
import { initializeDatabase } from "./schema";
import { queryMemories, deleteMemory, updateMemory, getMemoryById, insertMemory, listDistinctUserIds, runDecaySweep } from "./utils/db";
import { deleteVectorById, storeMemoryVector } from "./utils/vectorize";
import { checkTextGeneration } from "./utils/ai";

const app = new Hono<{
    Bindings: Env;
}>();

let dbInitialized = false;

// Self-test: probe Workers AI text generation and persist the result to D1
// (kv_store table, key __ai_selftest__). This always runs in the Worker
// runtime — i.e. the freshly-deployed code — so it verifies the live text
// model even when a Durable Object MCP session is pinned to older code, and
// even when the Worker can't be reached over HTTP from outside. The row is
// inspectable directly via a D1 query.
let lastSelfTest = 0;
async function runAiSelfTest(env: Env): Promise<void> {
    let result: Record<string, string>;
    try {
        const model = await checkTextGeneration(env);
        result = { status: "ok", model, ts: new Date().toISOString() };
    } catch (e) {
        result = { status: "fail", error: String(e), ts: new Date().toISOString() };
    }
    try {
        await env.DB.prepare(
            "INSERT INTO kv_store (key, value, expires_at, updated_at) VALUES ('__ai_selftest__', ?, NULL, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=NULL, updated_at=excluded.updated_at"
        ).bind(JSON.stringify(result), new Date().toISOString()).run();
    } catch (e) {
        console.error("AI self-test: failed to persist result:", e);
    }
}

// Optional API-key auth: set the MEMORY_API_KEY secret (wrangler secret put MEMORY_API_KEY)
// to require `Authorization: Bearer <key>` or `?key=<key>` on all data routes.
// When unset, the server is open (local dev / trusted environments).
app.use("*", async (c, next) => {
    const apiKey = (c.env as Env & { MEMORY_API_KEY?: string }).MEMORY_API_KEY;
    if (apiKey) {
        const url = new URL(c.req.url);
        // The web UI shell itself is public; data routes behind it are not.
        const isPublicAsset = c.req.method === "GET" && url.pathname === "/";
        // SSE message POSTs carry an unguessable sessionId issued on an
        // authenticated stream connect — possession proves authentication.
        const isSessionMessage = url.pathname.endsWith("/sse/message") && url.searchParams.has("sessionId");

        if (!isPublicAsset && !isSessionMessage) {
            const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
            const queryKey = url.searchParams.get("key");
            if (bearer !== apiKey && queryKey !== apiKey) {
                return c.json({ success: false, error: "Unauthorized" }, 401);
            }
        }
    }
    await next();
});

app.use("*", async (c, next) => {
    if (!dbInitialized) {
        try {
            await initializeDatabase(c.env);
            dbInitialized = true;
        } catch (e) {
            console.error("Failed to initialize database:", e);
        }
    }

    // Opportunistically refresh the AI self-test (at most once every 90s), in
    // the background so it never delays the response. Runs in fresh Worker code.
    const now = Date.now();
    if (now - lastSelfTest > 90000) {
        lastSelfTest = now;
        try { c.executionCtx.waitUntil(runAiSelfTest(c.env)); } catch { /* no execution ctx (e.g. some test paths) */ }
    }

    await next();
});

app.get("/", async (c) => await c.env.ASSETS.fetch(c.req.raw));

app.get("/:userId/memories", async (c) => {
    const userId = c.req.param("userId");
    try {
        const memories = await queryMemories(userId, c.env, { suppressed: false });
        return c.json({ success: true, memories: memories.map(m => ({ id: m.id, content: m.text })) });
    } catch (error) {
        console.error("Error retrieving memories:", error);
        return c.json({ success: false, error: "Failed to retrieve memories" }, 500);
    }
});

app.post("/:userId/memories", async (c) => {
    const userId = c.req.param("userId");
    try {
        const body = await c.req.json();
        if (!body || typeof body.content !== "string" || body.content.trim() === "") {
            return c.json({ success: false, error: "Invalid or missing content" }, 400);
        }
        const memory = await insertMemory({
            userId,
            text: body.content.trim(),
            category: body.category,
            layer: body.layer,
        }, c.env);
        try {
            await storeMemoryVector(memory.id, memory.text, userId, c.env);
            await updateMemory(memory.id, userId, { embedding_status: "embedded" } as any, c.env);
        } catch { /* best effort — backfill_embeddings can catch up later */ }
        return c.json({ success: true, memory: { id: memory.id, content: memory.text } }, 201);
    } catch (error) {
        console.error("Error creating memory:", error);
        return c.json({ success: false, error: "Failed to create memory" }, 500);
    }
});

app.delete("/:userId/memories/:memoryId", async (c) => {
    const userId = c.req.param("userId");
    const memoryId = c.req.param("memoryId");
    try {
        await deleteMemory(memoryId, userId, c.env);
        try { await deleteVectorById(memoryId, c.env); } catch { /* best effort */ }
        return c.json({ success: true });
    } catch (error) {
        console.error("Error deleting memory:", error);
        return c.json({ success: false, error: "Failed to delete memory" }, 500);
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
        await updateMemory(memoryId, userId, { text: updatedContent } as any, c.env);
        try { await storeMemoryVector(memoryId, updatedContent, userId, c.env); } catch { /* best effort */ }
        return c.json({ success: true });
    } catch (error: any) {
        const msg = error.message || "Failed to update memory";
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

    ctx.props = { userId };

    const response = await MyMCP.mount(`/${userId}/sse`).fetch(req, env, ctx);
    if (response) return response;

    return new Response("Not Found within MCP mount", { status: 404 });
});

async function runScheduledDecaySweep(env: Env): Promise<void> {
    if (!dbInitialized) {
        try {
            await initializeDatabase(env);
            dbInitialized = true;
        } catch (e) {
            console.error("Scheduled sweep: failed to initialize database:", e);
            return;
        }
    }

    try {
        const userIds = await listDistinctUserIds(env);
        let totalDecayed = 0;
        let totalFlagged = 0;

        for (const userId of userIds) {
            try {
                const { decayed, flagged } = await runDecaySweep(userId, env);
                totalDecayed += decayed;
                totalFlagged += flagged;
            } catch (e) {
                console.error(`Scheduled sweep: decay failed for user ${userId}:`, e);
            }
        }

        console.log(`Scheduled decay sweep: ${userIds.length} users, ${totalDecayed} memories decayed, ${totalFlagged} flagged for reverification.`);
    } catch (e) {
        console.error("Scheduled decay sweep failed:", e);
    }
}

export default {
    fetch: app.fetch,
    async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(runScheduledDecaySweep(env));
        ctx.waitUntil(runAiSelfTest(env));
    },
};

export { MyMCP };
