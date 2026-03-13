import { GridCell, LETTER_POINTS, LETTER_FREQUENCY, MIN_VOWEL_FRACTION, MAX_VOWEL_FRACTION } from "./GameState";
import { getWords } from "./words";
import { getSeededRandom } from "sliftutils/misc/random";

const VOWELS = "AEIOU";
const CONSONANTS = "BCDFGHJKLMNPQRSTVWXYZ";

export const MIN_WORDS_PER_LETTER = 10;
export const MAX_OPTIMIZATION_SWAPS = 50;
const MAX_WORD_SEARCH_ITERATIONS = 1000000;

class TrieNode {
    children: Map<string, TrieNode> = new Map();
    isWord: boolean = false;
}

class Trie {
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

async function loadWordData(): Promise<void> {
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

function findAllWordsInGrid(grid: GridCell[][], trie: Trie): { words: Set<string>; iterations: number; hitLimit: boolean } {
    let foundWords = new Set<string>();
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

        if (word.length >= 3 && trie.isWord(word)) {
            foundWords.add(word.toLowerCase());
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

    return { words: foundWords, iterations, hitLimit };
}

function countWordsWithoutCell(grid: GridCell[][], trie: Trie, excludeRow: number, excludeCol: number): number {
    let height = grid.length;
    let width = grid[0].length;
    let foundWords = new Set<string>();

    function dfs(path: { row: number; col: number }[], word: string, visited: Set<string>) {
        if (!trie.hasPrefix(word)) {
            return;
        }

        if (word.length >= 3 && trie.isWord(word)) {
            foundWords.add(word.toLowerCase());
        }
        if (word.length >= 12) return;

        let lastCell = path[path.length - 1];
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                let newRow = lastCell.row + dr;
                let newCol = lastCell.col + dc;
                if (newRow < 0 || newRow >= height || newCol < 0 || newCol >= width) continue;
                if (newRow === excludeRow && newCol === excludeCol) continue;
                let key = `${newRow},${newCol}`;
                if (visited.has(key)) continue;
                let newWord = word + grid[newRow][newCol].letter;
                visited.add(key);
                dfs([...path, { row: newRow, col: newCol }], newWord, visited);
                visited.delete(key);
            }
        }
    }

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            if (row === excludeRow && col === excludeCol) continue;
            let visited = new Set<string>();
            visited.add(`${row},${col}`);
            dfs([{ row, col }], grid[row][col].letter, visited);
        }
    }

    return foundWords.size;
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

function ensureVowelLimits(grid: GridCell[][], random: () => number) {
    let totalCells = grid.length * grid[0].length;
    let minVowels = Math.ceil(totalCells * MIN_VOWEL_FRACTION);
    let maxVowels = Math.floor(totalCells * MAX_VOWEL_FRACTION);

    let vowelCount = countVowels(grid);

    while (vowelCount < minVowels) {
        let row = Math.floor(random() * grid.length);
        let col = Math.floor(random() * grid[0].length);
        if (!VOWELS.includes(grid[row][col].letter)) {
            let vowel = VOWELS[Math.floor(random() * VOWELS.length)];
            grid[row][col].letter = vowel;
            grid[row][col].points = LETTER_POINTS[vowel] || 1;
            vowelCount++;
        }
    }

    while (vowelCount > maxVowels) {
        let row = Math.floor(random() * grid.length);
        let col = Math.floor(random() * grid[0].length);
        if (VOWELS.includes(grid[row][col].letter)) {
            let consonant = CONSONANTS[Math.floor(random() * CONSONANTS.length)];
            grid[row][col].letter = consonant;
            grid[row][col].points = LETTER_POINTS[consonant] || 1;
            vowelCount--;
        }
    }
}

export interface GridMetadata {
    grid: GridCell[][];
    totalPossibleWords: number;
    totalPossibleScore: number;
}

function calculateTotalScoreForWords(grid: GridCell[][], words: Set<string>, trie: Trie): number {
    let totalScore = 0;

    function findWordPath(word: string): { row: number; col: number }[] | undefined {
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

    for (let word of words) {
        let path = findWordPath(word);
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

export async function generateGameGrid(seed: number, width: number, height: number): Promise<GridMetadata> {
    let random = getSeededRandom(seed);
    let grid: GridCell[][] = [];

    for (let row = 0; row < height; row++) {
        let rowCells: GridCell[] = [];
        for (let col = 0; col < width; col++) {
            let letter = LETTER_FREQUENCY[Math.floor(random() * LETTER_FREQUENCY.length)];
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

    ensureVowelLimits(grid, random);

    let initialResult = findAllWordsInGrid(grid, wordTrie);
    let totalWords = initialResult.words.size;

    if (initialResult.hitLimit) {
        console.log(`Hit iteration limit (${MAX_WORD_SEARCH_ITERATIONS.toLocaleString()}) during initial scan, skipping optimization`);
    } else {
        for (let swap = 0; swap < MAX_OPTIMIZATION_SWAPS; swap++) {
            let leastUsefulCell: { row: number; col: number; contribution: number; letter: string } | undefined;

            for (let row = 0; row < height; row++) {
                for (let col = 0; col < width; col++) {
                    let wordsWithoutCell = countWordsWithoutCell(grid, wordTrie, row, col);
                    let contribution = totalWords - wordsWithoutCell;
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
            let newLetter = LETTER_FREQUENCY[Math.floor(random() * LETTER_FREQUENCY.length)];
            grid[leastUsefulCell.row][leastUsefulCell.col].letter = newLetter;
            grid[leastUsefulCell.row][leastUsefulCell.col].points = LETTER_POINTS[newLetter] || 1;

            ensureVowelLimits(grid, random);

            let newResult = findAllWordsInGrid(grid, wordTrie);

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
            }
        }
    }

    placeSeedWord(grid, wordSet, random);

    let finalResult = findAllWordsInGrid(grid, wordTrie);
    let finalContributions: { row: number; col: number; letter: string; contribution: number }[] = [];
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            let wordsWithoutCell = countWordsWithoutCell(grid, wordTrie, row, col);
            let contribution = finalResult.words.size - wordsWithoutCell;
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
    };
}
