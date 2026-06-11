import { observable } from "mobx";
import { isNode } from "typesafecss";
import { getWords } from "./words";
import { generateGameGrid, buildCellToWords, getWordTrie, gridLetterFingerprint } from "./GridGenerator";
import { getSavedConfigOrDefaults } from "./GameConfig";
import { showGameOver } from "./GameOver";


export const CELL_SIZE = 80;
export const CELL_GAP = 8;
export const HIT_SIZE = 55;
export const HIT_OFFSET = (CELL_SIZE - HIT_SIZE) / 2;
export const GAME_DURATION = 90000;
// New users default to cooperative mode at this goal fraction. The goal
// no longer auto-ends the game — it's just a milestone — so a low target
// gives a quick sense of progress while leaving room to keep playing.
export const DEFAULT_GAME_MODE: "cooperative" = "cooperative";
export const DEFAULT_COOP_GOAL_FRACTION = 0.25;
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

export type GameMode = "competitive" | "cooperative" | "competitive-shared";

export interface MatchedWord {
    word: string;
    points: number;
    playerIndex?: number;
    /** Set in competitive-shared mode when this player tried to pick a
     *  word another player had already picked. Renders with strikethrough. */
    blocked?: boolean;
}

export interface GameState {
    status: "ready" | "playing" | "finished" | "waiting";
    grid: GridCell[][];
    startTime: number | undefined;
    timeRemaining: number;
    elapsedTime: number;
    score: number;
    matchedWords: MatchedWord[];
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
    showRemainingWordsPerCell: boolean;
    showTotalPossibleScore: boolean;
    restartCountdownEnd: number;
    gameMode: GameMode;
    coopGoalFraction: number;
    /** Set when the user resumes a cooperative game after hitting the goal.
     *  While true, the goal no longer triggers `endGame()` so they can keep
     *  playing past the target (the goal indicator stays visible as a
     *  milestone). Cleared at the start of any new game. */
    coopInfinite: boolean;
    peerFlashRequest?: { id: number; cells: { row: number; col: number }[]; playerIndex: number };
    lastGameOverState?: GameOverState;
    lastGameOverOnPlayAgain?: () => void;
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
        // The word (and which player picked it) that crossed the coop goal.
        // Only set when the game ended because the cooperative target was
        // reached. Undefined for non-coop games, manual End Now, etc.
        coopWinningWord?: { word: string; points: number; playerIndex: number };
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

// Tracks which grid the current `gameState.cellToWords` corresponds to so we
// don't re-scan the dictionary on every snapshot when the grid is unchanged.
let cellToWordsFingerprint: string | undefined;

export async function ensureCellToWordsForGrid(grid: GridCell[][]): Promise<void> {
    const fp = gridLetterFingerprint(grid);
    if (cellToWordsFingerprint === fp && gameState.cellToWords.size > 0) return;
    const trie = await getWordTrie();
    if (gameState.grid !== grid && gridLetterFingerprint(gameState.grid) !== fp) return;
    gameState.cellToWords = buildCellToWords(grid, trie);
    cellToWordsFingerprint = fp;
}

async function generateGrid(): Promise<GridCell[][]> {
    let seed = Date.now();
    let result = await generateGameGrid(seed, gameState.gridWidth, gameState.gridHeight);
    gameState.totalPossibleWords = result.totalPossibleWords;
    gameState.totalPossibleScore = result.totalPossibleScore;
    gameState.cellToWords = result.cellToWords;
    cellToWordsFingerprint = gridLetterFingerprint(result.grid);
    return result.grid;
}

export const gameHistory: GameHistory[] = [];

const initialConfig = isNode() ? { gridWidth: 4, gridHeight: 4, gameDuration: GAME_DURATION, showRemainingWordsPerCell: false, showTotalPossibleScore: false } : getSavedConfigOrDefaults();

export const gameState = observable<GameState>({
    status: "ready",
    grid: [],
    startTime: undefined,
    timeRemaining: initialConfig.gameDuration,
    elapsedTime: 0,
    score: 0,
    matchedWords: [] as MatchedWord[],
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
    showRemainingWordsPerCell: !!initialConfig.showRemainingWordsPerCell,
    showTotalPossibleScore: !!initialConfig.showTotalPossibleScore,
    restartCountdownEnd: 0,
    gameMode: (initialConfig as any).gameMode || DEFAULT_GAME_MODE,
    coopGoalFraction: (initialConfig as any).coopGoalFraction ?? DEFAULT_COOP_GOAL_FRACTION,
    coopInfinite: false,
    peerFlashRequest: undefined,
    lastGameOverState: undefined,
    lastGameOverOnPlayAgain: undefined,
});

export function applySettings(settings: {
    showRemainingWordsPerCell?: boolean;
    showTotalPossibleScore?: boolean;
    gameMode?: GameMode;
    coopGoalFraction?: number;
}) {
    if (settings.showRemainingWordsPerCell !== undefined) {
        gameState.showRemainingWordsPerCell = settings.showRemainingWordsPerCell;
    }
    if (settings.showTotalPossibleScore !== undefined) {
        gameState.showTotalPossibleScore = settings.showTotalPossibleScore;
    }
    if (settings.gameMode !== undefined) {
        gameState.gameMode = settings.gameMode;
    }
    if (settings.coopGoalFraction !== undefined) {
        gameState.coopGoalFraction = Math.max(0.05, Math.min(1, settings.coopGoalFraction));
    }
}

void generateGrid().then(grid => {
    if (!gameState.isChallengeMode) {
        gameState.grid = grid;
    }
});

function tickTimer() {
    if (gameState.status !== "playing") return;
    if (gameState.startTime === undefined) return;
    const elapsed = Date.now() - gameState.startTime;
    gameState.elapsedTime = elapsed;
    if (gameState.gameMode === "cooperative") {
        if (!gameState.isMultiplayer && !gameState.coopInfinite) {
            const goal = Math.max(1, Math.ceil(gameState.totalPossibleScore * gameState.coopGoalFraction));
            if (gameState.score >= goal && gameState.totalPossibleScore > 0) {
                void endGame();
            }
        }
        return;
    }
    gameState.timeRemaining = Math.max(0, gameState.gameDuration - elapsed);
    if (gameState.timeRemaining === 0 && !gameState.isMultiplayer) {
        void endGame();
    }
}

if (!isNode()) {
    window.setInterval(tickTimer, 100);
}

export async function startGame(regenerateGrid = true, duration?: number) {
    if (duration !== undefined) {
        gameState.gameDuration = duration;
    }
    if (regenerateGrid) {
        gameState.grid = await generateGrid();
        gameState.isChallengeMode = false;
        gameState.challengerData = undefined;
    }
    gameState.timeRemaining = gameState.gameDuration;
    gameState.elapsedTime = 0;
    gameState.score = 0;
    gameState.matchedWords = [];
    gameState.lastGameOverState = undefined;
    gameState.lastGameOverOnPlayAgain = undefined;
    gameState.matchedWordsSet.clear();
    gameState.consecutiveWrongWords = 0;
    gameState.timeoutUntil = 0;
    gameState.startTime = Date.now();
    gameState.coopInfinite = false;
    gameState.status = "playing";
}

// Resume a finished cooperative game so the player can keep accumulating
// score past the goal. Preserves the grid, found words, and score; only
// flips status back to "playing" and disables the goal-end check.
export function resumeCoopGame(): void {
    if (gameState.gameMode !== "cooperative") return;
    if (gameState.isMultiplayer) return;
    gameState.coopInfinite = true;
    gameState.status = "playing";
    // Preserve elapsedTime by anchoring startTime relative to now.
    gameState.startTime = Date.now() - gameState.elapsedTime;
    gameState.lastGameOverState = undefined;
    gameState.lastGameOverOnPlayAgain = undefined;
}

export async function endGame() {
    gameState.status = "finished";
    gameState.startTime = undefined;
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

        let coopWinningWord: GameOverState["coopWinningWord"] | undefined;
        if (gameState.gameMode === "cooperative" && gameState.totalPossibleScore > 0) {
            const goal = Math.max(1, Math.ceil(gameState.totalPossibleScore * gameState.coopGoalFraction));
            if (gameState.score >= goal) {
                const last = gameState.matchedWords[gameState.matchedWords.length - 1];
                if (last) {
                    coopWinningWord = { word: last.word, points: last.points, playerIndex: 0 };
                }
            }
        }
        const gameOverState: GameOverState = {
            grid: gameState.grid,
            playerResults,
            totalPossibleScore: gameState.totalPossibleScore,
            totalPossibleWords: gameState.totalPossibleWords,
            coopWinningWord,
        };
        const onPlayAgain = () => { void startGame(); };
        gameState.lastGameOverState = gameOverState;
        gameState.lastGameOverOnPlayAgain = onPlayAgain;
        showGameOver(gameOverState, onPlayAgain);
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
}