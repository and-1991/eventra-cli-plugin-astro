import { buildScriptModule, parseAstroSfc, scriptVirtualPath } from "./parse-astro-sfc";
import type { CliPluginTransformInput, CliPluginTransformResult } from "./types";

export async function transformAstroSfc(
  input: CliPluginTransformInput,
): Promise<CliPluginTransformResult> {
  const parsed = await parseAstroSfc(input.source);

  return {
    modules: [
      {
        path: scriptVirtualPath(input.path),
        content: buildScriptModule(parsed),
      },
    ],
  };
}
