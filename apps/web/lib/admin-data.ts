import { formatUnitDisplay } from "@emberly/core";

export type { PassStatus as GuestPassStatus, GuestPassStatusSource } from "@emberly/core";
export { getGuestPassStatus } from "@emberly/core";

export function formatUnitForColumn(unitAddress: string | null | undefined): string {
  return formatUnitDisplay(unitAddress);
}
