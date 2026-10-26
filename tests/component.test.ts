import { describe, expect, it } from "vitest";

import { componentCalls, replaceAstroProps, topLevelImports, usesAstroProps, wrapFrontmatter } from "../src/component";
import { buildScriptModule, parseAstroSfc } from "../src/parse-astro-sfc";

async function module(source: string, filePath = "/p/Button.astro"): Promise<string> {
  return buildScriptModule(await parseAstroSfc(source), filePath);
}

describe("topLevelImports", () => {
  it("finds where the code starts and which imports are components", () => {
    const code = `// c\nimport A from "a";\nimport type T from "t";\nimport B, { x } from 'b'\n/* k */ import * as C from "c";\nimport "side";\nimport {\n  d,\n} from "d";\nimport J from "j.json" with { type: "json" };\nconst x = 1;`;
    const imports = topLevelImports(code)!;
    expect(imports.components).toEqual(["A", "B", "J"]);
    expect(code.slice(imports.bodyStart)).toBe("const x = 1;");
  });

  it("treats a call or a property of import as code, not as an import", () => {
    const code = `import A from "a";\nconst m = await import("m");`;
    expect(code.slice(topLevelImports(code)!.bodyStart)).toBe(`const m = await import("m");`);
    expect(topLevelImports(`import.meta.env;`)!.bodyStart).toBe(0);
  });

  it("does not take a name that only starts with import for a late import", () => {
    const code = `import A from "a";\nconst x = 1;\nimportant = 2;\nimports.push(1);`;
    expect(topLevelImports(code)).not.toBeNull();
    // a real import written without a space still counts
    expect(topLevelImports(`const x = 1;\nimport{ b } from "b";`)).toBeNull();
    expect(topLevelImports(`const x = 1;\nimport"side-effect";`)).toBeNull();
    expect(topLevelImports(`const x = 1;\nimport * as b from "b";`)).toBeNull();
  });

  it("copes with nothing but comments, a string with an escaped quote and an unterminated comment", () => {
    expect(topLevelImports("// only\n")!.bodyStart).toBe(8);
    expect(topLevelImports("// only")!.bodyStart).toBe(7);
    expect(topLevelImports("/* open")!.bodyStart).toBe(7);
    expect(topLevelImports(`import A from "a\\"b";\nx;`)!.components).toEqual(["A"]);
    expect(topLevelImports(`import A from "a`)!.components).toEqual(["A"]);
    expect(topLevelImports("")!.bodyStart).toBe(0);
  });

  it("gives up when an import comes after code, or has no module name", () => {
    expect(topLevelImports(`const a = 1;\nimport b from "b";`)).toBeNull();
    expect(topLevelImports(`import { a }`)).toBeNull();
  });
});

describe("wrapFrontmatter", () => {
  const wrap = (code: string, file = "/p/Button.astro"): ReturnType<typeof wrapFrontmatter> => wrapFrontmatter(code, topLevelImports(code)!, file);

  it("puts the statements in a function of the props, on the line they were", () => {
    expect(wrap(`import x from "x";\n\nconst { track } = Astro.props;\nx(track);`)?.code).toBe(
      `import x from "x";\n\nfunction Button(__astroProps: any) {const { track } = __astroProps;\nx(track);`,
    );
  });

  it("reads every Astro.props through the parameter and is async when it awaits", () => {
    const wrapped = wrap(`const a = Astro.props.a;\nconst b = await load(Astro.props);`)!;
    expect(wrapped.code).toBe(`async function Button(__astroProps: any) {const a = __astroProps.a;\nconst b = await load(__astroProps);`);
    expect(wrapped.name).toBe("Button");
  });

  it("strips the export of a type and leaves a value export to the old scan", () => {
    expect(wrap(`export interface Props { a: string }\nexport type Q = 1;\nconst { a } = Astro.props;`)?.code).toBe(
      `function Button(__astroProps: any) {interface Props { a: string }\ntype Q = 1;\nconst { a } = __astroProps;`,
    );
    expect(wrap(`export const prerender = true;\nAstro.props;`)).toBeNull();
    expect(wrap(`export function getStaticPaths() {}\nAstro.props;`)).toBeNull();
  });

  it("names the function after the file and keeps the name clear of the frontmatter's", () => {
    expect(wrap("Astro.props;", "/p/my-card.astro")?.name).toBe("MyCard");
    expect(wrap("Astro.props;", "/p/[slug].astro")?.name).toBe("Slug");
    expect(wrap("Astro.props;", "/p/.astro")?.name).toBe("AstroComponent");
    expect(wrap("Astro.props;", "/p/1.astro")?.name).toBe("AstroComponent");
    expect(wrap("Astro.props; Button();", "/p/Button.astro")?.name).toBe("ButtonComponent");
    expect(wrap("Astro.props; MyButton();", "/p/Button.astro")?.name).toBe("Button");
    expect(wrap("Astro.props; X();", "/p/$x.astro")?.name).toBe("XComponent");
  });
});

