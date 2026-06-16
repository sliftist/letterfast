import { observable, reaction, IReactionDisposer } from "mobx";
import { css, isNode } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import * as preact from "preact";
import { Anchor } from "sliftutils/render-utils/Anchor";
import { joinGameIdURL, challengeURL, scoreShowsWordsURL } from "./Page";
import { singleGameURL, encodeSingleGameId, decodeSingleGameId, applySingleGameFromURL, updateSingleGameURL } from "./singlePlayerGames";
import {
    CELL_SIZE,
    CELL_GAP,
    HIT_SIZE,
    GAME_DURATION,
    gameState,
    startGame,
    endGame,
    getCurrentGridSize,
    calculateWordScore,
    calculateWordScoreForGrid,
    cellCenter,
    getCellAt,
    isAdjacent,
    formatTime,
    getWordSet,
    cleanup,
    GridCell,
    changeGridSize,
    applySettings,
    DEFAULT_GAME_MODE,
    DEFAULT_COOP_GOAL_FRACTION,
    LETTER_POINTS,
} from "./GameState";
import { findPathsForWord, findAllWordsInGrid, getWordTrie } from "./GridGenerator";
import { getClientId } from "./ClientId";
import { VoiceController, StreamingWord } from "./VoiceMode";
import { preloadHomophoneDict, getHomophones, findPhoneticMatches } from "./Homophones";
import { getRPCClient, resetRPCClient, setRPCDisconnectHandler } from "./rpcClient";
import { loadSavedConfig, saveConfig } from "./GameConfig";
import { ConnectionManager } from "./ConnectionManager";
import { showGameOver } from "./GameOver";

const DEBUG_MODE = false;
const ENABLE_VIBRATION = true;
const BELOW_GRID_GAP = 12;
const WRONG_WORD_BASE_TIMEOUT = 1000;
const WRONG_WORD_TIMEOUT_INCREMENT = 100;
const MAX_WRONG_WORD_TIMEOUT = 3000;
const CANCEL_ZONE_SIZE = 80;
const TIMEOUT_FADEOUT_DURATION = 300;
// If the user goes silent for at least this long, the next thing they
// say is treated as a new phrase and the prior voice transcript is
// wiped before tokens for the new phrase land.
const VOICE_RESET_GAP_MS = 1000;
const PEER_FLASH_STAGGER_MS = 100;
const PEER_FLASH_DURATION_MS = 500;
const ACCEPTED_CELL_FLASH_MS = 700;
// How long the score-bar segment of the player who already found your word glows.
const PLAYER_HIGHLIGHT_DURATION_MS = 1500;
const WORD_REVEAL_DURATION_MS = 700;
const SCORE_PULSE_DURATION_MS = 600;
const DEMO_WORD_LENGTH = 3;
const DEMO_STEP_MS = 380;
const DEMO_HOLD_MS = 900;
const DEMO_GAP_MS = 600;
const DEMO_IDLE_RECHECK_MS = 1000;
const DEMO_FINISHED_TOP_N = 20;
// Post-game demo: the whole word is shown at once (not traced letter-by-letter) and held this long before moving to the next.
const DEMO_FINISHED_HOLD_MS = 3850;

function randomGameCode(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let s = "";
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

const MARGIN_EMPTY_SIDE = 10;
const BOTTOM_HEIGHT_FRACTION = 0.2;
const SECTION_GAP = 12;
function lineIntersectsCell(
    lineStart: { x: number; y: number },
    lineEnd: { x: number; y: number },
    row: number,
    col: number
): boolean {
    const center = cellCenter(row, col);
    const radius = HIT_SIZE / 2;

    const checkPoint = (x: number, y: number): boolean => {
        const dx = x - center.x;
        const dy = y - center.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        return distance <= radius;
    };

    if (checkPoint(lineStart.x, lineStart.y)) return true;
    if (checkPoint(lineEnd.x, lineEnd.y)) return true;

    const steps = 20;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = lineStart.x + (lineEnd.x - lineStart.x) * t;
        const y = lineStart.y + (lineEnd.y - lineStart.y) * t;
        if (checkPoint(x, y)) {
            return true;
        }
    }

    return false;
}

function getCellsAlongLine(
    lineStart: { x: number; y: number },
    lineEnd: { x: number; y: number },
    gridSize: { width: number; height: number }
): { row: number; col: number; distance: number }[] {
    const cells: { row: number; col: number; distance: number }[] = [];

    for (let row = 0; row < gridSize.height; row++) {
        for (let col = 0; col < gridSize.width; col++) {
            if (lineIntersectsCell(lineStart, lineEnd, row, col)) {
                const center = cellCenter(row, col);
                const dx = center.x - lineStart.x;
                const dy = center.y - lineStart.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                cells.push({ row, col, distance });
            }
        }
    }

    cells.sort((a, b) => a.distance - b.distance);

    return cells;
}

function redrawCanvas(
    canvas: HTMLCanvasElement,
    selectedCells: { row: number; col: number }[],
    currentPos: { x: number; y: number } | undefined,
    debugPositions: { x: number; y: number }[],
    gridSize: { width: number; height: number },
    demoCells: { row: number; col: number }[],
) {
    let ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (demoCells.length >= 2) {
        ctx.save();
        ctx.strokeStyle = "rgba(0, 212, 255, 0.35)";
        ctx.lineWidth = 5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.shadowBlur = 10;
        ctx.shadowColor = "rgba(0, 212, 255, 0.25)";
        ctx.beginPath();
        const dFirst = cellCenter(demoCells[0].row, demoCells[0].col);
        ctx.moveTo(dFirst.x, dFirst.y);
        for (let i = 1; i < demoCells.length; i++) {
            const c = cellCenter(demoCells[i].row, demoCells[i].col);
            ctx.lineTo(c.x, c.y);
        }
        ctx.stroke();
        ctx.restore();
    }

    if (DEBUG_MODE) {
        for (let row = 0; row < gridSize.height; row++) {
            for (let col = 0; col < gridSize.width; col++) {
                let center = cellCenter(row, col);
                ctx.strokeStyle = "rgba(255, 255, 0, 0.3)";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(center.x, center.y, HIT_SIZE / 2, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        ctx.fillStyle = "rgba(255, 0, 0, 0.5)";
        for (let pos of debugPositions) {
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    if (selectedCells.length === 0) return;
    ctx.strokeStyle = "rgba(0, 212, 255, 0.8)";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowBlur = 10;
    ctx.shadowColor = "rgba(0, 212, 255, 0.6)";
    ctx.beginPath();
    let first = cellCenter(selectedCells[0].row, selectedCells[0].col);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < selectedCells.length; i++) {
        let c = cellCenter(selectedCells[i].row, selectedCells[i].col);
        ctx.lineTo(c.x, c.y);
    }
    if (currentPos) ctx.lineTo(currentPos.x, currentPos.y);
    ctx.stroke();
}

// Collects every unique `length`-letter dictionary word path on the grid.
// Used by the idle-board demo to pick something short to trace as a hint.
function findShortWordPaths(grid: GridCell[][], length: number, wordSet: Set<string>): { row: number; col: number }[][] {
    const out: { row: number; col: number }[][] = [];
    const seenWords = new Set<string>();
    const h = grid.length;
    const w = grid[0]?.length ?? 0;
    const path: { row: number; col: number }[] = [];
    const visited = new Set<string>();
    let letters = "";
    function dfs() {
        if (path.length === length) {
            const lower = letters.toLowerCase();
            if (!seenWords.has(lower) && wordSet.has(lower)) {
                seenWords.add(lower);
                out.push(path.slice());
            }
            return;
        }
        const last = path[path.length - 1];
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = last.row + dr;
                const nc = last.col + dc;
                if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
                const k = `${nr},${nc}`;
                if (visited.has(k)) continue;
                visited.add(k);
                path.push({ row: nr, col: nc });
                letters += grid[nr][nc].letter;
                dfs();
                letters = letters.slice(0, -1);
                path.pop();
                visited.delete(k);
            }
        }
    }
    for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
            const k = `${r},${c}`;
            visited.add(k);
            path.push({ row: r, col: c });
            letters = grid[r][c].letter;
            dfs();
            letters = "";
            path.pop();
            visited.delete(k);
        }
    }
    return out;
}

// Returns the highest-scoring path on the grid that spells the given letter
// sequence, or undefined if no valid path exists. Used by both keyboard typing
// and (potentially) drag rerouting so we don't fork the pathing logic.
function findBestPathForLetters(grid: GridCell[][], letters: string): { row: number; col: number }[] | undefined {
    if (letters.length === 0) return undefined;
    const paths = findPathsForWord(grid, letters);
    if (paths.length === 0) return undefined;
    let best = paths[0];
    let bestScore = calculateWordScoreForGrid(grid, best);
    for (let i = 1; i < paths.length; i++) {
        const s = calculateWordScoreForGrid(grid, paths[i]);
        if (s > bestScore) { bestScore = s; best = paths[i]; }
    }
    return best;
}

type VoiceTokenStatus = "pending" | "ok" | "not-word" | "not-on-board" | "already" | "skipped";
interface VoiceToken {
    word: string;
    status: VoiceTokenStatus;
    points?: number;
}

type AttemptResult =
    | { status: "not-word" }
    | { status: "not-on-board" }
    | { status: "already" }
    | { status: "ok"; word: string; bestPath: { row: number; col: number }[]; bestScore: number };

interface FloatingScore {
    id: number;
    points: number;
    timestamp: number;
}

@observer
export class LetterFastGame extends preact.Component {
    canvas: HTMLCanvasElement | undefined;
    wrapper: HTMLDivElement | undefined;
    floatingScoreId = 0;

    synced = observable({
        drawing: false,
        currentPos: undefined as { x: number; y: number } | undefined,
        selectedCells: [] as { row: number; col: number }[],
        pulseCells: [] as { row: number; col: number }[],
        demoCells: [] as { row: number; col: number }[],
        demoFilterCell: undefined as { row: number; col: number } | undefined,
        acceptedCells: [] as { row: number; col: number }[],
        recentAcceptedWord: undefined as string | undefined,
        recentAcceptedToken: 0,
        scorePulseId: 0,
        floatingScores: [] as FloatingScore[],
        scale: 1,
        totalWidth: 0,
        totalHeight: 0,
        debugPositions: [] as { x: number; y: number }[],
        isFullscreen: false,
        showCancelZone: false,
        isOverCancelZone: false,
        showTimeoutMessage: false,
        timeoutMessage: "",
        timeoutWord: "",
        timeoutStartedAt: 0,
        timeoutTotalMs: 0,
        timeoutFadingOut: false,
        wrongWordCells: [] as { row: number; col: number }[],
        linkCopied: false,
        isConverting: false,
        reconnectCountdown: 0,
        menuOpen: false,
        cfgWidth: 4,
        cfgHeight: 4,
        cfgDuration: 90000,
        cfgDurationStr: "90",
        cfgShowRemaining: false,
        cfgShowTotal: false,
        cfgAutoBestPath: true,
        cfgGameMode: DEFAULT_GAME_MODE as "competitive" | "cooperative" | "competitive-shared",
        cfgCoopGoalPct: Math.round(DEFAULT_COOP_GOAL_FRACTION * 100),
        cfgCoopGoalPctStr: String(Math.round(DEFAULT_COOP_GOAL_FRACTION * 100)),
        joinGameId: randomGameCode(),
        joining: false,
        menuError: undefined as string | undefined,
        joinPopupOpen: false,
        joinPopupBackdropDown: false,
        menuBackdropDown: false,
        confirmNewMp: false,
        peerFlashCells: [] as { row: number; col: number; id: number }[],
        blockedFlashCells: [] as { row: number; col: number; id: number }[],
        alreadyFlashCells: [] as { row: number; col: number; id: number }[],
        highlightPlayerIndex: undefined as number | undefined,
        highlightPlayerToken: 0,
        voiceModeOn: false,
        voiceLoading: false,
        voiceStatus: undefined as string | undefined,
        voiceError: undefined as string | undefined,
        voiceTranscriptText: "" as string,
        voiceTranscriptListening: false,
        voiceTokens: [] as VoiceToken[],
        boardImportError: undefined as string | undefined,
        boardImportCopied: false,
    });

    boardTextareaRef: HTMLTextAreaElement | undefined;

    connectionManager: ConnectionManager | undefined;

    // Returning to a backgrounded tab/app is the main way sockets die — reconnect immediately instead of waiting out the retry timer.
    onVisibilityReconnect = () => {
        if (document.visibilityState !== "visible") return;
        if (!gameState.isMultiplayer) return;
        if (!this.connectionManager) return;
        if (gameState.connectionStatus === "connected") return;
        void this.connectionManager.connect();
    };
    reconnectCountdownInterval: number | undefined;
    gridSizeReactionDisposer: IReactionDisposer | undefined;
    peerFlashReactionDisposer: IReactionDisposer | undefined;
    peerFlashIdSeq = 0;

    runPeerFlash = (cells: { row: number; col: number }[]) => {
        cells.forEach((cell, i) => {
            const id = ++this.peerFlashIdSeq;
            setTimeout(() => {
                this.synced.peerFlashCells.push({ row: cell.row, col: cell.col, id });
                setTimeout(() => {
                    this.synced.peerFlashCells = this.synced.peerFlashCells.filter(c => c.id !== id);
                }, PEER_FLASH_DURATION_MS);
            }, i * PEER_FLASH_STAGGER_MS);
        });
    };

    flashBlockedCells = (cells: { row: number; col: number }[]) => {
        // Red outline flash on the cells the user just drew, signaling
        // "this word was already taken by someone else."
        cells.forEach((cell) => {
            const id = ++this.peerFlashIdSeq;
            this.synced.blockedFlashCells.push({ row: cell.row, col: cell.col, id });
            setTimeout(() => {
                this.synced.blockedFlashCells = this.synced.blockedFlashCells.filter(c => c.id !== id);
            }, 800);
        });
    };

    flashAlreadyFoundCells = (cells: { row: number; col: number }[]) => {
        // Amber flash on the traced cells — valid word, but it's already in
        // the found list. Same shape as the accepted flash so it reads as
        // "good trace", just a different color.
        cells.forEach((cell) => {
            const id = ++this.peerFlashIdSeq;
            this.synced.alreadyFlashCells.push({ row: cell.row, col: cell.col, id });
            setTimeout(() => {
                this.synced.alreadyFlashCells = this.synced.alreadyFlashCells.filter(c => c.id !== id);
            }, 800);
        });
        this.vibrate();
    };

    preventGlobalTouch = (e: TouchEvent) => {
        if (e.touches.length > 1) {
            e.preventDefault();
        }
    };

    vibrate() {
        if (ENABLE_VIBRATION && !isNode() && "vibrate" in navigator) {
            navigator.vibrate(50);
        }
    }

    vibrateLong() {
        if (ENABLE_VIBRATION && !isNode() && "vibrate" in navigator) {
            navigator.vibrate(400);
        }
    }

    calculateScale = () => {
        if (isNode()) return;

        const gridSize = getCurrentGridSize();
        const gridNaturalWidth = CELL_SIZE * gridSize.width + CELL_GAP * (gridSize.width - 1);
        const gridNaturalHeight = CELL_SIZE * gridSize.height + CELL_GAP * (gridSize.height - 1);

        this.synced.totalWidth = gridNaturalWidth;
        this.synced.totalHeight = gridNaturalHeight;

        const containerW = this.midElem ? this.midElem.clientWidth : window.innerWidth;
        const containerH = this.midElem ? this.midElem.clientHeight : 0;
        if (containerW <= 0 || containerH <= 0) return;

        const availableWidth = containerW - BELOW_GRID_GAP;
        const availableHeight = containerH - BELOW_GRID_GAP;

        const scaleWidth = availableWidth / gridNaturalWidth;
        const scaleHeight = availableHeight / gridNaturalHeight;
        const scaleFactor = Math.min(scaleWidth, scaleHeight);

        this.synced.scale = Math.max(0.3, scaleFactor);
    };

    midResizeObserver: ResizeObserver | undefined;
    midElem: HTMLDivElement | undefined;

    setMidRef = (elem: HTMLDivElement | null) => {
        if (!elem) return;
        if (this.midElem === elem) return;
        this.midElem = elem;
        if (this.midResizeObserver) this.midResizeObserver.disconnect();
        if (typeof ResizeObserver === "undefined") {
            this.calculateScale();
            return;
        }
        this.midResizeObserver = new ResizeObserver(() => {
            this.calculateScale();
        });
        this.midResizeObserver.observe(elem);
    };

    tryStartGameAsHost = async (options?: { autoStart?: boolean }) => {
        if (!gameState.isMultiplayer) return;
        if (!gameState.gameId) return;
        if (gameState.myPlayerIndex !== gameState.hostPlayerIndex) return;
        if (gameState.status === "playing") return;
        // Auto-start (fired on connect) must only kick off a genuinely fresh game. Joining a game that already has results ("finished") must not silently regenerate the board — that looks like a reset. Manual starts (no autoStart flag) still restart a finished game on purpose.
        if (options?.autoStart && gameState.status !== "waiting") return;
        try {
            const rpc = getRPCClient();
            await (rpc as any).updateGameSettings(
                gameState.gameId,
                this.synced.cfgWidth,
                this.synced.cfgHeight,
                this.synced.cfgDuration,
                this.synced.cfgShowRemaining,
                this.synced.cfgShowTotal,
                this.synced.cfgGameMode,
                this.synced.cfgCoopGoalPct / 100,
            );
            await rpc.startGame(gameState.gameId);
        } catch (error) {
            console.error("Failed to start multiplayer game:", error);
        }
    };

