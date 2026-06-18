import { GridCell, LETTER_POINTS, LETTER_FREQUENCY, MIN_VOWEL_FRACTION, MAX_VOWEL_FRACTION, WordLengthMode, isWordLengthAllowed, GRID_RETRY_LIMIT } from "./GameState";
import { getWords } from "./words";
import { getSeededRandom } from "sliftutils/misc/random";

export interface GridGenOptions {
    wordLengthMode?: WordLengthMode;
    /** When score falls below this, the generator retries with a new seed (up to GRID_RETRY_LIMIT times). */
    targetScoreMin?: number;
    /** When score exceeds this, the generator retries. */
    targetScoreMax?: number;
    /** 4x4 only: force the four center cells to vowels and lock them from optimizer / vowel-balance swaps. */
    vowelCenter4?: boolean;
}

const VOWELS = "AEIOU";
const CONSONANTS = "BCDFGHJKLMNPQRSTVWXYZ";

export const MIN_WORDS_PER_LETTER = 20;
export const MAX_OPTIMIZATION_SWAPS = 50;
const MAX_WORD_SEARCH_ITERATIONS = 1000000;

class TrieNode {
    children: Map<string, TrieNode> = new Map();
    isWord: boolean = false;
}

export class Trie {
    root: TrieNode = new TrieNode();

    insert(word: string) {
        let node = this.root;
        for (let char of word.toUpperCase()) {
            if (!node.children.has(char)) {
                node.children.set(char, new TrieNode());
            }
            node = node.children.get(char)!;
        }
        node.isWord = true;
    }

    hasPrefix(prefix: string): boolean {
        let node = this.root;
        for (let char of prefix.toUpperCase()) {
            if (!node.children.has(char)) {
                return false;
            }
            node = node.children.get(char)!;
        }
        return true;
    }

    isWord(word: string): boolean {
        let node = this.root;
        for (let char of word.toUpperCase()) {
            if (!node.children.has(char)) {
                return false;
            }
            node = node.children.get(char)!;
        }
        return node.isWord;
    }
}

let wordSet: Set<string> | undefined;
let wordTrie: Trie | undefined;
let wordSetPromise: Promise<void> | undefined;

export async function loadWordData(): Promise<void> {
    if (wordSet && wordTrie) return;
    if (wordSetPromise) return wordSetPromise;

    wordSetPromise = getWords().then(words => {
        wordSet = new Set(words.map(w => w.toLowerCase()));
        wordTrie = new Trie();
        for (let word of words) {
            wordTrie.insert(word);
        }
    });

    return wordSetPromise;
}

export async function getWordTrie(): Promise<Trie> {
    await loadWordData();
    if (!wordTrie) {
        throw new Error("Failed to load word trie");
    }
    return wordTrie;
}

// Builds the per-cell word index used by `remainingWordsForCell` and the
// "exhausted cell" check. Centralized so every caller (grid generation,
// board import, challenge mode, multiplayer grid arrival) uses the exact
// same logic and the index stays in sync with the live grid.
export function buildCellToWords(grid: GridCell[][], trie: Trie, wordLengthMode: WordLengthMode = "any"): Map<string, Set<string>> {
    const cellToWords = new Map<string, Set<string>>();
    const result = findAllWordsInGrid(grid, trie, wordLengthMode);
    for (const [word, cells] of result.wordPaths) {
        const upperWord = word.toUpperCase();
        for (const cellKey of cells) {
            let wordsSet = cellToWords.get(cellKey);
            if (!wordsSet) { wordsSet = new Set<string>(); cellToWords.set(cellKey, wordsSet); }
            wordsSet.add(upperWord);
        }
    }
    return cellToWords;
}

export function gridLetterFingerprint(grid: GridCell[][]): string {
    let out = "";
    for (let r = 0; r < grid.length; r++) {
        const row = grid[r];
        for (let c = 0; c < row.length; c++) {
            out += row[c].letter;
        }
        out += "|";
    }
    return out;
}

