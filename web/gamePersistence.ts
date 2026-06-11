// Persists multiplayer game state to SQLite using node:sqlite, which is built into Node 22.5+ — no npm package, no native build, nothing to install on the server. Only ever imported from server.ts (node-only); must never be pulled into the browser bundle.

// Rows older than this are pruned so the database can't grow without bound. In-memory cleanup removes games after 7 idle days, so anything this old is long dead.
const GAME_ROW_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

interface SqliteStatement {
    run(...args: (string | number)[]): unknown;
    all(...args: (string | number)[]): unknown[];
}
interface SqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): SqliteStatement;
}

let db: SqliteDatabase | undefined;
// Mirrors what's on disk so flushes only write games whose serialized form actually changed (throttling disk writes to real changes).
const lastWritten = new Map<string, string>();

export function openGameDb(path: string): void {
    const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
    db = new sqlite.DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, updatedAt INTEGER NOT NULL, data TEXT NOT NULL)");
    db.prepare("DELETE FROM games WHERE updatedAt < ?").run(Date.now() - GAME_ROW_MAX_AGE);
}

export function loadAllGames(): { id: string; data: string }[] {
    if (!db) {
        throw new Error(`openGameDb must be called before loadAllGames`);
    }
    const rows = db.prepare("SELECT id, data FROM games").all() as { id: string; data: string }[];
    for (const row of rows) {
        lastWritten.set(row.id, row.data);
    }
    return rows;
}

// Upserts changed games, deletes rows for games that no longer exist in memory (so in-memory cleanup propagates to disk), and prunes ancient rows. Synchronous — also safe to call from a SIGTERM handler right before exit.
export function flushGames(current: { id: string; data: string }[]): void {
    if (!db) return;
    const now = Date.now();
    const currentIds = new Set(current.map(g => g.id));
    for (const g of current) {
        if (lastWritten.get(g.id) === g.data) continue;
        db.prepare("INSERT INTO games (id, updatedAt, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updatedAt = excluded.updatedAt, data = excluded.data").run(g.id, now, g.data);
        lastWritten.set(g.id, g.data);
    }
    for (const id of [...lastWritten.keys()]) {
        if (!currentIds.has(id)) {
            db.prepare("DELETE FROM games WHERE id = ?").run(id);
            lastWritten.delete(id);
        }
    }
    db.prepare("DELETE FROM games WHERE updatedAt < ?").run(now - GAME_ROW_MAX_AGE);
}
