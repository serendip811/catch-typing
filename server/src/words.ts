import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type WordRow = { text: string; category: string; difficulty: number; enabled: boolean };

const wordFile = [resolve(process.cwd(), "words.csv"), resolve(process.cwd(), "server/words.csv")]
  .find((candidate) => existsSync(candidate));
if (!wordFile) throw new Error("Korean word data file was not found");

const rows: WordRow[] = readFileSync(wordFile, "utf8")
  .replace(/^\uFEFF/, "")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [, text, category, difficulty, , , enabled] = line.split(",");
    return { text: text.trim(), category, difficulty: Number(difficulty), enabled: enabled === "True" };
  });

const enabledRows = rows.filter((row) => row.enabled && row.text.length > 0);

// Fast arcade modes stay readable on mobile. A small set of easy trend words is
// mixed in, while long phrases remain available for future sentence modes.
export const KOREAN_TARGETS = enabledRows
  .filter((row) => row.text.length <= 10 && (row.category !== "trend" || row.difficulty === 1))
  .map((row) => row.text);

export const KOREAN_SENTENCES = enabledRows
  .filter((row) => row.text.length > 10)
  .map((row) => row.text);

export const KOREAN_TREND_TARGETS = enabledRows
  .filter((row) => row.category === "trend")
  .map((row) => row.text);
