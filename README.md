<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI Plugin — Astro

<p align="center">
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-astro"><img alt="npm version" src="https://img.shields.io/npm/v/@eventra_dev/cli-plugin-astro.svg?style=flat-square&color=blue"></a>
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-astro"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@eventra_dev/cli-plugin-astro.svg?style=flat-square&color=blue"></a>
  <img alt="tests passing" src="https://img.shields.io/badge/tests-170%20passing-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="node" src="https://img.shields.io/node/v/@eventra_dev/cli-plugin-astro?style=flat-square&color=darkgreen&logo=node.js&logoColor=white">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-blue?style=flat-square&logo=typescript&logoColor=white"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@eventra_dev/cli-plugin-astro?style=flat-square&color=lightgrey">
</p>

Official [**Eventra CLI**](https://www.npmjs.com/package/@eventra_dev/eventra-cli) plugin — extracts `track()` calls from Astro components (`.astro`), so `eventra sync`/`check`/`watch` understand Astro code the same way they already understand plain TypeScript.

---

## Overview

The CLI core is framework-agnostic and only walks TypeScript and JavaScript files (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`). This plugin teaches it `.astro`: it parses each component with the real Astro compiler ([`@astrojs/compiler`](https://www.npmjs.com/package/@astrojs/compiler)) - not a regex - and hands the CLI a single virtual TypeScript module per file, so every existing detection rule (direct SDK calls, function wrappers, cross-file propagation, dynamic-name reporting) applies to Astro code without any Astro-specific case in the core engine.

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

- A `<script define:vars={vars}>` whose value is not an object written out in the tag, or one that has imports of its own (it is then a module, as any other `<script>`). A `define:vars={{ a, b: expr }}` script without imports is read in the frontmatter's scope, so `a` and `b` resolve to what the frontmatter sets them to.
- Boolean attributes and template literals in props (a template literal on `event` itself, `` event=`a-${b}` ``, is read).
- Member tags (`<Foo.Bar>`) and non-default imports.
- A frontmatter with a value `export` (a type is fine) or an import after other code.
- A prop put into an attribute string (`onclick={`track("${x}")`}`): that is text, not a call.

A value the CLI cannot resolve to a plain string (a `.map()` variable, a prop of the page itself) is listed under "Dynamic event names" instead of becoming an event, with the reason (`env`, `variable`, `template`, `call`, `expression`). The tracking call inside the component itself is listed apart, under "Inside a wrapper", because what it tracks is whatever each caller passes; the callers that pass a literal are still found.

### Very large templates

The Astro compiler slows down sharply, and finally runs out of memory, on a template with about 700 or more siblings under one element (a long generated list) or with markup nested hundreds of levels deep. The plugin measures the template first. Past 700 siblings under one parent, 1000 levels of nesting, 8000 elements or a tag with more than 1000 attributes (a run of `<script x ` that is never closed is read as attributes of one tag, and the compiler's cost grows with their square), it does not hand the template to the compiler: it reads the frontmatter and the `<script>` tags, leaves the template out, and prints a warning naming the file. Events written in that template are not in the scan; split the page into components to get them back. The plugin tells the CLI the file was read only in part: `sync` and `check` list it, count the scan as not clean, keep the events already known, and `--strict` fails. A file that crashes the compiler for any other reason is treated the same way, and other files are not affected. The size is judged by the number of children under one parent times the markup inside it (a table of 500 rows by 30 cells is too large, 500 rows by 5 cells is not), by nesting, and by a tag that is never closed (the compiler's answer to broken markup is not predictable). If the scripts alone are too much for the compiler too, only the frontmatter is read. An end tag left out (`<li>a<li>b`) is nested by the compiler, so it counts as nesting. A compiler crash is contained: the next file is read as usual.

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
    partial?: string[];  // the template was too large for the compiler and was left out
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

**163 unit tests** (vitest), covering:

| Area | Covers |
|---|---|
| Component parsing | Frontmatter extraction, comment safety, compiler-diagnostic reporting |
| Template — literal | Nested elements, JSX expressions (`&&`, ternary, `.map()`) |
| Template — dynamic | Raw expression passthrough, `{event}` shorthand, resolution through the frontmatter scope |
| Edge cases | Empty `event=""`, boolean-shorthand `event`, empty `event={}`, unbraced template-literal `` event=`a-${b}` `` (read as the template literal it is, the same as `` event={`a-${b}`} ``) |
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

MIT, copyright (c) 2026 [Yuriy Korolik](https://github.com/and-1991). See [LICENSE](LICENSE).
