import { createFunctionCaller, FunctionCallerInterface } from "./FunctionCaller";

export function createClientRPC<T extends Record<string, (...args: any[]) => Promise<any>>>(
    url: string,
    clientHandlers: T
): T {
    const ws = new WebSocket(url);
    const messageHandlers: ((message: string) => void)[] = [];
    let isOpen = false;
    let isClosed = false;
    const pendingMessages: string[] = [];
    const disconnectHandlers: (() => void)[] = [];

    const fireDisconnect = () => {
        if (isClosed) return;
        isClosed = true;
        // Snapshot in case a handler unregisters during iteration.
        for (const handler of disconnectHandlers.slice()) {
            try { handler(); } catch (e) { console.error("RPC disconnect handler threw:", e); }
        }
    };

    ws.onopen = () => {
        isOpen = true;
        while (pendingMessages.length > 0) {
            const message = pendingMessages.shift();
            if (message) {
                ws.send(message);
            }
        }
    };

    ws.onmessage = (event) => {
        messageHandlers.forEach(handler => handler(event.data));
    };

    ws.onerror = (event) => {
        console.warn("RPC WebSocket error:", event);
        fireDisconnect();
    };

    ws.onclose = () => {
        fireDisconnect();
    };

    const caller = createFunctionCaller({
        send: (message: string) => {
            if (isClosed) {
                // Drop messages on a dead socket; pending-call promises are
                // rejected by the disconnect handler in FunctionCaller.
                return;
            }
            if (isOpen) {
                ws.send(message);
            } else {
                pendingMessages.push(message);
            }
        },
        onMessage: (handler: (message: string) => void) => {
            messageHandlers.push(handler);
        },
        onCall: async (call: { method: string; args: unknown[] }) => {
            const handler = clientHandlers[call.method];
            if (!handler) {
                const availableMethods = Object.keys(clientHandlers).join(", ");
                throw new Error(`Client method ${call.method} not found. Available methods: ${availableMethods}`);
            }
            return await handler(...call.args);
        },
        onDisconnect: (handler: () => void) => {
            disconnectHandlers.push(handler);
            // If the socket already closed (e.g. registration happens after
            // a synchronous failure), notify immediately.
            if (isClosed) {
                try { handler(); } catch (e) { console.error("RPC disconnect handler threw:", e); }
            }
        },
        disconnect: () => {
            try { ws.close(); } catch (e) { console.warn("ws.close threw:", e); }
            fireDisconnect();
        }
    });

    return new Proxy({} as T, {
        get(target, prop: string) {
            return (...args: unknown[]) => {
                return caller.call(prop, args);
            };
        }
    });
}

