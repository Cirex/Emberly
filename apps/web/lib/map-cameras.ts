/** Shared bits for the map-camera routes (admin writes, scanner reads). */

export const CAMERA_SELECT =
  "id, normalized_x, normalized_y, direction, fov, range, active, unifi_console_id, unifi_camera_id, unifi_camera_name, updated_at";

export function serializeCamera(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    // The label IS the paired Protect camera's name — there is no free-text
    // label to edit; unpaired markers are simply "Camera".
    label: (row.unifi_camera_name as string) ?? "",
    normalizedX: row.normalized_x as number,
    normalizedY: row.normalized_y as number,
    direction: row.direction as number,
    fov: row.fov as number,
    range: row.range as number,
    active: Boolean(row.active),
    unifiConsoleId: (row.unifi_console_id as string) ?? null,
    unifiCameraId: (row.unifi_camera_id as string) ?? null,
    hasLiveFeed: Boolean(row.unifi_console_id && row.unifi_camera_id),
    updatedAt: (row.updated_at as string) ?? null,
  };
}
