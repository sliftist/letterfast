import * as fs from "fs";
import { generateCert, getAccountKey, parseCert } from "sliftutils/misc/https/httpsCerts";
import { setRecord } from "sliftutils/misc/https/dns";
import { getExternalIP } from "socket-function/src/networking";

// Renew once this fraction of the cert's lifetime has passed. Matches sliftutils' getHTTPSCert threshold so certs renew with plenty of margin (Let's Encrypt certs last 90 days → renews around day 36).
const RENEW_LIFETIME_FRACTION = 0.4;
// How often the running server re-checks whether the cert needs renewal.
const CERT_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export interface KeyCert {
    key: string;
    cert: string;
}

function certCachePath(domain: string): string {
    return domain + ".cert";
}

function needsRenewal(keyCert: KeyCert): boolean {
    const certObj = parseCert(keyCert.cert);
    const notBefore = +new Date(certObj.validity.notBefore);
    const notAfter = +new Date(certObj.validity.notAfter);
    const renewAt = notBefore + (notAfter - notBefore) * RENEW_LIFETIME_FRACTION;
    return Date.now() >= renewAt;
}

// Loads the cert cached on disk, regenerating it via Let's Encrypt (DNS-01 through Cloudflare) when missing, unparsable, or past the renewal threshold. Also covers *.domain, so one cert handles multiplayer.<domain> etc.
export async function loadOrGenerateCert(domain: string): Promise<KeyCert> {
    const path = certCachePath(domain);
    let cached: KeyCert | undefined;
    try {
        cached = JSON.parse(fs.readFileSync(path, "utf8")) as KeyCert;
    } catch {
        // Missing or corrupt cache — regenerate below.
    }
    if (cached) {
        try {
            if (!needsRenewal(cached)) {
                return cached;
            }
            console.log(`Cert for ${domain} is past its renewal threshold, regenerating`);
        } catch (err) {
            console.warn(`Cached cert for ${domain} could not be parsed, regenerating:`, (err as Error).stack ?? err);
        }
    } else {
        console.log(`No cached cert for ${domain}, generating`);
    }

    const accountKey = await getAccountKey(domain);
    const fresh = await generateCert({ accountKey, domain, altDomains: ["*." + domain] });
    const keyCert: KeyCert = { key: fresh.key, cert: fresh.cert };
    await fs.promises.writeFile(path, JSON.stringify(keyCert));
    return keyCert;
}

// Periodically re-checks the cert and invokes onRenewed with the new key/cert when it rolls over, so the caller can hot-swap it into a running https server (setSecureContext) without a restart. Failures are logged and retried next interval — never fatal.
export function startCertMaintenance(config: { domain: string; onRenewed: (keyCert: KeyCert) => void }): void {
    setInterval(() => {
        void (async () => {
            try {
                const path = certCachePath(config.domain);
                let before: string | undefined;
                try {
                    before = fs.readFileSync(path, "utf8");
                } catch { }
                const keyCert = await loadOrGenerateCert(config.domain);
                if (JSON.stringify(keyCert) !== before) {
                    console.log(`Cert for ${config.domain} renewed, hot-swapping into running server`);
                    config.onRenewed(keyCert);
                }
            } catch (err) {
                console.error(`Cert renewal check for ${config.domain} failed (will retry):`, (err as Error).stack ?? err);
            }
        })();
    }, CERT_CHECK_INTERVAL);
}

// Points the given hostname at this machine's public IP (unproxied, so WSS on a custom port connects directly). No-op when the record already matches.
export async function ensureARecord(host: string): Promise<void> {
    const ip = await getExternalIP();
    await setRecord("A", host, ip);
    console.log(`A record for ${host} ensured at ${ip}`);
}
