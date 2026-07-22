/**
 * Side-effect import barrel: every module imported here self-registers with
 * the sync registry (lib/sync-registry.ts) at import time. The tabs layout
 * imports THIS file once, which is what arms the 60s/foreground sync tick for
 * every participant.
 *
 * Wave-2 feature agents: append your store module's import line here (one
 * line per store; keep the list alphabetical). Your module must call
 * `registerSync("<name>", fn)` at module scope — see lib/stores/units.ts for
 * the reference pattern.
 */
import "@/lib/stores/delinquency";
import "@/lib/stores/leases";
import "@/lib/stores/ledger";
import "@/lib/stores/mlgw";
import "@/lib/stores/people";
import "@/lib/stores/renewals";
import "@/lib/stores/snapshots";
import "@/lib/stores/units";
import "@/lib/stores/work-orders";
