CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_hash TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    memory_type TEXT,
    created_at REAL NOT NULL,
    created_at_iso TEXT NOT NULL,
    updated_at REAL,
    updated_at_iso TEXT,
    metadata_json TEXT,
    vector_id TEXT UNIQUE,
    content_size INTEGER DEFAULT 0,
    r2_key TEXT,
    tags TEXT,
    deleted_at REAL DEFAULT NULL,
    store TEXT NOT NULL DEFAULT 'default'
);
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_tags (
    memory_id INTEGER,
    tag_id INTEGER,
    PRIMARY KEY (memory_id, tag_id),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_vector_id ON memories(vector_id);
CREATE INDEX IF NOT EXISTS idx_memories_deleted_at ON memories(deleted_at);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
