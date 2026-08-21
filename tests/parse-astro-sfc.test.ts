import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createCliPluginAstro } from "../src/index";
import { buildScriptModule, parseAstroSfc, scriptVirtualPath } from "../src/parse-astro-sfc";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "checkout.astro",
);

describe("parseAstroSfc", () => {
  it("extracts the frontmatter and literal template event", async () => {
    const source = readFileSync(FIXTURE, "utf8");
    const parsed = await parseAstroSfc(source);

    expect(parsed.script).toContain('tracker.track("checkout.started")');
    expect(parsed.templateEvents).toEqual([{ kind: "literal", value: "checkout.cta" }]);
  });

  it("builds the virtual module path", () => {
    expect(scriptVirtualPath("/src/Card.astro")).toBe("/src/Card.astro.ts");
  });

  it("ignores frontmatter/element-looking text inside HTML comments", async () => {
    const source = `
      <!-- ---
      evil();
      --- -->
      <!-- <button event="fake" /> -->
      ---
      track("real");
      ---
      <button event="real_event" />
    `;
    const parsed = await parseAstroSfc(source);

    expect(parsed.script).toBe("track(\"real\");");
    expect(parsed.templateEvents).toEqual([{ kind: "literal", value: "real_event" }]);
  });

  it("finds literal event bindings inside JSX expressions (&&, ternary, .map)", async () => {
    const source = `
      <button event="root_a" />
      <div>
        {cond && <button event="conditional" />}
        {cond ? <button event="ternary_true" /> : <button event="ternary_false" />}
        {items.map((item) => <button event="looped" key={item.id} />)}
      </div>
    `;
    const parsed = await parseAstroSfc(source);

    expect(parsed.templateEvents.map((e) => e.value)).toEqual([
      "root_a",
      "conditional",
      "ternary_true",
      "ternary_false",
      "looped",
    ]);
  });

  it('drops an empty event="" attribute instead of emitting a blank literal', async () => {
    const parsed = await parseAstroSfc('<button event="" />');

    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("ignores a boolean-shorthand event attribute (no value)", async () => {
    const parsed = await parseAstroSfc("<button event />");

    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("ignores an interpolated template-literal event value instead of misreading it as one binding", async () => {
    const parsed = await parseAstroSfc("<button event=`prefix-${suffix}` />");

    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("captures dynamic event={} bindings as raw expressions instead of dropping them", async () => {
    const source = `
      <button event={computedName} />
      <button event={isActive ? "a" : "b"} />
    `;
    const parsed = await parseAstroSfc(source);

    expect(parsed.templateEvents).toEqual([
      { kind: "dynamic", value: "computedName" },
      { kind: "dynamic", value: 'isActive ? "a" : "b"' },
    ]);
  });

  it("drops an empty event={} expression instead of emitting a blank dynamic occurrence", async () => {
    const parsed = await parseAstroSfc("<button event={} />");

    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("expands JSX shorthand {event} to a dynamic event={event} binding", async () => {
    const parsed = await parseAstroSfc("<button {event} />");

    expect(parsed.templateEvents).toEqual([{ kind: "dynamic", value: "event" }]);
  });

  it("passes Astro.props destructuring through untouched and still detects the sink call", async () => {
    const source = `
      ---
      import { Eventra } from "@eventra_dev/eventra-sdk";

      const { eventName = "all_props_event" } = Astro.props;
      const tracker = new Eventra({ apiKey: "k" });
      tracker.track(eventName);
      ---
      <button event="all_props_template_event" />
    `;
    const parsed = await parseAstroSfc(source);

    expect(parsed.script).toContain("Astro.props");
    expect(parsed.script).toContain("tracker.track(eventName);");
    expect(parsed.templateEvents).toEqual([
      { kind: "literal", value: "all_props_template_event" },
    ]);
  });

  it("returns null script and no template events for a component with no frontmatter", async () => {
    const parsed = await parseAstroSfc("<div />");

    expect(parsed.script).toBeNull();
    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("reports a compiler diagnostic via the errors array", async () => {
    const parsed = await parseAstroSfc("---\n/* unterminated\n---\n<div />");

    expect(parsed.errors).toEqual(["Unterminated comment"]);
  });

  it("returns null script for a frontmatter fence that is present but empty", async () => {
    const parsed = await parseAstroSfc("---\n---\n<button event=\"real\" />");

    expect(parsed.script).toBeNull();
    expect(parsed.templateEvents).toEqual([{ kind: "literal", value: "real" }]);
  });
});

describe("buildScriptModule", () => {
  it("emits a single module with frontmatter content followed by the template-events function", async () => {
    const parsed = await parseAstroSfc(readFileSync(FIXTURE, "utf8"));
    const module = buildScriptModule(parsed);

    expect(module).toContain('tracker.track("checkout.started")');
    expect(module).toContain('__eventra_astro_template_event__("checkout.cta")');
  });

  it("emits dynamic bindings as raw (unquoted) expressions", async () => {
    const parsed = await parseAstroSfc("<button event={computedName} />");
    const module = buildScriptModule(parsed);

    expect(module).toContain("__eventra_astro_template_event__(computedName);");
    expect(module).not.toContain('__eventra_astro_template_event__("computedName")');
  });

  it("resolves a dynamic binding through a real frontmatter const in the same module scope", async () => {
    const source = `
      ---
      const eventName = "from_frontmatter_const";
      ---
      <button event={eventName} />
    `;
    const parsed = await parseAstroSfc(source);
    const module = buildScriptModule(parsed);

    expect(module).toContain('const eventName = "from_frontmatter_const"');
    expect(module).toContain("__eventra_astro_template_event__(eventName);");
  });

  it("returns an export stub when there is no frontmatter and no template events", async () => {
    const parsed = await parseAstroSfc("<div />");
    const module = buildScriptModule(parsed);

    expect(module.trim()).toBe("export {}");
  });
});

describe("createCliPluginAstro", () => {
  it("returns a single virtual module combining frontmatter and template", async () => {
    const source = readFileSync(FIXTURE, "utf8");
    const plugin = createCliPluginAstro();

    expect(plugin.match("Card.astro")).toBe(true);
    expect(plugin.match("Card.tsx")).toBe(false);
    expect(plugin.includeGlobs).toContain("**/*.astro");
    expect(plugin.staticSinks?.[0]?.callee).toBe("__eventra_astro_template_event__");

    const result = await plugin.transform({ path: "/project/Checkout.astro", source });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.path).toBe("/project/Checkout.astro.ts");
    expect(result.modules[0]?.content).toContain("checkout.started");
    expect(result.modules[0]?.content).toContain("checkout.cta");
  });

  it("returns an export stub when both frontmatter and template are missing", async () => {
    const plugin = createCliPluginAstro();
    const result = await plugin.transform({ path: "/Empty.astro", source: "<div />" });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.content.trim()).toBe("export {}");
  });
});
