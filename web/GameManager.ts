import { GridCell, getWordSet, calculateWordScoreForGrid, isAdjacent, GAME_DURATION, DEFAULT_GAME_MODE, DEFAULT_COOP_GOAL_FRACTION } from "./GameState";
import { generateGameGrid } from "./GridGenerator";
import { AllHandlers, ClientHandlers } from "./multiplayerFunctionHandlers";
import { FunctionCallerInterface } from "./rpc/FunctionCaller";

export type PlayerIdentifier = AllHandlers;

interface Game {
    id: string;
    playerCount: number;
    players: PlayerIdentifier[];
    // Client-generated stable IDs, parallel to `players`. When a client
    // reconnects with the same id, the slot (and its score/words/letter) is
    // restored. Empty string when the client didn't provide one.
    clientIds: string[];
    status: "waiting" | "playing" | "finished";
    grid: GridCell[][];
    scores: Map<PlayerIdentifier, number>;
    words: Map<PlayerIdentifier, { word: string; points: number; cells: { row: number; col: number }[]; at: number }[]>;
    startTime?: number;
    endTime?: number;
    gameDuration: number;
    gridWidth: number;
    gridHeight: number;
    createdTime: number;
    lastActivityTime: number;
    totalPossibleWords: number;
    totalPossibleScore: number;
    showRemainingWordsPerCell: boolean;
    showTotalPossibleScore: boolean;
    gameMode: "competitive" | "cooperative" | "competitive-shared";
    coopGoalFraction: number;
    timerSeqNum: number;
    // Players who disconnected mid-game. They stay in `players` (removing them would delete their words/score and shift every later player's index); they're actually pruned when the next game starts.
    disconnectedPlayers: Set<PlayerIdentifier>;
    // Timestamp when the game became fully empty (every slot disconnected).
    // Cleared when any slot becomes connected. Used by cleanupIdleGames to
    // keep an empty game alive for a grace period so a single player can
    // refresh and rejoin the same game they were in.
    emptiedAt?: number;
}

// Empty games carry no runtime cost (no per-game tick, just a few KB of
// state in the games Map), so we keep them around for a week — long enough
// that a player who closed the tab can still rejoin days later.
const EMPTY_GAME_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface GameSnapshot {
    gameId: string;
    status: "waiting" | "playing" | "finished";
    hostPlayerIndex: number;
    yourPlayerIndex: number;
    players: { id: string; score: number }[];
    gridWidth: number;
    gridHeight: number;
    gameDuration: number;
    gameMode: "competitive" | "cooperative" | "competitive-shared";
    coopGoalFraction: number;
    showRemainingWordsPerCell: boolean;
    showTotalPossibleScore: boolean;
    totalPossibleWords: number;
    totalPossibleScore: number;
    grid: GridCell[][];
    startTime: number | undefined;
    coopMatchedWords: { word: string; points: number; playerIndex: number }[];
    // The receiving player's own accepted words, in every mode — lets a reconnecting client restore its found-word list (coopMatchedWords only covers cooperative).
    yourWords: { word: string; points: number }[];
    timerSeqNum: number;
}

const games = new Map<string, Game>();

// Plain-JSON shape of a Game for SQLite persistence. Live RPC handles can't be serialized, so scores/words are stored by player index and players are restored as disconnected stubs — the clientId rejoin path swaps the real handle back into the slot when the player reconnects.
interface SerializedGame {
    id: string;
    playerCount: number;
    clientIds: string[];
    status: "waiting" | "playing" | "finished";
    grid: GridCell[][];
    scores: number[];
    words: { word: string; points: number; cells: { row: number; col: number }[]; at: number }[][];
    startTime?: number;
    endTime?: number;
    gameDuration: number;
    gridWidth: number;
    gridHeight: number;
    createdTime: number;
    lastActivityTime: number;
    totalPossibleWords: number;
    totalPossibleScore: number;
    showRemainingWordsPerCell: boolean;
    showTotalPossibleScore: boolean;
    gameMode: "competitive" | "cooperative" | "competitive-shared";
    coopGoalFraction: number;
    timerSeqNum: number;
    emptiedAt?: number;
}

