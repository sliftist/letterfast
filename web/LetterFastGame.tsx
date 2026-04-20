import { observable } from "mobx";
import { css, isNode } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import * as preact from "preact";
import { Anchor } from "sliftutils/render-utils/Anchor";
import { pageURL, joinGameIdURL, challengeURL } from "./Page";
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
} from "./GameState";
import { getRPCClient, resetRPCClient } from "./rpcClient";
import { getSavedConfigOrDefaults, saveConfig } from "./GameConfig";
import { ConnectionManager } from "./ConnectionManager";

const DEBUG_MODE = false;
const ENABLE_VIBRATION = true;
const GRID_TO_WORDS_GAP = 20;
const CURRENT_WORD_HEIGHT = 32;
const BELOW_GRID_GAP = 12;
const WRONG_WORD_BASE_TIMEOUT = 1000;
const WRONG_WORD_TIMEOUT_INCREMENT = 100;
const MAX_WRONG_WORD_TIMEOUT = 3000;
const CANCEL_ZONE_SIZE = 80;
const TIMEOUT_FADEOUT_DURATION = 300;

const MARGIN_EMPTY_SIDE = 20;
const MIN_SPACE_CONTENT_AXIS_NORMAL = 500;
const MIN_SPACE_CONTENT_AXIS_PORTRAIT = 200;
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
        // default is portrait
        isRotated: false,
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
    });

    connectionManager: ConnectionManager | undefined;
    reconnectCountdownInterval: number | undefined;

    preventGlobalTouch = (e: TouchEvent) => {
        if (e.touches.length > 1) {
            e.preventDefault();
        }
    };

    preventGlobalTouchMove = (e: TouchEvent) => {
        e.preventDefault();
    };

    onFullscreenChange = () => {
        this.synced.isFullscreen = !!document.fullscreenElement;
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

    async toggleFullscreen() {
        if (!isNode()) {
            if (!document.fullscreenElement) {
                await document.documentElement.requestFullscreen();
            } else {
                await document.exitFullscreen();
            }
        }
    }

    calculateScale = () => {
        if (isNode()) return;

        const containerWidth = window.innerWidth;
        const containerHeight = window.innerHeight;

        this.synced.isRotated = containerWidth < containerHeight * 0.75;

        const gridSize = getCurrentGridSize();
        const gridNaturalWidth = CELL_SIZE * gridSize.width + CELL_GAP * (gridSize.width - 1);
        const gridNaturalHeight = CELL_SIZE * gridSize.height + CELL_GAP * (gridSize.height - 1);

        this.synced.totalWidth = gridNaturalWidth;
        this.synced.totalHeight = gridNaturalHeight;

        let availableWidth: number;
        let availableHeight: number;

        if (this.synced.isRotated) {
            availableWidth = containerWidth - (MARGIN_EMPTY_SIDE * 2);
            availableHeight = containerHeight - MIN_SPACE_CONTENT_AXIS_PORTRAIT;
        } else {
            availableWidth = containerWidth - MIN_SPACE_CONTENT_AXIS_NORMAL;
            availableHeight = containerHeight - (MARGIN_EMPTY_SIDE * 2);
        }

        console.log({ availableWidth, availableHeight });

        const scaleWidth = availableWidth / gridNaturalWidth;
        const scaleHeight = availableHeight / gridNaturalHeight;
        const scaleFactor = Math.min(scaleWidth, scaleHeight);

        this.synced.scale = Math.max(0.3, scaleFactor);
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
                        gameState.gameDuration
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

    async componentDidMount() {
        if (!isNode()) {
            this.calculateScale();

            window.addEventListener("resize", this.calculateScale);
            window.addEventListener("keydown", this.onKeyDown);
            document.addEventListener("touchstart", this.preventGlobalTouch, { passive: false });
            document.addEventListener("touchmove", this.preventGlobalTouchMove, { passive: false });
            document.addEventListener("fullscreenchange", this.onFullscreenChange);
            this.synced.isFullscreen = !!document.fullscreenElement;
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
        if (this.connectionManager) {
            this.connectionManager.cleanup();
            this.connectionManager = undefined;
        }
        if (!isNode()) {
            window.removeEventListener("resize", this.calculateScale);
            window.removeEventListener("keydown", this.onKeyDown);
            window.removeEventListener("mousemove", this.onGlobalMouseMove);
            window.removeEventListener("touchmove", this.onGlobalTouchMove, { passive: false } as any);
            window.removeEventListener("mouseup", this.onGlobalMouseUp);
            window.removeEventListener("touchend", this.onGlobalTouchEnd, { passive: false } as any);
            document.removeEventListener("touchstart", this.preventGlobalTouch);
            document.removeEventListener("touchmove", this.preventGlobalTouchMove);
            document.removeEventListener("fullscreenchange", this.onFullscreenChange);
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

        let cancelZoneX: number;
        let cancelZoneY: number;
        if (this.synced.isRotated) {
            cancelZoneX = this.synced.totalWidth - CANCEL_ZONE_SIZE;
            cancelZoneY = this.synced.totalHeight + BELOW_GRID_GAP + CURRENT_WORD_HEIGHT;
        } else {
            cancelZoneX = this.synced.totalWidth + GRID_TO_WORDS_GAP;
            cancelZoneY = this.synced.totalHeight - CANCEL_ZONE_SIZE;
        }
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

        if (word.length <= 1) return;

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
            <>
                <div className={css.vbox(4)}>
                    <div className={css.fontSize(32).width(100).textAlign("center")}>
                        {formatTime(gameState.timeRemaining)}
                    </div>
                    <div className={css.width(100).height(4).hsl(0, 0, 30).borderRadius(2).relative.overflowHidden}>
                        <div
                            className={css.absolute.pos(0, 0).height(4).hsl(timeBarHue, 70, 50).borderRadius(2) + ""}
                            style={{ width: `${timePercent}%`, transition: "width 0.1s linear" }}
                        />
                    </div>
                </div>
                <div className={css.fontSize(20).relative}>
                    Score: {gameState.score}
                    {this.synced.floatingScores.map(fs => (
                        <div
                            key={fs.id}
                            className={css.absolute.pos(-30, 30).fontSize(24).fontWeight("bold")
                                .colorhsl(120, 70, 60) + " floating-score"}
                        >
                            +{fs.points}
                        </div>
                    ))}
                    {/* 
                    <span className={css.fontSize(14).colorhsl(0, 0, 70)}>
                        Window: {isNode() ? "N/A" : `${window.innerWidth}x${window.innerHeight}`}
                    </span> */}
                </div>
            </>
        );
    }

    renderPlayerScores() {
        if (gameState.isChallengeMode && gameState.challengerData) {
            return (
                <div className={css.vbox(4)}>
                    <div className={css.fontSize(14).colorhsl(0, 0, 100)}>
                        Challenger: {gameState.challengerData.score}
                    </div>
                </div>
            );
        }
        if (!gameState.isMultiplayer || gameState.players.length === 0) return undefined;
        return (
            <div className={css.vbox(6)}>
                <div className={css.fontSize(16).fontWeight("bold").colorhsl(0, 0, 100)}>
                    Players
                </div>
                {gameState.players.map((p, index) => (
                    <div key={p.id} className={css.hbox(6).fontSize(14).colorhsl(0, 0, 100)}>
                        {index === 0 && <span>👑</span>}
                        <span>Player {index + 1}: {p.score}</span>
                        {index === gameState.myPlayerIndex && <span className={css.opacity(0.7)}>(You)</span>}
                    </div>
                ))}
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

    renderButtons() {
        return (
            <>
                <button onClick={async () => await startGame()}>
                    {gameState.status === "ready" && "Start Game"}
                    {gameState.status === "playing" && "Restart"}
                    {gameState.status === "finished" && "Play Again"}
                </button>
                {gameState.status === "playing" && (
                    <button onClick={() => endGame()}>
                        End Now
                    </button>
                )}
                {gameState.status === "ready" && !gameState.isMultiplayer && (
                    <button onClick={async () => {
                        const defaults = { gridWidth: 4, gridHeight: 4, gameDuration: 90000 };
                        await changeGridSize({ width: defaults.gridWidth, height: defaults.gridHeight });
                        gameState.gameDuration = defaults.gameDuration;
                        gameState.timeRemaining = defaults.gameDuration;
                        saveConfig(defaults);
                    }}>
                        Default
                    </button>
                )}
                <button onClick={() => this.toggleFullscreen()}>
                    {this.synced.isFullscreen && "Exit Fullscreen" || "Fullscreen"}
                </button>
                {!gameState.isMultiplayer && (
                    <button onClick={() => {
                        pageURL.value = "config";
                    }}>
                        Settings
                    </button>
                )}
                {gameState.isMultiplayer && (
                    <>
                        <button
                            onClick={this.copyShareLink}
                            className={css.hsl(120, 60, 40) + ""}
                        >
                            {this.synced.linkCopied && "Copied!" || "Copy Link"}
                        </button>
                        <button
                            onClick={this.leaveMultiplayer}
                            className={css.hsl(0, 60, 40) + ""}
                        >
                            Leave Multiplayer
                        </button>
                    </>
                )}
            </>
        );
    }

    renderMultiplayerButton() {
        if (gameState.isMultiplayer) return undefined;
        return (
            <button
                onClick={this.convertToMultiplayer}
                disabled={this.synced.isConverting}
                className={css.hsl(200, 60, 40) + ""}
            >
                {this.synced.isConverting && "Converting..." || "Convert to Multiplayer"}
            </button>
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
                                left: this.synced.isRotated && `${this.synced.totalWidth - CANCEL_ZONE_SIZE}px` || `${this.synced.totalWidth + GRID_TO_WORDS_GAP}px`,
                                top: this.synced.isRotated && `${this.synced.totalHeight + BELOW_GRID_GAP + CURRENT_WORD_HEIGHT}px` || `${this.synced.totalHeight - CANCEL_ZONE_SIZE}px`,
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

    renderCurrentWord(currentWord: string) {
        return (
            <div className={css.fontSize(16).height(20).colorhsl(0, 0, 100)
                .fontWeight("bold")
            }>
                {currentWord}
            </div>
        );
    }

    renderMatchedWords() {
        return (
            <div className={css.vbox(12).colorhsl(0, 0, 100) + (this.synced.isRotated && css.fillWidth || css.width(250))}>
                <div className={css.vbox(6).overflowAuto.fillWidth
                    .hsl(240, 30, 15).borderRadius(8).pad2(12)
                    + (this.synced.isRotated && css.height(150) || css.height(this.synced.totalHeight))
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
            </div>
        );
    }

    render() {
        let currentWord = (this.synced.wrongWordCells.length > 0 && this.synced.wrongWordCells || this.synced.selectedCells)
            .map(c => gameState.grid[c.row][c.col].letter)
            .join(" ");

        this.redraw();

        let timePercent = (gameState.timeRemaining / gameState.gameDuration) * 100;
        let timeBarHue = gameState.timeRemaining <= 5000 && 0 || gameState.timeRemaining <= 15000 && 60 || 120;

        return (
            <div
                className={css.fillBoth.vbox(0)
                    .justifyContent("center").alignItems("center")
                }
                style={{
                    paddingTop: `calc(${MARGIN_EMPTY_SIDE}px + env(safe-area-inset-top))`,
                    paddingBottom: `calc(${MARGIN_EMPTY_SIDE}px + env(safe-area-inset-bottom))`,
                    paddingLeft: `calc(${MARGIN_EMPTY_SIDE}px + env(safe-area-inset-left))`,
                    paddingRight: `calc(${MARGIN_EMPTY_SIDE}px + env(safe-area-inset-right))`,
                }}
            >
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
                <div className={css.vbox(4)
                    + (this.synced.isRotated && css.width(this.synced.totalWidth * this.synced.scale))
                    + (!this.synced.isRotated && css.height(this.synced.totalHeight * this.synced.scale))
                }>
                    {this.synced.isRotated && (
                        <>
                            <div className={css.vbox(2).alignItems("start").colorhsl(0, 0, 100)}>
                                {this.renderTimeAndScore(timeBarHue, timePercent)}
                                <div className={css.vbox(2)}>
                                    <div className={css.hbox(12).wrap}>
                                        {this.renderButtons()}
                                    </div>
                                    {!gameState.isMultiplayer && (
                                        <div className={css.hbox(12).wrap}>
                                            {this.renderMultiplayerButton()}
                                        </div>
                                    )}
                                    {gameState.isMultiplayer && (
                                        <div className={css.hbox(20).wrap}>
                                            {this.renderConnectionStatus()}
                                            {this.renderPlayerScores()}
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className={
                                css.vbox(6)

                            }>
                                {this.renderGrid()}
                                {this.renderCurrentWord(currentWord)}
                            </div>
                            {this.renderMatchedWords()}
                        </>
                    )}
                    {!this.synced.isRotated && (
                        <>
                            <div className={css.hbox(20).center}>
                                <div className={css.vbox(20).alignItems("end").colorhsl(0, 0, 100)}>
                                    {this.renderTimeAndScore(timeBarHue, timePercent)}
                                    <div className={css.vbox(5).alignItems("end")}>
                                        {this.renderButtons()}
                                        {!gameState.isMultiplayer && (
                                            <>
                                                {this.renderMultiplayerButton()}
                                            </>
                                        )}
                                        {gameState.isMultiplayer && (
                                            <>
                                                {this.renderConnectionStatus()}
                                                {this.renderPlayerScores()}
                                            </>
                                        )}
                                    </div>
                                </div>
                                <div className={css.vbox(12)}>
                                    {this.renderGrid()}
                                    {this.renderCurrentWord(currentWord)}
                                </div>
                                {this.renderMatchedWords()}
                            </div>
                        </>
                    )}
                </div>
            </div>
        );
    }
}
