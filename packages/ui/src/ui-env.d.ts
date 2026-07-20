// Ambient shims so `tsc` can typecheck this source-only package standalone.
// These are used ONLY by this package's own tsconfig; they are not imported by
// the consuming apps, so they never reach an app's TypeScript program.

// Metro resolves image imports to asset ids at bundle time.
declare module "*.png";

// React Native asset loading uses `require(...)`; the consuming apps type this
// via their own env (bun/expo). Declared here for standalone type-checking.
declare function require(name: string): any;