export function findPathsForWord(grid: GridCell[][], target: string): { row: number; col: number }[][] {
    const upper = target.toUpperCase();
    if (upper.length === 0) return [];
    const height = grid.length;
    const width = grid[0]?.length ?? 0;
    if (height === 0 || width === 0) return [];

    const paths: { row: number; col: number }[][] = [];
    const path: { row: number; col: number }[] = [];
    const visited = new Set<string>();

    function dfs(r: number, c: number, idx: number) {
        if (grid[r][c].letter !== upper[idx]) return;
        path.push({ row: r, col: c });
        if (idx === upper.length - 1) {
            paths.push(path.slice());
        } else {
            const key = `${r},${c}`;
            visited.add(key);
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = r + dr;
                    const nc = c + dc;
                    if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
                    const nk = `${nr},${nc}`;
                    if (visited.has(nk)) continue;
                    dfs(nr, nc, idx + 1);
                }
            }
            visited.delete(key);
        }
        path.pop();
    }

    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            dfs(r, c, 0);
        }
    }
    return paths;
}

export function findAllWordsInGrid(grid: GridCell[][], trie: Trie, wordLengthMode: WordLengthMode = "any"): { words: Set<string>; wordPaths: Map<string, Set<string>>; iterations: number; hitLimit: boolean } {
    let foundWords = new Set<string>();
    let wordPaths = new Map<string, Set<string>>();
    let height = grid.length;
    let width = grid[0].length;
    let iterations = 0;
    let hitLimit = false;

    function dfs(path: { row: number; col: number }[], word: string, visited: Set<string>) {
        iterations++;
        if (iterations > MAX_WORD_SEARCH_ITERATIONS) {
            hitLimit = true;
            return;
        }

        if (!trie.hasPrefix(word)) {
            return;
        }

        if (isWordLengthAllowed(word.length, wordLengthMode) && trie.isWord(word)) {
            let lowerWord = word.toLowerCase();
            foundWords.add(lowerWord);
            let cellsSet = wordPaths.get(lowerWord);
            if (!cellsSet) {
                cellsSet = new Set<string>();
                wordPaths.set(lowerWord, cellsSet);
            }
            for (let cell of path) {
                cellsSet.add(`${cell.row},${cell.col}`);
            }
        }
        if (word.length >= 12) return;

        let lastCell = path[path.length - 1];
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                let newRow = lastCell.row + dr;
                let newCol = lastCell.col + dc;
                if (newRow < 0 || newRow >= height || newCol < 0 || newCol >= width) continue;
                let key = `${newRow},${newCol}`;
                if (visited.has(key)) continue;
                let newWord = word + grid[newRow][newCol].letter;
                visited.add(key);
                dfs([...path, { row: newRow, col: newCol }], newWord, visited);
                if (hitLimit) return;
                visited.delete(key);
            }
        }
    }

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            let visited = new Set<string>();
            visited.add(`${row},${col}`);
            dfs([{ row, col }], grid[row][col].letter, visited);
            if (hitLimit) break;
        }
        if (hitLimit) break;
    }

    return { words: foundWords, wordPaths, iterations, hitLimit };
}