function makeOfflinePlayerStub(): PlayerIdentifier {
    // Quiet no-op for every RPC method — restored players are disconnected until they rejoin, and broadcasts to them should neither throw nor log.
    return new Proxy({}, { get: () => async () => undefined }) as unknown as PlayerIdentifier;
}

export function serializeAllGames(): { id: string; data: string }[] {
    const out: { id: string; data: string }[] = [];
    for (const game of games.values()) {
        const s: SerializedGame = {
            id: game.id,
            playerCount: game.playerCount,
            clientIds: game.clientIds,
            status: game.status,
            grid: game.grid,
            scores: game.players.map(p => game.scores.get(p) || 0),
            words: game.players.map(p => game.words.get(p) || []),
            startTime: game.startTime,
            endTime: game.endTime,
            gameDuration: game.gameDuration,
            gridWidth: game.gridWidth,
            gridHeight: game.gridHeight,
            createdTime: game.createdTime,
            lastActivityTime: game.lastActivityTime,
            totalPossibleWords: game.totalPossibleWords,
            totalPossibleScore: game.totalPossibleScore,
            showRemainingWordsPerCell: game.showRemainingWordsPerCell,
            showTotalPossibleScore: game.showTotalPossibleScore,
            gameMode: game.gameMode,
            coopGoalFraction: game.coopGoalFraction,
            timerSeqNum: game.timerSeqNum,
            emptiedAt: game.emptiedAt,
        };
        out.push({ id: game.id, data: JSON.stringify(s) });
    }
    return out;
}

// Returns the competitive games still mid-play whose end timers must be re-armed by the caller (timers don't survive a restart).
export function restoreSerializedGames(rows: { id: string; data: string }[]): { gameId: string; remainingMs: number; timerSeqNum: number }[] {
    const timers: { gameId: string; remainingMs: number; timerSeqNum: number }[] = [];
    const now = Date.now();
    for (const row of rows) {
        let s: SerializedGame;
        try {
            s = JSON.parse(row.data) as SerializedGame;
        } catch (err) {
            console.error(`Failed to parse persisted game ${row.id}, skipping:`, (err as Error).stack ?? err);
            continue;
        }
        const players = s.clientIds.map(() => makeOfflinePlayerStub());
        const game: Game = {
            id: s.id,
            playerCount: s.playerCount,
            players,
            clientIds: s.clientIds,
            status: s.status,
            grid: s.grid,
            scores: new Map(players.map((p, i) => [p, s.scores[i] || 0])),
            words: new Map(players.map((p, i) => [p, s.words[i] || []])),
            startTime: s.startTime,
            endTime: s.endTime,
            gameDuration: s.gameDuration,
            gridWidth: s.gridWidth,
            gridHeight: s.gridHeight,
            createdTime: s.createdTime,
            lastActivityTime: s.lastActivityTime,
            totalPossibleWords: s.totalPossibleWords,
            totalPossibleScore: s.totalPossibleScore,
            showRemainingWordsPerCell: s.showRemainingWordsPerCell,
            showTotalPossibleScore: s.showTotalPossibleScore,
            gameMode: s.gameMode,
            coopGoalFraction: s.coopGoalFraction,
            timerSeqNum: s.timerSeqNum,
            disconnectedPlayers: new Set(players),
            // Everyone is disconnected after a restart; keep the original empty-timestamp if the game was already empty, otherwise the grace window starts now.
            emptiedAt: s.emptiedAt ?? now,
        };
        if (game.status === "playing" && game.gameMode !== "cooperative") {
            if (game.endTime && game.endTime > now) {
                timers.push({ gameId: game.id, remainingMs: game.endTime - now, timerSeqNum: game.timerSeqNum });
            } else {
                // The game ended while the server was down (or has no end time to honor) — finish it so rejoiners see the end state instead of a frozen board.
                game.status = "finished";
            }
        }
        games.set(game.id, game);
    }
    return timers;
}

