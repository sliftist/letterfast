import { createRPC } from "./rpc/createRPC";
import { GridCell, gameState } from "./GameState";
import * as GameManager from "./GameManager";
import { onLastCallerDisconnect, getLastFunctionCaller } from "./rpc/FunctionCaller";
import { pageURL } from "./Page";

function setupPlayerDisconnect(gameId: string, player: GameManager.PlayerIdentifier): void {
    onLastCallerDisconnect(() => {
        GameManager.removePlayerFromGame(gameId, player);
        const game = GameManager.getGame(gameId);
        if (game) {
            const players = GameManager.getPlayerScores(gameId);
            GameManager.broadcastToGame(gameId, (playerClient, playerIndex) => {
                void playerClient.onPlayerUpdate(gameId, players, game.status, playerIndex);
            });
        }
    });
}
const serverHandlers = {
    async createGame(playerCount: number): Promise<{ gameId: string }> {
        const player = getServerSideClient();
        if (!player) {
            throw new Error(`No active caller`);
        }

        const result = GameManager.createGame(playerCount, player);
        setupPlayerDisconnect(result.gameId, player);

        const players = GameManager.getPlayerScores(result.gameId);
        void player.onPlayerUpdate(result.gameId, players, "waiting", 0);
        return result;
    },

    async joinGame(gameId: string, defaultGridWidth?: number, defaultGridHeight?: number, defaultGameDuration?: number): Promise<void> {
        const player = getServerSideClient();
        if (!player) {
            throw new Error(`No active caller`);
        }

        const sanitized = gameId.toUpperCase().replace(/[^A-Z]/g, "");

        if (sanitized.length === 0) {
            throw new Error(`Invalid game ID: must contain at least one letter`);
        }
        if (sanitized.length > 30) {
            throw new Error(`Invalid game ID: too long (max 30 characters)`);
        }

        let gridWidth = 4;
        let gridHeight = 4;
        let gameDuration = 90000;

        if (defaultGridWidth !== undefined && defaultGridWidth >= 2 && defaultGridWidth <= 10) {
            gridWidth = defaultGridWidth;
        }
        if (defaultGridHeight !== undefined && defaultGridHeight >= 2 && defaultGridHeight <= 10) {
            gridHeight = defaultGridHeight;
        }
        if (defaultGameDuration !== undefined && defaultGameDuration >= 10000 && defaultGameDuration <= 3600000) {
            gameDuration = defaultGameDuration;
        }

        let game = GameManager.getGame(sanitized);
        if (!game) {
            GameManager.createGameWithId(sanitized, 16, player, gridWidth, gridHeight, gameDuration);
            game = GameManager.getGame(sanitized);
        } else {
            GameManager.joinGame(sanitized, player);
        }

        setupPlayerDisconnect(sanitized, player);

        if (game) {
            const players = GameManager.getPlayerScores(sanitized);
            GameManager.broadcastToGame(sanitized, (playerClient, playerIndex) => {
                console.log("onPlayerUpdate", playerClient, playerIndex);
                void playerClient.onPlayerUpdate(sanitized, players, game!.status, playerIndex);
            });

            if (game.status === "playing" && game.startTime) {
                void player.onGameStart(sanitized, game.grid, game.startTime, game.gameDuration);
            }
        }
    },

    async startGame(gameId: string): Promise<void> {
        const player = getServerSideClient();
        if (!player) {
            throw new Error(`No active caller`);
        }

        const game = GameManager.getGame(gameId);
        if (!game) {
            throw new Error(`Game ${gameId} not found`);
        }

        GameManager.validateStartGame(gameId, player);
        GameManager.startGamePlaying(gameId);
        const updatedGame = GameManager.getGame(gameId);
        if (!updatedGame) {
            throw new Error(`Game ${gameId} not found after starting`);
        }

        GameManager.broadcastToGame(gameId, (client) => {
            void client.onGameStart(gameId, updatedGame.grid, updatedGame.startTime!, updatedGame.gameDuration);
        });

        setTimeout(() => {
            const finalGame = GameManager.getGame(gameId);
            if (finalGame && finalGame.status === "playing") {
                const allWords = GameManager.getAllWords(gameId);
                const players = GameManager.getPlayerScores(gameId);

                GameManager.broadcastToGame(gameId, (client) => {
                    void client.onGameEnd(gameId, players, allWords);
                });

                setTimeout(() => {
                    GameManager.endGame(gameId);
                }, 1000);
            }
        }, updatedGame.gameDuration);
    },

    async submitWord(gameId: string, word: string, cells: { row: number; col: number }[]): Promise<{ points: number }> {
        const player = getServerSideClient();
        if (!player) {
            throw new Error(`No active caller`);
        }

        const game = GameManager.getGame(gameId);
        if (!game) {
            throw new Error(`Game ${gameId} not found`);
        }

        const result = GameManager.submitWord({ gameId, player, word, cells });
        const players = GameManager.getPlayerScores(gameId);
        GameManager.broadcastToGame(gameId, (client, playerIndex) => {
            void client.onPlayerUpdate(gameId, players, game.status, playerIndex);
        });

        return result;
    },

    async updateGameSettings(gameId: string, gridWidth?: number, gridHeight?: number, gameDuration?: number): Promise<void> {
        const player = getServerSideClient();
        if (!player) {
            throw new Error(`No active caller`);
        }

        GameManager.updateGameSettings({ gameId, player, gridWidth, gridHeight, gameDuration });
        const settings = GameManager.getGameSettings(gameId);
        GameManager.broadcastToGame(gameId, (client) => {
            void client.onSettingsUpdate(gameId, settings.gridWidth, settings.gridHeight, settings.gameDuration);
        });
    },

    async getGameSettings(gameId: string): Promise<{ gridWidth: number; gridHeight: number; gameDuration: number }> {
        return GameManager.getGameSettings(gameId);
    }
};

