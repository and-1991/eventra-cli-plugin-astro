<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI Plugin — Astro

<p align="center">
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-astro"><img alt="npm version" src="https://img.shields.io/npm/v/@eventra_dev/cli-plugin-astro.svg?style=flat-square&color=blue"></a>
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-astro"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@eventra_dev/cli-plugin-astro.svg?style=flat-square&color=blue"></a>
  <img alt="tests passing" src="https://img.shields.io/badge/tests-124%20passing-brightgreen?style=flat-square&logo=vitest&logoColor=white">
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

### Template - expressions and `<script>` tags

Calls written in template expressions are read: `{track("x")}`, `attr={expr}` (`onclick={() => track("x")}`) and `{...spread}`. A `{...}` that also contains markup (`{items.map((i) => <li>...</li>)}`) is JSX, not plain code: only the braces inside it are read.

Each `<script>` in the template (client-side TypeScript) is read as a module of its own, with its own imports and its real line numbers. A script that holds data (`type="application/ld+json"`, an import map) or has no content is skipped. A quoted `onclick="track('x')"` is text for the browser and is not read.

### Props of a component, whatever they are called

The prop does not have to be named `event`. If a component sends one of its props to a tracking call, every place that uses the component with a value for that prop is an event:

```astro
---
// Banner.astro: tracks that it was shown
import { Eventra } from '@eventra_dev/eventra-sdk';
const tracker = new Eventra({ apiKey: 'YOUR_KEY' });
const { analyticsName } = Astro.props;
tracker.track(analyticsName);
---
<aside><slot /></aside>
```

```astro
---
// Page.astro
import Banner from './Banner.astro';
---
<Banner analyticsName="checkout.banner">Free shipping</Banner>
```

The call has to be real code (in the frontmatter, in a `{...}` expression or in a `<script>`): a prop put into a string such as `onclick={`track("${name}")`}` is text, not a call, and is not read.

Works for `const { a, b } = Astro.props`, `const props = Astro.props` and `Astro.props.a` read straight in the template, for default imports of `.astro` files, `prop="text"`, `prop={expr}` and the `{prop}` shorthand, and follows a prop handed on to another component. Props the component never tracks are not events.

**Not followed** (those components are scanned as before, so nothing is lost, but a prop that only they use is not found):

- `<script define:vars={{ ... }}>`. A `<script>` is read as a module of its own, so a prop that reaches it only through `define:vars` is not followed. Track in the frontmatter or in a `{...}` expression instead.
- Spreads, boolean attributes and template literals in props.
- Member tags (`<Foo.Bar>`) and non-default imports.
- A frontmatter with a value `export` (a type is fine) or an import after other code.
- A prop put into an attribute string (`onclick={`track("${x}")`}`): that is text, not a call.

A value the CLI cannot resolve to a plain string (a `.map()` variable, a prop of the page itself) is listed under "Dynamic event names" instead of becoming an event. The same list shows the tracking call inside the component itself, one line per component, because what it tracks is whatever each caller passes; the callers that pass a literal are still found.

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

No dependency on `@eventra_dev/eventra-cli` - the CLI adapts this shape internally. `.astro` → one virtual `.astro.ts` module (frontmatter content, then a function wrapping synthetic calls for every template `event="..."` binding and the template expressions copied as code, under a `// --- astro template (auto-generated) ---` comment the CLI uses to tell generated code from your own lines), plus one `.astro.client1.ts`, `.astro.client2.ts`, ... module per template `<script>`. The package also exports `buildClientScriptModule`, `clientScriptVirtualPath` and the `ClientScript` type for those modules. A template-literal attribute (`` attr=`x${track()}` ``) is not read. `staticSinks` describes those synthetic calls; the CLI builds its own sink detector from them. See [`@eventra_dev/eventra-cli`'s plugin docs](https://www.npmjs.com/package/@eventra_dev/eventra-cli#plugin-contract-for-authors) for the full external-plugin contract.

---

## Requirements

- Node.js 18+
- `@eventra_dev/eventra-cli` as the host CLI

---

## Test Coverage

**100% statement/branch/function/line coverage** (v8 provider, `pnpm test:coverage`), enforced via a `coverage.thresholds` block in `vitest.config.ts`.

**124 unit tests** (vitest), covering:

| Area | Covers |
|---|---|
| Component parsing | Frontmatter extraction, comment safety, compiler-diagnostic reporting |
| Template — literal | Nested elements, JSX expressions (`&&`, ternary, `.map()`) |
| Template — dynamic | Raw expression passthrough, `{event}` shorthand, resolution through the frontmatter scope |
| Edge cases | Empty `event=""`, boolean-shorthand `event`, empty `event={}`, unbraced template-literal `` event=`a-${b}` `` (unsupported — silently ignored, same as any other interpolated/mixed value; wrap it in braces, `` event={`a-${b}`} ``, to make it a supported dynamic expression) |
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

MIT, copyright (c) 2026 [and-1991](https://github.com/and-1991). See [LICENSE](LICENSE).