function generateGameId(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let id: string;
    do {
        id = "";
        for (let i = 0; i < 6; i++) {
            id += chars[Math.floor(Math.random() * chars.length)];
        }
    } while (games.has(id));
    return id;
}

export async function createGame(playerCount: number, player: PlayerIdentifier, clientId = ""): Promise<{ gameId: string }> {
    const gameId = generateGameId();
    const now = Date.now();
    const gridMetadata = await generateGameGrid(now, 4, 4);

    const game: Game = {
        id: gameId,
        playerCount: 16,
        players: [player],
        clientIds: [clientId],
        status: "waiting",
        grid: gridMetadata.grid,
        scores: new Map([[player, 0]]),
        words: new Map([[player, []]]),
        startTime: undefined,
        endTime: undefined,
        gameDuration: 90000,
        gridWidth: 4,
        gridHeight: 4,
        createdTime: now,
        lastActivityTime: now,
        totalPossibleWords: gridMetadata.totalPossibleWords,
        totalPossibleScore: gridMetadata.totalPossibleScore,
        showRemainingWordsPerCell: false,
        showTotalPossibleScore: false,
        gameMode: DEFAULT_GAME_MODE,
        coopGoalFraction: DEFAULT_COOP_GOAL_FRACTION,
        timerSeqNum: 0,
        disconnectedPlayers: new Set(),
    };

    games.set(gameId, game);

    return { gameId };
}

export async function createGameWithId(gameId: string, playerCount: number, player: PlayerIdentifier, gridWidth: number, gridHeight: number, gameDuration: number, showRemainingWordsPerCell = false, showTotalPossibleScore = false, clientId = ""): Promise<void> {
    const now = Date.now();
    const gridMetadata = await generateGameGrid(now, gridWidth, gridHeight);

    const game: Game = {
        id: gameId,
        playerCount,
        players: [player],
        clientIds: [clientId],
        status: "waiting",
        grid: gridMetadata.grid,
        scores: new Map([[player, 0]]),
        words: new Map([[player, []]]),
        startTime: undefined,
        endTime: undefined,
        gameDuration,
        gridWidth,
        gridHeight,
        createdTime: now,
        lastActivityTime: now,
        totalPossibleWords: gridMetadata.totalPossibleWords,
        totalPossibleScore: gridMetadata.totalPossibleScore,
        showRemainingWordsPerCell,
        showTotalPossibleScore,
        gameMode: DEFAULT_GAME_MODE,
        coopGoalFraction: DEFAULT_COOP_GOAL_FRACTION,
        timerSeqNum: 0,
        disconnectedPlayers: new Set(),
    };

    games.set(gameId, game);
}

