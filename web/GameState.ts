import { observable } from "mobx";
import { isNode } from "typesafecss";
import { getWords } from "./words";
import { generateGameGrid } from "./GridGenerator";
import { getSavedConfigOrDefaults } from "./GameConfig";
import { showGameOver } from "./GameOver";


export const CELL_SIZE = 80;
export const CELL_GAP = 8;
export const HIT_SIZE = 55;
export const HIT_OFFSET = (CELL_SIZE - HIT_SIZE) / 2;
export const GAME_DURATION = 90000;
export const MIN_VOWEL_FRACTION = 0.20;
export const MAX_VOWEL_FRACTION = 0.45;

export interface GridCell {
    letter: string;
    points: number;
    multiplier: 1 | 2 | 3;
}

export interface MultiplayerPlayer {
    id: string;
    score: number;
}

export interface GameState {
    status: "ready" | "playing" | "finished" | "waiting";
    grid: GridCell[][];
    timeRemaining: number;
    score: number;
    matchedWords: { word: string; points: number }[];
    matchedWordsSet: Set<string>;
    isMultiplayer: boolean;
    gameId: string | undefined;
    myPlayerIndex: number | undefined;
    players: MultiplayerPlayer[];
    allWords: Record<string, { word: string; points: number }[]>;
    gameDuration: number;
    gridWidth: number;
    gridHeight: number;
    consecutiveWrongWords: number;
    timeoutUntil: number;
    totalPossibleWords: number;
    totalPossibleScore: number;
    cellToWords: Map<string, Set<string>>;
    isChallengeMode: boolean;
    challengerData?: {
        words: { word: string; points: number }[];
        score: number;
    };
    challengeMetadata?: {
        challengeId: string;
        signature: string;
        publicKey: string;
    };
    connectionStatus: "disconnected" | "connecting" | "connected" | "error";
}

export interface GameHistory {
    timestamp: number;
    score: number;
    wordsFound: number;
    duration: number;
}

export type GameOverState =
    {
        grid: GridCell[][];
        playerResults: {
            id: string;
            score: number;
            matchedWords: { word: string; points: number }[];
            isSelf?: boolean;
        }[];

        totalPossibleScore: number;
        totalPossibleWords: number;
    };

export const LETTER_POINTS: { [key: string]: number } = {
    E: 1, A: 1, I: 1, O: 1, N: 1, R: 1, T: 1, L: 1, S: 1, U: 1,
    D: 2, G: 2,
    B: 3, C: 3, M: 3, P: 3,
    F: 4, H: 4, V: 4, W: 4, Y: 4,
    K: 5,
    J: 8, X: 8,
    Q: 10, Z: 10,
};

export const LETTER_FREQUENCY = "EEEEEEEEEEEEETTTTTTTTTAAAAAAAAAOOOOOOOOIIIIIIINNNNNNNSSSSSSRRRRRRHHHHHHDDDDLLLLCCCCUUUUMMMMPPPPFFFFGGGGBBBBVVWWYYKJXQZ";

let wordSet: Set<string> | undefined;
let wordSetPromise: Promise<Set<string>> | undefined;

export async function getWordSet(): Promise<Set<string>> {
    if (wordSet) return wordSet;
    if (wordSetPromise) return wordSetPromise;

    wordSetPromise = getWords().then(words => {
        wordSet = new Set(words.map(w => w.toLowerCase()));
        return wordSet;
    });

    return wordSetPromise;
}

if (!isNode()) {
    setImmediate(() => {
        void getWordSet();
    });
}

async function generateGrid(): Promise<GridCell[][]> {
    let seed = Date.now();
    let result = await generateGameGrid(seed, gameState.gridWidth, gameState.gridHeight);
    gameState.totalPossibleWords = result.totalPossibleWords;
    gameState.totalPossibleScore = result.totalPossibleScore;
    gameState.cellToWords = result.cellToWords;
    return result.grid;
}

export const gameHistory: GameHistory[] = [];

const initialConfig = isNode() ? { gridWidth: 4, gridHeight: 4, gameDuration: GAME_DURATION } : getSavedConfigOrDefaults();

export const gameState = observable<GameState>({
    status: "ready",
    grid: [],
    timeRemaining: initialConfig.gameDuration,
    score: 0,
    matchedWords: [],
    matchedWordsSet: new Set<string>(),
    isMultiplayer: false,
    gameId: undefined,
    myPlayerIndex: undefined,
    players: [],
    allWords: {},
    gameDuration: initialConfig.gameDuration,
    gridWidth: initialConfig.gridWidth,
    gridHeight: initialConfig.gridHeight,
    consecutiveWrongWords: 0,
    timeoutUntil: 0,
    totalPossibleWords: 0,
    totalPossibleScore: 0,
    cellToWords: new Map<string, Set<string>>(),
    isChallengeMode: false,
    challengerData: undefined,
    challengeMetadata: undefined,
    connectionStatus: "disconnected",
});

void generateGrid().then(grid => {
    if (!gameState.isChallengeMode) {
        gameState.grid = grid;
    }
});

let timerInterval: number | undefined;

