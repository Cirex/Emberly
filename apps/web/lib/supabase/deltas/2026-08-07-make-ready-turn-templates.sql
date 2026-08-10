-- ============================================================================
-- Backfill is_make_ready for the turn checklist filed under trade categories
-- ============================================================================
--
-- WHY. `resman_work_orders.is_make_ready` is DERIVED at sync time, not ResMan's
-- raw MakeReady flag — the sync already folded in rows whose CATEGORY is plainly
-- a make-ready. It missed a second case: the property files four standard turn
-- tasks under the trade that performs them, with the flag unset.
--
--     34  Trash Out                        (Trash and Debris)
--     14  Clean, Replace, Repair flooring  (Flooring)
--     14  Rekey and reassign Traka         (Locks and Keys)
--     14  Touch up Painting                (Painting)
--
-- All 76 are Canceled/Closed/Completed, so they showed on the maintenance app's
-- CLOSED board even though make-ready has its own tab. `isOpenWorkOrder` and
-- `isClosedWorkOrder` both exclude `is_make_ready`, so setting the column is the
-- entire fix — no board code changes.
--
-- EXACT TITLE MATCH, NOT A PATTERN. The same words appear in genuine resident
-- work orders that must stay on the boards:
--
--     "flooring is pealing off in the kitchen and bathroom"
--     "the HVAC needs cleaning and it needs a filter"
--     "stove caught fire i tried cleaning it but need a new one"
--     "NO HOT WATER IN UNIT, needs touch up cleaning, and exhaust fan"
--
-- 103 rows contain a stage word in the title; only these 76 are turn work.
-- `ILIKE '%flooring%'` would hide the other 27. The four strings below are
-- template text repeated 14-34 times verbatim — deliberate, unlike free prose —
-- which is what makes exact matching safe here.
--
-- The same rules now live in packages/core (`isMakeReadyCategory`,
-- `isMakeReadyTemplateTitle`) and the sync imports them, so new rows are
-- classified on arrival. This delta only fixes rows already stored.
--
-- Idempotent: the WHERE clause matches nothing on a second run.

update public.resman_work_orders
set is_make_ready = true
where not is_make_ready
  and lower(btrim(regexp_replace(title, '\s+', ' ', 'g'))) in (
    'trash out',
    'clean, replace, repair flooring',
    'rekey and reassign traka',
    'touch up painting'
  );
