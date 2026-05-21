import { startServer } from "./multiplayerFunctionHandlers";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import * as zlib from "zlib";
import * as crypto from "crypto";

process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled rejection:", reason);
    console.error("Promise:", promise);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});

const STATIC_PORT = Number(process.env.STATIC_PORT) || 8881;
const STATIC_ROOT = path.resolve(__dirname, "..", "build-web");

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
};

const COMPRESSIBLE = new Set([
    "text/html; charset=utf-8",
    "application/javascript; charset=utf-8",
    "text/css; charset=utf-8",
    "application/json; charset=utf-8",
    "image/svg+xml",
    "text/plain; charset=utf-8",
    "application/wasm",
]);

interface CachedFile {
    mtimeMs: number;
    size: number;
    raw: Buffer;
    gzip?: Buffer;
    br?: Buffer;
    etag: string;
    type: string;
}

// In-memory cache keyed by absolute path. Entries are invalidated when the
// underlying file's mtime changes, so a rebuild during dev picks up fresh
// content without needing a restart.
const fileCache = new Map<string, CachedFile>();

function pickEncoding(acceptEncoding: string | undefined): "br" | "gzip" | undefined {
    const ae = (acceptEncoding || "").toLowerCase();
    if (ae.includes("br")) return "br";
    if (ae.includes("gzip")) return "gzip";
    return undefined;
}

function loadFromCache(absPath: string, type: string): CachedFile | undefined {
    let cached = fileCache.get(absPath);
    let stat: fs.Stats;
    try {
        stat = fs.statSync(absPath);
    } catch {
        return undefined;
    }
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached;
    }
    let raw: Buffer;
    try {
        raw = fs.readFileSync(absPath);
    } catch {
        return undefined;
    }
    const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
    const etag = `"${hash}"`;
    const entry: CachedFile = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        raw,
        etag,
        type,
    };
    if (COMPRESSIBLE.has(type)) {
        // Pre-compute compressed variants once so requests don't pay the
        // cost on every hit.
        try { entry.gzip = zlib.gzipSync(raw, { level: 9 }); } catch (e) { console.warn("[static] gzip failed:", e); }
        try { entry.br = zlib.brotliCompressSync(raw); } catch (e) { console.warn("[static] brotli failed:", e); }
    }
    fileCache.set(absPath, entry);
    return entry;
}

function staticHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Allow": "GET, HEAD" });
        res.end("Method Not Allowed");
        return;
    }

    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath.endsWith("/")) urlPath += "index.html";

    const filePath = path.join(STATIC_ROOT, urlPath);
    if (!filePath.startsWith(STATIC_ROOT)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    let resolved = filePath;
    let stat: fs.Stats | undefined;
    try {
        stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
            resolved = path.join(resolved, "index.html");
            stat = fs.statSync(resolved);
        }
    } catch {
        res.writeHead(404);
        res.end("Not found");
        return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";

    const entry = loadFromCache(resolved, type);
    if (!entry) {
        res.writeHead(404);
        res.end("Not found");
        return;
    }

    // Conditional GET — let the browser skip the body when nothing changed.
    const inm = req.headers["if-none-match"];
    if (inm && inm === entry.etag) {
        res.writeHead(304, {
            "ETag": entry.etag,
            "Cache-Control": "public, max-age=0, must-revalidate",
        });
        res.end();
        return;
    }

    const encoding = pickEncoding(req.headers["accept-encoding"] as string | undefined);
    let body: Buffer = entry.raw;
    const headers: Record<string, string> = {
        "Content-Type": type,
        "ETag": entry.etag,
        // Always require revalidation but the etag check makes that cheap
        // (304 on hit). This is the right default during active dev — long
        // immutable caches require content-hashed filenames in the build.
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Vary": "Accept-Encoding",
    };
    if (encoding === "br" && entry.br) {
        body = entry.br;
        headers["Content-Encoding"] = "br";
    } else if (encoding === "gzip" && entry.gzip) {
        body = entry.gzip;
        headers["Content-Encoding"] = "gzip";
    }
    headers["Content-Length"] = String(body.length);

    res.writeHead(200, headers);
    if (req.method === "HEAD") { res.end(); return; }
    res.end(body);
}

function startStaticServer(): void {
    if (!fs.existsSync(STATIC_ROOT)) {
        console.warn(`[static] ${STATIC_ROOT} does not exist; static server not started`);
        return;
    }
    const server = http.createServer(staticHandler);
    server.on("error", (err) => {
        console.error("[static] server error:", err);
    });
    server.listen(STATIC_PORT, () => {
        console.log(`[static] serving ${STATIC_ROOT} at http://localhost:${STATIC_PORT}/`);
    });
}

async function main() {
    const certPath = "/etc/letsencrypt/live/quentinbrooks.com-0001/fullchain.pem";
    const keyPath = "/etc/letsencrypt/live/quentinbrooks.com-0001/privkey.pem";

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        startServer({
            port: 8880,
            ssl: {
                certPath,
                keyPath
            }
        });
    } else {
        startServer({ port: 8880 });
    }

    startStaticServer();
}

main().catch(console.error);
// Suppress an unused-import warning for https (kept for future SSL static hosting).
void https;