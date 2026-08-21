<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI Plugin — Astro

<p align="center">
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-astro"><img alt="npm version" src="https://img.shields.io/npm/v/@eventra_dev/cli-plugin-astro.svg?style=flat-square&color=blue"></a>
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-astro"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@eventra_dev/cli-plugin-astro.svg?style=flat-square&color=blue"></a>
  <img alt="tests passing" src="https://img.shields.io/badge/tests-20%20passing-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="node" src="https://img.shields.io/node/v/@eventra_dev/cli-plugin-astro?style=flat-square&color=darkgreen&logo=node.js&logoColor=white">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-blue?style=flat-square&logo=typescript&logoColor=white"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@eventra_dev/cli-plugin-astro?style=flat-square&color=lightgrey">
</p>

Official [**Eventra CLI**](https://www.npmjs.com/package/@eventra_dev/eventra-cli) plugin — extracts `track()` calls from Astro components (`.astro`), so `eventra sync`/`check`/`watch` understand Astro code the same way they already understand plain TypeScript.

---

## Overview

The CLI core is framework-agnostic and only walks `.ts`/`.tsx`/`.js`/`.jsx`. This plugin teaches it `.astro`: it parses each component with the real Astro compiler ([`@astrojs/compiler`](https://www.npmjs.com/package/@astrojs/compiler)) — not a regex — and hands the CLI a single virtual TypeScript module per file, so every existing detection rule (direct SDK calls, function wrappers, cross-file propagation, dynamic-name reporting) applies to Astro code without any Astro-specific case in the core engine.

---

## Installation

```bash
npm install -D @eventra_dev/cli-plugin-astro @eventra_dev/eventra-cli
# or
pnpm add -D @eventra_dev/cli-plugin-astro @eventra_dev/eventra-cli
```

Enable it in `eventra.json`:

```json
{
  "plugins": ["@eventra_dev/cli-plugin-astro"],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": ["node_modules", "dist", ".astro", ".git"]
  }
}
```

`sync.include` does **not** need `**/*.astro` added manually — the plugin registers it via `includeGlobs`.

---

## What gets detected

### Frontmatter

Handled exactly like a regular `.ts` file — direct SDK calls, function wrappers, variables, ternaries, cross-file propagation all apply. Astro frontmatter is TypeScript already, so there's no `lang=` attribute to detect:

```astro
---
import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "YOUR_PROJECT_API_KEY" });

tracker.track("checkout.started");
---
```

### Template — literal event attributes

```astro
<button event="checkout.cta">Pay</button>
```

### Template — dynamic event attributes

```astro
<button event={computedEventName}>Pay</button>
<!-- JSX shorthand also works: {event} is sugar for event={event} -->
<button {event} />
```

The expression is copied as-is into the same module scope as the frontmatter. If it resolves to a real frontmatter constant, the event name is detected normally; otherwise it's reported as a **dynamic occurrence** (same mechanism as `tracker.track(someVariable)` in plain TypeScript) instead of being silently dropped.

`event` is recognized on any tag — plain elements, components, custom elements, and fragments — including ones nested inside JSX expressions (`{cond && <Button event="..." />}`, `{items.map((item) => <Button event="..." />)}`), since the plugin walks the whole template rather than special-casing specific expression shapes.

---

## Configuration

No plugin-specific config — it activates purely by being listed in `eventra.json`'s `plugins` array (see [Installation](#installation)).

---

## Plugin contract

```ts
export interface CliPluginAstro {
  readonly id: string;
  readonly version: string;
  readonly includeGlobs: readonly string[];
  readonly staticSinks?: readonly CliPluginStaticCalleeSink[];
  match(path: string): boolean;
  transform(input: { path: string; source: string }): Promise<{
    modules: Array<{ path: string; content: string }>;
  }>;
}
```

No dependency on `@eventra_dev/eventra-cli` — the CLI adapts this shape internally. `.astro` → one virtual `.astro.ts` module (frontmatter content, then a function wrapping synthetic calls for every template `event="..."` binding). `staticSinks` describes those synthetic calls; the CLI builds its own sink detector from them. See [`@eventra_dev/eventra-cli`'s plugin docs](https://www.npmjs.com/package/@eventra_dev/eventra-cli#plugin-contract-for-authors) for the full external-plugin contract.

---

## Requirements

- Node.js 18+
- `@eventra_dev/eventra-cli` as the host CLI

---

## Test Coverage

**100% statement/branch/function/line coverage** (v8 provider, `pnpm test:coverage`), enforced via a `coverage.thresholds` block in `vitest.config.ts`.

**20 unit tests** (vitest), covering:

| Area | Covers |
|---|---|
| Component parsing | Frontmatter extraction, comment safety, compiler-diagnostic reporting |
| Template — literal | Nested elements, JSX expressions (`&&`, ternary, `.map()`) |
| Template — dynamic | Raw expression passthrough, `{event}` shorthand, resolution through the frontmatter scope |
| Edge cases | Empty `event=""`, boolean-shorthand `event`, empty `event={}`, interpolated `` event=`a-${b}` `` |
| Astro globals | `Astro.props` destructuring passes through without special-casing |
| Virtual module output | Single combined `.astro.ts`, export stub when frontmatter/template are empty |
| Plugin contract | `match()`, `includeGlobs`, `staticSinks`, `transform()` |

Run locally:

```bash
pnpm --filter @eventra_dev/cli-plugin-astro test
pnpm --filter @eventra_dev/cli-plugin-astro test:coverage
```

---

## License

MIT