describe("replaceAstroProps / usesAstroProps", () => {
  it("matches the whole name only", () => {
    expect(replaceAstroProps("Astro.props.a + MyAstro.props + Astro.propsX")).toBe("__astroProps.a + MyAstro.props + Astro.propsX");
    expect(usesAstroProps("const { a } = Astro.props;")).toBe(true);
    expect(usesAstroProps("Astro.url")).toBe(false);
  });
});

describe("componentCalls", () => {
  it("calls only the tags that are imported components, with their props", () => {
    const calls = componentCalls(
      [
        { tag: "Button", props: [{ name: "track", kind: "literal", value: 'a"b' }, { name: "data-x", kind: "expression", value: "x" }] },
        { tag: "Other", props: [{ name: "a", kind: "literal", value: "1" }] },
      ],
      ["Button"],
      (code) => code.toUpperCase(),
    );
    expect(calls).toEqual(['  Button({ track: "a\\"b", "data-x": (X\n) });']);
  });
});

describe("parseAstroSfc component usages", () => {
  it("reads quoted, expression and shorthand props of a component and nothing else", async () => {
    const parsed = await parseAstroSfc(`---\nimport B from "./b.astro";\n---\n<div a="1"><B track="x" label={y} {t} flag dyn=\`a\${b}\` {...rest} /><B /><my-el a="1" />{ok && <B track={z} />}</div>`);
    expect(parsed.componentUsages).toEqual([
      { tag: "B", props: [{ name: "track", kind: "literal", value: "x" }, { name: "label", kind: "expression", value: "y" }, { name: "t", kind: "expression", value: "t" }] },
      { tag: "B", props: [{ name: "track", kind: "expression", value: "z" }] },
    ]);
  });

  it("skips an expression prop with no code in it", async () => {
    expect((await parseAstroSfc(`<B a={ } />`)).componentUsages).toEqual([]);
  });
});

describe("buildScriptModule with props", () => {
  it("exports the component as a function of its props, with the template inside it", async () => {
    const text = await module(`---\nconst { track } = Astro.props;\n---\n<button onclick={() => go(track)} event={Astro.props.name}>{Astro.props.label}</button>`);
    expect(text).toBe(
      [
        "",
        "function Button(__astroProps: any) {const { track } = __astroProps;",
        "// --- astro template (auto-generated) ---",
        "  (() => go(track)",
        "  );",
        "  (__astroProps.label",
        "  );",
        "  __eventra_astro_template_event__(__astroProps.name);",
        "// --- end template ---",
        "}",
        "export default Button;",
        "",
        "declare function __eventra_astro_template_event__(name: string): void;",
        "",
      ].join("\n"),
    );
  });

  it("closes the function when the template has nothing in it", async () => {
    expect(await module(`---\nconst p = Astro.props;\n---\n<div />`)).toBe("\nfunction Button(__astroProps: any) {const p = __astroProps;\n}\nexport default Button;\n");
  });

  it("wraps a component whose only use of the props is in the template", async () => {
    const text = await module(`<b onclick={() => go(Astro.props.t)} />`);
    expect(text).toContain("function Button(__astroProps: any) {");
    expect(text).toContain("go(__astroProps.t)");
  });

  it("turns a use of an imported component into a call with its props", async () => {
    const text = await module(`---\nimport Card from "./Card.astro";\nconst { t } = Astro.props;\n---\n<Card id="a" label={Astro.props.l} {t} />`);
    expect(text).toContain('  Card({ id: "a", label: (__astroProps.l\n), t: (t\n) });');
    expect(text).toContain("export default Button;");
  });

  it("is scanned as before when the component does not read Astro.props", async () => {
    const text = await module(`---\nimport Card from "./Card.astro";\nconst a = 1;\n---\n<Card id={a} /><b event={a} />`);
    expect(text).toContain("function __eventraAstroTemplate() {");
    expect(text).toContain("  Card({ id: (a\n) });");
    expect(text).not.toContain("export default");
  });

  it("is scanned as before when the frontmatter is written in a way that is not followed", async () => {
    const text = await module(`---\nexport const prerender = true;\nconst { a } = Astro.props;\n---\n<b event={Astro.props.a} />`);
    expect(text).toContain("function __eventraAstroTemplate() {");
    expect(text).toContain("__eventra_astro_template_event__(Astro.props.a);");
    expect(text).not.toContain("export default");
  });

  it("is scanned as before when an import follows other code", async () => {
    const text = await module(`---\nconst a = 1;\nimport B from "./b.astro";\n---\n<B id={Astro.props.x} />`);
    expect(text).not.toContain("export default");
    expect(text).not.toContain("B({");
  });
});