export function joinGame(gameId: string, player: PlayerIdentifier, clientId = ""): void {
    const game = games.get(gameId);
    if (!game) {
        throw new Error(`Game ${gameId} not found`);
    }

    // Clientid rejoin: if this client already had a slot in the game, restore
    // it (replacing the old, now-dead handle). Score, words, and letter
    // index all stay the same.
    if (clientId) {
        const existingIdx = game.clientIds.indexOf(clientId);
        if (existingIdx !== -1) {
            const oldPlayer = game.players[existingIdx];
            if (oldPlayer !== player) {
                const prevScore = game.scores.get(oldPlayer) ?? 0;
                const prevWords = game.words.get(oldPlayer) ?? [];
                game.scores.delete(oldPlayer);
                game.words.delete(oldPlayer);
                game.scores.set(player, prevScore);
                game.words.set(player, prevWords);
                game.players[existingIdx] = player;
                game.disconnectedPlayers.delete(oldPlayer);
            }
            game.disconnectedPlayers.delete(player);
            game.emptiedAt = undefined;
            game.lastActivityTime = Date.now();
            return;
        }
    }

    game.disconnectedPlayers.delete(player);
    if (game.players.includes(player)) {
        game.emptiedAt = undefined;
        game.lastActivityTime = Date.now();
        return;
    }
    if (game.players.length >= game.playerCount) {
        throw new Error(`Game ${gameId} is full`);
    }

    // Joining NEVER resets a game. The board, scores, words, and status all
    // persist (keyed by gameId), so a joiner just takes a seat in whatever
    // state the game is already in — even an in-progress or finished one. If
    // every existing player is disconnected ("nobody's in it"), the joiner
    // takes the host seat (index 0) so they CAN start/restart it manually,
    // but nothing is wiped by default. The old behavior wiped the game here,
    // which (combined with the client's auto-start) reset the board out from
    // under a player who rejoined on a second machine.
    const allDisconnected = game.players.length > 0
        && game.players.every(p => game.disconnectedPlayers.has(p));
    if (allDisconnected) {
        game.players.unshift(player);
        game.clientIds.unshift(clientId);
    } else {
        game.players.push(player);
        game.clientIds.push(clientId);
    }
    game.scores.set(player, 0);
    game.words.set(player, []);
    game.emptiedAt = undefined;
    game.lastActivityTime = Date.now();
}

export function getGame(gameId: string): Game | undefined {
    return games.get(gameId);
}

export function validateStartGame(gameId: string, player: PlayerIdentifier): void {
    const game = games.get(gameId);
    if (!game) {
        throw new Error(`Game ${gameId} not found`);
    }
    if (game.players[0] !== player) {
        throw new Error(`Only the host can start the game`);
    }
}


export async function startGamePlaying(gameId: string): Promise<number> {
    const game = games.get(gameId);
    if (!game) {
        throw new Error(`Game ${gameId} not found`);
    }
    const now = Date.now();
    const gridMetadata = await generateGameGrid(now, game.gridWidth, game.gridHeight);
    game.grid = gridMetadata.grid;
    game.totalPossibleWords = gridMetadata.totalPossibleWords;
    game.totalPossibleScore = gridMetadata.totalPossibleScore;
    game.status = "playing";
    game.startTime = now;
    game.endTime = now + game.gameDuration;
    game.lastActivityTime = now;
    game.timerSeqNum++;

    for (const player of [...game.disconnectedPlayers]) {
        const idx = game.players.indexOf(player);
        if (idx !== -1) {
            game.players.splice(idx, 1);
            game.clientIds.splice(idx, 1);
        }
        game.scores.delete(player);
        game.words.delete(player);
    }
    game.disconnectedPlayers.clear();

    for (const player of game.players) {
        game.scores.set(player, 0);
        game.words.set(player, []);
    }
    return game.timerSeqNum;
}

