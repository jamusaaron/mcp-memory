const prefixFor = (userId: string) => `static:${userId}:`;

export async function readStaticFile(userId: string, filename: string, env: Env): Promise<string | null> {
    return await env.KV.get(`${prefixFor(userId)}${filename}`);
}

export async function writeStaticFile(userId: string, filename: string, content: string, env: Env): Promise<void> {
    await env.KV.put(`${prefixFor(userId)}${filename}`, content);
}

export async function deleteStaticFile(userId: string, filename: string, env: Env): Promise<void> {
    await env.KV.delete(`${prefixFor(userId)}${filename}`);
}

export async function listStaticFiles(userId: string, env: Env): Promise<string[]> {
    const prefix = prefixFor(userId);
    const names: string[] = [];
    let cursor: string | undefined;

    do {
        const page = await env.KV.list({ prefix, cursor });
        names.push(...page.keys.map((key) => key.name.slice(prefix.length)));
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    return names;
}
