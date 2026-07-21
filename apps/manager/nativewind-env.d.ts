/// <reference types="nativewind/types" />

// Side-effect CSS imports (e.g. `import "../global.css"`). Expo normally emits
// this via the generated expo-env.d.ts (`expo/types`), which isn't present until
// `expo start`/prebuild runs; declare it here so `tsc` resolves it standalone.
declare module "*.css";
