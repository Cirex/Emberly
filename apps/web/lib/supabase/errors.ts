type SupabaseErrorLike = {
  code?: string | null;
  message?: string | null;
};

export type SupabaseQueryFailure = {
  error: string;
  reason: string;
  requiredAction?: string;
};

export function describeSupabaseQueryFailure(error: SupabaseErrorLike): {
  body: SupabaseQueryFailure;
  status: number;
} {
  if (isSchemaCacheError(error)) {
    return {
      status: 503,
      body: {
        error: "Emberly database schema is not initialized",
        reason: "supabase_schema_missing",
        requiredAction: "Apply apps/web/lib/supabase/schema.sql to the Supabase project.",
      },
    };
  }

  return {
    status: 500,
    body: {
      error: "Resident lookup failed",
      reason: "supabase_query_failed",
    },
  };
}

function isSchemaCacheError(error: SupabaseErrorLike) {
  if (error.code === "PGRST204" || error.code === "PGRST205") {
    return true;
  }

  const message = error.message?.toLowerCase() ?? "";
  return message.includes("schema cache");
}
