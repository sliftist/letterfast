import { startServer } from "./multiplayerFunctionHandlers";

process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled rejection:", reason);
    console.error("Promise:", promise);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});

async function main() {
    startServer({ port: 8080 });
}

main().catch(console.error);