export async function startGame(regenerateGrid = true, duration?: number) {
    gameState.status = "playing";
    if (duration !== undefined) {
        gameState.gameDuration = duration;
    }
    if (regenerateGrid) {
        gameState.grid = await generateGrid();
        gameState.isChallengeMode = false;
        gameState.challengerData = undefined;
    }
    gameState.timeRemaining = gameState.gameDuration;
    gameState.score = 0;
    gameState.matchedWords = [];
    gameState.matchedWordsSet.clear();
    gameState.consecutiveWrongWords = 0;
    gameState.timeoutUntil = 0;
    if (timerInterval) clearInterval(timerInterval);
    let startTime = Date.now();
    timerInterval = window.setInterval(() => {
        if (gameState.status !== "playing") return;
        gameState.timeRemaining = Math.max(0, gameState.gameDuration - (Date.now() - startTime));
        if (gameState.timeRemaining === 0) {
            void endGame();
        }
    }, 100);
}

export async function endGame() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = undefined;
    gameState.status = "finished";
    gameHistory.push({
        timestamp: Date.now(),
        score: gameState.score,
        wordsFound: gameState.matchedWords.length,
        duration: gameState.gameDuration - gameState.timeRemaining,
    });

    if (gameState.isChallengeMode && gameState.challengeMetadata && !isNode()) {
        try {
            const { getRPCClient } = await import("./rpcClient");
            const rpc = getRPCClient();
            await rpc.submitChallengeCompletion(
                gameState.challengeMetadata.challengeId,
                gameState.challengeMetadata.signature,
                gameState.challengeMetadata.publicKey,
                gameState.score,
                gameState.matchedWords
            );
        } catch (error) {
            console.error("Failed to submit challenge completion:", error);
        }
    }

    if (!gameState.isMultiplayer && !isNode()) {
        let playerResults: GameOverState["playerResults"];
        
        if (gameState.isChallengeMode && gameState.challengerData) {
            playerResults = [
                {
                    id: "challenger",
                    score: gameState.challengerData.score,
                    matchedWords: gameState.challengerData.words,
                    isSelf: false,
                },
                {
                    id: "player",
                    score: gameState.score,
                    matchedWords: gameState.matchedWords,
                    isSelf: true,
                }
            ];
        } else {
            playerResults = [{
                id: "player",
                score: gameState.score,
                matchedWords: gameState.matchedWords,
                isSelf: true,
            }];
        }

        const gameOverState: GameOverState = {
            grid: gameState.grid,
            playerResults,
            totalPossibleScore: gameState.totalPossibleScore,
            totalPossibleWords: gameState.totalPossibleWords,
        };
        showGameOver(gameOverState, async () => await startGame());
    }
}

export async function changeGridSize(config: { width: number; height: number }) {
    if (config.width < 2 || config.width > 10) {
        throw new Error(`Grid width must be between 2 and 10, was ${config.width}`);
    }
    if (config.height < 2 || config.height > 10) {
        throw new Error(`Grid height must be between 2 and 10, was ${config.height}`);
    }
    gameState.gridWidth = config.width;
    gameState.gridHeight = config.height;
    gameState.grid = await generateGrid();
    gameState.status = "ready";
    gameState.score = 0;
    gameState.matchedWords = [];
    gameState.matchedWordsSet.clear();
    gameState.timeRemaining = gameState.gameDuration;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = undefined;
}

export async function regenerateGridForCurrentSize(): Promise<void> {
    gameState.grid = await generateGrid();
}

export function getCurrentGridSize(): { width: number; height: number } {
    return { width: gameState.gridWidth, height: gameState.gridHeight };
}

export function calculateWordScore(cells: { row: number; col: number }[]): number {
    let baseScore = 0;
    let multiplier = 1;
    for (let cell of cells) {
        let gridCell = gameState.grid[cell.row][cell.col];
        baseScore += gridCell.points;
        if (gridCell.multiplier > 1) {
            multiplier *= gridCell.multiplier;
        }
    }
    return baseScore * multiplier;
}

export function calculateWordScoreForGrid(grid: GridCell[][], cells: { row: number; col: number }[]): number {
    let baseScore = 0;
    let multiplier = 1;
    for (let cell of cells) {
        let gridCell = grid[cell.row][cell.col];
        baseScore += gridCell.points;
        if (gridCell.multiplier > 1) {
            multiplier *= gridCell.multiplier;
        }
    }
    return baseScore * multiplier;
}

export function cellCenter(row: number, col: number) {
    let x = col * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2;
    let y = row * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2;
    return { x, y };
}

export function getCellAt(pos: { x: number; y: number }): { row: number; col: number } | undefined {
    let gridSize = getCurrentGridSize();
    let col = Math.floor(pos.x / (CELL_SIZE + CELL_GAP));
    let row = Math.floor(pos.y / (CELL_SIZE + CELL_GAP));
    if (col < 0 || col >= gridSize.width || row < 0 || row >= gridSize.height) return undefined;
    let center = cellCenter(row, col);
    let dx = pos.x - center.x;
    let dy = pos.y - center.y;
    let distance = Math.sqrt(dx * dx + dy * dy);
    let radius = HIT_SIZE / 2;
    if (distance > radius) return undefined;
    return { row, col };
}

export function isAdjacent(a: { row: number; col: number }, b: { row: number; col: number }) {
    return Math.abs(a.row - b.row) <= 1 && Math.abs(a.col - b.col) <= 1;
}

export function formatTime(ms: number): string {
    let totalSeconds = Math.ceil(ms / 1000);
    let minutes = Math.floor(totalSeconds / 60);
    let seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function cleanup() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = undefined;
}