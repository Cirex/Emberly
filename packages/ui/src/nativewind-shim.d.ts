// NativeWind adds a `className` prop to React Native components at runtime, and
// declares the matching types via `nativewind/types` (which augments the
// `react-native` module). That augmentation is loaded through each app's
// `nativewind-env.d.ts`, but it does not reliably reach a file that lives in a
// workspace package and is resolved through a `node_modules` symlink — the
// augmentation and the component's `import ... from "react-native"` can bind to
// different resolutions of the module.
//
// This shim re-declares the `className` surface actually used by the shared
// components, resolved from THIS package's own context, so it always merges with
// the same `react-native` module the components import. It is intentionally
// minimal — extend it if a shared component starts using className on other RN
// primitives.
import "react-native";

declare module "react-native" {
  interface ViewProps {
    className?: string;
  }
  interface TextProps {
    className?: string;
  }
  interface ImageProps {
    className?: string;
  }
  interface PressableProps {
    className?: string;
  }
  interface ScrollViewProps {
    className?: string;
  }
}
