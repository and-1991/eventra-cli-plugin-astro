import { parse } from "@astrojs/compiler";

/** A single `event="..."` binding found on a tag in the template. */
export interface TemplateEventBinding {
  /** `literal`: the event name is a string constant. `dynamic`: a raw JS/TS expression, copied verbatim. */
  readonly kind: "literal" | "dynamic";
  readonly value: string;
}

export interface ParsedAstroSfc {
  /** Raw frontmatter (`--- ... ---`) content, or `null` when the file has none. */
  readonly script: string | null;
  readonly templateEvents: readonly TemplateEventBinding[];
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
function collectFromAttributes(attributes: readonly AstroAttributeNode[], out: TemplateEventBinding[]): void {
  for (const attribute of attributes) {
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

/** Parse an Astro component via the real `@astrojs/compiler` parser (handles comments, JSX expressions, malformed markup, etc). */
export async function parseAstroSfc(source: string): Promise<ParsedAstroSfc> {
  const result = await parse(source, { position: true });

  const errors = result.diagnostics
    .filter((diagnostic) => diagnostic.severity === DIAGNOSTIC_SEVERITY_ERROR)
    .map((diagnostic) => diagnostic.text);

  let script: string | null = null;
  const templateEvents: TemplateEventBinding[] = [];

  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    const record = node as Record<string, unknown>;
    if (record.type === "frontmatter") {
      const content = (record.value as string).trim();
      if (content) script = content;
      return;
    }
    if (Array.isArray(record.attributes)) {
      collectFromAttributes(record.attributes as AstroAttributeNode[], templateEvents);
    }
    for (const key of Object.keys(record)) {
      visit(record[key]);
    }
  }

  visit(result.ast);

  return { script, templateEvents, errors };
}

/** Map `Card.astro` → `Card.astro.ts` (single virtual TS module for the compiler). */
export function scriptVirtualPath(astroPath: string): string {
  return astroPath.replace(/\.astro$/i, ".astro.ts");
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
  const parts: string[] = [parsed.script ? ["// --- astro frontmatter ---", parsed.script].join("\n") : "export {}"];

  if (parsed.templateEvents.length > 0) {
    const lines = [
      "// --- astro template (auto-generated) ---",
      `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`,
      "function __eventraAstroTemplate() {",
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
