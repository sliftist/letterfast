import { isNode } from "typesafecss";
import { getClient, clientHandlers } from "./multiplayerFunctionHandlers";

let rpcClientInstance: ReturnType<typeof getClient> | undefined;

// Called when the CURRENT client's websocket dies (stale/replaced clients are ignored). The game wires this to its ConnectionManager so a dropped socket auto-reconnects instead of leaving a zombie "connected" state.
let rpcDisconnectHandler: (() => void) | undefined;
export function setRPCDisconnectHandler(handler: (() => void) | undefined): void {
    rpcDisconnectHandler = handler;
}

export function getRPCClient(): ReturnType<typeof getClient> {
    if (isNode()) {
        throw new Error(`RPC client cannot be initialized on server`);
    }

    if (!rpcClientInstance) {
        let host = window.location.hostname;
        let protocol = "wss";
        if (window.location.protocol === "file:") {
            protocol = "ws";
            host = "localhost";
        }
        if (host === "letterquick.com" || host.endsWith(".letterquick.com")) {
            if (!host.startsWith("multiplayer.")) {
                host = "multiplayer.letterquick.com";
            }
        }
        const wsUrl = `${protocol}://${host}:8880`;
        let created: ReturnType<typeof getClient> | undefined;
        created = getClient(wsUrl, clientHandlers as any, () => {
            if (rpcClientInstance === created) {
                rpcDisconnectHandler?.();
            }
        });
        rpcClientInstance = created;
    }

    return rpcClientInstance;
}

export function disconnectRPC(): void {
    rpcClientInstance = undefined;
}

export function resetRPCClient(): void {
    rpcClientInstance = undefined;
}