describe("topLevelImports: where an import ends and what is one", () => {
  const rest = (code: string): string => code.slice(topLevelImports(code)!.bodyStart);

  it("ends a string at its closing quote, past an escaped one", () => {
    expect(rest(`import A from "a\\"b";\nx;`)).toBe("x;");
    expect(rest(`import A from 'a\\'b';\nx;`)).toBe("x;");
    expect(rest(`import A from "a\\\\";\nx;`)).toBe("x;");
  });

  it("skips a block comment that starts with /*/", () => {
    expect(rest(`/*/ c */\nimport A from "a";\nx;`)).toBe("x;");
  });

  it("takes an import attribute clause with or without a space", () => {
    expect(rest(`import J from "j.json" with{ type: "json" };\nx;`)).toBe("x;");
    expect(rest(`import J from "j.json" assert { type: "json" }\nx;`)).toBe("x;");
  });

  it("only reads an import at the start of a statement", () => {
    expect(topLevelImports(`;import a from "a";\nconst b = 1;`)).toEqual({ bodyStart: 0, components: [] });
  });

  it("takes the default name from the start of the statement, with any space after import", () => {
    expect(topLevelImports(`import {a} from "import b from";\nx;`)!.components).toEqual([]);
    expect(topLevelImports(`import   Foo   from "x";\nx;`)!.components).toEqual(["Foo"]);
    expect(topLevelImports(`import type Foo from "x";\nx;`)!.components).toEqual([]);
  });

  it("gives up on a later import in any spelling, and only at the start of a line", () => {
    expect(topLevelImports(`const x = 1;\nimport{a} from "a";`)).toBeNull();
    expect(topLevelImports(`const x = 1;\n  import * as a from "a";`)).toBeNull();
    expect(topLevelImports(`const x = 1;\nimport"side";`)).toBeNull();
    expect(topLevelImports(`const s = "do import a";`)).not.toBeNull();
    expect(topLevelImports(`bar.import ab;`)).not.toBeNull();
    expect(topLevelImports(`const x = 1;\nimport.meta.url;`)).not.toBeNull();
  });
});

describe("wrapFrontmatter: exports, names and escapes", () => {
  const wrap = (code: string, file = "/p/Button.astro"): ReturnType<typeof wrapFrontmatter> => wrapFrontmatter(code, topLevelImports(code)!, file);

  it("drops the export of a type with its indentation kept, in any spacing", () => {
    expect(wrap("Astro.props;\n  export type A = 1;")?.code).toBe("function Button(__astroProps: any) {__astroProps;\n  type A = 1;");
    expect(wrap("Astro.props;\nexport  interface B {}")?.code).toBe("function Button(__astroProps: any) {__astroProps;\ninterface B {}");
  });

  it("leaves what only mentions export alone", () => {
    expect(wrap("Astro.props;\n// export type A\nconst s = 'export type';")?.code).toContain("// export type A\nconst s = 'export type';");
    expect(wrap("obj.export = 1;\nAstro.props;")).not.toBeNull();
  });

  it("gives up on an export of anything but a type, indented or not", () => {
    expect(wrap("Astro.props;\nexport const a = 1;")).toBeNull();
    expect(wrap("Astro.props;\n  export const a = 1;")).toBeNull();
  });

  it("names the component after its file", () => {
    const name = (file: string): string | undefined => wrap("Astro.props;", file)?.name;
    expect(name("/p/Foo.astroBar.astro")).toBe("FooAstroBar");
    expect(name("/p/a-_b.astro")).toBe("AB");
    expect(name("/p/1abc.astro")).toBe("AstroComponent");
    expect(name("/p/_a.astro")).toBe("_a");
  });
});

describe("componentCalls: escapes", () => {
  it("escapes a backslash and a quote in a literal, in that order", () => {
    expect(componentCalls([{ tag: "B", props: [{ name: "a", kind: "literal", value: 'x\\y"z' }] }], ["B"], (c) => c)).toEqual(['  B({ a: "x\\\\y\\"z" });']);
  });
});
