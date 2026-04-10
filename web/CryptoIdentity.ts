import { isNode } from "typesafecss";

const STORAGE_KEY = "letterfast_crypto_identity";
const ALGORITHM = "ECDSA";
const CURVE = "P-256";
const HASH = "SHA-256";

interface StoredIdentity {
    privateKey: JsonWebKey;
    publicKey: JsonWebKey;
}

let cachedKeyPair: CryptoKeyPair | undefined;

export async function getOrCreateIdentity(): Promise<CryptoKeyPair> {
    if (isNode()) {
        throw new Error(`CryptoIdentity is not supported in Node.js`);
    }

    if (cachedKeyPair) {
        return cachedKeyPair;
    }

    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        const identity: StoredIdentity = JSON.parse(stored);
        const privateKey = await crypto.subtle.importKey(
            "jwk",
            identity.privateKey,
            { name: ALGORITHM, namedCurve: CURVE },
            true,
            ["sign"]
        );
        const publicKey = await crypto.subtle.importKey(
            "jwk",
            identity.publicKey,
            { name: ALGORITHM, namedCurve: CURVE },
            true,
            ["verify"]
        );
        cachedKeyPair = { privateKey, publicKey };
        return cachedKeyPair;
    }

    cachedKeyPair = await crypto.subtle.generateKey(
        { name: ALGORITHM, namedCurve: CURVE },
        true,
        ["sign", "verify"]
    );

    const privateKeyJwk = await crypto.subtle.exportKey("jwk", cachedKeyPair.privateKey);
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", cachedKeyPair.publicKey);

    const identity: StoredIdentity = {
        privateKey: privateKeyJwk,
        publicKey: publicKeyJwk
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));

    return cachedKeyPair;
}

export async function signPayload(data: any): Promise<string> {
    if (isNode()) {
        throw new Error(`signPayload is not supported in Node.js`);
    }

    const keyPair = await getOrCreateIdentity();
    const encoder = new TextEncoder();
    const dataString = JSON.stringify(data);
    const dataBuffer = encoder.encode(dataString);

    const signature = await crypto.subtle.sign(
        { name: ALGORITHM, hash: HASH },
        keyPair.privateKey,
        dataBuffer
    );

    return arrayBufferToBase64(signature);
}

export async function getPublicKey(): Promise<string> {
    if (isNode()) {
        throw new Error(`getPublicKey is not supported in Node.js`);
    }

    const keyPair = await getOrCreateIdentity();
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    return JSON.stringify(publicKeyJwk);
}

export async function verifySignature(data: any, signature: string, publicKeyString: string): Promise<boolean> {
    const publicKeyJwk: JsonWebKey = JSON.parse(publicKeyString);
    const publicKey = await crypto.subtle.importKey(
        "jwk",
        publicKeyJwk,
        { name: ALGORITHM, namedCurve: CURVE },
        false,
        ["verify"]
    );

    const encoder = new TextEncoder();
    const dataString = JSON.stringify(data);
    const dataBuffer = encoder.encode(dataString);
    const signatureBuffer = base64ToArrayBuffer(signature);

    return await crypto.subtle.verify(
        { name: ALGORITHM, hash: HASH },
        publicKey,
        signatureBuffer,
        dataBuffer
    );
}

export async function exportIdentity(): Promise<string> {
    if (isNode()) {
        throw new Error(`exportIdentity is not supported in Node.js`);
    }

    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
        throw new Error(`No identity to export`);
    }
    return stored;
}

export async function importIdentity(identityString: string): Promise<void> {
    if (isNode()) {
        throw new Error(`importIdentity is not supported in Node.js`);
    }

    const identity: StoredIdentity = JSON.parse(identityString);
    
    const privateKey = await crypto.subtle.importKey(
        "jwk",
        identity.privateKey,
        { name: ALGORITHM, namedCurve: CURVE },
        true,
        ["sign"]
    );
    const publicKey = await crypto.subtle.importKey(
        "jwk",
        identity.publicKey,
        { name: ALGORITHM, namedCurve: CURVE },
        true,
        ["verify"]
    );

    cachedKeyPair = { privateKey, publicKey };
    localStorage.setItem(STORAGE_KEY, identityString);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}
