import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { TagEditorDialog } from "@/components/map/TagEditorDialog";
import { AppCardSurface } from "@/components/ui/AppCardSurface";
import { AppStatusBadge } from "@emberly/ui";
import type { ScannerConfig } from "@/lib/api/scanner";
import type { TenantDetail } from "@/lib/api/tenant-detail";
import type { ResmanUnit } from "@/lib/api/units";
import { tagExpiryBadge, useTags, type UnitTag } from "@/lib/stores/tags";
import { unitClassification, unitInitials, unitLine, unitPrimaryName, unitStatus } from "@/lib/unit-display";

/** Stable empty result — `?? []` in a zustand selector loops forever. */
const NO_TAGS: UnitTag[] = [];

type IconName = React.ComponentProps<typeof Ionicons>["name"];

/**
 * TenantDetailMetricRow: 48pt minimum, a hairline rule along the bottom, and the
 * value picked out by what it says — olive for an affirmative, red for a refusal.
 * The last row in a group drops its rule rather than drawing against the card
 * edge.
 *
 * A refusal reading the same as any other value is the wrong default here: "guests
 * blocked" is the one answer on this card that should stop someone.
 */
function MetricRow({
  icon,
  label,
  value,
  muted,
  last,
}: {
  icon: IconName;
  label: string;
  value: string;
  muted?: boolean;
  last?: boolean;
}) {
  const affirmative = value === "Yes" || value === "Guest Active";
  const refused = value === "No";
  return (
    <View
      className="flex-row items-center"
      style={{
        gap: 12,
        minHeight: 48,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: "rgba(9,27,84,0.10)",
      }}
    >
      <Ionicons name={icon} size={18} color="#70788F" />
      <Text className="text-slate dark:text-white/70" style={{ fontSize: 15, fontWeight: "500", flex: 1 }}>
        {label}
      </Text>
      <Text
        className={
          affirmative
            ? "text-olive-dark"
            : refused
              ? "text-status-blocked"
              : muted
                ? "text-muted"
                : "text-navy dark:text-white"
        }
        style={{ fontSize: 15, fontWeight: "600", maxWidth: "58%", textAlign: "right" }}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

function ActionButton({ icon, title, onPress }: { icon: IconName; title: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="bg-white dark:bg-white/10"
      style={{
        flex: 1,
        height: 44,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: "rgba(9,27,84,0.12)",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
      }}
    >
      <Ionicons name={icon} size={16} color="#4C556F" />
      <Text className="text-navy dark:text-white" style={{ fontSize: 13, fontWeight: "700" }}>
        {title}
      </Text>
    </Pressable>
  );
}

/** "2022 Gray Saturn Vue" — the car, without its plate. */
export function vehicleDescription(v: TenantDetail["vehicles"][number]): string {
  return [v.year, v.color, v.make, v.model].filter((p) => p.trim().length > 0).join(" ") || "Vehicle on file";
}

/**
 * Every plate chip is the same width whatever it holds, so the descriptions
 * beside them line up into a column instead of stepping in and out.
 */
const PLATE_WIDTH = 116;
const PLATE_FONT = Platform.select({ ios: "Menlo", default: "monospace" });

/**
 * The plate leads: at a gate it's what gets matched against a car, and it reads
 * at a glance in mono. A missing plate says so rather than leaving a gap — 43 of
 * the register's rows have none.
 */
function PlateChip({ plate, state }: { plate: string; state: string }) {
  const value = plate.trim();
  const region = state.trim();

  if (!value) {
    return (
      <View
        style={{
          width: PLATE_WIDTH,
          height: 34,
          borderRadius: 7,
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: "rgba(9,27,84,0.22)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text className="text-muted" style={{ fontSize: 12, fontWeight: "500" }}>
          No plate
        </Text>
      </View>
    );
  }

  return (
    <View
      className="bg-white dark:bg-white/10"
      style={{
        width: PLATE_WIDTH,
        height: 34,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: "rgba(9,27,84,0.22)",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        paddingHorizontal: 6,
      }}
    >
      <Text
        className="text-navy dark:text-white"
        style={{ fontFamily: PLATE_FONT, fontSize: 14, fontWeight: "600", letterSpacing: 0.6 }}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
      >
        {value}
      </Text>
      {region ? (
        <Text className="text-slate dark:text-white/60" style={{ fontSize: 10, fontWeight: "700" }}>
          {region}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * "Guests Allowed" — Yes or No, nothing else. This is read with someone waiting
 * at the gate, so it answers the question rather than reporting the inputs to it.
 *
 * Guests are allowed by default. The only thing that flips it to No is an
 * explicit ban (`guest_pass_bans`) against someone at this unit — enrollment
 * status and access standing don't factor in.
 */
export function guestsAllowedLabel(access: TenantDetail["guestAccess"] | undefined): {
  value: string;
  muted: boolean;
} {
  // Only before the detail fetch lands: unknown is not the same claim as No.
  if (!access) return { value: "—", muted: true };
  return { value: access.banned > 0 ? "No" : "Yes", muted: false };
}

/** "Expires in 6h" / "Expires in 24m" — a guard cares how long it has left. */
export function expiresInLabel(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "Expired";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `Expires in ${mins}m`;
  return `Expires in ${Math.round(mins / 60)}h`;
}

/**
 * The active passes for this unit, as a small table. A popup rather than a jump
 * to the Guest Passes tab: the question ("is this guest expected?") is asked
 * while looking at the tenant, and answering it shouldn't lose that place.
 */
function GuestPassesModal({
  visible,
  onClose,
  tenant,
  passes,
}: {
  visible: boolean;
  onClose: () => void;
  tenant: string;
  passes: TenantDetail["guestPasses"];
}) {
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(9,16,32,0.45)", alignItems: "center", justifyContent: "center", padding: 24 }}
      >
        {/* Swallow taps inside the sheet so only the scrim dismisses. */}
        <Pressable onPress={() => {}} style={{ width: "100%", maxWidth: 460 }}>
          <View className="bg-paper-top dark:bg-night-top" style={{ borderRadius: 20, overflow: "hidden" }}>
            <View
              className="flex-row items-center justify-between"
              style={{ paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "rgba(9,27,84,0.10)" }}
            >
              <View style={{ flex: 1 }}>
                <Text className="text-navy dark:text-white" style={{ fontSize: 17, fontWeight: "700" }}>
                  Active guest passes
                </Text>
                <Text className="text-muted" style={{ fontSize: 12 }} numberOfLines={1}>
                  {tenant}
                </Text>
              </View>
              <Pressable onPress={onClose} hitSlop={12}>
                <Ionicons name="close" size={22} color="#70788F" />
              </Pressable>
            </View>

            {passes.length === 0 ? (
              <View style={{ padding: 26, alignItems: "center", gap: 6 }}>
                <Ionicons name="ticket-outline" size={30} color="#A9B0C4" />
                <Text className="text-muted" style={{ fontSize: 14 }}>
                  No active passes
                </Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 320 }}>
                {passes.map((p, i) => (
                  <View
                    key={p.id}
                    className="flex-row items-center"
                    style={{
                      gap: 12,
                      paddingHorizontal: 18,
                      paddingVertical: 12,
                      borderBottomWidth: i === passes.length - 1 ? 0 : 1,
                      borderBottomColor: "rgba(9,27,84,0.07)",
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text className="text-navy dark:text-white" style={{ fontSize: 15, fontWeight: "700" }} numberOfLines={1}>
                        {p.guestName || "Guest"}
                      </Text>
                      {p.hostName ? (
                        <Text className="text-muted" style={{ fontSize: 12 }} numberOfLines={1}>
                          Invited by {p.hostName}
                        </Text>
                      ) : null}
                    </View>
                    <Text className="text-slate dark:text-white/70" style={{ fontSize: 12, fontWeight: "600" }}>
                      {expiresInLabel(p.expiresAt)}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function lastEntryLabel(entry: TenantDetail["lastEntry"]): string {
  if (!entry?.enteredAt) return "Not recorded";
  const when = new Date(entry.enteredAt);
  if (Number.isNaN(when.getTime())) return "Not recorded";
  const stamp = when.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${stamp} · ${entry.entryType === "guest" ? "Guest" : "Resident"}`;
}

/**
 * Port of TenantDetailCard (TenantsDashboardView.swift). The Swift original
 * hard-coded "Last Entry"/"Vehicle" to placeholder strings; both are real here —
 * vehicles come from the ResMan lease mirror, last entry from our own entry log.
 */
export function TenantDetailCard({
  unit,
  detail,
  loading,
  error,
  config,
  onViewOnMap,
}: {
  unit: ResmanUnit;
  detail: TenantDetail | null;
  loading: boolean;
  error?: string;
  config: ScannerConfig;
  onViewOnMap: () => void;
}) {
  const status = unitStatus(unit);
  const vehicles = detail?.vehicles ?? [];
  const guestPasses = detail?.guestPasses ?? [];
  const guestsAllowed = guestsAllowedLabel(detail?.guestAccess);
  const [passesOpen, setPassesOpen] = useState(false);
  const [tagEditOpen, setTagEditOpen] = useState(false);
  const tags = useTags((s) => s.byUnit[unit.number] ?? NO_TAGS);
  const removeTag = useTags((s) => s.remove);

  return (
    <AppCardSurface kind="panel">
      <View style={{ padding: 20, gap: 6 }}>
        <View className="flex-row items-center" style={{ gap: 14 }}>
          <View
            className="items-center justify-center rounded-full"
            style={{ width: 58, height: 58, backgroundColor: "#E9E6D1" }}
          >
            <Text style={{ color: "#848F0D", fontSize: 20, fontWeight: "700" }}>{unitInitials(unit)}</Text>
          </View>
          <View className="flex-1">
            <Text className="text-navy dark:text-white" style={{ fontSize: 19, fontWeight: "700" }} numberOfLines={2}>
              {unitPrimaryName(unit)}
            </Text>
            <Text className="text-slate dark:text-white/70" style={{ fontSize: 14, fontWeight: "500" }}>
              {unitLine(unit)}
            </Text>
            {unitClassification(unit) ? (
              <Text className="text-muted" style={{ fontSize: 13, fontWeight: "500" }}>
                {unitClassification(unit)}
              </Text>
            ) : null}
          </View>
        </View>

        <View className="flex-row" style={{ marginTop: 8 }}>
          <AppStatusBadge label={status.label} tint={status.tint} />
        </View>

        {/* Shared tags — same per-unit tags as the map, read + write here. */}
        <View style={{ marginTop: 14 }}>
          <View className="flex-row items-center justify-between" style={{ marginBottom: 8 }}>
            <Text
              className="text-slate dark:text-white/60"
              style={{ fontSize: 11, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" }}
            >
              Tags · shared
            </Text>
            <Pressable
              onPress={() => setTagEditOpen(true)}
              hitSlop={6}
              className="flex-row items-center"
              style={{
                gap: 4,
                paddingVertical: 4,
                paddingHorizontal: 11,
                borderRadius: 999,
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: "rgba(118,123,36,0.5)",
              }}
            >
              <Ionicons name="add" size={12} color="#767B24" />
              <Text style={{ fontSize: 12, fontWeight: "700", color: "#767B24" }}>Add tag</Text>
            </Pressable>
          </View>
          {tags.length === 0 ? (
            <Text className="text-muted" style={{ fontSize: 12.5, paddingVertical: 2 }}>
              None yet
            </Text>
          ) : (
            tags.map((t) => {
              const badge = tagExpiryBadge(t);
              return (
                <View
                  key={t.id}
                  className="flex-row items-center"
                  style={{
                    gap: 10,
                    paddingVertical: 8,
                    paddingHorizontal: 11,
                    marginBottom: 7,
                    borderRadius: 12,
                    backgroundColor: `${t.colorHex}12`,
                    borderWidth: 1,
                    borderColor: `${t.colorHex}33`,
                  }}
                >
                  <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: t.colorHex }} />
                  <Text style={{ fontSize: 13.5, fontWeight: "700", color: t.colorHex }} numberOfLines={1}>
                    {t.label}
                  </Text>
                  {badge ? (
                    <Text style={{ fontSize: 10.5, fontWeight: "700", color: t.colorHex, opacity: 0.8 }}>
                      · {badge}
                    </Text>
                  ) : null}
                  <View style={{ flex: 1 }} />
                  <Pressable
                    onPress={() => void removeTag(unit.number, t.id, config)}
                    hitSlop={8}
                    accessibilityLabel={`Remove ${t.label}`}
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: `${t.colorHex}22`,
                    }}
                  >
                    <Ionicons name="close" size={11} color={t.colorHex} />
                  </Pressable>
                </View>
              );
            })
          )}
        </View>

        <View style={{ marginTop: 10 }}>
          <MetricRow
            icon="shield-checkmark"
            label="Guests Allowed"
            value={loading && !detail ? "…" : guestsAllowed.value}
            muted={guestsAllowed.muted}
          />
          <MetricRow icon="document-text" label="Lease Status" value={unit.lease_status || "Unavailable"} />
          <MetricRow
            icon="time"
            label="Last Entry"
            value={loading ? "…" : lastEntryLabel(detail?.lastEntry ?? null)}
            muted={!detail?.lastEntry}
          />
        </View>

        {/* Vehicles get their own section rather than a metric row: they're a
            list, they're the reason to look at this pane, and a plate crammed
            right-aligned into a value column is unreadable at a gate. */}
        <View style={{ marginTop: 14 }}>
          {/* Reads as a peer of the metric rows above — same icon size, gap and
              label type. A smaller, tracked, all-caps header looked like it came
              from a different design. */}
          <View className="flex-row items-center" style={{ gap: 12, marginBottom: 6 }}>
            <Ionicons name="car" size={18} color="#70788F" />
            <Text className="text-slate dark:text-white/70" style={{ fontSize: 15, fontWeight: "500" }}>
              {vehicles.length > 1 ? `Vehicles (${vehicles.length})` : "Vehicle"}
            </Text>
          </View>

          {loading && !detail ? (
            <Text className="text-muted" style={{ fontSize: 13, paddingVertical: 8 }}>
              …
            </Text>
          ) : vehicles.length === 0 ? (
            <Text className="text-muted" style={{ fontSize: 13, paddingVertical: 8 }}>
              None on file
            </Text>
          ) : (
            vehicles.map((v, i) => (
              <View
                key={v.id}
                className="flex-row items-center"
                style={{
                  gap: 10,
                  paddingVertical: 7,
                  borderBottomWidth: i === vehicles.length - 1 ? 0 : 1,
                  borderBottomColor: "rgba(9,27,84,0.08)",
                }}
              >
                <PlateChip plate={v.licensePlate} state={v.licensePlateState} />
                <Text
                  className="text-navy dark:text-white"
                  style={{ flex: 1, fontSize: 13, fontWeight: "500" }}
                  numberOfLines={1}
                >
                  {vehicleDescription(v)}
                </Text>
              </View>
            ))
          )}
        </View>

        {error ? (
          <Text className="text-status-blocked" style={{ fontSize: 13, marginTop: 4 }}>
            {error}
          </Text>
        ) : null}

        {loading && !detail ? (
          <View className="flex-row items-center" style={{ gap: 8, marginTop: 4 }}>
            <ActivityIndicator size="small" color="#70788F" />
            <Text className="text-muted" style={{ fontSize: 12 }}>
              Loading details…
            </Text>
          </View>
        ) : null}

        <View className="flex-row" style={{ gap: 10, marginTop: 14 }}>
          <ActionButton icon="location" title="View on Map" onPress={onViewOnMap} />
          <ActionButton
            icon="people"
            title={guestPasses.length > 0 ? `Guest Passes (${guestPasses.length})` : "Guest Passes"}
            onPress={() => setPassesOpen(true)}
          />
        </View>
      </View>

      <GuestPassesModal
        visible={passesOpen}
        onClose={() => setPassesOpen(false)}
        tenant={`${unitPrimaryName(unit)} · ${unitLine(unit)}`}
        passes={guestPasses}
      />

      {tagEditOpen ? (
        <TagEditorDialog unitNumber={unit.number} config={config} onClose={() => setTagEditOpen(false)} />
      ) : null}
    </AppCardSurface>
  );
}

/** Shown in the detail column when nothing is selected (TenantDetailEmptyCard). */
export function TenantDetailEmptyCard() {
  return (
    <AppCardSurface kind="panel">
      <View style={{ padding: 32, alignItems: "center", gap: 10 }}>
        <Ionicons name="person-circle-outline" size={40} color="#A9B0C4" />
        <Text className="text-navy dark:text-white" style={{ fontSize: 16, fontWeight: "700" }}>
          Select a tenant
        </Text>
        <Text className="text-muted text-center" style={{ fontSize: 13, maxWidth: 260 }}>
          Pick a unit from the list to see its access, vehicles, and last entry.
        </Text>
      </View>
    </AppCardSurface>
  );
}
