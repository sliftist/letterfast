import * as http from "http";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "build-web");
const PORT = Number(process.env.PORT) || 8080;

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

const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath.endsWith("/")) urlPath += "index.html";

    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    fs.stat(filePath, (err, stat) => {
        let resolved = filePath;
        if (!err && stat.isDirectory()) {
            resolved = path.join(filePath, "index.html");
        } else if (err) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }
        const ext = path.extname(resolved).toLowerCase();
        const type = MIME[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        fs.createReadStream(resolved)
            .on("error", () => {
                res.writeHead(404);
                res.end("Not found");
            })
            .pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`Serving ${ROOT} at http://localhost:${PORT}/`);
});