function placeSeedWord(grid: GridCell[][], wordSet: Set<string>, random: () => number): void {
    let height = grid.length;
    let width = grid[0].length;

    if (width * height < 16) {
        return;
    }

    let leastCommonLetters = "QZJXK";
    let wordArray = Array.from(wordSet).filter(w => {
        if (w.length < 7 || w.length > 8) return false;
        let upperWord = w.toUpperCase();
        for (let letter of leastCommonLetters) {
            if (upperWord.includes(letter)) return true;
        }
        return false;
    });

    if (wordArray.length === 0) {
        throw new Error("No seed words found with 7-8 letters containing Q, Z, J, X, or K");
    }

    let word = wordArray[Math.floor(random() * wordArray.length)].toUpperCase();
    let startRow = Math.floor(random() * height);
    let startCol = Math.floor(random() * width);

    let path: { row: number; col: number }[] = [];
    let visited = new Set<string>();

    function dfs(row: number, col: number, letterIndex: number): boolean {
        if (row < 0 || row >= height || col < 0 || col >= width) return false;

        let key = `${row},${col}`;
        if (visited.has(key)) return false;

        visited.add(key);
        path.push({ row, col });

        if (letterIndex === word.length - 1) {
            return true;
        }

        let directions: [number, number][] = [];
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                directions.push([dr, dc]);
            }
        }

        for (let i = directions.length - 1; i > 0; i--) {
            let j = Math.floor(random() * (i + 1));
            [directions[i], directions[j]] = [directions[j], directions[i]];
        }

        for (let [dr, dc] of directions) {
            let newRow = row + dr;
            let newCol = col + dc;
            if (dfs(newRow, newCol, letterIndex + 1)) return true;
        }

        path.pop();
        visited.delete(key);
        return false;
    }

    if (!dfs(startRow, startCol, 0)) {
        throw new Error(`Failed to place seed word "${word}" from position (${startRow}, ${startCol}) in ${width}x${height} grid`);
    }

    for (let i = 0; i < path.length; i++) {
        let { row, col } = path[i];
        grid[row][col].letter = word[i];
        grid[row][col].points = LETTER_POINTS[word[i]] || 1;
    }

    console.log(`Placed seed word "${word}" starting at (${startRow}, ${startCol})`);
}

function countVowels(grid: GridCell[][]): number {
    let count = 0;
    for (let row of grid) {
        for (let cell of row) {
            if (VOWELS.includes(cell.letter)) {
                count++;
            }
        }
    }
    return count;
}

function countLetterOccurrences(grid: GridCell[][], letter: string): number {
    let count = 0;
    for (let row of grid) {
        for (let cell of row) {
            if (cell.letter === letter) {
                count++;
            }
        }
    }
    return count;
}

function ensureVowelLimits(grid: GridCell[][], random: () => number, enforceLetterLimit: boolean, lockedCells?: Set<string>) {
    let totalCells = grid.length * grid[0].length;
    let minVowels = Math.ceil(totalCells * MIN_VOWEL_FRACTION);
    let maxVowels = Math.floor(totalCells * MAX_VOWEL_FRACTION);

    let vowelCount = countVowels(grid);

    let addVowelAttempts = 0;
    while (vowelCount < minVowels) {
        let row = Math.floor(random() * grid.length);
        let col = Math.floor(random() * grid[0].length);
        if (lockedCells && lockedCells.has(`${row},${col}`)) continue;
        if (!VOWELS.includes(grid[row][col].letter)) {
            let vowel: string | undefined;
            if (enforceLetterLimit) {
                for (let attempt = 0; attempt < VOWELS.length * 3; attempt++) {
                    let candidateVowel = VOWELS[Math.floor(random() * VOWELS.length)];
                    if (countLetterOccurrences(grid, candidateVowel) < 2) {
                        vowel = candidateVowel;
                        break;
                    }
                }
                if (!vowel) {
                    addVowelAttempts++;
                    if (addVowelAttempts > 1000) {
                        throw new Error("Failed to add vowel while respecting letter limit constraint after 1000 attempts");
                    }
                    continue;
                }
            } else {
                vowel = VOWELS[Math.floor(random() * VOWELS.length)];
            }
            grid[row][col].letter = vowel;
            grid[row][col].points = LETTER_POINTS[vowel] || 1;
            vowelCount++;
            addVowelAttempts = 0;
        }
    }

    let removeVowelAttempts = 0;
    while (vowelCount > maxVowels) {
        let row = Math.floor(random() * grid.length);
        let col = Math.floor(random() * grid[0].length);
        if (lockedCells && lockedCells.has(`${row},${col}`)) continue;
        if (VOWELS.includes(grid[row][col].letter)) {
            let consonant: string | undefined;
            if (enforceLetterLimit) {
                for (let attempt = 0; attempt < CONSONANTS.length * 3; attempt++) {
                    let candidateConsonant = CONSONANTS[Math.floor(random() * CONSONANTS.length)];
                    if (countLetterOccurrences(grid, candidateConsonant) < 2) {
                        consonant = candidateConsonant;
                        break;
                    }
                }
                if (!consonant) {
                    removeVowelAttempts++;
                    if (removeVowelAttempts > 1000) {
                        throw new Error("Failed to remove vowel while respecting letter limit constraint after 1000 attempts");
                    }
                    continue;
                }
            } else {
                consonant = CONSONANTS[Math.floor(random() * CONSONANTS.length)];
            }
            grid[row][col].letter = consonant;
            grid[row][col].points = LETTER_POINTS[consonant] || 1;
            vowelCount--;
            removeVowelAttempts = 0;
        }
    }
}

