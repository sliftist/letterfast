import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import { createFunctionCaller } from "./FunctionCaller";

export function createServerRPC<T extends Record<string, (...args: any[]) => Promise<any>>>(handlers: T) {
    return function startServer(config: { 
        port: number;
        ssl?: {
            certPath: string;
            keyPath: string;
        };
    }) {
        let server: http.Server | https.Server;

        if (config.ssl) {
            const cert = fs.readFileSync(config.ssl.certPath, "utf8");
            const key = fs.readFileSync(config.ssl.keyPath, "utf8");
            
            server = https.createServer({ cert, key }, (req, res) => {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("WebSocket RPC Server (Secure)");
            });
        } else {
            server = http.createServer((req, res) => {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("WebSocket RPC Server");
            });
        }

        const wss = new WebSocketServer({ server });

        wss.on("connection", (ws: WebSocket) => {
            console.log("Client connected");

            const messageHandlers: ((message: string) => void)[] = [];
            const disconnectCallbacks: (() => void)[] = [];

            ws.on("message", (data: Buffer) => {
                const messageStr = data.toString();
                messageHandlers.forEach(handler => handler(messageStr));
            });

            ws.on("close", () => {
                console.log("Client disconnected");
                disconnectCallbacks.forEach(callback => callback());
            });

            createFunctionCaller({
                send: (message: string) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(message);
                    }
                },
                onMessage: (handler: (message: string) => void) => {
                    messageHandlers.push(handler);
                },
                onCall: async (call: { method: string; args: unknown[] }) => {
                    const handler = handlers[call.method];
                    if (!handler) {
                        const availableMethods = Object.keys(handlers).join(", ");
                        throw new Error(`Method ${call.method} not found. Available methods: ${availableMethods}`);
                    }
                    return await handler(...call.args);
                },
                onDisconnect: (handler: () => void) => {
                    disconnectCallbacks.push(handler);
                },
                disconnect: () => {
                    ws.close();
                }
            });
        });

        server.listen(config.port, () => {
            const protocol = config.ssl ? "wss" : "ws";
            console.log(`WebSocket RPC server (${protocol}) listening on port ${config.port}`);
        });

        return server;
    };
}

