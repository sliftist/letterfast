import { isNode } from "typesafecss";
import { getClient, clientHandlers } from "./multiplayerFunctionHandlers";

let rpcClientInstance: ReturnType<typeof getClient> | undefined;

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
        const wsUrl = `${protocol}://${host}:7276`;
        rpcClientInstance = getClient(wsUrl, clientHandlers as any);
    }

    return rpcClientInstance;
}

export function disconnectRPC(): void {
    rpcClientInstance = undefined;
}

export function resetRPCClient(): void {
    rpcClientInstance = undefined;
}
