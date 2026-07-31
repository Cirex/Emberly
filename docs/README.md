# docs/ — GitHub Wiki source

This folder is the **source of truth for the Emberly [GitHub Wiki](../../wiki)**. The pages
here are authored as wiki pages (GitHub wiki conventions) and published to the wiki, so they
can be reviewed in pull requests alongside the code they document.

## Pages

| File | Wiki page | Contents |
| --- | --- | --- |
| `Home.md` | Home | Landing page + orientation. |
| `Architecture.md` | Architecture | Apps, sync worker, Supabase, data flow, import boundaries. |
| `Deployment.md` | Deployment | End-to-end production runbook (Supabase, Sentry, PostHog, Coolify, EAS). |
| `Environment-Variables.md` | Environment Variables | Every variable each app reads. |
| `MCP-Server-Setup.md` | MCP Server Setup | Connect any AI client to the read-only staff MCP server. |
| `Web-API.md` | Web API | **Generated** — every HTTP route, its guard, and its response shape. |
| `Database.md` | Database | **Generated** — every table and column, and which joins are enforced. |
| `_Sidebar.md` | (sidebar) | Wiki navigation. |
| `_Footer.md` | (footer) | Wiki footer. |

Internal cross-links use GitHub wiki syntax — `[[Page Title]]` (e.g. `[[Deployment]]`), which
resolves to the file whose name is the title with spaces replaced by dashes.

## Conventions

- One `<h1>` per page (the page title).
- Keep prose wrapped ~100 cols to match the rest of the repo.
- Page file names use dashes for spaces (`Environment-Variables.md`), because that is how the
  GitHub wiki stores and links them.
- Files beginning with `_` (`_Sidebar.md`, `_Footer.md`) are wiki chrome, not pages.
- **`Web-API.md` and `Database.md` are generated — never edit them by hand.** Run
  `bun run docs` to rebuild both. Their prose comes from the source they describe (a route's
  docblock, a table's comment block in `schema.sql`), so it is updated in the same edit as the
  thing it documents rather than drifting in a separate file. `--check` on either generator
  fails when the committed copy is stale, which is the CI-friendly form.

## Publishing to the wiki

The GitHub wiki is a **separate git repository** at
`https://github.com/Cirex/Emberly.wiki.git`. It must be initialized once (Repo → **Wiki** tab
→ *Create the first page* → Save) before it can be cloned.

### Option A — manual (one-off or occasional)

```bash
# from anywhere outside the main repo working tree
git clone https://github.com/Cirex/Emberly.wiki.git
cp /path/to/Emberly/docs/*.md Emberly.wiki/
cd Emberly.wiki
git add -A && git commit -m "docs: sync wiki from docs/" && git push
```

### Option B — automatic sync on push (recommended)

Add a workflow that pushes `docs/` to the wiki whenever the docs change on `main`. Create
`.github/workflows/wiki-sync.yml`:

```yaml
name: Sync docs/ to Wiki
on:
  push:
    branches: [main]
    paths: ['docs/**']
permissions:
  contents: write
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Publish docs/ to the wiki
        uses: Andrew-Chen-Wang/github-wiki-action@v4
        with:
          path: docs/
```

The wiki must already be initialized (one manual first page) for the action's first run to
succeed. After that, every push to `docs/**` on `main` updates the wiki automatically.
