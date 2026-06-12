import { URLParam } from "sliftutils/render-utils/URLParam";
import { isNode } from "typesafecss";
import { gameState, GridCell, LETTER_POINTS, GameMode, ensureCellToWordsForGrid } from "./GameState";
import { findAllWordsInGrid, getWordTrie, calculateTotalScoreForWords } from "./GridGenerator";

// Single-player games are identified by a URL param whose value base64url-encodes the FULL game configuration: board letters, multipliers, duration, mode, and coop goal. The id alone recreates the board, so sharing the URL shares the game (this replaces the old ?board= link format). Per-id progress (words found, score, elapsed time, status) is stored in the origin-private file system, one file per game keyed by a hash of the id — so reloading the page resumes your game, while someone else opening your link gets the same board fresh.

export const singleGameURL = new URLParam("g", "");

const SAVE_DIR = "single-games";
const AUTOSAVE_INTERVAL = 2000;
// Idle elapsed-time progress is only persisted when it crosses one of these buckets, so an idle-but-open game doesn't rewrite its save file every tick (word/score changes still save within AUTOSAVE_INTERVAL).
const ELAPSED_SAVE_BUCKET = 15 * 1000;
const SAVE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const ENCODED_GAME_VERSION = 1;

export interface SingleGameConfig {
    grid: GridCell[][];
    gameDuration: number;
    gameMode: GameMode;
    coopGoalFraction: number;
}

export interface SingleGameProgress {
    status: "playing" | "finished";
    score: number;
    matchedWords: { word: string; points: number }[];
    elapsedTime: number;
    coopInfinite: boolean;
    savedAt: number;
}

interface EncodedGame {
    v: number;
    w: number;
    h: number;
    // Letters and multipliers, row-major, one char per cell.
    l: string;
    m: string;
    d: number;
    gm: string;
    cg: number;
}