export function getSnapshot(gameId: string, player: PlayerIdentifier): GameSnapshot | undefined {
    const game = games.get(gameId);
    if (!game) return undefined;
    const yourIdx = game.players.indexOf(player);
    const players = game.players.map((p, index) => ({
        id: `player${index + 1}`,
        score: game.scores.get(p) || 0,
    }));
    const coopMatchedWords: { word: string; points: number; playerIndex: number }[] = [];
    if (game.gameMode === "cooperative") {
        // Interlace all players' words chronologically — concatenating per player would make the client's matched-words list show blocks per player instead of most-recent-last.
        const all: { word: string; points: number; playerIndex: number; at: number }[] = [];
        game.players.forEach((p, idx) => {
            const ws = game.words.get(p) || [];
            for (const w of ws) all.push({ word: w.word, points: w.points, playerIndex: idx, at: w.at || 0 });
        });
        all.sort((a, b) => a.at - b.at);
        for (const w of all) coopMatchedWords.push({ word: w.word, points: w.points, playerIndex: w.playerIndex });
    }
    const yourWords = (game.words.get(player) || []).map(w => ({ word: w.word, points: w.points }));
    return {
        gameId: game.id,
        status: game.status,
        hostPlayerIndex: 0,
        yourPlayerIndex: yourIdx,
        players,
        gridWidth: game.gridWidth,
        gridHeight: game.gridHeight,
        gameDuration: game.gameDuration,
        gameMode: game.gameMode,
        coopGoalFraction: game.coopGoalFraction,
        showRemainingWordsPerCell: game.showRemainingWordsPerCell,
        showTotalPossibleScore: game.showTotalPossibleScore,
        totalPossibleWords: game.totalPossibleWords,
        totalPossibleScore: game.totalPossibleScore,
        grid: game.grid,
        startTime: game.startTime,
        coopMatchedWords,
        yourWords,
        timerSeqNum: game.timerSeqNum,
    };
}

export function endGame(gameId: string): void {
    const game = games.get(gameId);
    if (!game) return;
    game.status = "finished";
}

export async function submitWord(config: {
    gameId: string;
    player: PlayerIdentifier;
    word: string;
    cells: { row: number; col: number }[];
}): Promise<{ points: number }> {
    const game = games.get(config.gameId);
    if (!game) {
        throw new Error(`Game ${config.gameId} not found`);
    }

    if (game.status !== "playing") {
        const now = Date.now();
        if (!game.endTime || now < game.endTime - 1000 || now > game.endTime + 1000) {
            throw new Error(`Game is not active`);
        }
    }

    if (!game.players.includes(config.player)) {
        throw new Error(`Player is not in game ${config.gameId}`);
    }

    const wordLower = config.word.toLowerCase();
    const wordSet = await getWordSet();
    if (!wordSet.has(wordLower)) {
        throw new Error(`Word ${config.word} is not in dictionary`);
    }

    if (config.cells.length < 3) {
        throw new Error(`Word must be at least 3 letters`);
    }

    for (let i = 1; i < config.cells.length; i++) {
        if (!isAdjacent(config.cells[i - 1], config.cells[i])) {
            throw new Error(`Cells are not adjacent`);
        }
    }

    const spelledWord = config.cells.map(cell => {
        if (!game.grid[cell.row] || !game.grid[cell.row][cell.col]) {
            throw new Error(`Invalid cell position: row ${cell.row}, col ${cell.col}`);
        }
        return game.grid[cell.row][cell.col].letter;
    }).join("");

    if (spelledWord.toLowerCase() !== wordLower) {
        throw new Error(`Cells do not spell the word ${config.word}, they spell ${spelledWord}`);
    }

    const playerWords = game.words.get(config.player) || [];
    if (playerWords.some(w => w.word.toLowerCase() === wordLower)) {
        throw new Error(`Word ${config.word} already played`);
    }
    // Both cooperative and competitive-shared dedupe globally across
    // players. Competitive-shared throws a structured "BLOCKED:" error so
    // the client can show "this word was already taken by someone else."
    if (game.gameMode === "cooperative" || game.gameMode === "competitive-shared") {
        for (const [otherPlayer, otherWords] of game.words) {
            if (otherPlayer === config.player) continue;
            if (otherWords.some(w => w.word.toLowerCase() === wordLower)) {
                if (game.gameMode === "competitive-shared") {
                    throw new Error(`BLOCKED: ${config.word}`);
                }
                throw new Error(`Word ${config.word} already played`);
            }
        }
    }

    const points = calculateWordScoreForGrid(game.grid, config.cells);
    const currentScore = game.scores.get(config.player) || 0;
    game.scores.set(config.player, currentScore + points);

    playerWords.push({ word: config.word.toUpperCase(), points, cells: config.cells, at: Date.now() });
    game.words.set(config.player, playerWords);

    return { points };
}