export interface GridMetadata {
    grid: GridCell[][];
    totalPossibleWords: number;
    totalPossibleScore: number;
    cellToWords: Map<string, Set<string>>;
}

export function findWordPathInGrid(grid: GridCell[][], word: string): { row: number; col: number }[] | undefined {
    let height = grid.length;
    let width = grid[0].length;

    function dfs(path: { row: number; col: number }[], wordIndex: number, visited: Set<string>): boolean {
        if (wordIndex === word.length) {
            return true;
        }

        if (path.length === 0) {
            return false;
        }

        let lastCell = path[path.length - 1];
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                let newRow = lastCell.row + dr;
                let newCol = lastCell.col + dc;
                if (newRow < 0 || newRow >= height || newCol < 0 || newCol >= width) continue;
                let key = `${newRow},${newCol}`;
                if (visited.has(key)) continue;
                if (grid[newRow][newCol].letter !== word[wordIndex].toUpperCase()) continue;
                visited.add(key);
                path.push({ row: newRow, col: newCol });
                if (dfs(path, wordIndex + 1, visited)) return true;
                path.pop();
                visited.delete(key);
            }
        }
        return false;
    }

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            if (grid[row][col].letter !== word[0].toUpperCase()) continue;
            let visited = new Set<string>();
            visited.add(`${row},${col}`);
            let path = [{ row, col }];
            if (dfs(path, 1, visited)) {
                return path;
            }
        }
    }
    return undefined;
}

export function calculateTotalScoreForWords(grid: GridCell[][], words: Set<string>, trie: Trie): number {
    let totalScore = 0;

    for (let word of words) {
        let path = findWordPathInGrid(grid, word);
        if (path) {
            let baseScore = 0;
            let multiplier = 1;
            for (let cell of path) {
                let gridCell = grid[cell.row][cell.col];
                baseScore += gridCell.points;
                if (gridCell.multiplier > 1) {
                    multiplier *= gridCell.multiplier;
                }
            }
            totalScore += baseScore * multiplier;
        }
    }

    return totalScore;
}

// Generates a grid that respects the supplied options. If targetScoreMin/Max are set, the generator may discard and regenerate up to GRID_RETRY_LIMIT times until the score lands inside the range; failing that, the closest attempt is returned so we always produce a board. seed is the seed for the FIRST attempt — retries derive their seeds from it deterministically (seed * 65537 + attempt) so a given seed still maps to a single deterministic grid for any given set of options.
export async function generateGameGrid(seed: number, width: number, height: number, options: GridGenOptions = {}): Promise<GridMetadata> {
    const { targetScoreMin, targetScoreMax } = options;
    const hasRangeConstraint = (targetScoreMin && targetScoreMin > 0) || (targetScoreMax && targetScoreMax > 0);

    let bestResult: GridMetadata | undefined;
    let bestDistance = Infinity;
    const attempts = hasRangeConstraint ? GRID_RETRY_LIMIT : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
        const attemptSeed = attempt === 0 ? seed : Math.floor(seed * 65537 + attempt);
        const result = await generateGameGridOnce(attemptSeed, width, height, options);
        const score = result.totalPossibleScore;

        let distance = 0;
        if (targetScoreMin && targetScoreMin > 0 && score < targetScoreMin) distance += targetScoreMin - score;
        if (targetScoreMax && targetScoreMax > 0 && score > targetScoreMax) distance += score - targetScoreMax;

        if (distance === 0) {
            if (attempt > 0) console.log(`Score ${score} in range after ${attempt + 1} attempts`);
            return result;
        }
        if (distance < bestDistance) {
            bestDistance = distance;
            bestResult = result;
        }
    }

    console.log(`Score range not met after ${attempts} attempts; using closest (off by ${bestDistance}).`);
    return bestResult!;
}

