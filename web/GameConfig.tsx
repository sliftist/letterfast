import preact from "preact";
import { css } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import { pageURL, joinGameIdURL } from "./Page";
import { changeGridSize, getCurrentGridSize, gameState, applySettings } from "./GameState";
import { observable } from "mobx";
import { getRPCClient } from "./rpcClient";

export const STORAGE_KEY = "letterfast_game_config";

export interface SavedConfig {
    gridWidth: number;
    gridHeight: number;
    gameDuration: number;
    showRemainingWordsPerCell?: boolean;
    showTotalPossibleScore?: boolean;
}

export function loadSavedConfig(): SavedConfig | undefined {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return undefined;
        const config = JSON.parse(saved) as SavedConfig;
        if (config.gridWidth >= 2 && config.gridWidth <= 10 &&
            config.gridHeight >= 2 && config.gridHeight <= 10 &&
            config.gameDuration >= 10000 && config.gameDuration <= 3600000) {
            return {
                gridWidth: config.gridWidth,
                gridHeight: config.gridHeight,
                gameDuration: config.gameDuration,
                showRemainingWordsPerCell: !!config.showRemainingWordsPerCell,
                showTotalPossibleScore: !!config.showTotalPossibleScore,
            };
        }
    } catch (error) {
        console.error("Failed to load saved config:", error);
    }
    return undefined;
}

export function saveConfig(config: SavedConfig): void {
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
        showRemainingWordsPerCell: false,
        showTotalPossibleScore: false,
    };
}

@observer
export class GameConfig extends preact.Component {
    synced = observable({
        customWidth: 4,
        customHeight: 4,
        gameDuration: 90000,
        showRemainingWordsPerCell: false,
        showTotalPossibleScore: false,
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
            showRemainingWordsPerCell: this.synced.showRemainingWordsPerCell,
            showTotalPossibleScore: this.synced.showTotalPossibleScore,
        });
        applySettings({
            showRemainingWordsPerCell: this.synced.showRemainingWordsPerCell,
            showTotalPossibleScore: this.synced.showTotalPossibleScore,
        });

        if (gameState.isMultiplayer && gameState.gameId && gameState.myPlayerIndex === 0) {
            void (async () => {
                try {
                    const rpc = getRPCClient();
                    await rpc.updateGameSettings(
                        gameState.gameId!,
                        this.synced.customWidth,
                        this.synced.customHeight,
                        this.synced.gameDuration,
                        this.synced.showRemainingWordsPerCell,
                        this.synced.showTotalPossibleScore
                    );
                } catch (error) {
                    console.error("Failed to push settings to server:", error);
                }
            })();
        }
    };

    componentDidMount() {
        const saved = loadSavedConfig();
        if (saved) {
            this.synced.customWidth = saved.gridWidth;
            this.synced.customHeight = saved.gridHeight;
            this.synced.gameDuration = saved.gameDuration;
            this.synced.showRemainingWordsPerCell = saved.showRemainingWordsPerCell ?? false;
            this.synced.showTotalPossibleScore = saved.showTotalPossibleScore ?? false;
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

    startSinglePlayerGame = async (config: { width: number; height: number }) => {
        this.synced.customWidth = config.width;
        this.synced.customHeight = config.height;
        await changeGridSize(config);
        gameState.gameDuration = this.synced.gameDuration;
        gameState.timeRemaining = this.synced.gameDuration;
        pageURL.value = "game";
    };

    onStartSinglePlayer = async () => {
        await changeGridSize({
            width: this.synced.customWidth,
            height: this.synced.customHeight,
        });
        gameState.gameDuration = this.synced.gameDuration;
        gameState.timeRemaining = this.synced.gameDuration;
        pageURL.value = "game";
    };

    onJoinGame = async () => {
        if (!this.synced.gameIdToJoin) {
            this.synced.error = "Please enter a game ID";
            return;
        }

        this.synced.joining = true;
        this.synced.error = undefined;

        try {
            gameState.gameId = this.synced.gameIdToJoin.toUpperCase();
            gameState.isMultiplayer = true;
            joinGameIdURL.value = this.synced.gameIdToJoin.toUpperCase();
            pageURL.value = "game";
        } catch (error) {
            this.synced.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.synced.joining = false;
        }
    };

    render() {
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
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={async () => await this.startSinglePlayerGame({ width: 3, height: 3 })}
                            >
                                3x3 Classic Mode
                            </button>
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={async () => await this.startSinglePlayerGame({ width: 4, height: 4 })}
                            >
                                4x4 Standard Mode
                            </button>
                            <button
                                className={css.fontSize(20).pad2(16) + ""}
                                onClick={async () => await this.startSinglePlayerGame({ width: 5, height: 5 })}
                            >
                                5x5 Extended Mode
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
                                onClick={async () => {
                                    if (this.synced.customWidth >= 2 && this.synced.customWidth <= 10
                                        && this.synced.customHeight >= 2 && this.synced.customHeight <= 10) {
                                        await this.onStartSinglePlayer();
                                    }
                                }}
                            >
                                {`Start ${this.synced.customWidth}x${this.synced.customHeight} Game`}
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

                    {(() => {
                        const inMultiplayer = gameState.isMultiplayer && !!gameState.gameId;
                        const isHost = !inMultiplayer || gameState.myPlayerIndex === 0;
                        const showRemainingWordsPerCell = inMultiplayer ? gameState.showRemainingWordsPerCell : this.synced.showRemainingWordsPerCell;
                        const showTotalPossibleScore = inMultiplayer ? gameState.showTotalPossibleScore : this.synced.showTotalPossibleScore;
                        return (
                            <div className={css.vbox(16)}>
                                <div className={css.fontSize(24).fontWeight("bold")}>
                                    Display{inMultiplayer && !isHost ? " (set by host)" : ""}
                                </div>
                                <label className={css.hbox(12).alignItems("center").fontSize(18) + (isHost ? css.cursor("pointer") : css.opacity(0.6))}>
                                    <input
                                        type="checkbox"
                                        checked={showRemainingWordsPerCell}
                                        disabled={!isHost}
                                        onChange={(e) => {
                                            this.synced.showRemainingWordsPerCell = e.currentTarget.checked;
                                            this.saveCurrentConfig();
                                        }}
                                        className={css.size(20, 20) + ""}
                                    />
                                    <span>Show remaining words per tile</span>
                                </label>
                                <label className={css.hbox(12).alignItems("center").fontSize(18) + (isHost ? css.cursor("pointer") : css.opacity(0.6))}>
                                    <input
                                        type="checkbox"
                                        checked={showTotalPossibleScore}
                                        disabled={!isHost}
                                        onChange={(e) => {
                                            this.synced.showTotalPossibleScore = e.currentTarget.checked;
                                            this.saveCurrentConfig();
                                        }}
                                        className={css.size(20, 20) + ""}
                                    />
                                    <span>Show total possible score and percentage</span>
                                </label>
                            </div>
                        );
                    })()}

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
