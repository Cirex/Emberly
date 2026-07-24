import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import {
  Canvas,
  Circle,
  Group,
  Image as SkiaImage,
  ImageFormat,
  Path,
  Skia,
  useCanvasRef,
  useImage,
} from "@shopify/react-native-skia";
import { Directory, File, Paths } from "expo-file-system";
import { useMemo, useRef, useState } from "react";
import {
  LayoutChangeEvent,
  Modal,
  Pressable,
  Text,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { runOnJS } from "react-native-reanimated";
import { arrowHead, isMeaningfulStroke, rectFromCorners } from "@/lib/derived/markup-geometry";
import type { MarkupPoint, MarkupStroke, MarkupTool } from "@/lib/derived/photo-markup";

/**
 * Full-screen markup editor for a captured work-order photo.
 *
 * Draws over the image on a Skia canvas — circle, arrow, freehand, note — then
 * flattens the result to a JPEG the upload queue treats like any other photo.
 * The geometry that both the live render and the flattened output depend on
 * lives in lib/derived/markup-geometry.ts and is tested there; this file is the
 * canvas, the gestures, and the export.
 */

const TOOLS: { tool: MarkupTool; icon: keyof typeof MaterialCommunityIcons.glyphMap }[] = [
  { tool: "circle", icon: "circle-outline" },
  { tool: "arrow", icon: "arrow-top-right" },
  { tool: "freehand", icon: "draw" },
  { tool: "note", icon: "format-text" },
];

const COLORS = ["#FFD23F", "#D1382E", "#33A666", "#2563B4"];
const STROKE_WIDTH = 5;

let strokeSeq = 0;
function strokeId(): string {
  strokeSeq += 1;
  return `mk${Date.now().toString(36)}${strokeSeq.toString(36)}`;
}

function markupDir(): Directory {
  const d = new Directory(Paths.document, "work-order-photos");
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

/** Skia path for one stroke, in canvas coordinates. */
function pathFor(stroke: MarkupStroke) {
  const p = Skia.Path.Make();
  const pts = stroke.points;
  if (pts.length === 0) return p;

  if (stroke.tool === "freehand") {
    p.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) p.lineTo(pts[i].x, pts[i].y);
    return p;
  }

  const start = pts[0];
  const end = pts[pts.length - 1];
  if (stroke.tool === "circle") {
    const r = rectFromCorners(start, end);
    p.addOval(Skia.XYWHRect(r.x, r.y, r.width, r.height));
    return p;
  }
  if (stroke.tool === "arrow") {
    p.moveTo(start.x, start.y);
    p.lineTo(end.x, end.y);
    const [b1, b2] = arrowHead(start, end);
    p.moveTo(b1.x, b1.y);
    p.lineTo(end.x, end.y);
    p.lineTo(b2.x, b2.y);
    return p;
  }
  return p;
}

export function PhotoMarkupSheet({
  visible,
  sourceUri,
  onCancel,
  onSave,
}: {
  visible: boolean;
  /** The captured photo to mark up. */
  sourceUri: string | null;
  onCancel: () => void;
  /** Flattened JPEG uri + the strokes that produced it. */
  onSave: (markedUri: string, strokes: MarkupStroke[]) => void;
}) {
  const insets = useSafeAreaInsets();
  const canvasRef = useCanvasRef();
  const image = useImage(sourceUri ?? undefined);

  const [tool, setTool] = useState<MarkupTool>("circle");
  const [color, setColor] = useState(COLORS[0]);
  const [strokes, setStrokes] = useState<MarkupStroke[]>([]);
  const [live, setLive] = useState<MarkupPoint[] | null>(null);
  const [saving, setSaving] = useState(false);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const colorRef = useRef(color);
  colorRef.current = color;

  // Re-seed each open so a dismissed sheet never resurrects a prior drawing.
  const [seeded, setSeeded] = useState(false);
  if (visible && !seeded) {
    setStrokes([]);
    setLive(null);
    setSeeded(true);
  } else if (!visible && seeded) {
    setSeeded(false);
  }

  // Canvas is laid out to the image's aspect ratio inside the available box, so
  // strokes are captured in the same coordinate space they're rendered and
  // flattened in — no rescaling between draw and export.
  const [box, setBox] = useState({ width: 0, height: 0 });
  const onBox = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox({ width, height });
  };
  const fitted = useMemo(() => {
    if (!image || box.width === 0 || box.height === 0) return null;
    const scale = Math.min(box.width / image.width(), box.height / image.height());
    const w = image.width() * scale;
    const h = image.height() * scale;
    return { w, h, x: (box.width - w) / 2, y: (box.height - h) / 2 };
  }, [image, box]);

  const pushPoint = (x: number, y: number, begin: boolean) => {
    setLive((prev) => {
      if (toolRef.current === "note") return [{ x, y }];
      if (begin || prev === null) return [{ x, y }];
      if (toolRef.current === "freehand") return [...prev, { x, y }];
      return [prev[0], { x, y }]; // shapes: anchor + current corner
    });
  };

  const commitLive = () => {
    setLive((prev) => {
      if (prev && prev.length > 0) {
        const stroke: MarkupStroke = {
          id: strokeId(),
          tool: toolRef.current,
          color: colorRef.current,
          points: prev,
        };
        if (isMeaningfulStroke(stroke)) setStrokes((s) => [...s, stroke]);
      }
      return null;
    });
  };

  const pan = Gesture.Pan()
    .maxPointers(1)
    .onBegin((e) => runOnJS(pushPoint)(e.x, e.y, true))
    .onUpdate((e) => runOnJS(pushPoint)(e.x, e.y, false))
    .onEnd(() => runOnJS(commitLive)())
    .onFinalize(() => runOnJS(commitLive)());

  const liveStroke: MarkupStroke | null =
    live && live.length > 0 ? { id: "live", tool, color, points: live } : null;

  const undo = () => setStrokes((s) => s.slice(0, -1));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const snapshot = await canvasRef.current?.makeImageSnapshotAsync();
      if (!snapshot) {
        onCancel();
        return;
      }
      const bytes = snapshot.encodeToBytes(ImageFormat.JPEG, 85);
      const file = new File(markupDir(), `${strokeId()}.jpg`);
      file.write(bytes);
      onSave(file.uri, strokes);
    } finally {
      setSaving(false);
    }
  };

  const renderStroke = (s: MarkupStroke, key: string) => {
    if (s.tool === "note") {
      const at = s.points[0];
      return (
        <Circle key={key} cx={at.x} cy={at.y} r={9} color={s.color} />
      );
    }
    return (
      <Path
        key={key}
        path={pathFor(s)}
        color={s.color}
        style="stroke"
        strokeWidth={STROKE_WIDTH}
        strokeJoin="round"
        strokeCap="round"
      />
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: "#0C0F14" }}>
        {/* top bar */}
        <View
          style={{
            paddingTop: insets.top + 6,
            paddingHorizontal: 20,
            paddingBottom: 12,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Pressable onPress={onCancel} hitSlop={10} accessibilityRole="button">
            <Text style={{ color: "#B9C0D0", fontSize: 15, fontWeight: "700" }}>Cancel</Text>
          </Pressable>
          <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "800" }}>Mark up photo</Text>
          <Pressable onPress={save} hitSlop={10} accessibilityRole="button" disabled={saving}>
            <Text style={{ color: "#D9DF3B", fontSize: 15, fontWeight: "800", opacity: saving ? 0.5 : 1 }}>
              Save
            </Text>
          </Pressable>
        </View>

        {/* canvas */}
        <View style={{ flex: 1 }} onLayout={onBox}>
          <GestureDetector gesture={pan}>
            <Canvas ref={canvasRef} style={{ flex: 1 }}>
              {image && fitted ? (
                <Group>
                  <SkiaImage image={image} x={fitted.x} y={fitted.y} width={fitted.w} height={fitted.h} fit="contain" />
                  {strokes.map((s, i) => renderStroke(s, `${s.id}:${i}`))}
                  {liveStroke ? renderStroke(liveStroke, "live") : null}
                </Group>
              ) : null}
            </Canvas>
          </GestureDetector>
        </View>

        {/* tools + colors */}
        <View
          style={{
            paddingHorizontal: 16,
            paddingBottom: insets.bottom + 12,
            paddingTop: 12,
            gap: 14,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {TOOLS.map(({ tool: tl, icon }) => (
              <Pressable
                key={tl}
                onPress={() => setTool(tl)}
                accessibilityRole="button"
                accessibilityLabel={tl}
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 14,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: tool === tl ? "#FFD23F" : "rgba(255,255,255,0.09)",
                }}
              >
                <MaterialCommunityIcons name={icon} size={22} color={tool === tl ? "#12151D" : "#C7CDDA"} />
              </Pressable>
            ))}
            <View style={{ flex: 1 }} />
            <Pressable
              onPress={undo}
              disabled={strokes.length === 0}
              accessibilityRole="button"
              accessibilityLabel="Undo"
              style={{
                width: 46,
                height: 46,
                borderRadius: 14,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(255,255,255,0.09)",
                opacity: strokes.length === 0 ? 0.4 : 1,
              }}
            >
              <Ionicons name="arrow-undo" size={20} color="#C7CDDA" />
            </Pressable>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            {COLORS.map((c) => (
              <Pressable
                key={c}
                onPress={() => setColor(c)}
                accessibilityRole="button"
                accessibilityLabel={`color ${c}`}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  backgroundColor: c,
                  borderWidth: color === c ? 3 : 0,
                  borderColor: "#FFFFFF",
                }}
              />
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}
