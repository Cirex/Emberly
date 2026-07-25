import type { WorkOrder } from "@/lib/api/work-orders";

/**
 * Screenshot mode — a build that renders FABRICATED data, for App Store images.
 *
 * WHY THIS EXISTS. App Store screenshots are public. A screenshot of the real
 * work-order board publishes unit numbers, technician names and descriptions
 * that say what is wrong inside a named resident's home. Redacting by hand is
 * one missed pane away from a data leak, and it has to be redone every time the
 * UI moves. So the app renders invented data instead, and no real record can
 * reach a public image by construction.
 *
 * TWO THINGS IT MUST DO, not one. Seeding fixtures is not enough: the tab
 * layout's sync tick fires within a second of launch and would replace them with
 * the real board. Screenshot mode therefore also DISABLES syncing — see
 * `app/(tabs)/_layout.tsx`. Seeding without that would produce screenshots of
 * live resident data that merely looked like fixtures for a moment.
 *
 * OFF unless EXPO_PUBLIC_SCREENSHOT_MODE=1 at build time. Expo inlines
 * EXPO_PUBLIC_* at bundle time, so a normal production build cannot turn this on
 * at runtime.
 *
 *   EXPO_PUBLIC_SCREENSHOT_MODE=1 bun run ios
 */
export function isScreenshotMode(): boolean {
  return process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "1";
}

/**
 * The signed-in staff member shown in screenshot mode. A plausible-looking name
 * that belongs to nobody — never a real technician, since the account chip is
 * visible on most screens.
 */
export const SCREENSHOT_ADMIN = {
  adminId: "screenshot-admin",
  role: "security_manager",
  displayName: "Alex Rivera",
  personId: null,
} as const;

/**
 * Fabricated work orders.
 *
 * Written to look like a real Tuesday — a mix of priorities and statuses, an
 * emergency at the top, a couple mid-repair — because a screenshot of an empty
 * or uniform board sells nothing. Unit numbers are in the property's format but
 * are not units that exist; no field names a resident.
 */
function workOrder(over: Partial<WorkOrder> & { resman_work_order_id: string }): WorkOrder {
  return {
    number: "",
    resman_unit_id: null,
    unit_lease_group_id: "",
    resman_lease_id: "",
    unit_number: "",
    resman_property_id: "screenshot-property",
    status: "Not Started",
    priority: "Normal",
    category: "General",
    title: "",
    notes: "",
    completion_notes: "",
    technician: SCREENSHOT_ADMIN.displayName,
    date_reported: "2026-07-21",
    date_scheduled: "2026-07-21",
    date_completed: null,
    is_make_ready: false,
    callback_requested: false,
    callback_completed: false,
    tags: [],
    is_duplicate: false,
    callback_status: "none",
    callback_matched_work_order_id: "",
    callback_engine_version: "",
    callback_source: "",
    callback_detected_at: null,
    synced_at: "2026-07-21T14:00:00.000Z",
    created_at: "2026-07-21T08:00:00.000Z",
    updated_at: "2026-07-21T14:00:00.000Z",
    ...over,
  } as WorkOrder;
}

export const SCREENSHOT_WORK_ORDERS: readonly WorkOrder[] = [
  workOrder({
    resman_work_order_id: "ss-1",
    number: "WO-4821",
    unit_number: "0714",
    priority: "Emergency",
    status: "Not Started",
    category: "Plumbing",
    title: "Water heater leaking into hallway",
    notes: "Water pooling outside the utility closet. Shutoff is behind the panel.",
    date_reported: "2026-07-21",
  }),
  workOrder({
    resman_work_order_id: "ss-2",
    number: "WO-4817",
    unit_number: "0322",
    priority: "High",
    status: "In Progress",
    category: "HVAC",
    title: "No cooling — compressor not starting",
    notes: "Thermostat calls for cool, condenser fan runs, compressor silent.",
    completion_notes: "Replaced start capacitor. Monitoring before close.",
  }),
  workOrder({
    resman_work_order_id: "ss-3",
    number: "WO-4809",
    unit_number: "1108",
    priority: "Normal",
    status: "Scheduled",
    category: "Appliance",
    title: "Dishwasher not draining",
  }),
  workOrder({
    resman_work_order_id: "ss-4",
    number: "WO-4802",
    unit_number: "0517",
    priority: "Normal",
    status: "In Progress",
    category: "Electrical",
    title: "Bedroom outlets dead on one wall",
    notes: "Half the wall is out. Breaker holds. Suspect a back-stabbed outlet.",
  }),
  workOrder({
    resman_work_order_id: "ss-5",
    number: "WO-4796",
    unit_number: "0233",
    priority: "Low",
    status: "Not Started",
    category: "General",
    title: "Closet door off its track",
  }),
  workOrder({
    resman_work_order_id: "ss-6",
    number: "WO-4788",
    unit_number: "0905",
    priority: "Normal",
    status: "Completed",
    category: "Plumbing",
    title: "Kitchen faucet dripping",
    completion_notes: "Replaced cartridge and aerator. Tested, no drip.",
    date_completed: "2026-07-21",
  }),
  workOrder({
    resman_work_order_id: "ss-7",
    number: "WO-4781",
    unit_number: "0641",
    priority: "High",
    status: "Not Started",
    category: "Make Ready",
    title: "Make ready — paint, blinds, deep clean",
    is_make_ready: true,
  }),
];

/** Sanity floor: a screenshot build must not show an empty board. */
export const SCREENSHOT_MIN_WORK_ORDERS = 5;
