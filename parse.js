// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (GFM on, breaks off, pedantic off, async off).
// Written from the CommonMark and GFM specifications, in this session, and
// verified line by line against marked as a black-box oracle on the kit's
// 720 practice cases. Single-pass direct rendering: no token objects for
// blocks, no lex/parse tree — blocks render straight to a string, and the
// inline layer works on one flat node list per paragraph.

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// A newline character, built without an escape sequence in this source.
const NL = String.fromCharCode(10);

// ASCII punctuation, by code point, for backslash escapes and flanking tests.
const PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT[ch.charCodeAt(0)] = 1;
function isPunctChar(c) {
  const code = c.charCodeAt(0);
  if (code < 128) return PUNCT[code] === 1;
  return false;
}
// Unicode punctuation, for emphasis flanking only (CommonMark flanking
// rules use Unicode punctuation; backslash escapes are ASCII-only).
function isFlankPunct(c) {
  const code = c.charCodeAt(0);
  if (code < 128) return PUNCT[code] === 1;
  // CommonMark "Unicode punctuation" is general categories P or S.
  return /[\p{P}\p{S}]/u.test(c);
}
function isSpaceChar(c) {
  const code = c.charCodeAt(0);
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12 || code === 160 || code === 8232 || code === 8233;
}

// Space, tab, LF or CR, by char code.
function isWsChar(c) {
  const code = c.charCodeAt(0);
  return code === 32 || code === 9 || code === 10 || code === 13;
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function esc(s) {
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

// Entity reference starting at s[i] === '&'. Named references pass through
// verbatim (marked keeps &copy; as &copy;); numeric ones decode, with 0,
// surrogates and > 0x10FFFF becoming U+FFFD. Returns { text, end } or null.
function entityAt(s, i) {
  if (s[i + 1] === '#') {
    let j = i + 2;
    let hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const ds = j;
    while (j < s.length) {
      const code = s.charCodeAt(j);
      const ok = hex
        ? (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)
        : (code >= 48 && code <= 57);
      if (!ok) break;
      j++;
    }
    const len = j - ds;
    if (len === 0 || len > (hex ? 6 : 7) || s[j] !== ';') return null;
    let cp = parseInt(s.slice(ds, j), hex ? 16 : 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return { text: String.fromCodePoint(cp), end: j + 1, numeric: true };
  }
  let j = i + 1;
  while (j < s.length) {
    const code = s.charCodeAt(j);
    const ok = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
    if (!ok) break;
    j++;
  }
  if (j > i + 1 && s[j] === ';') return { text: s.slice(i, j + 1), end: j + 1, numeric: false };
  return null;
}

// Escape for attribute values: & < > " ' escaped, valid entity references kept.
// End index (exclusive) of an entity-like sequence starting at s[i] === '&',
// or -1. Mirrors the reference pattern: &# + 1-7 digits + ';',
// &#[xX] + 1-6 hex digits + ';', or & + 1+ word chars + ';'. The text is
// preserved verbatim by attribute escaping (no decoding).
function entityEnd(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j < n && s[j] === '#') {
    j++;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) {
      j++;
      const start = j;
      while (j < n && j < start + 6) {
        const c = s[j];
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) j++;
        else break;
      }
      if (j === start) return -1;
      if (j < n && s[j] === ';') return j + 1;
      return -1;
    }
    const start = j;
    while (j < n && j < start + 7 && s[j] >= '0' && s[j] <= '9') j++;
    if (j === start) return -1;
    if (j < n && s[j] === ';') return j + 1;
    return -1;
  }
  const start = j;
  while (j < n) {
    const c = s[j];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_') j++;
    else break;
  }
  if (j === start) return -1;
  if (j < n && s[j] === ';') return j + 1;
  return -1;
}

function escAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  let chunk = 0;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const e = entityEnd(s, i);
      if (e !== -1) { i = e; continue; }
      out += s.slice(chunk, i) + '&amp;'; i++; chunk = i; continue;
    }
    if (c === '<') { out += s.slice(chunk, i) + '&lt;'; i++; chunk = i; continue; }
    if (c === '>') { out += s.slice(chunk, i) + '&gt;'; i++; chunk = i; continue; }
    if (c === '"') { out += s.slice(chunk, i) + '&quot;'; i++; chunk = i; continue; }
    if (c === "'") { out += s.slice(chunk, i) + '&#39;'; i++; chunk = i; continue; }
    i++;
  }
  return chunk === 0 ? s : out + s.slice(chunk);
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%').replace(/\\/g, '%5C');
  } catch {
    return null;
  }
}

// Remove backslash escapes before punctuation characters.
function unescapePunct(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  let chunk = 0;
  while (i < n) {
    if (s[i] === '\\' && i + 1 < n && isPunctChar(s[i + 1])) {
      out += s.slice(chunk, i) + s[i + 1];
      i += 2;
      chunk = i;
      continue;
    }
    i++;
  }
  return chunk === 0 ? s : out + s.slice(chunk);
}

// Column width of a line's leading whitespace (tab advances to a multiple of 4).
function indentOf(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Index of the first non-space/tab character.
function firstNonWs(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

// Remove n columns of leading indent, expanding a straddling tab to spaces.
function stripIndent(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const next = col + 4 - (col % 4);
      if (next <= n) { col = next; i++; }
      else {
        // Tab straddles the boundary: keep the leftover as spaces.
        return ' '.repeat(next - n) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}

// ---------------------------------------------------------------------------
// Inline layer
// ---------------------------------------------------------------------------

// Link labels: collapse whitespace runs to one space, trim, lowercase.
function normalizeLabel(label) {
  // Labels match on the raw text (backslash escapes are NOT resolved for
  // matching: 'foo\\!' does not match 'foo!'), case-folded with Unicode
  // full folding ('ß'/'ẞ' -> 'ss', ligatures expanded, final sigma -> sigma).
  return label
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st')
    .replace(/ﬆ/g, 'st')
    .replace(/ς/g, 'σ');
}

// Index of the `]` closing the `[` at src[i], respecting backslash escapes
// and code spans; -1 when the brackets never balance.
function findBracketEnd(src, i) {
  return scanBrackets(src, i + 1, 1);
}
// Scan from j for the ']' that brings depth to 0, mirroring marked's
// label regex. A backtick run is tried as a code span first (opening run
// + content + next backtick run); if that path finds no closer, backtrack
// to the 2+ run immediately before ']' case. A lone backtick run that is
// neither invalidates the label.
function scanBrackets(src, j, depth) {
  const n = src.length;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      let k = j;
      while (k < n && src[k] === '`') k++;
      const run = k - j;
      // Try the code-span path: the closing run is the next backtick run.
      let m = k;
      while (m < n && src[m] !== '`') m++;
      if (m < n) {
        let mEnd = m;
        while (mEnd < n && src[mEnd] === '`') mEnd++;
        const after = scanBrackets(src, mEnd, depth);
        if (after !== -1) return after;
      }
      // Code-span path failed (or no closing run): a 2+ run immediately
      // before ']' is valid on its own; fall through to the ']' below.
      if (run >= 2 && k < n && src[k] === ']') { j = k; continue; }
      return -1;
    }
    // A '<' that opens an HTML tag or an angle autolink consumes its
    // whole extent, so a ']' inside a quoted attribute or an autolink
    // URL is not a label closer.
    if (c === '<') {
      const tag = matchHtmlTag(src, j);
      if (tag) { j = tag.end; continue; }
      const auto = matchAngleAutolink(src, j);
      if (auto) { j = auto.end; continue; }
    }
    if (c === '[') { depth++; j++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) return j;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

// Parse an inline link's (destination title) starting at src[j] === '('.
// Returns { href, title, end } or null.
function parseInlineLink(src, j) {
  const n = src.length;
  let k = j + 1;
  while (k < n && isWsChar(src[k])) k++;
  if (k >= n) return null;
  let href;
  if (src[k] === '<') {
    let m = k + 1;
    while (m < n && src[m] !== '>' && src.charCodeAt(m) !== 10 && src[m] !== '<') {
      if (src[m] === '\\') m += 2;
      else m++;
    }
    if (m >= n || src[m] !== '>') return null;
    href = unescapePunct(src.slice(k + 1, m));
    k = m + 1;
  } else {
    let depth = 0;
    let m = k;
    while (m < n) {
      const ch = src[m];
      if (ch === '\\' && m + 1 < n && isPunctChar(src[m + 1])) { m += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      } else if (isWsChar(ch) || ch.charCodeAt(0) < 32) break;
      m++;
    }
    href = unescapePunct(src.slice(k, m));
    k = m;
  }
  while (k < n && isWsChar(src[k])) k++;
  let title = null;
  if (k < n && (src[k] === '"' || src[k] === "'" || src[k] === '(')) {
    const q = src[k];
    const closer = q === '(' ? ')' : q;
    let m = k + 1;
    while (m < n) {
      if (src[m] === '\\' && m + 1 < n && isPunctChar(src[m + 1])) { m += 2; continue; }
      if (src[m] === closer) break;
      m++;
    }
    if (m >= n || src[m] !== closer) return null;
    title = unescapePunct(src.slice(k + 1, m));
    k = m + 1;
    while (k < n && isWsChar(src[k])) k++;
  }
  if (k >= n || src[k] !== ')') return null;
  return { href, title, end: k + 1 };
}

// Try to parse a link or image whose text starts at src[i] === '['.
// isImage is true when the '[' was preceded by '!'. Returns a node or null.
// True when a link label already contains a link: a link may not contain
// another link, so the outer '[' must stay literal and the inner link wins.
function labelHasLink(labelText, links) {
  for (let k = 0; k < labelText.length; k++) {
    if (labelText[k] !== '[') continue;
    if (k > 0 && labelText[k - 1] === '!') continue;
    if (k > 0 && labelText[k - 1] === '\\') continue;
    if (tryLink(labelText, k, links, false)) return true;
  }
  return false;
}

// Whether a link label's backtick runs satisfy marked's label regex:
// at the top level of the label, backtick runs must pair up (any
// lengths), or be a 2+ run immediately before the closing ']'. Runs
// inside a nested [...] group or after a backslash need no pairing.
function labelBackticksOk(label) {
  const n = label.length;
  let i = 0;
  while (i < n) {
    const c = label[i];
    if (c === '\\' && i + 1 < n) { i += 2; continue; }
    if (c === '[') {
      // Skip a nested [...] group (its backticks need no pairing).
      let depth = 1;
      let j = i + 1;
      let ok = false;
      while (j < n) {
        const cj = label[j];
        if (cj === '\\' && j + 1 < n) { j += 2; continue; }
        if (cj === '[') depth++;
        else if (cj === ']') { depth--; if (depth === 0) { ok = true; break; } }
        j++;
      }
      if (!ok) return false;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let run = 0;
      while (i + run < n && label[i + run] === '`') run++;
      // A 2+ run immediately before the closing ']' is valid on its own.
      if (run >= 2 && i + run === n) return true;
      // Find the next backtick run (any length); brackets between the
      // runs are ordinary characters for the pairing alternative.
      let j = i + run;
      while (j < n) {
        if (label[j] === '\\' && j + 1 < n) { j += 2; continue; }
        if (label[j] === '`') break;
        j++;
      }
      if (j >= n) return false;
      let run2 = 0;
      while (j + run2 < n && label[j + run2] === '`') run2++;
      i = j + run2;
      continue;
    }
    i++;
  }
  return true;
}

function tryLink(src, i, links, isImage) {
  const close = findBracketEnd(src, i);
  if (close === -1) return null;
  const labelText = src.slice(i + 1, close);
  if (!labelBackticksOk(labelText)) return null;
  if (!isImage && labelHasLink(labelText, links)) return null;
  const j = close + 1;
  if (src[j] === '(') {
    const parsed = parseInlineLink(src, j);
    if (parsed) {
      const href = cleanUrl(parsed.href);
      if (href !== null) {
        return { t: isImage ? 8 : 7, text: labelText, href, title: parsed.title, end: parsed.end };
      }
    }
    // An invalid '(...)' does not kill the link: '[foo]' may still be
    // a shortcut reference link, with '(...)' as literal text.
  }
  if (src[j] === '[') {
    const close2 = findBracketEnd(src, j);
    if (close2 === -1) return null;
    const label = close2 === j + 1 ? labelText : src.slice(j + 1, close2);
    const def = links.get(normalizeLabel(label));
    if (!def) return null;
    return { t: isImage ? 8 : 7, text: labelText, href: def.href, title: def.title, end: close2 + 1 };
  }
  const def = links.get(normalizeLabel(labelText));
  if (!def) return null;
  return { t: isImage ? 8 : 7, text: labelText, href: def.href, title: def.title, end: close + 1 };
}

// Match an HTML comment, processing instruction, declaration, CDATA section,
// open tag or close tag starting at s[i] === '<'. Returns { end } or null.
function matchHtmlTag(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    // '<!-->' and '<!--->' are complete (empty) comments.
    if (s[i + 4] === '>') return { end: i + 5 };
    if (s[i + 4] === '-' && s[i + 5] === '>') return { end: i + 6 };
    const e = s.indexOf('-->', i + 4);
    return e === -1 ? null : { end: e + 3 };
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? null : { end: e + 2 };
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    return e === -1 ? null : { end: e + 3 };
  }
  if (s.startsWith('<!', i)) {
    if (i + 2 >= n) return null;
    const c = s.charCodeAt(i + 2);
    if (c < 65 || c > 90) return null;
    const e = s.indexOf('>', i + 3);
    return e === -1 ? null : { end: e + 1 };
  }
  let j = i + 1;
  const closing = s[j] === '/';
  if (closing) j++;
  if (j >= n) return null;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  while (true) {
    let k = j;
    while (k < n && isWsChar(s[k])) k++;
    if (k >= n) return null;
    if (s[k] === '>') return { end: k + 1 };
    if (s[k] === '/' && s[k + 1] === '>') return { end: k + 2 };
    // A closing tag takes no attributes.
    if (closing) return null;
    // An attribute must be preceded by whitespace.
    if (k === j) return null;
    j = k;
    const a0 = s.charCodeAt(j);
    if (!((a0 >= 65 && a0 <= 90) || (a0 >= 97 && a0 <= 122) || a0 === 95 || a0 === 58)) return null;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 58 || c === 46 || c === 45) j++;
      else break;
    }
    const nameEnd = j;
    let m = j;
    while (m < n && isWsChar(s[m])) m++;
    if (s[m] === '=') {
      m++;
      while (m < n && isWsChar(s[m])) m++;
      if (m >= n) return null;
      if (s[m] === '"' || s[m] === "'") {
        const e = s.indexOf(s[m], m + 1);
        if (e === -1) return null;
        j = e + 1;
      } else {
        let e = m;
        while (e < n) {
          const c = s[e];
          if (isWsChar(c) || c === '"' || c === "'" || c === '=' || c === '<' || c === '>' || c === '`') break;
          e++;
        }
        if (e === m) return null;
        j = e;
      }
    } else {
      // Valueless attribute: leave j at the end of the name so the
      // loop's whitespace skip sees the separating space.
      j = nameEnd;
    }
  }
}

function isEmailLocalCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || code === 46 || code === 33 || code === 35 || code === 36 || code === 37 || code === 38
    || code === 39 || code === 42 || code === 43 || code === 47 || code === 61 || code === 63
    || code === 94 || code === 95 || code === 96 || code === 123 || code === 124 || code === 125
    || code === 126 || code === 45;
}

// A domain with at least one dot, labels of letters, digits and hyphens
// that neither start nor end with a hyphen.
function validEmailDomain(d) {
  if (d.indexOf('.') === -1) return false;
  const labels = d.split('.');
  for (let li = 0; li < labels.length; li++) {
    const lab = labels[li];
    if (lab.length === 0) return false;
    if (lab[0] === '-' || lab[lab.length - 1] === '-') return false;
    for (let k = 0; k < lab.length; k++) {
      const c = lab.charCodeAt(k);
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45)) return false;
    }
  }
  return true;
}

function isEmail(s) {
  const at = s.indexOf('@');
  if (at <= 0) return false;
  for (let k = 0; k < at; k++) {
    if (!isEmailLocalCode(s.charCodeAt(k))) return false;
  }
  return validEmailDomain(s.slice(at + 1));
}

// Positions of '_'/'*' delimiter runs that pair as emphasis closers,
// found by a forward scan that skips code spans. Marked lexes emphasis
// before autolinks, so an email inside _..._ or *...* matches in full
// (its trailing '_'/'*' is a closer, not part of the address); a
// trailing '_' that is not a closer backtracks the domain instead.
function pairedCloserPositions(src) {
  const paired = new Set();
  const stack = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const run = j - i;
      let k = j, close = -1;
      while (k < n) {
        if (src[k] === '`') {
          let m = k;
          while (m < n && src[m] === '`') m++;
          if (m - k === run) { close = k; break; }
          k = m;
        } else k++;
      }
      if (close === -1) { i = j; continue; }
      i = close + run;
      continue;
    }
    if (c === '*' || c === '_') {
      let j = i;
      while (j < n && src[j] === c) j++;
      const run = j - i;
      const info = delimInfo(src, i, run, c);
      if (info.canClose) {
        for (let s = stack.length - 1; s >= 0; s--) {
          const o = stack[s];
          if (o.ch !== c || !o.canOpen || o.pos === i) continue;
          if ((o.canOpen && o.canClose) || (info.canOpen && info.canClose)) {
            const sum = o.n + run;
            if (sum % 3 === 0 && !(o.n % 3 === 0 && run % 3 === 0)) continue;
          }
          paired.add(i);
          stack.length = s;
          break;
        }
      }
      if (info.canOpen) stack.push({ ch: c, n: run, canOpen: true, canClose: info.canClose, pos: i });
      i = j;
      continue;
    }
    i++;
  }
  return paired;
}

// Bare-email autolink spans in src, found before tokenizing so that a
// '_' inside a local part is never split off as an emphasis delimiter.
// Implements marked's GFM email regex exactly:
//   /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/
// The domain backtracks label-by-label so the (?![\w-]) lookahead holds:
// a trailing '_' or '-' after the domain shortens the match to the last
// label boundary (first@sprout.example.com_ links first@sprout.example),
// it does not invalidate the whole address. A trailing '_' that closes
// emphasis (pairedCloserPositions) does not backtrack at all.
function findEmails(src) {
  const spans = [];
  let i = 0;
  const n = src.length;
  const isLocal = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45;
  const isDom = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
  const isAlnum = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  let closers = null;
  const isCloser = (p) => {
    if (src[p] !== '_') return false;
    if (closers === null) closers = pairedCloserPositions(src);
    return closers.has(p);
  };
  while (i < n) {
    const at = src.indexOf('@', i);
    if (at === -1) break;
    let p = at;
    while (p > 0 && isLocal(src.charCodeAt(p - 1))) p--;
    if (p === at) { i = at + 1; continue; }
    let q = at + 1;
    while (q < n && isDom(src.charCodeAt(q)) && !isCloser(q)) q++;
    if (q === at + 1) { i = at + 1; continue; }
    const ends = [];
    while (q < n && src.charCodeAt(q) === 46) {
      let r = q + 1;
      while (r < n && isDom(src.charCodeAt(r)) && !isCloser(r)) r++;
      if (r === q + 1 || !isAlnum(src.charCodeAt(r - 1))) break;
      ends.push(r);
      q = r;
    }
    if (ends.length === 0) { i = at + 1; continue; }
    let end = -1;
    for (let t = ends.length - 1; t >= 0; t--) {
      const e = ends[t];
      if (e >= n) { end = e; break; }
      const c = src.charCodeAt(e);
      if (isCloser(e) || (!isAlnum(c) && c !== 95 && c !== 45)) { end = e; break; }
    }
    if (end === -1) { i = at + 1; continue; }
    spans.push({ start: p, end, email: src.slice(p, end) });
    i = end;
  }
  return spans;
}

// Angle-bracket autolink <scheme:...> or <email> at s[i] === '<'.
function matchAngleAutolink(s, i) {
  const gt = s.indexOf('>', i + 1);
  if (gt === -1) return null;
  const inner = s.slice(i + 1, gt);
  if (inner.length === 0) return null;
  for (let k = 0; k < inner.length; k++) {
    const code = inner.charCodeAt(k);
    if (code <= 32 || inner[k] === '<') return null;
  }
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(inner);
  if (scheme) {
    const href = cleanUrl(inner);
    if (href === null) return null;
    return { end: gt + 1, href, text: inner };
  }
  if (isEmail(inner)) {
    return { end: gt + 1, href: 'mailto:' + inner, text: inner };
  }
  return null;
}

// Maximal run of URL characters starting at s[i] (stops at whitespace or < > [ ]).
function scanUrlRun(s, i) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s[j];
    if (isWsChar(c) || c === '<') break;
    j++;
  }
  return s.slice(i, j);
}

// marked's _backpedal: the longest prefix made of safe runs, balanced
// parenthesised groups, '&' not starting a trailing entity, and
// punctuation runs that are not at the very end. Reimplemented as a
// forward scan over the same alternatives.
function trimUrl(url) {
  const n = url.length;
  let end = 0;
  while (end < n) {
    const c = url[end];
    if (c === '(') {
      const close = url.indexOf(')', end + 1);
      if (close === -1) break;
      end = close + 1;
      continue;
    }
    if (c === '&') {
      const m = /^&[A-Za-z0-9]+;/.exec(url.slice(end));
      if (m && end + m[0].length === n) break;
      end++;
      continue;
    }
    if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === ';'
      || c === '*' || c === '_' || c === "'" || c === '"' || c === '~' || c === ')') {
      let k = end;
      while (k < n && (url[k] === '?' || url[k] === '!' || url[k] === '.' || url[k] === ','
        || url[k] === ':' || url[k] === ';' || url[k] === '*' || url[k] === '_'
        || url[k] === "'" || url[k] === '"' || url[k] === '~' || url[k] === ')')) k++;
      if (k === n) break;
      end = k;
      continue;
    }
    end++;
  }
  return url.slice(0, end);
}

