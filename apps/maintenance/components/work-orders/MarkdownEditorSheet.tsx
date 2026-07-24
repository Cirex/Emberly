import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Image,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  canDictate,
  dictationNotice,
  shouldOfferDictation,
} from "@/lib/dictation/availability-notice";
import {
  activeStyles,
  toggleBold,
  toggleCheckboxAtLine,
  toggleLineStyle,
} from "@/lib/markdown-edit";
import { MarkdownLite } from "./markdown";
import { PhotoMarkupSheet } from "./PhotoMarkupSheet";
import { useDictation } from "@/lib/dictation/use-dictation";
import { useSettings } from "@/lib/stores/settings";
import { MUTED, NAVY, OLIVE_TEXT } from "@/theme/tokens";

const SLATE = "#4C556F";
const RED = "#D1382E";

type Mode = "write" | "preview";
type Selection = { start: number; end: number };

/**
 * Markdown editor for description / technician notes (approved mockup
 * b2ecb737): the pageSheet keeps its Cancel / Save frame and grows
 * - a Write ⇄ Preview segmented toggle (Preview = the detail screen's
 *   MarkdownLite renderer, checkboxes tappable to flip [ ] ⇄ [x]),
 * - a glass formatting toolbar docked above the keyboard (Bold, Heading
 *   cycling # → ## → off, Bullet, Checkbox) lighting olive at the caret,
 * - tinted syntax in the write view: the input renders nested Text spans so
 *   markers (**, #, - [ ]) read in olive/faded while the text stays a plain
 *   TextInput underneath.
 */
