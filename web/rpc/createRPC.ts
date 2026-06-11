import { createServerRPC } from "./createServerRPC";
import { createClientRPC } from "./createClientRPC";
import { getLastFunctionCaller } from "./FunctionCaller";

const serverSideClientCache = new WeakMap();

export function createRPC<T extends Record<string, (...args: any[]) => Promise<any>>>(handlers: T) {
    return {
        startServer: createServerRPC(handlers),
        getClient: (url: string, clientHandlers: T, onDisconnect?: () => void): T => createClientRPC<T>(url, clientHandlers, onDisconnect),
        getServerSideClient: (): T => {
            const caller = getLastFunctionCaller();
            if (!caller) {
                throw new Error(`No active client connection`);
            }

            let proxy = serverSideClientCache.get(caller);
            if (!proxy) {
                proxy = new Proxy({} as T, {
                    get(target, prop: string) {
                        return (...args: any[]) => {
                            return caller.call(prop, args);
                        };
                    }
                });
                serverSideClientCache.set(caller, proxy);
            }

            return proxy;
        }
    };
}

