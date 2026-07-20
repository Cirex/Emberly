/**
 * Escape hatch for tables that are not covered by the generated Database
 * types yet. Prefer typed queries where the generated types allow it; a full
 * migration to generated types is out of scope for now.
 */
export type UntypedSupabase = {
  from: (table: string) => any;
};
