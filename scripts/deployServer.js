// Deploys the multiplayer server to an arbitrary host (ssh/scp must already be configured for it):
//   node scripts/deployServer.js <host>
// Copies the source + the Cloudflare API key (wrapped into the cloudflare.json format sliftutils expects), installs deps, and installs/restarts a systemd unit so the server runs as a daemon, starts on boot, and restarts on crash.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REMOTE_DIR = "/root/letterfast-server";
const API_KEY_PATH = "C:/Users/quent/letterquickapikey";
const SERVICE_NAME = "letterfast";

const host = process.argv[2];
if (!host) {
    throw new Error("Usage: node scripts/deployServer.js <host>");
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        console.log(`> ${cmd} ${args.join(" ")}`);
        const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", data => process.stdout.write(data));
        child.stderr.on("data", data => process.stderr.write(data));
        child.on("error", reject);
        child.on("close", code => {
            if (code !== 0) {
                reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
                return;
            }
            resolve(undefined);
        });
    });
}

async function main() {
    console.log(`Deploying server to ${host}:${REMOTE_DIR}`);

    await run("ssh", [host, `mkdir -p ${REMOTE_DIR}`]);

    await run("scp", ["./package.json", "./yarn.lock", "./tsconfig.json", `${host}:${REMOTE_DIR}/`]);
    await run("scp", ["-r", "./web", "./scripts", `${host}:${REMOTE_DIR}/`]);

    // The local file is the bare Cloudflare token; sliftutils' dns.ts reads {"key": ...} from ./cloudflare.json in the server's working directory.
    const apiKey = fs.readFileSync(API_KEY_PATH, "utf8").trim();
    const tempCloudflare = path.join(os.tmpdir(), `letterfast-cloudflare-${Date.now()}.json`);
    fs.writeFileSync(tempCloudflare, JSON.stringify({ key: apiKey }));
    try {
        await run("scp", [tempCloudflare, `${host}:${REMOTE_DIR}/cloudflare.json`]);
    } finally {
        fs.unlinkSync(tempCloudflare);
    }
    await run("ssh", [host, `chmod 600 ${REMOTE_DIR}/cloudflare.json`]);

    // --ignore-platform: package.json pins @cbor-extract/cbor-extract-win32-x64 in resolutions (a Windows-only binary), which newer yarns hard-fail on under Linux. --ignore-scripts matches how the previous production server installed.
    await run("ssh", [host, `cd ${REMOTE_DIR} && yarn install --ignore-platform --ignore-scripts`]);

    await run("scp", ["./scripts/letterfast.service", `${host}:/etc/systemd/system/${SERVICE_NAME}.service`]);
    await run("ssh", [host, `systemctl daemon-reload && systemctl enable ${SERVICE_NAME} && systemctl restart ${SERVICE_NAME}`]);

    // Give it a moment to crash if it's going to, so the status below is meaningful.
    await new Promise(resolve => setTimeout(resolve, 3000));
    await run("ssh", [host, `systemctl status ${SERVICE_NAME} --no-pager -l`]);

    console.log(`Deployed. Logs: ssh ${host} journalctl -u ${SERVICE_NAME} -f`);
}

main().catch(err => {
    console.error(err.stack ?? err);
    process.exit(1);
});
