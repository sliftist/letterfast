import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { GameOverState, gameHistory } from "./GameState";
import { sort } from "socket-function/src/misc";
import { showFullscreenModal } from "sliftutils/render-utils/FullscreenModal";
import { closeAllModals } from "sliftutils/render-utils/modal";
import { observable } from "mobx";
import { analyzeWords, WordAnalysisResult } from "./WordAnalysis";

interface GameOverProps {
    state: GameOverState;
    onPlayAgain: () => void;
}

@observer
class GameOverComponent extends preact.Component<GameOverProps> {
    synced = observable({
        analysis: undefined as WordAnalysisResult | undefined,
        isLoading: true,
    });

    async componentDidMount() {
        const selfPlayer = this.props.state.playerResults.find(p => p.isSelf);
        if (selfPlayer) {
            const analysis = await analyzeWords({
                grid: this.props.state.grid,
                foundWords: selfPlayer.matchedWords,
            });
            this.synced.analysis = analysis;
            this.synced.isLoading = false;
        } else {
            this.synced.isLoading = false;
        }
    }

    render() {
        const { state, onPlayAgain } = this.props;
        const sortedPlayers = sort(state.playerResults.slice(), p => -p.score);
        const winner = sortedPlayers[0];
        const isSinglePlayer = state.playerResults.length === 1;
        const selfPlayer = state.playerResults.find(p => p.isSelf);

        return (
            <div className={css.fillBoth.vbox(20)
                .pad2(40)
                .colorhsl(0, 0, 100)
                .overflowAuto
                .hbox(0).justifyContent("center")
            }>
                <div
                    className={css.vbox(20).pad2(40)
                        .hsl(240, 40, 20)
                        .borderRadius(12).colorhsl(0, 0, 100)
                        .boxShadow("0 10px 50px rgba(0, 0, 0, 0.5)")
                    }
                    style={{
                        border: "3px solid transparent",
                        backgroundImage: "linear-gradient(#2a1a4a, #2a1a4a), linear-gradient(135deg, #00d4ff, #ff00d4)",
                        backgroundOrigin: "border-box",
                        backgroundClip: "padding-box, border-box",
                    }}
                >
                    <div className={css.fontSize(32).fontWeight("bold").textAlign("center")}>
                        Game Over!
                    </div>

                    {!isSinglePlayer && winner && (
                        <div className={css.vbox(8).textAlign("center")}>
                            <div className={css.fontSize(24)}>
                                Winner: Player {state.playerResults.findIndex(p => p.id === winner.id) + 1}
                            </div>
                            <div className={css.fontSize(20).opacity(0.7)}>
                                {winner.score} Score ({state.totalPossibleScore > 0 ? Math.round(winner.score / state.totalPossibleScore * 100) : 0}%)
                            </div>
                        </div>
                    )}

                    {isSinglePlayer && selfPlayer && (
                        <div className={css.vbox(8)}>
                            <div className={css.fontSize(24)}>
                                {selfPlayer.score} Score ({state.totalPossibleScore > 0 ? Math.round(selfPlayer.score / state.totalPossibleScore * 100) : 0}%) | {selfPlayer.matchedWords.length} Words ({state.totalPossibleWords > 0 ? Math.round(selfPlayer.matchedWords.length / state.totalPossibleWords * 100) : 0}%)
                            </div>
                        </div>
                    )}

                    <div className={css.vbox(16)}>
                        {!isSinglePlayer && (
                            <div className={css.fontSize(24).fontWeight("bold")}>
                                Final Scores
                            </div>
                        )}
                        {sortedPlayers.map((player, index) => {
                            const playerIndex = state.playerResults.findIndex(p => p.id === player.id);
                            const isMe = player.isSelf;
                            const words = player.matchedWords;

                            return (
                                <div
                                    key={player.id}
                                    className={css.vbox(12).pad2(16).borderRadius(8)
                                        + (isMe
                                            ? css.hsl(240, 50, 25)
                                            : css.hsl(240, 30, 20)
                                        )
                                    }
                                >
                                    <div className={css.hbox(12).alignItems("center")}>
                                        {!isSinglePlayer && (
                                            <div className={css.fontSize(20).fontWeight("bold")}>
                                                #{index + 1} Player {playerIndex + 1}
                                            </div>
                                        )}
                                        {isMe && !isSinglePlayer && (
                                            <span className={css.opacity(0.7)}>(You)</span>
                                        )}
                                        {!isSinglePlayer && (
                                            <div className={css.fontSize(18).fontWeight("bold").marginLeft("auto")}>
                                                {player.score} Score ({state.totalPossibleScore > 0 ? Math.round(player.score / state.totalPossibleScore * 100) : 0}%) | {words.length} Words ({state.totalPossibleWords > 0 ? Math.round(words.length / state.totalPossibleWords * 100) : 0}%)
                                            </div>
                                        )}
                                    </div>

                                    {isSinglePlayer && !this.synced.isLoading && this.synced.analysis && (
                                        <div className={css.vbox(16)}>
                                            {this.synced.analysis.commonMissedWords.length > 0 && (
                                                <div className={css.vbox(8)}>
                                                    <div className={css.fontSize(20).fontWeight("bold").opacity(0.5)}>
                                                        Common Missed Words
                                                    </div>
                                                    <div className={css.hbox(8).wrap}>
                                                        {this.synced.analysis.commonMissedWords.map((w, i) => (
                                                            <div key={i} className={css.fontSize(14)
                                                                .pad2(6, 4).borderRadius(4)
                                                                .hsl(240, 40, 30).opacity(0.5)
                                                            }>
                                                                {w.word} ({w.points})
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {this.synced.analysis.valuableMissedWords.length > 0 && (
                                                <div className={css.vbox(8)}>
                                                    <div className={css.fontSize(20).fontWeight("bold").opacity(0.5)}>
                                                        Most Valuable Missed Words
                                                    </div>
                                                    <div className={css.hbox(8).wrap}>
                                                        {this.synced.analysis.valuableMissedWords.map((w, i) => (
                                                            <div key={i} className={css.fontSize(14)
                                                                .pad2(6, 4).borderRadius(4)
                                                                .hsl(240, 40, 30).opacity(0.5)
                                                            }>
                                                                {w.word} ({w.points})
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {this.synced.analysis.nearMissWords.length > 0 && (
                                                <div className={css.vbox(8)}>
                                                    <div className={css.fontSize(20).fontWeight("bold").opacity(0.5)}>
                                                        Near Miss Opportunities
                                                    </div>
                                                    <div className={css.hbox(8).wrap}>
                                                        {this.synced.analysis.nearMissWords.map((w, i) => (
                                                            <div key={i} className={css.fontSize(14)
                                                                .pad2(6, 4).borderRadius(4)
                                                                .hsl(240, 40, 30).opacity(0.5)
                                                            }>
                                                                {w.word} ({w.points})
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {words.length > 0 && (
                                        <div className={css.vbox(6)}>
                                            <div className={css.fontSize(isSinglePlayer ? 20 : 16).fontWeight("bold").colorhsl(120, 60, 60)}>
                                                {isSinglePlayer ? "Words You Found" : `Words`} ({words.length}):
                                            </div>
                                            <div className={css.hbox(8).wrap.overflowAuto.maxHeight(200)}>
                                                {sort(words.slice(), w => -w.points).map((w, i) => (
                                                    <div key={i} className={css.fontSize(14)
                                                        .pad2(6, 4).borderRadius(4)
                                                        .hsl(120, 40, 30)
                                                    }>
                                                        {w.word} ({w.points})
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    <button onClick={() => {
                        closeAllModals();
                        onPlayAgain();
                    }}>
                        Play Again
                    </button>

                    {isSinglePlayer && gameHistory.length > 0 && (
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
        );
    }
}

export function showGameOver(state: GameOverState, onPlayAgain: () => void) {
    showFullscreenModal({
        contents: <GameOverComponent state={state} onPlayAgain={onPlayAgain} />
    });
}
