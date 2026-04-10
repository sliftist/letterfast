import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { gameState, formatTime } from "./GameState";
import { pageURL, joinGameIdURL } from "./Page";
import { getRPCClient } from "./rpcClient";
import { observable } from "mobx";
import { sort } from "socket-function/src/misc";
import { getSavedConfigOrDefaults } from "./GameConfig";

function saveConfig(config: { gridWidth: number; gridHeight: number; gameDuration: number }): void {
    try {
        localStorage.setItem("letterfast_game_config", JSON.stringify(config));
    } catch (error) {
        console.error("Failed to save config:", error);
    }
}

@observer
export class GameLobby extends preact.Component {
    synced = observable({
        copied: false,
    });

    saveCurrentConfig = () => {
        saveConfig({
            gridWidth: gameState.gridWidth,
            gridHeight: gameState.gridHeight,
            gameDuration: gameState.gameDuration,
        });
    };

    async componentDidMount() {
        if (!gameState.gameId) {
            pageURL.value = "config";
            return;
        }

        try {
            const rpc = getRPCClient();
            const settings = await rpc.getGameSettings(gameState.gameId);
            gameState.gridWidth = settings.gridWidth;
            gameState.gridHeight = settings.gridHeight;
            gameState.gameDuration = settings.gameDuration;
        } catch (error) {
            console.error("Failed to fetch game settings:", error);
        }
    }

    onStartGame = async () => {
        if (!gameState.gameId) return;
        const rpc = getRPCClient();
        await rpc.startGame(gameState.gameId);
    };

    onCopyShareLink = async () => {
        if (!gameState.gameId) return;
        await navigator.clipboard.writeText(window.location.href);
        this.synced.copied = true;
        setTimeout(() => {
            this.synced.copied = false;
        }, 2000);
    };

    onBackToConfig = () => {
        joinGameIdURL.value = "";
        gameState.gameId = undefined;
        gameState.isMultiplayer = false;
        gameState.myPlayerIndex = undefined;
        gameState.players = [];
        gameState.allWords = {};
        pageURL.value = "config";
    };

    onUpdateSettings = async () => {
        if (!gameState.gameId) return;
        try {
            const rpc = getRPCClient();
            await rpc.updateGameSettings(gameState.gameId, gameState.gridWidth, gameState.gridHeight, gameState.gameDuration);
        } catch (error) {
            console.error("Failed to update settings:", error);
        }
    };

    render() {
        const { gameId, myPlayerIndex, players, status, allWords } = gameState;

        if (!gameId) {
            return <div className={css.pad2(20)}>No game ID</div>;
        }

        const isHost = myPlayerIndex === 0;
        const playerCount = players.length;

        return (
            <div className={css.fillBoth.vbox(20)
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

                {status === "playing" && (
                    <div className={css.vbox(20)}>
                        <div className={css.fontSize(28).fontWeight("bold").textAlign("center").colorhsl(120, 60, 60)}>
                            Game is Active!
                        </div>
                        <div className={css.vbox(12).pad2(20).borderRadius(12).hsl(240, 30, 20)}>
                            <div className={css.fontSize(20)}>
                                Time Remaining: <span className={css.fontWeight("bold").colorhsl(120, 60, 60)}>{formatTime(gameState.timeRemaining)}</span>
                            </div>
                            <div className={css.fontSize(20)}>
                                Players: <span className={css.fontWeight("bold")}>{playerCount}</span>
                            </div>
                            <div className={css.fontSize(20)}>
                                Grid Size: <span className={css.fontWeight("bold")}>{gameState.gridWidth}x{gameState.gridHeight}</span>
                            </div>
                        </div>
                        <button
                            onClick={() => {
                                pageURL.value = "game";
                            }}
                            className={css.fontSize(24).pad2(20, 16).hsl(120, 50, 40) + ""}
                        >
                            Join Game
                        </button>
                    </div>
                )}

                {(
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
                            <div className={css.vbox(12)}>
                                <div className={css.fontSize(20).fontWeight("bold")}>
                                    Game Settings
                                </div>
                                <div className={css.vbox(8)}>
                                    <div className={css.hbox(12).alignItems("center")}>
                                        <div className={css.fontSize(16)}>Grid Size:</div>
                                        <input
                                            type="number"
                                            min="2"
                                            max="10"
                                            value={gameState.gridWidth}
                                            disabled={status === "playing"}
                                            onInput={(e) => {
                                                const value = parseInt(e.currentTarget.value, 10);
                                                if (!isNaN(value) && value >= 2 && value <= 10) {
                                                    gameState.gridWidth = value;
                                                    this.saveCurrentConfig();
                                                }
                                            }}
                                            onBlur={() => {
                                                void this.onUpdateSettings();
                                            }}
                                            className={css.fontSize(16).pad2(8).width(60) + ""}
                                        />
                                        <div className={css.fontSize(16)}>x</div>
                                        <input
                                            type="number"
                                            min="2"
                                            max="10"
                                            value={gameState.gridHeight}
                                            disabled={status === "playing"}
                                            onInput={(e) => {
                                                const value = parseInt(e.currentTarget.value, 10);
                                                if (!isNaN(value) && value >= 2 && value <= 10) {
                                                    gameState.gridHeight = value;
                                                    this.saveCurrentConfig();
                                                }
                                            }}
                                            onBlur={() => {
                                                void this.onUpdateSettings();
                                            }}
                                            className={css.fontSize(16).pad2(8).width(60) + ""}
                                        />
                                    </div>
                                    <div className={css.hbox(12).alignItems("center")}>
                                        <div className={css.fontSize(16)}>Duration (seconds):</div>
                                        <input
                                            type="number"
                                            min="10"
                                            max="3600"
                                            value={Math.round(gameState.gameDuration / 1000)}
                                            disabled={status === "playing"}
                                            onInput={(e) => {
                                                const value = parseInt(e.currentTarget.value, 10);
                                                if (!isNaN(value) && value >= 10 && value <= 3600) {
                                                    gameState.gameDuration = value * 1000;
                                                    this.saveCurrentConfig();
                                                }
                                            }}
                                            onBlur={() => {
                                                void this.onUpdateSettings();
                                            }}
                                            className={css.fontSize(16).pad2(8).width(80) + ""}
                                        />
                                    </div>
                                </div>
                                {status !== "playing" && (
                                    <button
                                        onClick={this.onStartGame}
                                        className={css.fontSize(20).pad2(16, 12) + ""}
                                    >
                                        {status === "finished" && "Start New Game"}
                                        {status === "waiting" && "Start Game"}
                                    </button>
                                )}
                            </div>
                        )}

                        {!isHost && (
                            <div className={css.vbox(12)}>
                                <div className={css.fontSize(20).fontWeight("bold")}>
                                    Game Settings
                                </div>
                                <div className={css.vbox(8).fontSize(16)}>
                                    <div>Grid Size: {gameState.gridWidth}x{gameState.gridHeight}</div>
                                    <div>Duration: {Math.round(gameState.gameDuration / 1000)} seconds</div>
                                </div>
                                <div className={css.fontSize(18).opacity(0.7).textAlign("center")}>
                                    {status === "finished" && "Waiting for host to start a new game..."}
                                    {status === "waiting" && "Waiting for host to start the game..."}
                                </div>
                            </div>
                        )}

                        <button
                            onClick={this.onBackToConfig}
                            className={css.fontSize(18).pad2(12, 8) + ""}
                        >
                            Back to Configuration
                        </button>
                    </div>
                )}
            </div>
        );
    }
}

