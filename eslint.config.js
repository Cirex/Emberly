// Root ESLint flat config.
//
// This intentionally only declares shared ignores so `eslint` can be run from
// the repo root without pulling app-specific plugins into the wrong workspace.
// Each app/package owns its real rules (e.g. apps/web uses eslint-config-next)
// and is linted via its own `lint` script through Turbo.
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.expo/**",
      "**/.turbo/**",
      "**/build/**",
      "**/coverage/**",
    ],
  },
];
