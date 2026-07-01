export async function readStaticFile(userId: string, filename: string, env: Env): Promise<string | null> {
    const obj = await env.R2.get(`${userId}/${filename}`);
    if (!obj) return null;
    return await obj.text();
}

export async function writeStaticFile(userId: string, filename: string, content: string, env: Env): Promise<void> {
    await env.R2.put(`${userId}/${filename}`, content, {
        httpMetadata: { contentType: "text/markdown" },
    });
}

export async function listStaticFiles(userId: string, env: Env): Promise<string[]> {
    const listed = await env.R2.list({ prefix: `${userId}/` });
    return listed.objects.map(o => o.key.replace(`${userId}/`, ""));
}
