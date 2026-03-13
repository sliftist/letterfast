import { isNode } from "typesafecss";

const CACHE_DURATION = 6 * 60 * 60 * 1000;
const WORDS_URL = "https://quentinbrooks.com/letterfast/words.txt.gz";

interface CacheMetadata {
    timestamp: number;
    contentLength: number;
    base64Data?: string;
}

let wordsPromise: Promise<string[]> | undefined;
let cachedWords: string[] | undefined;

async function fetchWords(): Promise<string[]> {
    if (isNode()) {
        return fetchWordsNode();
    }
    return fetchWordsBrowser();
}

async function fetchWordsBrowser(): Promise<string[]> {
    if (window.location.protocol === "file:") {
        return fetchWordsFromGeneratedJS();
    }

    const url = "./words.txt.gz";

    const cacheKey = "letterfast_words_cache";
    const metaKey = "letterfast_words_meta";

    let shouldDownload = true;
    let cachedMeta: CacheMetadata | undefined;

    try {
        const metaStr = localStorage.getItem(metaKey);
        if (metaStr) {
            cachedMeta = JSON.parse(metaStr);
            if (!cachedMeta) throw new Error("Failed to parse cache metadata");

            const age = Date.now() - cachedMeta.timestamp;

            if (age < CACHE_DURATION) {
                const cachedData = localStorage.getItem(cacheKey);
                if (cachedData && cachedMeta.base64Data) {
                    return decompressBrowser(base64ToBuffer(cachedMeta.base64Data));
                }
            } else {
                const headResponse = await fetch(url, { method: "HEAD" });
                const contentLength = parseInt(headResponse.headers.get("content-length") || "0");

                if (contentLength === cachedMeta.contentLength) {
                    cachedMeta.timestamp = Date.now();
                    localStorage.setItem(metaKey, JSON.stringify(cachedMeta));

                    const cachedData = localStorage.getItem(cacheKey);
                    if (cachedData && cachedMeta.base64Data) {
                        return decompressBrowser(base64ToBuffer(cachedMeta.base64Data));
                    }
                }
            }
        }
    } catch (error) {
        console.warn("Cache check failed, downloading fresh:", error);
    }

    const response = await fetch(url, {
        credentials: "omit",
        mode: "cors",
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch words: ${response.status} ${response.statusText}`);
    }

    const compressedBuffer = await response.arrayBuffer();
    const contentLength = compressedBuffer.byteLength;

    const base64Data = bufferToBase64(new Uint8Array(compressedBuffer));
    const meta: CacheMetadata = {
        timestamp: Date.now(),
        contentLength,
        base64Data
    };

    try {
        localStorage.setItem(metaKey, JSON.stringify(meta));
        localStorage.setItem(cacheKey, base64Data);
    } catch (error) {
        console.warn("Failed to cache words:", error);
    }

    return decompressBrowser(new Uint8Array(compressedBuffer));
}

async function fetchWordsFromGeneratedJS(): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "./words.generated.js";
        script.onload = () => {
            const base64Data = (window as any).__LETTERFAST_WORDS__;
            if (!base64Data) {
                reject(new Error("Failed to load words from generated file"));
                return;
            }
            const compressedData = base64ToBuffer(base64Data);
            resolve(decompressBrowser(compressedData));
        };
        script.onerror = () => reject(new Error("Failed to load words.generated.js"));
        document.head.appendChild(script);
    });
}

async function fetchWordsNode(): Promise<string[]> {
    const fs = await import("fs");
    const path = await import("path");
    const zlib = await import("zlib");
    const https = await import("https");

    const cacheDir = path.resolve(process.cwd(), "./cache");
    const cachePath = path.join(cacheDir, "words.txt.gz");
    const metaPath = path.join(cacheDir, "words.meta.json");

    let shouldDownload = true;
    let cachedMeta: CacheMetadata | undefined;

    try {
        if (fs.existsSync(metaPath) && fs.existsSync(cachePath)) {
            const metaStr = fs.readFileSync(metaPath, "utf8");
            cachedMeta = JSON.parse(metaStr);
            if (!cachedMeta) throw new Error("Failed to parse cache metadata");

            const age = Date.now() - cachedMeta.timestamp;

            if (age < CACHE_DURATION) {
                const compressedData = fs.readFileSync(cachePath);
                return decompressNode(compressedData, zlib);
            } else {
                const contentLength = await getContentLengthNode(WORDS_URL, https);

                if (contentLength === cachedMeta.contentLength) {
                    cachedMeta.timestamp = Date.now();
                    fs.writeFileSync(metaPath, JSON.stringify(cachedMeta));

                    const compressedData = fs.readFileSync(cachePath);
                    return decompressNode(compressedData, zlib);
                }
            }
        }
    } catch (error) {
        console.warn("Cache check failed, downloading fresh:", error);
    }

    const compressedData = await downloadNode(WORDS_URL, https);

    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const meta: CacheMetadata = {
        timestamp: Date.now(),
        contentLength: compressedData.length
    };

    try {
        fs.writeFileSync(cachePath, compressedData);
        fs.writeFileSync(metaPath, JSON.stringify(meta));
    } catch (error) {
        console.warn("Failed to cache words:", error);
    }

    return decompressNode(compressedData, zlib);
}

async function decompressBrowser(compressedData: Uint8Array): Promise<string[]> {
    const blob = new Blob([new Uint8Array(compressedData)]);
    const stream = blob.stream();
    if (!stream) {
        throw new Error("Failed to create stream from compressed data");
    }

    const decompressedStream = stream.pipeThrough(new DecompressionStream("gzip"));
    const decompressedResponse = new Response(decompressedStream);
    const text = await decompressedResponse.text();

    return JSON.parse(text);
}

async function decompressNode(compressedData: Buffer, zlib: any): Promise<string[]> {
    return new Promise((resolve, reject) => {
        zlib.gunzip(compressedData, (error: Error | null, result: Buffer) => {
            if (error) {
                reject(error);
                return;
            }
            const text = result.toString("utf8");
            resolve(JSON.parse(text));
        });
    });
}

async function getContentLengthNode(url: string, https: any): Promise<number> {
    return new Promise((resolve, reject) => {
        const request = https.request(url, { method: "HEAD" }, (response: any) => {
            const contentLength = parseInt(response.headers["content-length"] || "0");
            resolve(contentLength);
        });

        request.on("error", reject);
        request.end();
    });
}

async function downloadNode(url: string, https: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        https.get(url, (response: any) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
                return;
            }

            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => resolve(Buffer.concat(chunks)));
            response.on("error", reject);
        }).on("error", reject);
    });
}

function bufferToBase64(buffer: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < buffer.length; i++) {
        binary += String.fromCharCode(buffer[i]);
    }
    return btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array {
    const binary = atob(base64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        buffer[i] = binary.charCodeAt(i);
    }
    return buffer;
}

wordsPromise = fetchWords().then(words => {
    cachedWords = words;
    return words;
}).catch(error => {
    console.error("Failed to load words:", error);
    throw error;
});

export function getWords(): Promise<string[]> {
    if (cachedWords) {
        return Promise.resolve(cachedWords);
    }
    return wordsPromise!;
}
