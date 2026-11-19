// Writes data/sample-transactions.csv from sample.js.  Run: node tools/generate-sample.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { generateSample } from "../sample.js";

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
const csv = generateSample();
writeFileSync(new URL("../data/sample-transactions.csv", import.meta.url), csv);
console.log(`Wrote data/sample-transactions.csv (${csv.trim().split("\n").length - 1} transactions)`);
