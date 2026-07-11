const MIGRATIONS = [
    `CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'knowledge',
        layer TEXT NOT NULL DEFAULT 'current',
        subject TEXT,
        text TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        triggers TEXT DEFAULT '[]',
        confidence REAL DEFAULT 0.8,
        salience REAL DEFAULT 0.5,
        emotion_weight REAL DEFAULT 0.0,
        source_type TEXT DEFAULT 'stated',
        linked_people TEXT DEFAULT '[]',
        embedding_status TEXT DEFAULT 'pending',
        suppressed INTEGER DEFAULT 0,
        suppression_reason TEXT,
        last_accessed TEXT,
        last_verified TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(userId)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(userId, category)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(userId, layer)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories(userId, embedding_status)`,

    `CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases TEXT DEFAULT '[]',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_people_user ON people(userId)`,

    `CREATE TABLE IF NOT EXISTS person_profiles (
        id TEXT PRIMARY KEY,
        personId TEXT NOT NULL,
        userId TEXT NOT NULL,
        section TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (personId) REFERENCES people(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_profiles_person ON person_profiles(personId)`,

    `CREATE TABLE IF NOT EXISTS pending_updates (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        personId TEXT,
        update_type TEXT NOT NULL,
        field TEXT NOT NULL,
        proposed_value TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        source TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_updates(userId, status)`,

    `CREATE TABLE IF NOT EXISTS session_logs (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        session_id TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_session_logs ON session_logs(userId, session_id)`,

    `CREATE TABLE IF NOT EXISTS uncertainties (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        question TEXT NOT NULL,
        context TEXT,
        status TEXT DEFAULT 'open',
        answer TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        answered_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_uncertainties_user ON uncertainties(userId, status)`,

    `CREATE TABLE IF NOT EXISTS ai_notes (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        namespace TEXT DEFAULT 'default',
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ai_notes ON ai_notes(userId, agent_id)`,

    `CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        processed INTEGER DEFAULT 0,
        extracted_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_transcripts_user ON transcripts(userId)`,

    `CREATE TABLE IF NOT EXISTS behavioral_observations (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        observation_type TEXT NOT NULL,
        content TEXT NOT NULL,
        context TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_behavioral_user ON behavioral_observations(userId)`,

    `CREATE TABLE IF NOT EXISTS personality_feedback (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        persona TEXT DEFAULT 'default',
        tone TEXT,
        mode TEXT,
        situation TEXT,
        outcome TEXT,
        feedback_score REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_personality_user ON personality_feedback(userId)`,
];

/** Additive column migrations — safe to re-run (errors ignored if column exists). */
const COLUMN_MIGRATIONS = [
    `ALTER TABLE memories ADD COLUMN pinned INTEGER DEFAULT 0`,
    `ALTER TABLE memories ADD COLUMN access_count INTEGER DEFAULT 0`,
];

const POST_COLUMN_INDEXES = [
    `CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(userId, pinned)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_salience ON memories(userId, salience)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_text ON memories(userId, text)`,
];

export async function initializeDatabase(env: Env): Promise<void> {
    for (const sql of MIGRATIONS) {
        await env.DB.prepare(sql).run();
    }
    for (const sql of COLUMN_MIGRATIONS) {
        try {
            await env.DB.prepare(sql).run();
        } catch {
            /* column already exists */
        }
    }
    for (const sql of POST_COLUMN_INDEXES) {
        await env.DB.prepare(sql).run();
    }
    console.log("Database schema initialized.");
}
