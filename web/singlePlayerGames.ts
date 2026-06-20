import { URLParam } from "sliftutils/render-utils/URLParam";
import { isNode } from "typesafecss";
import { gameState, GridCell, LETTER_POINTS, GameMode, ensureCellToWordsForGrid, GAME_DURATION, DEFAULT_GAME_MODE, DEFAULT_COOP_GOAL_FRACTION, WordLengthMode, DEFAULT_WORD_LENGTH_MODE, applySettings } from "./GameState";
import { findAllWordsInGrid, getWordTrie, calculateTotalScoreForWords } from "./GridGenerator";

// Single-player games are identified by a compact URL param that custom-encodes the game config. The id alone recreates the board, so sharing the URL shares the game. Per-id progress (words, score, elapsed time, status) lives in the origin-private file system, one file per game keyed by a hash of the id — reloading resumes your game, while someone else opening your link gets the same board fresh.
//
// Id format (segments joined by "."), kept minimal — letters are already
// URL-safe so they're stored raw, and anything matching a default is omitted:
//   seg[0]  LETTERS        row-major board letters (A-Z), width*height of them
//   seg[1]  WIDTH          grid width as digits (height = letters.length / width)
//   .m...   MULTIPLIERS    3 chars each: 2-digit cell index + 1-digit value (2|3); omitted when all cells are 1
//   .d<s>   DURATION       seconds; omitted when default
//   .g<c>   MODE           "r"=competitive, "s"=competitive-shared; cooperative (default) omitted
//   .p<n>   COOP GOAL      percent; omitted when default (only meaningful for cooperative)
//   .w<c>   WORD LENGTH    "f"=min4, "t"=exactly3; "any" (default) omitted
//   .t<n>   TARGET SCORE   the score the generator aimed for (30 attempts, closest wins); omitted when unset
//   .c1     VOWEL CENTER 4 only in 4x4 grids; omitted when off
// The leading char is always a letter so sliftutils' niceStringify stores it
// verbatim (a leading digit would get JSON-quoted).

export const singleGameURL = new URLParam("g", "");

const SAVE_DIR = "single-games";
const AUTOSAVE_INTERVAL = 2000;
// Idle elapsed-time progress is only persisted when it crosses one of these buckets, so an idle-but-open game doesn't rewrite its save file every tick (word/score changes still save within AUTOSAVE_INTERVAL).
const ELAPSED_SAVE_BUCKET = 15 * 1000;
const SAVE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_DURATION_SECONDS = Math.round(GAME_DURATION / 1000);
const DEFAULT_COOP_GOAL_PERCENT = Math.round(DEFAULT_COOP_GOAL_FRACTION * 100);

export interface SingleGameConfig {
    grid: GridCell[][];
    gameDuration: number;
    gameMode: GameMode;
    coopGoalFraction: number;
    wordLengthMode: WordLengthMode;
    targetScore: number | undefined;
    vowelCenter4: boolean;
}

export interface SingleGameProgress {
    status: "playing" | "finished";
    score: number;
    matchedWords: { word: string; points: number }[];
    elapsedTime: number;
    coopInfinite: boolean;
    savedAt: number;
}

export function encodeSingleGameId(config: SingleGameConfig): string {
    const width = config.grid[0].length;
    const letters = config.grid.map(row => row.map(c => c.letter).join("")).join("");
    let out = letters + "." + width;

    let mult = "";
    config.grid.forEach((row, r) => row.forEach((cell, c) => {
        if (cell.multiplier !== 1) {
            mult += String(r * width + c).padStart(2, "0") + String(cell.multiplier);
        }
    }));
    if (mult) out += ".m" + mult;

    const seconds = Math.round(config.gameDuration / 1000);
    if (seconds !== DEFAULT_DURATION_SECONDS) out += ".d" + seconds;

    if (config.gameMode === "competitive") out += ".gr";
    else if (config.gameMode === "competitive-shared") out += ".gs";

    if (config.gameMode === "cooperative") {
        const pct = Math.round(config.coopGoalFraction * 100);
        if (pct !== DEFAULT_COOP_GOAL_PERCENT) out += ".p" + pct;
    }

    if (config.wordLengthMode === "min4") out += ".wf";
    else if (config.wordLengthMode === "exactly3") out += ".wt";

    if (config.targetScore && config.targetScore > 0) out += ".t" + Math.floor(config.targetScore);
    if (config.vowelCenter4) out += ".c1";

    return out;
}

