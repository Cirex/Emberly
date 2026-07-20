export function normalizeUnitLabel(value: string | null | undefined): string {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";

  return trimmed.replace(/^(?:unit|apt|apartment|#)\s+/i, "").trim() || trimmed;
}

export function formatUnitDisplay(value: string | null | undefined): string {
  return normalizeUnitLabel(value) || "—";
}
