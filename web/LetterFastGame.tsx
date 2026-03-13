import { observable } from "mobx";
import { css, isNode } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import * as preact from "preact";
import { sort } from "socket-function/src/misc";
import { Anchor } from "sliftutils/render-utils/Anchor";
import { pageURL, joinGameIdURL } from "./Page";
import {
    CELL_SIZE,
    CELL_GAP,
    HIT_SIZE,
    GAME_DURATION,
    gameState,
    gameHistory,
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
} from "./GameState";
import { getRPCClient } from "./rpcClient";

const DEBUG_MODE = false;
const ENABLE_VIBRATION = true;
const VIEWPORT_MARGIN_BASE = 20;
const VIEWPORT_MARGIN_REFERENCE_SIZE = 1000;
const PORTRAIT_ROTATION_THRESHOLD = 0.75;
const OUTER_PADDING = 20;
const MATCHED_WORDS_WIDTH = 250;
const GRID_TO_WORDS_GAP = 20;
const HEADER_GAP = 20;
const HEADER_HEIGHT_ESTIMATE = 50;
const CURRENT_WORD_HEIGHT = 32;
const BELOW_GRID_GAP = 12;
const WRONG_WORD_BASE_TIMEOUT = 1000;
const WRONG_WORD_TIMEOUT_INCREMENT = 100;
const MAX_WRONG_WORD_TIMEOUT = 3000;
const CANCEL_ZONE_SIZE = 80;
const TIMEOUT_FADEOUT_DURATION = 300;
const BUTTONS_ROW_HEIGHT_ESTIMATE = 50;
const MATCHED_WORDS_HEIGHT_PORTRAIT = 150;

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
        isRotated: false,
        debugPositions: [] as { x: number; y: number }[],
        isFullscreen: false,
        showCancelZone: false,
        isOverCancelZone: false,
        showTimeoutMessage: false,
        timeoutMessage: "",
        timeoutFadingOut: false,
        wrongWordCells: [] as { row: number; col: number }[],
    });

    updateScaling = () => {
        if (isNode()) return;

        const aspectRatio = window.innerWidth / window.innerHeight;
        this.synced.isRotated = aspectRatio < PORTRAIT_ROTATION_THRESHOLD;

        const minViewportSize = Math.min(window.innerWidth, window.innerHeight);
        const viewportMargin = (minViewportSize / VIEWPORT_MARGIN_REFERENCE_SIZE) * VIEWPORT_MARGIN_BASE;

        const gridSize = getCurrentGridSize();
        const gridNaturalWidth = CELL_SIZE * gridSize.width + CELL_GAP * (gridSize.width - 1);
        const gridNaturalHeight = CELL_SIZE * gridSize.height + CELL_GAP * (gridSize.height - 1);

        let contentNaturalWidth: number;
        let contentNaturalHeight: number;

        if (this.synced.isRotated) {
            contentNaturalWidth = Math.max(gridNaturalWidth, MATCHED_WORDS_WIDTH);
            contentNaturalHeight = HEADER_HEIGHT_ESTIMATE + HEADER_GAP + BUTTONS_ROW_HEIGHT_ESTIMATE + HEADER_GAP + gridNaturalHeight + BELOW_GRID_GAP + CURRENT_WORD_HEIGHT + HEADER_GAP + MATCHED_WORDS_HEIGHT_PORTRAIT;
        } else {
            contentNaturalWidth = gridNaturalWidth + GRID_TO_WORDS_GAP + MATCHED_WORDS_WIDTH;
            contentNaturalHeight = HEADER_HEIGHT_ESTIMATE + HEADER_GAP + gridNaturalHeight + BELOW_GRID_GAP + CURRENT_WORD_HEIGHT;
        }

        let availableWidth = window.innerWidth - (viewportMargin * 2);
        let availableHeight = window.innerHeight - (viewportMargin * 2);

        const scaleWidth = availableWidth / contentNaturalWidth;
        const scaleHeight = availableHeight / contentNaturalHeight;

        const scaleFactor = Math.min(scaleWidth, scaleHeight);

        this.synced.scale = Math.max(0.3, scaleFactor);
    };

    onResize = () => {
        this.updateScaling();
    };

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

    cancelSelection = () => {
        this.synced.drawing = false;
        this.synced.currentPos = undefined;
        this.synced.selectedCells = [];
        this.synced.showCancelZone = false;
        this.synced.isOverCancelZone = false;
        if (DEBUG_MODE) this.synced.debugPositions = [];
        this.redraw();
    };

    onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && this.synced.drawing) {
            this.cancelSelection();
        }
    };

    async componentDidMount() {
        this.updateScaling();

        if (!isNode()) {
            window.addEventListener("resize", this.onResize);
            window.addEventListener("keydown", this.onKeyDown);
            document.addEventListener("touchstart", this.preventGlobalTouch, { passive: false });
            document.addEventListener("touchmove", this.preventGlobalTouchMove, { passive: false });
            document.addEventListener("fullscreenchange", this.onFullscreenChange);
            this.synced.isFullscreen = !!document.fullscreenElement;
        }

        const joinGameId = joinGameIdURL.value;
        if (joinGameId && !gameState.gameId) {
            try {
                const { getSavedConfigOrDefaults } = await import("./GameConfig");
                const defaults = getSavedConfigOrDefaults();
                const rpc = getRPCClient();
                await rpc.joinGame(joinGameId.toUpperCase(), defaults.gridWidth, defaults.gridHeight, defaults.gameDuration);
                gameState.gameId = joinGameId.toUpperCase();
                gameState.isMultiplayer = true;
                pageURL.value = "lobby";
            } catch (error) {
                console.error("Failed to join game:", error);
            }
        }
    }

    componentWillUnmount() {
        cleanup();
        if (!isNode()) {
            window.removeEventListener("resize", this.onResize);
            window.removeEventListener("keydown", this.onKeyDown);
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

    handleSelectionStart = (pos: { x: number; y: number }) => {
        if (gameState.status === "ready") {
            startGame(false);
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
    };

    onMouseDown = (e: MouseEvent) => {
        let pos = this.getRelativePos(e);
        this.handleSelectionStart(pos);
    };

    handleSelectionMove = (pos: { x: number; y: number }) => {
        if (!this.synced.drawing || gameState.status !== "playing") return;
        this.synced.currentPos = pos;
        if (DEBUG_MODE) this.synced.debugPositions.push(pos);

        const gridSize = getCurrentGridSize();
        const totalWidth = CELL_SIZE * gridSize.width + CELL_GAP * (gridSize.width - 1);
        const totalHeight = CELL_SIZE * gridSize.height + CELL_GAP * (gridSize.height - 1);
        let cancelZoneX: number;
        let cancelZoneY: number;
        if (this.synced.isRotated) {
            cancelZoneX = totalWidth - CANCEL_ZONE_SIZE;
            cancelZoneY = totalHeight + BELOW_GRID_GAP + CURRENT_WORD_HEIGHT;
        } else {
            cancelZoneX = totalWidth + GRID_TO_WORDS_GAP;
            cancelZoneY = totalHeight - CANCEL_ZONE_SIZE;
        }
        const wasOverCancel = this.synced.isOverCancelZone;
        this.synced.isOverCancelZone = pos.x >= cancelZoneX && pos.x <= cancelZoneX + CANCEL_ZONE_SIZE && pos.y >= cancelZoneY && pos.y <= cancelZoneY + CANCEL_ZONE_SIZE;

        if (this.synced.isOverCancelZone && !wasOverCancel) {
            this.vibrate();
        }

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
                    gameState.matchedWords.push({ word: word.toUpperCase(), points: result.points });
                    this.showWordAcceptedFeedback(result.points);
                }
            }
            return;
        }

        let alreadyMatched = gameState.matchedWords.some(m => m.word === word.toUpperCase());
        if (alreadyMatched) return;

        let points = calculateWordScore(this.synced.selectedCells);
        gameState.score += points;
        gameState.matchedWords.push({ word: word.toUpperCase(), points });
        this.showWordAcceptedFeedback(points);
    };

    handleSelectionEnd = async () => {
        if (!this.synced.drawing) return;
        if (gameState.status !== "playing") return;

        this.synced.drawing = false;
        this.synced.currentPos = undefined;
        this.synced.showCancelZone = false;

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
        this.handleSelectionStart(pos);
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
                <div className={css.fontSize(24).relative}>
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
                </div>
            </>
        );
    }

    renderPlayerScores() {
        if (!gameState.isMultiplayer || gameState.players.length <= 1) return undefined;
        return (
            <div className={css.vbox(4)}>
                {gameState.players
                    .map((p, index) => ({ p, index }))
                    .filter(({ index }) => index !== gameState.myPlayerIndex)
                    .map(({ p, index }) => (
                        <div key={p.id} className={css.fontSize(14)}>
                            👤 {p.score}
                        </div>
                    ))}
            </div>
        );
    }

    renderButtons() {
        return (
            <>
                {!gameState.isMultiplayer && (
                    <>
                        <button onClick={() => startGame()}>
                            {gameState.status === "ready" && "Start Game"}
                            {gameState.status === "playing" && "Restart"}
                            {gameState.status === "finished" && "Play Again"}
                        </button>
                        {gameState.status === "playing" && (
                            <button onClick={() => endGame()}>
                                End Now
                            </button>
                        )}
                        <button onClick={() => this.toggleFullscreen()}>
                            {this.synced.isFullscreen && "Exit Fullscreen" || "Enter Fullscreen"}
                        </button>
                        <button onClick={() => {
                            pageURL.value = "config";
                        }}>
                            Back to Menu
                        </button>
                    </>
                )}
                {gameState.isMultiplayer && (
                    <>
                        <button onClick={() => this.toggleFullscreen()}>
                            {this.synced.isFullscreen && "Exit Fullscreen" || "Enter Fullscreen"}
                        </button>
                        <button onClick={() => {
                            pageURL.value = "lobby";
                        }}>
                            Back to Lobby
                        </button>
                    </>
                )}
            </>
        );
    }

    renderGrid(totalWidth: number, totalHeight: number, gridSize: { width: number; height: number }) {
        return (
            <div
                ref={elem => { this.wrapper = elem || undefined; }}
                className={css.relative.size(totalWidth, totalHeight).userSelect("none")}
                style={{ touchAction: "none" }}
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
                    className={css.absolute.pos(0, 0).size(totalWidth, totalHeight)}
                    style={{ display: "grid", gridTemplateColumns: `repeat(${gridSize.width}, ${CELL_SIZE}px)`, gap: `${CELL_GAP}px` }}
                >
                    {gameState.grid.map((row, ri) =>
                        row.map((cell, ci) => {
                            let isSelected = this.isCellSelected(ri, ci);
                            let isPulsing = this.isCellPulsing(ri, ci);
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
                        elem.width = totalWidth;
                        elem.height = totalHeight;
                        this.redraw();
                    }}
                    className={css.absolute.pos(0, 0).size(totalWidth, totalHeight)}
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
                            left: this.synced.isRotated && `${totalWidth - CANCEL_ZONE_SIZE}px` || `${totalWidth + GRID_TO_WORDS_GAP}px`,
                            top: this.synced.isRotated && `${totalHeight + BELOW_GRID_GAP + CURRENT_WORD_HEIGHT}px` || `${totalHeight - CANCEL_ZONE_SIZE}px`,
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
        );
    }

    renderCurrentWord(currentWord: string) {
        return (
            <div className={css.fontSize(22).height(32).colorhsl(0, 0, 100)
                .fontWeight("bold")
            }>
                {currentWord}
            </div>
        );
    }

    renderMatchedWords(totalHeight: number) {
        return (
            <div className={css.vbox(12).colorhsl(0, 0, 100) + (this.synced.isRotated && css.fillWidth || css.width(250))}>
                <div className={css.vbox(6).overflowAuto.fillWidth
                    .hsl(240, 30, 15).borderRadius(8).pad2(12)
                    + (this.synced.isRotated && css.height(MATCHED_WORDS_HEIGHT_PORTRAIT) || css.height(totalHeight))
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
        let gridSize = getCurrentGridSize();
        let totalWidth = CELL_SIZE * gridSize.width + CELL_GAP * (gridSize.width - 1);
        let totalHeight = CELL_SIZE * gridSize.height + CELL_GAP * (gridSize.height - 1);
        let currentWord = (this.synced.wrongWordCells.length > 0 && this.synced.wrongWordCells || this.synced.selectedCells)
            .map(c => gameState.grid[c.row][c.col].letter)
            .join(" ");

        this.redraw();

        let timePercent = (gameState.timeRemaining / gameState.gameDuration) * 100;
        let timeBarHue = gameState.timeRemaining <= 5000 && 0 || gameState.timeRemaining <= 15000 && 60 || 120;

        return (
            <div className={css.fillBoth.vbox(20)
                .pad2(20).justifyContent("center").alignItems("center")
            }>
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
                <div
                    className={css.vbox(20)}
                    style={{
                        transform: `scale(${this.synced.scale})`,
                        transformOrigin: "center center"
                    }}
                >
                    {this.synced.isRotated && (
                        <>
                            <div className={css.hbox(20).alignItems("center").colorhsl(0, 0, 100)}>
                                {this.renderTimeAndScore(timeBarHue, timePercent)}
                                {this.renderPlayerScores()}
                            </div>
                            <div className={css.hbox(12).wrap.colorhsl(0, 0, 100)}>
                                {this.renderButtons()}
                            </div>
                            <div className={css.vbox(12)}>
                                {this.renderGrid(totalWidth, totalHeight, gridSize)}
                                {this.renderCurrentWord(currentWord)}
                            </div>
                            {this.renderMatchedWords(totalHeight)}
                        </>
                    )}
                    {!this.synced.isRotated && (
                        <>
                            <div className={css.hbox(20).alignItems("center").colorhsl(0, 0, 100)}>
                                {this.renderTimeAndScore(timeBarHue, timePercent)}
                                {this.renderButtons()}
                                {this.renderPlayerScores()}
                            </div>
                            <div className={css.hbox(20).alignItems("start")}>
                                <div className={css.vbox(12)}>
                                    {this.renderGrid(totalWidth, totalHeight, gridSize)}
                                    {this.renderCurrentWord(currentWord)}
                                </div>
                                {this.renderMatchedWords(totalHeight)}
                            </div>
                        </>
                    )}
                </div>
                {gameState.status === "finished" && !gameState.isMultiplayer && (
                    <div
                        className={css.fixed.pos(0, 0).fillBoth
                            .hsla(0, 0, 0, 0.85).hbox(0).justifyContent("center")
                        }
                        onClick={() => startGame()}
                    >
                        <div
                            className={css.vbox(20).pad2(40)
                                .hsl(240, 40, 20)
                                .borderRadius(12).marginAuto.colorhsl(0, 0, 100)
                                .boxShadow("0 10px 50px rgba(0, 0, 0, 0.5)")
                            }
                            style={{
                                border: "3px solid transparent",
                                backgroundImage: "linear-gradient(#2a1a4a, #2a1a4a), linear-gradient(135deg, #00d4ff, #ff00d4)",
                                backgroundOrigin: "border-box",
                                backgroundClip: "padding-box, border-box",
                            }}
                        >
                            <div className={css.fontSize(32)}>Game Over!</div>
                            <div className={css.vbox(8)}>
                                <div className={css.fontSize(24)}>
                                    Final Score: {gameState.score}
                                </div>
                                <div className={css.fontSize(18)}>
                                    Words Found: {gameState.matchedWords.length}
                                </div>
                            </div>
                            {gameState.matchedWords.length > 0 && (
                                <div className={css.vbox(6).overflowAuto.maxHeight(300)}>
                                    <div className={css.fontSize(18)}>Words:</div>
                                    {sort(gameState.matchedWords.slice(), w => -w.points).map((w, i) => (
                                        <div key={i} className={css.hbox(12).fontSize(16)}>
                                            <span>{w.word}</span>
                                            <span className={css.opacity(0.7)}>
                                                {w.points} pts
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <button onClick={() => startGame()}>
                                Play Again
                            </button>
                            {gameHistory.length > 0 && (
                                <div className={css.vbox(8)}>
                                    <div className={css.fontSize(20)}>History</div>
                                    {gameHistory.slice(-5).reverse().map((h, i) => (
                                        <div key={i} className={css.hbox(12).fontSize(14)}>
                                            <span>{h.score} pts</span>
                                            <span>{h.wordsFound} words</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        );
    }
}
