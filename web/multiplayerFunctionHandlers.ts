import { createRPC } from "./rpc/createRPC";
import { GridCell, multiplayerState } from "./GameState";
import * as GameManager from "./GameManager";
import { onLastCallerDisconnect, getLastFunctionCaller } from "./rpc/FunctionCaller";

function setupPlayerDisconnect(gameId: string, player: GameManager.PlayerIdentifier): void {
    onLastCallerDisconnect(() => {
        GameManager.removePlayerFromGame(gameId, player);
        const game = GameManager.getGame(gameId);
        if (game) {
            const players = GameManager.getPlayerScores(gameId);
            GameManager.broadcastToGame(gameId, (playerClient, playerIndex) => {
                void playerClient.onPlayerUpdate(players, game.status, playerIndex);
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
        void player.onPlayerUpdate(players, "waiting", 0);
        return result;
    },

    async joinGame(gameId: string): Promise<void> {
        const player = getServerSideClient();
        if (!player) {
            throw new Error(`No active caller`);
        }

        GameManager.joinGame(gameId, player);
        setupPlayerDisconnect(gameId, player);

        const game = GameManager.getGame(gameId);
        if (game) {
            const players = GameManager.getPlayerScores(gameId);
            GameManager.broadcastToGame(gameId, (playerClient, playerIndex) => {
                console.log("onPlayerUpdate", playerClient, playerIndex);
                void playerClient.onPlayerUpdate(players, game.status, playerIndex);
            });
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
        GameManager.startGameCountdown(gameId);

        for (let i = 3; i > 0; i--) {
            GameManager.broadcastToGame(gameId, (client) => {
                void client.onCountdown(i);
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        GameManager.startGamePlaying(gameId);
        const updatedGame = GameManager.getGame(gameId);
        if (updatedGame) {
            GameManager.broadcastToGame(gameId, (client) => {
                void client.onGameStart(updatedGame.grid, updatedGame.startTime!);
            });
        }

        setTimeout(() => {
            const finalGame = GameManager.getGame(gameId);
            if (finalGame && finalGame.status === "playing") {
                GameManager.endGame(gameId);
                const allWords = GameManager.getAllWords(gameId);
                const players = GameManager.getPlayerScores(gameId);
                GameManager.broadcastToGame(gameId, (client) => {
                    void client.onGameEnd(players, allWords);
                });
            }
        }, 90000 + 1000);
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
            void client.onPlayerUpdate(players, game.status, playerIndex);
        });

        return result;
    }
};

export const clientHandlers = {
    async onPlayerUpdate(players: { id: string; score: number }[], status: string, yourPlayerIndex: number): Promise<void> {
        multiplayerState.players = players;
        multiplayerState.status = status as any;
        multiplayerState.myPlayerIndex = yourPlayerIndex;
    },

    async onCountdown(seconds: number): Promise<void> {
        multiplayerState.countdown = seconds;
        multiplayerState.status = "countdown";
    },

    async onGameStart(grid: GridCell[][], startTime: number): Promise<void> {
        multiplayerState.grid = grid;
        multiplayerState.status = "playing";
        multiplayerState.timeRemaining = 90000;

        const updateTimer = () => {
            if (multiplayerState.status !== "playing") return;
            const elapsed = Date.now() - startTime;
            multiplayerState.timeRemaining = Math.max(0, 90000 - elapsed);
            if (multiplayerState.timeRemaining > 0) {
                setTimeout(updateTimer, 100);
            }
        };
        updateTimer();
    },

    async onGameEnd(players: { id: string; score: number }[], allWords: Record<string, { word: string; points: number }[]>): Promise<void> {
        multiplayerState.status = "finished";
        multiplayerState.players = players;
        multiplayerState.allWords = allWords;
    }
};

type ClientHandlers = typeof clientHandlers;

const clientHandlersNoOp: ClientHandlers = {
    async onPlayerUpdate(players: { id: string; score: number }[], status: string, yourPlayerIndex: number): Promise<void> {
    },

    async onCountdown(seconds: number): Promise<void> {
    },

    async onGameStart(grid: GridCell[][], startTime: number): Promise<void> {
    },

    async onGameEnd(players: { id: string; score: number }[], allWords: Record<string, { word: string; points: number }[]>): Promise<void> {
    }
};

const allHandlers = {
    ...serverHandlers,
    ...clientHandlersNoOp
};

const _ensureAllHandlersExtendsClientHandlers: ClientHandlers = allHandlers;

export type AllHandlers = typeof allHandlers;

export const { startServer, getClient, getServerSideClient } = createRPC(allHandlers);