    connectToMultiplayer = async (code: string, options?: { autoStartAsHost?: boolean }) => {
        if (isNode()) return;
        const autoStartAsHost = options?.autoStartAsHost ?? false;

        if (this.connectionManager) {
            this.connectionManager.cleanup();
            this.connectionManager = undefined;
        }

        gameState.isMultiplayer = true;
        gameState.gameId = code;
        joinGameIdURL.value = code;
        // A multiplayer game owns the board now — drop any single-player game id so a refresh rejoins the multiplayer game instead of restoring the old solo board.
        singleGameURL.reset();
        const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?page=game&join=${code}`;
        window.history.pushState({}, "", newUrl);

        // A dead websocket fires this through rpcClient (guarded to the current instance), which schedules a reconnect; reconnecting re-joins the game and the server's join snapshot fully resyncs state, so a dropped connection can't leave a zombie game.
        setRPCDisconnectHandler(() => {
            this.connectionManager?.handleDisconnect();
        });
        document.removeEventListener("visibilitychange", this.onVisibilityReconnect);
        document.addEventListener("visibilitychange", this.onVisibilityReconnect);
        this.connectionManager = new ConnectionManager({
            connect: async () => {
                resetRPCClient();
                const newRpc = getRPCClient();
                await newRpc.joinGame(code, gameState.gridWidth, gameState.gridHeight, gameState.gameDuration, getClientId());
            },
            disconnect: () => {
                resetRPCClient();
            },
            callbacks: {
                onStatusChange: (status) => {
                    gameState.connectionStatus = status;
                    if (status === "disconnected" || status === "error") {
                        this.startReconnectCountdown();
                    } else {
                        this.stopReconnectCountdown();
                    }
                },
                onConnect: () => {
                    if (!autoStartAsHost) return;
                    setTimeout(() => { void this.tryStartGameAsHost({ autoStart: true }); }, 250);
                },
            }
        });
        await this.connectionManager.connect();
    };

    startOrJoinMultiplayer = async () => {
        if (isNode()) return;
        this.synced.isConverting = true;
        this.synced.joining = true;
        this.synced.menuError = undefined;
        try {
            if (gameState.isMultiplayer && gameState.gameId && gameState.status === "playing") {
                // Already mid-game: the current room can't be restarted while playing, so break off into a brand new game with a fresh id (the old game persists for anyone still in it).
                await this.connectToMultiplayer(randomGameCode(), { autoStartAsHost: true });
            } else if (!gameState.isMultiplayer || !gameState.gameId) {
                const code = (this.synced.joinGameId || randomGameCode()).toUpperCase();
                await this.connectToMultiplayer(code, { autoStartAsHost: true });
            } else {
                await this.tryStartGameAsHost();
            }
        } finally {
            this.synced.isConverting = false;
            this.synced.joining = false;
        }
    };


    enterTestMode = () => {
        gameState.isMultiplayer = true;
        gameState.gameId = "TEST01";
        gameState.connectionStatus = "connected";
        gameState.myPlayerIndex = 1;
        gameState.players = [
            { id: "alice", score: 142 },
            { id: "self", score: 87 },
            { id: "carol", score: 56 },
            { id: "dave", score: 23 },
        ];
        gameState.status = "playing";
        gameState.score = 87;
        gameState.timeRemaining = 42000;
        gameState.gameDuration = 90000;
        gameState.totalPossibleScore = 500;
        gameState.totalPossibleWords = 80;
        gameState.showTotalPossibleScore = true;
        gameState.showRemainingWordsPerCell = true;
        gameState.matchedWords = [
            { word: "HELLO", points: 8 },
            { word: "WORLD", points: 9 },
            { word: "TEST", points: 4 },
            { word: "MODE", points: 7 },
            { word: "GAME", points: 6 },
            { word: "PLAY", points: 9 },
            { word: "WORD", points: 8 },
            { word: "FAST", points: 7 },
            { word: "QUICK", points: 19 },
            { word: "JUMP", points: 13 },
            { word: "BRAIN", points: 7 },
            { word: "PUZZLE", points: 19 },
        ];
        gameState.matchedWordsSet = new Set(gameState.matchedWords.map(w => w.word));

        const gridSize = getCurrentGridSize();
        const cells: { row: number; col: number }[] = [];
        const sampleLetters = ["T", "E", "S", "T"];
        for (let i = 0; i < sampleLetters.length && i < gridSize.width; i++) {
            cells.push({ row: 0, col: i });
            if (gameState.grid[0] && gameState.grid[0][i]) {
                gameState.grid[0][i] = {
                    ...gameState.grid[0][i],
                    letter: sampleLetters[i],
                };
            }
        }
        if (gameState.grid[0] && gameState.grid[0][0]) {
            gameState.grid[0][0] = { ...gameState.grid[0][0], multiplier: 2 };
        }
        if (gameState.grid[1] && gameState.grid[1][1]) {
            gameState.grid[1][1] = { ...gameState.grid[1][1], multiplier: 3 };
        }
        this.synced.selectedCells = cells;
        this.synced.drawing = true;
        this.synced.showCancelZone = true;
        this.synced.currentPos = cellCenter(0, Math.min(sampleLetters.length, gridSize.width) - 1);

        this.synced.pulseCells = [{ row: 0, col: 0 }, { row: 0, col: 1 }];
        const scoreId = this.floatingScoreId++;
        this.synced.floatingScores.push({ id: scoreId, points: 12, timestamp: Date.now() });

        this.synced.showTimeoutMessage = true;
        this.synced.timeoutMessage = "Not a word!";
        this.synced.timeoutWord = "SAMPLE";
        this.synced.timeoutStartedAt = Date.now();
        this.synced.timeoutTotalMs = 5000;
        this.synced.wrongWordCells = [{ row: 1, col: 0 }, { row: 1, col: 1 }];
        gameState.timeoutUntil = Date.now() + 5000;

        this.synced.linkCopied = true;

        this.redraw();
    };

    voiceController: VoiceController | undefined;
    voiceQueue: { token: VoiceToken; tokensRef: VoiceToken[] }[] = [];
    voiceProcessing = false;
    voiceAnimating = false;
    // Index in voiceTokens where the *current* utterance's positional
    // tokens start. Tokens before this index are from past utterances
    // and are frozen. Tokens at/after this index mirror the current
    // partial transcript by position — when the model revises a word,
    // we replace the token at the matching index (and undo its play
    // if it had one). When vosk commits the utterance, we just bump
    // this index forward.
    voiceUtteranceStartIndex = 0;
    // Wall-clock time of the last speech-end event. When the next
    // speech-start fires, if the gap exceeds VOICE_RESET_GAP_MS we
    // treat that as a brand-new phrase and wipe the prior tokens.
    // Below the threshold, prior tokens stay so a quick breath in the
    // middle of a sentence doesn't reset the whole transcript.
    voiceLastSpeechEndAt = 0;
    // Letters from words committed so far in the current speech session,
    // and from the in-flight partial. Substring-matched against every
    // playable board word so users can spell letters, recover from ASR
    // splits, and get all sub-word matches in one breath ("vahamin" →
    // HAM, HAMIN, AMIN, …). These extra plays are append-only and are
    // not undone when the partial revises.
    voiceCommittedLetters = "";
    voicePartialLetters = "";

    toggleVoiceMode = () => {
        if (this.synced.voiceModeOn || this.synced.voiceLoading) {
            void this.stopVoiceMode();
        } else {
            void this.startVoiceMode();
        }
    };

    startVoiceMode = async () => {
        console.log("[voice] startVoiceMode requested");
        if (isNode()) return;
        if (this.synced.voiceModeOn || this.synced.voiceLoading) {
            console.log("[voice] start ignored: already on/loading");
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this.synced.voiceError = "Microphone is not available in this browser.";
            return;
        }
        this.synced.voiceError = undefined;
        this.synced.voiceLoading = true;
        this.synced.voiceStatus = "Loading…";
        this.synced.voiceTranscriptText = "";
        this.synced.voiceTranscriptListening = false;
        this.synced.voiceTokens = [];
        this.voiceQueue = [];

        if (!this.voiceController) this.voiceController = new VoiceController();

        // Kick off the CMU dictionary fetch in parallel with model loading so
        // homophone lookups are ready by the time the user starts speaking.
        void preloadHomophoneDict().catch(() => { /* logged inside */ });

        try {
            await this.voiceController.start({
                onSpeechStart: () => this.handleVoiceSpeechStart(),
                onPartialTranscript: (text: string) => this.handleVoicePartial(text),
                onCommittedWord: (word: StreamingWord) => this.handleVoiceCommittedWord(word),
                onSpeechEnd: () => this.handleVoiceSpeechEnd(),
                onStatus: (status: string) => {
                    console.log("[voice] status:", status);
                    this.synced.voiceStatus = status;
                },
                onError: (err: string) => {
                    console.warn("[voice] error from controller:", err);
                    this.synced.voiceError = err;
                },
            });
            this.synced.voiceModeOn = true;
            this.synced.voiceLoading = false;
            console.log("[voice] startVoiceMode succeeded");
        } catch (e) {
            console.error("[voice] startVoiceMode failed:", e);
            this.synced.voiceLoading = false;
            this.synced.voiceModeOn = false;
            if (!this.synced.voiceError) {
                this.synced.voiceError = e instanceof Error ? e.message : String(e);
            }
        }
    };

    stopVoiceMode = async () => {
        console.log("[voice] stopVoiceMode requested");
        this.synced.voiceModeOn = false;
        this.synced.voiceLoading = false;
        this.synced.voiceStatus = undefined;
        this.synced.voiceTranscriptText = "";
        this.synced.voiceTranscriptListening = false;
        this.synced.voiceTokens = [];
        this.voiceUtteranceStartIndex = 0;
        this.voiceQueue = [];
        this.voiceCommittedLetters = "";
        this.voicePartialLetters = "";
        if (this.voiceController) {
            try {
                this.voiceController.stop();
            } catch (e) {
                console.error("[voice] stop threw:", e);
            }
        }
    };

    private handleVoiceSpeechStart = () => {
        this.synced.voiceTranscriptListening = true;
        this.synced.voiceTranscriptText = "";
        // If the user paused for ≥ VOICE_RESET_GAP_MS, treat this as a
        // fresh phrase and wipe the prior token list. Anything shorter
        // (a quick breath, a brief hesitation) keeps the prior tokens
        // so they accumulate into the same phrase. NB: the very first
        // speech start has voiceLastSpeechEndAt === 0, in which case we
        // skip the reset and preserve the empty initial state.
        if (this.voiceLastSpeechEndAt > 0) {
            const gap = Date.now() - this.voiceLastSpeechEndAt;
            if (gap >= VOICE_RESET_GAP_MS) {
                console.log(`[voice] ${gap}ms gap since last speech — clearing prior tokens`);
                this.synced.voiceTokens = [];
            }
        }
        this.voiceUtteranceStartIndex = this.synced.voiceTokens.length;
        this.voiceCommittedLetters = "";
        this.voicePartialLetters = "";
    };

    private handleVoiceSpeechEnd = () => {
        // Lock the current utterance's tokens in place — the next
        // utterance's positional region starts after them.
        this.synced.voiceTranscriptListening = false;
        this.voiceUtteranceStartIndex = this.synced.voiceTokens.length;
        this.voiceLastSpeechEndAt = Date.now();
        this.voiceCommittedLetters = "";
        this.voicePartialLetters = "";
    };

    private handleVoicePartial = (text: string) => {
        // Mirror the partial's words into the positional region. When the
        // model revises a word at position i, we replace the token at
        // index `start + i` and undo any play that token had — so
        // "cat" becoming "cap" doesn't leave both as tokens.
        this.synced.voiceTranscriptListening = false;
        const newWords = (text || "").toLowerCase().split(/[^a-z]+/).filter(w => w.length > 0);
        const tokens = this.synced.voiceTokens;
        const start = this.voiceUtteranceStartIndex;

        // Trim any trailing positional tokens that no longer have a
        // counterpart in the new partial (the partial got shorter or a
        // word was removed). Pop from the end so indices stay stable.
        while (tokens.length > start + newWords.length) {
            const removed = tokens.pop();
            if (removed) this.undoTokenPlay(removed);
        }

        // Replace / insert each position.
        for (let i = 0; i < newWords.length; i++) {
            const idx = start + i;
            const newWord = newWords[i];
            const oldTok = tokens[idx];
            if (oldTok && oldTok.word === newWord) continue;
            if (oldTok) this.undoTokenPlay(oldTok);
            const token: VoiceToken = {
                word: newWord,
                status: newWord.length < 3 ? "not-word" : "pending",
            };
            if (idx < tokens.length) tokens[idx] = token;
            else tokens.push(token);
            if (token.status === "pending") {
                this.voiceQueue.push({ token, tokensRef: tokens });
                void this.flushVoiceQueue();
            }
        }

        this.voicePartialLetters = (text || "").toLowerCase().replace(/[^a-z]+/g, "");
        void this.checkLetterBuffer();
    };

    /** Undo the on-board play attached to a token that's about to be
     *  replaced (because the model revised what it heard at this
     *  position). For singleplayer we remove the matched word and
     *  refund points. For multiplayer we can only emit a warning —
     *  the server already accepted the word and there's no withdraw
     *  RPC. */
    private undoTokenPlay = (token: VoiceToken) => {
        if (token.status !== "ok") return;
        const upper = token.word.toUpperCase();
        if (!gameState.matchedWordsSet.has(upper)) return;
        if (gameState.isMultiplayer) {
            console.warn("[voice] partial revised away from played word; can't undo on server:", token.word);
            return;
        }
        const idx = gameState.matchedWords.findIndex(w => w.word === upper);
        if (idx !== -1) gameState.matchedWords.splice(idx, 1);
        gameState.matchedWordsSet.delete(upper);
        gameState.score = Math.max(0, gameState.score - (token.points ?? 0));
        console.log(`[voice] undid play of ${token.word} (refunded ${token.points ?? 0})`);
    };

    private handleVoiceCommittedWord = (word: StreamingWord) => {
        const cleaned = (word.word || "").toLowerCase().replace(/[^a-z]+/g, "");
        if (!cleaned) return;
        console.log("[voice] committed:", cleaned);
        // The committed word is already represented in the positional
        // region by the most recent partial (vosk's commit text matches
        // its final partial). Just roll the letters forward.
        this.voiceCommittedLetters = (this.voiceCommittedLetters + cleaned).slice(-128);
        this.voicePartialLetters = "";
        void this.checkLetterBuffer();
    };

    /** Substring-match every playable word on the board against the
     *  running letter buffer (committed letters + the live partial),
     *  playing each match exactly once. Runs on every partial update,
     *  not just on commit, so reactions happen mid-utterance. Plays
     *  every match — if the user says "vahamin" we get HAM, HAMIN,
     *  AMIN, etc. (whichever are real words on the board).
     *
     *  Letter-buffer matches are inserted as "frozen extras" at the
     *  *start* of the current utterance's region, and the positional
     *  start index is bumped past them, so subsequent partial updates
     *  don't try to trim or revise them. */
    private checkLetterBuffer = async () => {
        if (gameState.status !== "playing") return;
        const buf = this.voiceCommittedLetters + this.voicePartialLetters;
        if (buf.length < 3) return;
        const wordSet = await getWordSet();
        const boardWords = this.collectBoardWords();
        // Sorting by length only affects the order plays happen in;
        // every matching word still plays exactly once thanks to
        // matchedWordsSet. Longer first feels more natural visually.
        boardWords.sort((a, b) => b.length - a.length);
        for (const cand of boardWords) {
            if (cand.length < 3) continue;
            if (gameState.matchedWordsSet.has(cand.toUpperCase())) continue;
            if (!buf.includes(cand)) continue;
            const r = await this.attemptWord(cand, wordSet);
            if (r.status !== "ok") continue;
            console.log(`[voice] letter-buffer match: ${cand} found in "${buf}"`);
            const tokens = this.synced.voiceTokens;
            const tok: VoiceToken = { word: cand, status: "pending" };
            tokens.splice(this.voiceUtteranceStartIndex, 0, tok);
            this.voiceUtteranceStartIndex++;
            this.voiceQueue.push({ token: tok, tokensRef: tokens });
            void this.flushVoiceQueue();
        }
    };

    private updateVoiceToken = (
        tokensRef: VoiceToken[],
        token: VoiceToken,
        status: VoiceTokenStatus,
        points?: number,
    ): VoiceToken => {
        // Only mutate if these tokens are still the current ones — if the
        // user has started a new utterance, voiceTokens has been replaced
        // with a fresh array and we should leave the orphaned one alone.
        if (this.synced.voiceTokens !== tokensRef) return token;
        const idx = tokensRef.indexOf(token);
        if (idx === -1) return token;
        const next = { ...token, status, points };
        tokensRef[idx] = next;
        return next;
    };

    private replaceVoiceTokenWord = (
        tokensRef: VoiceToken[],
        token: VoiceToken,
        newWord: string,
    ): VoiceToken => {
        if (this.synced.voiceTokens !== tokensRef) return token;
        const idx = tokensRef.indexOf(token);
        if (idx === -1) return token;
        const next = { ...token, word: newWord };
        tokensRef[idx] = next;
        return next;
    };

    private disposeVoiceRecognition = () => {
        console.log("[voice] disposeVoiceRecognition");
        if (this.voiceController) {
            try { this.voiceController.stop(); } catch (e) { console.warn("[voice] dispose stop failed:", e); }
            this.voiceController = undefined;
        }
    };

    private flushVoiceQueue = async () => {
        if (this.voiceProcessing) return;
        this.voiceProcessing = true;
        try {
            while (this.voiceQueue.length > 0) {
                const item = this.voiceQueue.shift()!;
                await this.tryVoiceWord(item.token, item.tokensRef);
            }
        } finally {
            this.voiceProcessing = false;
        }
    };

    private collectBoardWords(): string[] {
        const out: string[] = [];
        const seen = new Set<string>();
        for (const set of gameState.cellToWords.values()) {
            for (const w of set) {
                const lower = w.toLowerCase();
                if (seen.has(lower)) continue;
                seen.add(lower);
                out.push(lower);
            }
        }
        return out;
    }

    private attemptWord = async (
        word: string,
        wordSet: Set<string>,
    ): Promise<AttemptResult> => {
        if (word.length < 3) return { status: "not-word" };
        if (!wordSet.has(word.toLowerCase())) return { status: "not-word" };
        const upper = word.toUpperCase();
        const paths = findPathsForWord(gameState.grid, upper);
        if (paths.length === 0) return { status: "not-on-board" };
        if (gameState.matchedWordsSet.has(upper)) return { status: "already" };
        let bestPath = paths[0];
        let bestScore = calculateWordScoreForGrid(gameState.grid, bestPath);
        for (let i = 1; i < paths.length; i++) {
            const score = calculateWordScoreForGrid(gameState.grid, paths[i]);
            if (score > bestScore) { bestScore = score; bestPath = paths[i]; }
        }
        return { status: "ok", word, bestPath, bestScore };
    };

    private tryVoiceWord = async (token: VoiceToken, tokensRef: VoiceToken[]) => {
        let currentToken = token;
        const word = token.word;
        const set = (status: VoiceTokenStatus, points?: number) => {
            currentToken = this.updateVoiceToken(tokensRef, currentToken, status, points);
        };

        if (!this.synced.voiceModeOn) { console.log("[voice] skip", word, "(voice off)"); set("skipped"); return; }
        if (word.length < 3) { set("not-word"); return; }

        const wordSet = await getWordSet();

        // 1. Try the spoken word.
        let trial = await this.attemptWord(word, wordSet);

        // 2. If it didn't work, try homophones. Pick the highest-scoring
        //    matching homophone (e.g. user says "knight", board has "night").
        if (trial.status !== "ok") {
            const homos = await getHomophones(word);
            let best: AttemptResult | undefined;
            for (const homo of homos) {
                const r = await this.attemptWord(homo, wordSet);
                if (r.status === "ok") {
                    if (!best || best.status !== "ok" || r.bestScore > best.bestScore) {
                        best = r;
                    }
                }
            }
            if (best && best.status === "ok") {
                console.log("[voice] homophone match:", word, "→", best.word, "(score", best.bestScore + ")");
                currentToken = this.replaceVoiceTokenWord(tokensRef, currentToken, best.word);
                trial = best;
            }
        }

        // 2b. Still no match — fall back to fuzzy phonetic matching against
        //     the words actually playable on this board. Catches near-rhymes
        //     like "tee"↔"teed" and ASR splits like "diff users"↔"diffusers"
        //     that strict homophone lookup misses.
        if (trial.status !== "ok") {
            const boardWords = this.collectBoardWords();
            const fuzzy = await findPhoneticMatches(word, boardWords, { maxDistanceRatio: 0.4, topN: 6 });
            let best: AttemptResult | undefined;
            for (const f of fuzzy) {
                const r = await this.attemptWord(f, wordSet);
                if (r.status === "ok") {
                    if (!best || best.status !== "ok" || r.bestScore > best.bestScore) {
                        best = r;
                    }
                }
            }
            if (best && best.status === "ok") {
                console.log("[voice] fuzzy match:", word, "→", best.word, "(score", best.bestScore + ")");
                currentToken = this.replaceVoiceTokenWord(tokensRef, currentToken, best.word);
                trial = best;
            }
        }

        if (trial.status !== "ok") {
            console.log("[voice] skip", word, "(" + trial.status + ")");
            set(trial.status);
            return;
        }

        // 3. Auto-start the game on first real word, then re-validate the
        //    chosen word against the (possibly new) grid.
        if (gameState.status !== "playing") {
            const started = await this.autoStartFromVoice(trial.word);
            if (!started) { set("skipped"); return; }
            const reTrial = await this.attemptWord(trial.word, wordSet);
            if (reTrial.status !== "ok") {
                console.log("[voice]", trial.word, "no longer playable after game start (" + reTrial.status + ")");
                set(reTrial.status);
                return;
            }
            trial = reTrial;
        }

        if (this.synced.drawing) { console.log("[voice] skip", trial.word, "(user drawing)"); set("skipped"); return; }
        if (Date.now() < gameState.timeoutUntil) { console.log("[voice] skip", trial.word, "(in timeout)"); set("skipped"); return; }

        console.log("[voice] applying", trial.word, "(score " + trial.bestScore + ")");
        await this.playVoicePath(trial.bestPath);
        set("ok", trial.bestScore);
    };

    private autoStartFromVoice = async (word: string): Promise<boolean> => {
        if (gameState.isMultiplayer) {
            if (!gameState.gameId || gameState.myPlayerIndex !== gameState.hostPlayerIndex) {
                console.log("[voice] cannot auto-start MP game (not host)");
                return false;
            }
            console.log("[voice] auto-starting MP game from word", word);
            try {
                const rpc = getRPCClient();
                await rpc.startGame(gameState.gameId);
            } catch (e) {
                console.error("[voice] failed to start MP game:", e);
                return false;
            }
            // Wait briefly for the server's onGameStart broadcast to land.
            for (let attempt = 0; attempt < 50 && gameState.status !== "playing"; attempt++) {
                await new Promise(r => setTimeout(r, 50));
            }
            if (gameState.status !== "playing") {
                console.warn("[voice] MP game did not transition to 'playing' after start");
                return false;
            }
            return true;
        }
        console.log("[voice] auto-starting SP game from word", word);
        try {
            await startGame(false);
        } catch (e) {
            console.error("[voice] failed to start SP game:", e);
            return false;
        }
        return gameState.status === "playing";
    };

    private playVoicePath = async (path: { row: number; col: number }[]) => {
        this.voiceAnimating = true;
        try {
            this.synced.selectedCells = [];
            this.synced.currentPos = cellCenter(path[0].row, path[0].col);
            for (const cell of path) {
                this.synced.selectedCells.push(cell);
                this.synced.currentPos = cellCenter(cell.row, cell.col);
                this.redraw();
                await new Promise(r => setTimeout(r, 30));
            }
            try {
                await this.processSelectedWord();
            } catch (e) {
                console.error("Voice submit failed:", e);
            }
            await new Promise(r => setTimeout(r, 200));
        } finally {
            this.synced.selectedCells = [];
            this.synced.currentPos = undefined;
            this.redraw();
            this.voiceAnimating = false;
        }
    };

    leaveMultiplayer = () => {
        if (this.connectionManager) {
            this.connectionManager.disconnect();
            this.connectionManager = undefined;
        }

        gameState.isMultiplayer = false;
        gameState.gameId = undefined;
        gameState.myPlayerIndex = undefined;
        gameState.players = [];
        gameState.connectionStatus = "disconnected";
        joinGameIdURL.value = "";

        const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?page=game`;
        window.history.pushState({}, "", newUrl);
    };