export function MarkdownEditorSheet({
  visible,
  title,
  initialText,
  dark,
  paper,
  ink,
  allowPhotos = false,
  onSave,
  onClose,
}: {
  visible: boolean;
  title: string;
  initialText: string;
  dark: boolean;
  paper: string;
  ink: string;
  /** Offer the camera. Notes get photos; the description field doesn't. */
  allowPhotos?: boolean;
  /** Photos are local file URIs; the caller owns queuing them for upload. */
  onSave: (text: string, photoUris: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height: windowH } = useWindowDimensions();
  const inputRef = useRef<TextInput>(null);
  const [draft, setDraft] = useState(initialText);
  const [mode, setMode] = useState<Mode>("write");
  // Keyboard overlap, tracked from the frame's screen position. Neither
  // KeyboardAvoidingView nor InputAccessoryView survives a Modal pageSheet
  // (the first mis-measures, the second never attaches), so the sheet pads
  // itself — a pageSheet reaches the screen bottom, so screen-space keyboard
  // coordinates map 1:1 onto it.
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const change = Keyboard.addListener("keyboardWillChangeFrame", (e) => {
      setKb(Math.max(0, windowH - e.endCoordinates.screenY));
    });
    const hide = Keyboard.addListener("keyboardWillHide", () => setKb(0));
    return () => {
      change.remove();
      hide.remove();
    };
  }, [windowH]);
  // Live selection from the input; forced = programmatic caret placement
  // after a toolbar action (passed as the selection prop for one round-trip,
  // cleared as soon as the input reports it back).
  const selRef = useRef<Selection>({ start: initialText.length, end: initialText.length });
  const [forced, setForced] = useState<Selection | null>(null);
  // Re-seed the draft each time the sheet opens for a (possibly different) field.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  // Photos attached to this note, as local file URIs. Cleared with the draft so
  // a dismissed sheet never resurrects a previous field's attachments.
  const [photos, setPhotos] = useState<string[]>([]);
  // Which attached photo is open in the markup editor, or null.
  const [markupIndex, setMarkupIndex] = useState<number | null>(null);
  if (visible && seededFor !== title) {
    setDraft(initialText);
    setMode("write");
    setPhotos([]);
    selRef.current = { start: initialText.length, end: initialText.length };
    setSeededFor(title);
  } else if (!visible && seededFor !== null) {
    setSeededFor(null);
  }
  const dirty = draft !== initialText || photos.length > 0;

  const hairline = dark ? "rgba(255,255,255,0.10)" : "rgba(9,27,84,0.08)";
  const active = activeStyles(draft, selRef.current.start, selRef.current.end);

  const applyEdit = (result: { text: string; selStart: number; selEnd: number }) => {
    setDraft(result.text);
    selRef.current = { start: result.selStart, end: result.selEnd };
    setForced({ start: result.selStart, end: result.selEnd });
    inputRef.current?.focus();
  };
  const onToolbar = (kind: "bold" | "heading" | "bullet" | "checkbox") => {
    const { start, end } = selRef.current;
    applyEdit(kind === "bold" ? toggleBold(draft, start, end) : toggleLineStyle(draft, start, end, kind));
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    if (next === "preview") Keyboard.dismiss();
    else inputRef.current?.focus();
  };

  // Dictation writes into the same draft the keyboard does, at the same caret.
  // Getters rather than values: the recognizer's callbacks outlive this render.
  const language = useSettings((s) => s.language);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dictation = useDictation({
    language,
    getText: () => draftRef.current,
    getSelection: () => selRef.current,
    onText: (text, caret) => {
      setDraft(text);
      selRef.current = { start: caret, end: caret };
      setForced({ start: caret, end: caret });
    },
  });
  // Preview has no caret to dictate into, so a running session ends with the mode.
  useEffect(() => {
    if (mode === "preview" && dictation.listening) dictation.toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // The mic always renders on iOS. When it can't run it says why, because a
  // control that silently disappears is indistinguishable from one that was
  // never built — which is exactly how this went unnoticed.
  const offersDictation = shouldOfferDictation({
    availability: dictation.availability,
    moduleLinked: dictation.moduleLinked,
    platform: Platform.OS,
  });
  const dictationUsable = canDictate(dictation.availability);
  const onMicPress = () => {
    if (dictationUsable) {
      dictation.toggle();
      return;
    }
    const notice = dictationNotice({
      availability: dictation.availability,
      moduleLinked: dictation.moduleLinked,
      platform: Platform.OS,
    });
    if (notice) Alert.alert(notice.title, notice.body);
  };

  // Photos ride the same capture path as completion photos; the caller queues
  // them on save so a cancelled sheet uploads nothing.
  const pickPhoto = () => {
    Keyboard.dismiss();
    const attach = (result: ImagePicker.ImagePickerResult) => {
      const uri = result.assets?.[0]?.uri;
      if (result.canceled || !uri) return;
      setPhotos((prev) => [...prev, uri]);
    };
    Alert.alert(t("workOrders.closeFlow.addPhoto"), undefined, [
      {
        text: t("workOrders.closeFlow.takePhoto"),
        onPress: () => void ImagePicker.launchCameraAsync({ quality: 0.7 }).then(attach),
      },
      {
        text: t("workOrders.closeFlow.chooseFromLibrary"),
        onPress: () =>
          void ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 }).then(
            attach,
          ),
      },
      { text: t("workOrders.closeFlow.cancel"), style: "cancel" },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: paper, paddingBottom: mode === "write" ? kb : 0 }}>
        {/* Header — unchanged frame: Cancel / title / Save-when-dirty. */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 10,
            borderBottomWidth: 1,
            borderBottomColor: hairline,
          }}
        >
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={8}>
            <Text style={{ fontSize: 13.5, fontWeight: "600", color: MUTED }}>Cancel</Text>
          </Pressable>
          <Text style={{ fontSize: 13.5, fontWeight: "800", color: ink, letterSpacing: -0.1 }}>{title}</Text>
          <Pressable
            onPress={() => onSave(draft, photos)}
            disabled={!dirty}
            accessibilityRole="button"
            hitSlop={8}
            style={{
              paddingHorizontal: 14,
              height: 30,
              borderRadius: 999,
              backgroundColor: dirty ? OLIVE_TEXT : dark ? "rgba(255,255,255,0.10)" : "rgba(9,27,84,0.08)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 12.5, fontWeight: "700", color: dirty ? "#FFFFFF" : MUTED }}>Save</Text>
          </Pressable>
        </View>

        {/* Write ⇄ Preview */}
        <View style={{ alignItems: "center", paddingTop: 10, paddingBottom: 4 }}>
          <View
            style={{
              flexDirection: "row",
              gap: 2,
              padding: 3,
              borderRadius: 999,
              backgroundColor: dark ? "rgba(255,255,255,0.08)" : "rgba(9,27,84,0.06)",
            }}
          >
            {(
              [
                ["write", "pencil-outline", "Write"],
                ["preview", "eye-outline", "Preview"],
              ] as const
            ).map(([key, icon, label]) => {
              const on = mode === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => switchMode(key)}
                  accessibilityRole="button"
                  accessibilityState={on ? { selected: true } : {}}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    paddingHorizontal: 16,
                    paddingVertical: 5,
                    borderRadius: 999,
                    backgroundColor: on ? (dark ? "rgba(255,255,255,0.14)" : "#FFFFFF") : "transparent",
                    shadowColor: NAVY,
                    shadowOpacity: on && !dark ? 0.14 : 0,
                    shadowRadius: 6,
                    shadowOffset: { width: 0, height: 2 },
                  }}
                >
                  <Ionicons name={icon} size={12} color={on ? OLIVE_TEXT : MUTED} />
                  <Text style={{ fontSize: 11.5, fontWeight: "700", color: on ? OLIVE_TEXT : MUTED }}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {mode === "write" ? (
          <>
            {/* The input renders highlighted spans as children — the text
                content equals `draft` exactly, so editing behaves like a
                plain input while the syntax reads tinted. */}
            <TextInput
              ref={inputRef}
              onChangeText={(t) => {
                setDraft(t);
                setForced(null);
              }}
              onSelectionChange={(e) => {
                selRef.current = e.nativeEvent.selection;
                if (forced) setForced(null);
              }}
              selection={forced ?? undefined}
              multiline
              autoFocus
              textAlignVertical="top"
              placeholder={`Write the ${title.toLowerCase()}…`}
              placeholderTextColor={MUTED}
              style={{ flex: 1, padding: 18, paddingTop: 14, fontSize: 14.5, lineHeight: 21, color: ink }}
            >
              <HighlightedSource text={draft} ink={ink} dark={dark} />
            </TextInput>

            {/* Attached photos, between the note and the toolbar that added
                them. Removable until save — nothing uploads from here. */}
            {photos.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}
              >
                {photos.map((uri, i) => (
                  <Pressable
                    key={`${uri}:${i}`}
                    onPress={() => setMarkupIndex(i)}
                    accessibilityRole="button"
                    accessibilityLabel="Mark up photo"
                    style={{ width: 56, height: 56 }}
                  >
                    <Image
                      source={{ uri }}
                      style={{ width: 56, height: 56, borderRadius: 12, backgroundColor: hairline }}
                    />
                    {/* A pencil badge signals the thumbnail is tappable to draw on. */}
                    <View
                      style={{
                        position: "absolute",
                        bottom: 3,
                        left: 3,
                        width: 17,
                        height: 17,
                        borderRadius: 9,
                        backgroundColor: "rgba(9,13,19,0.62)",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <MaterialCommunityIcons name="pencil" size={10} color="#FFFFFF" />
                    </View>
                    <Pressable
                      onPress={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                      accessibilityRole="button"
                      accessibilityLabel={t("workOrders.closeFlow.removePhoto")}
                      hitSlop={8}
                      style={{
                        position: "absolute",
                        top: 3,
                        right: 3,
                        width: 17,
                        height: 17,
                        borderRadius: 9,
                        backgroundColor: "rgba(9,13,19,0.62)",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Ionicons name="close" size={11} color="#FFFFFF" />
                    </Pressable>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}

            {/* Dictation state, docked above the toolbar so the mic's effect is
                visible without stealing room from the editor. */}
            {dictation.listening || dictation.error ? (
              <DictationBand
                listening={dictation.listening}
                error={dictation.error}
                language={language}
                hairline={hairline}
                onDismissError={dictation.clearError}
              />
            ) : null}

            {/* Formatting toolbar — sits above the tracked keyboard overlap. */}
            <Toolbar dark={dark} hairline={hairline} bottomInset={kb === 0 ? Math.max(insets.bottom, 8) : 8}>
              <ToolButton on={active.bold} onPress={() => onToolbar("bold")} label="Bold">
                <Text style={{ fontSize: 15, fontWeight: "800", color: active.bold ? OLIVE_TEXT : toolIdle(dark) }}>B</Text>
              </ToolButton>
              <ToolButton
                on={active.line === "h1" || active.line === "h2"}
                onPress={() => onToolbar("heading")}
                label="Heading"
              >
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: "800",
                    color: active.line === "h1" || active.line === "h2" ? OLIVE_TEXT : toolIdle(dark),
                  }}
                >
                  H{active.line === "h2" ? "2" : active.line === "h1" ? "1" : ""}
                </Text>
              </ToolButton>
              <View style={{ width: 1, height: 20, backgroundColor: hairline }} />
              <ToolButton on={active.line === "bullet"} onPress={() => onToolbar("bullet")} label="Bullet list">
                <MaterialCommunityIcons
                  name="format-list-bulleted"
                  size={18}
                  color={active.line === "bullet" ? OLIVE_TEXT : toolIdle(dark)}
                />
              </ToolButton>
              <ToolButton on={active.line === "checkbox"} onPress={() => onToolbar("checkbox")} label="Checklist">
                <MaterialCommunityIcons
                  name="checkbox-marked-outline"
                  size={18}
                  color={active.line === "checkbox" ? OLIVE_TEXT : toolIdle(dark)}
                />
              </ToolButton>
              {allowPhotos || offersDictation ? (
                <View style={{ width: 1, height: 20, backgroundColor: hairline }} />
              ) : null}
              {allowPhotos ? (
                <ToolButton on={false} onPress={pickPhoto} label={t("workOrders.closeFlow.addPhoto")}>
                  <MaterialCommunityIcons name="camera-outline" size={20} color={toolIdle(dark)} />
                </ToolButton>
              ) : null}
              {/* Android has no Apple Speech twin, so the mic stays hidden there.
                  On iOS it always renders: when it can't run it explains why
                  rather than vanishing, which used to make an old binary look
                  identical to a feature that was never built. */}
              {offersDictation ? (
                <ToolButton
                  on={dictation.listening}
                  onPress={onMicPress}
                  label={dictation.listening ? "Stop dictation" : "Dictate"}
                >
                  <MaterialCommunityIcons
                    name={dictation.listening ? "microphone" : "microphone-outline"}
                    size={20}
                    color={
                      dictation.listening ? RED : dictationUsable ? toolIdle(dark) : MUTED
                    }
                    style={dictationUsable ? undefined : { opacity: 0.55 }}
                  />
                </ToolButton>
              ) : null}
            </Toolbar>
          </>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 24 }}
            keyboardShouldPersistTaps="handled"
          >
            {draft.trim().length > 0 ? (
              <MarkdownLite
                text={draft}
                ink={ink}
                onToggleLine={(line) => setDraft((d) => toggleCheckboxAtLine(d, line))}
              />
            ) : (
              <Text style={{ fontSize: 12.5, color: MUTED }}>Nothing to preview yet.</Text>
            )}
          </ScrollView>
        )}
      </View>

      {/* Photo markup, over the editor. Save swaps the flattened copy in place;
          the marked image is what rides the upload queue. */}
      <PhotoMarkupSheet
        visible={markupIndex !== null}
        sourceUri={markupIndex !== null ? photos[markupIndex] ?? null : null}
        onCancel={() => setMarkupIndex(null)}
        onSave={(markedUri) => {
          setPhotos((prev) => prev.map((u, i) => (i === markupIndex ? markedUri : u)));
          setMarkupIndex(null);
        }}
      />
    </Modal>
  );
}

function toolIdle(dark: boolean): string {
  return dark ? "rgba(255,255,255,0.72)" : SLATE;
}

/**
 * "Listening" state for dictation, or the reason it stopped.
 *
 * The on-device claim is stated plainly rather than implied: maintenance notes
 * name residents and units, and a tech holding the phone to their mouth in
 * someone's kitchen deserves to know the audio isn't leaving it.
 */
function DictationBand({
  listening,
  error,
  language,
  hairline,
  onDismissError,
}: {
  listening: boolean;
  error: string | null;
  language: string;
  hairline: string;
  onDismissError: () => void;
}) {
  const { t } = useTranslation();
  if (error) {
    return (
      <Pressable
        onPress={onDismissError}
        accessibilityRole="button"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          marginHorizontal: 12,
          paddingVertical: 9,
          paddingHorizontal: 12,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: "rgba(209,56,46,0.24)",
          backgroundColor: "rgba(209,56,46,0.08)",
        }}
      >
        <Ionicons name="alert-circle-outline" size={15} color={RED} />
        <Text style={{ flex: 1, fontSize: 11.5, fontWeight: "700", color: RED }} numberOfLines={2}>
          {error}
        </Text>
        <Ionicons name="close" size={14} color={RED} />
      </Pressable>
    );
  }
  if (!listening) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={t("dictation.listening")}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        marginHorizontal: 12,
        paddingVertical: 9,
        paddingHorizontal: 12,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: "rgba(209,56,46,0.24)",
        backgroundColor: "rgba(209,56,46,0.08)",
      }}
    >
      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: RED }} />
      <Text style={{ flex: 1, fontSize: 11.5, fontWeight: "800", color: RED }}>
        {t("dictation.listening")}
        <Text style={{ fontWeight: "600", color: MUTED }}> · {t("dictation.onDevice")}</Text>
      </Text>
      <View
        style={{
          borderRadius: 999,
          borderWidth: 1,
          borderColor: hairline,
          paddingHorizontal: 9,
          paddingVertical: 3,
        }}
      >
        <Text style={{ fontSize: 10, fontWeight: "800", color: OLIVE_TEXT }}>
          {language.toUpperCase()}
        </Text>
      </View>
    </View>
  );
}

