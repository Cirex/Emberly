// Expo + NativeWind + Yarn-workspace monorepo Metro config.
const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getSentryExpoConfig(projectRoot);

// @emberly/core lives at packages/core and deps are hoisted to the monorepo
// root node_modules. Metro must watch the whole monorepo and resolve from both.
config.watchFolders = [...(config.watchFolders ?? []), monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

module.exports = withNativeWind(config, { input: "./global.css" });