export function getPlayerScores(gameId: string): { id: string; score: number }[] {
    const game = games.get(gameId);
    if (!game) return [];

    return game.players.map((player, index) => ({
        id: `player${index + 1}`,
        score: game.scores.get(player) || 0
    }));
}

export function getPlayerWordCount(gameId: string, player: PlayerIdentifier): number {
    const game = games.get(gameId);
    if (!game) return 0;
    const playerWords = game.words.get(player);
    if (!playerWords) return 0;
    return playerWords.length;
}

export function getAllWords(gameId: string): Record<string, { word: string; points: number }[]> {
    const game = games.get(gameId);
    if (!game) return {};

    const result: Record<string, { word: string; points: number }[]> = {};
    game.players.forEach((player, index) => {
        const words = game.words.get(player) || [];
        result[`player${index + 1}`] = words.map(w => ({ word: w.word, points: w.points }));
    });
    return result;
}

export function removePlayerFromGame(gameId: string, player: PlayerIdentifier): void {
    const game = games.get(gameId);
    if (!game) return;

    const playerIndex = game.players.indexOf(player);
    if (playerIndex === -1) return;

    // Decide whether to preserve the slot (so the client can refresh and
    // rejoin via clientId) or evict it.
    // - "playing":   always preserve. Removing them mid-game would shift
    //                every later player's letter and corrupt the coop word
    //                list. The slot is pruned on the next startGamePlaying.
    // - "finished":  always preserve. The user may want to Continue or
    //                Restart, and other players' scoreboards reference
    //                their slot.
    // - "waiting":   preserve only if they're the *last* player in the game,
    //                so a solo creator who refreshes doesn't lose their
    //                game. Otherwise (other lobby members), evict so the
    //                lobby's player count drops immediately.
    const isLastPlayer = game.players.length === 1;
    const preserveSlot = game.status !== "waiting" || isLastPlayer;

    if (preserveSlot) {
        game.disconnectedPlayers.add(player);
    } else {
        game.players.splice(playerIndex, 1);
        game.clientIds.splice(playerIndex, 1);
        game.scores.delete(player);
        game.words.delete(player);
        game.disconnectedPlayers.delete(player);
    }

    // If every remaining slot is disconnected, start the empty-game grace
    // timer. cleanupIdleGames deletes the game once it stays empty long
    // enough.
    const anyConnected = game.players.some(p => !game.disconnectedPlayers.has(p));
    if (!anyConnected && game.emptiedAt === undefined) {
        game.emptiedAt = Date.now();
    }
}

const BROADCAST_TIMEOUT_MS = 15000;

export async function broadcastToGame(gameId: string, callback: (client: ClientHandlers, playerIndex: number) => Promise<void>): Promise<void> {
    const game = games.get(gameId);
    if (!game) return;

    const players = game.players.slice();
    if (players.length === 0) return;

    const results = await Promise.all(players.map(async (player, i) => {
        try {
            await Promise.race([
                callback(player, i),
                new Promise<never>((_, reject) => {
                    setTimeout(() => reject(new Error(`Broadcast to player ${i} in game ${gameId} timed out after ${BROADCAST_TIMEOUT_MS}ms`)), BROADCAST_TIMEOUT_MS);
                }),
            ]);
            return true;
        } catch (error) {
            console.error(`Broadcast to player ${i} in game ${gameId} failed:`, error);
            return false;
        }
    }));

    // Only auto-delete the game when every CONNECTED player's broadcast
    // failed — if all the listed slots are intentionally disconnected
    // (everyone closed the tab), let the empty-game grace timer handle
    // cleanup so a refresh can still rejoin.
    const connectedResults = results.filter((_, i) => !game.disconnectedPlayers.has(players[i]));
    const anySucceeded = connectedResults.some(r => r);
    if (connectedResults.length > 0 && !anySucceeded && games.get(gameId) === game) {
        console.warn(`All broadcasts failed for game ${gameId}, removing game`);
        games.delete(gameId);
    }
}

