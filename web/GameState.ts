import { observable } from "mobx";
import { isNode } from "typesafecss";
import { getWords } from "./words";
import { getSeededRandom } from "sliftutils/misc/random";

export const CELL_SIZE = 80;
export const CELL_GAP = 8;
export const HIT_SIZE = 60;
export const HIT_OFFSET = (CELL_SIZE - HIT_SIZE) / 2;
export const GAME_DURATION = 90000;

export interface GridCell {
    letter: string;
    points: number;
    multiplier: 1 | 2 | 3;
}

export interface GameState {
    status: "ready" | "playing" | "finished";
    grid: GridCell[][];
    timeRemaining: number;
    score: number;
    matchedWords: { word: string; points: number }[];
}

export interface GameHistory {
    timestamp: number;
    score: number;
    wordsFound: number;
    duration: number;
}

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

let GRID_WIDTH = 4;
let GRID_HEIGHT = 4;

function getStoredGridDimensions(): { width: number; height: number } {
    if (isNode()) return { width: 2, height: 2 };
    let stored = localStorage.getItem("letterfast-grid-dimensions");
    if (!stored) return { width: 4, height: 4 };
    let parsed = JSON.parse(stored);
    if (!parsed || typeof parsed.width !== "number" || typeof parsed.height !== "number") {
        return { width: 4, height: 4 };
    }
    if (parsed.width < 2 || parsed.width > 10 || parsed.height < 2 || parsed.height > 10) {
        return { width: 4, height: 4 };
    }
    return { width: parsed.width, height: parsed.height };
}

function setStoredGridDimensions(config: { width: number; height: number }) {
    localStorage.setItem("letterfast-grid-dimensions", JSON.stringify(config));
}

let storedDimensions = getStoredGridDimensions();
GRID_WIDTH = storedDimensions.width;
GRID_HEIGHT = storedDimensions.height;

let wordSet: Set<string> | undefined;
export function getWordSet() {
    if (wordSet) return wordSet;
    wordSet = new Set(getWords().map(w => w.toLowerCase()));
    return wordSet;
}
if (!isNode()) {
    getWordSet();
}

export function generateGameGrid(seed: number, width: number, height: number): GridCell[][] {
    let random = getSeededRandom(seed);
    let grid: GridCell[][] = [];
    for (let row = 0; row < height; row++) {
        let rowCells: GridCell[] = [];
        for (let col = 0; col < width; col++) {
            let letter = LETTER_FREQUENCY[Math.floor(random() * LETTER_FREQUENCY.length)];
            rowCells.push({
                letter,
                points: LETTER_POINTS[letter] || 1,
                multiplier: 1,
            });
        }
        grid.push(rowCells);
    }
    let multipliersToAdd = [2, 2, 3];
    let usedPositions = new Set<string>();
    for (let multiplier of multipliersToAdd) {
        let row: number;
        let col: number;
        let key: string;
        do {
            row = Math.floor(random() * height);
            col = Math.floor(random() * width);
            key = `${row},${col}`;
        } while (usedPositions.has(key));
        usedPositions.add(key);
        grid[row][col].multiplier = multiplier as 2 | 3;
    }
    return grid;
}

function generateGrid(): GridCell[][] {
    let seed = Date.now();
    return generateGameGrid(seed, GRID_WIDTH, GRID_HEIGHT);
}

export const gameHistory: GameHistory[] = [];
export const gameState = observable<GameState>({
    status: "ready",
    grid: generateGrid(),
    timeRemaining: GAME_DURATION,
    score: 0,
    matchedWords: [],
});

let timerInterval: number | undefined;

export function startGame(regenerateGrid = true) {
    gameState.status = "playing";
    if (regenerateGrid) {
        gameState.grid = generateGrid();
    }
    gameState.timeRemaining = GAME_DURATION;
    gameState.score = 0;
    gameState.matchedWords = [];
    if (timerInterval) clearInterval(timerInterval);
    let startTime = Date.now();
    timerInterval = window.setInterval(() => {
        if (gameState.status !== "playing") return;
        gameState.timeRemaining = Math.max(0, GAME_DURATION - (Date.now() - startTime));
        if (gameState.timeRemaining === 0) {
            endGame();
        }
    }, 100);
}

export function endGame() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = undefined;
    gameState.status = "finished";
    gameHistory.push({
        timestamp: Date.now(),
        score: gameState.score,
        wordsFound: gameState.matchedWords.length,
        duration: GAME_DURATION - gameState.timeRemaining,
    });
}

export function changeGridSize(config: { width: number; height: number }) {
    if (config.width < 2 || config.width > 10) {
        throw new Error(`Grid width must be between 2 and 10, was ${config.width}`);
    }
    if (config.height < 2 || config.height > 10) {
        throw new Error(`Grid height must be between 2 and 10, was ${config.height}`);
    }
    GRID_WIDTH = config.width;
    GRID_HEIGHT = config.height;
    setStoredGridDimensions(config);
    gameState.grid = generateGrid();
    gameState.status = "ready";
    gameState.score = 0;
    gameState.matchedWords = [];
    gameState.timeRemaining = GAME_DURATION;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = undefined;
}

export function getCurrentGridSize(): { width: number; height: number } {
    return { width: GRID_WIDTH, height: GRID_HEIGHT };
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

export interface MultiplayerPlayer {
    id: string;
    score: number;
}

export const multiplayerState = observable({
    gameId: undefined as string | undefined,
    myPlayerIndex: undefined as number | undefined,
    players: [] as MultiplayerPlayer[],
    status: "waiting" as "waiting" | "playing" | "finished",
    grid: undefined as GridCell[][] | undefined,
    timeRemaining: 0,
    allWords: {} as Record<string, { word: string; points: number }[]>
});