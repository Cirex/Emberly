/**
 * Make-ready board derivations (the six-stage turn checklist, move-in urgency,
 * quick filters). PROMOTED to @emberly/core (packages/core/src/make-ready.ts)
 * so the manager app's Work tab and Today card render the same turn board;
 * this module stays as the app's import path and public API.
 */
export {
  MAKE_READY_STAGES,
  buildMakeReadyGroups,
  buildTurnThroughput,
  currentStageOf,
  earliestReportedDate,
  isFullyCompletedTurn,
  isStageCompleted,
  latestCompletedDate,
  moveInUrgency,
  quickFilterCounts,
  quickFilterIncludes,
  stagesOf,
  unitIsReady,
  urgencyShowsBadge,
} from "@emberly/core";
export type {
  MakeReadyGroup,
  TurnThroughputMonth,
  MakeReadyQuickFilter,
  MakeReadyStage,
  MoveInUrgency,
} from "@emberly/core";
