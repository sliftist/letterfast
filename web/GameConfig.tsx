import preact from "preact";
import { css } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import { pageURL } from "./Page";
import { changeGridSize, getCurrentGridSize, multiplayerState } from "./GameState";
import { observable } from "mobx";
import { getRPCClient } from "./rpcClient";

@observer
export class GameConfig extends preact.Component {
    synced = observable({
        customWidth: 4,
        customHeight: 4,
        isMultiplayer: false,
        playerCount: 4,
        gameIdToJoin: "",
        creating: false,
        joining: false,
        error: undefined as string | undefined,
    });

    componentDidMount() {
        let size = getCurrentGridSize();
        this.synced.customWidth = size.width;
        this.synced.customHeight = size.height;

        const urlParams = new URLSearchParams(window.location.search);
        const joinGameId = urlParams.get("join");
        if (joinGameId) {
            this.synced.gameIdToJoin = joinGameId.toUpperCase();
        }
    }

    onStartSinglePlayer = () => {
        changeGridSize({
            width: this.synced.customWidth,
            height: this.synced.customHeight,
        });
        pageURL.value = "game";
    };

    onCreateGame = async () => {
        this.synced.creating = true;
        this.synced.error = undefined;

        try {
            changeGridSize({
                width: this.synced.customWidth,
                height: this.synced.customHeight,
            });

            const rpc = getRPCClient();
            const { gameId } = await rpc.createGame(this.synced.playerCount);
            multiplayerState.gameId = gameId;
            pageURL.value = "lobby";
        } catch (error) {
            this.synced.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.synced.creating = false;
        }
    };

    onJoinGame = async () => {
        if (!this.synced.gameIdToJoin) {
            this.synced.error = "Please enter a game ID";
            return;
        }

        this.synced.joining = true;
        this.synced.error = undefined;

        try {
            const rpc = getRPCClient();
            await rpc.joinGame(this.synced.gameIdToJoin.toUpperCase());
            multiplayerState.gameId = this.synced.gameIdToJoin.toUpperCase();
            pageURL.value = "lobby";
        } catch (error) {
            this.synced.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.synced.joining = false;
        }
    };

