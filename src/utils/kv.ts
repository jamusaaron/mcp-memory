// The KV binding is optional: when `kv_namespaces` is not configured in
// wrangler.jsonc (e.g. no namespace provisioned in the account), all cache
// operations transparently fall back to the D1 `kv_store` table, including
// TTL emulation via `expires_at`.

export function kvBackend(env: Env): "kv" | "d1" {
    return env.KV ? "kv" : "d1";
}

export async function getKV(key: string, env: Env): Promise<string | null> {
    if (env.KV) return await env.KV.get(key);

    const row = await env.DB.prepare("SELECT value, expires_at FROM kv_store WHERE key=?").bind(key).first() as { value: string; expires_at: string | null } | null;
    if (!row) return null;
    if (row.expires_at && row.expires_at < new Date().toISOString()) {
        await env.DB.prepare("DELETE FROM kv_store WHERE key=?").bind(key).run();
        return null;
    }
    return row.value;
}

export async function putKV(key: string, value: string, env: Env, expirationTtl?: number): Promise<void> {
    if (env.KV) {
        const opts: KVNamespacePutOptions = {};
        if (expirationTtl) opts.expirationTtl = expirationTtl;
        await env.KV.put(key, value, opts);
        return;
    }

    const expiresAt = expirationTtl ? new Date(Date.now() + expirationTtl * 1000).toISOString() : null;
    await env.DB.prepare(
        "INSERT INTO kv_store (key, value, expires_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at, updated_at=excluded.updated_at"
    ).bind(key, value, expiresAt, new Date().toISOString()).run();
}

export async function deleteKV(key: string, env: Env): Promise<void> {
    if (env.KV) {
        await env.KV.delete(key);
        return;
    }
    await env.DB.prepare("DELETE FROM kv_store WHERE key=?").bind(key).run();
}

export async function getLivingSummary(userId: string, env: Env): Promise<string | null> {
    return getKV(`living_summary:${userId}`, env);
}

export async function putLivingSummary(userId: string, summary: string, env: Env): Promise<void> {
    await putKV(`living_summary:${userId}`, summary, env);
}

export async function getPersonalityCache(userId: string, env: Env): Promise<string | null> {
    return getKV(`personality:${userId}`, env);
}

export async function putPersonalityCache(userId: string, data: string, env: Env): Promise<void> {
    await putKV(`personality:${userId}`, data, env, 3600);
}

export async function getBehavioralCache(userId: string, env: Env): Promise<string | null> {
    return getKV(`behavioral:${userId}`, env);
}

export async function putBehavioralCache(userId: string, data: string, env: Env): Promise<void> {
    await putKV(`behavioral:${userId}`, data, env, 3600);
}

export async function getSessionState(userId: string, sessionId: string, env: Env): Promise<string | null> {
    return getKV(`session:${userId}:${sessionId}`, env);
}

export async function putSessionState(userId: string, sessionId: string, state: string, env: Env): Promise<void> {
    await putKV(`session:${userId}:${sessionId}`, state, env, 86400);
}