function toBase64Url(s: string): string {
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

export function encodeSingleGameId(config: SingleGameConfig): string {
    const encoded: EncodedGame = {
        v: ENCODED_GAME_VERSION,
        w: config.grid[0].length,
        h: config.grid.length,
        l: config.grid.map(row => row.map(c => c.letter).join("")).join(""),
        m: config.grid.map(row => row.map(c => String(c.multiplier)).join("")).join(""),
        d: config.gameDuration,
        gm: config.gameMode,
        cg: config.coopGoalFraction,
    };
    return toBase64Url(JSON.stringify(encoded));
}

export function decodeSingleGameId(id: string): SingleGameConfig | undefined {
    let e: EncodedGame;
    try {
        e = JSON.parse(fromBase64Url(id)) as EncodedGame;
    } catch {
        return undefined;
    }
    if (e.v !== ENCODED_GAME_VERSION) return undefined;
    if (!Number.isInteger(e.w) || e.w < 2 || e.w > 10) return undefined;
    if (!Number.isInteger(e.h) || e.h < 2 || e.h > 10) return undefined;
    if (typeof e.l !== "string" || e.l.length !== e.w * e.h || !/^[A-Z]+$/.test(e.l)) return undefined;
    if (typeof e.m !== "string" || e.m.length !== e.w * e.h || !/^[123]+$/.test(e.m)) return undefined;
    if (typeof e.d !== "number" || e.d < 10000 || e.d > 3600000) return undefined;
    const gameMode: GameMode = e.gm === "competitive" || e.gm === "competitive-shared" ? e.gm : "cooperative";
    const coopGoalFraction = typeof e.cg === "number" ? Math.max(0.05, Math.min(1, e.cg)) : 0.25;

    const grid: GridCell[][] = [];
    for (let r = 0; r < e.h; r++) {
        const row: GridCell[] = [];
        for (let c = 0; c < e.w; c++) {
            const letter = e.l[r * e.w + c];
            row.push({
                letter,
                points: LETTER_POINTS[letter] || 1,
                multiplier: Number(e.m[r * e.w + c]) as 1 | 2 | 3,
            });
        }
        grid.push(row);
    }
    return { grid, gameDuration: e.d, gameMode, coopGoalFraction };
}

// Recomputes the id from the live game and puts it in the URL. Called whenever a new single-player board comes into existence (new game, grid resize, board import).
export function updateSingleGameURL(): void {
    if (isNode()) return;
    if (gameState.isMultiplayer || gameState.isChallengeMode) return;
    if (gameState.grid.length === 0) return;
    singleGameURL.value = encodeSingleGameId({
        grid: gameState.grid,
        gameDuration: gameState.gameDuration,
        gameMode: gameState.gameMode,
        coopGoalFraction: gameState.coopGoalFraction,
    });
}

// Applies the game encoded in the URL: rebuilds the board, then restores saved progress for that id if we have any. Returns false when the param is missing or unparsable.
export async function applySingleGameFromURL(): Promise<boolean> {
    const id = singleGameURL.value;
    if (!id) return false;
    const config = decodeSingleGameId(id);
    if (!config) {
        console.warn(`Invalid single-player game id in URL, ignoring`);
        return false;
    }

    const trie = await getWordTrie();
    const result = findAllWordsInGrid(config.grid, trie);
    gameState.gridWidth = config.grid[0].length;
    gameState.gridHeight = config.grid.length;
    gameState.grid = config.grid;
    gameState.gameDuration = config.gameDuration;
    gameState.gameMode = config.gameMode;
    gameState.coopGoalFraction = config.coopGoalFraction;
    gameState.totalPossibleWords = result.words.size;
    gameState.totalPossibleScore = calculateTotalScoreForWords(config.grid, result.words, trie);
    gameState.status = "ready";
    gameState.score = 0;
    gameState.matchedWords = [];
    gameState.matchedWordsSet.clear();
    gameState.elapsedTime = 0;
    gameState.startTime = undefined;
    gameState.timeRemaining = config.gameDuration;
    gameState.coopInfinite = false;
    await ensureCellToWordsForGrid(config.grid);

    const progress = await loadProgress(id);
    if (progress) {
        gameState.score = progress.score;
        gameState.matchedWords = progress.matchedWords.map(w => ({ word: w.word, points: w.points }));
        gameState.matchedWordsSet = new Set(progress.matchedWords.map(w => w.word));
        gameState.elapsedTime = progress.elapsedTime;
        gameState.coopInfinite = progress.coopInfinite;
        gameState.status = progress.status;
        gameState.timeRemaining = Math.max(0, config.gameDuration - progress.elapsedTime);
        if (progress.status === "playing") {
            // Anchor the timer so elapsed time continues from where it was saved.
            gameState.startTime = Date.now() - progress.elapsedTime;
        }
    }
    return true;
}

// Minimal OPFS surface — lib.dom doesn't reliably include these yet.
interface OpfsFileHandle {
    getFile(): Promise<File>;
    createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
interface OpfsDirHandle {
    getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>;
    getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDirHandle>;
    removeEntry(name: string): Promise<void>;
    entries(): AsyncIterable<[string, { kind: string }]>;
}

async function getSaveDir(): Promise<OpfsDirHandle | undefined> {
    if (isNode()) return undefined;
    const storage = navigator.storage as { getDirectory?: () => Promise<unknown> };
    if (!storage || !storage.getDirectory) return undefined;
    const root = await storage.getDirectory() as OpfsDirHandle;
    return await root.getDirectoryHandle(SAVE_DIR, { create: true });
}

// Ids can exceed filesystem name limits (they encode the whole board), so files are keyed by a hash of the id instead.
async function fileNameForId(id: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("") + ".json";
}

async function loadProgress(id: string): Promise<SingleGameProgress | undefined> {
    try {
        const dir = await getSaveDir();
        if (!dir) return undefined;
        const handle = await dir.getFileHandle(await fileNameForId(id));
        const file = await handle.getFile();
        return JSON.parse(await file.text()) as SingleGameProgress;
    } catch {
        // Missing file (fresh/shared game) or corrupt save — start clean either way.
        return undefined;
    }
}

async function saveProgress(id: string, progress: SingleGameProgress): Promise<void> {
    const dir = await getSaveDir();
    if (!dir) return;
    const handle = await dir.getFileHandle(await fileNameForId(id), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(progress));
    await writable.close();
}

async function pruneOldSaves(): Promise<void> {
    try {
        const dir = await getSaveDir();
        if (!dir) return;
        const cutoff = Date.now() - SAVE_MAX_AGE;
        const toDelete: string[] = [];
        for await (const [name, entry] of dir.entries()) {
            if (entry.kind !== "file") continue;
            const file = await (entry as unknown as OpfsFileHandle).getFile();
            if (file.lastModified < cutoff) toDelete.push(name);
        }
        for (const name of toDelete) {
            await dir.removeEntry(name);
        }
        if (toDelete.length > 0) {
            console.log(`Pruned ${toDelete.length} old single-player saves`);
        }
    } catch (err) {
        console.warn(`Failed to prune old saves:`, (err as Error).stack ?? err);
    }
}

let lastSavedKey = "";
async function autosaveTick(): Promise<void> {
    if (gameState.isMultiplayer || gameState.isChallengeMode) return;
    const id = singleGameURL.value;
    if (!id) return;
    if (gameState.status !== "playing" && gameState.status !== "finished") return;
    const progress: SingleGameProgress = {
        status: gameState.status,
        score: gameState.score,
        matchedWords: gameState.matchedWords.map(w => ({ word: w.word, points: w.points })),
        elapsedTime: gameState.elapsedTime,
        coopInfinite: gameState.coopInfinite,
        savedAt: Date.now(),
    };
    const key = id + "|" + JSON.stringify({
        s: progress.status,
        sc: progress.score,
        w: progress.matchedWords,
        ci: progress.coopInfinite,
        eb: Math.floor(progress.elapsedTime / ELAPSED_SAVE_BUCKET),
    });
    if (key === lastSavedKey) return;
    try {
        await saveProgress(id, progress);
        lastSavedKey = key;
    } catch (err) {
        console.warn(`Failed to save single-player progress:`, (err as Error).stack ?? err);
    }
}

if (!isNode()) {
    setInterval(() => { void autosaveTick(); }, AUTOSAVE_INTERVAL);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void autosaveTick();
    });
    void pruneOldSaves();
}
