"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAdminJson } from "../_components/admin-fetch";

/** The drawn map's page space (unitmap.svg viewBox). */
const PAGE_W = 5347;
const PAGE_H = 2903;

const MIN_SCALE = 0.1;
const MAX_SCALE = 3;

/** The security app's pin palette — same colors, same order. */
const PIN_PALETTE = [
  "#A2A921", "#767B24", "#D1382E", "#E38736",
  "#E3B23A", "#2E8A5F", "#458ADB", "#7A6BC7",
  "#D4537E", "#5B7C99", "#70788F", "#091B54",
];

/**
 * The security app's curated pin glyphs, rendered from the same Ionicons font
 * the iPads draw with (public/fonts/Ionicons.ttf) — codepoints from the
 * @expo/vector-icons glyphmap.
 */
const PIN_ICONS: Array<{ name: string; label: string; glyph: string }> = [
  { name: "document-text", label: "Note", glyph: "\u{f2b3}" },
  { name: "lock-open", label: "Unlocked", glyph: "\u{f3ca}" },
  { name: "trash", label: "Trash", glyph: "\u{f5f2}" },
  { name: "warning", label: "Hazard", glyph: "\u{f628}" },
  { name: "build", label: "Repair", glyph: "\u{f1bd}" },
  { name: "car", label: "Vehicle", glyph: "\u{f1e1}" },
  { name: "water", label: "Leak", glyph: "\u{f62e}" },
  { name: "paw", label: "Animal", glyph: "\u{f499}" },
  { name: "flash", label: "Power", glyph: "\u{f316}" },
  { name: "key", label: "Key", glyph: "\u{f3a3}" },
];

function pinGlyph(icon: string): string {
  return (PIN_ICONS.find((i) => i.name === icon) ?? PIN_ICONS[0]).glyph;
}

/** Ring color distinguishes the layer at a glance; fill is the pin's own color. */
const LAYER_RING: Record<Layer, string> = { security: "#767B24", staff: "#1D4ED8" };
const LAYER_LABEL: Record<Layer, string> = { security: "Security", staff: "Staff" };

type Layer = "security" | "staff";

export interface AdminAnnotation {
  id: string;
  layer: Layer;
  origin: string;
  title: string;
  notes: string;
  normalizedX: number;
  normalizedY: number;
  colorHex: string;
  icon: string;
  photoIds: string[];
  createdByDisplayName: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  version: number;
}

interface ListResponse {
  annotations: AdminAnnotation[];
}

export interface AdminCamera {
  id: string;
  label: string;
  normalizedX: number;
  normalizedY: number;
  direction: number;
  fov: number;
  range: number;
  active: boolean;
  unifiConsoleId: string | null;
  unifiCameraId: string | null;
  hasLiveFeed: boolean;
  updatedAt: string | null;
}

interface UnifiConsole {
  consoleId: string;
  consoleName: string;
  cameras: { id: string; name: string; state: string }[];
}

const CAMERA_COLOR = "#5B7C99";

