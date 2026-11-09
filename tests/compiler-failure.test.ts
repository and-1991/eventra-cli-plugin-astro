import { beforeEach, describe, expect, it, vi } from "vitest";

const parseMock = vi.hoisted(() => vi.fn());
const teardownMock = vi.hoisted(() => vi.fn());
vi.mock("@astrojs/compiler", () => ({ parse: parseMock, teardown: teardownMock }));

import { parseAstroSfc } from "../src/parse-astro-sfc";

const ast = (children: unknown[] = []) => ({
  diagnostics: [],
  ast: { type: "root", children },
});
const FRONT = `---\nsdk.track("a");\n---\n<p>hi</p>\n`;

describe("when the Astro compiler itself fails", () => {
  beforeEach(() => {
    parseMock.mockReset();
    teardownMock.mockReset();
  });

  it("falls back to the frontmatter and scripts, and says why", async () => {
    parseMock.mockRejectedValueOnce(new Error("Go program has already exited\nstack")).mockResolvedValueOnce(
      ast([{ type: "frontmatter", value: '\nsdk.track("a");\n', position: { start: { line: 1 } } }]),
    );
    const parsed = await parseAstroSfc(FRONT);
    expect(parsed.templateSkipped).toBe("the Astro compiler failed (Go program has already exited)");
    expect(parsed.script).toContain('sdk.track("a")');
    // the retry saw the source without its template
    expect(parseMock.mock.calls[1][0]).not.toContain("hi");
  });

  it("starts the compiler afresh after a failure, because a crashed Go runtime does not notice it is dead", async () => {
    parseMock.mockRejectedValueOnce(new Error("crash")).mockResolvedValueOnce(ast());
    await parseAstroSfc(FRONT);
    expect(teardownMock).toHaveBeenCalledTimes(1);
    parseMock.mockResolvedValueOnce(ast());
    await parseAstroSfc(FRONT);
    expect(teardownMock).toHaveBeenCalledTimes(1);
  });

  it("reports a non-Error rejection", async () => {
    parseMock.mockRejectedValueOnce("boom").mockResolvedValueOnce(ast());
    expect((await parseAstroSfc(FRONT)).templateSkipped).toBe("the Astro compiler failed (boom)");
  });

  it("rethrows the original error when even the reduced source cannot be parsed", async () => {
    const original = new Error("first failure");
    parseMock.mockRejectedValueOnce(original).mockRejectedValueOnce(new Error("second"));
    await expect(parseAstroSfc(FRONT)).rejects.toBe(original);
  });

  it("throws a descriptive error when the original failure was not an Error", async () => {
    parseMock.mockRejectedValueOnce("x").mockRejectedValueOnce(new Error("second"));
    await expect(parseAstroSfc(FRONT)).rejects.toThrow(/could not be parsed: the Astro compiler failed/);
  });

  it("a failed call does not block the next one", async () => {
    parseMock.mockRejectedValueOnce(new Error("a")).mockRejectedValueOnce(new Error("b")).mockResolvedValueOnce(ast());
    await expect(parseAstroSfc(FRONT)).rejects.toThrow();
    expect((await parseAstroSfc(FRONT)).templateSkipped).toBeUndefined();
  });
});
