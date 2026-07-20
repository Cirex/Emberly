# AGENTS.md

## Purpose

Rules for building the Emberly platform with React Native, Expo, TypeScript, Next.js, Supabase, Sentry, Zustand, i18next, Resend, Tailwind/NativeWind, EAS, Coolify, Yarn, and Zod.

Prefer small files, clear boundaries, reusable primitives, secure data access, reliable tests, and simple deployments. Global rules apply everywhere; a more specific rule overrides a general one.

---

## Required Workflow

Before editing code:

1. Write a **Superpowers Plan**.
2. Create a separate branch; never work directly on `main`.
3. Document the intended Conventional Commit.
4. Inspect existing patterns and choose the smallest safe change.

```md
## Superpowers Plan
- Branch: feature/<scope>-<short-description>
- Goal: problem being solved
- Current behavior: what exists and where
- Proposed change: add/change/remove/refactor
- Architecture fit: mobile, web, API, package, or database boundaries touched
- Files expected: additions, edits, and removals
- Security/privacy: auth, RLS, secrets, validation, PII, logs, permissions
- Testing: unit, component, integration, E2E, and manual checks
- Performance: render, network, bundle, cache, offline/retry impact
- Rollback: safe reversal plan
- Intended commit: feat(scope): short description
```

No small-change exemption.

Branch prefixes:

```text
feature/  fix/  refactor/  chore/  docs/  test/
```

Commit types:

```text
feat  fix  refactor  chore  docs  test
```

Every finished change must summarize what changed, why, tests run, security notes, cleanup, and the intended commit. Never commit secrets, `.env*`, sensitive screenshots, local build output, generated junk, or unrelated lockfile churn.

---

## Repository and Imports

```text
emberly/
  AGENTS.md
  package.json
  bun.lock
  turbo.json
  tsconfig.base.json
  eslint.config.js
  .prettierrc
  .env.example

  apps/
    mobile/                 # Expo React Native
      app/                  # Expo Router routes only
      src/{features,primitives,navigation,services,state,styles,test}/
      app.config.ts | app.json
      eas.json
      package.json

    web/                    # Next.js, deployed by Coolify
      app/                  # App Router and route handlers
      src/{features,components,services,styles}/
      next.config.ts
      Dockerfile
      package.json

  packages/
    core/                   # framework-free models, constants, pure logic
    api/                    # Zod schemas, contracts, typed clients
    ui/                     # reusable primitives only
    config/                 # shared tool configuration

  supabase/                 # migrations, seeds, RLS/database tests
  docs/                     # architecture, deployment, ADRs
```

Rules:

- `apps/mobile` is Expo React Native; `apps/web` is Next.js.
- Mobile routes stay in `apps/mobile/app`. Do not add a second app-level navigation root.
- Keep code app-local until a second real consumer exists.
- Avoid Git submodules unless the code is independently owned and released.

Allowed imports:

```text
apps/mobile  -> packages/api, core, ui, config
apps/web     -> packages/api, core, ui, config
packages/api -> packages/core
packages/ui  -> packages/core only when unavoidable
packages/core -> no app, React, Expo, Next.js, Supabase, or provider imports
```

Apps may import packages; packages must not import app code. Consume features through small public exports. Do not create circular dependencies or broad barrel files merely to quiet TypeScript.

---

## Architecture

### Mobile MVVM

```text
apps/mobile/src/features/<feature>/
  screens/  components/  view-models/  repositories/
  services/  models/  hooks/  __tests__/  index.ts
```

- **Route:** load params, set navigation options, and compose a screen.
- **View/Screen:** render state, bind events, and compose primitives.
- **ViewModel:** own UI state, derived state, commands, loading, and errors. Name hooks `use<Feature>ViewModel`.
- **Model:** domain types, Zod schemas, value objects, and state definitions.
- **Repository:** hide Supabase/API details and return domain data.
- **Service:** coordinate uploads, notifications, email, sync, payments, audit logs, and other workflows.

Use Expo Router as the only app-level mobile router. Routes and views contain no workflow logic, raw `fetch`, direct Supabase calls, or provider details. Views call ViewModels; ViewModels call repositories, services, query hooks, or typed clients. Models remain framework-free. Keep mobile-only primitives local until proven reusable.

### Web

```text
apps/web/src/features/<feature>/
  components/  actions/  services/  schemas.ts  types.ts  __tests__/  index.ts
```

