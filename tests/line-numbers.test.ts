import { describe, expect, it } from "vitest";

import { firstContentLine, placeBlocks } from "../src/layout";
import { buildScriptModule, parseAstroSfc } from "../src/parse-astro-sfc";

const lineOf = (text: string, needle: string): number =>
  text.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("astro script module keeps original line numbers", () => {
  it("puts every frontmatter line on the line it has in the .astro file", async () => {
    const source = `---
import { Eventra } from "@eventra_dev/eventra-sdk";
const name = "x";
const sdk = new Eventra({ apiKey: "k" });
sdk.track(name);
---
<button event={name}>Pay</button>
`;
    const module = buildScriptModule(await parseAstroSfc(source));

    for (const needle of ["import { Eventra }", 'const name = "x"', "sdk.track(name)"]) {
      expect(lineOf(module, needle)).toBe(lineOf(source, needle));
    }
  });

  it("works when the frontmatter does not start on line 1", async () => {
    const source = "\n\n---\nfoo();\n---\n<p>hi</p>\n";
    const module = buildScriptModule(await parseAstroSfc(source));

    expect(lineOf(module, "foo()")).toBe(lineOf(source, "foo()"));
  });

  it("emits an empty module when there is no frontmatter", async () => {
    const module = buildScriptModule(await parseAstroSfc("<p>hi</p>\n"));

    expect(module.startsWith("export {}")).toBe(true);
  });
});

describe("placeBlocks", () => {
  it("separates blocks by a blank line when a line is unknown", () => {
    expect(placeBlocks([{ content: "a();" }, { content: "b();" }])).toBe("a();\n\nb();");
  });

  it("keeps the directive on line 1 and starts an unplaced block right below it", () => {
    expect(placeBlocks([{ content: "a();" }], "// @ts-nocheck")).toBe("// @ts-nocheck\na();");
  });

  it("never moves a later block above the end of the previous one", () => {
    const out = placeBlocks([{ content: "a();\nb();", startLine: 1 }, { content: "c();", startLine: 1 }]);

    expect(out).toBe("a();\nb();\nc();");
  });

  it("counts the leading blank lines of a block", () => {
    expect(firstContentLine("\n\n  x", 3)).toBe(5);
    expect(firstContentLine("x", 3)).toBe(3);
  });
});
