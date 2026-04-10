#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execSync } = require("child_process");

const inputPath = path.resolve(__dirname, "../cel_2-45.txt");
const tempGzPath = path.resolve(__dirname, "../cel_2-45.txt.gz");
const remoteDir = "/root/new-site/dist/letterfast/";
const remoteFile = "words.txt.gz";
const remoteHost = "quentinbrooks.com";

console.log("===================================");
console.log("Uploading Word List to Server");
console.log("===================================");
console.log("");

console.log(`Reading word list from: ${inputPath}`);
const rawData = fs.readFileSync(inputPath, "utf8");
const words = rawData.split("\n").map(w => w.trim()).filter(w => w.length > 0);
console.log(`✓ Loaded ${words.length.toLocaleString()} words`);
console.log("");

console.log("Loading frequency order...");
const frequencyOrderPath = path.resolve(__dirname, "../words_ordered.txt");
const frequencyData = fs.readFileSync(frequencyOrderPath, "utf8");
const frequencyOrder = frequencyData.split("\n").map(w => w.trim()).filter(w => w.length > 0);
const frequencyIndex = new Map(frequencyOrder.map((word, index) => [word, index]));
console.log(`✓ Loaded ${frequencyIndex.size.toLocaleString()} words from frequency list`);
console.log("");

console.log("Sorting words by frequency...");
words.sort((a, b) => {
    const indexA = frequencyIndex.get(a);
    const indexB = frequencyIndex.get(b);
    
    if (indexA !== undefined && indexB !== undefined) {
        return indexA - indexB;
    }
    if (indexA !== undefined) return -1;
    if (indexB !== undefined) return 1;
    return a.localeCompare(b);
});
const wordsInFrequencyList = words.filter(w => frequencyIndex.has(w)).length;
console.log(`✓ Sorted ${wordsInFrequencyList.toLocaleString()} words by frequency`);
console.log(`✓ Placed ${(words.length - wordsInFrequencyList).toLocaleString()} remaining words at end (alphabetically)`);
console.log("");

console.log("Compressing with gzip...");
const wordsJson = JSON.stringify(words);
const compressed = zlib.gzipSync(Buffer.from(wordsJson, "utf8"));
fs.writeFileSync(tempGzPath, compressed);
const originalSize = Buffer.byteLength(wordsJson, "utf8");
const compressedSize = compressed.length;
const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(1);
console.log(`✓ Original size: ${(originalSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`✓ Compressed size: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`✓ Compression ratio: ${ratio}%`);
console.log("");

console.log(`Uploading to ${remoteHost}:${remoteDir}${remoteFile}...`);
try {
    execSync(`scp "${tempGzPath}" ${remoteHost}:${remoteDir}${remoteFile}`, {
        stdio: "inherit"
    });
    console.log("✓ Upload complete!");
} catch (error) {
    console.error("✗ Upload failed:", error.message);
    process.exit(1);
} finally {
    fs.unlinkSync(tempGzPath);
    console.log("✓ Cleaned up temporary file");
}

console.log("");
console.log("===================================");
console.log("Upload Complete!");
console.log("===================================");
console.log(`Word list available at: https://${remoteHost}/letterfast/${remoteFile}`);
