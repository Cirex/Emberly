# Deltas

New schema changes go here as `YYYY-MM-DD-description.sql`. The directory is
empty after a flatten — see `../migrations/README.md` for the full convention
and the record of past flattens.

Two things worth knowing before adding a file:

**Order is by filename, not by date in the header.** The runner sorts the
directory and applies in that order. A `2026-08-01-drop-x.sql` sorts *before*
`2026-08-01-mcp-x.sql`, so a file that undoes or depends on another needs a name
that sorts after it. This is not theoretical: the drop of the stale `mcp_*`
overloads was originally dated 08-01, ran before the files that create them, and
was silently undone on replay.

**`drop ... if exists` cannot tell "already gone" from "never existed".** A
signature that does not match exactly is a no-op with no warning. When dropping
a function, spell the argument types out in full and verify the object actually
disappeared rather than trusting the statement to have run.
