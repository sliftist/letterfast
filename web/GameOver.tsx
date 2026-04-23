import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { GameOverState, gameHistory } from "./GameState";
import { sort } from "socket-function/src/misc";
import { observable } from "mobx";
import { analyzeWords, WordAnalysisResult } from "./WordAnalysis";
import { challengeURL } from "./Page";
import { isNode } from "typesafecss";
import { signPayload, getPublicKey } from "./CryptoIdentity";
import { getRPCClient } from "./rpcClient";
import { render } from "preact";

let modalRoot: HTMLDivElement | undefined;
let modalContainer: HTMLDivElement | undefined;

function showFullscreenModal(config: { contents: preact.VNode }) {
    if (!modalRoot) {
        modalRoot = document.createElement("div");
        modalRoot.id = "fullscreen-modal-root";
        document.body.appendChild(modalRoot);
    }

    if (modalContainer) {
        modalContainer.remove();
    }

    modalContainer = document.createElement("div");
    modalContainer.className = css.fixed.pos(0, 0).fillBoth
        .hsla(0, 0, 0, 0.8)
        .zIndex(10000)
        .overflowAuto + "";

    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const handleTouchMove = (e: TouchEvent) => {
        if (e.target === modalContainer) {
            e.preventDefault();
        }
    };

    modalContainer.addEventListener("touchmove", handleTouchMove, { passive: false });

    modalRoot.appendChild(modalContainer);
    render(config.contents, modalContainer);

    return () => {
        if (modalContainer) {
            modalContainer.removeEventListener("touchmove", handleTouchMove);
            modalContainer.remove();
            modalContainer = undefined;
        }
        document.body.style.overflow = originalOverflow;
        document.body.style.paddingRight = originalPaddingRight;
    };
}

function closeAllModals() {
    if (modalContainer) {
        modalContainer.remove();
        modalContainer = undefined;
    }
    document.body.style.overflow = "";
    document.body.style.paddingRight = "";
}

export function closeGameOverModal() {
    closeAllModals();
}

interface GameOverProps {
    state: GameOverState;
    onPlayAgain: () => void;
}

@observer
class GameOverComponent extends preact.Component<GameOverProps> {
    synced = observable({
        analysis: undefined as WordAnalysisResult | undefined,
        isLoading: true,
        challengeLinkCopied: false,
        challengeLinkCopyFailed: false,
        isMobile: false,
    });

    updateMobileState = () => {
        this.synced.isMobile = window.innerWidth <= 600;
    };

    async componentDidMount() {
        this.updateMobileState();
        window.addEventListener("resize", this.updateMobileState);

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

    componentWillUnmount() {
        window.removeEventListener("resize", this.updateMobileState);
    }

    copyToClipboard = async (text: string): Promise<boolean> => {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (error) {
            console.warn("navigator.clipboard.writeText failed:", error);
        }

        try {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.left = "-999999px";
            textArea.style.top = "-999999px";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();

            const successful = document.execCommand("copy");
            textArea.remove();

            if (successful) {
                return true;
            }
        } catch (error) {
            console.warn("execCommand copy failed:", error);
        }

        return false;
    };

    render() {
        const { state, onPlayAgain } = this.props;
        const sortedPlayers = sort(state.playerResults.slice(), p => -p.score);
        const winner = sortedPlayers[0];
        const isSinglePlayer = state.playerResults.length === 1;
        const isChallengeMode = state.playerResults.length === 2 && state.playerResults.some(p => p.id === "challenger");
        const selfPlayer = state.playerResults.find(p => p.isSelf);

        let commonWords: Set<string> | undefined;
        if (!isSinglePlayer && state.playerResults.length >= 2 && state.playerResults.every(p => p.matchedWords.length > 0)) {
            const perPlayerSets = state.playerResults.map(p => new Set(p.matchedWords.map(w => w.word.toUpperCase())));
            commonWords = new Set<string>();
            for (const word of perPlayerSets[0]) {
                if (perPlayerSets.every(s => s.has(word))) {
                    commonWords.add(word);
                }
            }
        }

        const outerPadding = this.synced.isMobile ? 0 : 40;
        const innerPadding = this.synced.isMobile ? 20 : 40;
        const borderRadius = this.synced.isMobile ? 0 : 12;

        return (
            <div className={css.fillBoth.vbox(20)
                .pad2(outerPadding)
                .colorhsl(0, 0, 100)
                .overflowAuto
                .hbox(0).justifyContent("center")
            }>
                <div
                    className={css.vbox(20).pad2(innerPadding)
                        .hsl(240, 40, 20)
                        .borderRadius(borderRadius).colorhsl(0, 0, 100)
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
                                Winner: {winner.isSelf ? "You" : winner.id === "challenger" ? "Challenger" : `Player ${state.playerResults.findIndex(p => p.id === winner.id) + 1}`}
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
                                                #{index + 1} {isMe ? "You" : player.id === "challenger" ? "Challenger" : `Player ${playerIndex + 1}`}
                                            </div>
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
                                                {sort(words.slice(), w => -w.points).map((w, i) => {
                                                    const isCommon = commonWords?.has(w.word.toUpperCase());
                                                    return (
                                                        <div key={i} className={css.fontSize(14)
                                                            .pad2(6, 4).borderRadius(4)
                                                            .hsl(120, 40, 30)
                                                            + (isCommon && css.opacity(0.4) || "")
                                                        }>
                                                            {w.word} ({w.points})
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    <button onClick={() => {
                        challengeURL.reset();
                        closeAllModals();
                        onPlayAgain();
                    }}>
                        Play Again
                    </button>

                    {selfPlayer && !isNode() && (
                        <button onClick={async () => {
                            const { gameState } = await import("./GameState");
                            const challengeId = crypto.randomUUID();
                            const publicKey = await getPublicKey();
                            const signature = await signPayload({ challengeId });

                            challengeURL.value = {
                                grid: state.grid,
                                challengerWords: selfPlayer.matchedWords,
                                challengerScore: selfPlayer.score,
                                totalPossibleWords: state.totalPossibleWords,
                                totalPossibleScore: state.totalPossibleScore,
                                gameDuration: gameState.gameDuration,
                                challengeId,
                                signature,
                                publicKey,
                            };
                            const url = window.location.origin + window.location.pathname + window.location.search;

                            const copySuccess = await this.copyToClipboard(url);

                            if (copySuccess) {
                                this.synced.challengeLinkCopied = true;
                                this.synced.challengeLinkCopyFailed = false;
                                setTimeout(() => {
                                    this.synced.challengeLinkCopied = false;
                                }, 2000);
                            } else {
                                this.synced.challengeLinkCopied = false;
                                this.synced.challengeLinkCopyFailed = true;
                                setTimeout(() => {
                                    this.synced.challengeLinkCopyFailed = false;
                                }, 3000);
                            }

                            try {
                                const rpc = getRPCClient();
                                await rpc.watchChallenge(
                                    challengeId,
                                    signature,
                                    publicKey,
                                    selfPlayer.score,
                                    selfPlayer.matchedWords,
                                    state.grid,
                                    state.totalPossibleScore,
                                    state.totalPossibleWords
                                );
                            } catch (error) {
                                console.error("Failed to watch challenge:", error);
                            }
                        }}>
                            {this.synced.challengeLinkCopied && "Copied!" || this.synced.challengeLinkCopyFailed && "Copy Failed" || "Challenge a Friend"}
                        </button>
                    )}

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
