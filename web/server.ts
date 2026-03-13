import { startServer } from "./multiplayerFunctionHandlers";
import * as fs from "fs";

process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled rejection:", reason);
    console.error("Promise:", promise);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});

async function main() {
    const certPath = "/etc/letsencrypt/live/quentinbrooks.com-0001/fullchain.pem";
    const keyPath = "/etc/letsencrypt/live/quentinbrooks.com-0001/privkey.pem";

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        startServer({
            port: 7276,
            ssl: {
                certPath,
                keyPath
            }
        });
    } else {
        startServer({ port: 7276 });
    }
}

main().catch(console.error);