
const assert = require("node:assert/strict");
const test = require("node:test");

const { getMissingSupabaseAdminEnvVars } = require("../lib/supabase/admin");

test("getMissingSupabaseAdminEnvVars reports missing server-side Supabase config", () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalPublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.deepEqual(getMissingSupabaseAdminEnvVars(), [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]);

    // The plain runtime var satisfies the URL requirement.
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    assert.deepEqual(getMissingSupabaseAdminEnvVars(), []);

    // The legacy NEXT_PUBLIC_ name still satisfies it (backward compatibility).
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://legacy.supabase.co";
    assert.deepEqual(getMissingSupabaseAdminEnvVars(), []);
  } finally {
    restore("SUPABASE_URL", originalUrl);
    restore("NEXT_PUBLIC_SUPABASE_URL", originalPublicUrl);
    restore("SUPABASE_SERVICE_ROLE_KEY", originalServiceRoleKey);
  }
});

function restore(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
