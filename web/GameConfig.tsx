import preact from "preact";
import { css } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import { pageURL, joinGameIdURL } from "./Page";
import { changeGridSize, getCurrentGridSize, gameState } from "./GameState";
import { observable } from "mobx";
import { getRPCClient } from "./rpcClient";

const STORAGE_KEY = "letterfast_game_config";

interface SavedConfig {
    gridWidth: number;
    gridHeight: number;
    gameDuration: number;
}

function loadSavedConfig(): SavedConfig | undefined {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return undefined;
        const config = JSON.parse(saved) as SavedConfig;
        if (config.gridWidth >= 2 && config.gridWidth <= 10 &&
            config.gridHeight >= 2 && config.gridHeight <= 10 &&
            config.gameDuration >= 10000 && config.gameDuration <= 3600000) {
            return config;
        }
    } catch (error) {
        console.error("Failed to load saved config:", error);
    }
    return undefined;
}

function saveConfig(config: SavedConfig): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (error) {
        console.error("Failed to save config:", error);
    }
}

export function getSavedConfigOrDefaults(): SavedConfig {
    const saved = loadSavedConfig();
    if (saved) return saved;
    return {
        gridWidth: 4,
        gridHeight: 4,
        gameDuration: 90000,
    };
}

@observer
export class GameConfig extends preact.Component {
    synced = observable({
        customWidth: 4,
        customHeight: 4,
        gameDuration: 90000,
        gameIdToJoin: "",
        creating: false,
        joining: false,
        error: undefined as string | undefined,
    });

    saveCurrentConfig = () => {
        saveConfig({
            gridWidth: this.synced.customWidth,
            gridHeight: this.synced.customHeight,
            gameDuration: this.synced.gameDuration,
        });
    };

    componentDidMount() {
        const saved = loadSavedConfig();
        if (saved) {
            this.synced.customWidth = saved.gridWidth;
            this.synced.customHeight = saved.gridHeight;
            this.synced.gameDuration = saved.gameDuration;
        } else {
            let size = getCurrentGridSize();
            this.synced.customWidth = size.width;
            this.synced.customHeight = size.height;
        }

        const joinGameId = joinGameIdURL.value;
        if (joinGameId) {
            this.synced.gameIdToJoin = joinGameId.toUpperCase();
            void this.onJoinGame();
        }
    }

    startSinglePlayerGame = (config: { width: number; height: number }) => {
        this.synced.customWidth = config.width;
        this.synced.customHeight = config.height;
        changeGridSize(config);
        gameState.gameDuration = this.synced.gameDuration;
        gameState.timeRemaining = this.synced.gameDuration;
        pageURL.value = "game";
    };

    startMultiplayerGame = async (config: { width: number; height: number }) => {
        this.synced.customWidth = config.width;
        this.synced.customHeight = config.height;
        await this.onCreateGame();
    };

