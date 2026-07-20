import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  activeStyles,
  toggleBold,
  toggleCheckboxAtLine,
  toggleLineStyle,
} from "@/lib/markdown-edit";
import { MarkdownLite } from "./markdown";
import { MUTED, NAVY, OLIVE_TEXT } from "@/theme/tokens";

const SLATE = "#4C556F";

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
  onSave,
  onClose,
}: {
  visible: boolean;
  title: string;
  initialText: string;
  dark: boolean;
  paper: string;
  ink: string;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
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
  if (visible && seededFor !== title) {
    setDraft(initialText);
    setMode("write");
    selRef.current = { start: initialText.length, end: initialText.length };
    setSeededFor(title);
  } else if (!visible && seededFor !== null) {
    setSeededFor(null);
  }
  const dirty = draft !== initialText;

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
            onPress={() => onSave(draft)}
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
    </Modal>
  );
}

function toolIdle(dark: boolean): string {
  return dark ? "rgba(255,255,255,0.72)" : SLATE;
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