/** The formatting capsule, rendered inline above the keyboard overlap. */
function Toolbar({
  dark,
  hairline,
  bottomInset,
  children,
}: {
  dark: boolean;
  hairline: string;
  bottomInset: number;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-evenly",
        marginHorizontal: 10,
        marginTop: 8,
        marginBottom: bottomInset,
        height: 46,
        borderRadius: 999,
        backgroundColor: dark ? "rgba(40,44,52,0.96)" : "rgba(255,255,255,0.94)",
        borderWidth: 1,
        borderColor: dark ? "rgba(255,255,255,0.12)" : hairline,
        shadowColor: NAVY,
        shadowOpacity: dark ? 0 : 0.14,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 6 },
      }}
    >
      {children}
    </View>
  );
}

function ToolButton({
  on,
  onPress,
  label,
  children,
}: {
  on: boolean;
  onPress: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={on ? { selected: true } : {}}
      hitSlop={6}
      style={{
        width: 44,
        height: 36,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: on ? "rgba(132,143,13,0.14)" : "transparent",
      }}
    >
      {children}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Tinted source — nested Text spans whose concatenation EQUALS the draft.

const LINE_PREFIX_RE = /^(\s*)(## |# (?!#)|- \[( |x|\*)\] |- (?!\[))/i;

function HighlightedSource({ text, ink, dark }: { text: string; ink: string; dark: boolean }) {
  const tokenTint = OLIVE_TEXT;
  const markerTint = dark ? "rgba(255,255,255,0.38)" : "rgba(9,27,84,0.35)";
  const lines = text.split("\n");
  return (
    <Text>
      {lines.map((line, li) => {
        const prefix = LINE_PREFIX_RE.exec(line);
        const head = prefix ? prefix[0] : "";
        const rest = line.slice(head.length);
        const isHeading = head.trimStart().startsWith("#");
        const parts = rest.split("**");
        return (
          <Fragment key={li}>
            {li > 0 ? "\n" : null}
            {head.length > 0 ? (
              <Text style={{ color: tokenTint, fontWeight: "700" }}>{head}</Text>
            ) : null}
            {parts.map((part, pi) => (
              <Fragment key={pi}>
                {pi > 0 ? <Text style={{ color: markerTint, fontWeight: "600" }}>**</Text> : null}
                <Text
                  style={{
                    color: ink,
                    fontWeight: isHeading || pi % 2 === 1 ? "700" : "400",
                  }}
                >
                  {part}
                </Text>
              </Fragment>
            ))}
          </Fragment>
        );
      })}
    </Text>
  );
}
