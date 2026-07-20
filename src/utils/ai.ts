// Ordered list of Workers AI text-generation models to try. The first that
// succeeds is used; if a model has been deprecated or removed (Cloudflare
// retires models on an end-of-support schedule — e.g. the Llama 3.x 8B
// instruct line hit EOL 2026-05-30), we fall through to the next. Set the
// LLM_MODEL var in wrangler.jsonc to pin/override the primary without a code
// change. Entries span model families and sizes so a single deprecation — or
// even a whole-family issue — can't take out the entire list.
const FALLBACK_TEXT_MODELS = [
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "@cf/meta/llama-3.1-8b-instruct-fast",
    "@cf/meta/llama-3.2-3b-instruct",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/qwen/qwen2.5-coder-32b-instruct",
];

/**
 * Run a text-generation prompt, trying each candidate model until one works.
 * Returns the response AND the model that produced it (so callers like
 * health_check can report which model is live). Throws only if every candidate
 * fails.
 */
export async function llmCallDetailed(prompt: string, env: Env, maxTokens: number = 1024): Promise<{ response: string; model: string }> {
    const configured = (env as Env & { LLM_MODEL?: string }).LLM_MODEL;
    const models = configured
        ? [configured, ...FALLBACK_TEXT_MODELS.filter(m => m !== configured)]
        : FALLBACK_TEXT_MODELS;

    let lastError: unknown;
    for (const model of models) {
        try {
            // Cast: the model list is intentionally dynamic (future-proof against
            // deprecations), so we bypass the generated fixed model-name union.
            const result = await (env.AI.run as (m: string, o: unknown) => Promise<{ response?: string }>)(model, {
                messages: [{ role: "user", content: prompt }],
                max_tokens: maxTokens,
            });
            return { response: result.response ?? "", model };
        } catch (e) {
            lastError = e;
            console.error(`llmCall: model ${model} unavailable, trying next:`, String(e));
        }
    }
    throw lastError ?? new Error("llmCall: no text-generation model available");
}

export async function llmCall(prompt: string, env: Env): Promise<string> {
    return (await llmCallDetailed(prompt, env)).response;
}

/**
 * Lightweight liveness probe for text generation — used by health_check so a
 * model deprecation/outage is caught instead of silently breaking every
 * AI-dependent tool. Returns the working model id, or throws.
 */
export async function checkTextGeneration(env: Env): Promise<string> {
    const { model } = await llmCallDetailed("Reply with the single word: ok", env, 5);
    return model;
}

export async function triageText(text: string, env: Env): Promise<{
    worth_storing: boolean;
    category: string;
    layer: string;
    confidence: number;
    salience: number;
    emotion_weight: number;
    tags: string[];
    subject: string;
}> {
    const prompt = `Analyze this text and decide if it contains information worth storing as a long-term memory about a user. Return ONLY valid JSON.

Text: "${text}"

Return JSON with these fields:
- worth_storing: boolean (true if this contains meaningful personal info, preferences, facts, or context)
- category: one of [identity, relationship, projects, cybersec, finance, ai, health, rules, creative, preferences, likes, goals, knowledge, corrections]
- layer: one of [core, long_embedded, mid_ground, current] (core=permanent facts, current=recent/provisional)
- confidence: 0.0-1.0 (how confident this information is accurate)
- salience: 0.0-1.0 (how important/relevant this is)
- emotion_weight: 0.0-1.0 (emotional significance)
- tags: array of 1-5 keyword tags
- subject: brief subject/title (max 10 words)`;

    const response = await llmCall(prompt, env);
    try {
        const match = response.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
    } catch { /* fall through */ }
    return {
        worth_storing: true, category: "knowledge", layer: "current",
        confidence: 0.7, salience: 0.5, emotion_weight: 0.0,
        tags: [], subject: text.slice(0, 50),
    };
}

