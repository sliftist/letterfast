import { GridCell, calculateWordScoreForGrid } from "./GameState";
import { findAllWordsInGrid, findWordPathInGrid, getWordTrie, Trie } from "./GridGenerator";
import { getWords } from "./words";

export interface WordWithScore {
    word: string;
    points: number;
}

export interface WordAnalysisResult {
    commonMissedWords: WordWithScore[];
    valuableMissedWords: WordWithScore[];
    nearMissWords: WordWithScore[];
    // Every valid word on the grid that no player found, sorted by points desc.
    // When `allFoundWords` is omitted this is the same set as the player's own
    // misses.
    allMissedWords: WordWithScore[];
}

export async function analyzeWords(config: {
    grid: GridCell[][];
    foundWords: { word: string; points: number }[];
    allFoundWords?: { word: string; points: number }[];
}): Promise<WordAnalysisResult> {
    const trie = await getWordTrie();
    const allWordsResult = findAllWordsInGrid(config.grid, trie);
    const allValidWords = Array.from(allWordsResult.words);
    const allWordsOrdered = await getWords();

    const foundWordsSet = new Set(config.foundWords.map(w => w.word.toLowerCase()));
    const missedWords = allValidWords.filter(word => !foundWordsSet.has(word.toLowerCase()));

    const missedWordsWithScores: WordWithScore[] = [];
    const missedWordsSet = new Set<string>();
    for (let word of missedWords) {
        const path = findWordPathInGrid(config.grid, word);
        if (path) {
            const points = calculateWordScoreForGrid(config.grid, path);
            missedWordsWithScores.push({ word, points });
            missedWordsSet.add(word.toLowerCase());
        }
    }

    const allFoundSet = new Set((config.allFoundWords ?? config.foundWords).map(w => w.word.toLowerCase()));
    const allMissedWords = missedWordsWithScores
        .filter(w => !allFoundSet.has(w.word.toLowerCase()))
        .slice()
        .sort((a, b) => b.points - a.points);

    const commonMissedWords = findCommonMissedWords(missedWordsWithScores, allWordsOrdered);
    const valuableMissedWords = findValuableMissedWords(missedWordsWithScores);
    const nearMissWords = await findNearMissWords({
        grid: config.grid,
        foundWords: config.foundWords,
        missedWords: missedWordsSet,
    });

    return {
        commonMissedWords,
        valuableMissedWords,
        nearMissWords,
        allMissedWords,
    };
}

function findCommonMissedWords(missedWords: WordWithScore[], allWordsOrdered: string[]): WordWithScore[] {
    const wordOrderMap = new Map<string, number>();
    for (let i = 0; i < allWordsOrdered.length; i++) {
        wordOrderMap.set(allWordsOrdered[i].toLowerCase(), i);
    }
    
    const wordsWithOrder = missedWords
        .map(w => ({
            ...w,
            order: wordOrderMap.get(w.word.toLowerCase()) ?? Infinity,
        }))
        .filter(w => w.order !== Infinity);
    
    wordsWithOrder.sort((a, b) => a.order - b.order);
    
    return wordsWithOrder.slice(0, 5).map(w => ({ word: w.word, points: w.points }));
}

function findValuableMissedWords(missedWords: WordWithScore[]): WordWithScore[] {
    const sorted = missedWords.slice().sort((a, b) => b.points - a.points);
    return sorted.slice(0, 3);
}

export async function findNearMissWords(config: {
    grid: GridCell[][];
    foundWords: { word: string; points: number }[];
    missedWords: Set<string>;
}): Promise<WordWithScore[]> {
    const trie = await getWordTrie();
    const nearMissCandidates = new Set<string>();
    
    for (let foundWord of config.foundWords) {
        const word = foundWord.word.toUpperCase();
        
        for (let i = 0; i <= word.length; i++) {
            for (let letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
                const candidate = word.slice(0, i) + letter + word.slice(i);
                if (candidate.length >= 3 && trie.isWord(candidate)) {
                    nearMissCandidates.add(candidate.toLowerCase());
                }
            }
        }
        
        for (let i = 0; i < word.length; i++) {
            const candidate = word.slice(0, i) + word.slice(i + 1);
            if (candidate.length >= 3 && trie.isWord(candidate)) {
                nearMissCandidates.add(candidate.toLowerCase());
            }
        }
    }
    
    const validNearMisses: WordWithScore[] = [];
    for (let candidate of nearMissCandidates) {
        if (config.missedWords.has(candidate)) {
            const path = findWordPathInGrid(config.grid, candidate);
            if (path) {
                const points = calculateWordScoreForGrid(config.grid, path);
                validNearMisses.push({ word: candidate, points });
            }
        }
    }
    
    validNearMisses.sort((a, b) => b.points - a.points);
    return validNearMisses.slice(0, 3);
}
