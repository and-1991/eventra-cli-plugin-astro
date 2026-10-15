import { parse } from "@astrojs/compiler";
import { firstContentLine, placeBlocks } from "./layout";

/** A single `event="..."` binding found on a tag in the template. */
export interface TemplateEventBinding {
  /** `literal`: the event name is a string constant. `dynamic`: a raw JS/TS expression, copied verbatim. */
  readonly kind: "literal" | "dynamic";
  readonly value: string;
}

/** A `<script>` element of the template: client-side TypeScript with its own imports and scope. */
export interface ClientScript {
  readonly content: string;
  /** 1-based line of the script's first character in the .astro file. */
  readonly startLine?: number;
}

export interface ParsedAstroSfc {
  /** Raw frontmatter (`--- ... ---`) content, or `null` when the file has none. */
  readonly script: string | null;
  /** 1-based line of the frontmatter's first character in the .astro file. */
  readonly scriptStartLine?: number;
  readonly templateEvents: readonly TemplateEventBinding[];
  /**
   * Raw JS of the template's own expressions, copied verbatim: `{expr}` interpolations that hold only
   * code, and attribute values written as `attr={expr}` / `{...spread}`. A call to a tracking function
   * in there is an event the component fires.
   */
  readonly templateCode: readonly string[];
  /** The template's `<script>` elements, each a module of its own. */
  readonly clientScripts: readonly ClientScript[];
  readonly errors: readonly string[];
}

// `@astrojs/compiler`'s DiagnosticSeverity enum (Error = 1, Warning = 2, ...)
// is documented in its shared type defs but not re-exported at runtime from
// the package's public entrypoint, so the value is inlined here.
const DIAGNOSTIC_SEVERITY_ERROR = 1;

interface AstroAttributeNode {
  readonly type: string;
  readonly kind: string;
  readonly name: string;
  readonly value: string;
}

/**
 * Every attribute-bearing template node (`element`, `component`,
 * `custom-element`, `fragment`) carries an `attributes` array, regardless of
 * its `type` — duck-typing on that shape (rather than an explicit list of
 * node type names) means new tag kinds a future Astro version adds are
 * picked up automatically.
 */
function collectFromAttributes(
  attributes: readonly AstroAttributeNode[],
  out: TemplateEventBinding[],
  code: string[],
): void {
  for (const attribute of attributes) {
    // `onclick={() => track("x")}`, `class={cls()}`: plain JS
    if (attribute.type === "attribute" && attribute.name !== "event" && attribute.kind === "expression") {
      code.push(attribute.value.trim());
      continue;
    }
    // `{...props()}`: the compiler hands the expression back as the attribute's name, with no value
    if (attribute.type === "attribute" && attribute.kind === "spread") {
      code.push(attribute.name.trim());
      continue;
    }
    if (attribute.type !== "attribute" || attribute.name !== "event") continue;

    if (attribute.kind === "expression") {
      // `event={expr}` — the compiler already hands back the raw JS source
      // text of the expression as `value`.
      const dynamic = attribute.value.trim();
      if (dynamic) {
        out.push({ kind: "dynamic", value: dynamic });
      }
    } else if (attribute.kind === "shorthand") {
      // JSX shorthand `{event}` is sugar for `event={event}` — the compiler
      // leaves `value` empty for this kind, so the expression is the name.
      out.push({ kind: "dynamic", value: attribute.name });
    } else if (attribute.kind === "quoted" || attribute.kind === "empty") {
      // `event="literal"` or the boolean-shorthand `event` (empty kind, no
      // event name to extract).
      const literal = attribute.value.trim();
      if (literal) {
        out.push({ kind: "literal", value: literal });
      }
    }
    // "template-literal" (`` event=`a-${b}` ``) mixes text and expressions —
    // not a single literal or single expression, so it's unsupported and
    // silently skipped, same as an interpolated attribute in the Vue/Svelte
    // plugins.
  }
}

// a script that is not JavaScript (`application/ld+json`, an importmap) holds data, not calls
const JS_SCRIPT_TYPES = new Set(["module", "text/javascript", "application/javascript"]);

function clientScript(element: Record<string, unknown>): ClientScript | null {
  // an element node always carries its (possibly empty) attributes array
  const attributes = element.attributes as readonly AstroAttributeNode[];
  const type = attributes.find((attribute) => attribute.name === "type")?.value.trim().toLowerCase();
  if (type !== undefined && !JS_SCRIPT_TYPES.has(type)) return null;

  const text = (element.children as readonly { type: string; value: string; position?: { start?: { line?: number } } }[] | undefined)?.find(
    (child) => child.type === "text",
  );
  const content = text?.value.trim();
  if (!text || !content) return null;
  const start = text.position?.start?.line;
  // `position: true` always sets it; kept defensive so an unexpected AST shape only loses line numbers
  /* v8 ignore next */
  return { content, startLine: typeof start === "number" ? firstContentLine(text.value, start) : undefined };
}

