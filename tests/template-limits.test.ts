import { describe, expect, it, vi } from "vitest";

import { MAX_COST, MAX_DEPTH, MAX_ELEMENTS, MAX_SIBLINGS, measureTemplate, templateLimitReason, withoutTemplate } from "../src/complexity";
import { buildScriptModule, parseAstroSfc } from "../src/parse-astro-sfc";
import { transformAstroSfc } from "../src/transform";

const FRONT = `---
import { Eventra } from "@eventra_dev/eventra-sdk";
const sdk = new Eventra({ apiKey: "k" });
sdk.track("page.viewed");
---
`;
const lineOf = (text: string, needle: string): number =>
  text.split("\n").findIndex((l) => l.includes(needle)) + 1;

const wide = (n: number) => `${FRONT}<ul>\n${Array.from({ length: n }, (_, i) => `<li>item ${i}</li>`).join("\n")}\n</ul>\n`;

describe("measureTemplate", () => {
  it("counts the widest parent, not the whole page", () => {
    const nested = Array.from({ length: 50 }, () => "<div><p>a</p><p>b</p></div>").join("");
    expect(measureTemplate(nested).maxSiblings).toBe(50);
    expect(measureTemplate("<ul><li/><li/><li/></ul>").maxSiblings).toBe(3);
  });

  it("treats void and self-closing tags as leaves", () => {
    expect(measureTemplate("<div><br><img src='a'><Card/><input></div>").maxDepth).toBe(1);
  });

  it("ignores `>` inside quotes and expressions and `<` inside scripts and comments", () => {
    const shape = measureTemplate(
      `<!-- <a><a><a> --><button onclick={() => a > b} title="x > y">go</button><script>if (a < b) { x = "<i>"; }</script>`,
    );
    expect(shape.maxDepth).toBe(1);
    expect(shape.maxSiblings).toBe(2);
  });

  it("measures nesting depth", () => {
    expect(measureTemplate("<div>".repeat(30) + "</div>".repeat(30)).maxDepth).toBe(30);
  });

  it("never throws on broken markup", () => {
    for (const bad of ["<", "<div", "<div attr=\"", "{{{", "</", "<<<>>>", "<!--", "<script>", "</div></div></div>"]) {
      expect(() => measureTemplate(bad)).not.toThrow();
    }
  });
});

describe("templateLimitReason", () => {
  it("accepts a page at the limit and refuses one past it", () => {
    expect(templateLimitReason(wide(MAX_SIBLINGS - 5))).toBeNull();
    expect(templateLimitReason(wide(MAX_SIBLINGS + 200))).toMatch(/children/);
    expect(templateLimitReason("<div>".repeat(MAX_DEPTH + 50))).toMatch(/nested/);
  });
});

describe("withoutTemplate", () => {
  it("keeps frontmatter and scripts on their original lines and blanks the rest", () => {
    const source = `${FRONT}<h1>Hello</h1>\n<script>\n  track("from.client");\n</script>\n<p>tail</p>\n`;
    const reduced = withoutTemplate(source);
    expect(reduced).not.toContain("Hello");
    expect(reduced).not.toContain("tail");
    expect(reduced.split("\n").length).toBe(source.split("\n").length);
    expect(lineOf(reduced, 'track("from.client")')).toBe(lineOf(source, 'track("from.client")'));
    expect(lineOf(reduced, 'sdk.track("page.viewed")')).toBe(lineOf(source, 'sdk.track("page.viewed")'));
  });

  it("treats an unclosed frontmatter fence as no frontmatter", () => {
    expect(withoutTemplate("---\nfoo();\n<p>a</p>\n")).toBe("\n\n\n");
  });

  it("works without frontmatter", () => {
    expect(withoutTemplate("<p>a</p>\n<script>x()</script>")).toBe("\n<script>x()</script>");
  });
});