export function PropertyMapClient({
  initialAnnotations,
  initialCameras,
}: {
  initialAnnotations: AdminAnnotation[];
  initialCameras: AdminCamera[];
}) {
  const [annotations, setAnnotations] = useState(initialAnnotations);
  const [cameras, setCameras] = useState(initialCameras);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  // The dropdown picks which layer you're working on; the other layer stays
  // visible but dimmed, so a security pin dropped from an iPad is never out
  // of sight while you're on the staff layer (and vice versa).
  const [activeLayer, setActiveLayer] = useState<Layer>("security");
  const [placing, setPlacing] = useState<null | "pin" | "camera">(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 0.2 });
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [ann, cams] = await Promise.all([
        fetchAdminJson<ListResponse>("/api/admin/map-annotations"),
        fetchAdminJson<{ cameras: AdminCamera[] }>("/api/admin/map-cameras"),
      ]);
      setAnnotations(ann.annotations);
      setCameras(cams.cameras);
    } catch {
      /* poll failure is not worth a banner; the next tick retries */
    }
  }, []);

  // Live-ish: the guard iPads push on their own tick, so a quiet poll keeps
  // this view honest without anyone pressing refresh.
  useEffect(() => {
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Fit the map centered in the viewport, and keep it centered through any
  // late layout shifts (sidebar, fonts, window size) until the user takes
  // over by panning or zooming.
  const interacted = useRef(false);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const fit = () => {
      if (interacted.current) return;
      const scale = Math.min(el.clientWidth / PAGE_W, el.clientHeight / PAGE_H) * 0.98;
      setView({
        scale,
        x: (el.clientWidth - PAGE_W * scale) / 2,
        y: (el.clientHeight - PAGE_H * scale) / 2,
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    interacted.current = true;
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setView((v) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * Math.exp(-e.deltaY * 0.0015)));
      const wx = (px - v.x) / v.scale;
      const wy = (py - v.y) / v.scale;
      return { scale: next, x: px - wx * next, y: py - wy * next };
    });
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, originX: view.x, originY: view.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      d.moved = true;
      interacted.current = true;
    }
    if (d.moved) setView((v) => ({ ...v, x: d.originX + dx, y: d.originY + dy }));
  };
  const onPointerUp = async (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;

    // A clean click. In place mode it drops a pin/camera; otherwise it
    // clears whatever is selected.
    if (!placing) {
      setSelectedId(null);
      setSelectedCameraId(null);
      return;
    }
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = (e.clientX - rect.left - view.x) / view.scale / PAGE_W;
    const ny = (e.clientY - rect.top - view.y) / view.scale / PAGE_H;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;

    try {
      if (placing === "camera") {
        const data = await fetchAdminJson<{ camera: AdminCamera }>("/api/admin/map-cameras", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ normalizedX: nx, normalizedY: ny }),
        });
        setCameras((prev) => [...prev, data.camera]);
        setSelectedCameraId(data.camera.id);
        setSelectedId(null);
      } else {
        const data = await fetchAdminJson<{ annotation: AdminAnnotation }>("/api/admin/map-annotations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            layer: activeLayer,
            title: "",
            normalizedX: nx,
            normalizedY: ny,
            colorHex: activeLayer === "security" ? PIN_PALETTE[0] : PIN_PALETTE[6],
          }),
        });
        setAnnotations((prev) => [...prev, { ...data.annotation, photoIds: data.annotation.photoIds ?? [] }]);
        setSelectedId(data.annotation.id);
        setSelectedCameraId(null);
      }
      setPlacing(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to place");
    }
  };

  const selectedCamera = cameras.find((c) => c.id === selectedCameraId) ?? null;

  // UniFi inventory for the pairing picker — fetched once, the first time a
  // camera dialog opens. null = not loaded, [] = integration off or empty.
  const [unifiConsoles, setUnifiConsoles] = useState<UnifiConsole[] | null>(null);
  useEffect(() => {
    if (!selectedCameraId || unifiConsoles !== null) return;
    let cancelled = false;
    fetchAdminJson<{ consoles: UnifiConsole[] }>("/api/admin/unifi-cameras")
      .then((data) => {
        if (!cancelled) setUnifiConsoles(data.consoles);
      })
      .catch(() => {
        if (!cancelled) setUnifiConsoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCameraId, unifiConsoles]);

  const saveCamera = async (id: string, patch: Partial<AdminCamera>) => {
    setCameras((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    try {
      const data = await fetchAdminJson<{ camera: AdminCamera }>(`/api/admin/map-cameras/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setCameras((prev) => prev.map((c) => (c.id === id ? data.camera : c)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save camera");
      void refresh();
    }
  };

  const deleteCamera = async () => {
    if (!selectedCamera) return;
    try {
      await fetchAdminJson(`/api/admin/map-cameras/${selectedCamera.id}`, { method: "DELETE" });
      setCameras((prev) => prev.filter((c) => c.id !== selectedCamera.id));
      setSelectedCameraId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete camera");
      void refresh();
    }
  };

  // Long-press (350ms) arms a camera drag; moving then slides the camera under
  // the pointer and pointer-up commits the new position. A short click still
  // just selects.
  const camDrag = useRef<{ id: string; timer: number; armed: boolean; moved: boolean } | null>(null);
  const [draggingCameraId, setDraggingCameraId] = useState<string | null>(null);

  const startCameraDrag = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const timer = window.setTimeout(() => {
      if (camDrag.current?.id === id) {
        camDrag.current.armed = true;
        setDraggingCameraId(id);
      }
    }, 350);
    camDrag.current = { id, timer, armed: false, moved: false };
  };

  const moveCameraDrag = (e: React.PointerEvent) => {
    const d = camDrag.current;
    if (!d) return;
    if (!d.armed) return;
    d.moved = true;
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (e.clientX - rect.left - view.x) / view.scale / PAGE_W));
    const ny = Math.min(1, Math.max(0, (e.clientY - rect.top - view.y) / view.scale / PAGE_H));
    setCameras((prev) => prev.map((c) => (c.id === d.id ? { ...c, normalizedX: nx, normalizedY: ny } : c)));
  };

  const endCameraDrag = () => {
    const d = camDrag.current;
    camDrag.current = null;
    setDraggingCameraId(null);
    if (!d) return;
    window.clearTimeout(d.timer);
    if (d.armed && d.moved) {
      const cam = cameras.find((c) => c.id === d.id);
      if (cam) void saveCamera(d.id, { normalizedX: cam.normalizedX, normalizedY: cam.normalizedY });
    }
  };

  /** SVG wedge for a camera's coverage, page coordinates, 0° = up. */
  const conePath = (c: AdminCamera) => {
    const cx = c.normalizedX * PAGE_W;
    const cy = c.normalizedY * PAGE_H;
    const r = c.range * PAGE_W;
    const steps = 18;
    const start = c.direction - c.fov / 2;
    let d = `M ${cx} ${cy}`;
    for (let i = 0; i <= steps; i++) {
      const a = ((start + (c.fov * i) / steps) * Math.PI) / 180;
      d += ` L ${cx + r * Math.sin(a)} ${cy - r * Math.cos(a)}`;
    }
    return d + " Z";
  };

  const visible = useMemo(() => annotations.filter((a) => !a.deletedAt), [annotations]);
  const selected = annotations.find((a) => a.id === selectedId) ?? null;

  const saveSelected = async (patch: Partial<AdminAnnotation>) => {
    if (!selected) return;
    const next = { ...selected, ...patch };
    try {
      const data = await fetchAdminJson<{ annotation: AdminAnnotation }>(
        `/api/admin/map-annotations/${selected.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedVersion: selected.version,
            title: next.title,
            notes: next.notes,
            normalizedX: next.normalizedX,
            normalizedY: next.normalizedY,
            colorHex: next.colorHex,
            icon: next.icon,
          }),
        },
      );
      setAnnotations((prev) =>
        prev.map((a) => (a.id === selected.id ? { ...data.annotation, photoIds: a.photoIds } : a)),
      );
      setError(null);
    } catch (err) {
      // Most likely a version conflict — someone edited it elsewhere. Refetch
      // so the panel shows the winning copy.
      setError(err instanceof Error ? err.message : "Failed to save");
      void refresh();
    }
  };

  const deleteSelected = async () => {
    if (!selected) return;
    try {
      await fetchAdminJson(`/api/admin/map-annotations/${selected.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: selected.version }),
      });
      setAnnotations((prev) => prev.filter((a) => a.id !== selected.id));
      setSelectedId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      void refresh();
    }
  };

  const setSelectedPhotos = (annotationId: string, mutate: (ids: string[]) => string[]) => {
    setAnnotations((prev) =>
      prev.map((a) => (a.id === annotationId ? { ...a, photoIds: mutate(a.photoIds) } : a)),
    );
  };

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      {/* The pins draw their glyphs with the exact font the iPads use. */}
      <style>{`@font-face { font-family: "MapPinIcons"; src: url("/fonts/Ionicons.ttf") format("truetype"); font-display: block; }`}</style>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold text-primary">Property Map</h1>
        <p className="text-sm text-primary/60">
          Security pins sync live with the guard iPads · staff pins share with the staff map client
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">
          {error}
        </div>
      ) : null}

      <div
        ref={viewportRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={`relative h-[76vh] w-full touch-none overflow-hidden rounded-xl border border-primary/10 bg-[#DDE5C4] select-none ${
          placing ? "cursor-crosshair" : "cursor-grab"
        }`}
      >
        <div
          style={{
            position: "absolute",
            width: PAGE_W,
            height: PAGE_H,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: "0 0",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/property-map.svg"
            alt="Emberly property map"
            width={PAGE_W}
            height={PAGE_H}
            draggable={false}
            className="pointer-events-none absolute inset-0"
          />
          <svg
            width={PAGE_W}
            height={PAGE_H}
            viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}
            className="pointer-events-none absolute inset-0"
          >
            {cameras.filter((c) => c.active).map((c) => (
              <path key={c.id} d={conePath(c)} fill="rgba(51,153,255,0.16)" stroke="rgba(51,153,255,0.45)" strokeWidth={3} />
            ))}
          </svg>
          {cameras.map((c) => (
            <button
              key={c.id}
              type="button"
              onPointerDown={(e) => startCameraDrag(e, c.id)}
              onPointerMove={moveCameraDrag}
              onPointerUp={endCameraDrag}
              onPointerCancel={endCameraDrag}
              onClick={() => {
                setSelectedCameraId(c.id);
                setSelectedId(null);
              }}
              title={c.label || "Camera — hold to drag"}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-white"
              style={{
                left: c.normalizedX * PAGE_W,
                top: c.normalizedY * PAGE_H,
                width: 26 / view.scale,
                height: 26 / view.scale,
                backgroundColor: c.active ? CAMERA_COLOR : "#9AA0B2",
                border: `${3 / view.scale}px solid #FFFFFF`,
                boxShadow:
                  draggingCameraId === c.id
                    ? `0 0 0 ${7 / view.scale}px rgba(91,124,153,0.55)`
                    : selectedCameraId === c.id
                      ? `0 0 0 ${5 / view.scale}px rgba(91,124,153,0.4)`
                      : undefined,
                cursor: draggingCameraId === c.id ? "grabbing" : "pointer",
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{ width: 14 / view.scale, height: 14 / view.scale }}>
                <rect x="3" y="7" width="13" height="10" rx="2" />
                <path d="m16 10 5-3v10l-5-3" />
              </svg>
            </button>
          ))}
          {visible.map((a) => {
            const active = a.layer === activeLayer;
            const size = (active ? 28 : 20) / view.scale;
            return (
              <button
                key={a.id}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setSelectedId(a.id);
                  setSelectedCameraId(null);
                }}
                title={`${a.title || "Untitled pin"} (${LAYER_LABEL[a.layer]})`}
                className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
                style={{
                  left: a.normalizedX * PAGE_W,
                  top: a.normalizedY * PAGE_H,
                  // Counter-scale so pins stay a readable size at any zoom;
                  // the inactive layer stays on the map, just quieter.
                  width: size,
                  height: size,
                  opacity: active ? 1 : 0.55,
                  backgroundColor: a.colorHex,
                  border: `${3 / view.scale}px solid ${LAYER_RING[a.layer]}`,
                  boxShadow: selectedId === a.id ? `0 0 0 ${5 / view.scale}px rgba(9,27,84,0.35)` : undefined,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    fontFamily: "MapPinIcons",
                    color: "#FFFFFF",
                    fontSize: (active ? 15 : 11) / view.scale,
                    lineHeight: 1,
                  }}
                >
                  {pinGlyph(a.icon)}
                </span>
                {a.photoIds.length > 0 ? (
                  <span
                    aria-hidden
                    className="absolute rounded-full bg-white"
                    style={{
                      right: -3 / view.scale,
                      top: -3 / view.scale,
                      width: 10 / view.scale,
                      height: 10 / view.scale,
                      border: `${2 / view.scale}px solid ${a.colorHex}`,
                    }}
                    title={`${a.photoIds.length} photo(s)`}
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        {/* Map controls — on the canvas, where a map expects them. */}
        <div
          className="absolute left-3 top-3 flex items-center gap-2 rounded-xl border border-primary/10 bg-white/95 p-2 shadow-sm"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <select
            value={activeLayer}
            onChange={(e) => {
              setActiveLayer(e.target.value as Layer);
              setPlacing(null);
            }}
            className="h-9 rounded-lg border border-primary/20 bg-white px-2.5 text-sm font-medium text-primary"
            aria-label="Active layer"
          >
            <option value="security">Security layer</option>
            <option value="staff">Staff layer</option>
          </select>
          <button
            type="button"
            onClick={() => setPlacing((p) => (p === "pin" ? null : "pin"))}
            aria-label={placing === "pin" ? "Cancel pin drop" : `Drop a ${LAYER_LABEL[activeLayer].toLowerCase()} pin`}
            title={placing === "pin" ? "Click the map to drop — press again to cancel" : "Drop pin"}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${
              placing === "pin"
                ? "bg-primary text-white"
                : "border border-primary/20 bg-white text-primary hover:bg-primary/5"
            }`}
            style={placing === "pin" ? undefined : { borderColor: LAYER_RING[activeLayer], color: LAYER_RING[activeLayer] }}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 21s-7-6.1-7-11a7 7 0 1 1 14 0c0 4.9-7 11-7 11Z" />
              <circle cx="12" cy="10" r="2.5" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setPlacing((p) => (p === "camera" ? null : "camera"))}
            aria-label={placing === "camera" ? "Cancel camera placement" : "Place camera"}
            title={placing === "camera" ? "Click the map to place — press again to cancel" : "Place camera"}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${
              placing === "camera"
                ? "bg-primary text-white"
                : "border border-primary/20 bg-white hover:bg-primary/5"
            }`}
            style={placing === "camera" ? undefined : { borderColor: CAMERA_COLOR, color: CAMERA_COLOR }}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="7" width="13" height="10" rx="2" />
              <path d="m16 10 5-3v10l-5-3" />
            </svg>
          </button>
          {placing ? (
            <span className="pr-1 text-xs font-medium text-primary/70">
              {placing === "camera" ? "Click the map to place the camera" : "Click the map to drop"}
            </span>
          ) : null}
        </div>

        <p className="absolute bottom-2 right-3 rounded bg-white/80 px-2 py-0.5 text-xs text-primary/60">
          {Math.round(view.scale * 100)}% · scroll to zoom, drag to pan · click a pin to edit
        </p>
      </div>

      {selected ? (
        <AnnotationDialog
          annotation={selected}
          onPatch={(patch) => {
            setAnnotations((prev) => prev.map((a) => (a.id === selected.id ? { ...a, ...patch } : a)));
          }}
          onSave={saveSelected}
          onDelete={deleteSelected}
          onClose={() => setSelectedId(null)}
          onPhotos={(mutate) => setSelectedPhotos(selected.id, mutate)}
          onError={setError}
        />
      ) : null}

      {selectedCamera ? (
        <Dialog onClose={() => setSelectedCameraId(null)}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span
                className="rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
                style={{ backgroundColor: CAMERA_COLOR }}
              >
                Camera
              </span>
              {/* The name comes from the paired Protect camera — not editable here. */}
              <span className="text-sm font-semibold text-primary">
                {selectedCamera.label || "Unpaired"}
              </span>
            </div>
            <label className="flex items-center gap-2 text-sm text-primary/80">
              <input
                type="checkbox"
                checked={selectedCamera.active}
                onChange={(e) => void saveCamera(selectedCamera.id, { active: e.target.checked })}
              />
              Active
            </label>
          </div>
          {selectedCamera.hasLiveFeed ? <LiveSnapshot cameraId={selectedCamera.id} /> : null}
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-primary/70">Live feed</span>
            <select
              className="w-full rounded-lg border border-primary/20 bg-white px-3 py-2 text-sm"
              value={
                selectedCamera.unifiConsoleId && selectedCamera.unifiCameraId
                  ? `${selectedCamera.unifiConsoleId}|${selectedCamera.unifiCameraId}`
                  : ""
              }
              onChange={(e) => {
                const [consoleId, cameraId] = e.target.value ? e.target.value.split("|") : [null, null];
                void saveCamera(selectedCamera.id, {
                  unifiConsoleId: consoleId,
                  unifiCameraId: cameraId,
                  hasLiveFeed: Boolean(consoleId && cameraId),
                });
              }}
            >
              <option value="">None (marker only)</option>
              {(unifiConsoles ?? []).map((con) => (
                <optgroup key={con.consoleId} label={con.consoleName}>
                  {con.cameras.map((cam) => (
                    <option key={cam.id} value={`${con.consoleId}|${cam.id}`}>
                      {cam.name}
                      {cam.state !== "CONNECTED" ? ` (${cam.state.toLowerCase()})` : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {unifiConsoles === null ? (
              <span className="mt-1 block text-xs text-primary/50">Loading UniFi cameras…</span>
            ) : unifiConsoles.length === 0 ? (
              <span className="mt-1 block text-xs text-primary/50">
                UniFi integration is not configured or returned no cameras.
              </span>
            ) : null}
          </label>
          <CameraSlider
            label={`Aim ${Math.round(selectedCamera.direction)}°`}
            min={0}
            max={360}
            step={5}
            value={selectedCamera.direction}
            onChange={(v) => setCameras((prev) => prev.map((c) => (c.id === selectedCamera.id ? { ...c, direction: v } : c)))}
            onCommit={(v) => void saveCamera(selectedCamera.id, { direction: v })}
          />
          <CameraSlider
            label={`Field of view ${Math.round(selectedCamera.fov)}°`}
            min={20}
            max={160}
            step={5}
            value={selectedCamera.fov}
            onChange={(v) => setCameras((prev) => prev.map((c) => (c.id === selectedCamera.id ? { ...c, fov: v } : c)))}
            onCommit={(v) => void saveCamera(selectedCamera.id, { fov: v })}
          />
          <CameraSlider
            label={`Range ${Math.round(selectedCamera.range * 1000)}`}
            min={0.02}
            max={0.3}
            step={0.01}
            value={selectedCamera.range}
            onChange={(v) => setCameras((prev) => prev.map((c) => (c.id === selectedCamera.id ? { ...c, range: v } : c)))}
            onCommit={(v) => void saveCamera(selectedCamera.id, { range: v })}
          />
          <div className="flex items-center justify-between border-t border-primary/10 pt-3">
            <button
              type="button"
              onClick={() => void deleteCamera()}
              className="text-sm font-semibold text-red-600 hover:text-red-700"
            >
              Delete camera
            </button>
            <button
              type="button"
              onClick={() => setSelectedCameraId(null)}
              className="text-sm font-semibold text-primary/70 hover:text-primary"
            >
              Done
            </button>
          </div>
          <p className="text-xs text-primary/50">
            Cameras appear on the guard iPads within a minute — view-only there. Hold and drag a camera on the map to move it.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * Near-live view of a paired camera: re-fetches the snapshot every few seconds
 * while the dialog is open. The cache-busting tick doubles as the img key so a
 * failed frame retries instead of sticking.
 */
function LiveSnapshot({ cameraId }: { cameraId: string }) {
  const frameSrc = (t: number) => `/api/admin/map-cameras/${cameraId}/snapshot?w=960&t=${t}`;
  // Double buffer: the visible frame only advances once its replacement has
  // decoded, so the refresh never flashes. A failed refresh keeps the old
  // frame up and flips the badge to "retrying".
  const [shownSrc, setShownSrc] = useState<string | null>(null);
  const [loadingSrc, setLoadingSrc] = useState(() => frameSrc(Date.now()));
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const interval = setInterval(() => setLoadingSrc(frameSrc(Date.now())), 4_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId]);

  return (
    <div className="overflow-hidden rounded-xl border border-primary/10 bg-primary/5">
      <div className="relative aspect-video w-full">
        {shownSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shownSrc} alt="Live camera view" className="absolute inset-0 h-full w-full object-cover" />
        ) : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={loadingSrc}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onLoad={() => {
            setShownSrc(loadingSrc);
            setStale(false);
          }}
          onError={() => setStale(true)}
        />
        {!shownSrc ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-primary/50">
            {stale ? "Snapshot unavailable — camera may be offline" : "Connecting…"}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary/60">
        <span className={`h-1.5 w-1.5 rounded-full ${stale && shownSrc ? "bg-amber-500" : "animate-pulse bg-red-500"}`} />
        {stale && shownSrc ? "Connection lost · retrying" : "Live · refreshes every 4s"}
      </div>
    </div>
  );
}

/** Centered modal shell — Escape or the backdrop closes it. */
function Dialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#091B54]/45 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="max-h-[88vh] w-[540px] max-w-full space-y-4 overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl"
      >
        {children}
      </div>
    </div>
  );
}

function AnnotationDialog({
  annotation,
  onPatch,
  onSave,
  onDelete,
  onClose,
  onPhotos,
  onError,
}: {
  annotation: AdminAnnotation;
  onPatch: (patch: Partial<AdminAnnotation>) => void;
  onSave: (patch: Partial<AdminAnnotation>) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
  onPhotos: (mutate: (ids: string[]) => string[]) => void;
  onError: (message: string | null) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadPhoto = async (file: File) => {
    setUploading(true);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });
      const data = await fetchAdminJson<{ photo: { id: string } }>(
        `/api/admin/map-annotations/${annotation.id}/photos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataBase64, contentType: file.type || "image/jpeg" }),
        },
      );
      onPhotos((ids) => [...ids, data.photo.id]);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to upload photo");
    } finally {
      setUploading(false);
    }
  };

  const removePhoto = async (photoId: string) => {
    try {
      await fetchAdminJson(`/api/admin/map-annotation-photos/${photoId}`, { method: "DELETE" });
      onPhotos((ids) => ids.filter((id) => id !== photoId));
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete photo");
    }
  };

  return (
    <Dialog onClose={onClose}>
      <div className="flex items-center justify-between">
        <span
          className="rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
          style={{ backgroundColor: LAYER_RING[annotation.layer] }}
        >
          {LAYER_LABEL[annotation.layer]} layer
        </span>
        <span className="text-xs text-primary/50">
          {annotation.createdByDisplayName ? `by ${annotation.createdByDisplayName}` : annotation.origin}
        </span>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-primary/70">Title</span>
        <input
          className="w-full rounded-lg border border-primary/20 px-3 py-2"
          value={annotation.title}
          onChange={(e) => onPatch({ title: e.target.value })}
          onBlur={() => void onSave({})}
          placeholder="What is this pin?"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-primary/70">Notes</span>
        <textarea
          className="min-h-20 w-full rounded-lg border border-primary/20 px-3 py-2"
          value={annotation.notes}
          onChange={(e) => onPatch({ notes: e.target.value })}
          onBlur={() => void onSave({})}
          placeholder="Details for whoever finds it"
        />
      </label>

      <div>
        <span className="mb-1.5 block text-sm font-medium text-primary/70">Icon</span>
        <div className="grid grid-cols-5 gap-2">
          {PIN_ICONS.map((icon) => {
            const active = (annotation.icon || "document-text") === icon.name;
            return (
              <button
                key={icon.name}
                type="button"
                onClick={() => void onSave({ icon: icon.name })}
                className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] font-medium transition ${
                  active
                    ? "border-primary bg-primary/5 text-primary"
                    : "border-primary/15 text-primary/60 hover:bg-primary/5"
                }`}
              >
                <span
                  aria-hidden
                  className="flex h-8 w-8 items-center justify-center rounded-full text-[15px] text-white"
                  style={{ fontFamily: "MapPinIcons", backgroundColor: annotation.colorHex }}
                >
                  {icon.glyph}
                </span>
                {icon.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <span className="mb-1.5 block text-sm font-medium text-primary/70">Color</span>
        <div className="flex flex-wrap gap-2">
          {PIN_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => void onSave({ colorHex: c })}
              className="h-7 w-7 rounded-full"
              style={{
                backgroundColor: c,
                outline: annotation.colorHex === c ? "2px solid #091B54" : "none",
                outlineOffset: 2,
              }}
              aria-label={`Set color ${c}`}
            />
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-sm font-medium text-primary/70">
            Photos{annotation.photoIds.length ? ` (${annotation.photoIds.length})` : ""}
          </span>
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="text-sm font-semibold text-primary/70 hover:text-primary disabled:opacity-50"
          >
            {uploading ? "Uploading…" : "+ Add photo"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadPhoto(file);
              e.target.value = "";
            }}
          />
        </div>
        {annotation.photoIds.length === 0 ? (
          <p className="rounded-lg border border-dashed border-primary/15 px-3 py-3 text-xs text-primary/50">
            No photos yet. Field photos taken on the iPads upload here on their next sync.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {annotation.photoIds.map((photoId) => (
              <div key={photoId} className="group relative">
                <a href={`/api/admin/map-annotation-photos/${photoId}`} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/admin/map-annotation-photos/${photoId}`}
                    alt="Annotation photo"
                    className="h-28 w-full rounded-lg border border-primary/10 object-cover"
                    loading="lazy"
                  />
                </a>
                <button
                  type="button"
                  onClick={() => void removePhoto(photoId)}
                  aria-label="Delete photo"
                  className="absolute right-1 top-1 hidden h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs font-bold text-white group-hover:flex"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-primary/10 pt-3">
        {confirmDelete ? (
          <span className="flex items-center gap-3 text-sm">
            <span className="font-medium text-primary/70">Delete this pin?</span>
            <button
              type="button"
              onClick={() => void onDelete()}
              className="font-semibold text-red-600 hover:text-red-700"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="font-semibold text-primary/60 hover:text-primary"
            >
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="text-sm font-semibold text-red-600 hover:text-red-700"
          >
            Delete pin
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-sm font-semibold text-primary/70 hover:text-primary"
        >
          Done
        </button>
      </div>
    </Dialog>
  );
}

function CameraSlider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-primary/70">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        className="w-full"
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
      />
    </label>
  );
}
