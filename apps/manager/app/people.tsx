import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { DirectoryHeader } from "@/components/people/DirectoryHeader";
import { DirectoryResults } from "@/components/people/DirectoryResults";
import { ProfileSheet, PEOPLE_COLORS } from "@/components/people/bits";
import { TenantProfile, type PiiField } from "@/components/people/TenantProfile";
import { profileSubline } from "@/components/people/format";
import { directoryTotals, fullName, searchPeople, type PeopleScope } from "@/components/people/search";
import { capture } from "@/lib/analytics";
import { useConfig } from "@/lib/stores/config";
import { usePeople } from "@/lib/stores/people";
import { HAIRLINE, screenHPad } from "@/theme/tokens";

/**
 * People — search, then the whole picture.
 *
 * A MODAL route, not a tab: "who is this person" is a question asked FROM
 * somewhere (a unit, a map tap, a delinquency row), so the directory opens
 * over whatever you were doing and hands you back. Search is its standalone
 * entry, matching name, unit, phone and license plate over the cached index.
 *
 * Phone: search screen, profile as a bottom sheet.
 * iPad (>=1040): the two-pane layout — directory left, profile right.
 */

/** iPad split threshold — the same breakpoint `screenHPad` switches on. */
const SPLIT_MIN_WIDTH = 1040;

export default function PeopleScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const split = width >= SPLIT_MIN_WIDTH;
  const hPad = screenHPad(width);

  const baseUrl = useConfig((s) => s.baseUrl);
  const token = useConfig((s) => s.token);
  const config = useMemo(() => ({ baseUrl, token }), [baseUrl, token]);

  const index = usePeople((s) => s.index);
  const loading = usePeople((s) => s.loading);
  const refreshedAt = usePeople((s) => s.refreshedAt);
  const profiles = usePeople((s) => s.profiles);
  const loadingProfile = usePeople((s) => s.loadingProfile);
  const profileError = usePeople((s) => s.profileError);
  const revealed = usePeople((s) => s.revealed);
  const loadAll = usePeople((s) => s.loadAll);
  const loadProfile = usePeople((s) => s.loadProfile);
  const revealPii = usePeople((s) => s.revealPii);

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PeopleScope>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // A cold open (deep link, killed app) must not show an empty directory just
  // because the 60s tick hasn't run yet.
  useEffect(() => {
    if (index.length === 0) void loadAll(config);
  }, [index.length, loadAll, config]);

  // One event per search session: fires when the box goes empty → non-empty.
  // No query text ever rides along — this is a PII-free event.
  const hadQuery = useRef(false);
  useEffect(() => {
    const has = query.trim().length > 0;
    if (has && !hadQuery.current) capture("people_search_performed");
    hadQuery.current = has;
  }, [query]);

  const results = useMemo(() => searchPeople(index, query), [index, query]);
  const totals = useMemo(() => directoryTotals(index), [index]);

  // "Now" for the insurance countdown: the last sync's timestamp, falling back
  // to mount time — keeping Date.now() out of the render body.
  const [mountedAt] = useState(() => Date.now());
  const nowMs = refreshedAt > 0 ? refreshedAt : mountedAt;

  const selectedProfile = selectedId ? (profiles[selectedId] ?? null) : null;
  const selectedName = (() => {
    if (selectedProfile) {
      return `${selectedProfile.resident.firstName} ${selectedProfile.resident.lastName}`.trim();
    }
    const entry = index.find((e) => e.personLeaseId === selectedId);
    return entry ? fullName(entry) : "";
  })();

  const openPerson = (personLeaseId: string) => {
    setSelectedId(personLeaseId);
    if (!split) setSheetOpen(true);
    capture("tenant_profile_opened");
    void loadProfile(config, personLeaseId);
  };

  const onReveal = async (field: PiiField): Promise<boolean> => {
    if (!selectedId) return false;
    return revealPii(config, selectedId, field);
  };

  // Cross-nav to the Money tab's ledger lands later; for now the button only
  // reports intent so the demand is measurable.
  const onLedger = () => capture("tenant_ledger_opened");

  const profileBody = (
    <TenantProfile
      profile={selectedProfile}
      loading={loadingProfile === selectedId}
      error={profileError}
      revealed={selectedId ? (revealed[selectedId] ?? []) : []}
      onReveal={onReveal}
      onLedger={onLedger}
      nowMs={nowMs}
      showHeader={split}
    />
  );

  const directory = (
    <DirectoryResults
      results={results}
      scope={scope}
      selectedId={split ? selectedId : null}
      onSelectPerson={openPerson}
    />
  );

  const showSpinner = loading && index.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: "rgba(250,247,240,0.98)" }}>
      <DirectoryHeader
        total={totals.residents}
        summary={
          split
            ? t("people.summary", {
                residents: totals.primaries.toLocaleString(),
                household: totals.householdMembers.toLocaleString(),
                vehicles: totals.vehicles.toLocaleString(),
              })
            : undefined
        }
        query={query}
        onQuery={setQuery}
        scope={scope}
        onScope={setScope}
        results={results}
        onClose={() => router.back()}
        hPad={hPad}
      />

      {showSpinner ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator />
        </View>
      ) : split ? (
        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ width: 400, borderRightWidth: 1, borderRightColor: HAIRLINE }}>
            <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>{directory}</ScrollView>
          </View>
          <View style={{ flex: 1 }}>
            {selectedId ? (
              <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>{profileBody}</ScrollView>
            ) : (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 12.5, color: PEOPLE_COLORS.muted }}>
                  {t("people.empty.selectPrompt")}
                </Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        <ScrollView keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: 60 }}>
          {directory}
        </ScrollView>
      )}

      {/* Phone: the profile rides a bottom sheet over the search results. */}
      {!split ? (
        <ProfileSheet
          visible={sheetOpen && selectedId !== null}
          onClose={() => setSheetOpen(false)}
          name={selectedName}
          subtitle={profileSubline(selectedProfile, t)}
          closeLabel={t("people.close")}
        >
          {profileBody}
        </ProfileSheet>
      ) : null}
    </View>
  );
}
