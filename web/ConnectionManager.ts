import { observable } from "mobx";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectionCallbacks {
    onStatusChange?: (status: ConnectionStatus) => void;
    onConnect?: () => void;
    onDisconnect?: () => void;
    onError?: (error: any) => void;
}

export class ConnectionManager {
    state = observable({
        status: "disconnected" as ConnectionStatus,
        reconnectAttempts: 0,
        reconnectTimeout: undefined as number | undefined,
    });

    private callbacks: ConnectionCallbacks;
    private connectFn: () => Promise<void>;
    private disconnectFn: () => void;
    private isIntentionalDisconnect = false;

    private readonly DISCONNECT_RECONNECT_DELAY = 5000;
    private readonly ERROR_RECONNECT_DELAY = 15000;

    constructor(config: {
        connect: () => Promise<void>;
        disconnect: () => void;
        callbacks?: ConnectionCallbacks;
    }) {
        this.connectFn = config.connect;
        this.disconnectFn = config.disconnect;
        this.callbacks = config.callbacks || {};
    }

    async connect(): Promise<void> {
        this.isIntentionalDisconnect = false;
        this.clearReconnectTimeout();
        
        this.setStatus("connecting");
        
        try {
            await this.connectFn();
            this.state.reconnectAttempts = 0;
            this.setStatus("connected");
            this.callbacks.onConnect?.();
        } catch (error) {
            console.error("Connection error:", error);
            this.setStatus("error");
            this.callbacks.onError?.(error);
            this.scheduleReconnect(false);
        }
    }

    disconnect(): void {
        this.isIntentionalDisconnect = true;
        this.clearReconnectTimeout();
        this.disconnectFn();
        this.setStatus("disconnected");
        this.callbacks.onDisconnect?.();
    }

    handleDisconnect(): void {
        if (this.isIntentionalDisconnect) return;
        
        this.setStatus("disconnected");
        this.callbacks.onDisconnect?.();
        this.scheduleReconnect(true);
    }

    handleError(error: any): void {
        console.error("Connection error:", error);
        this.setStatus("error");
        this.callbacks.onError?.(error);
        this.scheduleReconnect(false);
    }

    private scheduleReconnect(isDisconnect: boolean): void {
        if (this.isIntentionalDisconnect) return;
        
        this.clearReconnectTimeout();
        
        const delay = isDisconnect ? this.DISCONNECT_RECONNECT_DELAY : this.ERROR_RECONNECT_DELAY;
        this.state.reconnectAttempts++;
        
        console.log(`Scheduling reconnect in ${delay}ms (attempt ${this.state.reconnectAttempts})`);
        
        this.state.reconnectTimeout = window.setTimeout(() => {
            console.log(`Attempting to reconnect (attempt ${this.state.reconnectAttempts})`);
            void this.connect();
        }, delay);
    }

    private clearReconnectTimeout(): void {
        if (this.state.reconnectTimeout !== undefined) {
            clearTimeout(this.state.reconnectTimeout);
            this.state.reconnectTimeout = undefined;
        }
    }

    private setStatus(status: ConnectionStatus): void {
        if (this.state.status !== status) {
            this.state.status = status;
            this.callbacks.onStatusChange?.(status);
        }
    }

    cleanup(): void {
        this.isIntentionalDisconnect = true;
        this.clearReconnectTimeout();
        this.disconnectFn();
    }
}
