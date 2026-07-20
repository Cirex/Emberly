/**
 * Emberly brand palette. Used directly by the resident app and mapped into
 * the web Tailwind theme (where `text` → textNavy, `textSecondary` → muted,
 * and `border` → line).
 */
export const Colors = {
  primary: "#26348A",
  primaryLight: "#3A48A0",
  accent: "#B4B53A",
  cream: "#F4F1E6",
  creamWarm: "#F7F2E6",
  creamDeep: "#E7E1CF",
  white: "#FFFFFF",
  glass: "rgba(255, 255, 255, 0.58)",
  glassStrong: "rgba(255, 255, 255, 0.78)",
  glassBorder: "rgba(255, 255, 255, 0.72)",
  error: "#D32F2F",
  success: "#2E7D32",
  warning: "#B8860B",
  text: "#1B255F",
  textSecondary: "#6A6F8A",
  border: "#DDE1F0",
  background: "#FFFFFF",
} as const;
