# Admin Operations Implementation Plan

Goal: add the first operational admin portal slice for resident access health, QR and guest-pass controls, scanner management, entry audit visibility, resident detail pages, exception alerts, and resident session actions.

Architecture: keep ResMan as the upstream credential/session authority and keep raw ResMan sessions out of storage. Persist only Emberly-owned operational state: resident access freshness, guest-pass status, scanner metadata, entry logs, exception alerts, and admin actions.

Tech stack: Next.js App Router, TypeScript, Supabase service-role API routes, Supabase SQL migrations, Node test runner.

## Slice 1: Backend Model and Helpers

- Add `scanner_devices` table for registered scanner IDs, display names, location labels, enabled/disabled state, last-seen timestamp, and audit timestamps.
- Add `admin_alerts` table for resident access, guest pass, scanner, and security exceptions with severity, status, metadata, and resolution fields.
- Add helper functions for resident access health, pass status summaries, scanner health, alert derivation, and safe admin session actions.
- Do not store ResMan cookies/session material in any new table.

## Slice 2: Admin APIs

- Add resident detail API: resident profile, access health, recent entry logs, recent guest passes, ban status, and session-action affordances.
- Add resident action API: require reauthentication, mark access suspended, reset QR/TOTP seed.
- Add guest-pass action API: revoke/unrevoke a pass and extend expiration.
- Add scanner admin API: list/create/update scanner devices.
- Add alert API: list open/resolved alerts and resolve an alert.
- Extend entry logs with optional resident/guest-pass filters.

## Slice 3: Admin UI

- Add Resident Detail page at `/admin/residents/[id]`.
- Add Scanner Devices page at `/admin/scanners`.
- Add Alerts page at `/admin/alerts`.
- Improve Guest Passes with revoke/extend controls.
- Improve Entry Logs with linked resident/pass context and denial notes.
- Keep UI consistent with existing Emberly admin styling and shared admin classes.

## Verification

- Write failing tests for helper behavior before implementation.
- Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`.
- Restart the local admin server and verify the admin pages load.
