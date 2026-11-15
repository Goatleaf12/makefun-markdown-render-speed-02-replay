// Driver for the markdown-render-speed entry.
// The harness runs `node /bot/main.ts`. It loads the case list from the
// input directory, renders every case on its own with parse() from the
// local parse.js module, and writes the HTML strings, in order, to the
// output directory. When run outside the grading container the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR variables point at local
// directories instead of /input and /output.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const list = JSON.parse(raw) as Array<{ id: string; markdown: string }>;

const rendered: string[] = new Array(list.length);
for (let k = 0; k < list.length; k++) {
  rendered[k] = parse(list[k].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
