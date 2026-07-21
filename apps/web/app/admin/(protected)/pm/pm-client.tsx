"use client";

import { useState } from "react";
import type {
  PmCadence,
  PmOverview,
  PmScopeType,
  PmTemplateWithStats,
} from "@/lib/pm-templates";
import { AdminButton, AdminField, AdminSelect } from "../../_components/admin-ui";
import { fetchAdminJson } from "../_components/admin-fetch";

const CADENCES: readonly PmCadence[] = ["monthly", "quarterly", "semiannual", "annual"];
const SCOPE_TYPES: readonly PmScopeType[] = ["all", "building", "classification"];

const CADENCE_LABELS: Record<PmCadence, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Semiannual",
  annual: "Annual",
};

const SCOPE_TYPE_LABELS: Record<PmScopeType, string> = {
  all: "All units",
  building: "Building",
  classification: "Classification",
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-07" → "Jul 2026". */
function roundLabel(roundKey: string): string {
  const [y, m] = roundKey.split("-").map((part) => Number.parseInt(part, 10));
  if (!y || !m || m < 1 || m > 12) return roundKey;
  return `${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`;
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Client-side mirror of scopeSummary (the lib module is server-only at runtime). */
function scopeText(t: PmTemplateWithStats): string {
  if (t.scope_type === "all") return "All units";
  const list = t.scope_values.filter((v) => v.trim().length > 0).join(", ") || "none set";
  return t.scope_type === "building" ? `Buildings: ${list}` : `Classification: ${list}`;
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="card px-4 py-3.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-primary/45">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums leading-tight text-primary">{value}</p>
      <p className="mt-0.5 text-[11.5px] text-muted">{detail}</p>
    </div>
  );
}

function RoundMeter({ done, total }: { done: number; total: number }) {
  if (total === 0) return <span className="text-xs text-muted">No tasks yet</span>;
  const pct = Math.round((done / total) * 100);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-primary/[0.08]">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${Math.max(2, pct)}%`,
            background: pct >= 100 ? "var(--color-ok)" : "var(--color-primary-light)",
          }}
        />
      </span>
      <span className="text-xs font-semibold tabular-nums text-muted">
        {done}/{total}
      </span>
    </span>
  );
}

interface FormState {
  name: string;
  category: string;
  cadence: PmCadence;
  anchorMonth: string; // "" = null (January)
  scopeType: PmScopeType;
  scopeValues: string; // comma-separated
  active: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  category: "",
  cadence: "monthly",
  anchorMonth: "",
  scopeType: "all",
  scopeValues: "",
  active: true,
};

function formFor(t: PmTemplateWithStats): FormState {
  return {
    name: t.name,
    category: t.category,
    cadence: t.cadence,
    anchorMonth: t.anchor_month == null ? "" : String(t.anchor_month),
    scopeType: t.scope_type,
    scopeValues: t.scope_values.join(", "),
    active: t.active,
  };
}

function formBody(form: FormState) {
  return {
    name: form.name.trim(),
    category: form.category.trim(),
    cadence: form.cadence,
    anchorMonth: form.anchorMonth === "" ? null : Number.parseInt(form.anchorMonth, 10),
    scopeType: form.scopeType,
    scopeValues: form.scopeValues
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
    active: form.active,
  };
}

type Editing = { mode: "create" } | { mode: "edit"; id: string } | null;

