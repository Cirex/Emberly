"use client";

import type { AdminPagination } from "@/lib/admin-guest-passes";
import { AdminIcon } from "../../_components/admin-ui";

export function PaginationFooter({
  pagination,
  noun,
  onPageChange,
  summaryClassName = "text-sm text-primary/55",
}: {
  pagination: AdminPagination | null;
  noun: string;
  onPageChange: React.Dispatch<React.SetStateAction<number>>;
  summaryClassName?: string;
}) {
  if (!pagination || pagination.totalPages <= 1) return null;

  return (
    <div className="flex flex-col gap-3 border-t border-primary/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <p className={summaryClassName}>
        Page {pagination.page} of {pagination.totalPages} ·{" "}
        {pagination.total.toLocaleString()} {noun}
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => onPageChange((p) => p - 1)}
          disabled={!pagination.hasPrev}
          className="pagination-btn"
        >
          <AdminIcon name="chevron-left" />
          <span>Previous</span>
        </button>
        <button
          onClick={() => onPageChange((p) => p + 1)}
          disabled={!pagination.hasNext}
          className="pagination-btn"
        >
          <span>Next</span>
          <AdminIcon name="chevron-right" />
        </button>
      </div>
    </div>
  );
}
