// getSentryExpoConfig wraps Expo's default Metro config and adds Sentry's
// source-map / debug-id handling so stack traces symbolicate correctly. It is a
// drop-in replacement for expo/metro-config's getDefaultConfig and is harmless
// when Sentry is not configured (no DSN) — it only affects build-time metadata.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getSentryExpoConfig(projectRoot);

// Yarn-workspace monorepo setup. @emberly/core lives at packages/core and its
// dependencies are hoisted to the monorepo-root node_modules. Metro must watch
// the whole monorepo (so the workspace package bundles) and resolve modules from
// both the app's and the root's node_modules.
config.watchFolders = [
  ...(config.watchFolders ?? []),
  monorepoRoot,
];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

module.exports = config;
