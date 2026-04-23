import { createRPC } from "./rpc/createRPC";
import { GridCell, gameState, GameOverState, regenerateGridForCurrentSize } from "./GameState";
import * as GameManager from "./GameManager";
import { onLastCallerDisconnect, getLastFunctionCaller, disconnectLastCaller } from "./rpc/FunctionCaller";
import { pageURL } from "./Page";
import { showGameOver, closeGameOverModal } from "./GameOver";
import { verifySignature } from "./CryptoIdentity";
import { addNotification } from "./NotificationState";

const MAX_WORDS_PER_PLAYER = 10000;
const MAX_CHALLENGE_COMPLETIONS = 3;
const CHALLENGE_EXPIRY_TIME = 24 * 60 * 60 * 1000;
const END_TO_GAME_OVER_DELAY = 1000;
const AUTO_RESTART_DELAY = 15000;

function scheduleGameEnd(gameId: string, duration: number): void {
    setTimeout(() => {
        void (async () => {
            const finalGame = GameManager.getGame(gameId);
            if (!finalGame || finalGame.status !== "playing") return;

            const allWords = GameManager.getAllWords(gameId);
            const players = GameManager.getPlayerScores(gameId);

            await GameManager.broadcastToGame(gameId, async (client) => {
                await client.onGameEnd(gameId, players, allWords);
            });

            if (!GameManager.getGame(gameId)) return;

            setTimeout(() => {
                GameManager.endGame(gameId);
                scheduleAutoRestart(gameId);
            }, END_TO_GAME_OVER_DELAY);
        })();
    }, duration);
}

function scheduleAutoRestart(gameId: string): void {
    setTimeout(() => {
        void (async () => {
            const game = GameManager.getGame(gameId);
            if (!game) return;
            if (game.status !== "finished") return;
            if (game.players.length === 0) return;

            await GameManager.startGamePlaying(gameId);
            const updatedGame = GameManager.getGame(gameId);
            if (!updatedGame) return;

            const players = GameManager.getPlayerScores(gameId);
            await GameManager.broadcastToGame(gameId, async (client, playerIndex) => {
                await client.onPlayerUpdate(gameId, players, updatedGame.status, playerIndex);
                await client.onGameStart(gameId, updatedGame.grid, updatedGame.startTime!, updatedGame.gameDuration, updatedGame.totalPossibleWords, updatedGame.totalPossibleScore);
            });

            if (!GameManager.getGame(gameId)) return;

            scheduleGameEnd(gameId, updatedGame.gameDuration);
        })();
    }, AUTO_RESTART_DELAY);
}

interface ChallengeWatcher {
    publicKey: string;
    client: AllHandlers;
    completionCount: number;
    createdAt: number;
    creatorScore: number;
    creatorWords: { word: string; points: number }[];
    grid: GridCell[][];
    totalPossibleScore: number;
    totalPossibleWords: number;
}

const challengeWatchers = new Map<string, ChallengeWatcher>();

