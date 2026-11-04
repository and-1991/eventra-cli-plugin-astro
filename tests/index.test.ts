import { describe, expect, it } from "vitest";

import { transformAstroSfc } from "../src/transform";

describe("transformAstroSfc", () => {
  it("returns a single virtual module for a file with no errors and no events", async () => {
    const result = await transformAstroSfc({ path: "/project/Plain.astro", source: "<div>hi</div>" });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.path).toBe("/project/Plain.astro.ts");
  });

  it("throws (rather than silently returning an empty module) when the Astro parser reports an error", async () => {
    await expect(
      transformAstroSfc({ path: "/project/Broken.astro", source: "---\n/* unterminated\n---\n<div />" }),
    ).rejects.toThrow(/Failed to parse Astro component .*Broken\.astro/);
  });
});

describe("transformAstroSfc define:vars scripts", () => {
  it("reads a define:vars script in the frontmatter's scope instead of as a module of its own", async () => {
    const result = await transformAstroSfc({
      path: "/project/Card.astro",
      source: `---\nconst eventName = "card.viewed";\n---\n<button>x</button>\n<script define:vars={{ eventName, other: 1 }}>\n  track(eventName);\n</script>\n<script>track("b");</script>`,
    });
    // only the plain script is a module of its own, and it is the first one
    expect(result.modules.map((m) => m.path)).toEqual(["/project/Card.astro.ts", "/project/Card.astro.client1.ts"]);
    const main = result.modules[0]?.content ?? "";
    expect(main).toContain("const __eventraVar0_eventName = (eventName\n  );");
    expect(main).toContain("const __eventraVar0_other = (1\n  );");
    expect(main).toContain("const eventName = __eventraVar0_eventName;");
    expect(main).toContain("const other = __eventraVar0_other;");
    expect(main).toContain("track(eventName);");
    expect(result.modules[1]?.content).toContain('track("b");');
  });
});

describe("transformAstroSfc client scripts", () => {
  it("returns one extra module per <script>", async () => {
    const result = await transformAstroSfc({
      path: "/project/Card.astro",
      source: `---\n---\n<button>x</button>\n<script>\n  track("a");\n</script>\n<script>track("b");</script>`,
    });
    expect(result.modules.map((m) => m.path)).toEqual([
      "/project/Card.astro.ts",
      "/project/Card.astro.client1.ts",
      "/project/Card.astro.client2.ts",
    ]);
    expect(result.modules[1]?.content).toContain('track("a");');
  });
});
