/**
 * Emberly Security design system — 1:1 with the SwiftUI app
 * (AppDesignSystem.swift / AppStatusTint.swift / AppSettings accent themes).
 * Brand navy + olive; warm-paper light identity; dark mode via `dark:` variants.
 * The accent axis is runtime-swappable (see global.css / settings store).
 */
const accent = (v) => `rgb(var(${v}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    // Shared @emberly/ui source: NativeWind generates styles from `content`
    // globs, which do NOT reach a workspace package unless listed explicitly.
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx}",
  ],
  presets: [require("nativewind/preset")],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // — Brand identity —
        navy: "#091B54",
        slate: "#4C556F",
        muted: "#70788F",
        olive: {
          DEFAULT: "#A2A921",
          dark: "#848F0D",
          top: "#B1B822",
          bottom: "#8D950E",
          glow: "#B4B925",
        },
        slateNavy: "#2B3B5A",
        chevron: "#3E4F6E",
        syncTeal: "#19B885",
        // — Status —
        status: {
          ready: "#33A666",
          affirm: "#8FD36A",
          blocked: "#D1382E",
          warning: "#E38736",
          attention: "#EB852E",
          hold: "#D19438",
          info: "#458ADB",
          accentBlue: "#3D87E0",
          closed: "#3D9461",
          review: "#7A6BC7",
          denied: "#D12E21",
        },
        // — Leasing classification —
        classify: {
          ruby: "#9C101F",
          diamond: "#388FC7",
          legacy: "#9E805C",
          lux: "#C79433",
        },
        // — Warm-paper light surfaces —
        paper: {
          top: "#FCF8F0",
          mid: "#F8F6EE",
          foot: "#F1F5F2",
        },
        card: {
          top: "#FBF7F0",
          mid: "#F4F6EF",
          midSoft: "#F1F6EF",
          coolFoot: "#EEF2F7",
          coolDeep: "#ECF1F7",
        },
        initials: "#E9E6D1",
        viewfinder: "#E8EDE6",
        tooltip: "#1E1F24",
        // — Dark-mode surfaces —
        night: {
          top: "#14181F",
          mid: "#1A1A1F",
          foot: "#12171A",
          surface: "#1B1D20",
          mapEdge: "#0D0F14",
        },
        // — Map camera cones —
        camera: {
          day: "#3399FF",
          night: "#FF991A",
        },
        // — Runtime accent (default coral) —
        accent: {
          header: accent("--accent-header"),
          selection: accent("--accent-selection"),
          metric: accent("--accent-metric-value"),
        },
      },
      borderRadius: {
        compact: "10px",
        row: "12px",
        quiet: "14px",
        control: "18px",
        panel: "20px",
        feature: "22px",
        metric: "26px",
      },
      spacing: {
        controlH: "12px",
        controlV: "8px",
        panel: "14px",
        material: "18px",
        screen: "24px",
        screenWide: "34px",
      },
      fontSize: {
        // role-named scale from the extraction (px)
        wordmarkSub: ["8px", { lineHeight: "10px" }],
        micro: ["10px", { lineHeight: "13px" }],
        badge: ["12px", { lineHeight: "16px" }],
        rowSub: ["13px", { lineHeight: "17px" }],
        chip: ["14px", { lineHeight: "18px" }],
        subtitle: ["16px", { lineHeight: "21px" }],
        rowTitle: ["17px", { lineHeight: "22px" }],
        scanTitle: ["19px", { lineHeight: "24px" }],
        wordmark: ["20px", { lineHeight: "24px" }],
        section: ["20px", { lineHeight: "26px" }],
        detailName: ["25px", { lineHeight: "30px" }],
        metricValue: ["28px", { lineHeight: "32px" }],
        h1: ["34px", { lineHeight: "40px" }],
      },
      fontWeight: {
        // convenience aliases used across the app
        medium: "500",
        semibold: "600",
        bold: "700",
      },
    },
  },
  plugins: [],
};