async function generateGameGridOnce(seed: number, width: number, height: number, options: GridGenOptions): Promise<GridMetadata> {
    const wordLengthMode = options.wordLengthMode ?? "any";
    const vowelCenter4 = !!options.vowelCenter4 && width === 4 && height === 4;
    // Center 4 cells of a 4x4 grid (rows/cols 1 and 2). When vowelCenter4 is on, these are seeded as vowels and then locked from every later mutation (ensureVowelLimits, optimizer swaps, placeSeedWord).
    const lockedCells = new Set<string>();
    if (vowelCenter4) {
        lockedCells.add("1,1");
        lockedCells.add("1,2");
        lockedCells.add("2,1");
        lockedCells.add("2,2");
    }

    let random = getSeededRandom(seed);
    let grid: GridCell[][] = [];
    let totalCells = width * height;
    let enforceLetterLimit = totalCells <= 25;

    for (let row = 0; row < height; row++) {
        let rowCells: GridCell[] = [];
        for (let col = 0; col < width; col++) {
            let letter: string;
            const forceVowel = lockedCells.has(`${row},${col}`);
            if (forceVowel) {
                if (enforceLetterLimit) {
                    let attempts = 0;
                    do {
                        letter = VOWELS[Math.floor(random() * VOWELS.length)];
                        attempts++;
                        if (attempts > 1000) {
                            throw new Error("Failed to seed center vowel with letter limit constraint after 1000 attempts");
                        }
                    } while (countLetterOccurrences(grid, letter) + rowCells.filter(c => c.letter === letter).length >= 2);
                } else {
                    letter = VOWELS[Math.floor(random() * VOWELS.length)];
                }
            } else if (enforceLetterLimit) {
                let attempts = 0;
                do {
                    letter = LETTER_FREQUENCY[Math.floor(random() * LETTER_FREQUENCY.length)];
                    attempts++;
                    if (attempts > 1000) {
                        throw new Error("Failed to generate grid with letter limit constraint after 1000 attempts");
                    }
                } while (countLetterOccurrences(grid, letter) + rowCells.filter(c => c.letter === letter).length >= 2);
            } else {
                letter = LETTER_FREQUENCY[Math.floor(random() * LETTER_FREQUENCY.length)];
            }
            rowCells.push({
                letter,
                points: LETTER_POINTS[letter] || 1,
                multiplier: 1,
            });
        }
        grid.push(rowCells);
    }

    await loadWordData();
    if (!wordTrie || !wordSet) {
        throw new Error("Failed to load word data");
    }

    ensureVowelLimits(grid, random, enforceLetterLimit, lockedCells);

    let initialResult = findAllWordsInGrid(grid, wordTrie, wordLengthMode);
    let totalWords = initialResult.words.size;

    if (initialResult.hitLimit) {
        console.log(`Hit iteration limit (${MAX_WORD_SEARCH_ITERATIONS.toLocaleString()}) during initial scan, skipping optimization`);
    } else {
        for (let swap = 0; swap < MAX_OPTIMIZATION_SWAPS; swap++) {
            let leastUsefulCell: { row: number; col: number; contribution: number; letter: string } | undefined;

            for (let row = 0; row < height; row++) {
                for (let col = 0; col < width; col++) {
                    let cellKey = `${row},${col}`;
                    if (lockedCells.has(cellKey)) continue;
                    let contribution = 0;
                    for (let [word, cells] of initialResult.wordPaths) {
                        if (cells.has(cellKey)) {
                            contribution++;
                        }
                    }
                    let letter = grid[row][col].letter;

                    if (!leastUsefulCell || contribution < leastUsefulCell.contribution) {
                        leastUsefulCell = { row, col, contribution, letter };
                    }
                }
            }

            if (!leastUsefulCell || leastUsefulCell.contribution >= MIN_WORDS_PER_LETTER) {
                break;
            }

            let oldLetter = grid[leastUsefulCell.row][leastUsefulCell.col].letter;
            console.log(`Replacing ${oldLetter} (${leastUsefulCell.contribution} words)`);
            let newLetter: string | undefined;
            if (enforceLetterLimit) {
                for (let attempt = 0; attempt < 100; attempt++) {
                    let candidate = LETTER_FREQUENCY[Math.floor(random() * LETTER_FREQUENCY.length)];
                    let currentCount = countLetterOccurrences(grid, candidate);
                    if (candidate === oldLetter) {
                        currentCount--;
                    }
                    if (currentCount < 2) {
                        newLetter = candidate;
                        break;
                    }
                }
                if (!newLetter) {
                    break;
                }
            } else {
                newLetter = LETTER_FREQUENCY[Math.floor(random() * LETTER_FREQUENCY.length)];
            }
            grid[leastUsefulCell.row][leastUsefulCell.col].letter = newLetter;
            grid[leastUsefulCell.row][leastUsefulCell.col].points = LETTER_POINTS[newLetter] || 1;

            ensureVowelLimits(grid, random, enforceLetterLimit, lockedCells);

            let newResult = findAllWordsInGrid(grid, wordTrie, wordLengthMode);

            if (newResult.hitLimit) {
                grid[leastUsefulCell.row][leastUsefulCell.col].letter = oldLetter;
                grid[leastUsefulCell.row][leastUsefulCell.col].points = LETTER_POINTS[oldLetter] || 1;
                break;
            }

            let newTotalWords = newResult.words.size;

            if (newTotalWords < totalWords) {
                grid[leastUsefulCell.row][leastUsefulCell.col].letter = oldLetter;
                grid[leastUsefulCell.row][leastUsefulCell.col].points = LETTER_POINTS[oldLetter] || 1;
            } else {
                totalWords = newTotalWords;
                initialResult = newResult;
            }
        }
    }

    // placeSeedWord forces a 7-8 letter rare-letter word along a random path. With vowel-center locking that path can't include the center 4 cells, which is too restrictive on a 4x4 — so skip it when any cell is locked. The seed word is a "nice to have"; correctness doesn't depend on it.
    if (lockedCells.size === 0) {
        placeSeedWord(grid, wordSet, random);
    }

    let finalResult = findAllWordsInGrid(grid, wordTrie, wordLengthMode);
    let cellToWords = new Map<string, Set<string>>();

    for (let [word, cells] of finalResult.wordPaths) {
        let upperWord = word.toUpperCase();
        for (let cellKey of cells) {
            let wordsSet = cellToWords.get(cellKey);
            if (!wordsSet) {
                wordsSet = new Set<string>();
                cellToWords.set(cellKey, wordsSet);
            }
            wordsSet.add(upperWord);
        }
    }

    let finalContributions: { row: number; col: number; letter: string; contribution: number }[] = [];
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            let cellKey = `${row},${col}`;
            let wordsForCell = cellToWords.get(cellKey);
            let contribution = wordsForCell ? wordsForCell.size : 0;
            let letter = grid[row][col].letter;
            finalContributions.push({ row, col, letter, contribution });
        }
    }
    console.log(`Grid has ${finalResult.words.size} words. Letter contributions:`, finalContributions.map(c => `${c.letter}:${c.contribution}`).join(", "));

    let multipliersToAdd = [2, 2, 3];
    let usedPositions = new Set<string>();
    for (let multiplier of multipliersToAdd) {
        let row: number;
        let col: number;
        let key: string;
        do {
            row = Math.floor(random() * height);
            col = Math.floor(random() * width);
            key = `${row},${col}`;
        } while (usedPositions.has(key));
        usedPositions.add(key);
        grid[row][col].multiplier = multiplier as 2 | 3;
    }

    let totalPossibleWords = finalResult.words.size;
    let totalPossibleScore = calculateTotalScoreForWords(grid, finalResult.words, wordTrie);

    console.log(`Total possible: ${totalPossibleWords} words, ${totalPossibleScore} points`);

    return {
        grid,
        totalPossibleWords,
        totalPossibleScore,
        cellToWords,
    };
}