Use Next.js App Router. Use Route Handlers for mobile endpoints, webhooks, callbacks, and privileged workflows; use Server Actions only for Next.js-owned form mutations. Keep server-only code out of client components and prefer Server Components when they reduce shipped JavaScript.

Route Handlers must authenticate, authorize, validate, delegate to services, return intentional status codes, hide internal errors, and test success and failure paths.

### Shared Packages

- `core`: framework-free domain rules only.
- `api`: shared validation, contracts, inferred types, and typed clients.
- `ui`: simple cross-platform primitives, never business features.
- `config`: shared lint, TypeScript, Tailwind, and NativeWind configuration.

Share contracts and pure logic before visual composition. Premature reuse is still premature, even in a monorepo.

---

## Code, UI, and State

Recommended review limits:

```text
Screen 120 | Component/ViewModel/Repository 150 | Service/Schema 200 | Test 250
```

Split files when they have unrelated reasons to change, state, or workflows. Avoid vague names such as `utils.ts`, `helpers.ts`, and `api.ts`; name the responsibility directly.

Use strict TypeScript. Avoid `any`; prefer `unknown` with narrowing. Export intentional public types, use discriminated unions for complex states, and never suppress errors just to satisfy CI.

Use Tailwind on web and NativeWind on mobile. Prefer tokens and variants over repeated one-off styles. Primitives must support relevant loading, disabled, error, pressed, and focus states. Feature components compose primitives instead of forking them.

Use i18next with English as the source language and Spanish required for user-facing text, including validation, navigation, accessibility labels, emails, notifications, and loading/empty/error states. Use scoped stable keys and interpolation. Do not translate brand names, IDs, codes, or documented machine values.

Support safe areas, keyboard overlap, large tap targets, scalable text, visible web focus, sufficient contrast, non-color-only status, and applicable loading, empty, error, retry, offline, and permission-denied states.

State rules:

- Keep local UI state in React.
- Use Zustand only for mobile state crossing screens or surviving navigation, such as session, workspace, offline queues, selected inspections, theme, language, catalogs, vendors, or timers.
- Use selectors. Persist only intentional slices with `partialize`, versioning/migrations, and AsyncStorage when restart recovery is needed.
- Never persist passwords, service-role keys, Sentry auth tokens, invite tokens, or other secrets.
- Do not add Zustand to `packages/core`; use it on web only when URL/server/query state is insufficient.
- Use the installed query/cache layer for server state. Avoid duplicate requests, stale updates, and fetching from presentational components.

---

## Validation and Security

Validate every external or uncertain boundary with Zod, including env vars, route/search params, forms, request bodies, deep links, webhooks, email payloads, uploads, and network/Supabase responses. Prefer `safeParse` for user/network input; use `parse` only when failure is exceptional.

- Authenticate and authorize server operations. Never trust frontend roles, hidden fields, disabled fields, or client validation.
- Keep secrets and privileged keys in trusted server/build environments.
- Keep secrets, tokens, PII, sensitive URLs, request bodies, and internal errors out of logs, tests, screenshots, analytics, and user messages.
- Verify webhook signatures and restrict uploads by type, size, ownership, and policy.
- Make duplicate-sensitive workflows idempotent.
- Put privileged work in Route Handlers, Supabase Edge Functions, or trusted workers.

---

## Stack Rules

### Bun

Bun is both the package manager and the JS/TS runtime for the repo (pinned via `packageManager` in the root `package.json`). Run everything through Bun from the root:

```bash
bun install                                # honors the committed bun.lock
bun run <root-script>
bun run --filter '<workspace>' <script>
bun add --cwd <workspace-dir> <package>
bun remove --cwd <workspace-dir> <package>
bunx <tool>                                # one-off tool runner
```

Keep dependencies in the narrowest owning workspace. Commit `bun.lock`. Do not create npm/pnpm/yarn lockfiles alongside it. Tests run on Bun's runner (`bun test`, which is `node:test`-compatible); the sync worker and repo scripts run TypeScript natively under Bun (no transpile step).

**Everything runs on the Bun runtime, including builds.** By default Bun honors a CLI binary's Node shebang and defers to Node, so the build scripts explicitly opt into the Bun runtime with the `--bun` flag: `@emberly/web` uses `bun --bun next dev|build|start`, and the `tsc` builds use `bun --bun tsc`. Next 16 and `tsc` both build clean under Bun (verified). This means **the build environment must have Bun on PATH** — for Coolify, `bun.lock` drives buildpack detection; if a Dockerfile is used it needs a Bun base image (`oven/bun`) for the build stage. The Next standalone server (`server.js`) can still be served by Node at runtime. The only piece that genuinely still uses Node internally is the **Expo** apps' Metro/Hermes toolchain — that is unavoidable and not something Bun replaces.

