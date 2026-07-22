"use client";

import type {
  AccountSummary,
  CurrentMonthMix,
  MonthOverMonth,
  MonthPoint,
} from "@/lib/admin-utilities";
import { DetailSheet, type AccountDetail } from "../../admin/(protected)/utilities/detail-sheet";
import { PortfolioSnapshot } from "../../admin/(protected)/utilities/overview";

/** Client boundary: overview panel + the modal detail sheet with a no-op close. */
export function PreviewHarness({
  summary,
  detail,
  series,
  goal,
  mix,
  mom,
}: {
  summary: AccountSummary;
  detail: AccountDetail;
  series: MonthPoint[];
  goal: number | null;
  mix: CurrentMonthMix;
  mom: MonthOverMonth;
}) {
  return (
    <>
      <PortfolioSnapshot series={series} goal={goal} mix={mix} mom={mom} />
      <div style={{ height: 30 }} />
      <DetailSheet summary={summary} detail={detail} onClose={() => {}} />
    </>
  );
}
