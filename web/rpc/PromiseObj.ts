export class PromiseObj<T = unknown> {
    promise: Promise<T>;
    resolve!: (value: T) => void;
    reject!: (error: unknown) => void;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}

