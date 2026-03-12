import { isNode } from "typesafecss";
import { getClient, clientHandlers } from "./multiplayerFunctionHandlers";

let rpcClientInstance: ReturnType<typeof getClient> | undefined;

export function getRPCClient(): ReturnType<typeof getClient> {
    if (isNode()) {
        throw new Error(`RPC client cannot be initialized on server`);
    }

    if (!rpcClientInstance) {
        rpcClientInstance = getClient("ws://localhost:8080", clientHandlers as any);
    }

    return rpcClientInstance;
}
