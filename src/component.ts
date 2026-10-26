import path from "node:path";

/** A prop passed to a child component in the template: `track="x"` (literal), `track={expr}` / `{track}` (expression). */
export interface TemplateComponentProp {
  readonly name: string;
  readonly kind: "literal" | "expression";
  readonly value: string;
}

/** A component tag with the props written on it. Whether it is an imported component depends on the frontmatter. */
export interface TemplateComponentUsage {
  readonly tag: string;
  readonly props: readonly TemplateComponentProp[];
}

export interface ComponentModule {
  /** The frontmatter with a function header in front of its statements; the closing `}` is the caller's. */
  readonly code: string;
  /** The function's name, which the module exports as its default after the closing brace. */
  readonly name: string;
}

/** What the function takes as its one parameter: the props object, which `Astro.props` reads in the component. */
export const PROPS_PARAMETER = "__astroProps";

const ASTRO_PROPS = /\bAstro\.props\b/g;

/** `Astro.props` in code that now sits inside a function of the props. */
export function replaceAstroProps(code: string): string {
  return code.replace(ASTRO_PROPS, PROPS_PARAMETER);
}

export function usesAstroProps(code: string): boolean {
  return /\bAstro\.props\b/.test(code);
}

// what is left of a file name once everything that is not a word character is dropped
const STARTS_AN_IDENTIFIER = /^[A-Za-z_]/;

/** First index at or after `from` that is not whitespace or inside a comment. */
function skipTrivia(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (/\s/.test(text.charAt(i))) i++;
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      return i;
    }
  }
}

/** End of the string literal that starts at `from` (its opening quote). */
function skipString(text: string, from: number): number {
  const quote = text[from];
  let i = from + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

interface Imports {
  /** Where the first statement that is not an import starts. */
  readonly bodyStart: number;
  /** Local names of default imports (`import Button from "./Button.astro"`): the components a template can use. */
  readonly components: readonly string[];
}

const IMPORT_START = /^import(?=[\s{*"'])/;
const DEFAULT_IMPORT = /^import\s+(?!type\b)([A-Za-z_$][\w$]*)\s*(?:,|from\b)/;

/**
 * The imports at the top of the frontmatter, which have to stay outside the function. Null when an
 * import comes after other code, which is legal but not followed here.
 */
export function topLevelImports(code: string): Imports | null {
  const components: string[] = [];
  let i = skipTrivia(code, 0);
  while (IMPORT_START.test(code.slice(i, i + 8))) {
    const quote = code.slice(i).search(/["']/);
    if (quote === -1) return null;
    let end = skipString(code, i + quote);
    // an optional `with { type: "json" }` clause is part of the statement, and so is the `;`
    // every part of the pattern is optional, so it always matches, and at the start
    end += /\s*(?:(?:with|assert)\s*\{[^}]*\})?\s*;?/.exec(code.slice(end))![0].length;
    const name = DEFAULT_IMPORT.exec(code.slice(i, end))?.[1];
    if (name) components.push(name);
    i = skipTrivia(code, end);
  }
  if (/^[ \t]*import(?:\s+[\w{*"']|[{*"'])/m.test(code.slice(i))) return null;
  return { bodyStart: i, components };
}

/** `Button.astro` -> `Button`: the name the component is reported under. */
function componentName(filePath: string, code: string): string {
  const base = path.basename(filePath).replace(/\.astro$/i, "");
  const name = base.replace(/(?:^|[^A-Za-z0-9]+)(\w)/g, (_, letter: string) => letter.toUpperCase()).replace(/\W/g, "");
  const valid = STARTS_AN_IDENTIFIER.test(name) ? name : "AstroComponent";
  // a name the frontmatter already uses stays clear of it
  return new RegExp(`(?<![\\w$])${valid}(?![\\w$])`).test(code) ? `${valid}Component` : valid;
}

/**
 * Turns a frontmatter that reads `Astro.props` into the body of a function of the props, so the code
 * the compiler already understands (a parameter flowing into a track() call) applies to a component:
 *
 *   const { track } = Astro.props;   ->   function Button(__astroProps) { const { track } = __astroProps;
 *   const props = Astro.props;       ->   function Button(__astroProps) { const props = __astroProps;
 *
 * Every `Astro.props` becomes the parameter, the imports stay above the function, and statements keep
 * their line numbers (the header sits on the line of the first statement). Returns null when the
 * frontmatter does not read `Astro.props`, or is written in a way this does not follow (`export`s other
 * than types, imports after other code), in which case the component is scanned as before.
 */
export function wrapFrontmatter(code: string, imports: Imports, filePath: string): ComponentModule | null {
  const head = code.slice(0, imports.bodyStart);
  let body = code.slice(imports.bodyStart);
  body = body.replace(/^([ \t]*)export\s+(?=(?:interface|type)\s)/gm, "$1");
  if (/^[ \t]*export\b/m.test(body)) return null;

  const name = componentName(filePath, code);
  const header = `${/\bawait\b/.test(body) ? "async " : ""}function ${name}(${PROPS_PARAMETER}: any) {`;
  return { code: `${head}${header}${replaceAstroProps(body)}`, name };
}

const KEY = /^[A-Za-z_$][\w$]*$/;

const escapeString = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * A use of an imported component in the template is a call of that component with its props object:
 * `<Button track="x" label={text} />` is `Button({ track: "x", label: (text) })`.
 */
export function componentCalls(usages: readonly TemplateComponentUsage[], components: readonly string[], rewrite: (code: string) => string): string[] {
  const calls: string[] = [];
  for (const usage of usages) {
    if (!components.includes(usage.tag)) continue;
    const props = usage.props.map((prop) => {
      const key = KEY.test(prop.name) ? prop.name : `"${escapeString(prop.name)}"`;
      return `${key}: ${prop.kind === "literal" ? `"${escapeString(prop.value)}"` : `(${rewrite(prop.value)}\n)`}`;
    });
    calls.push(`  ${usage.tag}({ ${props.join(", ")} });`);
  }
  return calls;
}