function setupPlayerDisconnect(gameId: string, player: GameManager.PlayerIdentifier): void {
    onLastCallerDisconnect(() => {
        GameManager.removePlayerFromGame(gameId, player);
        const game = GameManager.getGame(gameId);
        if (game) {
            const players = GameManager.getPlayerScores(gameId);
            void GameManager.broadcastToGame(gameId, async (playerClient, playerIndex) => {
                await playerClient.onPlayerUpdate(gameId, players, game.status, playerIndex);
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

        const result = await GameManager.createGame(playerCount, player);
        setupPlayerDisconnect(result.gameId, player);

        const players = GameManager.getPlayerScores(result.gameId);
        // Wait, so the client can know the game ID before we tell them about the update. Otherwise, they will just ignore the update. 
        setImmediate(() => {
            void player.onPlayerUpdate(result.gameId, players, "waiting", 0);
        });
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
            await GameManager.createGameWithId(sanitized, 16, player, gridWidth, gridHeight, gameDuration);
            game = GameManager.getGame(sanitized);
        } else {
            GameManager.joinGame(sanitized, player);
        }

        setupPlayerDisconnect(sanitized, player);

        if (game) {
            const players = GameManager.getPlayerScores(sanitized);
            let gameT = game;
            // Wait, so the client can know the game ID before we tell them about the update. Otherwise, they will just ignore the update. 
            setImmediate(() => {
                void GameManager.broadcastToGame(sanitized, async (playerClient, playerIndex) => {
                    console.log("onPlayerUpdate", playerClient, playerIndex);
                    await playerClient.onPlayerUpdate(sanitized, players, game!.status, playerIndex);
                });

                void player.onSettingsUpdate(sanitized, gameT.gridWidth, gameT.gridHeight, gameT.gameDuration);

                if (gameT.status === "playing" && gameT.startTime) {
                    void player.onGameStart(sanitized, gameT.grid, gameT.startTime, gameT.gameDuration, gameT.totalPossibleWords, gameT.totalPossibleScore);
                }

                if (gameT.status === "waiting" && players.length > 1) {
                    setTimeout(async () => {
                        const currentGame = GameManager.getGame(sanitized);
                        if (currentGame && currentGame.status === "waiting") {
                            await GameManager.startGamePlaying(sanitized);
                            const updatedGame = GameManager.getGame(sanitized);
                            if (updatedGame) {
                                void GameManager.broadcastToGame(sanitized, async (client) => {
                                    await client.onGameStart(sanitized, updatedGame.grid, updatedGame.startTime!, updatedGame.gameDuration, updatedGame.totalPossibleWords, updatedGame.totalPossibleScore);
                                });

                                scheduleGameEnd(sanitized, updatedGame.gameDuration);
                            }
                        }
                    }, 1000);
                }
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
        await GameManager.startGamePlaying(gameId);
        const updatedGame = GameManager.getGame(gameId);
        if (!updatedGame) {
            throw new Error(`Game ${gameId} not found after starting`);
        }

        void GameManager.broadcastToGame(gameId, async (client) => {
            await client.onGameStart(gameId, updatedGame.grid, updatedGame.startTime!, updatedGame.gameDuration, updatedGame.totalPossibleWords, updatedGame.totalPossibleScore);
        });

        scheduleGameEnd(gameId, updatedGame.gameDuration);
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

        const playerWordCount = GameManager.getPlayerWordCount(gameId, player);
        if (playerWordCount >= MAX_WORDS_PER_PLAYER) {
            disconnectLastCaller();
            throw new Error(`Word limit exceeded: ${MAX_WORDS_PER_PLAYER}`);
        }

        const result = await GameManager.submitWord({ gameId, player, word, cells });
        const players = GameManager.getPlayerScores(gameId);
        void GameManager.broadcastToGame(gameId, async (client, playerIndex) => {
            await client.onPlayerUpdate(gameId, players, game.status, playerIndex);
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
        void GameManager.broadcastToGame(gameId, async (client) => {
            await client.onSettingsUpdate(gameId, settings.gridWidth, settings.gridHeight, settings.gameDuration);
        });
    },

    async getGameSettings(gameId: string): Promise<{ gridWidth: number; gridHeight: number; gameDuration: number }> {
        return GameManager.getGameSettings(gameId);
    },

    async watchChallenge(challengeId: string, signature: string, publicKey: string, creatorScore: number, creatorWords: { word: string; points: number }[], grid: GridCell[][], totalPossibleScore: number, totalPossibleWords: number): Promise<void> {
        const player = getServerSideClient();
        if (!player) {
            throw new Error(`No active caller`);
        }

        const payload = { challengeId };
        const isValid = await verifySignature(payload, signature, publicKey);
        if (!isValid) {
            throw new Error(`Invalid signature for challenge ${challengeId}`);
        }

        challengeWatchers.set(challengeId, {
            publicKey,
            client: player,
            completionCount: 0,
            createdAt: Date.now(),
            creatorScore,
            creatorWords,
            grid,
            totalPossibleScore,
            totalPossibleWords,
        });

        onLastCallerDisconnect(() => {
            challengeWatchers.delete(challengeId);
        });
    },

    async submitChallengeCompletion(challengeId: string, signature: string, publicKey: string, playerScore: number, playerWords: { word: string; points: number }[]): Promise<void> {
        const payload = { challengeId };
        const isValid = await verifySignature(payload, signature, publicKey);
        if (!isValid) {
            throw new Error(`Invalid signature for challenge ${challengeId}`);
        }

        const watcher = challengeWatchers.get(challengeId);
        if (!watcher) {
            return;
        }

        if (watcher.completionCount >= MAX_CHALLENGE_COMPLETIONS) {
            return;
        }

        watcher.completionCount++;

        void watcher.client.onChallengeCompleted(
            challengeId,
            playerScore,
            playerWords,
            watcher.grid,
            watcher.totalPossibleScore,
            watcher.totalPossibleWords,
            watcher.creatorScore,
            watcher.creatorWords
        );
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

    async onGameStart(gameId: string, grid: GridCell[][], startTime: number, duration: number, totalPossibleWords: number, totalPossibleScore: number): Promise<void> {
        if (gameState.gameId !== gameId) return;
        gameState.grid = grid;
        gameState.status = "playing";
        gameState.gameDuration = duration;
        gameState.timeRemaining = duration;
        gameState.isMultiplayer = true;
        gameState.score = 0;
        gameState.matchedWords = [];
        gameState.matchedWordsSet.clear();
        gameState.allWords = {};
        gameState.totalPossibleWords = totalPossibleWords;
        gameState.totalPossibleScore = totalPossibleScore;

        closeGameOverModal();

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
            gameState.matchedWordsSet.clear();
            for (let wordData of allWords[myPlayerId]) {
                gameState.matchedWordsSet.add(wordData.word);
            }
        }

        const gameOverState: GameOverState = {
            grid: gameState.grid,
            playerResults: players.map(player => ({
                id: player.id,
                score: player.score,
                matchedWords: allWords[player.id] || [],
                isSelf: player.id === myPlayerId,
            })),
            totalPossibleScore: gameState.totalPossibleScore,
            totalPossibleWords: gameState.totalPossibleWords,
        };
        showGameOver(gameOverState, () => {
            pageURL.value = "lobby";
        });
    },

    async onSettingsUpdate(gameId: string, gridWidth: number, gridHeight: number, gameDuration: number): Promise<void> {
        if (gameState.gameId !== gameId) return;
        const dimensionsChanged = gameState.gridWidth !== gridWidth || gameState.gridHeight !== gridHeight;
        gameState.gridWidth = gridWidth;
        gameState.gridHeight = gridHeight;
        gameState.gameDuration = gameDuration;
        if (gameState.status !== "playing") {
            gameState.timeRemaining = gameDuration;
            if (dimensionsChanged) {
                await regenerateGridForCurrentSize();
            }
        }
    },

    async onChallengeCompleted(challengeId: string, playerScore: number, playerWords: { word: string; points: number }[], grid: GridCell[][], totalPossibleScore: number, totalPossibleWords: number, creatorScore: number, creatorWords: { word: string; points: number }[]): Promise<void> {
        const summary = `Scored ${playerScore} vs your ${creatorScore}`;
        addNotification({
            type: "challenge-completed",
            summary,
            data: {
                challengeId,
                grid,
                playerScore,
                creatorScore,
                playerWords,
                creatorWords,
                totalPossibleScore,
                totalPossibleWords,
            },
        });
    }
};

export type ClientHandlers = typeof clientHandlers;

const clientHandlersNoOp: ClientHandlers = {
    async onPlayerUpdate(gameId: string, players: { id: string; score: number }[], status: string, yourPlayerIndex: number): Promise<void> {
    },

    async onGameStart(gameId: string, grid: GridCell[][], startTime: number, duration: number, totalPossibleWords: number, totalPossibleScore: number): Promise<void> {
    },

    async onGameEnd(gameId: string, players: { id: string; score: number }[], allWords: Record<string, { word: string; points: number }[]>): Promise<void> {
    },

    async onSettingsUpdate(gameId: string, gridWidth: number, gridHeight: number, gameDuration: number): Promise<void> {
    },

    async onChallengeCompleted(challengeId: string, playerScore: number, playerWords: { word: string; points: number }[], grid: GridCell[][], totalPossibleScore: number, totalPossibleWords: number, creatorScore: number, creatorWords: { word: string; points: number }[]): Promise<void> {
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

function cleanupExpiredChallenges(): void {
    const now = Date.now();
    for (const [challengeId, watcher] of challengeWatchers.entries()) {
        if (now - watcher.createdAt > CHALLENGE_EXPIRY_TIME) {
            challengeWatchers.delete(challengeId);
        }
    }
}

setInterval(cleanupExpiredChallenges, 60 * 60 * 1000);
