# Emberly Wiki

**Emberly is a multi-tenant apartment access and property-management platform** — one
connected system for a property's staff, residents, guards, and maintenance techs, backed by
a single source of truth synced from ResMan (property management) and MLGW (utility billing).

This wiki is the full documentation. For a quick orientation and local-setup steps, see the
repository [README](https://github.com/Cirex/Emberly#readme).

## Pages

- **[[Architecture]]** — the apps, the sync worker, Supabase, and how data flows between them.
- **[[Deployment]]** — the end-to-end production runbook: Supabase, Sentry, PostHog, Coolify
  (web + sync worker), and EAS (the three iOS apps), plus the web app's Docker/build-context
  internals.
- **[[Environment Variables]]** — every variable each app reads, where it goes, and which are
  secret.
- **[[MCP Server Setup]]** — connect the AI assistant of your choice (Claude, Codex, Cursor,
  Windsurf, VS Code, Gemini, and more) to Emberly's read-only staff MCP server.

## The applications at a glance

| App | Package | Platform | Purpose |
| --- | --- | --- | --- |
| Web | `@emberly/web` | Next.js on Coolify | Staff admin portal, resident web, and the backend API every mobile app calls. |
| Resident | `@emberly/resident` | Expo / iOS (EAS) | Residents manage their guest passes. |
| Security | `@emberly/security` | Expo / iPad + iPhone (EAS) | Guard app: tenants, property map, QR scanner, guest passes. |
| Maintenance | `@emberly/maintenance` | Expo / iOS (EAS) | Work orders, make-ready board, property map, "My Day" routing. |
| Sync worker | `@emberly/sync` | Coolify cron worker | Mirrors ResMan + MLGW into Supabase. |
| Core | `@emberly/core` | Shared package | Framework-free domain logic and contracts. |
