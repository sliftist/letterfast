import * as fs from "fs";
import * as path from "path";

const wordFile = path.join(__dirname, "..", "cel_2-45.txt");
const contents = fs.readFileSync(wordFile, "utf8");

const matches = contents
    .split(/\r?\n/)
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length === 7)
    .filter(w => !w.endsWith("ing"))
    .filter(w => !w.endsWith("er"))
    .filter(w => !w.endsWith("ed"))
    .filter(w => !w.endsWith("est"))
    .filter(w => !w.startsWith("un"))
    .filter(w => !w.endsWith("s"));

for (const word of matches) {
    console.log(word);
}

console.error(`Found ${matches.length} matching 7-letter words`);
