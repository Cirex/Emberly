import type { Config } from "tailwindcss";
import { Colors } from "@emberly/core";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: Colors.primary,
        primaryLight: Colors.primaryLight,
        accent: Colors.accent,
        cream: Colors.cream,
        textNavy: Colors.text,
        muted: Colors.textSecondary,
        line: Colors.border,
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
