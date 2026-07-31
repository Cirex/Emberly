# MCP Server Setup

Emberly exposes a **read-only staff MCP server** at `POST /api/mcp` (Streamable HTTP,
stateless). Its tools list and get the synced ResMan + MLGW mirror data through the same query
engine as the private REST API. Every request is gated by a **per-staff bearer token**
(`emcp_…`), and each tool call is attributed in `access_token_audit_log`.

This page shows how to connect the AI assistant of your choice. The pattern is the same
everywhere:

- **Native Streamable-HTTP clients** (Claude Code, Cursor, VS Code, Claude web/desktop
  connectors, ChatGPT connectors) point straight at the endpoint with an `Authorization`
  header.
- **stdio-only clients** (Codex, Gemini CLI, Zed, older configs) bridge to the HTTP endpoint
  with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), a tiny stdio↔HTTP proxy run
  via `npx` (needs Node on the machine).

The server is **read-only** — it never mutates ResMan/MLGW data.

It advertises three MCP capabilities: **tools** (seven), **prompts** (five canned analyses)
and **resources** (a scope-filtered schema catalog and a data-traps sheet). Clients that
support prompts and resources will surface those automatically; tool-only clients still get
the full query surface.

For what the tools actually *do* — searching, grouping, joining, and the handful of traps in
this data that will otherwise give you a confidently wrong number — see [[MCP Tools]].

---

## 1. Mint a token (do this first)

Admin portal → **Access Tokens** → *Create token* → Token Type **MCP**. The plaintext token
(`emcp_…`) is shown **once** at creation — only its hash is stored. The "token created" card
also shows ready-to-paste setup snippets with the token filled in for each client below.

- **Scopes are required.** A token with no scopes can read *nothing*. Grant resources
  explicitly (`units`, `work-orders`, …), or `*` for everything. This used to be the other
  way round — an empty list meant full access — which made "I forgot to set scopes" and
  "I meant to grant everything" indistinguishable. Existing tokens that list their resources
  are unaffected.
- Revoke at any time from the same page; the client loses access immediately.
- The token is a secret embedded in the client config — store the config securely and
  rotate/revoke as needed.
- **Each token gets 600 tool calls per 15 minutes.** Ample for real work; it exists to cap a
  runaway loop. Over the limit the client sees JSON-RPC error `-32003` and should retry later.

**Your endpoint URL** is your deployment origin + `/api/mcp`, e.g.
`https://emberly.example.com/api/mcp` (or `http://localhost:3010/api/mcp` in dev). Localhost
works with every client below (both the bridge and native HTTP clients reach it).

In the snippets, replace `https://<your-app>/api/mcp` with your endpoint and `emcp_…` with
your token.

---

## 2. Claude Code (terminal)

Native Streamable HTTP:

```bash
claude mcp add --transport http emberly https://<your-app>/api/mcp \
  --header "Authorization: Bearer emcp_…"
```

Then `claude mcp list` shows `emberly` connected. Remove with `claude mcp remove emberly`.

## 3. Claude Desktop / Claude web (Connectors)

In Claude, go to **Settings → Connectors → Add custom connector**, give it a name (`Emberly`)
and the endpoint URL. For a header-authenticated server, add the `Authorization: Bearer emcp_…`
header if the connector UI exposes custom headers; otherwise use the `mcp-remote` bridge in
the desktop config file (§ generic `mcp.json` below), which is the most reliable path for a
bearer-token server.

## 4. Cursor

Cursor supports Streamable HTTP directly. **Settings → MCP → Add new MCP server**, or edit
`~/.cursor/mcp.json` (global) / `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "emberly": {
      "url": "https://<your-app>/api/mcp",
      "headers": { "Authorization": "Bearer emcp_…" }
    }
  }
}
```

## 5. VS Code (GitHub Copilot agent mode)

Native HTTP. Create `.vscode/mcp.json` in the workspace (or run **MCP: Add Server** from the
command palette):

```json
{
  "servers": {
    "emberly": {
      "type": "http",
      "url": "https://<your-app>/api/mcp",
      "headers": { "Authorization": "Bearer emcp_…" }
    }
  }
}
```

## 6. Windsurf

Windsurf's config (`~/.codeium/windsurf/mcp_config.json`) uses the `serverUrl` form for HTTP
servers:

```json
{
  "mcpServers": {
    "emberly": {
      "serverUrl": "https://<your-app>/api/mcp",
      "headers": { "Authorization": "Bearer emcp_…" }
    }
  }
}
```

## 7. Cline (VS Code extension)

Open the Cline **MCP Servers** panel → **Configure MCP Servers**, and add to the JSON:

```json
{
  "mcpServers": {
    "emberly": {
      "type": "streamableHttp",
      "url": "https://<your-app>/api/mcp",
      "headers": { "Authorization": "Bearer emcp_…" }
    }
  }
}
```

## 8. Codex CLI (`~/.codex/config.toml`)

Codex configures MCP servers as local (stdio) processes, so bridge with `mcp-remote`:

```toml
[mcp_servers.emberly]
command = "npx"
args = ["-y", "mcp-remote", "https://<your-app>/api/mcp", "--header", "Authorization: Bearer emcp_…"]
```

## 9. Gemini CLI (`~/.gemini/settings.json`)

Gemini CLI launches MCP servers as commands — use the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "emberly": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-app>/api/mcp", "--header", "Authorization: Bearer emcp_…"]
    }
  }
}
```

## 10. Zed

In `settings.json`, add a `context_servers` entry using the `mcp-remote` bridge:

```json
{
  "context_servers": {
    "emberly": {
      "command": {
        "path": "npx",
        "args": ["-y", "mcp-remote", "https://<your-app>/api/mcp", "--header", "Authorization: Bearer emcp_…"]
      }
    }
  }
}
```

## 11. ChatGPT / OpenAI (custom connectors)

In ChatGPT (Settings → Connectors, on plans that support custom MCP connectors) or the OpenAI
Responses API, add a remote MCP server with the endpoint URL and an `Authorization: Bearer
emcp_…` header. Because the server is read-only (search/fetch-style tools only), it fits the
connector model directly — no bridge needed.

## 12. Generic `mcp.json` (any stdio client)

Any client that spawns stdio MCP servers can use the `mcp-remote` bridge — this is the
universal fallback:

```json
{
  "mcpServers": {
    "emberly": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-app>/api/mcp", "--header", "Authorization: Bearer emcp_…"]
    }
  }
}
```

---

## Which clients need the bridge?

| Client | Transport | Bridge? |
| --- | --- | --- |
| Claude Code | Streamable HTTP | No — native |
| Cursor | Streamable HTTP | No — native |
| VS Code (Copilot) | Streamable HTTP | No — native |
| Windsurf | Streamable HTTP | No — native |
| Cline | Streamable HTTP | No — native |
| ChatGPT / OpenAI connectors | Remote MCP | No — native |
| Claude Desktop | via connector or bridge | Bridge is most reliable for bearer auth |
| Codex CLI | stdio only | Yes — `mcp-remote` |
| Gemini CLI | stdio only | Yes — `mcp-remote` |
| Zed | stdio only | Yes — `mcp-remote` |

## Notes

- The `mcp-remote` bridge needs Node / `npx` on the machine running the client.
- Client config formats change as tools evolve — if a snippet's key names have drifted, the
  concepts are constant: **endpoint URL + `Authorization: Bearer emcp_…`**, directly for HTTP
  clients or via `mcp-remote` for stdio clients.
- The token grants read access to synced property data. Treat the config file like any other
  credential store, and revoke from the Access Tokens page the moment a device is lost or a
  teammate leaves.
