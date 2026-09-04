import pkg from "../package.json";
import { transformAstroSfc } from "./transform";
import type { CliPluginAstro } from "./types";

export function createCliPluginAstro(): CliPluginAstro {
  return {
    id: "astro",
    version: pkg.version,
    includeGlobs: ["**/*.astro"],
    staticSinks: [
      {
        id: "astro-template-event",
        callee: "__eventra_astro_template_event__",
        eventNameArgumentIndex: 0,
      },
    ],
    match: (path) => path.endsWith(".astro"),
    transform: transformAstroSfc,
  };
}

export default createCliPluginAstro();

export { transformAstroSfc } from "./transform";
export { buildScriptModule, parseAstroSfc, scriptVirtualPath } from "./parse-astro-sfc";
export type {
  CliPluginAstro,
  CliPluginStaticCalleeSink,
  CliPluginTransformInput,
  CliPluginTransformResult,
  CliPluginVirtualModule,
} from "./types";
export type { ParsedAstroSfc, TemplateEventBinding } from "./parse-astro-sfc";
