import nextVitals from "eslint-config-next/core-web-vitals";

export default [
  ...(Array.isArray(nextVitals) ? nextVitals : [nextVitals]),
  {
    settings: { react: { version: "19" } },
    // The React Compiler rules (eslint-plugin-react-hooks v6) are opt-in
    // strictness this codebase predates; keep them visible as warnings rather
    // than blocking CI. The classic correctness rules (exhaustive-deps,
    // rules-of-hooks) stay at their config default.
    rules: {
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/refs": "warn",
    },
  },
];