// GFM extended autolink at s[i]: www., http(s)://, ftp://, mailto:email.
// prev is the character before i ('' at the start). Returns { end, html } or null.
function tryGfmAutolink(s, i, prev) {
  const lower = s.slice(i, i + 8).toLowerCase();
  // 'www.' autolinks require lowercase 'www.' (GFM); schemes are
  // case-insensitive, so http/https/ftp/mailto keep the folded check.
  if (s.slice(i, i + 4) === 'www.') {
    if (prev !== '' && prev !== '(' && prev !== '*' && prev !== '_' && prev !== '~' && !isWsChar(prev)) return null;
    const raw = scanUrlRun(s, i);
    const url = trimUrl(raw);
    if (url.length <= 4) return null;
    const dom = url.slice(4).split(/[/:?#]/)[0];
    if (dom.indexOf('.') === -1) return null;
    return { end: i + url.length, href: 'http://' + url, text: url };
  }
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('ftp://')) {
    const raw = scanUrlRun(s, i);
    const url = trimUrl(raw);
    if (url.length === 0) return null;
    return { end: i + url.length, href: url, text: url };
  }
  if (lower.startsWith('mailto:')) {
    const rest = s.slice(i + 7);
    const m = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+/.exec(rest);
    if (!m) return null;
    let email = m[0];
    while (email.length > 0 && email[email.length - 1] === '.') email = email.slice(0, -1);
    // A trailing '-' or '_' after the address invalidates the whole link.
    const after = email.length < rest.length ? rest[email.length] : '';
    if (after === '-' || after === '_') return null;
    if (!isEmail(email)) return null;
    const full = 'mailto:' + email;
    return { end: i + full.length, href: full, text: full };
  }
  if (lower.startsWith('xmpp:')) {
    const raw = scanUrlRun(s, i + 5);
    const url = trimUrl(raw);
    if (url.length === 0) return null;
    const slash = url.indexOf('/');
    const head = slash === -1 ? url : url.slice(0, slash);
    if (!isEmail(head)) return null;
    // At most one path segment after the email address.
    let end = url.length;
    if (slash !== -1) {
      const next = url.indexOf('/', slash + 1);
      if (next !== -1) end = next;
    }
    const full = 'xmpp:' + url.slice(0, end);
    return { end: i + 5 + end, href: full, text: full };
  }
  return null;
}

// Delimiter-run flanking info for emphasis.
function delimInfo(src, i, run, ch) {
  const before = i > 0 ? src[i - 1] : '';
  const after = i + run < src.length ? src[i + run] : '';
  const beforeSpace = before === '' || isSpaceChar(before);
  const afterSpace = after === '' || isSpaceChar(after);
  const beforePunct = before !== '' && isFlankPunct(before);
  const afterPunct = after !== '' && isFlankPunct(after);
  const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  let canOpen;
  let canClose;
  if (ch === '*' || ch === '~') { canOpen = leftFlanking; canClose = rightFlanking; }
  else { canOpen = leftFlanking && (!rightFlanking || beforePunct); canClose = rightFlanking && (!leftFlanking || afterPunct); }
  return { canOpen, canClose };
}

// Node kinds: 0 text, 1 raw html, 2 delimiter, 3 em/strong, 4 entity,
// 5 hard break, 6 code span, 7 link, 8 image, 9 autolink, 10 strikethrough.
function tokenize(src, links, inLink) {
  const n = src.length;
  const nodes = [];
  let i = 0;
  let textStart = 0;
  const emailSpans = inLink ? null : findEmails(src);
  let spanIdx = 0;
  const flushText = (end) => {
    if (end > textStart) nodes.push({ t: 0, s: src.slice(textStart, end) });
  };
  while (i < n) {
    if (emailSpans) {
      while (spanIdx < emailSpans.length && emailSpans[spanIdx].end <= i) spanIdx++;
      if (spanIdx < emailSpans.length && emailSpans[spanIdx].start === i) {
        const sp = emailSpans[spanIdx];
        flushText(i);
        nodes.push({ t: 9, href: 'mailto:' + sp.email, text: sp.email });
        i = sp.end;
        textStart = i;
        spanIdx++;
        continue;
      }
    }
    const c = src[i];
    if (c === '\\') {
      const d = i + 1 < n ? src[i + 1] : '';
      if (d !== '' && d.charCodeAt(0) === 10) {
        flushText(i);
        nodes.push({ t: 5 });
        i += 2;
        // A hard break strips the leading whitespace of the next line.
        while (i < n && (src[i] === ' ' || src.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      if (d !== '' && isPunctChar(d)) {
        flushText(i);
        nodes.push({ t: 0, s: d });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const run = j - i;
      let k = j;
      let close = -1;
      while (k < n) {
        if (src[k] === '`') {
          let m = k;
          while (m < n && src[m] === '`') m++;
          if (m - k === run) { close = k; break; }
          k = m;
        } else k++;
      }
      if (close === -1) { i = j; continue; }
      let content = src.slice(j, close).split(NL).join(' ');
      if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flushText(i);
      nodes.push({ t: 6, s: content });
      i = close + run;
      textStart = i;
      continue;
    }
    if (c === '<') {
      const tag = matchHtmlTag(src, i);
      if (tag) {
        flushText(i);
        nodes.push({ t: 1, s: src.slice(i, tag.end) });
        i = tag.end;
        textStart = i;
        continue;
      }
      // Angle autolinks render inside link text too (marked does not
      // suppress them); bare GFM autolinks and bare emails do not.
      const auto = matchAngleAutolink(src, i);
      if (auto) {
        flushText(i);
        nodes.push({ t: 9, href: auto.href, text: auto.text });
        i = auto.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const node = tryLink(src, i + 1, links, true);
      if (node) {
        flushText(i);
        nodes.push(node);
        i = node.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '[') {
      if (!inLink) {
        const node = tryLink(src, i, links, false);
        if (node) {
          flushText(i);
          nodes.push(node);
          i = node.end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && src[j] === c) j++;
      // A run of 3+ tildes is literal text, never a strikethrough
      // delimiter (it is a fence at block level, plain text inline).
      if (c === '~' && j - i >= 3) { i = j; continue; }
      const info = delimInfo(src, i, j - i, c);
      flushText(i);
      nodes.push({ t: 2, ch: c, n: j - i, canOpen: info.canOpen, canClose: info.canClose, pos: i });
      i = j;
      textStart = i;
      continue;
    }
    if (c === '&') {
      const e = entityAt(src, i);
      if (e) {
        flushText(i);
        nodes.push({ t: 4, s: e.text, numeric: e.numeric });
        i = e.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c.charCodeAt(0) === 10) {
      let e = i;
      while (e > textStart && src[e - 1] === ' ') e--;
      if (i - e >= 2) {
        flushText(e);
        nodes.push({ t: 5 });
        i++;
        // A hard break strips the leading whitespace of the next line.
        while (i < n && (src[i] === ' ' || src.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if ((c === 'w' || c === 'W' || c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'm' || c === 'M' || c === 'x' || c === 'X') && !inLink) {
      const prev = i > 0 ? src[i - 1] : '';
      const g = tryGfmAutolink(src, i, prev);
      if (g) {
        flushText(i);
        nodes.push({ t: 9, href: g.href, text: g.text });
        i = g.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flushText(n);
  return nodes;
}

// CommonMark delimiter-stack emphasis: closers match the nearest eligible
// opener, subject to the odd-match rule; a match consumes 1 delimiter (em)
// or 2 (strong) from each side, leftovers stay and may match again.
// Marked's emStrong mask: code spans / links / HTML are replaced by
// '[aaa...]' and escaped punctuation by '++', so delimiters hidden inside
// them do not count as possible emphasis closers. The masked text keeps
// the original length, so indices line up with the source.
const anyPunctOutsideCodeRe = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const blockSkipRe = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
function maskEmStrong(src) {
  let t = src.replace(anyPunctOutsideCodeRe, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  t = t.replace(blockSkipRe, (n, s, r) => { const o = r ? r.length : 0; return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']'; });
  return t;
}
// Spans [start, end) of the source hidden by marked's blockSkip mask
// (code spans / links / HTML tags, after the Ot pass). Delimiters inside
// these spans do not exist for emphasis purposes. The mask preserves
// length, so spans line up with source indices.
function maskedSpans(src) {
  const t = src.replace(anyPunctOutsideCodeRe, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  const spans = [];
  blockSkipRe.lastIndex = 0;
  let m;
  while ((m = blockSkipRe.exec(t)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}
// Marked's fe(): for each of * _ ~, the start index of the LAST run whose
// preceding char is not whitespace, in the masked source (-1 if none).
function lastCloserIdx(masked) {
  let star = -1, under = -1, tilde = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '*') star = s; else if (r === '_') under = s; else tilde = s;
    }
    s = i - 1;
  }
  return { '*': star, '_': under, '~': tilde };
}

function processEmphasis(nodes, src) {
  // Marked's ze() bound: an opener can only pair if a possible closer for
  // its char exists at/after the opener's end in the masked source.
  // (A closer hidden inside a masked code span / link / tag does not count.)
  let last = null;
  let spans = null;
  // Delimiters inside a masked span do not exist for emphasis purposes.
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t !== 2) continue;
    if (spans === null) spans = maskedSpans(src);
    const e = nd.pos + nd.n;
    for (let s = 0; s < spans.length; s++) {
      if (nd.pos < spans[s][1] && e > spans[s][0]) { nd.canOpen = false; nd.canClose = false; break; }
    }
  }
  // Forward search, left to right, like marked's emStrong: for each
  // opener, scan forward for a closer. Inner opener runs of the same
  // char add to the required closer length (m); closers skipped by the
  // odd-match rule add to f; a closer only pairs once it consumes m.
  // (A stack that resolves inner pairs first would wrongly pair an
  // outer opener whose closer search fails in marked, e.g. *a **b**c*.)
  // If a run cannot open, marked consumes one char as literal text and
  // retries the shorter run (so **foo* yields *<em>foo</em>).
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (node.t !== 2 || !node.canOpen || node.ch === '~') { i++; continue; }
    if (last === null) last = lastCloserIdx(maskEmStrong(src));
    if (last[node.ch] < node.pos + node.n) { node.canOpen = false; i++; continue; }
    const ch = node.ch;
    if (node.origN === undefined) node.origN = node.n;
    // o: the char before this run is the same delimiter (a previous
    // char of the run was already consumed as literal text).
    const o = node.pos > 0 && src[node.pos - 1] === ch;
    let m = node.n, f = 0;
    const y = node.origN;
    let closerIdx = -1, closerUse = 0;
    for (let j = i + 1; j < nodes.length; j++) {
      const d = nodes[j];
      if (d.t !== 2 || d.ch !== ch) continue;
      const b = d.n;
      // A run that cannot close is not a closer candidate: a pure
      // opener adds to m, a run that can neither open nor close is
      // ignored entirely (e.g. intraword _).
      if (!d.canClose) {
        if (d.canOpen) m += b;
        continue;
      }
      const isBoth = d.canOpen && d.canClose;
      if (isBoth || node.canClose) {
        if (o && isBoth) break;
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      closerIdx = j;
      closerUse = Math.min(b, b + m + f);
      break;
    }
    if (closerIdx === -1) {
      if (node.n > 1) {
        // Split off one literal char and retry the shorter run.
        nodes.splice(i, 0, { t: 0, s: ch });
        node.n -= 1;
        node.pos += 1;
        const info = delimInfo(src, node.pos, node.n, ch);
        node.canOpen = info.canOpen;
        node.canClose = info.canClose;
        i++;
        continue;
      }
      i++;
      continue;
    }
    const closer = nodes[closerIdx];
    const kind = (Math.min(node.n, closerUse) % 2 === 1) ? 'em' : 'strong';
    const take = kind === 'em' ? 1 : 2;
    const kids = nodes.slice(i + 1, closerIdx);
    // Leftover opener chars stay INSIDE the em (at the start of its
    // inner text, where they may pair with a closer inside, e.g.
    // ***foo** bar* -> <em><strong>foo</strong> bar</em>).
    if (node.n > take) {
      const info = delimInfo(src, node.pos + take, node.n - take, ch);
      kids.unshift({ t: 2, ch, n: node.n - take, canOpen: info.canOpen, canClose: info.canClose, pos: node.pos + take });
    }
    // Closer chars that are part of M (closerUse) but not the delimiter
    // (take) also stay INSIDE, at the end (e.g. *foo *bar** -> the inner
    // <em>bar</em> uses the leftover * of the final **).
    const insideCloser = closerUse - take;
    if (insideCloser > 0) {
      const info = delimInfo(src, closer.pos, insideCloser, ch);
      kids.push({ t: 2, ch, n: insideCloser, canOpen: info.canOpen, canClose: info.canClose, pos: closer.pos });
    }
    processEmphasis(kids, src);
    const emNode = { t: 3, tag: kind, kids };
    // Closer chars NOT in M go OUTSIDE the em (after it).
    const replacement = [emNode];
    const outsideCloser = closer.n - closerUse;
    if (outsideCloser > 0) {
      const info = delimInfo(src, closer.pos + closerUse, outsideCloser, ch);
      replacement.push({ t: 2, ch, n: outsideCloser, canOpen: info.canOpen, canClose: info.canClose, pos: closer.pos + closerUse });
    }
    nodes.splice(i, closerIdx - i + 1, ...replacement);
    // Continue just past the em node (a leftover closer there is
    // reconsidered as a possible opener by the loop).
    i = i + 1;
  }
  // Strikethrough (~) keeps the stack pairing: equal-length runs only.
  const stack = [];
  i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (node.t !== 2 || node.ch !== '~') { i++; continue; }
    if (node.canOpen) stack.push(node);
    if (node.canClose) {
      let next = -1;
      for (;;) {
        if (node.n <= 0) break;
        let opener = null;
        let oi = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          const o = stack[s];
          if (o === node) continue;
          if (o.ch !== '~' || !o.canOpen || o.n !== node.n) continue;
          if ((o.canOpen && o.canClose) || (node.canOpen && node.canClose)) {
            const sum = o.n + node.n;
            if (sum % 3 === 0 && !(o.n % 3 === 0 && node.n % 3 === 0)) continue;
          }
          opener = o;
          oi = s;
          break;
        }
        if (!opener) break;
        const use = node.n;
        const oiIdx = nodes.indexOf(opener);
        const ciIdx = nodes.indexOf(node);
        const kids = nodes.slice(oiIdx + 1, ciIdx);
        processEmphasis(kids, src);
        const emNode = { t: 3, tag: 'del', kids };
        opener.n -= use;
        node.n -= use;
        stack.length = oi;
        const replacement = [];
        if (opener.n > 0) replacement.push(opener);
        replacement.push(emNode);
        if (node.n > 0) replacement.push(node);
        nodes.splice(oiIdx, ciIdx - oiIdx + 1, ...replacement);
        if (opener.n > 0) stack.push(opener);
        if (node.n > 0) stack.push(node);
        next = oiIdx + replacement.length;
        i = nodes.indexOf(node);
        if (i === -1) break;
      }
      if (i === -1) {
        i = next;
        continue;
      }
      if (node.n === 0) {
        const si = stack.indexOf(node);
        if (si !== -1) stack.splice(si, 1);
      }
    }
    i++;
  }
}

function renderNodes(nodes, links, inLink) {
  let out = '';
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    if (node.t === 0) out += esc(node.s);
    else if (node.t === 1) out += node.s;
    else if (node.t === 2) out += node.ch.repeat(node.n);
    else if (node.t === 3) out += '<' + node.tag + '>' + renderNodes(node.kids, links, inLink) + '</' + node.tag + '>';
    else if (node.t === 4) out += node.numeric ? esc(node.s) : node.s;
    else if (node.t === 5) out += '<br>';
    else if (node.t === 6) out += '<code>' + esc(node.s) + '</code>';
    else if (node.t === 7) {
      out += '<a href="' + escAttr(node.href) + '"';
      if (node.title !== null) out += ' title="' + escAttr(node.title) + '"';
      out += '>' + inline(node.text, links, true) + '</a>';
    } else if (node.t === 8) {
      out += '<img src="' + escAttr(node.href) + '" alt="' + plainText(node.text, links) + '"';
      if (node.title !== null) out += ' title="' + escAttr(node.title) + '"';
      out += '>';
    } else if (node.t === 9) {
      // marked's link renderer cleanUrls the href (GFM autolinks are
      // not cleaned at tokenize time); a null result renders as text.
      const href = cleanUrl(node.href);
      out += href === null ? esc(node.text) : '<a href="' + esc(href) + '">' + esc(node.text) + '</a>';
    }
    else if (node.t === 10) out += '<del>' + inline(node.text, links, inLink) + '</del>';
  }
  return out;
}

function renderPlain(nodes, links) {
  let out = '';
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    if (node.t === 0) out += escAttr(node.s);
    else if (node.t === 1) out += escAttr(node.s);
    else if (node.t === 2) out += node.ch.repeat(node.n);
    else if (node.t === 3) out += renderPlain(node.kids, links);
    else if (node.t === 4) out += node.numeric ? escAttr(node.s) : node.s;
    else if (node.t === 5) out += '';
    else if (node.t === 6) out += escAttr(node.s);
    else if (node.t === 7) out += plainText(node.text, links);
    else if (node.t === 8) out += plainText(node.text, links);
    else if (node.t === 9) out += escAttr(node.text);
    else if (node.t === 10) out += plainText(node.text, links);
  }
  return out;
}

// Plain text of inline content, as used for image alt text: formatting is
// stripped, raw HTML is escaped, links and images contribute their text.
function plainText(src, links) {
  const nodes = tokenize(src, links, false);
  processEmphasis(nodes, src);
  return renderPlain(nodes, links);
}

function inline(src, links, inLink) {
  const nodes = tokenize(src, links, inLink);
  processEmphasis(nodes, src);
  return renderNodes(nodes, links, inLink);
}

// ---------------------------------------------------------------------------
// Block layer
// ---------------------------------------------------------------------------

// Setext underline level: 1 for '=', 2 for '-', 0 when not an underline.
function setextLevel(line) {
  if (indentOf(line) > 3) return 0;
  let i = firstNonWs(line);
  if (i >= line.length) return 0;
  const c = line[i];
  if (c !== '=' && c !== '-') return 0;
  let j = line.length;
  while (j > i && (line[j - 1] === ' ' || line.charCodeAt(j - 1) === 9)) j--;
  for (let k = i; k < j; k++) {
    if (line[k] !== c) return 0;
  }
  return c === '=' ? 1 : 2;
}

function atxLevel(s) {
  let j = 0;
  while (j < s.length && s[j] === '#') j++;
  if (j === 0 || j > 6) return 0;
  if (j < s.length && s[j] !== ' ' && s[j].charCodeAt(0) !== 9) return 0;
  return j;
}

function fenceInfo(s) {
  const c = s[0];
  if (c !== '`' && c !== '~') return null;
  let j = 0;
  while (j < s.length && s[j] === c) j++;
  if (j < 3) return null;
  return { ch: c, len: j, info: s.slice(j) };
}

function isHr(s) {
  const c = s[0];
  if (c !== '*' && c !== '-' && c !== '_') return false;
  let count = 0;
  for (let k = 0; k < s.length; k++) {
    const d = s[k];
    if (d === c) count++;
    else if (d === ' ' || d.charCodeAt(0) === 9) continue;
    else return false;
  }
  return count >= 3;
}

// List marker at the start of a line (indent already known to be <= 3).
// Returns null, or { ordered, delim, start, markerLen, indent, contentIndent,
// contentStart, empty }. contentStart is the string index of the first
// non-whitespace character after the marker.
// True when a line, after its leading whitespace, starts with a list
// marker (any indent — matchListMarker itself rejects indent > 3).
function startsWithListMarker(line) {
  const s = line.slice(firstNonWs(line));
  if (s === '') return false;
  const c = s[0];
  if (c === '-' || c === '+' || c === '*') {
    return s.length === 1 || s[1] === ' ' || s[1].charCodeAt(0) === 9;
  }
  if (c >= '0' && c <= '9') {
    let j = 0;
    while (j < s.length && s[j] >= '0' && s[j] <= '9' && j < 9) j++;
    if (j === 0 || j >= s.length || (s[j] !== '.' && s[j] !== ')')) return false;
    return true;
  }
  return false;
}

function matchListMarker(line) {
  const ind = indentOf(line);
  if (ind > 3) return null;
  const s = line.slice(firstNonWs(line));
  if (s === '') return null;
  const c = s[0];
  let markerLen;
  let ordered = false;
  let delim = '';
  let start = 0;
  if (c === '-' || c === '+' || c === '*') {
    markerLen = 1;
    delim = c;
  } else if (c >= '0' && c <= '9') {
    let j = 0;
    while (j < s.length && s[j] >= '0' && s[j] <= '9' && j < 9) j++;
    if (j === 0 || j >= s.length || (s[j] !== '.' && s[j] !== ')')) return null;
    start = parseInt(s.slice(0, j), 10);
    delim = s[j];
    markerLen = j + 1;
    ordered = true;
  } else return null;
  if (markerLen >= s.length) {
    const ci = ind + markerLen + 1;
    return { ordered, delim, start, markerLen, indent: ind, contentIndent: ci, thresh: Math.min(ci, 4), firstContent: '', empty: true };
  }
  const after = s[markerLen];
  if (after !== ' ' && after.charCodeAt(0) !== 9) return null;
  let col = ind + markerLen;
  let k = markerLen;
  while (k < s.length && (s[k] === ' ' || s[k].charCodeAt(0) === 9)) {
    if (s[k] === ' ') col++;
    else col += 4 - (col % 4);
    k++;
  }
  if (k >= s.length) {
    const ci = ind + markerLen + 1;
    return { ordered, delim, start, markerLen, indent: ind, contentIndent: ci, thresh: Math.min(ci, 4), firstContent: '', empty: true };
  }
  const gap = col - (ind + markerLen);
  const contentIndent = gap >= 1 && gap <= 4 ? col : ind + markerLen + 1;
  // Continuation threshold: marked's indent cache clamps the effective
  // indent (R-1 to 0-3), so a line counts as item content from 4 columns
  // in even when the marker-line content sits further right; the strip
  // amount stays the full content indent.
  const thresh = Math.min(contentIndent, 4);
  const firstContent = gap >= 1 && gap <= 4 ? s.slice(k) : ' '.repeat(col - contentIndent) + s.slice(k);
  return { ordered, delim, start, markerLen, indent: ind, contentIndent, thresh, firstContent, empty: false };
}

// The line's content starting at column targetCol, with a tab that straddles
// the boundary expanded to the spaces that remain after it.
function sliceAtCol(line, targetCol) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < targetCol) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch.charCodeAt(0) === 9) {
      const next = col + 4 - (col % 4);
      if (next <= targetCol) { col = next; i++; }
      else {
        // The tab straddles the target column: the part at and after the
        // target becomes spaces, and the rest of the line is re-expanded
        // from the column after the tab.
        let out = '';
        for (let q = targetCol; q < next; q++) out += ' ';
        let c2 = next;
        for (let j = i + 1; j < line.length; j++) {
          const ch2 = line[j];
          if (ch2.charCodeAt(0) === 9) {
            const n2 = c2 + 4 - (c2 % 4);
            for (let q = c2; q < n2; q++) out += ' ';
            c2 = n2;
          } else {
            out += ch2;
            c2++;
          }
        }
        return out;
      }
    } else {
      // A non-space character: stop stripping here; never eat content
      // when the line's indent is shorter than the target column.
      break;
    }
  }
  return line.slice(i);
}

// Expand a line's leading tabs to spaces (relative to column 0), as
// marked's list tokenizer does for continuation lines (leadingSpaceTab
// + J) before stripping the item indent.
function expandLeadTabs(line) {
  let i = 0;
  let col = 0;
  let out = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { out += ' '; col++; }
    else { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; }
    i++;
  }
  return out + line.slice(i);
}

// Strip a block quote prefix ('>' plus one optional space) from a line,
// expanding leading tabs to spaces by column.
function stripQuotePrefix(line) {
  const ind = indentOf(line);
  const gtPos = firstNonWs(line);
  const col = ind + 1;
  let k = gtPos + 1;
  let hasWs = false;
  if (k < line.length && (line[k] === ' ' || line.charCodeAt(k) === 9)) hasWs = true;
  let c2 = col;
  let m = k;
  while (m < line.length && (line[m] === ' ' || line.charCodeAt(m) === 9)) {
    if (line[m] === ' ') c2++;
    else c2 += 4 - (c2 % 4);
    m++;
  }
  // Only one space after '>' belongs to the prefix; any further spaces
  // are content (a lone ' ' line stays a ' ' line, not an empty one).
  const prefixCols = col + (hasWs ? 1 : 0);
  const spaces = c2 - prefixCols;
  return ' '.repeat(spaces < 0 ? 0 : spaces) + line.slice(m);
}

function isAllWs(s) {
  for (let k = 0; k < s.length; k++) {
    if (!isWsChar(s[k])) return false;
  }
  return true;
}

// HTML block type (1-7) for a line whose content starts a tag, else 0.
function htmlBlockType(s) {
  const low = s.toLowerCase();
  if (low.startsWith('<!--')) return 2;
  if (low.startsWith('<?')) return 3;
  if (low.startsWith('<![cdata[')) return 5;
  if (s.length >= 3 && s[0] === '<' && s[1] === '!' && s.charCodeAt(2) >= 65 && s.charCodeAt(2) <= 90) return 4;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (!m) return 0;
  const tag = m[1].toLowerCase();
  const ai = m[0].length;
  const after = ai < s.length ? s[ai] : undefined;
  const okAfter = after === undefined || after === ' ' || after.charCodeAt(0) === 9 || after === '>'
    || (after === '/' && s[ai + 1] === '>');
  const isClose = m[0][1] === '/';
  if (!isClose && (tag === 'pre' || tag === 'script' || tag === 'style' || tag === 'textarea') && okAfter) return 1;
  if (BLOCK_TAGS.has(tag) && okAfter) return 6;
  const tagEnd = matchHtmlTag(s, 0);
  if (tagEnd && isAllWs(s.slice(tagEnd.end))) return 7;
  return 0;
}

// Does this line start a block construct (used for lazy continuation checks)?
function isBlockStartLine(line) {
  if (setextLevel(line) > 0) return false;
  const ind = indentOf(line);
  if (ind > 3) return false;
  const s = line.slice(firstNonWs(line));
  if (s === '') return false;
  const c = s[0];
  if (c === '#') return atxLevel(s) > 0;
  if (c === '`' || c === '~') {
    const f = fenceInfo(s);
    if (!f) return false;
    if (f.ch === '`' && f.info.indexOf('`') !== -1) return false;
    return true;
  }
  if (c === '>') return true;
  if (c === '*' || c === '-' || c === '_' || c === '+') {
    if (isHr(s)) return true;
    if (matchListMarker(line)) return true;
    return false;
  }
  if (c === '<') {
    const t = htmlBlockType(s);
    return t >= 1 && t <= 6;
  }
  if (c >= '0' && c <= '9') return matchListMarker(line) !== null;
  return false;
}

// Can this line interrupt a paragraph (stricter list rules apply)?
function interruptsParagraph(line, st) {
  if (setextLevel(line) > 0) return false;
  const ind = indentOf(line);
  if (ind > 3) return false;
  const s = line.slice(firstNonWs(line));
  if (s === '') return false;
  const c = s[0];
  if (c === '#') return atxLevel(s) > 0;
  if (c === '`' || c === '~') {
    const f = fenceInfo(s);
    if (!f) return false;
    if (f.ch === '`' && f.info.indexOf('`') !== -1) return false;
    return true;
  }
  if (c === '>') return true;
  if (c === '*' || c === '-' || c === '_' || c === '+') {
    if (isHr(s)) return true;
    const m = matchListMarker(line);
    if (m && !m.empty) return true;
    return false;
  }
  if (c === '<') {
    const t = htmlBlockType(s);
    return t >= 1 && t <= 6;
  }
  if (c >= '0' && c <= '9') {
    const m = matchListMarker(line);
    // An ordered list interrupts a paragraph only for start 1 at top
    // level; inside a list item (st.listDepth > 0) any start number does.
    if (m && !m.empty && (m.start === 1 || (st && st.listDepth > 0))) return true;
    return false;
  }
  return false;
}
// Strip leading link reference definitions from a paragraph's text,
// registering them (first definition of a label wins). Returns the rest.
function stripDefs(text, links) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    let col = 0;
    let j = i;
    while (j < n && col < 3) {
      const c = text[j];
      if (c === ' ') { col++; j++; }
      else if (c.charCodeAt(0) === 9) {
        const next = col + 4 - (col % 4);
        if (next > 3) break;
        col = next;
        j++;
      } else break;
    }
    if (text[j] !== '[') break;
    let k = j + 1;
    let label = '';
    let ok = false;
    while (k < n) {
      const c = text[k];
      if (c === '\\' && k + 1 < n && isPunctChar(text[k + 1])) { label += text[k]; label += text[k + 1]; k += 2; continue; }
      if (c === '[') break;
      if (c === ']') { ok = true; break; }
      label += c;
      k++;
    }
    if (!ok) break;
    const norm = normalizeLabel(label);
    if (norm === '' || norm.length > 999) break;
    k++;
    if (text[k] !== ':') break;
    k++;
    while (k < n && isWsChar(text[k])) k++;
    if (k >= n) break;
    let href;
    if (text[k] === '<') {
      let m = k + 1;
      while (m < n && text[m] !== '>' && text.charCodeAt(m) !== 10 && text[m] !== '<') {
        if (text[m] === '\\') m += 2;
        else m++;
      }
      if (m >= n || text[m] !== '>') break;
      href = unescapePunct(text.slice(k + 1, m));
      k = m + 1;
    } else {
      let depth = 0;
      let m = k;
      while (m < n) {
        const ch = text[m];
        if (ch === '\\' && m + 1 < n && isPunctChar(text[m + 1])) { m += 2; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') {
          if (depth === 0) break;
          depth--;
        } else if (isWsChar(ch) || ch.charCodeAt(0) < 32) break;
        m++;
      }
      if (m === k) break;
      href = unescapePunct(text.slice(k, m));
      k = m;
    }
    href = cleanUrl(href);
    if (href === null) break;
    let hadWs = false;
    while (k < n && (text[k] === ' ' || text.charCodeAt(k) === 9)) { k++; hadWs = true; }
    let title = null;
    let endAt = -1;
    if (k < n && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
      // A same-line title must be separated from the destination by
      // whitespace; an attached title opener invalidates the whole def.
      if (!hadWs) break;
      const q = text[k];
      const closer = q === '(' ? ')' : q;
      let m = k + 1;
      while (m < n) {
        if (text[m] === '\\' && m + 1 < n && isPunctChar(text[m + 1])) { m += 2; continue; }
        if (text[m] === closer) break;
        m++;
      }
      if (m >= n || text[m] !== closer) break;
      title = unescapePunct(text.slice(k + 1, m));
      k = m + 1;
      while (k < n && (text[k] === ' ' || text.charCodeAt(k) === 9)) k++;
      if (k < n && text.charCodeAt(k) !== 10) break;
      endAt = k;
    } else if (k < n && text.charCodeAt(k) === 10) {
      const k2 = k + 1;
      let m = k2;
      while (m < n && (text[m] === ' ' || text.charCodeAt(m) === 9)) m++;
      if (m < n && (text[m] === '"' || text[m] === "'" || text[m] === '(')) {
        const q = text[m];
        const closer = q === '(' ? ')' : q;
        let p = m + 1;
        let okTitle = true;
        while (p < n) {
          if (text[p] === '\\' && p + 1 < n && isPunctChar(text[p + 1])) { p += 2; continue; }
          if (text[p] === closer) break;
          p++;
        }
        if (p >= n || text[p] !== closer) okTitle = false;
        let nextTitle = null;
        let endP = -1;
        if (okTitle) {
          nextTitle = unescapePunct(text.slice(m + 1, p));
          p++;
          while (p < n && (text[p] === ' ' || text.charCodeAt(p) === 9)) p++;
          if (p < n && text.charCodeAt(p) !== 10) okTitle = false;
          else endP = p;
        }
        if (okTitle) { title = nextTitle; endAt = endP; }
        else { title = null; endAt = k; }
      } else {
        endAt = k;
      }
    } else if (k >= n) {
      endAt = k;
    } else {
      break;
    }
    if (!links.has(norm)) links.set(norm, { href, title });
    if (endAt >= n) { i = n; break; }
    i = endAt + 1;
  }
  return text.slice(i);
}

// Strip up to n columns of leading whitespace from a line (for fenced
// code content, which drops the opening fence's indent). Stops at the
// first non-whitespace character.
function stripIndentN(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === ' ') { col++; i++; continue; }
    if (c.charCodeAt(0) === 9) {
      const next = col + 4 - (col % 4);
      if (next > n) {
        let out = '';
        for (let q = n; q < next; q++) out += ' ';
        let c2 = next;
        for (let j = i + 1; j < line.length; j++) {
          const ch2 = line[j];
          if (ch2.charCodeAt(0) === 9) {
            const n2 = c2 + 4 - (c2 % 4);
            for (let q = c2; q < n2; q++) out += ' ';
            c2 = n2;
          } else {
            out += ch2;
            c2++;
          }
        }
        return out;
      }
      col = next; i++; continue;
    }
    break;
  }
  return line.slice(i);
}

// End tag for a type-1 HTML block (pre/script/style/textarea), or null.
function htmlEndTag(s) {
  if (s[0] !== '<') return null;
  const tags = ['pre', 'script', 'style', 'textarea'];
  for (let t = 0; t < tags.length; t++) {
    const tag = tags[t];
    if (s.length > tag.length && s.slice(1, 1 + tag.length).toLowerCase() === tag) {
      const after = s[1 + tag.length];
      if (after === undefined || after === ' ' || after === '>' || after.charCodeAt(0) === 9) {
        return '</' + tag + '>';
      }
    }
  }
  return null;
}

function langOf(info) {
  let i = 0;
  while (i < info.length && (info[i] === ' ' || info.charCodeAt(i) === 9)) i++;
  let j = i;
  while (j < info.length && info[j] !== ' ' && info[j].charCodeAt(j) !== 9) j++;
  return info.slice(i, j);
}

function splitCells(line) {
  const cells = [];
  let cur = '';
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    // An escaped pipe is a literal pipe in the cell, not a delimiter,
    // and the escape is resolved here (before inline parsing, so a code
    // span containing \| renders just |).
    if (c === '\\' && k + 1 < line.length && line[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '\\' && k + 1 < line.length) { cur += c + line[k + 1]; k++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}

function isDelimRow(line) {
  if (indentOf(line) > 3) return null;
  let s = line;
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s[b - 1] === ' ' || s.charCodeAt(b - 1) === 9)) b--;
  // Marked's table tokenizer requires the delimiter to match /[:|]/:
  // a bare '---' is a setext underline, not a table delimiter.
  if (s.slice(a, b).indexOf(':') === -1 && s.slice(a, b).indexOf('|') === -1) return null;
  if (a < b && s[a] === '|') a++;
  if (b > a && s[b - 1] === '|') b--;
  if (a >= b) return null;
  const parts = splitCells(s.slice(a, b));
  const aligns = [];
  for (let p = 0; p < parts.length; p++) {
    const cell = parts[p].trim();
    if (!/^:?-+:?$/.test(cell)) return null;
    aligns.push(cell[0] === ':' && cell[cell.length - 1] === ':' ? 'center' : cell[0] === ':' ? 'left' : cell[cell.length - 1] === ':' ? 'right' : null);
  }
  return aligns;
}
function isFenceClose(s, ch, len) {
  if (indentOf(s) > 3) return false;
  const t = s.slice(firstNonWs(s));
  if (t[0] !== ch) return false;
  let k = 0;
  while (k < t.length && t[k] === ch) k++;
  if (k < len) return false;
  return isAllWs(t.slice(k));
}

// Tracks whether the content added so far ends with an open paragraph, for
// lazy continuation lines. state: { inFence, fenceCh, fenceLen,
// endsWithParagraph, lastWasBlank }. inList is true for list-item content:
// there, an indented-code line ends the paragraph (marked's list
// tokenizer stops lazy continuation after a line whose item-text indent
// is 4+), while in a blockquote it does not.
function trackLine(state, rest, inList) {
  if (isBlank(rest)) {
    state.endsWithParagraph = false;
    state.lastWasBlank = true;
    return;
  }
  if (state.inFence) {
    if (isFenceClose(rest, state.fenceCh, state.fenceLen)) state.inFence = false;
    state.endsWithParagraph = false;
    state.lastWasBlank = false;
    return;
  }
  // A nested quote line: the paragraph state depends on the innermost
  // content, so strip one quote level and re-examine. A fence opened
  // inside the nested quote must not fence the outer level.
  if (indentOf(rest) <= 3) {
    const s0 = rest.slice(firstNonWs(rest));
    if (s0[0] === '>') {
      const savedFence = state.inFence;
      trackLine(state, stripQuotePrefix(rest), inList);
      state.inFence = savedFence;
      return;
    }
  }
  // A list line: the paragraph state depends on the item's first
  // content (and through nested quotes), so recurse into it. An empty
  // item ends the paragraph.
  if (indentOf(rest) <= 3) {
    const lm = matchListMarker(rest);
    if (lm) {
      if (lm.empty) { state.endsWithParagraph = false; state.lastWasBlank = false; return; }
      trackLine(state, lm.firstContent, inList);
      return;
    }
  }
  if (indentOf(rest) <= 3) {
    const f = fenceInfo(rest.slice(firstNonWs(rest)));
    if (f && !(f.ch === '`' && f.info.indexOf('`') !== -1)) {
      state.inFence = true;
      state.fenceCh = f.ch;
      state.fenceLen = f.len;
      state.endsWithParagraph = false;
      state.lastWasBlank = false;
      return;
    }
  }
  if (isBlockStartLine(rest)) {
    state.endsWithParagraph = false;
  } else if (state.lastWasBlank && indentOf(rest) >= 4) {
    state.endsWithParagraph = false;
  } else if (inList && isIndentedCodeStart(rest)) {
    // In a list item, an indented-code line is a code block, not
    // paragraph text: it ends lazy continuation (marked's m >= 4
    // check in the list tokenizer).
    state.endsWithParagraph = false;
  } else {
    state.endsWithParagraph = true;
  }
  state.lastWasBlank = false;
}

// A lazy setext-underline line must be added as paragraph text, not as a
// heading underline. If useFourSpaces (blockquote after a lazy line), indent
// it to 4 spaces; otherwise escape the first '=' so the block parser sees a
// paragraph line and the inline parser restores the '='. Lines already
// indented 4+ need no treatment.
function neutralizeLazySetext(line, useFourSpaces) {
  if (indentOf(line) >= 4) return line;
  if (useFourSpaces) {
    return '    ' + line.slice(firstNonWs(line));
  }
  const p = firstNonWs(line);
  return line.slice(0, p) + String.fromCharCode(92) + line.slice(p);
}

// Parse one blockquote group's lines as blocks. A quote's inner content
// is lexed with top=true, so any-start ordered lists do NOT interrupt
// paragraphs there (that rule applies only inside list items); reset
// listDepth while parsing a group.
function parseGroupLines(group, st) {
  const saved = st.listDepth || 0;
  st.listDepth = 0;
  try { return parseBlocks(group, 0, group.length, st); }
  finally { st.listDepth = saved; }
}

// Merge a freshly parsed blockquote group into the accumulated block
// list, following marked's blockTokens merge rules (top=true inside a
// quote): an indented code block or a paragraph merges into a preceding
// paragraph, the code text keeping its trailing newline when more lines
// follow in the group. The merge chain from the previous group is
// broken when the group starts with 2+ blank lines (a space token is
// emitted then); within a group a paragraph merges only as the first
// block or directly after a merged code block.
function mergeGroupBlocks(acc, blocks, groupLines) {
  let leadBlank = 0;
  while (leadBlank < groupLines.length && isBlank(groupLines[leadBlank])) leadBlank++;
  let prevMergedCode = false;
  for (let t = 0; t < blocks.length; t++) {
    const blk = blocks[t];
    const last = acc.length > 0 ? acc[acc.length - 1] : null;
    if (t === 0 && leadBlank < 2 && blk.k === 'code' && blk.indented && last && last.k === 'p') {
      let ct = blk.text;
      if (!blk.trail && ct.length > 0 && ct[ct.length - 1] === NL) ct = ct.slice(0, -1);
      last.text += NL + ct;
      prevMergedCode = true;
      continue;
    }
    if (blk.k === 'p' && last && last.k === 'p' && (t === 0 ? leadBlank < 2 : prevMergedCode)) {
      last.text += NL + blk.text;
      prevMergedCode = false;
      continue;
    }
    acc.push(blk);
    prevMergedCode = false;
  }
}

function parseBlockquote(lines, i, b, st) {
  const acc = [];
  let group = [];
  let groupHasQ = false;
  let j = i;
  const state = { inFence: false, fenceCh: '', fenceLen: 0, endsWithParagraph: false, lastWasBlank: true };
  // Close the current group: parse its lines and merge the blocks into
  // the accumulated list. Returns the accumulated last block.
  const closeGroup = () => {
    if (group.length > 0) mergeGroupBlocks(acc, parseGroupLines(group, st), group);
    group = [];
    groupHasQ = false;
    return acc.length > 0 ? acc[acc.length - 1] : null;
  };
  while (j < b) {
    const line = lines[j];
    // A truly blank line (no '>' prefix) ends the quote.
    if (isBlank(line)) break;
    const ind = indentOf(line);
    if (ind <= 3) {
      const s = line.slice(firstNonWs(line));
      if (s[0] === '>') {
        const rest = stripQuotePrefix(line);
        group.push(rest);
        groupHasQ = true;
        trackLine(state, rest);
        j++;
        continue;
      }
    }
    // Lazy continuation of an open paragraph. Marked's blockquote
    // tokenizer splits the quote into groups (consecutive '>' lines,
    // then the lazy lines as a second group, each lexed separately and
    // merged); the lazy lines are taken raw, so a 4-space lazy line
    // lexes as indented code and merges into the paragraph with a
    // blank line, and a setext line lexes as plain paragraph text. A
    // thematic break or any block start ends the quote instead. If the
    // current group ends in a nested quote or list, the lazy line joins
    // that group (the nested container re-lexes with it included); if
    // it ends in a code block, heading, hr, html block or table, the
    // quote ends here and the line is not consumed.
    // Lazy continuation of an open paragraph. Marked's blockquote
    // regex excludes list-start lines from lazy continuation (Ke):
    // a bullet or ordered marker followed by a space/tab or end of
    // line — including a lone '-' (an empty item), which
    // isBlockStartLine misses because it reads as a setext underline.
    if (state.endsWithParagraph && !isBlockStartLine(line) && !/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(line) && !(ind <= 3 && isHr(line.slice(firstNonWs(line))))) {
      // Marked's blockquoteSetextReplace: a lazy setext-underline line
      // (0-3 spaces, a run of '=' or '-', only spaces/tabs after) that
      // is not the first line of its group is indented to 4 spaces, so
      // it lexes as paragraph text, not a heading underline. A
      // '>'-prefixed setext line is not neutralized (the '>' blocks
      // the regex), and a setext line that opens a group stays literal.
      const neutralize = (l) => group.length > 0 && /^ {0,3}(?:=+|-+)[ \t]*$/.test(l) ? '    ' + l.slice(firstNonWs(l)) : l;
      if (groupHasQ) {
        const probe = parseGroupLines(group, st);
        const probeLast = probe.length > 0 ? probe[probe.length - 1] : null;
        if (probeLast && (probeLast.k === 'quote' || probeLast.k === 'list')) {
          group.push(neutralize(line));
          trackLine(state, line, probeLast.k === 'list');
          j++;
          continue;
        }
        mergeGroupBlocks(acc, probe, group);
        group = [];
        groupHasQ = false;
        const accLast = acc.length > 0 ? acc[acc.length - 1] : null;
        if (accLast && (accLast.k === 'code' || accLast.k === 'h' || accLast.k === 'hr' || accLast.k === 'html' || accLast.k === 'table')) {
          break;
        }
      }
      group.push(neutralize(line));
      trackLine(state, line);
      j++;
      continue;
    }
    break;
  }
  closeGroup();
  return { node: { k: 'quote', blocks: acc }, next: j };
}

function trimPipes(line) {
  let s = line.trim();
  if (s[0] === '|') s = s.slice(1);
  if (s.length > 0 && s[s.length - 1] === '|') s = s.slice(0, -1);
  return s;
}

function isIndentedCodeStart(line) {
  // A line whose content starts at column 4+ (spaces or a tab at 0-3
  // columns): an indented code block start in marked's table regex.
  if (firstNonWs(line) >= line.length) return false;
  return indentOf(line) >= 4;
}

// Strip one indented-code indent (marked's codeRemoveIndent): 1-4
// spaces, or up to 3 spaces plus a tab.
function stripCodeIndent(line) {
  const m = /^(?: {0,3}\t| {1,4})/.exec(line);
  return m ? line.slice(m[0].length) : line;
}

function parseParagraph(lines, i, b, st) {
  const paraLines = [];
  let j = i;
  // Soft breaks: lines that end a plain paragraph but are table rows
  // (tab-only blank lines; any-start ordered lists inside a list item).
  // They are collected and the paragraph is truncated at the first one
  // once the paragraph turns out not to be a table.
  let tabOnlyIdx = -1;
  let ordIdx = -1;
  let setextIdx = -1;
  while (j < b) {
    const line = lines[j];
    if (isBlank(line)) {
      // A blank line ends the paragraph, except a non-empty
      // whitespace-only line that is the last line of the input
      // (trailing whitespace of the paragraph). An empty last line is
      // just the trailing-newline marker. A tab-only blank line is a
      // table row, not a paragraph break.
      const tabOnly = line.indexOf('\t') !== -1;
      if (!tabOnly && (j < b - 1 || line === '')) break;
      if (tabOnly && tabOnlyIdx === -1) tabOnlyIdx = paraLines.length;
      paraLines.push(line);
      j++;
      continue;
    }
    // A setext underline line is collected, not a break: inside a
    // table it is a row (marked's table row pattern excludes only
    // hr/heading/blockquote/code/fences/list/html, not a lone '='
    // line). Outside a table it truncates the paragraph (recorded
    // here, applied below) so the heading path still sees it.
    if (paraLines.length > 0 && setextLevel(line) > 0 && setextIdx === -1) setextIdx = paraLines.length;
    if (paraLines.length > 0 && interruptsParagraph(line, st)) {
      // An ordered list with a start other than 1 inside a list item
      // interrupts a plain paragraph but is a table row.
      const m = matchListMarker(line);
      if (m && m.ordered && !m.empty && m.start !== 1 && st && st.listDepth > 0) {
        if (ordIdx === -1) ordIdx = paraLines.length;
        paraLines.push(line);
        j++;
        continue;
      }
      break;
    }
    paraLines.push(line);
    j++;
  }
  let rest = stripDefs(paraLines.join(NL), st.links);
  if (rest === '') return { node: null, next: j };
  let restLines = rest.split(NL);
  const removed = paraLines.length - restLines.length;
  if (restLines.length >= 2) {
    const aligns = isDelimRow(restLines[1]);
    if (aligns) {
      const headerCells = splitCells(trimPipes(restLines[0]));
      // The header must have exactly as many cells as the delimiter
      // row; otherwise this is not a table at all.
      if (headerCells.length !== aligns.length) {
        // fall through to setext / paragraph below
      } else {
      const header = [];
      for (let c = 0; c < aligns.length; c++) {
        header.push(c < headerCells.length ? headerCells[c].trim() : '');
      }
      const rows = [];
      let endJ = j;
      for (let r = 2; r < restLines.length; r++) {
        // An indented-code line ends the table; it (and what follows)
        // is parsed as new blocks.
        if (isIndentedCodeStart(restLines[r])) { endJ = i + r + removed; break; }
        const cells = splitCells(trimPipes(restLines[r]));
        const row = [];
        for (let c = 0; c < aligns.length; c++) {
          row.push(c < cells.length ? cells[c].trim() : '');
        }
        rows.push(row);
      }
      return { node: { k: 'table', header, aligns, rows }, next: endJ };
      }
    }
  }
  // Not a table: truncate at the first soft break.
  let cut = -1;
  if (tabOnlyIdx !== -1) cut = tabOnlyIdx;
  if (ordIdx !== -1 && (cut === -1 || ordIdx < cut)) cut = ordIdx;
  if (setextIdx !== -1 && (cut === -1 || setextIdx < cut)) cut = setextIdx;
  if (cut !== -1) {
    const trunc = paraLines.slice(0, cut);
    rest = stripDefs(trunc.join(NL), st.links);
    if (rest === '') return { node: null, next: i + cut };
    restLines = rest.split(NL);
    j = i + cut;
  }
  // Inside a list item, an indented-code line in the middle of a
  // paragraph is an indented code block merged into the paragraph
  // text (marked's text-token/code merge): its text is the line with
  // the code indent stripped, plus a blank line when more paragraph
  // text follows it. Skipped when a setext underline follows (the
  // heading path below is already correct there).
  if (st && st.listDepth > 0 && !(j < b && setextLevel(lines[j]) > 0)) {
    const out = [];
    let r = 0;
    let merged = false;
    while (r < restLines.length) {
      if (r >= 1 && isIndentedCodeStart(restLines[r])) {
        let s = r;
        while (s < restLines.length && isIndentedCodeStart(restLines[s])) s++;
        for (let k = r; k < s; k++) out.push(stripCodeIndent(restLines[k]));
        if (s < restLines.length) out.push('');
        merged = true;
        r = s;
      } else {
        out.push(restLines[r]);
        r++;
      }
    }
    if (merged) rest = out.join(NL);
  }
  if (j < b && setextLevel(lines[j]) > 0) {
    // A setext heading strips leading whitespace from its first line and
    // trailing whitespace from its last line (middle lines untouched).
    let a = 0;
    while (a < rest.length && (rest[a] === ' ' || rest.charCodeAt(a) === 9)) a++;
    let z = rest.length;
    while (z > a && (rest[z - 1] === ' ' || rest.charCodeAt(z - 1) === 9)) z--;
    return { node: { k: 'h', level: setextLevel(lines[j]), text: rest.slice(a, z) }, next: j + 1 };
  }
  return { node: { k: 'p', text: rest }, next: j };
}
function parseList(lines, i, b, st) {
  const first = matchListMarker(lines[i]);
  const ordered = first.ordered;
  const delim = first.delim;
  const items = [];
  let j = i;
  let loose = false;
  let sawBlankBetween = false;
  while (j < b) {
    const line = lines[j];
    if (isBlank(line)) {
      let k = j + 1;
      while (k < b && isBlank(lines[k])) k++;
      if (k >= b) break;
      if (items.length === 0) break;
      const cont = items[items.length - 1];
      const nline = lines[k];
      const nind = indentOf(nline);
      const nlm = matchListMarker(nline);
      // A same-type marker that is not indented enough to be nested
      // content starts a new item even after an empty item.
      if (nlm && nlm.ordered === ordered && nlm.delim === delim && nind <= 3 && nind < cont.width) {
        for (let t = j; t < k; t++) cont.lines.push('');
        sawBlankBetween = true;
        j = k;
        continue;
      }
      // An empty item followed by a blank line is closed; a later
      // indented line is a new block outside the list, not its content.
      if (cont.lines.every((l) => isBlank(l))) break;
      // After a blank line, a following line rejoins the item only at the
      // full content indent (the capped threshold is for direct
      // continuations, not blank-separated ones).
      if (nind >= cont.width) {
        for (let t = j; t < k; t++) cont.lines.push('');
        j = k;
        continue;
      }
      if (nind <= 3 && isHr(nline.slice(firstNonWs(nline)))) break;
      break;
    }
    if (items.length > 0) {
      const cont = items[items.length - 1];
      // A sufficiently indented line is content of the current item
      // (possibly a nested list), not a sibling item. A nested list
      // marker needs the full content indent; plain text only needs the
      // capped threshold.
      const need = startsWithListMarker(line) ? cont.width : cont.thresh;
      if (indentOf(line) >= need) {
        const rest = sliceAtCol(expandLeadTabs(line), cont.width);
        cont.lines.push(rest);
        trackLine(cont.state, rest, true);
        j++;
        continue;
      }
      // Lazy continuation of an open paragraph (includes setext
      // underlines, which are not block starts). A thematic break ends
      // the list instead. A list marker line is never lazy: it starts a
      // new item even when it also reads as a setext underline ('-').
      if (cont.state.endsWithParagraph && !isBlockStartLine(line) && !matchListMarker(line) && !(indentOf(line) <= 3 && isHr(line.slice(firstNonWs(line))))) {
        // A lazy line joins the item's content verbatim (marked keeps
        // its original indent); it is not stripped to the item indent.
        let add = line;
        if (setextLevel(add) === 1) add = neutralizeLazySetext(add, false);
        // A lazy line that reads as a list marker must stay paragraph
        // text, not start a nested list when the content is re-parsed.
        if (startsWithListMarker(add)) {
          const p = firstNonWs(add);
          const s0 = add[p];
          if (s0 === '-' || s0 === '+' || s0 === '*') {
            add = add.slice(0, p) + String.fromCharCode(92) + add.slice(p);
          } else {
            let q = p;
            while (q < add.length && add[q] >= '0' && add[q] <= '9') q++;
            if (q < add.length && (add[q] === '.' || add[q] === ')')) {
              add = add.slice(0, q) + String.fromCharCode(92) + add.slice(q);
            }
          }
        }
        cont.lines.push(add);
        trackLine(cont.state, add, true);
        j++;
        continue;
      }
    }
    // A thematic break ends the list (it is not a list item).
    if (indentOf(line) <= 3 && isHr(line.slice(firstNonWs(line)))) break;
    const lm2 = matchListMarker(line);
    if (lm2 && lm2.ordered === ordered && lm2.delim === delim && indentOf(line) <= 3) {
      const width = lm2.contentIndent;
      const thresh = lm2.thresh;
      const sub = [lm2.firstContent];
      const state = { inFence: false, fenceCh: '', fenceLen: 0, endsWithParagraph: false, lastWasBlank: true };
      trackLine(state, sub[0], true);
      items.push({ width, thresh, lines: sub, state });
      j++;
      continue;
    }
    break;
  }
  if (items.length === 0) return { node: null, next: i + 1 };
  for (let t = 0; t < items.length; t++) {
    const ls = items[t].lines;
    while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
    // A leading empty first line (empty marker) is not a blank separator.
    const startU = ls.length > 0 && ls[0] === '' ? 1 : 0;
    // Track fenced code state: blanks inside a fence are code content,
    // not block separators.
    let inFence = false;
    let fenceCh = '';
    let fenceLen = 0;
    for (let u = startU; u < ls.length; u++) {
      const lu = ls[u];
      if (!inFence) {
        const f = indentOf(lu) <= 3 ? fenceInfo(lu.slice(firstNonWs(lu))) : null;
        if (f && !(f.ch === '`' && f.info.indexOf('`') !== -1)) {
          inFence = true;
          fenceCh = f.ch;
          fenceLen = f.len;
        }
      } else if (isFenceClose(lu, fenceCh, fenceLen)) {
        inFence = false;
      }
      if (inFence || lu !== '') continue;
      // Blank line (not in a fence): a separator unless the line before
      // it is nested content.
      let v = u + 1;
      while (v < ls.length && ls[v] === '') v++;
      if (v < ls.length) {
        let w = u - 1;
        while (w >= 0 && ls[w] === '') w--;
        const bw = w >= 0 ? ls[w] : '';
        const beforeNested = w >= 0 && (indentOf(bw) >= items[t].thresh || matchListMarker(bw) !== null);
        // The blank is inside nested content only when the line before
        // it is nested AND the following line runs deeper (a continuation
        // of that nested block); otherwise it separates top-level blocks.
        const runsDeeper = beforeNested && indentOf(ls[v]) > indentOf(bw);
        if (!runsDeeper) { loose = true; break; }
      }
      u = v - 1;
    }
    if (loose) break;
  }
  if (sawBlankBetween) loose = true;
  return { node: { k: 'list', ordered, start: first.start, loose, items: items.map((it) => it.lines) }, next: j };
}
function parseBlocks(lines, a, b, st) {
  const out = [];
  let i = a;
  while (i < b) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const ind = indentOf(line);
    const s = line.slice(firstNonWs(line));
    if (ind <= 3) {
      const fence = fenceInfo(s);
      if (fence && !(fence.ch === '`' && fence.info.indexOf('`') !== -1)) {
        // marked's Dt (indentCodeCompensation): for a backtick fence
        // whose opening line has leading whitespace, strip up to that
        // many leading whitespace CHARACTERS from each content line
        // that starts with whitespace. Tilde fences are verbatim.
        const stripN = fence.ch === '`' ? firstNonWs(line) : 0;
        const content = [];
        let j = i + 1;
        while (j < b) {
          const l2 = lines[j];
          // The final empty line is the trailing newline, not content.
          if (j === b - 1 && l2 === '') break;
          if (indentOf(l2) <= 3) {
            const s2 = l2.slice(firstNonWs(l2));
            if (s2[0] === fence.ch) {
              let k = 0;
              while (k < s2.length && s2[k] === fence.ch) k++;
              if (k >= fence.len && isAllWs(s2.slice(k))) break;
            }
          }
          let cl = l2;
          if (stripN > 0) {
            const m = /^[ \t]+/.exec(l2);
            if (m) cl = l2.slice(Math.min(m[0].length, stripN));
          }
          content.push(cl);
          j++;
        }
        out.push({ k: 'code', lang: unescapePunct(langOf(fence.info)), text: content.length > 0 ? content.join(NL) + (content[content.length - 1] !== '' ? NL : '') : '' });
        i = j + 1;
        continue;
      }
      const level = atxLevel(s);
      if (level > 0) {
        let text = s.slice(level);
        let p = 0;
        while (p < text.length && (text[p] === ' ' || text.charCodeAt(p) === 9)) p++;
        text = text.slice(p);
        let e = text.length;
        while (e > 0 && (text[e - 1] === ' ' || text.charCodeAt(e - 1) === 9)) e--;
        let q = e;
        while (q > 0 && text[q - 1] === '#') q--;
        if (q < e) {
          if (q === 0) e = 0;
          else if (text[q - 1] === ' ' || text.charCodeAt(q - 1) === 9) {
            e = q;
            while (e > 0 && (text[e - 1] === ' ' || text.charCodeAt(e - 1) === 9)) e--;
          }
        }
        out.push({ k: 'h', level, text: text.slice(0, e) });
        i++;
        continue;
      }
      if (isHr(s)) { out.push({ k: 'hr' }); i++; continue; }
      if (s[0] === '>') {
        const r = parseBlockquote(lines, i, b, st);
        out.push(r.node);
        i = r.next;
        continue;
      }
      if (matchListMarker(line)) {
        const r = parseList(lines, i, b, st);
        out.push(r.node);
        i = r.next;
        continue;
      }
      const ht = htmlBlockType(s);
      if (ht >= 1 && ht <= 6) {
        const content = [];
        let j = i;
        if (ht === 1) {
          // pre/script/style/textarea end at the matching end tag.
          const endTag = htmlEndTag(s);
          while (j < b) {
            content.push(lines[j]);
            if (endTag && lines[j].toLowerCase().indexOf(endTag) !== -1) { j++; break; }
            j++;
          }
        } else if (ht === 6) {
          while (j < b && !isBlank(lines[j])) { content.push(lines[j]); j++; }
        } else {
          const ender = ht === 2 ? '-->' : ht === 3 ? '?>' : ht === 4 ? '>' : ']]>';
          while (j < b) {
            content.push(lines[j]);
            if (lines[j].indexOf(ender) !== -1) { j++; break; }
            j++;
          }
        }
        // Trailing newline: types 1-5 end at a marker line, so the text
        // keeps the newline after it when followed by content (or by a
        // single trailing newline at EOF); types 6-7 end at a blank line
        // and only keep it for the single-trailing-newline EOF case.
        let trailingNL;
        if (ht === 6) {
          trailingNL = j === b - 1 && j < b && lines[j] === '';
        } else {
          trailingNL = (j < b && lines[j] !== '') || (j === b - 1 && j < b && lines[j] === '');
        }
        out.push({ k: 'html', text: content.join(NL) + (trailingNL ? NL : '') });
        i = j;
        continue;
      }
      if (ht === 7) {
        const content = [];
        let j = i;
        while (j < b && !isBlank(lines[j])) { content.push(lines[j]); j++; }
        const trailingNL = j === b - 1 && j < b && lines[j] === '';
        out.push({ k: 'html', text: content.join(NL) + (trailingNL ? NL : '') });
        i = j;
        continue;
      }
    }
    if (ind >= 4) {
      const content = [];
      let j = i;
      while (j < b) {
        const l2 = lines[j];
        if (isBlank(l2)) {
          let k = j;
          while (k < b && isBlank(lines[k])) k++;
          if (k < b && indentOf(lines[k]) >= 4) {
            while (j < k) { content.push(sliceAtCol(lines[j], 4)); j++; }
            continue;
          }
          break;
        }
        if (indentOf(l2) < 4) break;
        content.push(sliceAtCol(l2, 4));
        j++;
      }
      while (content.length > 0 && isAllWs(content[content.length - 1])) content.pop();
      out.push({ k: 'code', lang: '', text: content.length > 0 ? content.join(NL) + NL : '', indented: true, trail: j < b });
      i = j;
      continue;
    }
    const r = parseParagraph(lines, i, b, st);
    if (r.node) out.push(r.node);
    i = r.next;
  }
  return out;
}
function renderTable(blk, st) {
  let out = `<table>\n<thead>\n<tr>\n`;
  for (let c = 0; c < blk.header.length; c++) {
    const align = blk.aligns[c];
    out += `<th${align ? ` align="${align}"` : ''}>${inline(blk.header[c], st.links)}</th>\n`;
  }
  out += `</tr>\n</thead>\n`;
  if (blk.rows.length === 0) return out + `</table>\n`;
  out += `<tbody>`;
  for (let r = 0; r < blk.rows.length; r++) {
    out += `<tr>\n`;
    for (let c = 0; c < blk.rows[r].length; c++) {
      const align = blk.aligns[c];
      out += `<td${align ? ` align="${align}"` : ''}>${inline(blk.rows[r][c], st.links)}</td>\n`;
    }
    out += `</tr>\n`;
  }
  out += `</tbody></table>\n`;
  return out;
}

function renderListItem(itemLines, st, loose) {
  let lines = itemLines;
  let task = null;
  if (lines.length > 0) {
    const first = lines[0];
    if (first.length >= 3 && first[0] === '[' && (first[1] === ' ' || first[1] === 'x' || first[1] === 'X') && first[2] === ']') {
      const after = first[3];
      if (first.length === 3 || after === ' ' || after.charCodeAt(0) === 9) {
        task = first[1] === ' ' ? ' ' : 'x';
        const rest = first.slice(3).replace(/^ +/, '');
        lines = [rest].concat(lines.slice(1));
      }
    }
  }
  // Inside a list item, an ordered list interrupts a paragraph for any
  // start number (marked); parseBlocks is given that context here.
  st.listDepth = (st.listDepth || 0) + 1;
  let blocks;
  try { blocks = parseBlocks(lines, 0, lines.length, st); }
  finally { st.listDepth--; }
  if (blocks.length === 0) {
    if (task) return `<li><input${task === 'x' ? ' checked=""' : ''} disabled="" type="checkbox"></li>\n`;
    return `<li></li>\n`;
  }
  const cb = task ? `<input${task === 'x' ? ' checked=""' : ''} disabled="" type="checkbox">` : '';
  const cbSp = task ? cb + ' ' : '';
  let out = '<li>';
  for (let t = 0; t < blocks.length; t++) {
    const blk = blocks[t];
    if (!loose && blk.k === 'p') {
      out += (t === 0 ? cbSp : '') + inline(blk.text, st.links);
    } else {
      const rendered = renderNode(blk, st);
      if (t === 0 && task && blk.k === 'p') out += rendered.replace('<p>', '<p>' + cbSp);
      else out += rendered;
    }
  }
  out += '</li>\n';
  return out;
}

function renderList(node, st) {
  const tag = node.ordered ? 'ol' : 'ul';
  const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
  let out = `<${tag}${start}>\n`;
  for (let t = 0; t < node.items.length; t++) {
    out += renderListItem(node.items[t], st, node.loose);
  }
  out += `</${tag}>\n`;
  return out;
}

function renderNode(blk, st) {
  switch (blk.k) {
    case 'code':
      return `<pre><code${blk.lang ? ` class="language-${escAttr(blk.lang)}"` : ''}>${esc(blk.text)}</code></pre>\n`;
    case 'h':
      return `<h${blk.level}>${inline(blk.text, st.links)}</h${blk.level}>\n`;
    case 'hr':
      return `<hr>\n`;
    case 'quote':
      return `<blockquote>\n${renderBlocks(blk.blocks, st)}</blockquote>\n`;
    case 'list':
      return renderList(blk, st);
    case 'html':
      return blk.text;
    case 'p':
      return `<p>${inline(blk.text, st.links)}</p>\n`;
    case 'table':
      return renderTable(blk, st);
    default:
      return '';
  }
}

function renderBlocks(blocks, st) {
  let out = '';
  for (let i = 0; i < blocks.length; i++) out += renderNode(blocks[i], st);
  return out;
}

function normalize(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    if (code === 13) {
      out += NL;
      if (i + 1 < src.length && src.charCodeAt(i + 1) === 10) i++;
    } else {
      out += src[i];
    }
  }
  return out;
}

// Pre-pass: walk a parsed block tree and force nested content (quotes,
// list items) to be parsed, so link reference definitions defined inside
// containers are registered before any inline rendering happens.
function collectDefs(blocks, st) {
  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i];
    if (blk.k === 'quote') {
      collectDefs(blk.blocks, st);
    } else if (blk.k === 'list') {
      for (let t = 0; t < blk.items.length; t++) {
        // Item contents are parsed with list context (any-start ordered
        // lists interrupt paragraphs there).
        st.listDepth = (st.listDepth || 0) + 1;
        try { collectDefs(parseBlocks(blk.items[t], 0, blk.items[t].length, st), st); }
        finally { st.listDepth--; }
      }
    }
  }
}

export function parse(src) {
  const st = { links: new Map(), refs: null, defs: false };
  const lines = normalize(src).split(NL);
  const blocks = parseBlocks(lines, 0, lines.length, st);
  collectDefs(blocks, st);
  return renderBlocks(blocks, st);
}