/** Parse an Astro component via the real `@astrojs/compiler` parser (handles comments, JSX expressions, malformed markup, etc). */
export async function parseAstroSfc(source: string): Promise<ParsedAstroSfc> {
  const result = await parse(source, { position: true });

  const errors = result.diagnostics
    .filter((diagnostic) => diagnostic.severity === DIAGNOSTIC_SEVERITY_ERROR)
    .map((diagnostic) => diagnostic.text);

  let script: string | null = null;
  let scriptStartLine: number | undefined;
  const templateEvents: TemplateEventBinding[] = [];
  const templateCode: string[] = [];
  const clientScripts: ClientScript[] = [];

  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    const record = node as Record<string, unknown>;
    if (record.type === "frontmatter") {
      const raw = record.value as string;
      const content = raw.trim();
      if (content) {
        script = content;
        // the node starts at the opening `---`; its text begins on that same line
        const start = (record.position as { start?: { line?: number } } | undefined)?.start?.line;
        // `parse(..., { position: true })` always sets it; kept defensive so an
        // unexpected AST shape only loses line numbers instead of failing the scan
        /* v8 ignore else */
        if (typeof start === "number") scriptStartLine = firstContentLine(raw, start);
      }
      return;
    }
    if (record.type === "element" && record.name === "script") {
      const script = clientScript(record);
      if (script) clientScripts.push(script);
      return;
    }
    // `{expr}`: when it holds only text it is plain code; one that also holds markup
    // (`{items.map((i) => <li>...</li>)}`) is JSX, which is not code here, but the `{}` inside it are visited
    if (record.type === "expression") {
      const children = record.children as readonly { type: string; value?: string }[] | undefined;
      if (children?.length && children.every((child) => child.type === "text")) {
        const expression = children.map((child) => child.value).join("").trim();
        if (expression) templateCode.push(expression);
      }
    }
    if (Array.isArray(record.attributes)) {
      collectFromAttributes(record.attributes as AstroAttributeNode[], templateEvents, templateCode);
    }
    for (const key of Object.keys(record)) {
      visit(record[key]);
    }
  }

  visit(result.ast);

  return { script, scriptStartLine, templateEvents, templateCode: templateCode.filter(Boolean), clientScripts, errors };
}

/** Map `Card.astro` → `Card.astro.ts` (single virtual TS module for the compiler). */
export function scriptVirtualPath(astroPath: string): string {
  return astroPath.replace(/\.astro$/i, ".astro.ts");
}

/** Map `Card.astro` → `Card.astro.client1.ts`, `Card.astro.client2.ts`, ... (one module per `<script>`). */
export function clientScriptVirtualPath(astroPath: string, index: number): string {
  return astroPath.replace(/\.astro$/i, `.astro.client${index + 1}.ts`);
}

/** A `<script>` as a module of its own: it has its own imports, so it must not share a scope with the frontmatter. */
export function buildClientScriptModule(script: ClientScript): string {
  return `${placeBlocks([script])}\nexport {}\n`;
}

const TEMPLATE_EVENT_CALLEE = "__eventra_astro_template_event__";

/**
 * Build one virtual TS module from the parsed component: frontmatter
 * content (Astro's frontmatter is TypeScript already — no `lang=`/`@ts-nocheck`
 * distinction needed), followed by a function wrapping synthetic calls for
 * every template `event="..."` binding. Because everything shares one module
 * scope, a dynamic binding (`event={expr}`) that references a real
 * frontmatter identifier resolves through the same checker-based pipeline as
 * any other TS expression; anything that doesn't resolve (e.g. a
 * `.map()` callback parameter) is correctly reported as a dynamic occurrence
 * rather than silently dropped.
 */
export function buildScriptModule(parsed: ParsedAstroSfc): string {
  // the frontmatter keeps its original line numbers
  const parts: string[] = [
    parsed.script ? placeBlocks([{ content: parsed.script, startLine: parsed.scriptStartLine }]) : "export {}",
  ];

  if (parsed.templateEvents.length > 0 || parsed.templateCode.length > 0) {
    const lines = [
      "// --- astro template (auto-generated) ---",
      `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`,
      "function __eventraAstroTemplate() {",
      // template expressions go through the same detection as frontmatter code; the closing paren
      // sits on its own line, so a trailing `// comment` cannot swallow it
      ...parsed.templateCode.map((expression) => `  (${expression}\n  );`),
      ...parsed.templateEvents.map((binding) =>
        binding.kind === "literal"
          ? `  ${TEMPLATE_EVENT_CALLEE}("${escapeString(binding.value)}");`
          : `  ${TEMPLATE_EVENT_CALLEE}(${binding.value});`,
      ),
      "}",
    ];
    parts.push(lines.join("\n"));
  }

  return `${parts.join("\n\n")}\n`;
}

function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
