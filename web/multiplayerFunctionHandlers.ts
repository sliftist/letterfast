import { createRPC } from "./rpc/createRPC";
import { GridCell, gameState, GameOverState, regenerateGridForCurrentSize, ensureCellToWordsForGrid } from "./GameState";
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
const RESTART_COUNTDOWN_MS = 10000;

const pendingRestarts = new Map<string, number>();
let peerFlashCounter = 0;

const MAX_CLIENT_ID_LENGTH = 64;
function sanitizeClientId(clientId: string | undefined): string {
    if (typeof clientId !== "string") return "";
    const trimmed = clientId.trim().slice(0, MAX_CLIENT_ID_LENGTH);
    // Only allow url-safe chars; anything else is silently dropped.
    return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : "";
}

async function broadcastSnapshot(gameId: string): Promise<void> {
    await GameManager.broadcastToGame(gameId, async (client, playerIndex) => {
        const game = GameManager.getGame(gameId);
        if (!game) return;
        const player = game.players[playerIndex];
        if (!player) return;
        const snap = GameManager.getSnapshot(gameId, player);
        if (!snap) return;
        await client.onGameState(snap);
    });
}

function scheduleGameEnd(gameId: string, duration: number, expectedSeq: number): void {
    setTimeout(() => {
        void (async () => {
            const finalGame = GameManager.getGame(gameId);
            if (!finalGame || finalGame.status !== "playing") return;
            if (finalGame.timerSeqNum !== expectedSeq) return;
            if (finalGame.gameMode === "cooperative") return;

            const allWords = GameManager.getAllWords(gameId);
            const players = GameManager.getPlayerScores(gameId);

            await GameManager.broadcastToGame(gameId, async (client) => {
                await client.onGameEnd(gameId, players, allWords);
            });
            await broadcastSnapshot(gameId);

            if (!GameManager.getGame(gameId)) return;

            setTimeout(() => {
                GameManager.endGame(gameId);
            }, END_TO_GAME_OVER_DELAY);
        })();
    }, duration);
}

