import { observable, reaction, IReactionDisposer } from "mobx";
import { css, isNode } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import * as preact from "preact";
import { Anchor } from "sliftutils/render-utils/Anchor";
import { joinGameIdURL, challengeURL } from "./Page";
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
    cellCenter,
    getCellAt,
    isAdjacent,
    formatTime,
    getWordSet,
    cleanup,
    GridCell,
    changeGridSize,
    applySettings,
} from "./GameState";
import { getRPCClient, resetRPCClient } from "./rpcClient";
import { getSavedConfigOrDefaults, loadSavedConfig, saveConfig } from "./GameConfig";
import { ConnectionManager } from "./ConnectionManager";

const DEBUG_MODE = false;
const ENABLE_VIBRATION = true;
const BELOW_GRID_GAP = 12;
const WRONG_WORD_BASE_TIMEOUT = 1000;
const WRONG_WORD_TIMEOUT_INCREMENT = 100;
const MAX_WRONG_WORD_TIMEOUT = 3000;
const CANCEL_ZONE_SIZE = 80;
const TIMEOUT_FADEOUT_DURATION = 300;

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
) {
    let ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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
        timeoutFadingOut: false,
        wrongWordCells: [] as { row: number; col: number }[],
        linkCopied: false,
        isConverting: false,
        reconnectCountdown: 0,
        menuOpen: false,
        cfgWidth: 4,
        cfgHeight: 4,
        cfgDuration: 90000,
        cfgShowRemaining: false,
        cfgShowTotal: false,
        joinGameId: "",
        joining: false,
        menuError: undefined as string | undefined,
    });

    connectionManager: ConnectionManager | undefined;
    reconnectCountdownInterval: number | undefined;
    gridSizeReactionDisposer: IReactionDisposer | undefined;

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

    convertToMultiplayer = async () => {
        if (isNode()) return;

        this.synced.isConverting = true;

        try {
            const defaults = getSavedConfigOrDefaults();
            const rpc = getRPCClient();

            this.connectionManager = new ConnectionManager({
                connect: async () => {
                    resetRPCClient();
                    const newRpc = getRPCClient();
                    const { gameId } = await newRpc.createGame(16);
                    gameState.gameId = gameId;
                    gameState.isMultiplayer = true;

                    await newRpc.updateGameSettings(
                        gameId,
                        gameState.gridWidth,
                        gameState.gridHeight,
                        gameState.gameDuration,
                        gameState.showRemainingWordsPerCell,
                        gameState.showTotalPossibleScore
                    );

                    joinGameIdURL.value = gameId;

                    const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?page=game&join=${gameId}`;
                    window.history.pushState({}, "", newUrl);
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
                }
            });

            await this.connectionManager.connect();
        } catch (error) {
            console.error("Failed to convert to multiplayer:", error);
        } finally {
            this.synced.isConverting = false;
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
        this.synced.wrongWordCells = [{ row: 1, col: 0 }, { row: 1, col: 1 }];
        gameState.timeoutUntil = Date.now() + 5000;

        this.synced.linkCopied = true;

        this.redraw();
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

    copyShareLink = async () => {
        if (!gameState.gameId) return;

        try {
            const shareUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?page=game&join=${gameState.gameId}`;
            await navigator.clipboard.writeText(shareUrl);
            this.synced.linkCopied = true;
            setTimeout(() => {
                this.synced.linkCopied = false;
            }, 2000);
        } catch (error) {
            console.error("Failed to copy link:", error);
        }
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
        }
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
        } else {
            this.synced.cfgWidth = gameState.gridWidth;
            this.synced.cfgHeight = gameState.gridHeight;
            this.synced.cfgDuration = gameState.gameDuration;
        }
    };

    saveMenuConfig = () => {
        saveConfig({
            gridWidth: this.synced.cfgWidth,
            gridHeight: this.synced.cfgHeight,
            gameDuration: this.synced.cfgDuration,
            showRemainingWordsPerCell: this.synced.cfgShowRemaining,
            showTotalPossibleScore: this.synced.cfgShowTotal,
        });
        applySettings({
            showRemainingWordsPerCell: this.synced.cfgShowRemaining,
            showTotalPossibleScore: this.synced.cfgShowTotal,
        });
        if (gameState.isMultiplayer && gameState.gameId && gameState.myPlayerIndex === 0) {
            void (async () => {
                try {
                    const rpc = getRPCClient();
                    await rpc.updateGameSettings(
                        gameState.gameId!,
                        this.synced.cfgWidth,
                        this.synced.cfgHeight,
                        this.synced.cfgDuration,
                        this.synced.cfgShowRemaining,
                        this.synced.cfgShowTotal,
                    );
                } catch (error) {
                    console.error("Failed to push settings to server:", error);
                }
            })();
        }
    };

    applyConfigAndStart = async () => {
        const w = this.synced.cfgWidth;
        const h = this.synced.cfgHeight;
        if (w < 2 || w > 10 || h < 2 || h > 10) return;
        await changeGridSize({ width: w, height: h });
        gameState.gameDuration = this.synced.cfgDuration;
        gameState.timeRemaining = this.synced.cfgDuration;
        this.synced.menuOpen = false;
        await startGame();
    };

    onJoinGameFromMenu = async () => {
        if (!this.synced.joinGameId) {
            this.synced.menuError = "Please enter a game ID";
            return;
        }
        this.synced.joining = true;
        this.synced.menuError = undefined;
        try {
            gameState.gameId = this.synced.joinGameId.toUpperCase();
            gameState.isMultiplayer = true;
            joinGameIdURL.value = this.synced.joinGameId.toUpperCase();
            this.synced.menuOpen = false;
        } catch (error) {
            this.synced.menuError = error instanceof Error ? error.message : String(error);
        } finally {
            this.synced.joining = false;
        }
    };

    async componentDidMount() {
        this.loadMenuConfig();
        if (!isNode()) {
            this.calculateScale();

            this.gridSizeReactionDisposer = reaction(
                () => [gameState.gridWidth, gameState.gridHeight],
                () => this.calculateScale(),
            );

            window.addEventListener("keydown", this.onKeyDown);
            document.addEventListener("touchstart", this.preventGlobalTouch, { passive: false });
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

            const { getWordTrie, findAllWordsInGrid } = await import("./GridGenerator");
            const trie = await getWordTrie();
            const result = findAllWordsInGrid(challengeData.grid, trie);
            const cellToWords = new Map<string, Set<string>>();
            for (let [word, cells] of result.wordPaths) {
                let upperWord = word.toUpperCase();
                for (let cellKey of cells) {
                    let wordsSet = cellToWords.get(cellKey);
                    if (!wordsSet) {
                        wordsSet = new Set<string>();
                        cellToWords.set(cellKey, wordsSet);
                    }
                    wordsSet.add(upperWord);
                }
            }
            gameState.cellToWords = cellToWords;
            return;
        }

        const joinGameId = joinGameIdURL.value;
        if (joinGameId && !gameState.gameId) {
            try {
                gameState.gameId = joinGameId.toUpperCase();
                gameState.isMultiplayer = true;

                const { getSavedConfigOrDefaults } = await import("./GameConfig");
                const defaults = getSavedConfigOrDefaults();

                this.connectionManager = new ConnectionManager({
                    connect: async () => {
                        resetRPCClient();
                        const rpc = getRPCClient();
                        await rpc.joinGame(joinGameId.toUpperCase(), defaults.gridWidth, defaults.gridHeight, defaults.gameDuration);
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
                    }
                });

                await this.connectionManager.connect();
            } catch (error) {
                console.error("Failed to join game:", error);
            }
        }
    }

    componentWillUnmount() {
        cleanup();
        this.stopReconnectCountdown();
        if (this.gridSizeReactionDisposer) {
            this.gridSizeReactionDisposer();
            this.gridSizeReactionDisposer = undefined;
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
        redrawCanvas(canvas, this.synced.selectedCells, this.synced.currentPos, this.synced.debugPositions, gridSize);
    }

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
        if (gameState.status === "ready") {
            await startGame(false);
            this.synced.selectedCells = [];
            this.synced.pulseCells = [];
            this.synced.floatingScores = [];
            if (DEBUG_MODE) this.synced.debugPositions = [];
        }
        if (gameState.status !== "playing") return;
        if (Date.now() < gameState.timeoutUntil) return;
        this.synced.selectedCells = [];
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

    showWordAcceptedFeedback = (points: number) => {
        gameState.consecutiveWrongWords = 0;
        this.synced.pulseCells = this.synced.selectedCells.slice();
        setTimeout(() => {
            this.synced.pulseCells = [];
        }, 600);
        let scoreId = this.floatingScoreId++;
        this.synced.floatingScores.push({ id: scoreId, points, timestamp: Date.now() });
        setTimeout(() => {
            this.synced.floatingScores = this.synced.floatingScores.filter(s => s.id !== scoreId);
        }, 1000);
    };

    showWrongWordFeedback = () => {
        this.vibrateLong();
        gameState.consecutiveWrongWords++;
        const timeoutDuration = Math.min(WRONG_WORD_BASE_TIMEOUT + (gameState.consecutiveWrongWords - 1) * WRONG_WORD_TIMEOUT_INCREMENT, MAX_WRONG_WORD_TIMEOUT);
        gameState.timeoutUntil = Date.now() + timeoutDuration;
        this.synced.showTimeoutMessage = true;
        this.synced.timeoutFadingOut = false;
        this.synced.timeoutMessage = "Not a word!";
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
            this.showWrongWordFeedback();
            return;
        }

        if (gameState.isMultiplayer) {
            if (!isNode() && gameState.gameId) {
                const rpc = getRPCClient();
                const result = await rpc.submitWord(gameState.gameId, word.toUpperCase(), this.synced.selectedCells);
                if (result.points > 0) {
                    const upperWord = word.toUpperCase();
                    gameState.matchedWords.push({ word: upperWord, points: result.points });
                    gameState.matchedWordsSet.add(upperWord);
                    this.showWordAcceptedFeedback(result.points);
                }
            }
            return;
        }

        const upperWord = word.toUpperCase();
        if (gameState.matchedWordsSet.has(upperWord)) return;

        let points = calculateWordScore(this.synced.selectedCells);
        gameState.score += points;
        gameState.matchedWords.push({ word: upperWord, points });
        gameState.matchedWordsSet.add(upperWord);
        this.showWordAcceptedFeedback(points);

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
        return (
            <div className={css.hbox(10).alignItems("center").fillWidth}>
                <div className={css.vbox(4)}>
                    <div className={css.fontSize(28).width(90).textAlign("center")}>
                        {formatTime(gameState.timeRemaining)}
                    </div>
                    <div className={css.width(90).height(4).hsl(0, 0, 30).borderRadius(2).relative.overflowHidden}>
                        <div
                            className={css.absolute.pos(0, 0).height(4).hsl(timeBarHue, 70, 50).borderRadius(2) + ""}
                            style={{ width: `${timePercent}%`, transition: "width 0.1s linear" }}
                        />
                    </div>
                </div>
                <div className={css.hbox(6).alignItems("center").relative
                    .pad2(4, 10).borderRadius(8)
                    .hsl(240, 30, 15)
                }
                    style={{ border: "1px solid rgba(255,255,255,0.15)" }}
                >
                    <span className={css.fontSize(20)}>🏆</span>
                    <span className={css.fontSize(20).fontWeight("bold")}>{gameState.score}</span>
                    {gameState.showTotalPossibleScore && gameState.totalPossibleScore > 0 && (
                        <span className={css.fontSize(13).colorhsl(0, 0, 70) + ""}>
                            / {gameState.totalPossibleScore}
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
                <button
                    onClick={() => { this.synced.menuOpen = !this.synced.menuOpen; }}
                    title="Menu"
                    className={css.fontSize(24).pad2(4, 10) + ""}
                    style={{ marginLeft: "auto" }}
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
        return (
            <div className={css.hbox(10).wrap.colorhsl(0, 0, 100)}>
                {gameState.players.map((p, index) => {
                    const letter = String.fromCharCode(65 + index);
                    const isYou = index === gameState.myPlayerIndex;
                    return (
                        <div key={p.id} className={css.hbox(3).alignItems("center").fontSize(14)}>
                            {isYou && <span title="You">👤</span>}
                            <span className={css.fontWeight("bold") + ""}>{letter}</span>
                            <span>{p.score}</span>
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
        const startLabel = gameState.status === "ready" && "▶️ Start Game"
            || gameState.status === "playing" && "▶️ Restart"
            || "▶️ Play Again";
        const closeAfter = (fn: () => unknown | Promise<unknown>) => async () => {
            this.synced.menuOpen = false;
            await fn();
        };
        return (
            <>
                {!gameState.isMultiplayer && (
                    <button onClick={closeAfter(() => startGame())} className={btn}>
                        {startLabel}
                    </button>
                )}
                {gameState.status === "playing" && !gameState.isMultiplayer && (
                    <button onClick={closeAfter(() => endGame())} className={btn}>
                        ⏹️ End Now
                    </button>
                )}
                {!gameState.isMultiplayer && (
                    <button
                        onClick={closeAfter(() => this.convertToMultiplayer())}
                        disabled={this.synced.isConverting}
                        className={btn}
                    >
                        {this.synced.isConverting && "👥 Converting…" || "👥 Convert to Multiplayer"}
                    </button>
                )}
                {!gameState.isMultiplayer && (
                    <button
                        onClick={closeAfter(() => this.enterTestMode())}
                        className={btn}
                    >
                        🧪 Test Mode
                    </button>
                )}
                {gameState.isMultiplayer && (
                    <>
                        <button
                            onClick={this.copyShareLink}
                            className={css.hsl(120, 60, 40).fontSize(16).pad2(10, 14).fillWidth.textAlign("left") + ""}
                        >
                            {this.synced.linkCopied && "✓ Copied!" || "🔗 Copy Link"}
                        </button>
                        <button
                            onClick={closeAfter(() => this.leaveMultiplayer())}
                            className={css.hsl(0, 60, 40).fontSize(16).pad2(10, 14).fillWidth.textAlign("left") + ""}
                        >
                            🚪 Leave Multiplayer
                        </button>
                    </>
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
                    {(Date.now() < gameState.timeoutUntil || this.synced.showTimeoutMessage) && (
                        <div
                            className={css.absolute.pos(0, 0).fillBoth
                                .hsla(0, 0, 0, 0.7).hbox(0).justifyContent("center")
                                .borderRadius(8)
                                + (this.synced.timeoutFadingOut && " timeout-fadeout" || "")
                            }
                        >
                            <div
                                className={css.fontSize(24).fontWeight("bold")
                                    .colorhsl(0, 0, 100).pad2(20)
                                    .hsl(0, 0, 10).borderRadius(8)
                                }
                            >
                                {this.synced.timeoutMessage}
                            </div>
                        </div>
                    )}
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
                    {gameState.status === "finished" && (
                        <div
                            title="Click to play again"
                            className={css.absolute.pos(0, 0).fillBoth
                                .hbox(0).justifyContent("center")
                                .borderRadius(8).cursor("pointer")
                            }
                            onClick={async () => await startGame()}
                        />
                    )}
                </div>
            </div>
        );
    }

    renderMenu() {
        if (!this.synced.menuOpen) return undefined;
        const inputCls = css.fontSize(13).pad2(4, 6).width(48) + "";
        const sectionTitle = css.fontSize(12).fontWeight("bold").colorhsl(0, 0, 70) + "";
        return (
            <div
                className={css.absolute.pos(0, 0).fillBoth.hsla(0, 0, 0, 0.6)
                    .hbox(0).justifyContent("end")
                }
                style={{ zIndex: 100 }}
                onClick={() => { this.synced.menuOpen = false; }}
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

                    {!gameState.isMultiplayer && (
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
                                onClick={this.onJoinGameFromMenu}
                                disabled={this.synced.joining}
                                className={css.fontSize(13).pad2(4, 8) + ""}
                            >
                                {this.synced.joining && "…" || "Join"}
                            </button>
                        </div>
                    )}

                    {gameState.isMultiplayer && gameState.gameId && (
                        <div className={css.vbox(2)
                            .pad2(6, 8).borderRadius(6)
                            .hsl(240, 30, 18)
                        }>
                            <div className={css.fontSize(10).colorhsl(0, 0, 70)}>Game Code</div>
                            <div className={css.fontSize(18).fontWeight("bold").fontFamily("monospace")
                                .letterSpacing("2px")
                            }>
                                {gameState.gameId}
                            </div>
                        </div>
                    )}

                    <div className={css.vbox(4)}>
                        {this.renderMenuButtons()}
                    </div>

                    <div className={css.vbox(4)}>
                        <div className={sectionTitle}>Grid Size (2-10)</div>
                        <div className={css.hbox(6).alignItems("center")}>
                            <input
                                type="number"
                                min="2"
                                max="10"
                                value={this.synced.cfgWidth}
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
                                onInput={(e) => {
                                    const v = parseInt(e.currentTarget.value, 10);
                                    if (!isNaN(v)) {
                                        this.synced.cfgHeight = v;
                                        this.saveMenuConfig();
                                    }
                                }}
                                className={inputCls}
                            />
                            <button
                                onClick={async () => await this.applyConfigAndStart()}
                                className={css.fontSize(12).pad2(4, 8) + ""}
                            >
                                Start
                            </button>
                        </div>
                    </div>

                    <div className={css.vbox(4)}>
                        <div className={sectionTitle}>Duration (s)</div>
                        <input
                            type="number"
                            min="10"
                            max="3600"
                            value={Math.round(this.synced.cfgDuration / 1000)}
                            onInput={(e) => {
                                const v = parseInt(e.currentTarget.value, 10);
                                if (!isNaN(v) && v >= 10 && v <= 3600) {
                                    this.synced.cfgDuration = v * 1000;
                                    this.saveMenuConfig();
                                }
                            }}
                            className={css.fontSize(13).pad2(4, 6).width(72) + ""}
                        />
                    </div>

                    {(() => {
                        const inMultiplayer = gameState.isMultiplayer && !!gameState.gameId;
                        const isHost = !inMultiplayer || gameState.myPlayerIndex === 0;
                        const showRem = inMultiplayer ? gameState.showRemainingWordsPerCell : this.synced.cfgShowRemaining;
                        const showTot = inMultiplayer ? gameState.showTotalPossibleScore : this.synced.cfgShowTotal;
                        return (
                            <div className={css.vbox(4)}>
                                <div className={sectionTitle}>Display{inMultiplayer && !isHost ? " (host only)" : ""}</div>
                                <label className={css.hbox(6).alignItems("center").fontSize(12) + (isHost ? css.cursor("pointer") : css.opacity(0.6))}>
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
                                <label className={css.hbox(6).alignItems("center").fontSize(12) + (isHost ? css.cursor("pointer") : css.opacity(0.6))}>
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
                            </div>
                        );
                    })()}

                    {this.synced.menuError && (
                        <div className={css.colorhsl(0, 70, 60).fontSize(12).pad2(6, 8).borderRadius(6).hsl(0, 30, 20)}>
                            {this.synced.menuError}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    renderMatchedWords() {
        return (
            <div className={css.vbox(6).overflowAuto.fillBoth
                .hsl(240, 30, 15).borderRadius(8).pad2(12)
                .colorhsl(0, 0, 100)
            }>
                {gameState.matchedWords.slice().reverse().map((w, i) => (
                    <div key={i} className={css.hbox(8).fontSize(18)}>
                        <span>{w.word}</span>
                        <span className={css.fontSize(14).opacity(0.7)}>
                            {w.points}
                        </span>
                    </div>
                ))}
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
                `}</style>
                <div className={css.fillBoth.vbox(SECTION_GAP).alignItems("center")}>
                    <div
                        className={css.vbox(6).alignItems("start").colorhsl(0, 0, 100).fillWidth}
                    >
                        {this.renderTimeAndScore(timeBarHue, timePercent)}
                        {gameState.isMultiplayer && (
                            <div className={css.hbox(12).wrap.alignItems("center")}>
                                {this.renderConnectionStatus()}
                                {this.renderPlayerScores()}
                            </div>
                        )}
                    </div>
                    <div
                        ref={this.setMidRef}
                        className={css.fillWidth.vbox(0).justifyContent("center").alignItems("center")}
                        style={{ flex: "1 1 0", minHeight: 0 }}
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
