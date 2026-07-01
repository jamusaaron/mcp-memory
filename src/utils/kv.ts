export async function getKV(key: string, env: Env): Promise<string | null> {
    return await env.KV.get(key);
}

export async function putKV(key: string, value: string, env: Env, expirationTtl?: number): Promise<void> {
    const opts: KVNamespacePutOptions = {};
    if (expirationTtl) opts.expirationTtl = expirationTtl;
    await env.KV.put(key, value, opts);
}

export async function deleteKV(key: string, env: Env): Promise<void> {
    await env.KV.delete(key);
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
