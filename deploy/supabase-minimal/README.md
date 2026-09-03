# Supabase — minimal stack for Coolify

Five services instead of the stock eleven. Built to be deployed **many times on
one host** without collisions.

| | stock | this |
|---|---|---|
| services | 11 | **5** (`db` `auth` `rest` `storage` `kong`) |
| measured RAM | 955–1419 MiB | **~600 MiB** |
| host ports published | 2 | **0** |

Validated with `docker compose config`: parses clean, zero published ports,
and every `depends_on` targets `db` only.

## Deploy

1. **Mint the keys.** `ANON_KEY` and `SERVICE_ROLE_KEY` are HS256 JWTs *signed
   with* `JWT_SECRET` — not random strings, which is why Coolify's password
   generator can't make them.

   ```bash
   JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 64)
   echo "JWT_SECRET=$JWT_SECRET"
   ./mint-keys.sh "$JWT_SECRET"
   ```

2. In Coolify: **New Resource → Docker Compose**, paste `docker-compose.yml`.

3. Paste `.env.example` into **Environment Variables**, filled in. Every
   deployment needs its **own** `JWT_SECRET` — reuse it and a token minted by
   one instance authenticates against the other.

4. Set the domain on the **`kong`** service. Coolify populates
   `SERVICE_FQDN_KONG_8000` and issues TLS. Nothing else is reachable.

Your client config is then `SUPABASE_URL=https://<that-domain>` and
`SUPABASE_ANON_KEY=<ANON_KEY>`.

## Why it's safe to deploy repeatedly

- **No `ports:` anywhere.** Stock publishes `${KONG_HTTP_PORT}:8000`, so a
  second copy dies on a port conflict. Coolify's proxy reaches kong over the
  project network instead.
- **No `container_name:`.** Coolify namespaces per project; a hardcoded name
  makes deploy #2 fail with a name conflict.
- **Plain named volumes**, scoped per project by Coolify.
- **`mem_limit` on every service**, so one tenant can't starve its neighbours.

## The `depends_on` rule

Only ever depend on `db`.

A `depends_on` pointing at an **optional** service means the stack refuses to
start the day you disable it. That is not hypothetical — on this host,
`kong` depended on `studio: service_healthy`, studio was disabled, and compose
refused to start kong with `kong is missing dependency studio`. The API gateway
stayed down until the dependency was removed.

Stock Supabase ships that exact edge. This file doesn't.

## Running several apps in one instance

Give each app its own schema and add it to `PGRST_DB_SCHEMAS`; select it
client-side with `supabase.schema('name')`.

**The catch:** GoTrue owns exactly one `auth.users` per database. Co-tenanted
apps share the user pool, the JWT secret, the SMTP config and the site URL — a
token minted for one is valid against the other unless your RLS is airtight.

Share a schema when the apps share users. Otherwise deploy a second copy of
this stack; that's what it's built for.

## Adopting an existing database

The JWT init script runs on **first init only** — an existing `db-data` volume
skips it. To point this stack at data you already have:

1. Reuse the **existing** `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY` and
   `POSTGRES_PASSWORD`. Change any of them and every issued token breaks.
2. Mount the existing volume as `db-data`.
3. Apply the GUCs by hand, since init won't rerun:
   ```sql
   ALTER DATABASE postgres SET "app.settings.jwt_secret" TO '<JWT_SECRET>';
   ALTER DATABASE postgres SET "app.settings.jwt_exp"    TO '3600';
   ```

## What was dropped, and what brings it back

| service | ~RAM | bring it back if… |
|---|---|---|
| `studio` | 161 MiB | you administer from a browser 24/7 — run it locally instead |
| `meta` | 57 MiB | never alone; it only serves studio |
| `supavisor` | 68 MiB | external clients need a *pooled* connection string |
| `realtime` | 55 MiB | you use `.channel()` / `postgres_changes` |
| `imgproxy` | 13 MiB | you call image transforms (also set `ENABLE_IMAGE_TRANSFORMATION=true`) |
| `edge-runtime` | — | you deploy Edge Functions |
| `analytics`/`vector` | — | you want Logflare self-hosted (rarely worth it) |

Copy a block back from upstream if needed — but wire its `depends_on` to `db`
only, and never let another service depend on it.

## Security defaults

Deliberately closed; open them per deployment:

- `DISABLE_SIGNUP=true`
- `ENABLE_EMAIL_AUTOCONFIRM=false` — true lets anyone register an address they
  don't control
- `ENABLE_ANONYMOUS_USERS=false`
- `PGRST_DB_MAX_ROWS=1000` — bounds an unfiltered `SELECT`
- Postgres publishes **no** host port; reach it via `compose exec` or SSH tunnel
- `no-new-privileges:true` on every service
- JSON logs capped at 10 MB × 3 — unbounded logs are part of how `dockerd` on
  this host grew to ~1.8 GB

## Not yet verified

Nothing here has been deployed and booted end-to-end. `docker compose config`
validates structure, not runtime. Before trusting it with real data, stand up
one throwaway instance and confirm: auth signup/login, a PostgREST read and
write, and a storage upload.