export const clientHandlers = {
    async onPlayerUpdate(gameId: string, players: { id: string; score: number }[], status: string, yourPlayerIndex: number): Promise<void> {
        if (gameState.gameId !== gameId) return;
        gameState.players = players;
        gameState.status = status as any;
        gameState.myPlayerIndex = yourPlayerIndex;
        if (yourPlayerIndex !== undefined && players[yourPlayerIndex]) {
            gameState.score = players[yourPlayerIndex].score;
        }
    },

    async onGameStart(gameId: string, grid: GridCell[][], startTime: number, duration: number): Promise<void> {
        if (gameState.gameId !== gameId) return;
        gameState.grid = grid;
        gameState.status = "playing";
        gameState.gameDuration = duration;
        gameState.timeRemaining = duration;
        gameState.isMultiplayer = true;

        const updateTimer = () => {
            if (gameState.status !== "playing") return;
            const elapsed = Date.now() - startTime;
            gameState.timeRemaining = Math.max(0, duration - elapsed);
            if (gameState.timeRemaining > 0) {
                setTimeout(updateTimer, 100);
            }
        };
        updateTimer();

        pageURL.value = "game";
    },

    async onGameEnd(gameId: string, players: { id: string; score: number }[], allWords: Record<string, { word: string; points: number }[]>): Promise<void> {
        if (gameState.gameId !== gameId) return;
        gameState.status = "finished";
        gameState.players = players;
        gameState.allWords = allWords;
        if (gameState.myPlayerIndex !== undefined && players[gameState.myPlayerIndex]) {
            gameState.score = players[gameState.myPlayerIndex].score;
        }
        const myPlayerId = gameState.myPlayerIndex !== undefined ? players[gameState.myPlayerIndex]?.id : undefined;
        if (myPlayerId && allWords[myPlayerId]) {
            gameState.matchedWords = allWords[myPlayerId];
        }
        pageURL.value = "lobby";
    },

    async onSettingsUpdate(gameId: string, gridWidth: number, gridHeight: number, gameDuration: number): Promise<void> {
        if (gameState.gameId !== gameId) return;
        gameState.gridWidth = gridWidth;
        gameState.gridHeight = gridHeight;
        gameState.gameDuration = gameDuration;
    }
};

export type ClientHandlers = typeof clientHandlers;

const clientHandlersNoOp: ClientHandlers = {
    async onPlayerUpdate(gameId: string, players: { id: string; score: number }[], status: string, yourPlayerIndex: number): Promise<void> {
    },

    async onGameStart(gameId: string, grid: GridCell[][], startTime: number, duration: number): Promise<void> {
    },

    async onGameEnd(gameId: string, players: { id: string; score: number }[], allWords: Record<string, { word: string; points: number }[]>): Promise<void> {
    },

    async onSettingsUpdate(gameId: string, gridWidth: number, gridHeight: number, gameDuration: number): Promise<void> {
    }
};

const allHandlers = {
    ...serverHandlers,
    ...clientHandlersNoOp
};

const _ensureAllHandlersExtendsClientHandlers: ClientHandlers = allHandlers;

export type AllHandlers = typeof allHandlers;

export const { startServer, getClient, getServerSideClient } = createRPC(allHandlers);

GameManager.startCleanupInterval();
