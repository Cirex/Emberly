// https://docs.expo.dev/guides/using-eslint/
const expoConfig = require("eslint-config-expo/flat");

module.exports = [
  ...expoConfig,
  {
    ignores: ["dist/*", ".expo/*", "expo-env.d.ts"],
  },
  {
    settings: { react: { version: "19" } },
    // React Compiler rules (eslint-plugin-react-hooks v6) are opt-in strictness
    // this codebase predates - keep them as warnings, not CI blockers.
    rules: {
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/refs": "warn",
    },
  },
];
