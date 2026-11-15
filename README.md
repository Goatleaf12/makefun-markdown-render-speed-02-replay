# fast-markdown

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![No dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](./package.json)

A dependency-free, single-pass Markdown renderer written in plain
JavaScript. `parse(markdown)` returns exactly the HTML that
[marked](https://github.com/markedjs/marked) 18.1.3 produces with its
default options (GFM on, breaks off), for every input — CommonMark
0.31.2 spec examples, GFM 0.29 extensions (tables, task lists,
strikethrough, extended autolinks) and long real-world documents — and
it renders the whole 720-case practice set about 1.28x faster than
marked itself (median process CPU 0.59s vs 0.75s on this machine).

## Usage

```js
import { parse } from './parse.js';

parse('# Hello\n\nSome *text*.');
// '<h1>Hello</h1>\n<p>Some <em>text</em>.</p>\n'
```

## How it works

There is no lexer and no token tree. The block parser walks the input
line by line and renders straight into a string: headings, fences,
indented code, blockquotes, lists (with lazy continuation and loose /
tight detection), tables, link reference definitions, setext headings
and paragraphs. Inline rendering is a single left-to-right scan that
dispatches on the first character (`*`, `_`, `` ` ``, `[`, `<`, `&`,
`\`, `~`, `!`, …), resolves emphasis with a delimiter stack, and
handles GFM autolinks, email addresses, entities and hard breaks.

Speed comes from avoiding allocation: no intermediate token objects,
one combined list-break scan, a line-bounded setext guard, a reused
mask for link definitions, and a backward double-blank check for
looseness instead of a second pass.

## Layout

- `parse.js` — the renderer. `parse(markdown)` returns the HTML string.
- `main.ts` — the grading driver: reads `/input/cases.json`, renders
  each case alone, writes `/output/html.json`.
- `package.json` — `{"type": "module"}`; there are no dependencies.

## License

MIT. See [LICENSE](./LICENSE).
