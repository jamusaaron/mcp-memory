import { Hono } from "hono";
import { MyMCP } from "./mcp";
import { initializeDatabase } from "./schema";
import { queryMemories, deleteMemory, updateMemory, getMemoryById } from "./utils/db";
import { deleteVectorById, storeMemoryVector } from "./utils/vectorize";

const app = new Hono<{
    Bindings: Env;
}>();

let dbInitialized = false;

app.use("*", async (c, next) => {
    if (!dbInitialized) {
        try {
            await initializeDatabase(c.env);
            dbInitialized = true;
        } catch (e) {
            console.error("Failed to initialize database:", e);
        }
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

export default app;

export { MyMCP };