export async function extractProfileUpdates(text: string, personName: string, env: Env): Promise<Array<{
    section: string;
    field: string;
    value: string;
    confidence: number;
}>> {
    const prompt = `Extract structured profile information about "${personName}" from this text. Return ONLY a JSON array.

Text: "${text}"

Return a JSON array of objects, each with:
- section: one of [identity, personality, psychology, behavior, history, relationship]
- field: the specific attribute (e.g., "occupation", "communication_style", "hobby")
- value: the extracted value
- confidence: 0.0-1.0

Return [] if no profile information is found.`;

    const response = await llmCall(prompt, env);
    try {
        const match = response.match(/\[[\s\S]*\]/);
        if (match) return JSON.parse(match[0]);
    } catch { /* fall through */ }
    return [];
}

export async function detectContradictions(newText: string, existingMemories: Array<{ id: string; text: string; score: number }>, env: Env): Promise<Array<{
    existing_id: string;
    existing_text: string;
    contradiction_type: string;
    explanation: string;
}>> {
    if (existingMemories.length === 0) return [];

    const existingList = existingMemories.map((m, i) => `${i + 1}. [ID:${m.id}] ${m.text}`).join("\n");
    const prompt = `Check if this new statement contradicts any existing memories. Return ONLY a JSON array.

New statement: "${newText}"

Existing memories:
${existingList}

Return a JSON array of contradictions found. Each object should have:
- existing_id: the ID of the contradicted memory
- existing_text: the text of the contradicted memory
- contradiction_type: "direct" (factual conflict) or "update" (newer info supersedes)
- explanation: brief explanation

Return [] if no contradictions found.`;

    const response = await llmCall(prompt, env);
    try {
        const match = response.match(/\[[\s\S]*\]/);
        if (match) return JSON.parse(match[0]);
    } catch { /* fall through */ }
    return [];
}

export async function generateSummary(memories: Array<{ text: string; category: string }>, env: Env): Promise<string> {
    const grouped: Record<string, string[]> = {};
    for (const m of memories) {
        if (!grouped[m.category]) grouped[m.category] = [];
        grouped[m.category].push(m.text);
    }
    const sections = Object.entries(grouped)
        .map(([cat, items]) => `## ${cat}\n${items.map(t => `- ${t}`).join("\n")}`)
        .join("\n\n");

    const prompt = `Create a concise living summary of this person based on their stored memories. Write in third person, present tense. Be factual and organized.

${sections}

Write a 2-4 paragraph summary covering key identity, relationships, projects, preferences, and goals.`;

    return await llmCall(prompt, env);
}

export async function analyzePatterns(memories: Array<{ text: string; category: string; tags: string[] }>, env: Env): Promise<string> {
    const items = memories.map((m, i) => `${i + 1}. [${m.category}] ${m.text} (tags: ${m.tags.join(", ")})`).join("\n");
    const prompt = `Analyze these memories for patterns, recurring themes, and behavioral tendencies. Return a structured analysis.

${items}

Identify:
1. Recurring themes or topics
2. Behavioral patterns
3. Preference clusters
4. Potential connections between memories
5. Notable trends over time`;

    return await llmCall(prompt, env);
}

export async function extractFromTranscript(transcript: string, env: Env): Promise<Array<{
    text: string;
    category: string;
    confidence: number;
    source_type: string;
}>> {
    const prompt = `Extract key facts, preferences, and notable information from this conversation transcript. Return ONLY a JSON array.

Transcript:
${transcript.slice(0, 3000)}

Return a JSON array of objects, each with:
- text: the extracted fact or preference (concise, self-contained)
- category: one of [identity, relationship, projects, cybersec, finance, ai, health, rules, creative, preferences, likes, goals, knowledge, corrections]
- confidence: 0.0-1.0
- source_type: "stated" (explicitly said) or "observed" (implied/inferred)

Focus on meaningful, persistent information. Skip transient details.`;

    const response = await llmCall(prompt, env);
    try {
        const match = response.match(/\[[\s\S]*\]/);
        if (match) return JSON.parse(match[0]);
    } catch { /* fall through */ }
    return [];
}