    onStartSinglePlayer = () => {
        changeGridSize({
            width: this.synced.customWidth,
            height: this.synced.customHeight,
        });
        gameState.gameDuration = this.synced.gameDuration;
        gameState.timeRemaining = this.synced.gameDuration;
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
            const { gameId } = await rpc.createGame(16);
            gameState.gameId = gameId;
            gameState.isMultiplayer = true;
            gameState.gridWidth = this.synced.customWidth;
            gameState.gridHeight = this.synced.customHeight;
            gameState.gameDuration = this.synced.gameDuration;
            gameState.timeRemaining = this.synced.gameDuration;

            await rpc.updateGameSettings(gameId, this.synced.customWidth, this.synced.customHeight, this.synced.gameDuration);

            joinGameIdURL.value = gameId;

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
            const defaults = getSavedConfigOrDefaults();
            const rpc = getRPCClient();
            await rpc.joinGame(this.synced.gameIdToJoin.toUpperCase(), defaults.gridWidth, defaults.gridHeight, defaults.gameDuration);
            gameState.gameId = this.synced.gameIdToJoin.toUpperCase();
            gameState.isMultiplayer = true;
            joinGameIdURL.value = this.synced.gameIdToJoin.toUpperCase();
            pageURL.value = "lobby";
        } catch (error) {
            this.synced.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.synced.joining = false;
        }
    };

    render() {
        const multiplayerButtonStyle = css.fontSize(32).pad2(8).hsl(200, 60, 40)
            .size(60, 60).display("flex").alignItems("center").justifyContent("center").flexShrink0 + "";
        const multiplayerButtonStyleSmall = css.fontSize(28).pad2(6).hsl(200, 60, 40)
            .size(50, 50).display("flex").alignItems("center").justifyContent("center").flexShrink0 + "";
        const emojiStyle = css.relative.top(-6) + "";

        return (
            <div className={css.fillBoth.vbox(20)
                .pad2(40).colorhsl(0, 0, 100)
            }>
                <div className={css.vbox(24).maxWidth(600).marginAuto}>
                    <div className={css.vbox(16)}>
                        <div className={css.fontSize(24).fontWeight("bold")}>
                            Quick Modes
                        </div>
                        <div className={css.vbox(12)}>
                            <div className={css.hbox(12)}>
                                <button
                                    className={css.fontSize(20).pad2(16) + ""}
                                    onClick={() => this.startSinglePlayerGame({ width: 3, height: 3 })}
                                >
                                    3x3 Classic Mode
                                </button>
                                <button
                                    className={multiplayerButtonStyle}
                                    onClick={() => this.startMultiplayerGame({ width: 3, height: 3 })}
                                    disabled={this.synced.creating}
                                >
                                    {this.synced.creating && "..."}
                                    {!this.synced.creating && <span className={emojiStyle}>👥</span>}
                                </button>
                            </div>
                            <div className={css.hbox(12)}>
                                <button
                                    className={css.fontSize(20).pad2(16) + ""}
                                    onClick={() => this.startSinglePlayerGame({ width: 4, height: 4 })}
                                >
                                    4x4 Standard Mode
                                </button>
                                <button
                                    className={multiplayerButtonStyle}
                                    onClick={() => this.startMultiplayerGame({ width: 4, height: 4 })}
                                    disabled={this.synced.creating}
                                >
                                    {this.synced.creating && "..."}
                                    {!this.synced.creating && <span className={emojiStyle}>👥</span>}
                                </button>
                            </div>
                            <div className={css.hbox(12)}>
                                <button
                                    className={css.fontSize(20).pad2(16) + ""}
                                    onClick={() => this.startSinglePlayerGame({ width: 5, height: 5 })}
                                >
                                    5x5 Extended Mode
                                </button>
                                <button
                                    className={multiplayerButtonStyle}
                                    onClick={() => this.startMultiplayerGame({ width: 5, height: 5 })}
                                    disabled={this.synced.creating}
                                >
                                    {this.synced.creating && "..."}
                                    {!this.synced.creating && <span className={emojiStyle}>👥</span>}
                                </button>
                            </div>
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
                                        this.saveCurrentConfig();
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
                                        this.saveCurrentConfig();
                                    }
                                }}
                                className={css.fontSize(20).pad2(12).width(80) + ""}
                            />
                            <button
                                className={css.fontSize(18).pad2(12) + ""}
                                onClick={() => {
                                    if (this.synced.customWidth >= 2 && this.synced.customWidth <= 10
                                        && this.synced.customHeight >= 2 && this.synced.customHeight <= 10) {
                                        this.onStartSinglePlayer();
                                    }
                                }}
                            >
                                {`Start ${this.synced.customWidth}x${this.synced.customHeight} Game`}
                            </button>
                            <button
                                className={multiplayerButtonStyleSmall}
                                onClick={async () => {
                                    if (this.synced.customWidth >= 2 && this.synced.customWidth <= 10
                                        && this.synced.customHeight >= 2 && this.synced.customHeight <= 10) {
                                        await this.onCreateGame();
                                    }
                                }}
                                disabled={this.synced.creating}
                            >
                                {this.synced.creating && "..."}
                                {!this.synced.creating && <span className={emojiStyle}>👥</span>}
                            </button>
                        </div>
                    </div>

                    <div className={css.vbox(16)}>
                        <div className={css.fontSize(24).fontWeight("bold")}>
                            Game Duration
                        </div>
                        <div className={css.hbox(12).alignItems("center")}>
                            <input
                                type="number"
                                min="10"
                                max="3600"
                                value={Math.round(this.synced.gameDuration / 1000)}
                                onInput={(e) => {
                                    let value = parseInt(e.currentTarget.value, 10);
                                    if (!isNaN(value) && value >= 10 && value <= 3600) {
                                        this.synced.gameDuration = value * 1000;
                                        this.saveCurrentConfig();
                                    }
                                }}
                                className={css.fontSize(20).pad2(12).width(100) + ""}
                            />
                            <div className={css.fontSize(20)}>seconds (10-3600)</div>
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
                                onKeyDown={async (e) => {
                                    if (e.key === "Enter") {
                                        await this.onJoinGame();
                                    }
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
