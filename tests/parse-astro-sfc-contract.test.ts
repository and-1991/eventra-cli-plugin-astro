import { describe, expect, it } from "vitest";

import {
  buildClientScriptModule,
  buildScriptModule,
  clientScriptVirtualPath,
  parseAstroSfc,
  scriptVirtualPath,
  type ParsedAstroSfc,
} from "../src/parse-astro-sfc";

// Exact-output tests: what each construct becomes, field by field, and the exact virtual module text.

const CALLEE = "__eventra_astro_template_event__";

const eventsOf = async (markup: string) => (await parseAstroSfc(markup)).templateEvents;
const codeOf = async (markup: string) => (await parseAstroSfc(markup)).templateCode;

describe("event attributes", () => {
  it("trims a literal event name, and drops an empty one or a boolean attribute", async () => {
    expect(await eventsOf(`<a event="  signup  ">x</a>`)).toEqual([{ kind: "literal", value: "signup" }]);
    expect(await eventsOf(`<a event="   ">x</a><a event="">y</a><a event>z</a>`)).toEqual([]);
  });

  it("trims a dynamic event expression, and drops an empty one", async () => {
    expect(await eventsOf(`<a event={  name  }>x</a>`)).toEqual([{ kind: "dynamic", value: "name" }]);
    expect(await eventsOf(`<a event={ }>x</a>`)).toEqual([]);
  });

  it("reads the shorthand {event} as the expression event", async () => {
    expect(await eventsOf(`<a {event}>x</a>`)).toEqual([{ kind: "dynamic", value: "event" }]);
  });

  it("skips a template-literal value, which is neither one literal nor one expression", async () => {
    expect(await eventsOf("<a event=`a-${b}`>x</a>")).toEqual([]);
  });

  it("does not take other attributes for an event", async () => {
    expect(await eventsOf(`<a name="x" data-event="y" events="z" eventx={w}>x</a>`)).toEqual([]);
  });

  it("finds events on elements, components and custom elements", async () => {
    expect(await eventsOf(`<a event="el">x</a><Card event="comp" /><my-el event="custom"></my-el>`)).toEqual([
      { kind: "literal", value: "el" },
      { kind: "literal", value: "comp" },
      { kind: "literal", value: "custom" },
    ]);
  });
});

describe("template code", () => {
  it("trims an attribute expression, and keeps the event attribute out of it", async () => {
    expect(await codeOf(`<a class={  cls()  } event={  e  }>x</a>`)).toEqual(["cls()"]);
  });

  it("trims the expression of a spread", async () => {
    expect(await codeOf(`<a {...  props()  }>x</a>`)).toEqual(["props()"]);
  });

  it("trims an {expr} that holds only text, and drops an empty one", async () => {
    expect(await codeOf(`<p>{  a + b  }</p><p>{ }</p><p>{}</p>`)).toEqual(["a + b"]);
  });

  it("drops an attribute expression that is empty", async () => {
    expect(await codeOf(`<a data-x={ }>x</a><a title={}>y</a>`)).toEqual([]);
  });

  it("does not take an {expr} that also holds markup for code, but reads the {} inside it", async () => {
    expect(await codeOf(`<ul>{items.map((i) => <li>{i.name}</li>)}</ul>`)).toEqual(["i.name"]);
  });

  it("does not take quoted attributes for code", async () => {
    expect(await codeOf(`<a class="x" title='y' hidden>z</a>`)).toEqual([]);
  });

  it("keeps the order of the document", async () => {
    expect(await codeOf(`<a class={one()}>{two()}<b {...three()}>{four()}</b></a>`)).toEqual(["one()", "two()", "three()", "four()"]);
  });
});

describe("frontmatter and positions", () => {
  it("has no script when there is no frontmatter, or it is blank", async () => {
    expect(await parseAstroSfc(`<p>x</p>`)).toMatchObject({ script: null, scriptStartLine: undefined });
    expect(await parseAstroSfc(`---\n\n---\n<p>x</p>`)).toMatchObject({ script: null, scriptStartLine: undefined });
  });

  it("gives the trimmed frontmatter and the line of its first non-blank character", async () => {
    expect(await parseAstroSfc(`---\n\n  const a = 1;\n---\n<p>x</p>`)).toMatchObject({ script: "const a = 1;", scriptStartLine: 3 });
    expect(await parseAstroSfc(`---\nconst a = 1;\n---\n`)).toMatchObject({ scriptStartLine: 2 });
  });
});

