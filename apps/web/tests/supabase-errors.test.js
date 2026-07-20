
const assert = require("node:assert/strict");
const test = require("node:test");

const { describeSupabaseQueryFailure } = require("../lib/supabase/errors");

test("describeSupabaseQueryFailure identifies missing Supabase schema cache entries", () => {
  const failure = describeSupabaseQueryFailure({
    code: "PGRST205",
    message: "Could not find the table 'public.residents' in the schema cache",
  });

  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, {
    error: "Emberly database schema is not initialized",
    reason: "supabase_schema_missing",
    requiredAction: "Apply apps/web/lib/supabase/schema.sql to the Supabase project.",
  });
});

test("describeSupabaseQueryFailure keeps unknown query failures generic", () => {
  const failure = describeSupabaseQueryFailure({
    code: "42501",
    message: "permission denied",
  });

  assert.equal(failure.status, 500);
  assert.deepEqual(failure.body, {
    error: "Resident lookup failed",
    reason: "supabase_query_failed",
  });
});
