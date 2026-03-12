import { PromiseObj } from "./PromiseObj";

export interface FunctionCallerInterface {
    call(method: string, args: unknown[]): Promise<unknown>;
    onDisconnect(callback: () => void): void;
}

type RPCMessage =
    | { type: "call"; id: string; method: string; args: unknown[] }
    | { type: "result"; id: string; result: unknown }
    | { type: "error"; id: string; error: string };

let lastFunctionCaller: FunctionCallerInterface | undefined;
export function getLastFunctionCaller(): FunctionCallerInterface | undefined {
    return lastFunctionCaller;
}

export function onLastCallerDisconnect(callback: () => void): void {
    if (!lastFunctionCaller) {
        throw new Error(`No active caller to register disconnect handler`);
    }
    lastFunctionCaller.onDisconnect(callback);
}

let functionCallerCount = 0;

export function createFunctionCaller(config: {
    send: (message: string) => void;
    onMessage: (handler: (message: string) => void) => void;
    onCall: (call: { method: string; args: unknown[] }) => Promise<unknown>;
    onDisconnect?: (handler: () => void) => void;
}): FunctionCallerInterface {
    const callerId = functionCallerCount++;
    const pendingCalls = new Map<string, PromiseObj<unknown>>();
    const disconnectCallbacks: (() => void)[] = [];
    let nextId = 0;

    config.onMessage(async (messageStr: string) => {
        const message: RPCMessage = JSON.parse(messageStr);

        if (message.type === "result") {
            console.log(`[${callerId}] RECEIVED RESULT (call id ${message.id}): ${JSON.stringify(message.result)}`);
            const pending = pendingCalls.get(message.id);
            if (!pending) return;
            pendingCalls.delete(message.id);
            pending.resolve(message.result);
        } else if (message.type === "error") {
            console.log(`[${callerId}] RECEIVED ERROR (call id ${message.id}): ${message.error}`);
            const pending = pendingCalls.get(message.id);
            if (!pending) return;
            pendingCalls.delete(message.id);
            pending.reject(new Error(message.error));
        } else if (message.type === "call") {
            try {
                console.log(`[${callerId}] RECEIVED CALL (call id ${message.id}): ${message.method}(${JSON.stringify(message.args).slice(1, -1)})`);
                lastFunctionCaller = self;
                const result = await config.onCall({ method: message.method, args: message.args });
                config.send(JSON.stringify({ type: "result", id: message.id, result }));
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                config.send(JSON.stringify({ type: "error", id: message.id, error: errorMessage }));
            }
        }
    });

    if (config.onDisconnect) {
        config.onDisconnect(() => {
            disconnectCallbacks.forEach(callback => callback());
        });
    }

    let self: FunctionCallerInterface = {
        call(method: string, args: unknown[]): Promise<unknown> {
            const id = String(nextId++);
            console.log(`[${callerId}] CALLING REMOTE (call id ${id}): ${method}(${JSON.stringify(args).slice(1, -1)})`);
            const promiseObj = new PromiseObj<unknown>();
            pendingCalls.set(id, promiseObj);
            config.send(JSON.stringify({ type: "call", id, method, args }));
            return promiseObj.promise;
        },
        onDisconnect(callback: () => void): void {
            disconnectCallbacks.push(callback);
        }
    };
    return self;
}

