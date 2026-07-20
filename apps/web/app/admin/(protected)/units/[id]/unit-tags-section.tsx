"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAdminJson } from "../../_components/admin-fetch";

interface Tag {
  id: string;
  unitNumber: string;
  label: string;
  colorHex: string;
  expiryKind: "never" | "date" | "duration" | "move_out" | "status_change";
  expiresAt: string | null;
  statusTrigger: string | null;
  createdByDisplayName: string | null;
  createdAt: string | null;
}

// The property-map tag palette.
const PALETTE = ["#D1382E", "#E38736", "#E3B23A", "#2E8A5F", "#458ADB", "#7A6BC7", "#5B7C99", "#091B54"];

const EXPIRY_OPTIONS: { kind: Tag["expiryKind"]; label: string; hint: string }[] = [
  { kind: "never", label: "Never", hint: "Stays until removed" },
  { kind: "date", label: "On a date", hint: "Auto-removes that day" },
  { kind: "duration", label: "After a set time", hint: "Days from now" },
  { kind: "move_out", label: "When tenant moves out", hint: "Deletes when the unit turns vacant" },
  { kind: "status_change", label: "When lease status changes", hint: "Watches the current status" },
];

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/** Human badge for a tag's expiration rule. */
function expiryBadge(tag: Tag): { text: string; tone: "auto" | "soon" | "perm" } {
  switch (tag.expiryKind) {
    case "move_out":
      return { text: "⛓ until move-out", tone: "auto" };
    case "status_change":
      return { text: `↻ while ${tag.statusTrigger ?? "status"}`, tone: "auto" };
    case "date":
    case "duration": {
      if (!tag.expiresAt) return { text: "expiring", tone: "soon" };
      const d = daysUntil(tag.expiresAt);
      return { text: d <= 1 ? "⏱ expires today" : `⏱ ${d} days left`, tone: "soon" };
    }
    default:
      return { text: "Permanent", tone: "perm" };
  }
}

const BADGE_TONE: Record<string, string> = {
  auto: "text-[#7A6BC7] bg-[#7A6BC7]/12",
  soon: "text-[#E38736] bg-[#E38736]/14",
  perm: "text-muted bg-primary/[0.06]",
};

export function UnitTagsSection({ unitNumber }: { unitNumber: string }) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // draft
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(PALETTE[6]);
  const [kind, setKind] = useState<Tag["expiryKind"]>("never");
  const [expiresOn, setExpiresOn] = useState("");
  const [durationDays, setDurationDays] = useState("30");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchAdminJson<{ tags: Tag[] }>(
        `/api/admin/unit-tags?unit=${encodeURIComponent(unitNumber)}`,
      );
      setTags(data.tags);
    } catch {
      /* leave prior tags; a poll or reopen retries */
    } finally {
      setLoading(false);
    }
  }, [unitNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetDraft = () => {
    setLabel("");
    setColor(PALETTE[6]);
    setKind("never");
    setExpiresOn("");
    setDurationDays("30");
  };

  const create = async () => {
    if (!label.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        unitNumber,
        label: label.trim(),
        colorHex: color,
        expiryKind: kind,
      };
      if (kind === "date") payload.expiresOn = expiresOn;
      if (kind === "duration") payload.durationDays = Number(durationDays);
      const data = await fetchAdminJson<{ tag: Tag }>("/api/admin/unit-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setTags((prev) => [...prev, data.tag]);
      resetDraft();
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add tag");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setTags((prev) => prev.filter((t) => t.id !== id));
    try {
      await fetchAdminJson(`/api/admin/unit-tags/${id}`, { method: "DELETE" });
    } catch {
      void load(); // put it back if the delete didn't take
    }
  };

  const dateInvalid = kind === "date" && !expiresOn;

  return (
    <section className="card px-5 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-primary">Tags</h2>
        {!adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-primaryLight"
          >
            + Add tag
          </button>
        ) : null}
      </div>

      {/* chips */}
      {loading ? (
        <p className="text-sm text-muted">Loading tags…</p>
      ) : tags.length === 0 && !adding ? (
        <p className="text-sm text-muted">
          No tags yet. Tags are shared with the guard iPads and can expire on their own.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tags.map((t) => {
            const badge = expiryBadge(t);
            return (
              <span
                key={t.id}
                className="group inline-flex items-center gap-2 rounded-full border py-1.5 pl-2.5 pr-1.5 text-[13px] font-semibold"
                style={{
                  color: t.colorHex,
                  backgroundColor: `${t.colorHex}18`,
                  borderColor: `${t.colorHex}44`,
                }}
                title={t.createdByDisplayName ? `Added by ${t.createdByDisplayName}` : undefined}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.colorHex }} />
                {t.label}
                <span
                  className={`ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${BADGE_TONE[badge.tone]}`}
                >
                  {badge.text}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(t.id)}
                  aria-label={`Remove ${t.label}`}
                  className="ml-0.5 grid h-4 w-4 place-items-center rounded-full text-current opacity-60 transition-opacity hover:opacity-100"
                  style={{ backgroundColor: `${t.colorHex}22` }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* editor */}
      {adding ? (
        <div className="mt-3 rounded-xl border border-primary/12 bg-cream/40 p-3.5">
          <div className="flex flex-col gap-3">
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !dateInvalid && void create()}
              placeholder="Tag label (e.g. Aggressive dog)"
              maxLength={48}
              className="w-full rounded-lg border border-primary/20 bg-white px-3 py-2 text-sm font-semibold text-primary"
            />

            <div className="flex items-center gap-2">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  onClick={() => setColor(c)}
                  className="h-6 w-6 rounded-lg transition-transform"
                  style={{
                    backgroundColor: c,
                    outline: color === c ? "2px solid var(--color-primary, #091B54)" : "none",
                    outlineOffset: "2px",
                  }}
                />
              ))}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-bold text-primary/70">Expiration</label>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {EXPIRY_OPTIONS.map((o) => (
                  <button
                    key={o.kind}
                    type="button"
                    onClick={() => setKind(o.kind)}
                    className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                      kind === o.kind
                        ? "border-accent bg-accent/12 ring-1 ring-accent"
                        : "border-primary/15 bg-white hover:border-primary/30"
                    }`}
                  >
                    <span className="text-[13px] font-bold text-primary">{o.label}</span>
                    <span className="text-[11px] text-muted">{o.hint}</span>
                  </button>
                ))}
              </div>

              {kind === "date" ? (
                <input
                  type="date"
                  value={expiresOn}
                  onChange={(e) => setExpiresOn(e.target.value)}
                  className="mt-2 rounded-lg border border-primary/20 bg-white px-3 py-1.5 text-sm font-semibold text-primary"
                />
              ) : null}
              {kind === "duration" ? (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={durationDays}
                    onChange={(e) => setDurationDays(e.target.value)}
                    className="w-20 rounded-lg border border-primary/20 bg-white px-3 py-1.5 text-center text-sm font-bold text-primary"
                  />
                  <span className="text-sm text-muted">days from now</span>
                </div>
              ) : null}
            </div>

            {error ? <p className="text-xs font-semibold text-red-600">{error}</p> : null}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  resetDraft();
                  setError(null);
                }}
                className="text-xs font-bold text-muted hover:text-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void create()}
                disabled={saving || !label.trim() || dateInvalid}
                className="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-bold text-primary transition-colors hover:bg-accent/90 disabled:opacity-50"
              >
                {saving ? "Adding…" : "Add tag"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
