import { createFunctionCaller, FunctionCallerInterface } from "./FunctionCaller";

export function createClientRPC<T extends Record<string, (...args: any[]) => Promise<any>>>(
    url: string,
    clientHandlers: T
): T {
    const ws = new WebSocket(url);
    const messageHandlers: ((message: string) => void)[] = [];
    let isOpen = false;
    const pendingMessages: string[] = [];

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

    const caller = createFunctionCaller({
        send: (message: string) => {
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
        disconnect: () => {
            ws.close();
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

