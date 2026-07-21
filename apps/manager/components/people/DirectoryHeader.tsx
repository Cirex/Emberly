import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { Pressable, Text, TextInput, View } from "react-native";
import { PEOPLE_COLORS, ScopeChip } from "@/components/people/bits";
import { PEOPLE_SCOPES, type PeopleScope, type PeopleSearchResults } from "@/components/people/search";

/**
 * The directory's header: the BoardHeader mode pill ("People · 1,204") on a
 * light glass band, the search field, and the scope chips — the mockup's
 * search screen chrome, adapted for a modal route (which owns a close button
 * instead of the account menu).
 */
export function DirectoryHeader({
  total,
  summary,
  query,
  onQuery,
  scope,
  onScope,
  results,
  onClose,
  hPad,
}: {
  total: number;
  /** The wide-layout counts line; omitted on phone. */
  summary?: string;
  query: string;
  onQuery: (q: string) => void;
  scope: PeopleScope;
  onScope: (s: PeopleScope) => void;
  results: PeopleSearchResults;
  onClose: () => void;
  hPad: number;
}) {
  const { t } = useTranslation();

  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: "rgba(255,255,255,0.55)",
        backgroundColor: "rgba(250,247,240,0.94)",
        paddingTop: 14,
        paddingBottom: 8,
      }}
    >
      {/* Mode pill row */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: hPad }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
            height: 42,
            paddingLeft: 9,
            paddingRight: 13,
            borderRadius: 999,
            backgroundColor: "rgba(255,255,255,0.80)",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.95)",
            shadowColor: PEOPLE_COLORS.navy,
            shadowOpacity: 0.1,
            shadowRadius: 9,
            shadowOffset: { width: 0, height: 4 },
          }}
        >
          <View
            style={{
              width: 25,
              height: 25,
              borderRadius: 13,
              backgroundColor: "rgba(132,143,13,0.15)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="people" size={14} color={PEOPLE_COLORS.olive} />
          </View>
          <Text style={{ fontSize: 16, fontWeight: "800", letterSpacing: -0.3, color: PEOPLE_COLORS.navy }}>
            {t("people.title")}
          </Text>
          <View
            style={{
              minWidth: 24,
              height: 21,
              paddingHorizontal: 7,
              borderRadius: 999,
              backgroundColor: "rgba(132,143,13,0.14)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: "800",
                color: PEOPLE_COLORS.olive,
                fontVariant: ["tabular-nums"],
              }}
            >
              {total.toLocaleString()}
            </Text>
          </View>
        </View>

        {summary ? (
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 10, color: PEOPLE_COLORS.muted }}>
            {summary}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}

        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("people.close")}
          hitSlop={8}
          style={{
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: "rgba(9,27,84,0.06)",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="close" size={15} color={PEOPLE_COLORS.slate} />
        </Pressable>
      </View>

      {/* Search field */}
      <View
        style={{
          marginTop: 10,
          marginHorizontal: hPad,
          backgroundColor: "#FFFFFF",
          borderWidth: 1,
          borderColor: "rgba(9,27,84,0.12)",
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 2,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Ionicons name="search" size={14} color={PEOPLE_COLORS.faint} />
        <TextInput
          value={query}
          onChangeText={onQuery}
          placeholder={t("people.searchPlaceholder")}
          placeholderTextColor={PEOPLE_COLORS.faint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel={t("people.searchPlaceholder")}
          style={{ flex: 1, paddingVertical: 9, fontSize: 13, fontWeight: "600", color: PEOPLE_COLORS.navy }}
        />
      </View>

      {/* Scope chips */}
      <View style={{ flexDirection: "row", gap: 5, paddingHorizontal: hPad, paddingTop: 9 }}>
        {PEOPLE_SCOPES.map((s) => (
          <ScopeChip
            key={s}
            label={t(`people.scopes.${s}`)}
            count={results.counts[s]}
            active={scope === s}
            onPress={() => onScope(s)}
          />
        ))}
      </View>
    </View>
  );
}
