/**
 * The Astro compiler (a Go program compiled to WebAssembly) serializes the tree
 * with repeated string concatenation, so time and memory grow with the square of
 * the number of siblings under one parent and with the nesting depth. Past a
 * limit it runs out of its 2 GB heap and the whole Go runtime dies, which also
 * takes down any parse running next to it. It cannot be caught safely, so a
 * template that would get there is detected up front and never handed over.
 *
 * Measured with @astrojs/compiler 2.13 and 4.0: 1300 siblings parse in about 2 s,
 * 1600 run out of memory; a nesting depth of 1000 is fine, 3000 is not. The
 * limits keep a wide margin below that.
 */
export const MAX_SIBLINGS = 700;
export const MAX_DEPTH = 1000;
/**
 * The serialization cost of one parent is about (children) x (bytes of everything inside it), because each
 * child is appended to a string that holds all the ones before it. 1300 `<Card ... />` (71 KB) still parse
 * in under 3 s, 1600 of them (88 KB) run out of memory, and 500 table rows of 30 cells (450 KB, only 500
 * children) too: the siblings limit alone does not see that, this one does.
 */
export const MAX_COST = 60_000_000;

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

// NOTE: HTML lets you leave out the end tag of `<li>`, `<td>` and the like, but the Astro compiler does not close them:
// `<li>a<li>b` becomes two NESTED elements (600 unclosed `<li>` parse to a tree 602 levels deep, measured). So an
// unclosed element is counted as nesting, here as in the compiler.

/**
 * Most attributes one tag may have. The compiler's cost grows with the square of them: 4000 bare attributes took
 * 2.5 s and 1.4 GB, 8000 ran out of memory, and a run of unclosed `<script x ` (each one read as attributes of the
 * first tag) did the same with half as many. 1000 parse in well under a second.
 */
export const MAX_ATTRIBUTES = 1000;

/** Most elements one page may hold: 27,000 spans in three levels took 11 s and 4.4 GB, 7,200 nodes about 2 s. */
export const MAX_ELEMENTS = 8000;

export interface TemplateShape {
  readonly maxSiblings: number;
  readonly maxDepth: number;
  readonly maxCost: number;
  readonly elements: number;
  /** The most attributes (words between a tag's name and its `>`) of any one tag. */
  readonly maxAttributes: number;
  /** A tag that is never closed (`<div class="a`): the compiler's handling of that is not predictable. */
  readonly unterminated: boolean;
}

/** Where the markup starts: after the frontmatter, whose `Array<string>` is TypeScript, not a tag. */
function markupStart(source: string): number {
  const fence = /^(\s*)---[ \t]*\r?\n/.exec(source);
  if (!fence) return 0;
  const rest = source.slice(fence[0].length);
  const close = /(^|\n)---[ \t]*(\r?\n|$)/.exec(rest);
  return close ? fence[0].length + close.index + close[0].length : 0;
}