### Expo and EAS

Prefer Expo-compatible libraries and Development Builds for unsupported native modules. Use Expo Router conventions and explicit platform files or `Platform.select`. Keep `eas.json` in `apps/mobile` with development, preview, and production profiles. Native configuration changes require a new binary, not an OTA update. Only intentionally public values belong in app client configuration.

### Next.js and Coolify

Deploy `apps/web` with Coolify Base Directory `/apps/web`. Prefer Next.js `output: "standalone"` and a multi-stage Dockerfile. Store secrets in Coolify. Do not run mobile builds in the web image. Use build pruning or prebuilt images, not submodules, when deployment size grows.

### Supabase

Enable and test RLS on every client-accessible table. Direct client access is allowed only when RLS and Storage policies make it safe; service-role keys never enter mobile/browser code. Use migrations, regenerate database types, and review indexes, seeds, backfills, and rollback. Do not edit migrations already applied outside local development. Scope and clean up Realtime subscriptions.

### Resend

Send email only from trusted server code. Keep keys in server/Coolify env, validate payloads, keep templates deterministic, log important sends safely, and use idempotency when duplicates matter. Hide provider details behind a replaceable service.

### Sentry

Use separate web and mobile projects. Web uses `@sentry/nextjs`; mobile uses `@sentry/react-native` with the Expo plugin. Public DSNs may use `NEXT_PUBLIC_SENTRY_DSN` and `EXPO_PUBLIC_SENTRY_DSN`.

Keep `SENTRY_AUTH_TOKEN` build-only in GitHub Actions or EAS. Never commit, log, screenshot, ship, or pass it through Docker `ARG`/`ENV`. Initialization must be a no-op without a DSN. Upload source maps/debug symbols from trusted pipelines. Scrub secrets, tokens, PII, inspection photos, request bodies, and sensitive URLs. Keep workflow reporting behind services/helpers, not views or ViewModels.

---

## Performance and Dependencies

Mobile: use virtualized lists, pagination, right-sized images, memoized expensive derivations, minimal global updates, and no heavy synchronous JavaScript. Optimistic updates require rollback behavior.

Web: minimize client components and shipped JavaScript, keep server packages out of client bundles, use loading/error boundaries deliberately, and keep production images limited to required web packages.

Before adding a dependency, review need, size, license, maintenance, security, Expo support, and web support. Remove unused dependencies when replacing code.

---

## Testing, Cleanup, and Completion

Behavior changes require appropriate tests for ViewModels, component behavior, Zod schemas, pure domain rules, repositories/services, Route Handlers, permissions/RLS, and relevant loading/error/empty/success/offline/retry states. Verify changed user-facing text in English and Spanish when practical.

Use E2E tests for critical flows: authentication, inspection create/update/submit, work orders, uploads, email triggers, role boundaries, and field payments when enabled.

Run affected Bun commands, for example:

```bash
bun run lint
bun run typecheck
bun run test
bun run web:build
bun run --filter '@emberly/mobile' test
bun run --filter '@emberly/web' typecheck
```

Before finishing:

- remove related dead code, imports, dependencies, helpers, flags, TODOs, and obsolete tests
- update affected setup, env, deployment, schema, auth, API, architecture, testing, and release docs
- keep `.env.example` current with public placeholders only
- add an ADR under `docs/adr/` for meaningful architecture decisions
- report commands actually run, failures, skipped checks, security implications, cleanup, and intended commit

A change is done only when the branch, plan, architecture boundaries, validation, security review, tests, cleanup, translations, documentation, and affected checks are complete or honestly documented. Never invent validation results.

---

## PR Checklist

```md
## What changed?
## Why?
## Superpowers Plan
## Screenshots / Recordings
Required for UI changes.

## Tests Run
- [ ] lint
- [ ] typecheck
- [ ] unit/component/integration tests
- [ ] E2E, if needed
- [ ] affected build

## Security
- [ ] Auth, permissions, RLS, and Storage reviewed
- [ ] Inputs validated with Zod
- [ ] No secrets or unsafe logs/errors
- [ ] Sentry data scrubbed and credentials build-only

## Cleanup
- [ ] Removed related dead code and dependencies
- [ ] Updated docs, `.env.example`, and translations

## Commit
feat(scope): short description
```
