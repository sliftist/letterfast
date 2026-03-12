import { GridCell, generateGameGrid, getWordSet, calculateWordScoreForGrid, isAdjacent, GAME_DURATION } from "./GameState";
import { AllHandlers } from "./multiplayerFunctionHandlers";
import { FunctionCallerInterface } from "./rpc/FunctionCaller";

export type PlayerIdentifier = AllHandlers;

export interface ClientHandlers {
    onPlayerUpdate(players: { id: string; score: number }[], status: string, yourPlayerIndex: number): Promise<void>;
    onGameStart(grid: GridCell[][], startTime: number): Promise<void>;
    onGameEnd(players: { id: string; score: number }[], allWords: Record<string, { word: string; points: number }[]>): Promise<void>;
}


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
}

const games = new Map<string, Game>();

function generateGameId(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let id: string;
    do {
        id = "";
        for (let i = 0; i < 8; i++) {
            id += chars[Math.floor(Math.random() * chars.length)];
        }
    } while (games.has(id));
    return id;
}

export function createGame(playerCount: number, player: PlayerIdentifier): { gameId: string } {
    if (playerCount < 2 || playerCount > 16) {
        throw new Error(`Player count must be between 2 and 16, was ${playerCount}`);
    }

    const gameId = generateGameId();

    const game: Game = {
        id: gameId,
        playerCount,
        players: [player],
        status: "waiting",
        grid: generateGameGrid(Date.now(), 4, 4),
        scores: new Map([[player, 0]]),
        words: new Map([[player, []]]),
        startTime: undefined,
        endTime: undefined
    };

    games.set(gameId, game);

    return { gameId };
}

export function joinGame(gameId: string, player: PlayerIdentifier): void {
    const game = games.get(gameId);
    if (!game) {
        throw new Error(`Game ${gameId} not found`);
    }
    if (game.status !== "waiting") {
        throw new Error(`Game ${gameId} has already started`);
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
    if (game.status !== "waiting") {
        throw new Error(`Game ${gameId} has already started`);
    }
    if (game.players[0] !== player) {
        throw new Error(`Only the first player can start the game`);
    }
}


export function startGamePlaying(gameId: string): void {
    const game = games.get(gameId);
    if (!game) {
        throw new Error(`Game ${gameId} not found`);
    }
    game.status = "playing";
    game.startTime = Date.now();
    game.endTime = Date.now() + GAME_DURATION;
}

export function endGame(gameId: string): void {
    const game = games.get(gameId);
    if (!game) return;
    game.status = "finished";
}

export function submitWord(config: {
    gameId: string;
    player: PlayerIdentifier;
    word: string;
    cells: { row: number; col: number }[];
}): { points: number } {
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
    if (!getWordSet().has(wordLower)) {
        throw new Error(`Word ${config.word} is not in dictionary`);
    }

    if (config.cells.length < 2) {
        throw new Error(`Word must be at least 2 letters`);
    }

    for (let i = 1; i < config.cells.length; i++) {
        if (!isAdjacent(config.cells[i - 1], config.cells[i])) {
            throw new Error(`Cells are not adjacent`);
        }
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

    if (game.players.length === 0) {
        games.delete(gameId);
    }
}

export function broadcastToGame(gameId: string, callback: (client: ClientHandlers, playerIndex: number) => void): void {
    const game = games.get(gameId);
    if (!game) return;
    for (let i = 0; i < game.players.length; i++) {
        const player = game.players[i];
        callback(player, i);
    }
}

