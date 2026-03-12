import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { multiplayerState } from "./GameState";
import { pageURL } from "./Page";
import { getRPCClient } from "./rpcClient";
import { observable } from "mobx";

@observer
export class GameLobby extends preact.Component {
    synced = observable({
        copied: false,
    });

    componentDidMount() {
        if (!multiplayerState.gameId) {
            pageURL.value = "";
        }
    }

    onStartGame = async () => {
        if (!multiplayerState.gameId) return;
        const rpc = getRPCClient();
        await rpc.startGame(multiplayerState.gameId);
    };

    onCopyShareLink = async () => {
        if (!multiplayerState.gameId) return;
        const url = new URL(window.location.href);
        url.searchParams.set("join", multiplayerState.gameId);
        await navigator.clipboard.writeText(url.toString());
        this.synced.copied = true;
        setTimeout(() => {
            this.synced.copied = false;
        }, 2000);
    };

    render() {
        const { gameId, myPlayerIndex, players, status, countdown } = multiplayerState;

        if (!gameId) {
            return <div className={css.pad2(20)}>No game ID</div>;
        }

        const isHost = myPlayerIndex === 0;
        const playerCount = players.length;

        return (
            <div className={css.fillBoth.vbox(20)
                .background("linear-gradient(135deg, #1a0b2e 0%, #2d1b69 50%, #1a0b2e 100%)")
                .pad2(40)
                .colorhsl(0, 0, 100)
            }>
                <div className={css.vbox(12)}>
                    <div className={css.fontSize(32).fontWeight("bold")}>
                        Game Lobby
                    </div>
                    <div className={css.vbox(8)}>
                        <div className={css.fontSize(20)}>
                            Game ID: <span className={css.fontSize(28).fontWeight("bold")}>{gameId}</span>
                        </div>
                        <div className={css.fontSize(16).opacity(0.7)}>
                            Share this ID with other players
                        </div>
                        <button
                            onClick={this.onCopyShareLink}
                            className={css.fontSize(16).pad2(12, 8) + ""}
                        >
                            {this.synced.copied && "Copied!"}
                            {!this.synced.copied && "Copy Share Link"}
                        </button>
                    </div>
                </div>

                {status === "countdown" && (
                    <div className={css.fontSize(48).fontWeight("bold").textAlign("center")}>
                        Starting in {countdown}...
                    </div>
                )}

                {status === "waiting" && (
                    <div className={css.vbox(16)}>
                        <div className={css.fontSize(24).fontWeight("bold")}>
                            Players ({playerCount})
                        </div>
                        <div className={css.vbox(8)}>
                            {players.map((player, index) => (
                                <div key={player.id} className={css.hbox(12).fontSize(18)
                                    .pad2(12).borderRadius(8)
                                    .hsl(240, 30, 20)
                                }>
                                    <span className={css.fontWeight("bold")}>
                                        Player {index + 1}
                                    </span>
                                    {index === myPlayerIndex && (
                                        <span className={css.opacity(0.7)}>(You)</span>
                                    )}
                                    {index === 0 && (
                                        <span className={css.opacity(0.7)}>(Host)</span>
                                    )}
                                </div>
                            ))}
                        </div>

                        {isHost && (
                            <button
                                onClick={this.onStartGame}
                                className={css.fontSize(20).pad2(16, 12) + ""}
                            >
                                Start Game
                            </button>
                        )}

                        {!isHost && (
                            <div className={css.fontSize(18).opacity(0.7).textAlign("center")}>
                                Waiting for host to start the game...
                            </div>
                        )}

                        <button
                            onClick={() => {
                                pageURL.value = "";
                            }}
                            className={css.fontSize(18).pad2(12, 8) + ""}
                        >
                            Leave Game
                        </button>
                    </div>
                )}
            </div>
        );
    }
}

