"use client";

import { useState } from "react";
import { fetchAdminJson } from "../_components/admin-fetch";

export interface McpTokenSummary {
  id: string;
  kind: string;
  staff_id: string;
  staff_name: string;
  role: string;
  token_prefix: string;
  scopes: string[];
  active: boolean;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

const ROLES = ["staff", "super_admin", "property_manager", "security_manager", "viewer"] as const;

interface Props {
  initialTokens: McpTokenSummary[];
  resources: string[];
  initialError: string;
}

interface MintedToken {
  id: string;
  token: string;
  tokenPrefix: string;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

/** A labelled, copyable code block. */
function Snippet({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-primary/60">{label}</p>
        <button
          type="button"
          className="btn-ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard blocked */
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="mt-1 overflow-x-auto rounded-lg bg-primary/5 px-3 py-2 text-xs leading-relaxed text-primary">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const TOKEN_PLACEHOLDER = "emcp_PASTE_YOUR_TOKEN";

/**
 * Ready-to-paste MCP client setup. When `token` is provided (right after
 * minting) it is embedded in the snippets; otherwise a placeholder is used so
 * the instructions can be shown any time (the real token is hash-only and never
 * recoverable).
 */
function ClientSetup({ token }: { token?: string }) {
  const secret = token ?? TOKEN_PLACEHOLDER;
  const origin = typeof window !== "undefined" ? window.location.origin : "https://<your-app>";
  const url = `${origin}/api/mcp`;
  const name = "emberly";

  const claudeCode = `claude mcp add --transport http ${name} ${url} \\
  --header "Authorization: Bearer ${secret}"`;

  const codexToml = `# ~/.codex/config.toml
[mcp_servers.${name}]
command = "npx"
args = ["-y", "mcp-remote", "${url}", "--header", "Authorization: Bearer ${secret}"]`;

  const genericJson = JSON.stringify(
    {
      mcpServers: {
        [name]: {
          command: "npx",
          args: ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${secret}`],
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-primary/45">Connect an AI client</p>
      <p className="mt-1 text-xs text-muted">
        Read-only MCP server at <code>{url}</code>.{" "}
        {token ? (
          "The token is embedded below — treat these snippets as secrets."
        ) : (
          <>
            Replace <code>{TOKEN_PLACEHOLDER}</code> with the <code>emcp_…</code> token shown once when you create it.
          </>
        )}
      </p>
      <Snippet label="Claude Code (terminal)" code={claudeCode} />
      <Snippet label="Codex CLI — ~/.codex/config.toml" code={codexToml} />
      <Snippet label="Claude Desktop / generic mcp.json" code={genericJson} />
      <p className="mt-2 text-[11px] text-muted">
        Codex and Claude Desktop reach the HTTP endpoint via the <code>mcp-remote</code> bridge (needs Node/npx).
        Claude Code connects to it directly.
      </p>
    </div>
  );
}

export function McpTokensClient({ initialTokens, resources, initialError }: Props) {
  const [tokens, setTokens] = useState<McpTokenSummary[]>(initialTokens);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  const [staffId, setStaffId] = useState("");
  const [staffName, setStaffName] = useState("");
  const [role, setRole] = useState<string>("staff");
  const [kind, setKind] = useState<"mcp" | "api_resman">("mcp");
  const [scopes, setScopes] = useState<string[]>([]);
  const [minted, setMinted] = useState<(MintedToken & { kind: string }) | null>(null);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    try {
      const res = await fetchAdminJson<{ data: McpTokenSummary[] }>("/api/admin/mcp-tokens");
      setTokens(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh tokens");
    }
  }

  function toggleScope(name: string) {
    setScopes((prev) => (prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]));
  }

  async function mint(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetchAdminJson<{ data: MintedToken }>("/api/admin/mcp-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ staffId: staffId.trim(), staffName: staffName.trim(), role, kind, scopes }),
      });
      setMinted({ ...res.data, kind });
      setCopied(false);
      setStaffId("");
      setStaffName("");
      setRole("staff");
      setKind("mcp");
      setScopes([]);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mint token");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revoke this token? Any client using it will immediately lose access.")) return;
    setError("");
    try {
      await fetchAdminJson(`/api/admin/mcp-tokens/${id}`, { method: "DELETE" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke token");
    }
  }

  async function copyToken() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <p className="admin-kicker">Integrations</p>
          <h1 className="text-2xl font-semibold text-primary">Access Tokens</h1>
          <p className="mt-1 text-sm text-muted">
            Per-staff bearer tokens for the MCP server (<code>/api/mcp</code>) and the private REST API
            (<code>/api/resman</code>). Only the hash is stored — the token is shown once at creation.
          </p>
        </div>
      </div>

      {error ? <p className="mb-4 text-sm font-semibold text-red-600">{error}</p> : null}

      {/* Always-available setup reference (uses a token placeholder). */}
      <details className="card mb-6 px-5 py-4">
        <summary className="cursor-pointer list-none text-sm font-semibold text-primary marker:hidden">
          <span className="inline-flex items-center gap-2">
            <span className="text-primary/40">▸</span>
            How to connect an AI client (Claude Code, Codex, Claude Desktop)
          </span>
        </summary>
        <ClientSetup />
      </details>

      {minted ? (
        <div className="card mb-6 border-2 border-accent px-5 py-4">
          <p className="text-sm font-semibold text-primary">
            Token created — copy it now. It will not be shown again.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <code className="flex-1 overflow-x-auto rounded-lg bg-primary/5 px-3 py-2 text-sm text-primary">
              {minted.token}
            </code>
            <button type="button" className="btn-primary" onClick={copyToken}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setMinted(null)}>
              Done
            </button>
          </div>
          {minted.kind === "mcp" ? <ClientSetup token={minted.token} /> : null}
        </div>
      ) : null}

      <form onSubmit={mint} className="card mb-6 px-5 py-4">
        <p className="mb-4 text-xs font-semibold uppercase text-primary/45">Create a token</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="admin-label" htmlFor="staffId">
              Staff ID
            </label>
            <input
              id="staffId"
              className="admin-input w-full"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              placeholder="e.g. jdoe"
              required
            />
          </div>
          <div>
            <label className="admin-label" htmlFor="staffName">
              Staff Name
            </label>
            <input
              id="staffName"
              className="admin-input w-full"
              value={staffName}
              onChange={(e) => setStaffName(e.target.value)}
              placeholder="e.g. Jane Doe"
              required
            />
          </div>
          <div>
            <label className="admin-label" htmlFor="role">
              Role
            </label>
            <select
              id="role"
              className="admin-input w-full"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="admin-label" htmlFor="kind">
              Token Type
            </label>
            <select
              id="kind"
              className="admin-input w-full"
              value={kind}
              onChange={(e) => setKind(e.target.value === "api_resman" ? "api_resman" : "mcp")}
            >
              <option value="mcp">MCP (AI clients)</option>
              <option value="api_resman">API (/api/resman)</option>
            </select>
          </div>
        </div>

        <div className="mt-4">
          <p className="admin-label">Scopes (optional — none = all resources)</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {resources.map((name) => {
              const on = scopes.includes(name);
              return (
                <button
                  type="button"
                  key={name}
                  onClick={() => toggleScope(name)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                    on
                      ? "border-accent bg-accent/10 text-primary"
                      : "border-line text-muted hover:bg-primary/5"
                  }`}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-5">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Creating…" : "Create token"}
          </button>
        </div>
      </form>

      <div className="card overflow-x-auto">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Staff</th>
              <th>Role</th>
              <th>Type</th>
              <th>Token</th>
              <th>Scopes</th>
              <th>Status</th>
              <th>Last used</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-5 py-12 text-center text-sm text-muted">
                  No tokens yet.
                </td>
              </tr>
            ) : (
              tokens.map((t) => {
                const revoked = !t.active || t.revoked_at !== null;
                return (
                  <tr key={t.id}>
                    <td className="text-primary">
                      <span className="font-semibold">{t.staff_name}</span>
                      <span className="block text-xs text-muted">{t.staff_id}</span>
                    </td>
                    <td className="text-muted">{t.role}</td>
                    <td className="text-xs font-semibold text-primary">{t.kind === "api_resman" ? "API" : "MCP"}</td>
                    <td className="tabular-nums text-muted">{t.token_prefix}…</td>
                    <td className="text-xs text-muted">
                      {t.scopes.length === 0 ? "all" : t.scopes.join(", ")}
                    </td>
                    <td>
                      <span className={revoked ? "text-sm font-semibold text-red-600" : "text-sm font-semibold text-primary"}>
                        {revoked ? "Revoked" : "Active"}
                      </span>
                    </td>
                    <td className="tabular-nums text-muted">{formatDate(t.last_used_at)}</td>
                    <td className="tabular-nums text-muted">{formatDate(t.created_at)}</td>
                    <td className="text-right">
                      {revoked ? null : (
                        <button type="button" className="btn-danger" onClick={() => revoke(t.id)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