describe("client scripts", () => {
  const scriptsOf = async (markup: string) => (await parseAstroSfc(markup)).clientScripts;

  it("reads each <script> as a module of its own, trimmed, with its first line", async () => {
    expect(await scriptsOf(`<p>x</p>\n<script>\n\n  track("a");\n</script>\n<script>track("b");</script>`)).toEqual([
      { content: 'track("a");', startLine: 4 },
      { content: 'track("b");', startLine: 6 },
    ]);
  });

  it.each(["module", "text/javascript", "application/javascript", " Module ", "TEXT/JavaScript"])("reads a script of type %j", async (type) => {
    expect(await scriptsOf(`<script type="${type}">x();</script>`)).toHaveLength(1);
  });

  it.each(["application/ld+json", "importmap", "text/typescript", "application/json"])("skips a script of type %s, which holds data", async (type) => {
    expect(await scriptsOf(`<script type="${type}">{}</script>`)).toEqual([]);
  });

  it("finds the type attribute wherever it sits among the attributes", async () => {
    expect(await scriptsOf(`<script defer type="module">x();</script>`)).toHaveLength(1);
    expect(await scriptsOf(`<script defer type="application/ld+json">{}</script>`)).toEqual([]);
  });

  it("skips an empty script", async () => {
    expect(await scriptsOf(`<script></script><script>   </script>`)).toEqual([]);
  });

  it("does not look inside a script for template code or events", async () => {
    const parsed = await parseAstroSfc(`<script>const a = {b: 1}; "<a event='x'>"</script>`);
    expect(parsed.templateEvents).toEqual([]);
    expect(parsed.templateCode).toEqual([]);
  });
});

describe("errors", () => {
  it("is empty for a hint-level diagnostic, which is not an error", async () => {
    expect((await parseAstroSfc(`<script defer type="module">x();</script>`)).errors).toEqual([]);
  });

  it("is empty for a clean file", async () => {
    expect((await parseAstroSfc(`---\nconst a = 1;\n---\n<p>{a}</p>`)).errors).toEqual([]);
  });
});

describe("virtual paths", () => {
  it("adds .ts after the final .astro only", () => {
    expect(scriptVirtualPath("/p/Card.astro")).toBe("/p/Card.astro.ts");
    expect(scriptVirtualPath("/p/Card.ASTRO")).toBe("/p/Card.astro.ts");
    expect(scriptVirtualPath("/pkg.astro/kit.astro-ui/Card.astro")).toBe("/pkg.astro/kit.astro-ui/Card.astro.ts");
    expect(scriptVirtualPath("/p/Card.astro.ts")).toBe("/p/Card.astro.ts");
  });

  it("numbers client scripts from 1, replacing only the final .astro", () => {
    expect(clientScriptVirtualPath("/p/Card.astro", 0)).toBe("/p/Card.astro.client1.ts");
    expect(clientScriptVirtualPath("/p/Card.astro", 2)).toBe("/p/Card.astro.client3.ts");
    expect(clientScriptVirtualPath("/pkg.astro/Card.ASTRO", 1)).toBe("/pkg.astro/Card.astro.client2.ts");
    expect(clientScriptVirtualPath("/p/Card.astro.ts", 0)).toBe("/p/Card.astro.ts");
  });
});

describe("modules: exact text", () => {
  const parsed = (over: Partial<ParsedAstroSfc> = {}): ParsedAstroSfc => ({
    script: null,
    scriptStartLine: undefined,
    templateEvents: [],
    templateCode: [],
    clientScripts: [],
    errors: [],
    ...over,
  });

  it("is an export stub with a newline when there is nothing", () => {
    expect(buildScriptModule(parsed())).toBe("export {}\n");
  });

  it("puts the template function after the frontmatter, separated by one blank line, with exact lines", () => {
    const text = buildScriptModule(
      parsed({
        script: "const a = 1;",
        scriptStartLine: 1,
        templateEvents: [{ kind: "literal", value: "signup" }, { kind: "dynamic", value: "name" }],
        templateCode: ["go()"],
      }),
    );
    expect(text).toBe(
      [
        "const a = 1;",
        "",
        "// --- astro template (auto-generated) ---",
        `declare function ${CALLEE}(name: string): void;`,
        "function __eventraAstroTemplate() {",
        "  (go()",
        "  );",
        `  ${CALLEE}("signup");`,
        `  ${CALLEE}(name);`,
        "}",
        "",
      ].join("\n"),
    );
  });

  it("keeps the frontmatter on its original line", () => {
    expect(buildScriptModule(parsed({ script: "const a = 1;", scriptStartLine: 3 }))).toBe("\n\nconst a = 1;\n");
  });

  it("emits the template function for code alone, and for events alone", () => {
    expect(buildScriptModule(parsed({ templateCode: ["x"] }))).toContain("function __eventraAstroTemplate() {");
    expect(buildScriptModule(parsed({ templateEvents: [{ kind: "literal", value: "e" }] }))).toContain("function __eventraAstroTemplate() {");
  });

  it("escapes backslashes and double quotes in a literal event name, in that order", () => {
    const line = (value: string) =>
      buildScriptModule(parsed({ templateEvents: [{ kind: "literal", value }] }))
        .split("\n")
        .find((l) => l.startsWith(`  ${CALLEE}(`));
    expect(line(String.raw`a\b`)).toBe(`  ${CALLEE}("a\\\\b");`);
    expect(line('say "hi"')).toBe(`  ${CALLEE}("say \\"hi\\"");`);
    expect(line(String.raw`a\"b`)).toBe(`  ${CALLEE}("a\\\\\\"b");`);
  });

  it("builds a client script as its own module, on its original line, ending in an export", () => {
    expect(buildClientScriptModule({ content: "track(1);", startLine: 4 })).toBe("\n\n\ntrack(1);\nexport {}\n");
    expect(buildClientScriptModule({ content: "track(1);" })).toBe("track(1);\nexport {}\n");
  });
});
