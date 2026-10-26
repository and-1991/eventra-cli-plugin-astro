import { parse } from "@astrojs/compiler";
import {
  componentCalls,
  replaceAstroProps,
  topLevelImports,
  usesAstroProps,
  wrapFrontmatter,
} from "./component";
import type { TemplateComponentProp, TemplateComponentUsage } from "./component";
import { firstContentLine, placeBlocks } from "./layout";

export type { TemplateComponentProp, TemplateComponentUsage } from "./component";

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
  /** Every component tag in the template with the props written on it, for the ones that turn out to be imported. */
  readonly componentUsages?: readonly TemplateComponentUsage[];
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
    } else if (attribute.kind === "quoted") {
      // `event="literal"`; the boolean shorthand `event` has kind "empty" and no name to extract.
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

/** `track="x"`, `track={expr}` and `{track}` are props; a spread, a boolean attribute and a template literal are not followed. */
function componentProps(attributes: readonly AstroAttributeNode[]): TemplateComponentProp[] {
  const props: TemplateComponentProp[] = [];
  for (const attribute of attributes) {
    if (attribute.kind === "quoted") props.push({ name: attribute.name, kind: "literal", value: attribute.value });
    else if (attribute.kind === "expression" && attribute.value.trim()) props.push({ name: attribute.name, kind: "expression", value: attribute.value.trim() });
    else if (attribute.kind === "shorthand") props.push({ name: attribute.name, kind: "expression", value: attribute.name });
  }
  return props;
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
  const componentUsages: TemplateComponentUsage[] = [];

  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
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
        // an empty `{ }` is dropped with the other empty expressions at the end
        templateCode.push(children.map((child) => child.value).join("").trim());
      }
    }
    if (record.type === "component" && Array.isArray(record.attributes)) {
      const props = componentProps(record.attributes as AstroAttributeNode[]);
      if (props.length > 0) componentUsages.push({ tag: record.name as string, props });
    }
    if (Array.isArray(record.attributes)) {
      collectFromAttributes(record.attributes as AstroAttributeNode[], templateEvents, templateCode);
    }
    for (const key of Object.keys(record)) {
      visit(record[key]);
    }
  }

  visit(result.ast);

  return { script, scriptStartLine, templateEvents, templateCode: templateCode.filter(Boolean), clientScripts, componentUsages, errors };
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
 *
 * A component that reads `Astro.props` is also exported as a function of them, and every use of it in
 * another template becomes a call of that function. The prop that reaches a tracking call is then
 * found by what the component does with it, whatever the prop is called.
 */
export function buildScriptModule(parsed: ParsedAstroSfc, filePath = ""): string {
  const imports = parsed.script ? topLevelImports(parsed.script) : { bodyStart: 0, components: [] };
  const readsProps = usesAstroProps([parsed.script ?? "", ...parsed.templateCode].join("\n"));
  const wrapped = readsProps && imports ? wrapFrontmatter(parsed.script ?? "", imports, filePath) : null;
  // outside a component function `Astro.props` stays as written, as it always was
  const rewrite = wrapped ? replaceAstroProps : (code: string): string => code;

  // the frontmatter keeps its original line numbers
  const frontmatter = wrapped?.code ?? parsed.script;
  const parts: string[] = [
    frontmatter ? placeBlocks([{ content: frontmatter, startLine: parsed.scriptStartLine }]) : "export {}",
  ];

  const usages = componentCalls(parsed.componentUsages ?? [], imports?.components ?? [], rewrite);
  if (parsed.templateEvents.length > 0 || parsed.templateCode.length > 0 || usages.length > 0) {
    const marker = "// --- astro template (auto-generated) ---";
    const declaration = `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`;
    const body = [
      // template expressions go through the same detection as frontmatter code; the closing paren
      // sits on its own line, so a trailing `// comment` cannot swallow it
      ...parsed.templateCode.map((expression) => `  (${rewrite(expression)}\n  );`),
      ...usages,
      ...parsed.templateEvents.map((binding) =>
        binding.kind === "literal"
          ? `  ${TEMPLATE_EVENT_CALLEE}("${escapeString(binding.value)}");`
          : `  ${TEMPLATE_EVENT_CALLEE}(${rewrite(binding.value)});`,
      ),
    ];
    if (wrapped) {
      // inside the component function, where its props and frontmatter variables are in scope
      parts[0] = `${parts[0]}\n${[marker, ...body].join("\n")}\n// --- end template ---\n}\nexport default ${wrapped.name};`;
      parts.push(declaration);
    } else {
      parts.push([marker, declaration, "function __eventraAstroTemplate() {", ...body, "}"].join("\n"));
    }
  } else if (wrapped) {
    parts[0] = `${parts[0]}\n}\nexport default ${wrapped.name};`;
  }

  return `${parts.join("\n\n")}\n`;
}

function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
