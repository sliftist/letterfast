/**
 * Homophone lookup using the CMU Pronouncing Dictionary.
 *
 * When Moonshine returns a word that doesn't match the board, we look for
 * other words that have the same phonemes (e.g. "knight" → "night",
 * "see" → "sea") and try those instead.
 */

const DICT_URL = "https://cdn.jsdelivr.net/npm/cmu-pronouncing-dictionary/+esm";

interface HomophoneIndex {
    wordToPhonemes: Map<string, string>;
    phonemeToWords: Map<string, string[]>;
}

const nativeDynamicImport: (url: string) => Promise<any> =
    new Function("u", "return import(u)") as any;

let dictPromise: Promise<HomophoneIndex> | undefined;

export function preloadHomophoneDict(): Promise<HomophoneIndex> {
    if (dictPromise) return dictPromise;
    console.log("[homophones] loading CMU pronouncing dictionary");
    dictPromise = (async () => {
        const start = Date.now();
        const mod = await nativeDynamicImport(DICT_URL);
        const data: Record<string, string> = (mod && mod.default) ? mod.default : mod;
        if (!data || typeof data !== "object") {
            throw new Error("CMU dictionary loaded but had unexpected shape");
        }
        const wordToPhonemes = new Map<string, string>();
        const phonemeToWords = new Map<string, string[]>();
        let count = 0;
        for (const word in data) {
            const raw = data[word];
            if (typeof raw !== "string") continue;
            // Strip ARPABET stress markers (digits) so e.g. "AH0 B" === "AH B".
            const normalized = raw.replace(/\d/g, "");
            const lower = word.toLowerCase();
            wordToPhonemes.set(lower, normalized);
            const list = phonemeToWords.get(normalized);
            if (list) list.push(lower);
            else phonemeToWords.set(normalized, [lower]);
            count++;
        }
        console.log(`[homophones] loaded ${count} entries in ${Date.now() - start}ms`);
        return { wordToPhonemes, phonemeToWords };
    })().catch((e) => {
        console.error("[homophones] failed to load CMU dict:", e);
        dictPromise = undefined;
        throw e;
    });
    return dictPromise;
}

/**
 * Returns words that share the same phoneme sequence as `word` (excluding
 * `word` itself). Resolves to an empty array when the word isn't in the
 * dictionary or the dictionary failed to load.
 */
export async function getHomophones(word: string): Promise<string[]> {
    let dict: HomophoneIndex;
    try {
        dict = await preloadHomophoneDict();
    } catch {
        return [];
    }
    const lower = word.toLowerCase();
    const phonemes = dict.wordToPhonemes.get(lower);
    if (!phonemes) return [];
    const matches = dict.phonemeToWords.get(phonemes);
    if (!matches) return [];
    return matches.filter(w => w !== lower);
}

// Collapse phonemes that listeners typically don't distinguish so that
// near-rhymes share more structure under edit distance. ARPABET → reduced
// equivalence classes. The mappings are intentionally generous because
// the goal is "sounds basically the same to a person, not to a phonologist."
const PHONEME_ALIAS: Record<string, string> = {
    // schwa-like central vowels
    AX: "AH", AH: "AH",
    // lax/tense pairs
    IH: "IY", IY: "IY",
    EH: "AE", AE: "AE",
    UH: "UW", UW: "UW",
    AO: "OW", OW: "OW",
    AA: "AH",
    // r-coloured vowels
    ER: "ER", AXR: "ER",
    // d/t at non-initial positions are easy to mishear
    // (we don't blanket-map them — that would over-merge)
};

function normalizePhoneme(p: string): string {
    return PHONEME_ALIAS[p] || p;
}

function getNormalizedPhonemes(dict: HomophoneIndex, word: string): string[] | undefined {
    const raw = dict.wordToPhonemes.get(word.toLowerCase());
    if (!raw) return undefined;
    return raw.split(" ").filter(Boolean).map(normalizePhoneme);
}

function levenshteinPhonemes(a: string[], b: string[]): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,        // deletion
                curr[j - 1] + 1,    // insertion
                prev[j - 1] + cost, // substitution
            );
        }
        const tmp = prev; prev = curr; curr = tmp;
    }
    return prev[n];
}

/**
 * Find candidate words whose pronunciation is "close enough" to the spoken
 * word using phoneme-level Levenshtein distance under a generous phoneme
 * equivalence map. Useful as a fallback when an exact homophone lookup
 * misses (e.g. "tee" vs "teed", "diffusers" vs "diff users").
 *
 * Returns candidates sorted by similarity (best first), only those whose
 * edit distance is <= `maxDistanceRatio` of the longer phoneme string.
 */
export async function findPhoneticMatches(
    spoken: string,
    candidates: Iterable<string>,
    options?: { maxDistanceRatio?: number; topN?: number },
): Promise<string[]> {
    let dict: HomophoneIndex;
    try { dict = await preloadHomophoneDict(); } catch { return []; }
    const spokenP = getNormalizedPhonemes(dict, spoken);
    if (!spokenP || spokenP.length === 0) return [];

    const maxDistanceRatio = options?.maxDistanceRatio ?? 0.4;
    const topN = options?.topN ?? 8;
    const scored: { word: string; ratio: number }[] = [];
    const seen = new Set<string>();
    const spokenLower = spoken.toLowerCase();
    for (const cand of candidates) {
        const lower = cand.toLowerCase();
        if (lower === spokenLower) continue;
        if (seen.has(lower)) continue;
        seen.add(lower);
        const candP = getNormalizedPhonemes(dict, lower);
        if (!candP || candP.length === 0) continue;
        const dist = levenshteinPhonemes(spokenP, candP);
        const maxLen = Math.max(spokenP.length, candP.length);
        const ratio = dist / maxLen;
        if (ratio > maxDistanceRatio) continue;
        scored.push({ word: lower, ratio });
    }
    scored.sort((a, b) => a.ratio - b.ratio);
    return scored.slice(0, topN).map(s => s.word);
}