describe("a template too large for the Astro compiler", () => {
  it("is parsed without its template instead of crashing the compiler", async () => {
    const source = wide(3000);
    const started = Date.now();
    const parsed = await parseAstroSfc(source);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(parsed.templateSkipped).toMatch(/children/);
    expect(parsed.script).toContain('sdk.track("page.viewed")');
    expect(buildScriptModule(parsed)).toContain('sdk.track("page.viewed")');
  });

  it("is parsed without its template when it is nested very deeply", async () => {
    const parsed = await parseAstroSfc(`${FRONT}${"<div>".repeat(3000)}x${"</div>".repeat(3000)}`);
    expect(parsed.templateSkipped).toMatch(/nested/);
    expect(parsed.script).toContain("page.viewed");
  });

  it("still reads the client <script> blocks", async () => {
    const parsed = await parseAstroSfc(`${wide(2500)}<script>\n  window.track("client.event");\n</script>\n`);
    expect(parsed.templateSkipped).toBeDefined();
    expect(parsed.clientScripts.map((s) => s.content)).toEqual(['window.track("client.event");']);
  });

  it("keeps working afterwards, also for parses started at the same time", async () => {
    const results = await Promise.all([
      parseAstroSfc(wide(3000)),
      parseAstroSfc(`${FRONT}<button event="buy">Buy</button>`),
      parseAstroSfc(wide(2600)),
      parseAstroSfc(`${FRONT}<button event="sell">Sell</button>`),
    ]);
    expect(results[0].templateSkipped).toBeDefined();
    expect(results[1].templateEvents).toEqual([{ kind: "literal", value: "buy" }]);
    expect(results[2].templateSkipped).toBeDefined();
    expect(results[3].templateEvents).toEqual([{ kind: "literal", value: "sell" }]);
  });

  it("transform tells the host CLI the file was read only in part, and still returns the modules", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const out = await transformAstroSfc({ path: "src/pages/big.astro", source: wide(3000) });
      expect(out.modules.length).toBeGreaterThan(0);
      expect(out.modules[0].content).toContain("page.viewed");
      expect(out.partial).toHaveLength(1);
      expect(out.partial![0]).toContain("template events were not scanned");
      expect(out.partial![0]).toContain("children");
      // the host CLI prints it with the file's name: the plugin itself prints nothing
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reports nothing partial for a normal page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await transformAstroSfc({ path: "a.astro", source: wide(20) })).partial).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("what the siblings limit alone does not see", () => {
  const table = (rows: number, cells: number) =>
    `<table><tbody>${Array.from({ length: rows }, (_, r) => `<tr>${Array.from({ length: cells }, (_, c) => `<td class="cell">r${r}c${c}</td>`).join("")}</tr>`).join("\n")}</tbody></table>`;

  it("a big table: few children, a lot of elements", () => {
    expect(measureTemplate(table(500, 30)).maxSiblings).toBeLessThan(MAX_SIBLINGS);
    expect(templateLimitReason(table(500, 30))).toMatch(/elements/);
    expect(measureTemplate(table(500, 30)).elements).toBeGreaterThan(MAX_ELEMENTS);
  });

  it("few children but a lot of text inside each: the cost is what is refused", () => {
    const heavy = `<div>${Array.from({ length: 600 }, (_, i) => `<p>${"word ".repeat(400)}${i}</p>`).join("")}</div>`;
    expect(measureTemplate(heavy).maxSiblings).toBeLessThan(MAX_SIBLINGS);
    expect(measureTemplate(heavy).elements).toBeLessThan(MAX_ELEMENTS);
    expect(templateLimitReason(heavy)).toMatch(/too large for the compiler/);
  });

  it("a page of 700 nested lists, which the compiler could not parse in 4 GB, is refused", () => {
    const page = `<ul>${Array.from({ length: 699 }, (_, i) => `<li>N${i}<ul><li>a<li>b<li>c<li>d</ul>`).join("\n")}</ul>`;
    expect(templateLimitReason(page)).not.toBeNull();
  });

  it("an ordinary table is fine", () => {
    expect(templateLimitReason(table(30, 8))).toBeNull();
  });

  it("a tag that is never closed is refused, not guessed at", () => {
    expect(templateLimitReason('<div class="a')).toMatch(/never closed/);
    expect(templateLimitReason("<div>" + '<span class="b'.repeat(50))).toMatch(/never closed/);
  });

  it("an end tag left out is nesting, as the compiler reads it (600 unclosed <li> parse 602 levels deep)", () => {
    expect(measureTemplate("<ul>" + "<li>item".repeat(450) + "</ul>").maxDepth).toBe(451);
    expect(measureTemplate("<table><tr><td>a<td>b<tr><td>c</table>").maxDepth).toBe(6);
    // a few hundred unclosed items are fine for the compiler (flat 600 took half a second)
    expect(templateLimitReason("<ul>" + "<li>item".repeat(450) + "</ul>")).toBeNull();
    expect(templateLimitReason("<ul>" + "<li>item".repeat(1200) + "</ul>")).toMatch(/nested/);
  });

  it("an end tag for something that is not the open element closes nothing, as in the compiler", () => {
    expect(measureTemplate("</div><p>a</p></span>").maxDepth).toBe(1);
    expect(measureTemplate("<div><p><b>x</div>y<i>z</i>").maxDepth).toBe(4);
    expect(measureTemplate("<ul><li>a<li>b</ul><ul><li>c</ul>").maxDepth).toBe(5);
  });

  it("an unclosed element counts up to the end of the page, and the markup of the frontmatter is not markup", () => {
    expect(measureTemplate("<div><p>text").maxDepth).toBe(2);
    expect(measureTemplate(`---\nconst a: Array<string> = []; const b = a.map((x): Map<string, string> => new Map());\n---\n<p>x</p>`).maxDepth).toBe(1);
  });

  it("a thousand small <script> tags are many siblings, and then the fallback keeps only the frontmatter", async () => {
    const source = `${FRONT}${Array.from({ length: 900 }, (_, i) => `<script>window.t${i} = 1;</script>`).join("\n")}`;
    expect(templateLimitReason(source)).toMatch(/children/);
    const parsed = await parseAstroSfc(source);
    expect(parsed.templateSkipped).toBeDefined();
    expect(parsed.script).toContain("page.viewed");
    expect(parsed.clientScripts).toEqual([]);
  });

  it("many script and style tags are measured in linear time", () => {
    const source = Array.from({ length: 6000 }, (_, i) => `<style>.a${i}{}</style><script>var a${i} = 1 < 2;</script>`).join("");
    const started = Date.now();
    measureTemplate(source);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("withoutTemplate can drop the scripts too", () => {
    expect(withoutTemplate(`${FRONT}<script>x()</script>`, false)).not.toContain("x()");
    expect(withoutTemplate(`${FRONT}<script>x()</script>`, false)).toContain("page.viewed");
  });
});

describe("what the partial message says was read", () => {
  it("the frontmatter and the scripts when the scripts were kept, only the frontmatter when they were dropped too", async () => {
    const kept = await transformAstroSfc({ path: "a.astro", source: `${FRONT}${"<p>x</p>".repeat(900)}<script>x()</script>` });
    expect(kept.partial![0]).toContain("the frontmatter and <script> blocks were");
    const dropped = await transformAstroSfc({ path: "b.astro", source: `${FRONT}${Array.from({ length: 900 }, (_, i) => `<script>window.t${i} = 1;</script>`).join("\n")}` });
    expect(dropped.partial![0]).toContain("only the frontmatter was");
    expect(dropped.partial![0]).not.toContain("<script> blocks were");
  });
});