export function updateGameSettings(config: {
    gameId: string;
    player: PlayerIdentifier;
    gridWidth?: number;
    gridHeight?: number;
    gameDuration?: number;
    showRemainingWordsPerCell?: boolean;
    showTotalPossibleScore?: boolean;
    gameMode?: "competitive" | "cooperative" | "competitive-shared";
    coopGoalFraction?: number;
}): void {
    const game = games.get(config.gameId);
    if (!game) {
        throw new Error(`Game ${config.gameId} not found`);
    }
    if (game.players[0] !== config.player) {
        throw new Error(`Only the host can update game settings`);
    }

    if (config.gridWidth !== undefined) {
        if (config.gridWidth < 2 || config.gridWidth > 10) {
            throw new Error(`Grid width must be between 2 and 10, was ${config.gridWidth}`);
        }
        game.gridWidth = config.gridWidth;
    }

    if (config.gridHeight !== undefined) {
        if (config.gridHeight < 2 || config.gridHeight > 10) {
            throw new Error(`Grid height must be between 2 and 10, was ${config.gridHeight}`);
        }
        game.gridHeight = config.gridHeight;
    }

    if (config.gameDuration !== undefined) {
        if (config.gameDuration < 10000 || config.gameDuration > 3600000) {
            throw new Error(`Game duration must be between 10000 and 3600000 ms, was ${config.gameDuration}`);
        }
        game.gameDuration = config.gameDuration;
    }

    if (config.showRemainingWordsPerCell !== undefined) {
        game.showRemainingWordsPerCell = !!config.showRemainingWordsPerCell;
    }

    if (config.showTotalPossibleScore !== undefined) {
        game.showTotalPossibleScore = !!config.showTotalPossibleScore;
    }

    if (config.gameMode !== undefined) {
        if (config.gameMode === "cooperative" || config.gameMode === "competitive-shared") {
            game.gameMode = config.gameMode;
        } else {
            game.gameMode = "competitive";
        }
    }
    if (config.coopGoalFraction !== undefined) {
        game.coopGoalFraction = Math.max(0.05, Math.min(1, config.coopGoalFraction));
    }

    game.timerSeqNum++;
}

export function getGameSettings(gameId: string): { gridWidth: number; gridHeight: number; gameDuration: number; showRemainingWordsPerCell: boolean; showTotalPossibleScore: boolean; gameMode: "competitive" | "cooperative" | "competitive-shared"; coopGoalFraction: number } {
    const game = games.get(gameId);
    if (!game) {
        throw new Error(`Game ${gameId} not found`);
    }
    return {
        gridWidth: game.gridWidth,
        gridHeight: game.gridHeight,
        gameDuration: game.gameDuration,
        showRemainingWordsPerCell: game.showRemainingWordsPerCell,
        showTotalPossibleScore: game.showTotalPossibleScore,
        gameMode: game.gameMode,
        coopGoalFraction: game.coopGoalFraction,
    };
}

export function cleanupIdleGames(): void {
    const now = Date.now();
    const oneWeek = 7 * 24 * 60 * 60 * 1000;

    for (const [gameId, game] of games.entries()) {
        if (game.emptiedAt !== undefined) {
            if (now - game.emptiedAt > EMPTY_GAME_GRACE_MS) {
                games.delete(gameId);
            }
        } else if (game.players.length === 0) {
            // Defensive: shouldn't normally hit this since emptiedAt is set
            // alongside the last disconnect, but evict immediately if we do.
            games.delete(gameId);
        } else if (now - game.lastActivityTime > oneWeek) {
            games.delete(gameId);
        }
    }
}

export function startCleanupInterval(): void {
    setInterval(cleanupIdleGames, 5 * 60 * 1000);
}
