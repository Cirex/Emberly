/**
 * ResMan work-order edit-form parsing — re-exported from @emberly/core, where
 * the engine moved so the maintenance app can write to ResMan directly from
 * the device under the technician's own session while the sync worker keeps
 * the office-side queue path. One parser, one serializer, one set of guards —
 * the recon notes and fixtures live with the tests here
 * (tests/fixtures/work-order-edit-*.html), the implementation lives in
 * packages/core/src/resman-work-order-write.ts.
 */
export {
  type FormControl,
  type FormControlKind,
  type FormOption,
  type ParsedWorkOrderEditForm,
  RESMAN_PROPERTY_TIME_ZONE,
  controlWirePairs,
  controlWireValue,
  decodeEntities,
  findControl,
  formatResManDate,
  formatResManDateTime,
  parseWorkOrderEditForm,
  serializeControls,
  setControlValue,
} from "@emberly/core";
