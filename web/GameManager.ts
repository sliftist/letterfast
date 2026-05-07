import { GridCell, getWordSet, calculateWordScoreForGrid, isAdjacent, GAME_DURATION } from "./GameState";
import { generateGameGrid } from "./GridGenerator";
import { AllHandlers, ClientHandlers } from "./multiplayerFunctionHandlers";
import { FunctionCallerInterface } from "./rpc/FunctionCaller";

export type PlayerIdentifier = AllHandlers;

interface Game {
    id: string;
    playerCount: number;
    players: PlayerIdentifier[];
    status: "waiting" | "playing" | "finished";
    grid: GridCell[][];
    scores: Map<PlayerIdentifier, number>;
    words: Map<PlayerIdentifier, { word: string; points: number; cells: { row: number; col: number }[] }[]>;
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
}

const games = new Map<string, Game>();

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

export async function createGame(playerCount: number, player: PlayerIdentifier): Promise<{ gameId: string }> {
    const gameId = generateGameId();
    const now = Date.now();
    const gridMetadata = await generateGameGrid(now, 4, 4);

    const game: Game = {
        id: gameId,
        playerCount: 16,
        players: [player],
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
    };

    games.set(gameId, game);

    return { gameId };
}

export async function createGameWithId(gameId: string, playerCount: number, player: PlayerIdentifier, gridWidth: number, gridHeight: number, gameDuration: number, showRemainingWordsPerCell = false, showTotalPossibleScore = false): Promise<void> {
    const now = Date.now();
    const gridMetadata = await generateGameGrid(now, gridWidth, gridHeight);

    const game: Game = {
        id: gameId,
        playerCount,
        players: [player],
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
    };

    games.set(gameId, game);
}

export function joinGame(gameId: string, player: PlayerIdentifier): void {
    const game = games.get(gameId);
    if (!game) {
        throw new Error(`Game ${gameId} not found`);
    }
    if (game.players.length >= game.playerCount) {
        throw new Error(`Game ${gameId} is full`);
    }

    game.players.push(player);
    game.scores.set(player, 0);
    game.words.set(player, []);
}

export function getGame(gameId: string): Game | undefined {
    return games.get(gameId);
}

export function validateStartGame(gameId: string, player: PlayerIdentifier): void {
    const game = games.get(gameId);
    if (!game) {
        throw new Error(`Game ${gameId} not found`);
    }
    if (game.status === "playing") {
        throw new Error(`Game ${gameId} is currently playing`);
    }
    if (game.players[0] !== player) {
        throw new Error(`Only the first player can start the game`);
    }
}


export async function startGamePlaying(gameId: string): Promise<void> {
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

    for (const player of game.players) {
        game.scores.set(player, 0);
        game.words.set(player, []);
    }
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

    const points = calculateWordScoreForGrid(game.grid, config.cells);
    const currentScore = game.scores.get(config.player) || 0;
    game.scores.set(config.player, currentScore + points);

    playerWords.push({ word: config.word.toUpperCase(), points, cells: config.cells });
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
    if (playerIndex !== -1) {
        game.players.splice(playerIndex, 1);
    }

    game.scores.delete(player);
    game.words.delete(player);
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

    const anySucceeded = results.some(r => r);
    if (!anySucceeded && games.get(gameId) === game) {
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
}): void {
    const game = games.get(config.gameId);
    if (!game) {
        throw new Error(`Game ${config.gameId} not found`);
    }
    if (game.status === "playing") {
        throw new Error(`Cannot update settings while game is playing`);
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
}

export function getGameSettings(gameId: string): { gridWidth: number; gridHeight: number; gameDuration: number; showRemainingWordsPerCell: boolean; showTotalPossibleScore: boolean } {
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
    };
}

export function cleanupIdleGames(): void {
    const now = Date.now();
    const thirtyMinutes = 30 * 60 * 1000;
    const oneWeek = 7 * 24 * 60 * 60 * 1000;

    for (const [gameId, game] of games.entries()) {
        if (game.players.length === 0) {
            if (now - game.createdTime > thirtyMinutes) {
                games.delete(gameId);
            }
        } else {
            if (now - game.lastActivityTime > oneWeek) {
                games.delete(gameId);
            }
        }
    }
}

export function startCleanupInterval(): void {
    setInterval(cleanupIdleGames, 5 * 60 * 1000);
}
