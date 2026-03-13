import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { gameState } from "./GameState";
import { sort } from "socket-function/src/misc";
import { pageURL } from "./Page";

@observer
export class GameResults extends preact.Component {
    render() {
        const { players, allWords, myPlayerIndex } = gameState;
        const myPlayerId = players[myPlayerIndex ?? -1]?.id;

        const sortedPlayers = sort(players, p => -p.score);
        const winner = sortedPlayers[0];

        return (
            <div className={css.fillBoth.vbox(20)
                .pad2(40)
                .colorhsl(0, 0, 100)
                .overflowAuto
            }>
                <div className={css.vbox(20)}>
                    <div className={css.fontSize(32).fontWeight("bold").textAlign("center")}>
                        Game Over!
                    </div>

                    {winner && (
                        <div className={css.vbox(8).textAlign("center")}>
                            <div className={css.fontSize(24)}>
                                Winner: Player {players.findIndex(p => p.id === winner.id) + 1}
                            </div>
                            <div className={css.fontSize(20).opacity(0.7)}>
                                Score: {winner.score}
                            </div>
                        </div>
                    )}

                    <div className={css.vbox(16)}>
                        <div className={css.fontSize(24).fontWeight("bold")}>
                            Final Scores
                        </div>
                        {sortedPlayers.map((player, index) => {
                            const playerIndex = players.findIndex(p => p.id === player.id);
                            const isMe = player.id === myPlayerId;
                            const words = allWords[player.id] || [];

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
                                        <div className={css.fontSize(20).fontWeight("bold")}>
                                            #{index + 1} Player {playerIndex + 1}
                                        </div>
                                        {isMe && (
                                            <span className={css.opacity(0.7)}>(You)</span>
                                        )}
                                        <div className={css.fontSize(24).fontWeight("bold").marginLeft("auto")}>
                                            {player.score}
                                        </div>
                                    </div>

                                    {words.length > 0 && (
                                        <div className={css.vbox(6)}>
                                            <div className={css.fontSize(16).opacity(0.7)}>
                                                Words ({words.length}):
                                            </div>
                                            <div className={css.hbox(8).wrap}>
                                                {words.map((w, i) => (
                                                    <div key={i} className={css.fontSize(14)
                                                        .pad2(6, 4).borderRadius(4)
                                                        .hsl(240, 40, 30)
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

                    <button
                        onClick={() => {
                            pageURL.value = "";
                        }}
                        className={css.fontSize(20).pad2(16, 12) + ""}
                    >
                        Back to Menu
                    </button>
                </div>
            </div>
        );
    }
}