export function decodeSingleGameId(id: string): SingleGameConfig | undefined {
    if (!id) return undefined;
    const segs = id.split(".");
    const letters = segs[0];
    const width = parseInt(segs[1], 10);
    if (!/^[A-Z]+$/.test(letters)) return undefined;
    if (!Number.isInteger(width) || width < 2 || width > 10) return undefined;
    if (letters.length % width !== 0) return undefined;
    const height = letters.length / width;
    if (height < 2 || height > 10) return undefined;

    let gameDuration = GAME_DURATION;
    let gameMode: GameMode = DEFAULT_GAME_MODE;
    let coopGoalFraction = DEFAULT_COOP_GOAL_FRACTION;
    let wordLengthMode: WordLengthMode = DEFAULT_WORD_LENGTH_MODE;
    let targetScore: number | undefined;
    let vowelCenter4 = false;
    const multipliers = new Map<number, 2 | 3>();

    for (let i = 2; i < segs.length; i++) {
        const seg = segs[i];
        const key = seg[0];
        const data = seg.slice(1);
        if (key === "m") {
            for (let j = 0; j + 3 <= data.length; j += 3) {
                const idx = parseInt(data.slice(j, j + 2), 10);
                const val = parseInt(data[j + 2], 10);
                if (Number.isInteger(idx) && (val === 2 || val === 3)) {
                    multipliers.set(idx, val);
                }
            }
        } else if (key === "d") {
            const seconds = parseInt(data, 10);
            if (seconds >= 10 && seconds <= 3600) gameDuration = seconds * 1000;
        } else if (key === "g") {
            if (data === "r") gameMode = "competitive";
            else if (data === "s") gameMode = "competitive-shared";
            else if (data === "c") gameMode = "cooperative";
        } else if (key === "p") {
            const pct = parseInt(data, 10);
            if (pct >= 5 && pct <= 100) coopGoalFraction = pct / 100;
        } else if (key === "w") {
            if (data === "f") wordLengthMode = "min4";
            else if (data === "t") wordLengthMode = "exactly3";
        } else if (key === "t") {
            const n = parseInt(data, 10);
            if (Number.isInteger(n) && n > 0) targetScore = n;
        } else if (key === "c") {
            vowelCenter4 = data === "1";
        }
    }

    const grid: GridCell[][] = [];
    for (let r = 0; r < height; r++) {
        const row: GridCell[] = [];
        for (let c = 0; c < width; c++) {
            const idx = r * width + c;
            const letter = letters[idx];
            row.push({
                letter,
                points: LETTER_POINTS[letter] || 1,
                multiplier: multipliers.get(idx) ?? 1,
            });
        }
        grid.push(row);
    }
    return { grid, gameDuration, gameMode, coopGoalFraction, wordLengthMode, targetScore, vowelCenter4 };
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
        wordLengthMode: gameState.wordLengthMode,
        targetScore: gameState.targetScore,
        vowelCenter4: gameState.vowelCenter4,
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
    const result = findAllWordsInGrid(config.grid, trie, config.wordLengthMode);
    gameState.gridWidth = config.grid[0].length;
    gameState.gridHeight = config.grid.length;
    gameState.grid = config.grid;
    gameState.gameDuration = config.gameDuration;
    gameState.gameMode = config.gameMode;
    gameState.coopGoalFraction = config.coopGoalFraction;
    // Direct assignment (not applySettings) — undefined values from the URL must override any stale state from a prior game.
    gameState.wordLengthMode = config.wordLengthMode;
    gameState.targetScore = config.targetScore;
    gameState.vowelCenter4 = config.vowelCenter4;
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
