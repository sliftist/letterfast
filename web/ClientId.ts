// Stable per-browser id so the server can recognize a refreshed client and
// restore its slot (letter / score / words) instead of treating it as a
// brand-new player. Not authenticated — anyone who steals the value can
// submit to that slot, which just means two clients share a score. The
// server caps clientId length and char set so this is at most a nuisance.

const STORAGE_KEY = "letterfast_client_id";
const ID_LENGTH = 24;

let cached: string | undefined;

export function getClientId(): string {
    if (cached) return cached;
    try {
        const existing = localStorage.getItem(STORAGE_KEY);
        if (existing && /^[A-Za-z0-9_-]+$/.test(existing) && existing.length <= 64) {
            cached = existing;
            return cached;
        }
    } catch {
        // localStorage unavailable (private mode, etc.) — fall through and
        // mint an ephemeral id so the session at least stays consistent.
    }
    cached = generateId();
    try {
        localStorage.setItem(STORAGE_KEY, cached);
    } catch {
        // Best effort; we still return the in-memory id.
    }
    return cached;
}

function generateId(): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = new Uint8Array(ID_LENGTH);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < ID_LENGTH; i++) {
        out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
}