    copyTextToClipboard = (text: string): boolean => {
        try {
            if (navigator.clipboard && (window.isSecureContext || location.hostname === "localhost")) {
                void navigator.clipboard.writeText(text);
                return true;
            }
        } catch { /* fall through to textarea fallback */ }
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.readOnly = true;
            ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            ta.setSelectionRange(0, text.length);
            const ok = document.execCommand("copy");
            document.body.removeChild(ta);
            return ok;
        } catch (e) {
            console.error("Clipboard copy failed:", e);
            return false;
        }
    };

    flashCopied = () => {
        this.synced.linkCopied = true;
        setTimeout(() => { this.synced.linkCopied = false; }, 2000);
    };

    copyShareLink = () => {
        if (!gameState.gameId) return;
        const shareUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?page=game&join=${gameState.gameId}`;
        if (this.copyTextToClipboard(shareUrl)) this.flashCopied();
    };

    buildShareUrl = (code: string): string => {
        return `${window.location.protocol}//${window.location.host}${window.location.pathname}?page=game&join=${code}`;
    };

    copyGameCode = () => {
        if (!gameState.gameId) return;
        if (this.copyTextToClipboard(this.buildShareUrl(gameState.gameId))) this.flashCopied();
    };

    startReconnectCountdown = () => {
        this.stopReconnectCountdown();

        const delay = gameState.connectionStatus === "disconnected" ? 5 : 15;
        this.synced.reconnectCountdown = delay;

        this.reconnectCountdownInterval = window.setInterval(() => {
            this.synced.reconnectCountdown--;
            if (this.synced.reconnectCountdown <= 0) {
                this.stopReconnectCountdown();
            }
        }, 1000);
    };

    stopReconnectCountdown = () => {
        if (this.reconnectCountdownInterval !== undefined) {
            clearInterval(this.reconnectCountdownInterval);
            this.reconnectCountdownInterval = undefined;
        }
        this.synced.reconnectCountdown = 0;
    };

    cancelSelection = () => {
        this.synced.drawing = false;
        this.synced.currentPos = undefined;
        this.synced.selectedCells = [];
        this.synced.showCancelZone = false;
        this.synced.isOverCancelZone = false;
        if (DEBUG_MODE) this.synced.debugPositions = [];
        this.redraw();

        if (!isNode()) {
            window.removeEventListener("mousemove", this.onGlobalMouseMove);
            window.removeEventListener("touchmove", this.onGlobalTouchMove, { passive: false } as any);
            window.removeEventListener("mouseup", this.onGlobalMouseUp);
            window.removeEventListener("touchend", this.onGlobalTouchEnd, { passive: false } as any);
        }
    };

    onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && this.synced.drawing) {
            this.cancelSelection();
            return;
        }
        // Desktop keyboard typing: each letter re-paths selectedCells from
        // scratch (matching the existing drag-trace display). Enter submits,
        // Backspace removes a cell, Escape clears. If a typed letter has no
        // valid path, the current selection is submitted immediately.
        const tgt = e.target as HTMLElement | null;
        const tagName = tgt?.tagName;
        if (tagName === "INPUT" || tagName === "TEXTAREA" || tgt?.isContentEditable) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (gameState.status !== "playing") return;
        if (this.synced.menuOpen || this.synced.joinPopupOpen) return;
        if (Date.now() < gameState.timeoutUntil) return;
        if (this.synced.drawing) return;

        if (e.key === "Backspace") {
            if (this.synced.selectedCells.length > 0) {
                this.synced.selectedCells = this.synced.selectedCells.slice(0, -1);
                this.redraw();
                e.preventDefault();
            }
            return;
        }
        if (e.key === "Escape") {
            if (this.synced.selectedCells.length > 0) {
                this.synced.selectedCells = [];
                this.redraw();
                e.preventDefault();
            }
            return;
        }
        if (e.key === "Enter" || e.key === " ") {
            if (this.synced.selectedCells.length >= 3) {
                e.preventDefault();
                void this.submitKeyboardWord();
            }
            return;
        }
        if (e.key.length === 1 && /^[a-zA-Z]$/.test(e.key)) {
            e.preventDefault();
            const current = this.synced.selectedCells
                .map(c => gameState.grid[c.row]?.[c.col]?.letter ?? "")
                .join("");
            const target = (current + e.key).toUpperCase();
            const best = findBestPathForLetters(gameState.grid, target);
            if (best) {
                this.synced.selectedCells = best;
                this.redraw();
            } else if (this.synced.selectedCells.length >= 3) {
                void this.submitKeyboardWord();
            } else {
                this.synced.selectedCells = [];
                this.redraw();
            }
        }
    };

    submitKeyboardWord = async () => {
        await this.processSelectedWord();
        this.synced.selectedCells = [];
        this.redraw();
    };

    onGlobalMouseMove = (e: MouseEvent) => {
        let pos = this.getRelativePos(e);
        this.handleSelectionMove(pos);
    };

    onGlobalTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        if (e.touches.length !== 1) return;
        let touch = e.touches[0];
        let pos = this.getRelativePos(touch);
        this.handleSelectionMove(pos);
    };

    onGlobalMouseUp = async () => {
        await this.handleSelectionEnd();
    };

    onGlobalTouchEnd = async (e: TouchEvent) => {
        e.preventDefault();
        await this.handleSelectionEnd();
    };

    loadMenuConfig = () => {
        const saved = loadSavedConfig();
        if (saved) {
            this.synced.cfgWidth = saved.gridWidth;
            this.synced.cfgHeight = saved.gridHeight;
            this.synced.cfgDuration = saved.gameDuration;
            this.synced.cfgShowRemaining = !!saved.showRemainingWordsPerCell;
            this.synced.cfgShowTotal = !!saved.showTotalPossibleScore;
            this.synced.cfgGameMode = saved.gameMode === "cooperative" || saved.gameMode === "competitive-shared"
                ? saved.gameMode
                : "competitive";
            this.synced.cfgCoopGoalPct = Math.round((saved.coopGoalFraction ?? DEFAULT_COOP_GOAL_FRACTION) * 100);
            this.synced.cfgAutoBestPath = saved.autoBestPath !== false;
        } else {
            this.synced.cfgWidth = gameState.gridWidth;
            this.synced.cfgHeight = gameState.gridHeight;
            this.synced.cfgDuration = gameState.gameDuration;
        }
        this.synced.cfgDurationStr = String(Math.round(this.synced.cfgDuration / 1000));
        this.synced.cfgCoopGoalPctStr = String(this.synced.cfgCoopGoalPct);
        applySettings({
            gameMode: this.synced.cfgGameMode,
            coopGoalFraction: this.synced.cfgCoopGoalPct / 100,
        });
    };

    saveMenuConfig = () => {
        saveConfig({
            gridWidth: this.synced.cfgWidth,
            gridHeight: this.synced.cfgHeight,
            gameDuration: this.synced.cfgDuration,
            showRemainingWordsPerCell: this.synced.cfgShowRemaining,
            showTotalPossibleScore: this.synced.cfgShowTotal,
            gameMode: this.synced.cfgGameMode,
            coopGoalFraction: this.synced.cfgCoopGoalPct / 100,
            autoBestPath: this.synced.cfgAutoBestPath,
        });
        applySettings({
            showRemainingWordsPerCell: this.synced.cfgShowRemaining,
            showTotalPossibleScore: this.synced.cfgShowTotal,
            gameMode: this.synced.cfgGameMode,
            coopGoalFraction: this.synced.cfgCoopGoalPct / 100,
        });
        if (gameState.isMultiplayer && gameState.gameId && gameState.myPlayerIndex === gameState.hostPlayerIndex) {
            void (async () => {
                try {
                    const rpc = getRPCClient();
                    await (rpc as any).updateGameSettings(
                        gameState.gameId!,
                        this.synced.cfgWidth,
                        this.synced.cfgHeight,
                        this.synced.cfgDuration,
                        this.synced.cfgShowRemaining,
                        this.synced.cfgShowTotal,
                        this.synced.cfgGameMode,
                        this.synced.cfgCoopGoalPct / 100,
                    );
                } catch (error) {
                    console.error("Failed to push settings to server:", error);
                }
            })();
        }
    };

    // Starts a fresh single-player game using the menu's configured settings
    // (which the menu keeps == the last configured state). Applies grid size,
    // duration, mode, and goal, then regenerates the board.
    startConfiguredSinglePlayerGame = async () => {
        const w = Math.max(2, Math.min(10, this.synced.cfgWidth));
        const h = Math.max(2, Math.min(10, this.synced.cfgHeight));
        gameState.gridWidth = w;
        gameState.gridHeight = h;
        gameState.gameDuration = this.synced.cfgDuration;
        applySettings({
            showRemainingWordsPerCell: this.synced.cfgShowRemaining,
            showTotalPossibleScore: this.synced.cfgShowTotal,
            gameMode: this.synced.cfgGameMode,
            coopGoalFraction: this.synced.cfgCoopGoalPct / 100,
        });
        await startGame();
    };

    // Loads the menu's editable config (cfg*) from the right source: the
    // CURRENT game's live settings while a game exists, or the saved "last
    // configured state" once the game is over (no current game). Called when
    // the menu opens so it always reflects what it should.
    refreshMenuConfig = () => {
        const saved = loadSavedConfig();
        const hasCurrentGame = gameState.status !== "finished";
        if (hasCurrentGame) {
            this.synced.cfgWidth = gameState.gridWidth;
            this.synced.cfgHeight = gameState.gridHeight;
            this.synced.cfgDuration = gameState.gameDuration;
            this.synced.cfgShowRemaining = gameState.showRemainingWordsPerCell;
            this.synced.cfgShowTotal = gameState.showTotalPossibleScore;
            this.synced.cfgGameMode = gameState.gameMode;
            this.synced.cfgCoopGoalPct = Math.round(gameState.coopGoalFraction * 100);
        } else if (saved) {
            this.synced.cfgWidth = saved.gridWidth;
            this.synced.cfgHeight = saved.gridHeight;
            this.synced.cfgDuration = saved.gameDuration;
            this.synced.cfgShowRemaining = !!saved.showRemainingWordsPerCell;
            this.synced.cfgShowTotal = !!saved.showTotalPossibleScore;
            this.synced.cfgGameMode = saved.gameMode ?? DEFAULT_GAME_MODE;
            this.synced.cfgCoopGoalPct = Math.round((saved.coopGoalFraction ?? DEFAULT_COOP_GOAL_FRACTION) * 100);
        }
        // autoBestPath is a client-side preference, never part of a game's shared state — always from saved prefs.
        this.synced.cfgAutoBestPath = saved ? saved.autoBestPath !== false : true;
        this.synced.cfgDurationStr = String(Math.round(this.synced.cfgDuration / 1000));
        this.synced.cfgCoopGoalPctStr = String(this.synced.cfgCoopGoalPct);
    };

    // Copies the current/last game's settings into the editable config (and
    // persists them), so after a game — especially a multiplayer one someone
    // else configured — you can adopt those settings as your own.
    copyConfigFromLastGame = () => {
        this.synced.cfgWidth = gameState.gridWidth;
        this.synced.cfgHeight = gameState.gridHeight;
        this.synced.cfgDuration = gameState.gameDuration;
        this.synced.cfgDurationStr = String(Math.round(gameState.gameDuration / 1000));
        this.synced.cfgShowRemaining = gameState.showRemainingWordsPerCell;
        this.synced.cfgShowTotal = gameState.showTotalPossibleScore;
        this.synced.cfgGameMode = gameState.gameMode;
        this.synced.cfgCoopGoalPct = Math.round(gameState.coopGoalFraction * 100);
        this.synced.cfgCoopGoalPctStr = String(Math.round(gameState.coopGoalFraction * 100));
        this.saveMenuConfig();
    };

    toggleMenu = () => {
        if (this.synced.menuOpen) {
            this.synced.menuOpen = false;
            return;
        }
        this.refreshMenuConfig();
        this.synced.menuOpen = true;
        this.synced.confirmNewMp = false;
        // The textarea is uncontrolled: it picks up its initial value from
        // `defaultValue={this.gridToText(...)}` on mount when the menu opens.
        this.synced.boardImportError = undefined;
        this.synced.boardImportCopied = false;
    };

    private gridToText = (grid: GridCell[][]): string => {
        return grid.map(row => row.map(c => (c.letter || "").toUpperCase()).join("")).join("\n");
    };

    private buildBoardShareUrl = (grid: GridCell[][]): string => {
        if (typeof window === "undefined") return "";
        const id = encodeSingleGameId({
            grid,
            gameDuration: gameState.gameDuration,
            gameMode: gameState.gameMode,
            coopGoalFraction: gameState.coopGoalFraction,
        });
        return `${window.location.protocol}//${window.location.host}${window.location.pathname}?page=game&g=${id}`;
    };

    /** Parse rows of letters out of arbitrary input — accepts:
     *    - the raw multi-line letter grid (one row per line),
     *    - rows joined by "-" ("ABCD-EFGH-…"),
     *    - a full share URL containing `?g=<encoded game id>` (also the
     *      legacy `?board=ABCD-EFGH-…` format).
     *  Returns the parsed rows, or an error string for the user. */
    private parseBoardInput = (raw: string): { rows: string[] } | { error: string } => {
        let text = (raw || "").trim();
        // A share-link id encodes the whole board — extract the letters from it.
        const gameIdMatch = /[?&]g=([^&\s#]+)/i.exec(text);
        if (gameIdMatch) {
            const config = decodeSingleGameId(decodeURIComponent(gameIdMatch[1]));
            if (!config) {
                return { error: "Could not decode the game id in that URL." };
            }
            return { rows: config.grid.map(row => row.map(c => c.letter).join("")) };
        }
        // Pull a board= param out of a URL-shaped input. Match `board=`
        // followed by the value up to the next `&` or end of string.
        const urlMatch = /[?&]board=([^&\s#]+)/i.exec(text);
        if (urlMatch) text = decodeURIComponent(urlMatch[1]);
        let rows: string[];
        if (text.includes("\n")) {
            rows = text.split(/\r?\n/);
        } else if (text.includes("-")) {
            rows = text.split("-");
        } else {
            rows = [text];
        }
        rows = rows
            .map(line => line.toUpperCase().replace(/[^A-Z]/g, ""))
            .filter(line => line.length > 0);
        if (rows.length < 2 || rows.length > 10) {
            return { error: `Board must have 2–10 rows (got ${rows.length}).` };
        }
        const width = rows[0].length;
        if (width < 2 || width > 10) {
            return { error: `Each row must have 2–10 letters (got ${width}).` };
        }
        if (!rows.every(r => r.length === width)) {
            return { error: "All rows must have the same number of letters." };
        }
        return { rows };
    };

    copyBoardText = () => {
        // Default to the live board (works in multiplayer too, and keeps
        // multipliers), but if the textarea was edited to different letters,
        // honor those instead. buildBoardShareUrl always produces a `?g=`
        // link, which is always opened as a fresh single-player game — there's
        // no way to launch multiplayer from a board link.
        let grid: GridCell[][] = gameState.grid;
        const raw = this.boardTextareaRef?.value;
        if (raw && raw.trim().length > 0) {
            const parsed = this.parseBoardInput(raw);
            if ("rows" in parsed && parsed.rows.join("\n") !== this.gridToText(gameState.grid)) {
                grid = parsed.rows.map(row => Array.from(row).map((letter): GridCell => ({
                    letter,
                    points: LETTER_POINTS[letter] || 1,
                    multiplier: 1,
                })));
            }
        }
        const url = this.buildBoardShareUrl(grid);
        if (this.copyTextToClipboard(url)) {
            this.synced.boardImportCopied = true;
            setTimeout(() => { this.synced.boardImportCopied = false; }, 1500);
        }
    };

    importBoardFromText = async () => {
        if (gameState.isMultiplayer) {
            this.synced.boardImportError = "Cannot import board in multiplayer.";
            return;
        }
        const raw = this.boardTextareaRef?.value ?? "";
        const parsed = this.parseBoardInput(raw);
        if ("error" in parsed) {
            this.synced.boardImportError = parsed.error;
            return;
        }
        await this.applyImportedBoard(parsed.rows);
        this.synced.menuOpen = false;
    };

    private applyImportedBoard = async (rows: string[]): Promise<void> => {
        const width = rows[0].length;
        const { LETTER_POINTS, ensureCellToWordsForGrid } = await import("./GameState");
        const { getWordTrie, findAllWordsInGrid, calculateTotalScoreForWords } = await import("./GridGenerator");

        const newGrid: GridCell[][] = rows.map(row => Array.from(row).map((letter): GridCell => ({
            letter,
            points: LETTER_POINTS[letter] || 1,
            multiplier: 1,
        })));

        const trie = await getWordTrie();
        const result = findAllWordsInGrid(newGrid, trie);

        gameState.gridWidth = width;
        gameState.gridHeight = rows.length;
        gameState.grid = newGrid;
        gameState.totalPossibleWords = result.words.size;
        gameState.totalPossibleScore = calculateTotalScoreForWords(newGrid, result.words, trie);
        await ensureCellToWordsForGrid(newGrid);

        gameState.status = "ready";
        gameState.score = 0;
        gameState.matchedWords = [];
        gameState.matchedWordsSet.clear();
        gameState.timeRemaining = gameState.gameDuration;
        gameState.startTime = undefined;

        this.synced.cfgWidth = width;
        this.synced.cfgHeight = rows.length;
        this.synced.boardImportError = undefined;
        updateSingleGameURL();
        console.log(`[board-import] applied ${width}x${rows.length} grid, ${result.words.size} words possible`);
    };

    onJoinGameFromMenu = async () => {
        const code = (this.synced.joinGameId || "").trim().toUpperCase();
        if (!code) {
            this.synced.menuError = "Please enter a game ID";
            return;
        }
        // Navigate to the join URL and let the page reload handle it — this is the same path as opening a ?join= link directly, which is known to work. Doing it in-place (routing through startOrJoinMultiplayer) ignored the code when already in a game.
        window.location.href = `${window.location.protocol}//${window.location.host}${window.location.pathname}?page=game&join=${code}`;
    };

    async componentDidMount() {
        this.loadMenuConfig();
        const urlCode = joinGameIdURL.value;
        if (urlCode) {
            this.synced.joinGameId = urlCode.toUpperCase();
        }

        // ?g=<id> in the URL → the id encodes the full board + config. Apply it and restore any saved progress for that game from OPFS. Stays in the URL so refreshes resume and the URL is always shareable.
        if (singleGameURL.value && !challengeURL.value && !joinGameIdURL.value) {
            const ok = await applySingleGameFromURL();
            if (!ok) singleGameURL.reset();
        }
        if (!isNode()) {
            this.calculateScale();

            this.gridSizeReactionDisposer = reaction(
                () => [gameState.gridWidth, gameState.gridHeight],
                () => this.calculateScale(),
            );

            this.peerFlashReactionDisposer = reaction(
                () => gameState.peerFlashRequest?.id,
                () => {
                    const req = gameState.peerFlashRequest;
                    if (req && req.cells.length > 0) this.runPeerFlash(req.cells);
                },
            );

            window.addEventListener("keydown", this.onKeyDown);
            document.addEventListener("touchstart", this.preventGlobalTouch, { passive: false });
            this.scheduleDemoTick(50);
        }

        const challengeData = challengeURL.value;
        challengeURL.reset();
        if (challengeData) {
            const gridWidth = challengeData.grid[0]?.length || 0;
            const gridHeight = challengeData.grid.length;

            if (gridWidth < 2 || gridWidth > 10 || gridHeight < 2 || gridHeight > 10) {
                console.error(`Invalid challenge grid size: ${gridWidth}x${gridHeight}. Must be between 2x2 and 10x10`);
                return;
            }

            if (!challengeData.grid.every(row => row.length === gridWidth)) {
                console.error(`Invalid challenge grid: inconsistent row lengths`);
                return;
            }

            gameState.isMultiplayer = false;
            gameState.isChallengeMode = true;
            gameState.grid = challengeData.grid;
            gameState.gridWidth = gridWidth;
            gameState.gridHeight = gridHeight;
            gameState.totalPossibleWords = challengeData.totalPossibleWords;
            gameState.totalPossibleScore = challengeData.totalPossibleScore;
            gameState.gameDuration = challengeData.gameDuration;
            gameState.challengerData = {
                words: challengeData.challengerWords,
                score: challengeData.challengerScore,
            };

            if (challengeData.challengeId && challengeData.signature && challengeData.publicKey) {
                gameState.challengeMetadata = {
                    challengeId: challengeData.challengeId,
                    signature: challengeData.signature,
                    publicKey: challengeData.publicKey,
                };
            }

            gameState.status = "ready";
            gameState.score = 0;
            gameState.matchedWords = [];
            gameState.matchedWordsSet.clear();
            gameState.timeRemaining = challengeData.gameDuration;

            const { ensureCellToWordsForGrid } = await import("./GameState");
            await ensureCellToWordsForGrid(challengeData.grid);
            return;
        }

        const joinGameId = joinGameIdURL.value;
        if (joinGameId && !gameState.gameId) {
            await this.connectToMultiplayer(joinGameId.toUpperCase(), { autoStartAsHost: true });
        }
    }

    componentWillUnmount() {
        cleanup();
        this.cancelDemoTick();
        void this.stopVoiceMode();
        this.disposeVoiceRecognition();
        this.stopReconnectCountdown();
        if (this.gridSizeReactionDisposer) {
            this.gridSizeReactionDisposer();
            this.gridSizeReactionDisposer = undefined;
        }
        if (this.peerFlashReactionDisposer) {
            this.peerFlashReactionDisposer();
            this.peerFlashReactionDisposer = undefined;
        }
        if (this.connectionManager) {
            this.connectionManager.cleanup();
            this.connectionManager = undefined;
        }
        if (this.midResizeObserver) {
            this.midResizeObserver.disconnect();
            this.midResizeObserver = undefined;
        }
        if (!isNode()) {
            window.removeEventListener("keydown", this.onKeyDown);
            window.removeEventListener("mousemove", this.onGlobalMouseMove);
            window.removeEventListener("touchmove", this.onGlobalTouchMove, { passive: false } as any);
            window.removeEventListener("mouseup", this.onGlobalMouseUp);
            window.removeEventListener("touchend", this.onGlobalTouchEnd, { passive: false } as any);
            document.removeEventListener("touchstart", this.preventGlobalTouch);
        }
    }

    getRelativePos(e: MouseEvent | Touch): { x: number; y: number } {
        let wrapper = this.wrapper;
        if (!wrapper) throw new Error(`Expected wrapper to be mounted`);
        let rect = wrapper.getBoundingClientRect();

        let x = (e.clientX - rect.left) / this.synced.scale;
        let y = (e.clientY - rect.top) / this.synced.scale;
        return { x, y };
    }

    redraw() {
        let canvas = this.canvas;
        if (!canvas) return;
        let gridSize = getCurrentGridSize();
        redrawCanvas(canvas, this.synced.selectedCells, this.synced.currentPos, this.synced.debugPositions, gridSize, this.synced.demoCells);
    }

    demoTimeoutId: number | undefined;
    demoCache: {
        grid: GridCell[][];
        // Snapshot of how many words were matched when finishedPaths was
        // computed — invalidates the cache once the player finds more so
        // the "words you missed" list stays correct.
        matchedCount: number;
        readyPath: { row: number; col: number }[] | undefined;
        finishedPaths: { row: number; col: number }[][];
        // Every missed word's best path (score-sorted), for the tap-a-tile filter on the finished board.
        allMissedPaths: { row: number; col: number }[][];
    } | undefined;
    demoFinishedIndex = 0;

    isDemoEligible(): boolean {
        if (isNode()) return false;
        if (this.synced.drawing) return false;
        if (this.synced.menuOpen) return false;
        if (this.synced.joinPopupOpen) return false;
        if (this.synced.selectedCells.length > 0) return false;
        if (Date.now() < gameState.timeoutUntil) return false;
        // Multiplayer only runs the post-game missed-words demo (no pre-game
        // "how to swipe" hint). Single-player runs both.
        if (gameState.isMultiplayer) return gameState.status === "finished";
        return gameState.status === "ready" || gameState.status === "finished";
    }

    // Bumped every time scheduleDemoTick / cancelDemoTick is called. Each runDemoCycle captures the token at start and bails on stale, so an in-flight cycle can't race a newly-scheduled one (otherwise two cycles fight over demoCells and words flash past at the wrong rate).
    demoCycleToken = 0;

    cancelDemoTick = () => {
        if (this.demoTimeoutId !== undefined) {
            window.clearTimeout(this.demoTimeoutId);
            this.demoTimeoutId = undefined;
        }
        this.demoCycleToken++;
        if (this.synced.demoCells.length > 0) {
            this.synced.demoCells = [];
            this.redraw();
        }
    };

    scheduleDemoTick = (delay: number) => {
        if (this.demoTimeoutId !== undefined) {
            window.clearTimeout(this.demoTimeoutId);
        }
        this.demoCycleToken++;
        const myToken = this.demoCycleToken;
        this.demoTimeoutId = window.setTimeout(() => {
            this.demoTimeoutId = undefined;
            if (myToken !== this.demoCycleToken) return;
            void this.runDemoCycle(myToken);
        }, delay);
    };

    ensureDemoCache = async (): Promise<typeof this.demoCache> => {
        if (this.demoCache
            && this.demoCache.grid === gameState.grid
            && this.demoCache.matchedCount === gameState.matchedWords.length
        ) {
            return this.demoCache;
        }
        const grid = gameState.grid;
        const wordSet = await getWordSet();
        if (grid !== gameState.grid) return this.demoCache;

        // Pick a single, deterministic 3-letter word to use as the
        // "how to swipe" hint on the ready board — same word every time
        // (highest-scoring, then alphabetical tiebreak).
        const shortPaths = findShortWordPaths(grid, DEMO_WORD_LENGTH, wordSet);
        let readyPath: { row: number; col: number }[] | undefined;
        if (shortPaths.length > 0) {
            const scored = shortPaths.map(p => ({
                path: p,
                score: calculateWordScoreForGrid(grid, p),
                word: p.map(c => grid[c.row][c.col].letter).join(""),
            }));
            scored.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
            readyPath = scored[0].path;
        }

        // Top-scoring words on the board for the post-game demo: cycle
        // through them so the player can see which words were available
        // and how they were spelled.
        const trie = await getWordTrie();
        if (grid !== gameState.grid) return this.demoCache;
        const allResult = findAllWordsInGrid(grid, trie);
        const foundSet = new Set<string>();
        for (const w of gameState.matchedWords) foundSet.add(w.word.toLowerCase());
        const finishedScored: { path: { row: number; col: number }[]; score: number; word: string }[] = [];
        for (const word of allResult.words) {
            if (foundSet.has(word.toLowerCase())) continue;
            const paths = findPathsForWord(grid, word.toUpperCase());
            if (paths.length === 0) continue;
            let best = paths[0];
            let bestScore = calculateWordScoreForGrid(grid, best);
            for (let i = 1; i < paths.length; i++) {
                const s = calculateWordScoreForGrid(grid, paths[i]);
                if (s > bestScore) { bestScore = s; best = paths[i]; }
            }
            finishedScored.push({ path: best, score: bestScore, word });
        }
        finishedScored.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
        const allMissedPaths = finishedScored.map(s => s.path);
        const finishedPaths = allMissedPaths.slice(0, DEMO_FINISHED_TOP_N);

        this.demoCache = {
            grid,
            matchedCount: gameState.matchedWords.length,
            readyPath,
            finishedPaths,
            allMissedPaths,
        };
        this.demoFinishedIndex = 0;
        this.synced.demoFilterCell = undefined;
        return this.demoCache;
    };

    // Tap on a finished board: filter the missed-words demo down to words whose path uses that tile. Tapping the same tile again clears the filter.
    toggleDemoFilterCell = (cell: { row: number; col: number }) => {
        const cur = this.synced.demoFilterCell;
        if (cur && cur.row === cell.row && cur.col === cell.col) {
            this.synced.demoFilterCell = undefined;
        } else {
            this.synced.demoFilterCell = cell;
        }
        this.demoFinishedIndex = 0;
        this.synced.demoCells = [];
        this.redraw();
        this.scheduleDemoTick(150);
    };

    runDemoCycle = async (token: number) => {
        const stale = () => token !== this.demoCycleToken;
        if (!this.isDemoEligible()) {
            if (this.synced.demoCells.length > 0) {
                this.synced.demoCells = [];
                this.redraw();
            }
            this.scheduleDemoTick(DEMO_IDLE_RECHECK_MS);
            return;
        }
        let cache: typeof this.demoCache;
        try {
            cache = await this.ensureDemoCache();
        } catch {
            if (stale()) return;
            this.scheduleDemoTick(DEMO_IDLE_RECHECK_MS);
            return;
        }
        if (stale()) return;
        if (!cache || !this.isDemoEligible()) {
            this.scheduleDemoTick(DEMO_IDLE_RECHECK_MS);
            return;
        }
        let path: { row: number; col: number }[] | undefined;
        if (gameState.status === "finished") {
            const filter = this.synced.demoFilterCell;
            const list = filter
                ? cache.allMissedPaths.filter(p => p.some(c => c.row === filter.row && c.col === filter.col))
                : cache.finishedPaths;
            if (list.length === 0) {
                this.scheduleDemoTick(DEMO_IDLE_RECHECK_MS);
                return;
            }
            path = list[this.demoFinishedIndex % list.length];
            this.demoFinishedIndex++;
        } else {
            path = cache.readyPath;
        }
        if (!path) {
            this.scheduleDemoTick(DEMO_IDLE_RECHECK_MS);
            return;
        }
        if (gameState.status === "finished") {
            // Post-game: reveal the whole word at once and hold it longer, so the missed words are easy to read.
            this.synced.demoCells = path.slice();
            this.redraw();
            await new Promise<void>(r => window.setTimeout(r, DEMO_FINISHED_HOLD_MS));
            if (stale()) return;
        } else {
            // Pre-game hint: trace the word letter-by-letter to teach the swipe.
            for (let i = 1; i <= path.length; i++) {
                if (stale()) return;
                if (!this.isDemoEligible()) {
                    this.synced.demoCells = [];
                    this.redraw();
                    this.scheduleDemoTick(DEMO_IDLE_RECHECK_MS);
                    return;
                }
                this.synced.demoCells = path.slice(0, i);
                this.redraw();
                await new Promise<void>(r => window.setTimeout(r, DEMO_STEP_MS));
                if (stale()) return;
            }
            await new Promise<void>(r => window.setTimeout(r, DEMO_HOLD_MS));
            if (stale()) return;
        }
        if (!this.isDemoEligible()) {
            this.synced.demoCells = [];
            this.redraw();
            this.scheduleDemoTick(DEMO_IDLE_RECHECK_MS);
            return;
        }
        this.synced.demoCells = [];
        this.redraw();
        this.scheduleDemoTick(DEMO_GAP_MS);
    };

    isCellSelected(row: number, col: number) {
        return this.synced.selectedCells.some(c => c.row === row && c.col === col);
    }

    isCellPulsing(row: number, col: number) {
        return this.synced.pulseCells.some(c => c.row === row && c.col === col);
    }

    isCellExhausted(row: number, col: number): string | undefined {
        const key = `${row},${col}`;
        const wordsForCell = gameState.cellToWords.get(key);
        if (!wordsForCell) return undefined;

        for (let word of wordsForCell) {
            if (!gameState.matchedWordsSet.has(word)) {
                return word;
            }
        }

        return undefined;
    }

    remainingWordsForCell(row: number, col: number): number {
        const key = `${row},${col}`;
        const wordsForCell = gameState.cellToWords.get(key);
        if (!wordsForCell) return 0;
        let count = 0;
        for (let word of wordsForCell) {
            if (!gameState.matchedWordsSet.has(word)) count++;
        }
        return count;
    }

    handleSelectionStart = async (pos: { x: number; y: number }) => {
        // Finished board: taps pick a tile to filter the missed-words demo (showing only missed words that use that tile). Works in both single-player and multiplayer. Never starts a game.
        if (gameState.status === "finished") {
            const cell = getCellAt(pos);
            if (cell) this.toggleDemoFilterCell(cell);
            return;
        }
        // We never start a game from board interaction. A game is either already
        // playing (draw), or it's ready/finished and there's a Start / New Game
        // button to use instead. Interacting with a non-playing board does nothing.
        if (gameState.status !== "playing") return;
        if (Date.now() < gameState.timeoutUntil) return;
        this.synced.selectedCells = [];
        if (this.synced.demoCells.length > 0) {
            this.synced.demoCells = [];
        }
        this.synced.drawing = true;
        this.synced.currentPos = pos;
        this.synced.showCancelZone = true;
        this.synced.isOverCancelZone = false;
        if (DEBUG_MODE) this.synced.debugPositions = [pos];
        let cell = getCellAt(pos);
        if (cell) {
            this.synced.selectedCells.push(cell);
            this.vibrate();
        }
        this.redraw();

        if (!isNode()) {
            window.addEventListener("mousemove", this.onGlobalMouseMove);
            window.addEventListener("touchmove", this.onGlobalTouchMove, { passive: false });
            window.addEventListener("mouseup", this.onGlobalMouseUp);
            window.addEventListener("touchend", this.onGlobalTouchEnd, { passive: false });
        }
    };

    onMouseDown = (e: MouseEvent) => {
        let pos = this.getRelativePos(e);
        void this.handleSelectionStart(pos);
    };

    handleSelectionMove = (pos: { x: number; y: number }) => {
        if (!this.synced.drawing || gameState.status !== "playing") return;
        this.synced.currentPos = pos;
        if (DEBUG_MODE) this.synced.debugPositions.push(pos);

        const cancelZoneX = this.synced.totalWidth - CANCEL_ZONE_SIZE;
        const cancelZoneY = this.synced.totalHeight + BELOW_GRID_GAP;
        const wasOverCancel = this.synced.isOverCancelZone;
        this.synced.isOverCancelZone = pos.x >= cancelZoneX && pos.x <= cancelZoneX + CANCEL_ZONE_SIZE && pos.y >= cancelZoneY && pos.y <= cancelZoneY + CANCEL_ZONE_SIZE;

        if (this.synced.isOverCancelZone && !wasOverCancel) {
            this.vibrate();
        }

        const gridSize = getCurrentGridSize();
        let cells = this.synced.selectedCells;
        let last = cells[cells.length - 1];
        if (!last) {
            let cell = getCellAt(pos);
            if (cell) {
                this.synced.selectedCells.push(cell);
                this.vibrate();
            }
        } else {
            const lastCenter = cellCenter(last.row, last.col);
            const cellsAlongLine = getCellsAlongLine(lastCenter, pos, gridSize);

            for (const candidateCell of cellsAlongLine) {
                if (!this.isCellSelected(candidateCell.row, candidateCell.col)) {
                    const currentLast = this.synced.selectedCells[this.synced.selectedCells.length - 1];
                    if (currentLast && isAdjacent(currentLast, candidateCell)) {
                        this.synced.selectedCells.push(candidateCell);
                        this.vibrate();
                    }
                }
            }
        }
        this.redraw();
    };

    onMouseMove = (e: MouseEvent) => {
        let pos = this.getRelativePos(e);
        this.handleSelectionMove(pos);
    };

    showWordAcceptedFeedback = (points: number, word?: string) => {
        gameState.consecutiveWrongWords = 0;
        this.synced.pulseCells = this.synced.selectedCells.slice();
        this.synced.acceptedCells = this.synced.selectedCells.slice();
        setTimeout(() => {
            this.synced.pulseCells = [];
        }, 600);
        setTimeout(() => {
            this.synced.acceptedCells = [];
        }, ACCEPTED_CELL_FLASH_MS);
        if (word) {
            const upper = word.toUpperCase();
            const token = ++this.synced.recentAcceptedToken;
            this.synced.recentAcceptedWord = upper;
            setTimeout(() => {
                if (this.synced.recentAcceptedToken === token) {
                    this.synced.recentAcceptedWord = undefined;
                }
            }, WORD_REVEAL_DURATION_MS);
        }
        this.synced.scorePulseId++;
        let scoreId = this.floatingScoreId++;
        this.synced.floatingScores.push({ id: scoreId, points, timestamp: Date.now() });
        setTimeout(() => {
            this.synced.floatingScores = this.synced.floatingScores.filter(s => s.id !== scoreId);
        }, 1000);
    };

    showWrongWordFeedback = (word?: string) => {
        this.vibrateLong();
        gameState.consecutiveWrongWords++;
        const timeoutDuration = Math.min(WRONG_WORD_BASE_TIMEOUT + (gameState.consecutiveWrongWords - 1) * WRONG_WORD_TIMEOUT_INCREMENT, MAX_WRONG_WORD_TIMEOUT);
        gameState.timeoutUntil = Date.now() + timeoutDuration;
        this.synced.showTimeoutMessage = true;
        this.synced.timeoutFadingOut = false;
        this.synced.timeoutMessage = "Not a word!";
        this.synced.timeoutWord = (word ?? this.synced.selectedCells
            .map(c => gameState.grid[c.row]?.[c.col]?.letter ?? "")
            .join("")).toUpperCase();
        this.synced.timeoutStartedAt = Date.now();
        this.synced.timeoutTotalMs = timeoutDuration;
        this.synced.wrongWordCells = this.synced.selectedCells.slice();
        setTimeout(() => {
            this.synced.timeoutFadingOut = true;
            setTimeout(() => {
                this.synced.showTimeoutMessage = false;
                this.synced.timeoutFadingOut = false;
                this.synced.wrongWordCells = [];
            }, TIMEOUT_FADEOUT_DURATION);
        }, timeoutDuration);
    };

    processSelectedWord = async () => {
        let word = this.synced.selectedCells
            .map(c => gameState.grid[c.row][c.col].letter)
            .join("")
            .toLowerCase();

        if (word.length < 3) return;

        const wordSet = await getWordSet();
        if (!wordSet.has(word)) {
            this.showWrongWordFeedback(word);
            return;
        }

        // Auto-best-path: when the user's word can be spelled multiple ways
        // on the grid (ambiguous letters), only swap to a different path if
        // it strictly out-scores what they traced. Ties keep the user's
        // exact cells, so the accepted-flash + pulse on those cells matches
        // what they actually touched. When we DO swap (strict higher score),
        // selectedCells becomes the new path and the flash shows those new
        // cells, intentionally surfacing the algorithm's choice.
        if (this.synced.cfgAutoBestPath) {
            const upper = word.toUpperCase();
            const allPaths = findPathsForWord(gameState.grid, upper);
            if (allPaths.length > 1) {
                const userPath = this.synced.selectedCells;
                const userScore = calculateWordScoreForGrid(gameState.grid, userPath);
                let bestPath = userPath;
                let bestScore = userScore;
                for (const p of allPaths) {
                    const s = calculateWordScoreForGrid(gameState.grid, p);
                    if (s > bestScore) { bestScore = s; bestPath = p; }
                }
                if (bestPath !== userPath) {
                    console.log(`[autoBestPath] ${upper}: rerouted ${userScore} → ${bestScore}`);
                    this.synced.selectedCells = bestPath;
                }
            }
        }

        if (gameState.isMultiplayer) {
            if (gameState.matchedWordsSet.has(word.toUpperCase())) {
                this.flashAlreadyFoundCells(this.synced.selectedCells.slice());
                // Cooperative: glow the finder's segment in the score bar so it's obvious who got it first.
                const found = gameState.matchedWords.find(w => w.word === word.toUpperCase());
                if (typeof found?.playerIndex === "number" && found.playerIndex !== gameState.myPlayerIndex) {
                    const token = ++this.synced.highlightPlayerToken;
                    this.synced.highlightPlayerIndex = found.playerIndex;
                    setTimeout(() => {
                        if (this.synced.highlightPlayerToken === token) {
                            this.synced.highlightPlayerIndex = undefined;
                        }
                    }, PLAYER_HIGHLIGHT_DURATION_MS);
                }
                return;
            }
            if (!isNode() && gameState.gameId) {
                const rpc = getRPCClient();
                const cells = this.synced.selectedCells.slice();
                try {
                    const result = await rpc.submitWord(gameState.gameId, word.toUpperCase(), cells);
                    if (result.points > 0) {
                        const upperWord = word.toUpperCase();
                        if (gameState.gameMode === "cooperative") {
                            // server's onCoopWord broadcast attributes & adds globally; just feedback here
                            if (!gameState.matchedWordsSet.has(upperWord)) {
                                gameState.matchedWords.push({ word: upperWord, points: result.points, playerIndex: gameState.myPlayerIndex });
                                gameState.matchedWordsSet.add(upperWord);
                            }
                        } else {
                            gameState.matchedWords.push({ word: upperWord, points: result.points });
                            gameState.matchedWordsSet.add(upperWord);
                        }
                        this.showWordAcceptedFeedback(result.points, upperWord);
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (gameState.gameMode === "competitive-shared" && msg.startsWith("BLOCKED:")) {
                        // Another player already picked this word — show
                        // it in our list with strikethrough and flash the
                        // cells red so it's obvious what happened.
                        const upperWord = word.toUpperCase();
                        if (!gameState.matchedWordsSet.has(upperWord)) {
                            gameState.matchedWords.push({ word: upperWord, points: 0, blocked: true });
                            gameState.matchedWordsSet.add(upperWord);
                        }
                        this.flashBlockedCells(cells);
                        this.vibrateLong();
                    } else {
                        console.warn("submitWord failed:", err);
                    }
                }
            }
            return;
        }

        const upperWord = word.toUpperCase();
        if (gameState.matchedWordsSet.has(upperWord)) {
            this.flashAlreadyFoundCells(this.synced.selectedCells.slice());
            return;
        }

        let points = calculateWordScore(this.synced.selectedCells);
        gameState.score += points;
        gameState.matchedWords.push({ word: upperWord, points });
        gameState.matchedWordsSet.add(upperWord);
        this.showWordAcceptedFeedback(points, upperWord);

        // Useful for debugging
        /*
        let remainingExamples: string[] = [];
        const gridSize = getCurrentGridSize();
        for (let row = 0; row < gridSize.height; row++) {
            for (let col = 0; col < gridSize.width; col++) {
                const letter = gameState.grid[row][col].letter;
                const remainingWord = this.isCellExhausted(row, col);
                if (!remainingWord) continue;
                remainingExamples.push(`${letter}: ${remainingWord}`);
            }
        }
        console.log(`Remaining words:`, remainingExamples.join(" | "));
        */
    };

    handleSelectionEnd = async () => {
        if (!this.synced.drawing) return;
        if (gameState.status !== "playing") return;

        this.synced.drawing = false;
        this.synced.currentPos = undefined;
        this.synced.showCancelZone = false;

        if (!isNode()) {
            window.removeEventListener("mousemove", this.onGlobalMouseMove);
            window.removeEventListener("touchmove", this.onGlobalTouchMove, { passive: false } as any);
            window.removeEventListener("mouseup", this.onGlobalMouseUp);
            window.removeEventListener("touchend", this.onGlobalTouchEnd, { passive: false } as any);
        }

        try {
            if (this.synced.isOverCancelZone) {
                this.synced.isOverCancelZone = false;
            } else {
                await this.processSelectedWord();
            }
        } finally {
            this.synced.selectedCells = [];
            this.redraw();
        }
    };

    onMouseUp = async () => {
        await this.handleSelectionEnd();
    };

    handleSelectionLeave = () => {
        if (!this.synced.drawing) return;
        this.synced.currentPos = undefined;
        this.redraw();
    };

    onMouseLeave = () => {
        this.handleSelectionLeave();
    };

    onTouchStart = (e: TouchEvent) => {
        e.preventDefault();
        if (e.touches.length !== 1) return;
        let touch = e.touches[0];
        let pos = this.getRelativePos(touch);
        void this.handleSelectionStart(pos);
    };

    onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        if (e.touches.length !== 1) return;
        let touch = e.touches[0];
        let pos = this.getRelativePos(touch);
        this.handleSelectionMove(pos);
    };

    onTouchEnd = async (e: TouchEvent) => {
        e.preventDefault();
        await this.handleSelectionEnd();
    };

    onTouchCancel = () => {
        this.handleSelectionLeave();
    };

    renderTimeAndScore(timeBarHue: number, timePercent: number) {
        const isCoop = gameState.gameMode === "cooperative";
        const totalScore = isCoop && gameState.isMultiplayer
            ? gameState.players.reduce((s, p) => s + p.score, 0)
            : gameState.score;
        // In coop multiplayer matchedWords already contains every player's words, so the count tracks the combined total just like totalScore does.
        const totalWords = gameState.matchedWords.length;
        const showWords = scoreShowsWordsURL.value;
        const headlineValue = showWords ? totalWords : totalScore;
        const goalPoints = isCoop ? Math.max(1, Math.ceil(gameState.totalPossibleScore * gameState.coopGoalFraction)) : 0;
        // Goal-completion bar always reflects points — the win condition is fixed even when the headline reads as a word count.
        const goalPct = isCoop && goalPoints > 0 ? Math.min(100, (totalScore / goalPoints) * 100) : 0;
        return (
            <div className={css.hbox(10).wrap.alignItems("center").fillWidth}>
                <div className={css.vbox(4)}>
                    <div className={css.fontSize(28).fontFamily("monospace")}>
                        {isCoop ? formatTime(gameState.elapsedTime) : formatTime(gameState.timeRemaining)}
                    </div>
                    <div className={css.width(90).height(4).hsl(0, 0, 30).borderRadius(2).relative.overflowHidden}>
                        <div
                            className={css.absolute.pos(0, 0).height(4).borderRadius(2) +
                                (isCoop ? css.hsl(200, 70, 50) : css.hsl(timeBarHue, 70, 50))
                            }
                            style={{ width: `${isCoop ? goalPct : timePercent}%`, transition: "width 0.1s linear" }}
                        />
                    </div>
                </div>
                <div
                    onClick={() => { scoreShowsWordsURL.value = !scoreShowsWordsURL.value; }}
                    title={showWords ? "Showing word count — tap to show points" : "Showing points — tap to show word count"}
                    className={css.hbox(6).alignItems("center").relative
                        .pad2(4, 10).borderRadius(8)
                        .hsl(240, 30, 15).cursor("pointer")
                    }
                    style={{ border: "1px solid rgba(255,255,255,0.15)" }}
                >
                    <span className={css.fontSize(20)}>{showWords ? "📝" : (isCoop ? "🤝" : "🏆")}</span>
                    <span
                        key={`score-${this.synced.scorePulseId}`}
                        className={css.fontSize(20).fontWeight("bold") + " score-pulse"}
                    >{headlineValue}</span>
                    <span className={css.fontSize(11).colorhsl(0, 0, 65).textTransform("uppercase").letterSpacing("0.5px") + ""}>
                        {showWords ? "words" : "pts"}
                    </span>
                    {isCoop && goalPoints > 0 && (
                        <span className={css.vbox(0).alignItems("center")}>
                            <span className={css.fontSize(13).colorhsl(0, 0, 70) + ""}>
                                / {goalPoints}
                            </span>
                            <span className={css.fontSize(10).colorhsl(200, 60, 65) + ""} style={{ marginTop: "-2px" }}>
                                {Math.round(gameState.coopGoalFraction * 100)}% goal
                            </span>
                        </span>
                    )}
                    {!isCoop && gameState.showTotalPossibleScore && (showWords ? gameState.totalPossibleWords > 0 : gameState.totalPossibleScore > 0) && (
                        <span className={css.fontSize(13).colorhsl(0, 0, 70) + ""}>
                            / {showWords ? gameState.totalPossibleWords : gameState.totalPossibleScore}
                        </span>
                    )}
                    {this.synced.floatingScores.map(fs => (
                        <div
                            key={fs.id}
                            className={css.absolute.pos(-30, 30).fontSize(24).fontWeight("bold")
                                .colorhsl(120, 70, 60) + " floating-score"}
                        >
                            +{fs.points}
                        </div>
                    ))}
                </div>
                {!gameState.isMultiplayer && gameState.status === "ready" && (
                    <button
                        onClick={async () => { await startGame(false); }}
                        className={css.hbox(6).alignItems("center")
                            .pad2(8, 14).borderRadius(8)
                            .fontSize(16).fontWeight("bold")
                            .colorhsl(0, 0, 100).cursor("pointer")
                            .border("2px solid rgba(120, 255, 160, 0.85)")
                            + ""}
                        style={{
                            background: "linear-gradient(135deg, rgba(0,200,120,0.4), rgba(0,140,90,0.4))",
                            boxShadow: "0 0 14px rgba(120, 255, 160, 0.45)",
                        }}
                    >
                        ▶ Start
                    </button>
                )}
                {!gameState.isMultiplayer && (gameState.status === "finished" || gameState.coopInfinite) && (
                    <button
                        onClick={async () => { await startGame(); }}
                        className={css.hbox(6).alignItems("center")
                            .pad2(8, 14).borderRadius(8)
                            .fontSize(16).fontWeight("bold")
                            .colorhsl(0, 0, 100).cursor("pointer")
                            .border("2px solid rgba(120, 255, 160, 0.85)")
                            + ""}
                        style={{
                            background: "linear-gradient(135deg, rgba(0,200,120,0.4), rgba(0,140,90,0.4))",
                            boxShadow: "0 0 14px rgba(120, 255, 160, 0.45)",
                        }}
                    >
                        ▶ Play Again
                    </button>
                )}
                {gameState.isMultiplayer && gameState.gameId && (
                    <button
                        onClick={this.copyGameCode}
                        title="Tap to copy game code"
                        className={css.hbox(4).alignItems("center")
                            .pad2(4, 8).borderRadius(6)
                            .hsl(240, 30, 18).colorhsl(0, 0, 100)
                            .fontFamily("monospace").fontSize(13).fontWeight("bold")
                            .letterSpacing("1px").cursor("pointer")
                            + ""}
                        style={{ marginLeft: "auto", border: "1px dashed rgba(255,255,255,0.3)" }}
                    >
                        <span className={css.fontSize(10).colorhsl(0, 0, 70).letterSpacing("0px") + ""}>
                            {this.synced.linkCopied ? "✓" : "📋"}
                        </span>
                        <span>{this.synced.linkCopied ? "COPIED" : gameState.gameId}</span>
                    </button>
                )}
                <button
                    onClick={() => {
                        this.synced.joinPopupOpen = true;
                        this.synced.menuError = undefined;
                    }}
                    title="Join a game"
                    className={css.fontSize(20).pad2(4, 8) + ""}
                    style={{ marginLeft: gameState.isMultiplayer && gameState.gameId ? "0" : "auto" }}
                >
                    👥
                </button>
                {gameState.lastGameOverState && (
                    <button
                        onClick={() => {
                            const s = gameState.lastGameOverState;
                            const cb = gameState.lastGameOverOnPlayAgain || (() => { });
                            if (s) showGameOver(s, cb);
                        }}
                        title="Show last game summary"
                        className={css.fontSize(20).pad2(4, 8) + ""}
                    >
                        📊
                    </button>
                )}
                <button
                    onClick={this.toggleMenu}
                    title="Menu"
                    className={css.fontSize(24).pad2(4, 10) + ""}
                >
                    ☰
                </button>
            </div>
        );
    }

    renderPlayerScores() {
        if (gameState.isChallengeMode && gameState.challengerData) {
            return (
                <div className={css.fontSize(14).colorhsl(0, 0, 100)}>
                    Challenger: {gameState.challengerData.score}
                </div>
            );
        }
        if (!gameState.isMultiplayer || gameState.players.length === 0) return undefined;

        const players = gameState.players.map((p, originalIndex) => ({
            p,
            originalIndex,
            score: Math.max(0, p.score || 0),
        }));
        const totalScore = players.reduce((s, x) => s + x.score, 0);
        const sorted = players.slice().sort((a, b) =>
            b.score - a.score || a.originalIndex - b.originalIndex,
        );

        // Each player gets a minimum slice so their letter stays readable
        // even when their score is 0; the rest is split by score share.
        const N = sorted.length;
        const MIN_PCT = Math.min(12, 100 / N);
        const remainingPct = Math.max(0, 100 - MIN_PCT * N);
        const pcts = sorted.map(entry =>
            totalScore === 0 ? 100 / N : MIN_PCT + (entry.score / totalScore) * remainingPct,
        );
        const lefts: number[] = [];
        let acc = 0;
        for (const pct of pcts) { lefts.push(acc); acc += pct; }

        // You = green; everyone else lives on the blue → purple arc, with
        // a stable hue per original index so colors don't change as scores
        // shift. Spread by a relatively-prime step so adjacent players
        // stay visually distinct.
        const NON_YOU_HUE_BASE = 200; // blue
        const NON_YOU_HUE_RANGE = 90; // up to 290 (purple)
        const hueFor = (idx: number, isYou: boolean) => {
            if (isYou) return 135;
            return NON_YOU_HUE_BASE + Math.round((idx * 47) % NON_YOU_HUE_RANGE);
        };

        const BAR_HEIGHT = 28;
        return (
            <div
                className={css.relative.fillWidth.height(BAR_HEIGHT).borderRadius(6).overflowHidden + ""}
                style={{
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.1)",
                }}
            >
                {sorted.map((entry, sortIdx) => {
                    const letter = String.fromCharCode(65 + entry.originalIndex);
                    const isYou = entry.originalIndex === gameState.myPlayerIndex;
                    const isHost = entry.originalIndex === gameState.hostPlayerIndex;
                    const hue = hueFor(entry.originalIndex, isYou);
                    const isHighlighted = entry.originalIndex === this.synced.highlightPlayerIndex;
                    return (
                        <div
                            key={entry.p.id || `idx-${entry.originalIndex}`}
                            title={`${isHost ? "Host " : ""}${isYou ? "(you) " : ""}${letter}: ${entry.score}`}
                            className={css.absolute.hbox(4).alignItems("center").justifyContent("center")
                                .colorhsl(0, 0, 100).fontSize(13).fontWeight("bold").overflowHidden
                                + ""}
                            style={{
                                top: 0,
                                height: `${BAR_HEIGHT}px`,
                                left: `${lefts[sortIdx]}%`,
                                width: `${pcts[sortIdx]}%`,
                                background: isHighlighted
                                    ? `linear-gradient(180deg, hsl(${hue}, 90%, 60%), hsl(${hue}, 80%, 45%))`
                                    : `linear-gradient(180deg, hsl(${hue}, 60%, 42%), hsl(${hue}, 55%, 32%))`,
                                transition: "left 350ms ease, width 350ms ease, background 200ms ease, box-shadow 200ms ease",
                                boxShadow: isHighlighted
                                    ? "0 0 0 3px rgba(255, 200, 60, 0.95), 0 0 16px rgba(255, 200, 60, 0.8)"
                                    : "inset 0 0 0 1px rgba(0,0,0,0.2)",
                                zIndex: isHighlighted ? 1 : undefined,
                                textShadow: "0 1px 2px rgba(0,0,0,0.5)",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {isHost && <span style={{ fontSize: 11 }}>👑</span>}
                            <span>{letter}</span>
                            {isYou && <span style={{ fontSize: 11 }}>👤</span>}
                            <span className={css.opacity(0.85) + ""}>{entry.score}</span>
                        </div>
                    );
                })}
            </div>
        );
    }

    renderConnectionStatus() {
        if (!gameState.isMultiplayer) return undefined;

        const { connectionStatus } = gameState;
        let statusText = "";
        let statusColor = "";

        if (connectionStatus === "connected") {
            statusText = "● Connected";
            statusColor = css.colorhsl(120, 70, 50) + "";
        } else if (connectionStatus === "connecting") {
            statusText = "● Connecting...";
            statusColor = css.colorhsl(60, 70, 50) + "";
        } else if (connectionStatus === "disconnected") {
            if (this.synced.reconnectCountdown > 0) {
                statusText = `● Reconnecting in ${this.synced.reconnectCountdown}s`;
            } else {
                statusText = "● Disconnected";
            }
            statusColor = css.colorhsl(0, 70, 50) + "";
        } else if (connectionStatus === "error") {
            if (this.synced.reconnectCountdown > 0) {
                statusText = `● Retrying in ${this.synced.reconnectCountdown}s`;
            } else {
                statusText = "● Connection Error";
            }
            statusColor = css.colorhsl(0, 70, 50) + "";
        }

        return (
            <div className={css.fontSize(14).fontWeight("bold") + statusColor}>
                {statusText}
            </div>
        );
    }

    renderMenuButtons() {
        const btn = css.fontSize(13).pad2(6, 10).fillWidth.textAlign("left") + "";
        const closeAfter = (fn: () => unknown | Promise<unknown>) => async () => {
            this.synced.menuOpen = false;
            await fn();
        };
        const startSingleplayer = async () => {
            if (gameState.isMultiplayer) this.leaveMultiplayer();
            await this.startConfiguredSinglePlayerGame();
        };
        const startMultiplayer = async () => {
            await this.startOrJoinMultiplayer();
        };
        const endMultiplayerGame = async () => {
            if (!gameState.gameId) return;
            try {
                await (getRPCClient() as any).endGameNow(gameState.gameId);
            } catch (error) {
                console.error("Failed to end game:", (error as Error).stack ?? error);
            }
        };
        // Non-host restriction only applies in the lobby (starting the shared game needs the host). Mid-game, clicking this spins up a NEW game, which anyone may do.
        const inMpLobbyAsNonHost = gameState.isMultiplayer && gameState.status !== "playing" && gameState.myPlayerIndex !== gameState.hostPlayerIndex;
        const mpDisabled = this.synced.isConverting || inMpLobbyAsNonHost;
        // Clicking "New Multiplayer Game" while already in a game leaves it — confirm first.
        const leavingForNewMp = gameState.isMultiplayer && !!gameState.gameId && gameState.status === "playing";
        const onMultiplayerClick = async () => {
            if (leavingForNewMp && !this.synced.confirmNewMp) {
                this.synced.confirmNewMp = true;
                return;
            }
            this.synced.confirmNewMp = false;
            this.synced.menuOpen = false;
            await startMultiplayer();
        };
        const isMpHost = gameState.isMultiplayer && gameState.myPlayerIndex === gameState.hostPlayerIndex;
        return (
            <>
                <button onClick={closeAfter(startSingleplayer)} className={btn}>
                    ▶️ Start Singleplayer
                </button>
                <button
                    onClick={onMultiplayerClick}
                    disabled={mpDisabled}
                    title={inMpLobbyAsNonHost ? "Only the host can start the game" : undefined}
                    className={btn}
                >
                    {this.synced.isConverting && "👥 Starting…"
                        || leavingForNewMp && "👥 New Multiplayer Game"
                        || "👥 Start Multiplayer"}
                </button>
                {this.synced.confirmNewMp && (
                    <div className={css.vbox(6).pad2(8).borderRadius(6).hsl(0, 40, 18)}>
                        <div className={css.fontSize(12)}>
                            Starting a new game will leave your current game.
                        </div>
                        <div className={css.hbox(6)}>
                            <button
                                onClick={async () => {
                                    this.synced.confirmNewMp = false;
                                    this.synced.menuOpen = false;
                                    await startMultiplayer();
                                }}
                                className={css.fontSize(13).pad2(4, 8) + ""}
                            >
                                Leave & start new
                            </button>
                            <button
                                onClick={() => { this.synced.confirmNewMp = false; }}
                                className={css.fontSize(13).pad2(4, 8) + ""}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
                {gameState.status === "playing" && !gameState.isMultiplayer && (
                    <button onClick={closeAfter(() => endGame())} className={btn}>
                        ⏹️ End Now
                    </button>
                )}
                {gameState.status === "playing" && isMpHost && (
                    <button onClick={closeAfter(endMultiplayerGame)} className={btn}>
                        ⏹️ End Game
                    </button>
                )}
            </>
        );
    }

    renderGrid() {
        const gridSize = getCurrentGridSize();
        const scaledWidth = this.synced.totalWidth * this.synced.scale;
        const scaledHeight = this.synced.totalHeight * this.synced.scale;
        return (
            <div className={css.relative.size(scaledWidth, scaledHeight)}>
                <div
                    ref={elem => { this.wrapper = elem || undefined; }}
                    className={css.size(this.synced.totalWidth, this.synced.totalHeight).userSelect("none")}
                    style={{
                        touchAction: "none",
                        transform: `scale(${this.synced.scale})`,
                        transformOrigin: "top left"
                    }}
                    onMouseDown={this.onMouseDown as any}
                    onMouseMove={this.onMouseMove as any}
                    onMouseUp={this.onMouseUp}
                    onMouseLeave={this.onMouseLeave}
                    onTouchStart={this.onTouchStart as any}
                    onTouchMove={this.onTouchMove as any}
                    onTouchEnd={this.onTouchEnd as any}
                    onTouchCancel={this.onTouchCancel}
                >
                    <div
                        className={css.absolute.pos(0, 0).size(this.synced.totalWidth, this.synced.totalHeight)}
                        style={{ display: "grid", gridTemplateColumns: `repeat(${gridSize.width}, ${CELL_SIZE}px)`, gap: `${CELL_GAP}px` }}
                    >
                        {gameState.grid.map((row, ri) =>
                            row.map((cell, ci) => {
                                let isSelected = this.isCellSelected(ri, ci);
                                let isPulsing = this.isCellPulsing(ri, ci);
                                let isPeerFlashing = this.synced.peerFlashCells.some(c => c.row === ri && c.col === ci);
                                let isBlockedFlashing = this.synced.blockedFlashCells.some(c => c.row === ri && c.col === ci);
                                let isAlreadyFlashing = this.synced.alreadyFlashCells.some(c => c.row === ri && c.col === ci);
                                let isExhausted = !this.isCellExhausted(ri, ci);
                                return (
                                    <div
                                        key={`${ri}-${ci}`}
                                        className={css.size(CELL_SIZE, CELL_SIZE).relative
                                            .hbox(0).justifyContent("center")
                                            .fontSize(36).fontWeight("bold")
                                            .borderRadius(8)
                                            + (isSelected && css.hsl(240, 50, 10).colorhsl(0, 0, 100)
                                                .background("linear-gradient(135deg, rgba(0,200,255,0.3) 0%, rgba(255,0,200,0.3) 100%), #0a0a1f")
                                                || css.hsl(0, 0, 95).colorhsl(0, 0, 0)
                                            )
                                            + (isExhausted && css.opacity(0.3))
                                            + " board-letter"
                                        }
                                        style={{
                                            border: isSelected && "3px solid transparent" || "3px solid #ddd",
                                            backgroundImage: isSelected && "linear-gradient(#0a0a1f, #0a0a1f), linear-gradient(135deg, #00d4ff, #ff00d4)" || undefined,
                                            backgroundOrigin: "border-box",
                                            backgroundClip: isSelected && "padding-box, border-box" || undefined,
                                        }}
                                    >
                                        {isPulsing && (
                                            <div
                                                className={css.absolute.pos(0, 0).fillBoth
                                                    .borderRadius(8)
                                                    + " pulse-cell"}
                                                style={{
                                                    border: "2px solid rgba(255, 255, 255, 0.6)",
                                                    backgroundColor: "transparent"
                                                }}
                                            />
                                        )}
                                        {this.synced.demoCells.some(c => c.row === ri && c.col === ci) && (
                                            <div
                                                className={css.absolute.pos(0, 0).fillBoth
                                                    .borderRadius(8)
                                                }
                                                style={{
                                                    border: "3px solid rgba(0, 212, 255, 0.4)",
                                                    background: "rgba(0, 212, 255, 0.15)",
                                                    pointerEvents: "none",
                                                }}
                                            />
                                        )}
                                        {gameState.status === "finished"
                                            && this.synced.demoFilterCell
                                            && this.synced.demoFilterCell.row === ri
                                            && this.synced.demoFilterCell.col === ci
                                            && (
                                                <div
                                                    className={css.absolute.pos(0, 0).fillBoth
                                                        .borderRadius(8)
                                                    }
                                                    style={{
                                                        border: "3px solid rgba(255, 200, 60, 0.95)",
                                                        boxShadow: "0 0 14px rgba(255, 200, 60, 0.6)",
                                                        background: "rgba(255, 200, 60, 0.18)",
                                                        pointerEvents: "none",
                                                    }}
                                                />
                                            )}
                                        {this.synced.acceptedCells.some(c => c.row === ri && c.col === ci) && (
                                            <div
                                                className={css.absolute.pos(0, 0).fillBoth
                                                    .borderRadius(8)
                                                    + " accepted-cell"}
                                                style={{
                                                    border: "3px solid rgba(120, 255, 160, 0.95)",
                                                    boxShadow: "0 0 14px rgba(120, 255, 160, 0.75)",
                                                    background: "rgba(80, 220, 130, 0.35)",
                                                }}
                                            />
                                        )}
                                        {isBlockedFlashing && (
                                            <div
                                                className={css.absolute.pos(0, 0).fillBoth
                                                    .borderRadius(8)
                                                    + " blocked-flash-cell"}
                                                style={{
                                                    border: "3px solid rgba(255, 60, 60, 0.95)",
                                                    boxShadow: "0 0 12px rgba(255, 60, 60, 0.7)",
                                                    background: "transparent",
                                                }}
                                            />
                                        )}
                                        {isAlreadyFlashing && (
                                            <div
                                                className={css.absolute.pos(0, 0).fillBoth
                                                    .borderRadius(8)
                                                    + " blocked-flash-cell"}
                                                style={{
                                                    border: "3px solid rgba(255, 200, 60, 0.95)",
                                                    boxShadow: "0 0 12px rgba(255, 200, 60, 0.6)",
                                                    background: "rgba(255, 200, 60, 0.2)",
                                                }}
                                            />
                                        )}
                                        {isPeerFlashing && (
                                            <div
                                                className={css.absolute.pos(0, 0).fillBoth
                                                    .borderRadius(8)
                                                    + " peer-flash-cell"}
                                                style={{
                                                    background: "rgba(120, 200, 255, 0.5)",
                                                    border: "3px solid rgba(120, 200, 255, 0.95)",
                                                }}
                                            />
                                        )}
                                        {cell.multiplier > 1 && (
                                            <div
                                                className={css.absolute.pos(3, 3)
                                                    .fontSize(11).fontWeight("bold")
                                                    .pad2(3, 2).borderRadius(4)
                                                    .colorhsl(0, 0, 100)
                                                    + (cell.multiplier === 2 && css.hsl(190, 80, 50) || css.hsl(45, 90, 55))
                                                }
                                            >
                                                {cell.multiplier}W
                                            </div>
                                        )}
                                        <div
                                            className={css.absolute.top(4).right(7)
                                                .fontSize(12).fontWeight("normal")
                                                .whiteSpace("nowrap")
                                                + (isSelected && css.colorhsl(0, 0, 70) || css.colorhsl(0, 0, 40))
                                            }
                                        >
                                            {cell.points}
                                        </div>
                                        {gameState.showRemainingWordsPerCell && (
                                            <div
                                                className={css.absolute.bottom(4).left(7)
                                                    .fontSize(12).fontWeight("normal")
                                                    .whiteSpace("nowrap")
                                                    + (isSelected && css.colorhsl(0, 0, 70) || css.colorhsl(0, 0, 40))
                                                }
                                            >
                                                {this.remainingWordsForCell(ri, ci)}
                                            </div>
                                        )}
                                        {cell.letter}
                                    </div>
                                );
                            })
                        )}
                    </div>
                    <canvas
                        ref={elem => {
                            if (!elem) return;
                            this.canvas = elem;
                            elem.width = this.synced.totalWidth;
                            elem.height = this.synced.totalHeight;
                            this.redraw();
                        }}
                        className={css.absolute.pos(0, 0).size(this.synced.totalWidth, this.synced.totalHeight)}
                        style={{ pointerEvents: "none" }}
                    />
                    {(Date.now() < gameState.timeoutUntil || this.synced.showTimeoutMessage) && (() => {
                        const total = this.synced.timeoutTotalMs;
                        const elapsed = Date.now() - this.synced.timeoutStartedAt;
                        const pct = total > 0 ? Math.max(0, Math.min(100, 100 - (elapsed / total) * 100)) : 0;
                        return (
                            <div
                                className={css.absolute.pos(0, 0).fillBoth
                                    .hsla(0, 0, 0, 0.7).hbox(0).justifyContent("center").alignItems("center")
                                    .borderRadius(8)
                                    + (this.synced.timeoutFadingOut && " timeout-fadeout" || "")
                                }
                            >
                                <div
                                    className={css.vbox(8).alignItems("center")
                                        .colorhsl(0, 0, 100).pad2(20)
                                        .hsl(0, 0, 10).borderRadius(8)
                                        .minWidth(220)
                                    }
                                >
                                    <div className={css.fontSize(24).fontWeight("bold")}>
                                        {this.synced.timeoutMessage}
                                    </div>
                                    {this.synced.timeoutWord && (
                                        <div className={css.fontSize(20).colorhsl(0, 80, 70).fontWeight("bold")}>
                                            {this.synced.timeoutWord}
                                        </div>
                                    )}
                                    {total > 0 && (
                                        <div className={css.width(180).height(6).hsl(0, 0, 25).borderRadius(3) + ""}
                                            style={{ overflow: "hidden" }}
                                        >
                                            <div className={css.height(6).hsl(0, 70, 55) + ""}
                                                style={{ width: `${pct}%`, transition: "width 100ms linear" }}
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })()}
                    {this.synced.showCancelZone && (
                        <div
                            className={css.absolute.size(CANCEL_ZONE_SIZE, CANCEL_ZONE_SIZE)
                                .borderRadius(8)
                                .hbox(0).justifyContent("center")
                                + (this.synced.isOverCancelZone && css.hsl(0, 80, 50) || css.hsl(0, 0, 30))
                            }
                            style={{
                                left: `${this.synced.totalWidth - CANCEL_ZONE_SIZE}px`,
                                top: `${this.synced.totalHeight + BELOW_GRID_GAP}px`,
                                transition: "background-color 0.1s",
                                pointerEvents: "none"
                            }}
                        >
                            <div className={css.fontSize(48).fontWeight("bold").colorhsl(0, 0, 100)}>
                                ✕
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    renderJoinPopup() {
        if (!this.synced.joinPopupOpen) return undefined;
        return (
            <div
                className={css.absolute.pos(0, 0).fillBoth.hsla(0, 0, 0, 0.6)
                    .hbox(0).justifyContent("center").alignItems("center")
                }
                style={{ zIndex: 200 }}
                onMouseDown={(e) => {
                    if (e.target === e.currentTarget) this.synced.joinPopupBackdropDown = true;
                }}
                onMouseUp={(e) => {
                    if (e.target === e.currentTarget && this.synced.joinPopupBackdropDown) {
                        this.synced.joinPopupOpen = false;
                    }
                    this.synced.joinPopupBackdropDown = false;
                }}
                onTouchStart={(e) => {
                    if (e.target === e.currentTarget) this.synced.joinPopupBackdropDown = true;
                }}
                onTouchEnd={(e) => {
                    if (e.target === e.currentTarget && this.synced.joinPopupBackdropDown) {
                        this.synced.joinPopupOpen = false;
                    }
                    this.synced.joinPopupBackdropDown = false;
                }}
            >
                <div
                    className={css.vbox(10).pad2(16).borderRadius(10)
                        .hsl(240, 30, 12).colorhsl(0, 0, 100)
                    }
                    style={{ width: "min(280px, 90vw)", boxShadow: "0 4px 20px rgba(0,0,0,0.5)" }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className={css.fontSize(14).fontWeight("bold")}>Join game</div>
                    <input
                        type="text"
                        autoFocus
                        placeholder="Game code"
                        value={this.synced.joinGameId}
                        onInput={(e) => { this.synced.joinGameId = e.currentTarget.value; }}
                        onKeyDown={async (e) => {
                            if (e.key === "Enter") {
                                await this.onJoinGameFromMenu();
                                this.synced.joinPopupOpen = false;
                            } else if (e.key === "Escape") {
                                this.synced.joinPopupOpen = false;
                            }
                        }}
                        className={css.fontSize(16).pad2(8, 10).textTransform("uppercase").fillWidth + ""}
                    />
                    <div className={css.hbox(8).justifyContent("end")}>
                        <button
                            onClick={() => { this.synced.joinPopupOpen = false; }}
                            className={css.fontSize(13).pad2(6, 10) + ""}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={async () => {
                                await this.onJoinGameFromMenu();
                                this.synced.joinPopupOpen = false;
                            }}
                            disabled={this.synced.joining}
                            className={css.fontSize(13).pad2(6, 10) + ""}
                        >
                            {this.synced.joining ? "Joining…" : "Join"}
                        </button>
                    </div>
                    {this.synced.menuError && (
                        <div className={css.colorhsl(0, 70, 60).fontSize(12).pad2(6, 8).borderRadius(6).hsl(0, 30, 20)}>
                            {this.synced.menuError}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    renderMenu() {
        if (!this.synced.menuOpen) return undefined;
        const inputCls = css.fontSize(13).pad2(4, 6).width(48) + "";
        const sectionTitle = css.fontSize(12).fontWeight("bold").colorhsl(0, 0, 70) + "";
        const inMP = gameState.isMultiplayer && !!gameState.gameId;
        const isHost = !inMP || gameState.myPlayerIndex === gameState.hostPlayerIndex;
        const hostOnlyTitle = !isHost ? "Only the host can change this" : undefined;
        const hostOnlySuffix = inMP && !isHost ? " (host only)" : "";
        return (
            <div
                className={css.absolute.pos(0, 0).fillBoth.hsla(0, 0, 0, 0.6)
                    .hbox(0).justifyContent("end")
                }
                style={{ zIndex: 100 }}
                onMouseDown={(e) => {
                    if (e.target === e.currentTarget) this.synced.menuBackdropDown = true;
                }}
                onMouseUp={(e) => {
                    if (e.target === e.currentTarget && this.synced.menuBackdropDown) {
                        this.synced.menuOpen = false;
                    }
                    this.synced.menuBackdropDown = false;
                }}
                onTouchStart={(e) => {
                    if (e.target === e.currentTarget) this.synced.menuBackdropDown = true;
                }}
                onTouchEnd={(e) => {
                    if (e.target === e.currentTarget && this.synced.menuBackdropDown) {
                        this.synced.menuOpen = false;
                    }
                    this.synced.menuBackdropDown = false;
                }}
            >
                <div
                    className={css.vbox(8).pad2(10).overflowAuto
                        .hsl(240, 30, 12).colorhsl(0, 0, 100)
                    }
                    style={{
                        width: "min(300px, 88vw)",
                        height: "100%",
                        boxShadow: "-4px 0 20px rgba(0,0,0,0.5)",
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className={css.hbox(8).alignItems("center").justifyContent("space-between")}>
                        <div className={css.fontSize(14).fontWeight("bold")}>Menu</div>
                        <button
                            onClick={() => { this.synced.menuOpen = false; }}
                            className={css.fontSize(14).pad2(2, 6) + ""}
                        >
                            ✕
                        </button>
                    </div>

                    <div className={css.hbox(6).alignItems("center")}>
                        <input
                            type="text"
                            placeholder="Game ID"
                            value={this.synced.joinGameId}
                            onInput={(e) => {
                                this.synced.joinGameId = e.currentTarget.value;
                            }}
                            onKeyDown={async (e) => {
                                if (e.key === "Enter") {
                                    await this.onJoinGameFromMenu();
                                }
                            }}
                            className={css.fontSize(13).pad2(4, 6).textTransform("uppercase").flexGrow(1).minWidth(0) + ""}
                        />
                        <button
                            onClick={() => {
                                const code = (this.synced.joinGameId || "").toUpperCase();
                                if (code && this.copyTextToClipboard(this.buildShareUrl(code))) this.flashCopied();
                            }}
                            title="Copy code"
                            className={css.fontSize(13).pad2(4, 8) + ""}
                        >
                            {this.synced.linkCopied ? "✓" : "📋"}
                        </button>
                        <button
                            onClick={this.onJoinGameFromMenu}
                            disabled={this.synced.joining}
                            className={css.fontSize(13).pad2(4, 8) + ""}
                        >
                            {this.synced.joining && "…" || "Join"}
                        </button>
                    </div>

                    <div className={css.vbox(4)}>
                        {this.renderMenuButtons()}
                    </div>

                    {inMP && isHost && gameState.players.length > 1 && (
                        <div className={css.vbox(4)}>
                            <div className={sectionTitle}>Make host</div>
                            <div className={css.hbox(6).wrap}>
                                {gameState.players.map((p, index) => {
                                    if (index === gameState.hostPlayerIndex) return undefined;
                                    const connected = p.connected !== false;
                                    const letter = String.fromCharCode(65 + index);
                                    return (
                                        <button
                                            key={p.id || `p-${index}`}
                                            disabled={!connected}
                                            title={connected ? `Make player ${letter} the host` : `Player ${letter} is disconnected`}
                                            onClick={async () => {
                                                if (!gameState.gameId) return;
                                                try {
                                                    await (getRPCClient() as any).transferHost(gameState.gameId, index);
                                                } catch (error) {
                                                    console.error("Failed to transfer host:", (error as Error).stack ?? error);
                                                }
                                            }}
                                            className={css.fontSize(13).pad2(4, 8) + (connected ? "" : css.opacity(0.5))}
                                        >
                                            {letter}{index === gameState.myPlayerIndex ? " (you)" : ""}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <div className={css.vbox(4)}>
                        <div className={sectionTitle}>Grid Size (2-10){hostOnlySuffix}</div>
                        <div className={css.hbox(6).alignItems("center")}>
                            <input
                                type="number"
                                min="2"
                                max="10"
                                value={this.synced.cfgWidth}
                                disabled={!isHost}
                                title={hostOnlyTitle}
                                onInput={(e) => {
                                    const v = parseInt(e.currentTarget.value, 10);
                                    if (!isNaN(v)) {
                                        this.synced.cfgWidth = v;
                                        this.saveMenuConfig();
                                    }
                                }}
                                className={inputCls}
                            />
                            <span>x</span>
                            <input
                                type="number"
                                min="2"
                                max="10"
                                value={this.synced.cfgHeight}
                                disabled={!isHost}
                                title={hostOnlyTitle}
                                onInput={(e) => {
                                    const v = parseInt(e.currentTarget.value, 10);
                                    if (!isNaN(v)) {
                                        this.synced.cfgHeight = v;
                                        this.saveMenuConfig();
                                    }
                                }}
                                className={inputCls}
                            />
                        </div>
                    </div>

                    {(() => {
                        const inMultiplayer = gameState.isMultiplayer && !!gameState.gameId;
                        const isHost = !inMultiplayer || gameState.myPlayerIndex === gameState.hostPlayerIndex;
                        return (
                            <div className={css.vbox(4)}>
                                <div className={sectionTitle}>Mode{inMultiplayer && !isHost ? " (host only)" : ""}</div>
                                <select
                                    value={this.synced.cfgGameMode}
                                    disabled={!isHost}
                                    title={!isHost ? "Only the host can change this" : undefined}
                                    onChange={(e) => {
                                        this.synced.cfgGameMode = e.currentTarget.value as any;
                                        this.saveMenuConfig();
                                    }}
                                    className={css.fontSize(13).pad2(4, 6).fillWidth + ""}
                                >
                                    <option value="competitive">Competitive (race)</option>
                                    <option value="cooperative">Cooperative (shared, reach goal)</option>
                                    <option value="competitive-shared">Competitive shared (race, no double-picks)</option>
                                </select>
                            </div>
                        );
                    })()}

                    {(this.synced.cfgGameMode === "cooperative") ? (
                        <div className={css.vbox(4)}>
                            <div className={sectionTitle}>Coop Goal (% of points){hostOnlySuffix}</div>
                            <input
                                type="number"
                                min="5"
                                max="100"
                                value={this.synced.cfgCoopGoalPctStr}
                                disabled={!isHost}
                                title={hostOnlyTitle}
                                onInput={(e) => { this.synced.cfgCoopGoalPctStr = e.currentTarget.value; }}
                                onBlur={() => {
                                    const v = parseInt(this.synced.cfgCoopGoalPctStr, 10);
                                    const clamped = isNaN(v) ? this.synced.cfgCoopGoalPct : Math.max(5, Math.min(100, v));
                                    this.synced.cfgCoopGoalPctStr = String(clamped);
                                    if (clamped !== this.synced.cfgCoopGoalPct) {
                                        this.synced.cfgCoopGoalPct = clamped;
                                        this.saveMenuConfig();
                                    }
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                                }}
                                className={css.fontSize(13).pad2(4, 6).width(72) + ""}
                            />
                        </div>
                    ) : (
                        <div className={css.vbox(4)}>
                            <div className={sectionTitle}>Duration (s){hostOnlySuffix}</div>
                            <input
                                type="number"
                                min="10"
                                max="3600"
                                value={this.synced.cfgDurationStr}
                                disabled={!isHost}
                                title={hostOnlyTitle}
                                onInput={(e) => { this.synced.cfgDurationStr = e.currentTarget.value; }}
                                onBlur={() => {
                                    const v = parseInt(this.synced.cfgDurationStr, 10);
                                    const clamped = isNaN(v) ? Math.round(this.synced.cfgDuration / 1000) : Math.max(10, Math.min(3600, v));
                                    this.synced.cfgDurationStr = String(clamped);
                                    if (clamped * 1000 !== this.synced.cfgDuration) {
                                        this.synced.cfgDuration = clamped * 1000;
                                        gameState.gameDuration = clamped * 1000;
                                        if (gameState.status !== "playing") {
                                            gameState.timeRemaining = clamped * 1000;
                                        }
                                        this.saveMenuConfig();
                                    }
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                                }}
                                className={css.fontSize(13).pad2(4, 6).width(72) + ""}
                            />
                        </div>
                    )}

                    {(() => {
                        const inMultiplayer = gameState.isMultiplayer && !!gameState.gameId;
                        const isHost = !inMultiplayer || gameState.myPlayerIndex === gameState.hostPlayerIndex;
                        const showRem = this.synced.cfgShowRemaining;
                        const showTot = this.synced.cfgShowTotal;
                        return (
                            <div className={css.vbox(4)}>
                                <div className={sectionTitle}>Display{inMultiplayer && !isHost ? " (host only)" : ""}</div>
                                <label
                                    title={!isHost ? "Only the host can change this" : undefined}
                                    className={css.hbox(6).alignItems("center").fontSize(12) + (isHost ? css.cursor("pointer") : css.opacity(0.6))}
                                >
                                    <input
                                        type="checkbox"
                                        checked={showRem}
                                        disabled={!isHost}
                                        onChange={(e) => {
                                            this.synced.cfgShowRemaining = e.currentTarget.checked;
                                            this.saveMenuConfig();
                                        }}
                                    />
                                    <span>Remaining words per tile</span>
                                </label>
                                <label
                                    title={!isHost ? "Only the host can change this" : undefined}
                                    className={css.hbox(6).alignItems("center").fontSize(12) + (isHost ? css.cursor("pointer") : css.opacity(0.6))}
                                >
                                    <input
                                        type="checkbox"
                                        checked={showTot}
                                        disabled={!isHost}
                                        onChange={(e) => {
                                            this.synced.cfgShowTotal = e.currentTarget.checked;
                                            this.saveMenuConfig();
                                        }}
                                    />
                                    <span>Total possible score</span>
                                </label>
                                <label
                                    className={css.hbox(6).alignItems("center").fontSize(12).cursor("pointer") + ""}
                                    title="Drawing a word picks the highest-scoring path automatically"
                                >
                                    <input
                                        type="checkbox"
                                        checked={this.synced.cfgAutoBestPath}
                                        onChange={(e) => {
                                            this.synced.cfgAutoBestPath = e.currentTarget.checked;
                                            this.saveMenuConfig();
                                        }}
                                    />
                                    <span>Auto-pick highest-scoring path</span>
                                </label>
                            </div>
                        );
                    })()}

                    {this.synced.menuError && (
                        <div className={css.colorhsl(0, 70, 60).fontSize(12).pad2(6, 8).borderRadius(6).hsl(0, 30, 20)}>
                            {this.synced.menuError}
                        </div>
                    )}

                    <div className={css.vbox(4)}>
                        <div className={css.hbox(6).alignItems("center").justifyContent("space-between")}>
                            <div className={sectionTitle}>Board (letters or URL)</div>
                            <button
                                onClick={this.copyBoardText}
                                title="Copy a share link to this board"
                                className={css.fontSize(12).pad2(2, 8) + ""}
                            >
                                {this.synced.boardImportCopied ? "✓ Link copied" : "🔗 Copy link"}
                            </button>
                        </div>
                        <textarea
                            ref={(el) => { this.boardTextareaRef = el || undefined; }}
                            defaultValue={this.gridToText(gameState.grid)}
                            spellcheck={false}
                            rows={Math.max(4, gameState.gridHeight)}
                            placeholder={"ABCD\nEFGH\nIJKL\nMNOP\n\n…or paste a share URL"}
                            className={css.fontSize(14).pad2(6, 8).fillWidth
                                .fontFamily("monospace").textTransform("uppercase")
                                .hsl(240, 30, 8).colorhsl(0, 0, 100) + ""}
                            style={{
                                resize: "vertical",
                                letterSpacing: "2px",
                                lineHeight: "1.3",
                                border: "1px solid rgba(255,255,255,0.15)",
                                borderRadius: "6px",
                            }}
                        />
                        {this.synced.boardImportError && (
                            <div className={css.colorhsl(0, 70, 60).fontSize(11).pad2(2, 4) + ""}>
                                {this.synced.boardImportError}
                            </div>
                        )}
                        <button
                            onClick={() => { void this.importBoardFromText(); }}
                            disabled={gameState.isMultiplayer}
                            title={gameState.isMultiplayer ? "Cannot import board in multiplayer" : "Replace the current board"}
                            className={css.fontSize(13).pad2(6, 10) + ""}
                        >
                            Import board
                        </button>
                    </div>

                    <button
                        onClick={this.copyConfigFromLastGame}
                        title="Set your configuration to match the current/last game's settings"
                        className={css.fontSize(13).pad2(6, 10) + ""}
                    >
                        Copy settings from last game
                    </button>
                </div>
            </div>
        );
    }

    renderVoiceTranscript() {
        if (!this.synced.voiceModeOn && !this.synced.voiceLoading) return undefined;
        const tokens = this.synced.voiceTokens;
        const listening = this.synced.voiceTranscriptListening;
        if (!listening && tokens.length === 0) return undefined;
        const tokenColor = (status: VoiceTokenStatus) => {
            // Matched: solid green. Already-played: green at reduced
            // opacity. Pending and any "invalid" status just render at
            // full normal color (or low opacity for invalid). No
            // separate gray "tentative" tier — every word counts.
            if (status === "ok") return css.colorhsl(120, 60, 65) + "";
            if (status === "already") return css.colorhsl(120, 60, 65).opacity(0.45) + "";
            if (status === "pending") return css.colorhsl(0, 0, 95) + "";
            return css.colorhsl(0, 0, 95).opacity(0.35) + "";
        };
        const tokenTitle = (t: VoiceToken) => {
            if (t.status === "ok") return `+${t.points ?? 0}`;
            if (t.status === "not-word") return "Not a word";
            if (t.status === "not-on-board") return "Not on the board";
            if (t.status === "already") return "Already played";
            if (t.status === "pending") return "Checking…";
            return "Skipped";
        };
        return (
            <div className={css.fillWidth.fontSize(20).fontWeight("bold").pad2(10, 12).borderRadius(8)
                .hsl(240, 30, 18).colorhsl(0, 0, 100)
                + ""}
                style={{ border: "1px solid rgba(255,255,255,0.1)", lineHeight: "1.3" }}
            >
                {tokens.length === 0 ? (
                    <span className={css.colorhsl(60, 70, 70).fontStyle("italic") + ""}>Listening…</span>
                ) : (
                    <span>
                        {tokens.map((t, i) => (
                            <span key={i} title={tokenTitle(t)} className={tokenColor(t.status)}>
                                {i > 0 ? " " : ""}{t.word}
                                {t.status === "ok" && t.points !== undefined && (
                                    <span className={css.fontSize(13).opacity(0.7) + ""}> +{t.points}</span>
                                )}
                            </span>
                        ))}
                    </span>
                )}
            </div>
        );
    }

    renderMatchedWords() {
        const showPrefix = gameState.gameMode === "cooperative" && gameState.isMultiplayer;
        return (
            <div className={css.hbox(10, 6).wrap.alignContent("flex-start").alignItems("flex-start")
                .overflowAuto.fillBoth
                .hsl(240, 30, 15).borderRadius(8).pad2(12)
                .colorhsl(0, 0, 100)
            }>
                {gameState.matchedWords.slice().reverse().map((w, i) => {
                    const letter = typeof w.playerIndex === "number"
                        ? String.fromCharCode(65 + w.playerIndex)
                        : undefined;
                    const isYou = typeof w.playerIndex === "number"
                        && w.playerIndex === gameState.myPlayerIndex;
                    const blocked = w.blocked === true;
                    const isRecent = i === 0 && this.synced.recentAcceptedWord === w.word.toUpperCase();
                    return (
                        <div
                            key={isRecent ? `recent-${this.synced.recentAcceptedToken}` : `w-${gameState.matchedWords.length - 1 - i}`}
                            className={css.hbox(8).fontSize(18).alignItems("center") + (blocked ? css.opacity(0.55) : "") + (isRecent ? " word-reveal" : "")}
                            title={blocked ? "Already taken by another player" : undefined}
                        >
                            {showPrefix && letter && (
                                <span className={css.fontSize(13).fontWeight("bold")
                                    .pad2(1, 5).borderRadius(4)
                                    + (isYou ? css.hsl(120, 50, 35) : css.hsl(240, 20, 30))
                                }>
                                    {letter}
                                </span>
                            )}
                            <span style={blocked ? { textDecoration: "line-through", color: "rgba(255,140,140,0.85)" } : undefined}>
                                {w.word}
                            </span>
                            {!blocked && (
                                <span className={css.fontSize(14).opacity(0.7)}>{w.points}</span>
                            )}
                            {blocked && (
                                <span className={css.fontSize(11).opacity(0.7) + ""}>taken</span>
                            )}
                        </div>
                    );
                })}
            </div>
        );
    }

    render() {
        this.redraw();

        let timePercent = (gameState.timeRemaining / gameState.gameDuration) * 100;
        let timeBarHue = gameState.timeRemaining <= 5000 && 0 || gameState.timeRemaining <= 15000 && 60 || 120;

        return (
            <div
                className={css.fillBoth.vbox(0).relative
                    .justifyContent("center").alignItems("center")
                }
                style={{
                    paddingTop: `calc(${MARGIN_EMPTY_SIDE}px + env(safe-area-inset-top))`,
                    paddingBottom: `calc(${MARGIN_EMPTY_SIDE}px + env(safe-area-inset-bottom))`,
                    paddingLeft: `calc(${MARGIN_EMPTY_SIDE}px + env(safe-area-inset-left))`,
                    paddingRight: `calc(${MARGIN_EMPTY_SIDE}px + env(safe-area-inset-right))`,
                }}
            >
                {this.renderMenu()}
                {this.renderJoinPopup()}
                <style>{`
                    @keyframes pulseOut {
                        0% { 
                            transform: scale(1); 
                            opacity: 0.6;
                            border-width: 2px;
                        }
                        100% { 
                            transform: scale(1.2); 
                            opacity: 0;
                            border-width: 3px;
                        }
                    }
                    @keyframes floatUp {
                        0% { transform: translateY(0); opacity: 1; }
                        100% { transform: translateY(-40px); opacity: 0; }
                    }
                    .pulse-cell {
                        animation: pulseOut 600ms ease-out;
                        pointer-events: none;
                    }
                    .floating-score {
                        animation: floatUp 1000ms ease-out;
                    }
                    @keyframes fadeOut {
                        0% { opacity: 1; }
                        100% { opacity: 0; }
                    }
                    .timeout-fadeout {
                        animation: fadeOut ${TIMEOUT_FADEOUT_DURATION}ms ease-out forwards;
                    }
                    @keyframes peerFlash {
                        0% { opacity: 0; }
                        20% { opacity: 1; }
                        100% { opacity: 0; }
                    }
                    .peer-flash-cell {
                        animation: peerFlash ${PEER_FLASH_DURATION_MS}ms ease-out;
                        pointer-events: none;
                    }
                    @keyframes blockedFlash {
                        0% { opacity: 1; }
                        70% { opacity: 1; }
                        100% { opacity: 0; }
                    }
                    .blocked-flash-cell {
                        animation: blockedFlash 800ms ease-out forwards;
                        pointer-events: none;
                    }
                    @keyframes acceptedFlash {
                        0%   { opacity: 0;   transform: scale(0.85); }
                        25%  { opacity: 1;   transform: scale(1.05); }
                        70%  { opacity: 0.9; transform: scale(1); }
                        100% { opacity: 0;   transform: scale(1); }
                    }
                    .accepted-cell {
                        animation: acceptedFlash ${ACCEPTED_CELL_FLASH_MS}ms ease-out forwards;
                        pointer-events: none;
                    }
                    @keyframes wordReveal {
                        0%   { opacity: 0; transform: translateY(-12px) scale(0.7); max-height: 0; }
                        40%  { opacity: 1; transform: translateY(0)     scale(1.15); max-height: 80px; }
                        100% { opacity: 1; transform: translateY(0)     scale(1);    max-height: 80px; }
                    }
                    .word-reveal {
                        animation: wordReveal ${WORD_REVEAL_DURATION_MS}ms cubic-bezier(0.18, 0.9, 0.3, 1.2);
                        transform-origin: left center;
                    }
                    @keyframes scorePulse {
                        0%   { transform: scale(1);    color: rgba(255,255,255,1); text-shadow: 0 0 0 rgba(120,255,160,0); }
                        30%  { transform: scale(1.5);  color: rgb(160,255,190);    text-shadow: 0 0 14px rgba(120,255,160,0.95); }
                        100% { transform: scale(1);    color: rgba(255,255,255,1); text-shadow: 0 0 0 rgba(120,255,160,0); }
                    }
                    .score-pulse {
                        display: inline-block;
                        animation: scorePulse ${SCORE_PULSE_DURATION_MS}ms ease-out;
                        transform-origin: center;
                    }
                `}</style>
                <div className={css.fillBoth.vbox(SECTION_GAP).alignItems("center")}>
                    <div
                        className={css.vbox(6).alignItems("start").colorhsl(0, 0, 100).fillWidth}
                    >
                        {this.renderTimeAndScore(timeBarHue, timePercent)}
                        {gameState.isMultiplayer && (
                            <div className={css.hbox(12).alignItems("center").fillWidth}>
                                {this.renderConnectionStatus()}
                                <div style={{ flex: "1 1 0", minWidth: 0 }}>
                                    {this.renderPlayerScores()}
                                </div>
                            </div>
                        )}
                    </div>
                    <div
                        ref={this.setMidRef}
                        className={css.fillWidth.vbox(0).justifyContent("center").alignItems("center")}
                        style={{
                            flex: "1 1 0",
                            minHeight: 0,
                            touchAction: "none",
                            width: `calc(100% + ${MARGIN_EMPTY_SIDE * 2}px + env(safe-area-inset-left) + env(safe-area-inset-right))`,
                            marginLeft: `calc(-${MARGIN_EMPTY_SIDE}px - env(safe-area-inset-left))`,
                            marginRight: `calc(-${MARGIN_EMPTY_SIDE}px - env(safe-area-inset-right))`,
                        }}
                    >
                        {this.renderGrid()}
                    </div>
                    <div
                        className={css.fillWidth}
                        style={{ height: `${BOTTOM_HEIGHT_FRACTION * 100}%`, flex: "0 0 auto" }}
                    >
                        {this.renderMatchedWords()}
                    </div>
                </div>
            </div>
        );
    }
}