    render() {
        return (
            <div className={css.fillBoth.vbox(20)
                .background("linear-gradient(135deg, #1a0b2e 0%, #2d1b69 50%, #1a0b2e 100%)")
                .pad2(40).colorhsl(0, 0, 100)
            }>
                <div className={css.vbox(24).maxWidth(600).marginAuto}>
                    <div className={css.vbox(16)}>
                        <div className={css.fontSize(24).fontWeight("bold")}>
                            Quick Modes
                        </div>
                        <div className={css.vbox(12)}>
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={async () => {
                                    this.synced.customWidth = 3;
                                    this.synced.customHeight = 3;
                                    changeGridSize({ width: 3, height: 3 });
                                    if (this.synced.isMultiplayer) {
                                        await this.onCreateGame();
                                    } else {
                                        pageURL.value = "game";
                                    }
                                }}
                                disabled={this.synced.creating}
                            >
                                {this.synced.creating && "Creating..."}
                                {!this.synced.creating && "3x3 Classic Mode"}
                            </button>
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={async () => {
                                    this.synced.customWidth = 4;
                                    this.synced.customHeight = 4;
                                    changeGridSize({ width: 4, height: 4 });
                                    if (this.synced.isMultiplayer) {
                                        await this.onCreateGame();
                                    } else {
                                        pageURL.value = "game";
                                    }
                                }}
                                disabled={this.synced.creating}
                            >
                                {this.synced.creating && "Creating..."}
                                {!this.synced.creating && "4x4 Standard Mode"}
                            </button>
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={async () => {
                                    this.synced.customWidth = 5;
                                    this.synced.customHeight = 5;
                                    changeGridSize({ width: 5, height: 5 });
                                    if (this.synced.isMultiplayer) {
                                        await this.onCreateGame();
                                    } else {
                                        pageURL.value = "game";
                                    }
                                }}
                                disabled={this.synced.creating}
                            >
                                {this.synced.creating && "Creating..."}
                                {!this.synced.creating && "5x5 Extended Mode"}
                            </button>
                        </div>
                    </div>

                    <div className={css.vbox(16)}>
                        <div className={css.fontSize(24).fontWeight("bold")}>
                            Custom Size (2-10)
                        </div>
                        <div className={css.hbox(12).alignItems("center").wrap}>
                            <input
                                type="number"
                                min="2"
                                max="10"
                                value={this.synced.customWidth}
                                onInput={(e) => {
                                    let value = parseInt(e.currentTarget.value, 10);
                                    if (!isNaN(value)) {
                                        this.synced.customWidth = value;
                                    }
                                }}
                                className={css.fontSize(20).pad2(12).width(80) + ""}
                            />
                            <div className={css.fontSize(20)}>x</div>
                            <input
                                type="number"
                                min="2"
                                max="10"
                                value={this.synced.customHeight}
                                onInput={(e) => {
                                    let value = parseInt(e.currentTarget.value, 10);
                                    if (!isNaN(value)) {
                                        this.synced.customHeight = value;
                                    }
                                }}
                                className={css.fontSize(20).pad2(12).width(80) + ""}
                            />
                            <button
                                className={css.fontSize(18).pad2(12) + ""}
                                onClick={async () => {
                                    if (this.synced.customWidth >= 2 && this.synced.customWidth <= 10
                                        && this.synced.customHeight >= 2 && this.synced.customHeight <= 10) {
                                        if (this.synced.isMultiplayer) {
                                            await this.onCreateGame();
                                        } else {
                                            this.onStartSinglePlayer();
                                        }
                                    }
                                }}
                                disabled={this.synced.creating}
                            >
                                {this.synced.creating && "Creating..."}
                                {!this.synced.creating && `Start ${this.synced.customWidth}x${this.synced.customHeight} Game`}
                            </button>
                        </div>
                    </div>

                    <div className={css.vbox(16)}>
                        <div className={css.fontSize(24).fontWeight("bold")}>
                            Join Game
                        </div>
                        <div className={css.hbox(12).alignItems("center")}>
                            <input
                                type="text"
                                placeholder="Game ID"
                                value={this.synced.gameIdToJoin}
                                onInput={(e) => {
                                    this.synced.gameIdToJoin = e.currentTarget.value;
                                }}
                                className={css.fontSize(20).pad2(12).textTransform("uppercase").width(150) + ""}
                            />
                            <button
                                onClick={this.onJoinGame}
                                disabled={this.synced.joining}
                                className={css.fontSize(18).pad2(12) + ""}
                            >
                                {this.synced.joining && "Joining..."}
                                {!this.synced.joining && "Join"}
                            </button>
                        </div>
                    </div>

                    <div className={css.vbox(12)}>
                        <label className={css.hbox(12).alignItems("center").fontSize(18)}>
                            <input
                                type="checkbox"
                                checked={this.synced.isMultiplayer}
                                onChange={(e) => {
                                    this.synced.isMultiplayer = e.currentTarget.checked;
                                }}
                            />
                            Multiplayer Mode
                        </label>
                    </div>

                    {this.synced.isMultiplayer && (
                        <div className={css.vbox(12)}>
                            <div className={css.fontSize(20).fontWeight("bold")}>Number of Players</div>
                            <input
                                type="number"
                                min="2"
                                max="16"
                                value={this.synced.playerCount}
                                onInput={(e) => {
                                    this.synced.playerCount = +e.currentTarget.value;
                                }}
                                className={css.fontSize(16).pad2(8).width(80) + ""}
                            />
                        </div>
                    )}

                    {this.synced.error && (
                        <div className={css.colorhsl(0, 70, 60).fontSize(16).pad2(12).borderRadius(8).hsl(0, 30, 20)}>
                            {this.synced.error}
                        </div>
                    )}
                </div>
            </div>
        );
    }
}
