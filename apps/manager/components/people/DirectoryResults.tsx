import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import {
  BandHeader,
  Lead,
  ListFooter,
  PEOPLE_COLORS,
  Pill,
  Row,
} from "@/components/people/bits";
import { fullName, type PeopleScope, type PeopleSearchResults } from "@/components/people/search";

/**
 * The banded result list from the mockup: PEOPLE, then PLATES, then UNITS,
 * each group only shown when the active scope includes it and it has hits.
 *
 * Rows are capped at RESULT_LIMIT per group — the directory is over a thousand
 * people and a plain scroll of all of them is neither fast nor useful; the
 * footer says so and invites a narrower query.
 */

export const RESULT_LIMIT = 50;

export function DirectoryResults({
  results,
  scope,
  selectedId,
  onSelectPerson,
}: {
  results: PeopleSearchResults;
  scope: PeopleScope;
  /** personLeaseId highlighted in the iPad split; null on phone. */
  selectedId: string | null;
  onSelectPerson: (personLeaseId: string) => void;
}) {
  const { t } = useTranslation();

  const showPeople = scope === "all" || scope === "people";
  const showPlates = scope === "all" || scope === "plates";
  const showUnits = scope === "all" || scope === "units";

  const people = showPeople ? results.people.slice(0, RESULT_LIMIT) : [];
  const plates = showPlates ? results.plates.slice(0, RESULT_LIMIT) : [];
  const units = showUnits ? results.units.slice(0, RESULT_LIMIT) : [];

  const nothing = people.length === 0 && plates.length === 0 && units.length === 0;
  if (nothing) {
    return (
      <Text
        style={{
          paddingHorizontal: 16,
          paddingVertical: 28,
          textAlign: "center",
          fontSize: 12.5,
          color: PEOPLE_COLORS.muted,
        }}
      >
        {results.query === "" ? t("people.empty.directory") : t("people.empty.noResults")}
      </Text>
    );
  }

  const truncated = showPeople && results.people.length > people.length;

  return (
    <View>
      {people.length > 0 ? (
        <View>
          <BandHeader label={t("people.bands.people")} />
          {people.map((entry) => {
            const name = fullName(entry);
            const role = entry.isPrimary ? t("people.row.primary") : t("people.row.occupant");
            const parts = [entry.unitNumber, role, entry.householdStatus].filter(
              (p) => p !== "",
            );
            return (
              <Row
                key={entry.personLeaseId}
                lead={<Lead name={name} />}
                title={name}
                subtitle={parts.join(" · ")}
                selected={selectedId === entry.personLeaseId}
                right={
                  <Pill
                    tone={entry.isPrimary ? "ok" : "neutral"}
                    label={entry.isPrimary ? t("people.status.primary") : t("people.status.occupant")}
                  />
                }
                onPress={() => onSelectPerson(entry.personLeaseId)}
              />
            );
          })}
          {truncated ? (
            <ListFooter>
              {t("people.footer.truncated", {
                shown: people.length,
                total: results.people.length,
              })}
            </ListFooter>
          ) : null}
        </View>
      ) : null}

      {plates.length > 0 ? (
        <View>
          <BandHeader label={t("people.bands.plates")} />
          {plates.map((hit) => (
            <Row
              key={hit.key}
              lead={<Lead name={hit.plate} glyph="🚗" />}
              title={hit.state ? `${hit.state} · ${hit.plate}` : hit.plate}
              subtitle={t("people.row.plateOwner", { name: hit.name })}
              selected={selectedId === hit.personLeaseId}
              right={
                hit.unitNumber ? (
                  <Text style={{ fontSize: 9.5, fontWeight: "600", color: PEOPLE_COLORS.muted }}>
                    {hit.unitNumber}
                  </Text>
                ) : undefined
              }
              onPress={() => onSelectPerson(hit.personLeaseId)}
            />
          ))}
        </View>
      ) : null}

      {units.length > 0 ? (
        <View>
          <BandHeader label={t("people.bands.units")} />
          {units.map((hit) => (
            <Row
              key={hit.unitNumber}
              title={hit.unitNumber}
              subtitle={t("people.row.units", { count: hit.residentCount })}
              right={
                hit.primaryName ? (
                  <Text style={{ fontSize: 9.5, fontWeight: "600", color: PEOPLE_COLORS.muted }}>
                    {hit.primaryName}
                  </Text>
                ) : undefined
              }
            />
          ))}
        </View>
      ) : null}

      <ListFooter>{t("people.footer.matches")}</ListFooter>
    </View>
  );
}