function scheduleRestart(gameId: string): void {
    if (pendingRestarts.has(gameId)) return;
    const game = GameManager.getGame(gameId);
    if (!game) return;
    if (game.status !== "finished") return;

    const endTime = Date.now() + RESTART_COUNTDOWN_MS;
    pendingRestarts.set(gameId, endTime);

    void GameManager.broadcastToGame(gameId, async (client) => {
        await client.onRestartCountdown(gameId, endTime);
    });

    setTimeout(() => {
        void (async () => {
            pendingRestarts.delete(gameId);
            const g = GameManager.getGame(gameId);
            if (!g) return;
            if (g.status !== "finished") return;
            if (g.players.length === 0) return;

            const seq = await GameManager.startGamePlaying(gameId);
            const updatedGame = GameManager.getGame(gameId);
            if (!updatedGame) return;

            const players = GameManager.getPlayerScores(gameId);
            await GameManager.broadcastToGame(gameId, async (client, playerIndex) => {
                await client.onPlayerUpdate(gameId, players, updatedGame.status, playerIndex);
                await client.onGameStart(gameId, updatedGame.grid, updatedGame.startTime!, updatedGame.gameDuration, updatedGame.totalPossibleWords, updatedGame.totalPossibleScore);
            });
            await broadcastSnapshot(gameId);

            if (!GameManager.getGame(gameId)) return;

            if (updatedGame.gameMode !== "cooperative") {
                scheduleGameEnd(gameId, updatedGame.gameDuration, seq);
            }
        })();
    }, RESTART_COUNTDOWN_MS);
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
            void broadcastSnapshot(gameId);
            const players = GameManager.getPlayerScores(gameId);
            void GameManager.broadcastToGame(gameId, async (playerClient, playerIndex) => {
                await playerClient.onPlayerUpdate(gameId, players, game.status, playerIndex);
            });
        }
    });
}
const serverHandlers = {
    async createGame(playerCount: number, clientId?: string): Promise<{ gameId: string }> {
        const player = getServerSideClient();
        if (!player) {
            throw new Error(`No active caller`);
        }

        const safeClientId = sanitizeClientId(clientId);
        const result = await GameManager.createGame(playerCount, player, safeClientId);
        setupPlayerDisconnect(result.gameId, player);

        const players = GameManager.getPlayerScores(result.gameId);
        // Wait, so the client can know the game ID before we tell them about the update. Otherwise, they will just ignore the update.
        setImmediate(() => {
            void player.onPlayerUpdate(result.gameId, players, "waiting", 0);
        });
        return result;
    },

    async joinGame(gameId: string, defaultGridWidth?: number, defaultGridHeight?: number, defaultGameDuration?: number, clientId?: string): Promise<void> {
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

        const safeClientId = sanitizeClientId(clientId);
        let game = GameManager.getGame(sanitized);
        if (!game) {
            await GameManager.createGameWithId(sanitized, 16, player, gridWidth, gridHeight, gameDuration, false, false, safeClientId);
            game = GameManager.getGame(sanitized);
        } else {
            GameManager.joinGame(sanitized, player, safeClientId);
        }

        setupPlayerDisconnect(sanitized, player);

        if (game) {
            let gameT = game;
            // Wait, so the client can know the game ID before we tell them about the update. Otherwise, they will just ignore the update.
            setImmediate(() => {
                void (async () => {
                    // Restore the rejoining player FIRST and DIRECTLY (everything is already in memory). onGameStart flips them to the board, then their own snapshot restores grid + scores + word lists in one message. This must not sit behind broadcasts to other players — a dead/slow connection elsewhere would otherwise delay the rejoiner's words by the broadcast timeout.
                    if (gameT.status === "playing" && gameT.startTime) {
                        try {
                            await player.onGameStart(sanitized, gameT.grid, gameT.startTime, gameT.gameDuration, gameT.totalPossibleWords, gameT.totalPossibleScore);
                        } catch (err) {
                            console.error(`onGameStart to rejoining player failed:`, (err as Error).stack ?? err);
                        }
                    }
                    const ownSnapshot = GameManager.getSnapshot(sanitized, player);
                    if (ownSnapshot) {
                        try {
                            await player.onGameState(ownSnapshot);
                        } catch (err) {
                            console.error(`onGameState to rejoining player failed:`, (err as Error).stack ?? err);
                        }
                    }
                    // Then notify everyone else, fire-and-forget — never blocks the rejoiner.
                    const players = GameManager.getPlayerScores(sanitized);
                    void GameManager.broadcastToGame(sanitized, async (playerClient, playerIndex) => {
                        await playerClient.onPlayerUpdate(sanitized, players, gameT.status, playerIndex);
                    });
                    void broadcastSnapshot(sanitized);
                })();
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
        const seq = await GameManager.startGamePlaying(gameId);
        const updatedGame = GameManager.getGame(gameId);
        if (!updatedGame) {
            throw new Error(`Game ${gameId} not found after starting`);
        }

        void GameManager.broadcastToGame(gameId, async (client) => {
            await client.onGameStart(gameId, updatedGame.grid, updatedGame.startTime!, updatedGame.gameDuration, updatedGame.totalPossibleWords, updatedGame.totalPossibleScore);
        });
        void broadcastSnapshot(gameId);

        if (updatedGame.gameMode !== "cooperative") {
            scheduleGameEnd(gameId, updatedGame.gameDuration, seq);
        }
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
        const submitterIndex = game.players.indexOf(player);
        void GameManager.broadcastToGame(gameId, async (client, playerIndex) => {
            await client.onPlayerUpdate(gameId, players, game.status, playerIndex);
            if (game.gameMode === "cooperative") {
                await client.onCoopWord(gameId, word.toUpperCase(), result.points, submitterIndex, cells);
            }
        });
        void broadcastSnapshot(gameId);

        if (game.gameMode === "cooperative") {
            let totalScore = 0;
            for (const [, s] of game.scores) totalScore += s;
            const goal = Math.max(1, Math.ceil(game.totalPossibleScore * game.coopGoalFraction));
            if (totalScore >= goal && game.status === "playing") {
                const allWords = GameManager.getAllWords(gameId);
                const playersForEnd = GameManager.getPlayerScores(gameId);
                const winning = {
                    word: word.toUpperCase(),
                    points: result.points,
                    playerIndex: submitterIndex,
                };
                void GameManager.broadcastToGame(gameId, async (client) => {
                    await client.onGameEnd(gameId, playersForEnd, allWords, winning);
                });
                setTimeout(() => GameManager.endGame(gameId), 1000);
            }
        }

        return result;
    },

    async requestRestart(gameId: string): Promise<void> {
        const player = getServerSideClient();
        if (!player) {
            throw new Error(`No active caller`);
        }
        const game = GameManager.getGame(gameId);
        if (!game) {
            throw new Error(`Game ${gameId} not found`);
        }
        if (game.players[0] !== player) {
            throw new Error(`Only the host can start a new game`);
        }
        if (game.status !== "finished") return;
        scheduleRestart(gameId);
    },

    async updateGameSettings(gameId: string, gridWidth?: number, gridHeight?: number, gameDuration?: number, showRemainingWordsPerCell?: boolean, showTotalPossibleScore?: boolean, gameMode?: "competitive" | "cooperative" | "competitive-shared", coopGoalFraction?: number): Promise<void> {
        const player = getServerSideClient();
        if (!player) {
            throw new Error(`No active caller`);
        }

        GameManager.updateGameSettings({ gameId, player, gridWidth, gridHeight, gameDuration, showRemainingWordsPerCell, showTotalPossibleScore, gameMode, coopGoalFraction });
        const settings = GameManager.getGameSettings(gameId);
        void GameManager.broadcastToGame(gameId, async (client) => {
            await client.onSettingsUpdate(gameId, settings.gridWidth, settings.gridHeight, settings.gameDuration, settings.showRemainingWordsPerCell, settings.showTotalPossibleScore, settings.gameMode, settings.coopGoalFraction);
        });
        void broadcastSnapshot(gameId);
    },

    async getGameSettings(gameId: string): Promise<{ gridWidth: number; gridHeight: number; gameDuration: number; showRemainingWordsPerCell: boolean; showTotalPossibleScore: boolean; gameMode: "competitive" | "cooperative" | "competitive-shared"; coopGoalFraction: number }> {
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
    async onGameState(snapshot: GameManager.GameSnapshot): Promise<void> {
        if (!gameState.isMultiplayer) return;
        if (gameState.gameId !== snapshot.gameId) return;
        if (snapshot.status === "playing" && gameState.status !== "playing") {
            // Resync (e.g. after a reconnect) into a running game — a stale game-over modal would otherwise sit on top of a playing board with nothing left to close it.
            closeGameOverModal();
        }
        gameState.players = snapshot.players;
        gameState.status = snapshot.status as any;
        gameState.startTime = snapshot.startTime;
        if (snapshot.status !== "playing") {
            gameState.timeRemaining = snapshot.gameDuration;
            gameState.elapsedTime = 0;
        } else if (snapshot.startTime !== undefined) {
            gameState.timeRemaining = Math.max(0, snapshot.gameDuration - (Date.now() - snapshot.startTime));
            gameState.elapsedTime = Math.max(0, Date.now() - snapshot.startTime);
        }
        gameState.myPlayerIndex = snapshot.yourPlayerIndex;
        gameState.gridWidth = snapshot.gridWidth;
        gameState.gridHeight = snapshot.gridHeight;
        gameState.gameDuration = snapshot.gameDuration;
        gameState.gameMode = snapshot.gameMode;
        gameState.coopGoalFraction = snapshot.coopGoalFraction;
        gameState.showRemainingWordsPerCell = snapshot.showRemainingWordsPerCell;
        gameState.showTotalPossibleScore = snapshot.showTotalPossibleScore;
        gameState.totalPossibleWords = snapshot.totalPossibleWords;
        gameState.totalPossibleScore = snapshot.totalPossibleScore;
        if (snapshot.grid && snapshot.grid.length > 0) {
            gameState.grid = snapshot.grid;
            void ensureCellToWordsForGrid(snapshot.grid);
        }
        if (snapshot.yourPlayerIndex >= 0 && snapshot.players[snapshot.yourPlayerIndex]) {
            gameState.score = snapshot.players[snapshot.yourPlayerIndex].score;
        }
        if (snapshot.gameMode === "cooperative") {
            gameState.matchedWords = snapshot.coopMatchedWords.map(w => ({
                word: w.word,
                points: w.points,
                playerIndex: w.playerIndex,
            }));
            gameState.matchedWordsSet = new Set(snapshot.coopMatchedWords.map(w => w.word));
        } else if (gameState.matchedWords.length === 0 && snapshot.yourWords && snapshot.yourWords.length > 0) {
            // Competitive reconnect: restore the player's own word list from the server. Only when the local list is empty (fresh rejoin) — mid-game snapshots must not clobber local-only entries like competitive-shared "blocked" strikethroughs.
            gameState.matchedWords = snapshot.yourWords.map(w => ({ word: w.word, points: w.points }));
            gameState.matchedWordsSet = new Set(snapshot.yourWords.map(w => w.word.toUpperCase()));
        }
    },

    async onPlayerUpdate(gameId: string, players: { id: string; score: number }[], status: string, yourPlayerIndex: number): Promise<void> {
        if (!gameState.isMultiplayer) return;
        if (gameState.gameId !== gameId) return;
        gameState.players = players;
        gameState.status = status as any;
        gameState.myPlayerIndex = yourPlayerIndex;
        if (yourPlayerIndex !== undefined && players[yourPlayerIndex]) {
            gameState.score = players[yourPlayerIndex].score;
        }
    },

    async onGameStart(gameId: string, grid: GridCell[][], startTime: number, duration: number, totalPossibleWords: number, totalPossibleScore: number): Promise<void> {
        if (!gameState.isMultiplayer) return;
        if (gameState.gameId !== gameId) return;
        gameState.grid = grid;
        void ensureCellToWordsForGrid(grid);
        gameState.gameDuration = duration;
        gameState.startTime = startTime;
        gameState.timeRemaining = Math.max(0, duration - (Date.now() - startTime));
        gameState.elapsedTime = Math.max(0, Date.now() - startTime);
        gameState.isMultiplayer = true;
        gameState.score = 0;
        gameState.matchedWords = [];
        gameState.matchedWordsSet.clear();
        gameState.allWords = {};
        gameState.totalPossibleWords = totalPossibleWords;
        gameState.totalPossibleScore = totalPossibleScore;
        gameState.restartCountdownEnd = 0;
        gameState.status = "playing";

        closeGameOverModal();

        pageURL.value = "game";
    },

    async onGameEnd(gameId: string, players: { id: string; score: number }[], allWords: Record<string, { word: string; points: number }[]>, coopWinningWord?: { word: string; points: number; playerIndex: number }): Promise<void> {
        if (!gameState.isMultiplayer) return;
        if (gameState.gameId !== gameId) return;
        gameState.status = "finished";
        gameState.startTime = undefined;
        gameState.restartCountdownEnd = 0;
        gameState.players = players;
        gameState.allWords = allWords;
        if (gameState.myPlayerIndex !== undefined && players[gameState.myPlayerIndex]) {
            gameState.score = players[gameState.myPlayerIndex].score;
        }
        const myPlayerId = gameState.myPlayerIndex !== undefined ? players[gameState.myPlayerIndex]?.id : undefined;
        // The board's word list (and the post-game missed-words demo, which is
        // "everything valid minus these") must match the mode: cooperative is
        // the COLLECTIVE words everyone found (so missed = words nobody found),
        // competitive is just THIS player's words (so missed = words you didn't
        // find). Mirrors the snapshot/onGameState logic for a refreshed client.
        if (gameState.gameMode === "cooperative") {
            const collective: { word: string; points: number }[] = [];
            const seen = new Set<string>();
            for (const pid of Object.keys(allWords)) {
                for (const w of allWords[pid]) {
                    const key = w.word.toUpperCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    collective.push(w);
                }
            }
            gameState.matchedWords = collective;
            gameState.matchedWordsSet = new Set(collective.map(w => w.word.toUpperCase()));
        } else {
            const myWords = (myPlayerId && allWords[myPlayerId]) || [];
            gameState.matchedWords = myWords;
            gameState.matchedWordsSet = new Set(myWords.map(w => w.word.toUpperCase()));
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
            coopWinningWord,
        };
        const onPlayAgain = () => { pageURL.value = "lobby"; };
        gameState.lastGameOverState = gameOverState;
        gameState.lastGameOverOnPlayAgain = onPlayAgain;
        showGameOver(gameOverState, () => {
            pageURL.value = "lobby";
        });
    },

    async onRestartCountdown(gameId: string, endTime: number): Promise<void> {
        if (!gameState.isMultiplayer) return;
        if (gameState.gameId !== gameId) return;
        gameState.restartCountdownEnd = endTime;
    },

    async onSettingsUpdate(gameId: string, gridWidth: number, gridHeight: number, gameDuration: number, showRemainingWordsPerCell?: boolean, showTotalPossibleScore?: boolean, gameMode?: "competitive" | "cooperative" | "competitive-shared", coopGoalFraction?: number): Promise<void> {
        if (!gameState.isMultiplayer) return;
        if (gameState.gameId !== gameId) return;
        const dimensionsChanged = gameState.gridWidth !== gridWidth || gameState.gridHeight !== gridHeight;
        gameState.gridWidth = gridWidth;
        gameState.gridHeight = gridHeight;
        gameState.gameDuration = gameDuration;
        if (showRemainingWordsPerCell !== undefined) {
            gameState.showRemainingWordsPerCell = !!showRemainingWordsPerCell;
        }
        if (showTotalPossibleScore !== undefined) {
            gameState.showTotalPossibleScore = !!showTotalPossibleScore;
        }
        if (gameMode !== undefined) {
            gameState.gameMode = gameMode === "cooperative" || gameMode === "competitive-shared"
                ? gameMode
                : "competitive";
        }
        if (coopGoalFraction !== undefined) {
            gameState.coopGoalFraction = Math.max(0.05, Math.min(1, coopGoalFraction));
        }
        if (gameState.status !== "playing") {
            gameState.timeRemaining = gameDuration;
            if (dimensionsChanged) {
                await regenerateGridForCurrentSize();
            }
        }
    },

    async onCoopWord(gameId: string, word: string, points: number, playerIndex: number, cells?: { row: number; col: number }[]): Promise<void> {
        if (!gameState.isMultiplayer) return;
        if (gameState.gameId !== gameId) return;
        if (!gameState.matchedWordsSet.has(word)) {
            gameState.matchedWords.push({ word, points, playerIndex });
            gameState.matchedWordsSet.add(word);
        }
        if (cells && cells.length > 0 && playerIndex !== gameState.myPlayerIndex) {
            gameState.peerFlashRequest = { id: ++peerFlashCounter, cells: cells.slice(), playerIndex };
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
    async onGameState(snapshot: GameManager.GameSnapshot): Promise<void> {
    },

    async onPlayerUpdate(gameId: string, players: { id: string; score: number }[], status: string, yourPlayerIndex: number): Promise<void> {
    },

    async onGameStart(gameId: string, grid: GridCell[][], startTime: number, duration: number, totalPossibleWords: number, totalPossibleScore: number): Promise<void> {
    },

    async onGameEnd(gameId: string, players: { id: string; score: number }[], allWords: Record<string, { word: string; points: number }[]>, coopWinningWord?: { word: string; points: number; playerIndex: number }): Promise<void> {
    },

    async onSettingsUpdate(gameId: string, gridWidth: number, gridHeight: number, gameDuration: number, showRemainingWordsPerCell?: boolean, showTotalPossibleScore?: boolean, gameMode?: "competitive" | "cooperative" | "competitive-shared", coopGoalFraction?: number): Promise<void> {
    },

    async onCoopWord(gameId: string, word: string, points: number, playerIndex: number, cells?: { row: number; col: number }[]): Promise<void> {
    },

    async onRestartCountdown(gameId: string, endTime: number): Promise<void> {
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

// Called by server.ts on boot with the rows loaded from SQLite. Re-arms the end timers for competitive games that were mid-play when the server went down (setTimeout state doesn't survive a restart).
export function restorePersistedGames(rows: { id: string; data: string }[]): void {
    const timers = GameManager.restoreSerializedGames(rows);
    for (const t of timers) {
        scheduleGameEnd(t.gameId, t.remainingMs, t.timerSeqNum);
    }
    if (rows.length > 0) {
        console.log(`Restored ${rows.length} persisted games (${timers.length} with active end timers)`);
    }
}

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
