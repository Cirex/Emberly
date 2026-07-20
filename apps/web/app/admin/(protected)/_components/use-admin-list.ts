"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminPagination } from "@/lib/admin-guest-passes";

/**
 * Shared state for the admin list screens: items + loading/error state, page
 * state, and a refresh callback. Skips the initial fetch (the server renders
 * initial data) and refetches whenever `load` identity or the page changes.
 */
export function useAdminList<T>({
  initialItems,
  initialPagination = null,
  initialError = "",
  loadErrorMessage,
  load,
}: {
  initialItems: T[];
  initialPagination?: AdminPagination | null;
  initialError?: string;
  loadErrorMessage: string;
  load: (page: number) => Promise<{ items: T[]; pagination?: AdminPagination | null }>;
}) {
  const [items, setItems] = useState<T[]>(initialItems);
  const [pagination, setPagination] = useState<AdminPagination | null>(initialPagination);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError);
  const skippedInitialFetch = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await load(page);
      setItems(result.items);
      setPagination(result.pagination ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : loadErrorMessage);
    } finally {
      setLoading(false);
    }
  }, [load, loadErrorMessage, page]);

  useEffect(() => {
    if (!skippedInitialFetch.current) {
      skippedInitialFetch.current = true;
      return;
    }
    refresh();
  }, [refresh]);

  return { items, setItems, pagination, page, setPage, loading, error, setError, refresh };
}
