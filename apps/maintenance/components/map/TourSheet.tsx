import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTour, type CompletedTour, type TourStop } from "@/lib/stores/tour";
import { HAIRLINE_STRONG, MUTED, NAVY, OLIVE_TEXT } from "@/theme/tokens";

/**
 * The tour route bottom sheet — port of TourRouteSheet + TourHistorySheet
 * (KrakenPropertyMap) in the FilterSheet glass language. Self-contained leaf
 * modal: reads the tour store directly, so the host screen only supplies
 * visibility and the map fly-to hook.
 *
 * Departures from the Swift original, by design: drag-reorder becomes
 * up/down chevrons (RN drag-sort without a new dependency is fragile), and
 * swipe-to-delete becomes an explicit remove button.
 */

const GREEN = "#33A666";
const RED = "#D1382E";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

/** 26px round header action, matching FilterSheet's close button. */
function HeaderIconBtn({
  icon,
  label,
  color = NAVY,
  onPress,
}: {
  icon: IconName;
  label: string;
  color?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={{
        width: 26,
        height: 26,
        borderRadius: 13,
        backgroundColor: "rgba(9,27,84,0.07)",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ionicons name={icon} size={14} color={color} />
    </Pressable>
  );
}

/** Small square row action (reorder / note / locate / remove). */
function RowIconBtn({
  icon,
  label,
  color = MUTED,
  disabled,
  onPress,
}: {
  icon: IconName;
  label: string;
  color?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={4}
      style={{
        width: 26,
        height: 26,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.3 : 1,
      }}
    >
      <Ionicons name={icon} size={15} color={color} />
    </Pressable>
  );
}

function StopRow({
  stop,
  index,
  isFirst,
  isLast,
  editingNote,
  onToggleDone,
  onToggleNote,
  onNoteChange,
  onLocate,
  onMove,
  onRemove,
}: {
  stop: TourStop;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  editingNote: boolean;
  onToggleDone: () => void;
  onToggleNote: () => void;
  onNoteChange: (t: string) => void;
  onLocate: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <View
      style={{
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: HAIRLINE_STRONG,
        paddingVertical: 9,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {/* Numbered disc → green check when done (TourStopRow). */}
        <Pressable
          onPress={onToggleDone}
          accessibilityRole="button"
          accessibilityLabel={stop.isDone ? "Mark not done" : "Mark done"}
          hitSlop={6}
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            backgroundColor: stop.isDone ? GREEN : "rgba(162,169,33,0.92)",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {stop.isDone ? (
            <Ionicons name="checkmark" size={14} color="#FFFFFF" />
          ) : (
            <Text style={{ fontSize: 12, fontWeight: "800", color: "#FFFFFF" }}>{index + 1}</Text>
          )}
        </Pressable>

        <View style={{ flex: 1, gap: 1 }}>
          <Text
            numberOfLines={1}
            style={{
              fontSize: 13.5,
              fontWeight: "700",
              color: stop.isDone ? MUTED : NAVY,
              textDecorationLine: stop.isDone ? "line-through" : "none",
            }}
          >
            Unit {stop.unitNumber}
          </Text>
          {!editingNote && stop.note ? (
            <Text numberOfLines={1} style={{ fontSize: 11.5, color: MUTED, fontStyle: "italic" }}>
              {stop.note}
            </Text>
          ) : null}
        </View>

        <RowIconBtn icon="chevron-up" label="Move up" disabled={isFirst} onPress={() => onMove(-1)} />
        <RowIconBtn icon="chevron-down" label="Move down" disabled={isLast} onPress={() => onMove(1)} />
        <RowIconBtn
          icon={editingNote ? "chevron-up" : "document-text-outline"}
          label={editingNote ? "Hide note" : "Edit note"}
          color={stop.note || editingNote ? OLIVE_TEXT : MUTED}
          onPress={onToggleNote}
        />
        <RowIconBtn icon="location-outline" label="Show on map" color={OLIVE_TEXT} onPress={onLocate} />
        <RowIconBtn icon="close" label="Remove stop" color={RED} onPress={onRemove} />
      </View>

      {editingNote ? (
        <TextInput
          value={stop.note}
          onChangeText={onNoteChange}
          placeholder="Add a note for this stop…"
          placeholderTextColor={MUTED}
          multiline
          autoFocus
          style={{
            marginLeft: 38,
            fontSize: 12.5,
            color: NAVY,
            backgroundColor: "rgba(255,255,255,0.65)",
            borderWidth: 1,
            borderColor: HAIRLINE_STRONG,
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 7,
            minHeight: 40,
            textAlignVertical: "top",
          }}
        />
      ) : null}
    </View>
  );
}

function HistoryRow({ tour, onDelete }: { tour: CompletedTour; onDelete: () => void }) {
  const d = new Date(tour.completedAt);
  const done = tour.stops.filter((s) => s.isDone).length;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: HAIRLINE_STRONG,
        paddingVertical: 10,
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: "rgba(9,27,84,0.07)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name="flag" size={13} color={MUTED} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ fontSize: 13, fontWeight: "700", color: NAVY }}>
          {d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          <Text style={{ fontWeight: "500", color: MUTED }}>
            {"  ·  "}
            {d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </Text>
        </Text>
        <Text style={{ fontSize: 11.5, color: MUTED }}>
          {tour.stops.length} stop{tour.stops.length === 1 ? "" : "s"}
          {done > 0 ? <Text style={{ color: GREEN, fontWeight: "600" }}> · {done} done</Text> : null}
        </Text>
      </View>
      <RowIconBtn icon="trash-outline" label="Delete tour" color={RED} onPress={onDelete} />
    </View>
  );
}

export function TourSheet({
  visible,
  onClose,
  onLocate,
}: {
  visible: boolean;
  onClose: () => void;
  onLocate: (unitNumber: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const tour = useTour();
  const [showHistory, setShowHistory] = useState(false);
  const [noteEditId, setNoteEditId] = useState<string | undefined>();

  const close = () => {
    setShowHistory(false);
    setNoteEditId(undefined);
    onClose();
  };

  const historyView = showHistory && tour.history.length > 0;
  const sortedHistory = [...tour.history].sort((a, b) => b.completedAt - a.completedAt);

  const confirmComplete = () =>
    Alert.alert(
      "Complete Tour?",
      "This will save the current route to history and clear the active tour.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Complete & Save",
          onPress: () => {
            tour.completeTour();
            close();
          },
        },
      ],
    );

  const confirmClear = () =>
    Alert.alert("Clear all stops?", "This removes the whole route without saving it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear All", style: "destructive", onPress: tour.clearStops },
    ]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          onPress={close}
          accessibilityLabel="Close tour sheet"
          style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(9,27,84,0.30)" }]}
        />
        <View
          style={{
            maxHeight: "78%",
            borderTopLeftRadius: 26,
            borderTopRightRadius: 26,
            overflow: "hidden",
            borderWidth: 1,
            borderColor: HAIRLINE_STRONG,
          }}
        >
          {/* Liquid glass sheet: blur over the dimmed map, warm-paper wash on top. */}
          <BlurView intensity={44} tint="light" style={{ backgroundColor: "rgba(252,250,244,0.72)" }}>
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }}
              keyboardShouldPersistTaps="handled"
            >
              {/* Header ---------------------------------------------------- */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                {historyView ? (
                  <>
                    <HeaderIconBtn icon="chevron-back" label="Back to route" onPress={() => setShowHistory(false)} />
                    <Text style={{ fontSize: 15, fontWeight: "700", color: NAVY }}>Tour History</Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="footsteps" size={15} color={NAVY} />
                    <Text style={{ fontSize: 15, fontWeight: "700", color: NAVY }}>Tour Route</Text>
                    {tour.stops.length > 0 ? (
                      <View
                        style={{
                          backgroundColor: "rgba(162,169,33,0.18)",
                          borderRadius: 999,
                          paddingHorizontal: 8,
                          paddingVertical: 2.5,
                        }}
                      >
                        <Text style={{ fontSize: 10.5, fontWeight: "700", color: OLIVE_TEXT }}>
                          {tour.stops.length} stop{tour.stops.length === 1 ? "" : "s"}
                        </Text>
                      </View>
                    ) : null}
                  </>
                )}
                <View style={{ flex: 1 }} />
                {!historyView && tour.history.length > 0 ? (
                  <HeaderIconBtn icon="time-outline" label="Tour history" onPress={() => setShowHistory(true)} />
                ) : null}
                {!historyView && tour.stops.length > 2 ? (
                  <HeaderIconBtn icon="shuffle" label="Optimize route order" color={OLIVE_TEXT} onPress={tour.optimize} />
                ) : null}
                {!historyView && tour.stops.length > 0 ? (
                  <HeaderIconBtn icon="flag" label="Complete tour" color={GREEN} onPress={confirmComplete} />
                ) : null}
                {!historyView && tour.stops.length > 0 ? (
                  <HeaderIconBtn icon="trash-outline" label="Clear all stops" color={RED} onPress={confirmClear} />
                ) : null}
                <HeaderIconBtn icon="close" label="Close" onPress={close} />
              </View>

              {/* Body ------------------------------------------------------ */}
              {historyView ? (
                <View style={{ marginTop: 6 }}>
                  {sortedHistory.map((t) => (
                    <HistoryRow key={t.id} tour={t} onDelete={() => tour.deleteHistory(t.id)} />
                  ))}
                </View>
              ) : tour.stops.length === 0 ? (
                <View style={{ alignItems: "center", paddingVertical: 44, gap: 10 }}>
                  <Ionicons name="map-outline" size={34} color="rgba(9,27,84,0.25)" />
                  <Text style={{ fontSize: 13.5, fontWeight: "700", color: NAVY }}>No stops yet</Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: MUTED,
                      textAlign: "center",
                      paddingHorizontal: 32,
                      lineHeight: 17,
                    }}
                  >
                    Enable Tour Mode on the map, then tap units to add them.
                  </Text>
                </View>
              ) : (
                <View style={{ marginTop: 6 }}>
                  {tour.stops.map((stop, index) => (
                    <StopRow
                      key={stop.id}
                      stop={stop}
                      index={index}
                      isFirst={index === 0}
                      isLast={index === tour.stops.length - 1}
                      editingNote={noteEditId === stop.id}
                      onToggleDone={() => tour.toggleDone(stop.id)}
                      onToggleNote={() => setNoteEditId((prev) => (prev === stop.id ? undefined : stop.id))}
                      onNoteChange={(t) => tour.setNote(stop.id, t)}
                      onLocate={() => {
                        onLocate(stop.unitNumber);
                        close();
                      }}
                      onMove={(direction) => tour.moveStop(stop.id, direction)}
                      onRemove={() => tour.removeStop(stop.id)}
                    />
                  ))}
                </View>
              )}
            </ScrollView>
          </BlurView>
        </View>
      </View>
    </Modal>
  );
}
