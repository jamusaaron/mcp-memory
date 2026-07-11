// The R2 binding is optional: when `r2_buckets` is not configured in
// wrangler.jsonc (e.g. no bucket provisioned in the account), static files
// transparently fall back to the D1 `static_files` table.

export function r2Backend(env: Env): "r2" | "d1" {
    return env.R2 ? "r2" : "d1";
}

export async function readStaticFile(userId: string, filename: string, env: Env): Promise<string | null> {
    if (env.R2) {
        const obj = await env.R2.get(`${userId}/${filename}`);
        if (!obj) return null;
        return await obj.text();
    }

    const row = await env.DB.prepare("SELECT content FROM static_files WHERE userId=? AND filename=?").bind(userId, filename).first() as { content: string } | null;
    return row?.content ?? null;
}

export async function writeStaticFile(userId: string, filename: string, content: string, env: Env): Promise<void> {
    if (env.R2) {
        await env.R2.put(`${userId}/${filename}`, content, {
            httpMetadata: { contentType: "text/markdown" },
        });
        return;
    }

    await env.DB.prepare(
        "INSERT INTO static_files (userId, filename, content, updated_at) VALUES (?,?,?,?) ON CONFLICT(userId, filename) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at"
    ).bind(userId, filename, content, new Date().toISOString()).run();
}

export async function deleteStaticFile(userId: string, filename: string, env: Env): Promise<void> {
    if (env.R2) {
        await env.R2.delete(`${userId}/${filename}`);
        return;
    }
    await env.DB.prepare("DELETE FROM static_files WHERE userId=? AND filename=?").bind(userId, filename).run();
}

export async function listStaticFiles(userId: string, env: Env): Promise<string[]> {
    if (env.R2) {
        const listed = await env.R2.list({ prefix: `${userId}/` });
        return listed.objects.map(o => o.key.replace(`${userId}/`, ""));
    }

    const res = await env.DB.prepare("SELECT filename FROM static_files WHERE userId=? ORDER BY filename").bind(userId).all();
    return (res.results as Array<{ filename: string }>).map(r => r.filename);
}