/** One linear pass over the markup that estimates the widest parent, the deepest nesting and the cost. Never throws. */
export function measureTemplate(source: string): TemplateShape {
  const counts: number[] = [0];
  const names: string[] = [""];
  const contentStarts: number[] = [0];
  let maxSiblings = 0;
  let maxDepth = 0;
  let maxCost = 0;
  let elements = 0;
  let maxAttributes = 0;
  let unterminated = false;
  const n = source.length;
  const closers = new Map<string, RegExp>();

  const add = () => {
    const level = counts.length - 1;
    const next = ++counts[level];
    if (next > maxSiblings) maxSiblings = next;
  };
  // an element ends at `end`: its children times everything inside it is what the compiler pays
  const close = (end: number) => {
    const children = counts.pop()!;
    names.pop();
    const start = contentStarts.pop()!;
    // each child is appended to a string that holds the ones before it, and a parent holds all its descendants:
    // the page pays for every element, so the costs add up instead of the worst one standing alone
    maxCost += Math.max(1, children) * Math.max(0, end - start);
  };

  let i = markupStart(source);
  contentStarts[0] = i;
  while (i < n) {
    const ch = source[i];
    if (ch === "{") {
      add();
      i++;
      continue;
    }
    if (ch !== "<") {
      i++;
      continue;
    }
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const tagStart = i;
    const closing = source[i + 1] === "/";
    const nameStart = closing ? i + 2 : i + 1;
    const match = /^[A-Za-z][\w:.-]*/.exec(source.slice(nameStart, nameStart + 64));
    if (!match) {
      i++;
      continue;
    }
    const name = match[0].toLowerCase();
    // read to the end of the tag; `>` inside quotes or an `{expression}` does not end it
    let j = nameStart + match[0].length;
    let quote = "";
    let braces = 0;
    let attributes = 0;
    let inWord = false;
    for (; j < n; j++) {
      const c = source[j];
      // a word starts after white space, outside quotes and braces (a quoted value or an {expression} is part of it)
      if (!quote && braces === 0) {
        const space = c === " " || c === "\n" || c === "\t" || c === "\r";
        if (!space && !inWord && c !== ">") attributes++;
        inWord = !space;
      }
      if (quote) {
        if (c === quote) quote = "";
      } else if (braces > 0) {
        if (c === "{") braces++;
        else if (c === "}") braces--;
        else if (c === '"' || c === "'" || c === "`") quote = c;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{") braces++;
      else if (c === ">") break;
    }
    if (attributes > maxAttributes) maxAttributes = attributes;
    if (j >= n) {
      unterminated = true;
      break;
    }
    const selfClosing = source[j - 1] === "/";
    i = j + 1;

    if (closing) {
      // An end tag closes the element that is open. One for something else (`</ul>` while a `<li>` is still open
      // inside it) is not honoured by the compiler: the elements stay open and everything after nests deeper
      // (150 such lists parse 753 levels deep), so it closes nothing here either.
      if (names.length > 1 && names[names.length - 1] === name) close(tagStart);
      continue;
    }
    add();
    elements++;
    if (selfClosing || VOID_ELEMENTS.has(name)) continue;
    if (name === "script" || name === "style") {
      // the body is code or CSS, not markup: `a < b` is not a tag
      let finder = closers.get(name);
      if (!finder) {
        finder = new RegExp(`</${name}`, "gi");
        closers.set(name, finder);
      }
      finder.lastIndex = i;
      const found = finder.exec(source);
      const end = found ? source.indexOf(">", found.index) : -1;
      i = end === -1 ? n : end + 1;
      continue;
    }
    counts.push(0);
    names.push(name);
    contentStarts.push(i);
    if (counts.length - 1 > maxDepth) maxDepth = counts.length - 1;
  }
  // what is still open at the end ends there; the page itself is a parent too
  while (counts.length > 1) close(n);
  maxCost += Math.max(1, counts[0]) * Math.max(0, n - contentStarts[0]);

  return { maxSiblings, maxDepth, maxCost, elements, maxAttributes, unterminated };
}

/** The reason this template is too large for the compiler, or `null` when it is safe to parse. */
export function templateLimitReason(source: string): string | null {
  const { maxSiblings, maxDepth, maxCost, elements, maxAttributes, unterminated } = measureTemplate(source);
  if (maxSiblings > MAX_SIBLINGS) {
    return `a parent element holds about ${maxSiblings} children (limit ${MAX_SIBLINGS})`;
  }
  if (maxDepth > MAX_DEPTH) {
    return `the markup is nested about ${maxDepth} levels deep (limit ${MAX_DEPTH})`;
  }
  if (maxAttributes > MAX_ATTRIBUTES) {
    return `a tag has about ${maxAttributes} attributes (limit ${MAX_ATTRIBUTES})`;
  }
  if (elements > MAX_ELEMENTS) {
    return `the page has about ${elements} elements (limit ${MAX_ELEMENTS})`;
  }
  if (maxCost > MAX_COST) {
    return "the markup is too large for the compiler (a parent element with that many children and that much inside)";
  }
  if (unterminated) {
    return "a tag in the markup is never closed";
  }
  return null;
}

/**
 * The same text with everything except the frontmatter and the `<script>`
 * elements blanked out. Newlines are kept, so every line number stays valid.
 */
export function withoutTemplate(source: string, keepScripts = true): string {
  const keep: Array<[number, number]> = [];
  const fence = /^(\s*)---[ \t]*\r?\n/.exec(source);
  let from = 0;
  if (fence) {
    const rest = source.slice(fence[0].length);
    const close = /(^|\n)---[ \t]*(\r?\n|$)/.exec(rest);
    if (close) {
      from = fence[0].length + close.index + close[0].length;
      keep.push([0, from]);
    }
  }
  // Found step by step, not with one lazy regex: `<script\b[^>]*>[\s\S]*?<\/script\s*>` scans to the end of the
  // file from every `<script` that is never closed, which is quadratic (40k of them took 4 s). Once there is no `>`
  // or no `</script` left after one, there is none after any later one either, so the search stops there.
  if (keepScripts) {
    const open = /<script\b/gi;
    const close = /<\/script\s*>/gi;
    open.lastIndex = from;
    for (let m = open.exec(source); m; m = open.exec(source)) {
      const tagEnd = source.indexOf(">", m.index);
      if (tagEnd === -1) break;
      close.lastIndex = tagEnd + 1;
      const end = close.exec(source);
      if (!end) break;
      keep.push([m.index, end.index + end[0].length]);
      open.lastIndex = end.index + end[0].length;
    }
  }

  let out = "";
  let pos = 0;
  for (const [start, end] of keep) {
    out += source.slice(pos, start).replace(/[^\r\n]/g, "");
    out += source.slice(start, end);
    pos = end;
  }
  return out + source.slice(pos).replace(/[^\r\n]/g, "");
}