export function PmClient({
  initialOverview,
  canManage,
  initialError,
}: {
  initialOverview: PmOverview | null;
  canManage: boolean;
  initialError: string;
}) {
  const [overview, setOverview] = useState<PmOverview | null>(initialOverview);
  const [editing, setEditing] = useState<Editing>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState("");
  const [roundsTemplateId, setRoundsTemplateId] = useState("");

  const noManageTitle = canManage ? undefined : "Requires super admin";

  async function refresh() {
    const res = await fetchAdminJson<{ data: PmOverview }>("/api/admin/pm-templates");
    setOverview(res.data);
  }

  function startCreate() {
    setError("");
    setNotice("");
    setForm(EMPTY_FORM);
    setEditing({ mode: "create" });
  }

  function startEdit(t: PmTemplateWithStats) {
    setError("");
    setNotice("");
    setForm(formFor(t));
    setEditing({ mode: "edit", id: t.id });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const body = formBody(form);
      if (editing.mode === "create") {
        await fetchAdminJson("/api/admin/pm-templates", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        setNotice(`Created template "${body.name}".`);
      } else {
        await fetchAdminJson(`/api/admin/pm-templates/${editing.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        setNotice(`Updated template "${body.name}".`);
      }
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(t: PmTemplateWithStats) {
    setError("");
    setNotice("");
    setBusyId(t.id);
    try {
      await fetchAdminJson(`/api/admin/pm-templates/${t.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !t.active }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update template");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(t: PmTemplateWithStats) {
    const ok = window.confirm(
      `Delete "${t.name}"? Every generated task for this template (all rounds, including completed history) is deleted with it.`,
    );
    if (!ok) return;
    setError("");
    setNotice("");
    setBusyId(t.id);
    try {
      await fetchAdminJson(`/api/admin/pm-templates/${t.id}`, { method: "DELETE" });
      setNotice(`Deleted template "${t.name}".`);
      if (roundsTemplateId === t.id) setRoundsTemplateId("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete template");
    } finally {
      setBusyId(null);
    }
  }

  if (!overview) {
    return (
      <div className="admin-page">
        <div className="card px-5 py-4">
          <p className="text-sm font-semibold text-red-600">
            {initialError || "Failed to load preventive maintenance templates."}
          </p>
        </div>
      </div>
    );
  }

  const { templates, summary } = overview;
  const roundRows = templates
    .filter((t) => !roundsTemplateId || t.id === roundsTemplateId)
    .flatMap((t) =>
      t.stats.rounds.map((r) => ({ ...r, templateId: t.id, templateName: t.name })),
    )
    .sort((a, b) => b.roundKey.localeCompare(a.roundKey) || a.templateName.localeCompare(b.templateName));

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Property Management</p>
          <h1 className="text-2xl font-semibold text-primary">Preventive maintenance</h1>
          <p className="mt-1 text-sm text-muted">
            Recurring maintenance templates. The nightly sync expands active templates into
            per-unit task rounds — this page only defines the schedule.
          </p>
        </div>
        <AdminButton
          icon="plus"
          onClick={startCreate}
          disabled={!canManage || saving}
          title={noManageTitle}
        >
          New template
        </AdminButton>
      </div>

      {error ? <p className="mb-4 text-sm font-semibold text-red-600">{error}</p> : null}
      {notice ? <p className="mb-4 text-sm font-semibold text-primary">{notice}</p> : null}

      {/* Header stats */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Active templates"
          value={summary.activeTemplates.toLocaleString()}
          detail={`${templates.length.toLocaleString()} total`}
        />
        <StatCard
          label="Due this round"
          value={summary.dueThisRound.toLocaleString()}
          detail="pending tasks in the current period"
        />
        <StatCard
          label="Round completion"
          value={summary.currentRoundPercent == null ? "—" : `${summary.currentRoundPercent}%`}
          detail={`${summary.currentRoundDone.toLocaleString()} of ${summary.currentRoundTotal.toLocaleString()} done`}
        />
        <StatCard
          label="On-time rate"
          value={summary.overallOnTimePercent == null ? "—" : `${summary.overallOnTimePercent}%`}
          detail="done tasks completed by their due date"
        />
      </div>

      {/* Editor */}
      {editing ? (
        <form onSubmit={save} className="card mb-4 px-5 py-4">
          <p className="mb-3 text-[13px] font-bold text-primary">
            {editing.mode === "create" ? "New template" : "Edit template"}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <AdminField label="Name">
              <input
                className="admin-input w-56"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="HVAC filter change"
                required
              />
            </AdminField>
            <AdminField label="Category">
              <input
                className="admin-input w-40"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                placeholder="HVAC"
              />
            </AdminField>
            <AdminField label="Cadence">
              <AdminSelect
                value={form.cadence}
                onChange={(e) => setForm((f) => ({ ...f, cadence: e.target.value as PmCadence }))}
              >
                {CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {CADENCE_LABELS[c]}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
            <AdminField label="Anchor month">
              <AdminSelect
                value={form.anchorMonth}
                onChange={(e) => setForm((f) => ({ ...f, anchorMonth: e.target.value }))}
              >
                <option value="">January (default)</option>
                {MONTH_NAMES.map((name, i) => (
                  <option key={name} value={String(i + 1)}>
                    {name}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
            <AdminField label="Scope">
              <AdminSelect
                value={form.scopeType}
                onChange={(e) => setForm((f) => ({ ...f, scopeType: e.target.value as PmScopeType }))}
              >
                {SCOPE_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {SCOPE_TYPE_LABELS[s]}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
            {form.scopeType !== "all" ? (
              <AdminField
                label={form.scopeType === "building" ? "Buildings (comma-separated)" : "Classifications (comma-separated)"}
              >
                <input
                  className="admin-input w-56"
                  value={form.scopeValues}
                  onChange={(e) => setForm((f) => ({ ...f, scopeValues: e.target.value }))}
                  placeholder={form.scopeType === "building" ? "3, 4" : "2BR"}
                />
              </AdminField>
            ) : null}
            <label className="mb-2 flex items-center gap-2 text-sm font-medium text-primary">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
              />
              Active
            </label>
          </div>
          <p className="mt-2 text-[11.5px] text-muted">
            Anchor month positions the cycle — e.g. anchoring an annual filter change to October
            runs it before heating season. Monthly templates ignore it.
          </p>
          <div className="mt-3 flex gap-2">
            <AdminButton icon="save" type="submit" disabled={saving}>
              {saving ? "Saving…" : editing.mode === "create" ? "Create template" : "Save changes"}
            </AdminButton>
            <AdminButton variant="ghost" type="button" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </AdminButton>
          </div>
        </form>
      ) : null}

      {/* Templates table */}
      <div className="card mb-4 overflow-x-auto">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Template</th>
              <th>Cadence</th>
              <th>Scope</th>
              <th>This round</th>
              <th>On-time</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-sm text-muted">
                  No templates yet. Create one to start generating maintenance rounds.
                </td>
              </tr>
            ) : (
              templates.map((t) => (
                <tr key={t.id}>
                  <td className="text-primary">
                    <span className="font-semibold">{t.name}</span>
                    {t.category ? (
                      <span className="block text-xs text-muted">{t.category}</span>
                    ) : null}
                  </td>
                  <td>
                    <span className="whitespace-nowrap rounded-md bg-primary/[0.07] px-2 py-0.5 text-[11px] font-semibold text-primary">
                      {CADENCE_LABELS[t.cadence]}
                    </span>
                  </td>
                  <td className="text-muted">{scopeText(t)}</td>
                  <td>
                    <RoundMeter done={t.stats.currentDone} total={t.stats.currentTotal} />
                  </td>
                  <td className="tabular-nums text-muted">
                    {t.stats.onTimePercent == null ? "—" : `${t.stats.onTimePercent}%`}
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`status-pill ${t.active ? "pill-ok" : "pill-neutral"} ${canManage ? "cursor-pointer" : "cursor-default"}`}
                      disabled={!canManage || busyId === t.id}
                      onClick={() => toggleActive(t)}
                      title={noManageTitle ?? (t.active ? "Deactivate — stops new rounds" : "Activate — resumes rounds")}
                    >
                      <span className="pill-dot" />
                      {busyId === t.id ? "Saving…" : t.active ? "Active" : "Inactive"}
                    </button>
                  </td>
                  <td className="text-right">
                    <span className="inline-flex items-center gap-2">
                      <AdminButton
                        variant="link"
                        onClick={() => startEdit(t)}
                        disabled={!canManage || busyId === t.id}
                        title={noManageTitle}
                      >
                        Edit
                      </AdminButton>
                      <AdminButton
                        variant="danger-link"
                        onClick={() => remove(t)}
                        disabled={!canManage || busyId === t.id}
                        title={noManageTitle}
                      >
                        Delete
                      </AdminButton>
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Rounds */}
      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
          <div>
            <p className="text-[13px] font-bold text-primary">Recent rounds</p>
            <p className="text-[11.5px] text-muted">Generated task rounds, newest first.</p>
          </div>
          <AdminSelect
            aria-label="Filter rounds by template"
            value={roundsTemplateId}
            onChange={(e) => setRoundsTemplateId(e.target.value)}
          >
            <option value="">All templates</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </AdminSelect>
        </div>
        <table className="admin-table mt-2">
          <thead>
            <tr>
              <th>Round</th>
              {!roundsTemplateId ? <th>Template</th> : null}
              <th>Due date</th>
              <th>Progress</th>
              <th>Skipped</th>
            </tr>
          </thead>
          <tbody>
            {roundRows.length === 0 ? (
              <tr>
                <td colSpan={roundsTemplateId ? 4 : 5} className="px-5 py-10 text-center text-sm text-muted">
                  No rounds generated yet — the nightly sync creates them from active templates.
                </td>
              </tr>
            ) : (
              roundRows.map((r) => (
                <tr key={`${r.templateId}:${r.roundKey}`}>
                  <td className="font-semibold text-primary">{roundLabel(r.roundKey)}</td>
                  {!roundsTemplateId ? <td className="text-muted">{r.templateName}</td> : null}
                  <td className="whitespace-nowrap tabular-nums text-muted">{fmtDate(r.dueDate)}</td>
                  <td>
                    <RoundMeter done={r.done} total={r.total} />
                  </td>
                  <td className="tabular-nums text-muted">{r.skipped}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
