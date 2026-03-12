import { observable } from "mobx";
import { css } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import * as preact from "preact";
import { sort } from "socket-function/src/misc";
import { Anchor } from "sliftutils/render-utils/Anchor";
import { pageURL } from "./Page";
import {
    CELL_SIZE,
    CELL_GAP,
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
} from "./GameState";

function redrawCanvas(
    canvas: HTMLCanvasElement,
    selectedCells: { row: number; col: number }[],
    currentPos: { x: number; y: number } | undefined,
) {
    let ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
    });

    componentWillUnmount() {
        cleanup();
    }

    getRelativePos(e: MouseEvent): { x: number; y: number } {
        let wrapper = this.wrapper;
        if (!wrapper) throw new Error(`Expected wrapper to be mounted`);
        let rect = wrapper.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    redraw() {
        let canvas = this.canvas;
        if (!canvas) return;
        redrawCanvas(canvas, this.synced.selectedCells, this.synced.currentPos);
    }

    isCellSelected(row: number, col: number) {
        return this.synced.selectedCells.some(c => c.row === row && c.col === col);
    }

    isCellPulsing(row: number, col: number) {
        return this.synced.pulseCells.some(c => c.row === row && c.col === col);
    }

    onMouseDown = (e: MouseEvent) => {
        if (gameState.status === "ready") {
            startGame(false);
            this.synced.selectedCells = [];
            this.synced.pulseCells = [];
            this.synced.floatingScores = [];
        }
        if (gameState.status !== "playing") return;
        let pos = this.getRelativePos(e);
        this.synced.selectedCells = [];
        this.synced.drawing = true;
        this.synced.currentPos = pos;
        let cell = getCellAt(pos);
        if (cell) this.synced.selectedCells.push(cell);
        this.redraw();
    };

    onMouseMove = (e: MouseEvent) => {
        if (!this.synced.drawing || gameState.status !== "playing") return;
        let pos = this.getRelativePos(e);
        this.synced.currentPos = pos;
        let cell = getCellAt(pos);
        if (cell && !this.isCellSelected(cell.row, cell.col)) {
            let cells = this.synced.selectedCells;
            let last = cells[cells.length - 1];
            if (!last || isAdjacent(last, cell)) {
                this.synced.selectedCells.push(cell);
            }
        }
        this.redraw();
    };

    onMouseUp = () => {
        if (!this.synced.drawing || gameState.status !== "playing") return;
        this.synced.drawing = false;
        this.synced.currentPos = undefined;
        let word = this.synced.selectedCells
            .map(c => gameState.grid[c.row][c.col].letter)
            .join("")
            .toLowerCase();
        if (word.length > 1 && getWordSet().has(word)) {
            let alreadyMatched = gameState.matchedWords.some(m => m.word === word.toUpperCase());
            if (!alreadyMatched) {
                let points = calculateWordScore(this.synced.selectedCells);
                gameState.score += points;
                gameState.matchedWords.push({ word: word.toUpperCase(), points });
                this.synced.pulseCells = this.synced.selectedCells.slice();
                setTimeout(() => {
                    this.synced.pulseCells = [];
                }, 600);
                let scoreId = this.floatingScoreId++;
                this.synced.floatingScores.push({ id: scoreId, points, timestamp: Date.now() });
                setTimeout(() => {
                    this.synced.floatingScores = this.synced.floatingScores.filter(s => s.id !== scoreId);
                }, 1000);
            }
        }
        this.synced.selectedCells = [];
        this.redraw();
    };

    onMouseLeave = () => {
        this.synced.drawing = false;
        this.synced.currentPos = undefined;
        this.synced.selectedCells = [];
        this.redraw();
    };

    render() {
        let gridSize = getCurrentGridSize();
        let totalWidth = CELL_SIZE * gridSize.width + CELL_GAP * (gridSize.width - 1);
        let totalHeight = CELL_SIZE * gridSize.height + CELL_GAP * (gridSize.height - 1);
        let currentWord = this.synced.selectedCells
            .map(c => gameState.grid[c.row][c.col].letter)
            .join(" ");

        this.redraw();

        let timePercent = (gameState.timeRemaining / GAME_DURATION) * 100;

        return (
            <div className={css.fillBoth.vbox(20)
                .background("linear-gradient(135deg, #1a0b2e 0%, #2d1b69 50%, #1a0b2e 100%)")
                .pad2(20)
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
                `}</style>
                <div className={css.hbox(20).alignItems("center").colorhsl(0, 0, 100)}>
                    <div className={css.vbox(4)}>
                        <div className={css.fontSize(32).width(100).textAlign("center")}>
                            {formatTime(gameState.timeRemaining)}
                        </div>
                        <div className={css.width(100).height(4).hsl(0, 0, 30).borderRadius(2).relative.overflowHidden}>
                            <div
                                className={css.absolute.pos(0, 0).height(4).hsl(0, 180, 50).borderRadius(2) + ""}
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
                    <Anchor params={[[pageURL, "config"]]}>
                        <button>Change Game</button>
                    </Anchor>
                </div>
                <div className={css.hbox(20).alignItems("start")}>
                    <div className={css.vbox(12)}>
                        <div
                            ref={elem => { this.wrapper = elem || undefined; }}
                            className={css.relative.size(totalWidth, totalHeight).userSelect("none")}
                            onMouseDown={this.onMouseDown as any}
                            onMouseMove={this.onMouseMove as any}
                            onMouseUp={this.onMouseUp}
                            onMouseLeave={this.onMouseLeave}
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
                                                    + (isSelected
                                                        ? css.hsl(240, 50, 10).colorhsl(0, 0, 100)
                                                            .background("linear-gradient(135deg, rgba(0,200,255,0.3) 0%, rgba(255,0,200,0.3) 100%), #0a0a1f")
                                                        : css.hsl(0, 0, 95).colorhsl(0, 0, 0)
                                                    )
                                                }
                                                style={{
                                                    border: isSelected ? "3px solid transparent" : "3px solid #ddd",
                                                    backgroundImage: isSelected ? "linear-gradient(#0a0a1f, #0a0a1f), linear-gradient(135deg, #00d4ff, #ff00d4)" : undefined,
                                                    backgroundOrigin: "border-box",
                                                    backgroundClip: isSelected ? "padding-box, border-box" : undefined,
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
                                                            + (cell.multiplier === 2
                                                                ? css.hsl(190, 80, 50)
                                                                : css.hsl(45, 90, 55)
                                                            )
                                                        }
                                                    >
                                                        {cell.multiplier}W
                                                    </div>
                                                )}
                                                <div
                                                    className={css.absolute.pos(CELL_SIZE - 18, 6)
                                                        .fontSize(12).fontWeight("normal")
                                                        + (isSelected ? css.colorhsl(0, 0, 70) : css.colorhsl(0, 0, 40))
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
                        </div>
                        <div className={css.fontSize(22).height(32).colorhsl(0, 0, 100)
                            .fontWeight("bold")
                        }>
                            {currentWord}
                        </div>
                    </div>
                    <div className={css.vbox(12).colorhsl(0, 0, 100)}>
                        <div className={css.fontSize(20).fontWeight("bold")}>
                            Matched Words ({gameState.matchedWords.length})
                        </div>
                        <div className={css.vbox(6).overflowAuto.height(totalHeight)
                            .hsl(240, 30, 15).borderRadius(8).pad2(12)
                        }>
                            {gameState.matchedWords.map((w, i) => (
                                <div key={i} className={css.hbox(8).fontSize(18)}>
                                    <span>{w.word}</span>
                                    <span className={css.fontSize(14).opacity(0.7)}>
                                        {w.points}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                {gameState.status === "finished" && (
                    <div
                        className={css.fixed.pos(0, 0).fillBoth
                            .hsla(0, 0, 0, 0.85).hbox(0).justifyContent("center")
                        }
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
                                    {sort(gameState.matchedWords, w => -w.points).map((w, i) => (
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
