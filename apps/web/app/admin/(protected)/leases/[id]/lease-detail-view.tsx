import Link from "next/link";
import type {
  ResmanLeaseDetail,
  ResmanLeaseFull,
  ResmanResidentWithTabs,
  ResmanTransactionSummary,
} from "@/lib/admin-resman-units";

function money(n: number | null | undefined): string {
  return n == null ? "—" : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function date(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}
function text(s: string | null | undefined): string {
  return s == null || s === "" ? "—" : s;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-primary/45">{label}</dt>
      <dd className="mt-0.5 text-sm text-primary">{value}</dd>
    </div>
  );
}

function statusPill(s: ResmanLeaseFull["status"]): string {
  const v = (s ?? "").toLowerCase();
  if (v.includes("current")) return "pill-ok";
  if (v.includes("notice") || v.includes("eviction") || v.includes("pending")) return "pill-warn";
  if (v.includes("former") || v.includes("evicted") || v.includes("denied") || v.includes("cancel")) return "pill-neutral";
  return "pill-neutral";
}

/** A small labelled sub-table used for the per-resident tab data. */
function MiniTable({ title, head, rows }: { title: string; head: string[]; rows: React.ReactNode[][] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-primary/45">{title}</p>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="admin-table">
          <thead>
            <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j} className="text-primary">{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** True when at least one field of `o` (across the given keys) is non-empty. */
function anyFilled<T>(o: T, keys: (keyof T)[]): boolean {
  return keys.some((k) => {
    const v = o[k];
    return v !== null && v !== undefined && v !== "";
  });
}

function ResidentCard({ r }: { r: ResmanResidentWithTabs }) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unnamed resident";
  // Drop fully-empty tab rows (skeleton artifacts).
  const vehicles = r.vehicles.filter((v) => anyFilled(v, ["make", "model", "year", "color", "license_plate", "license_plate_state", "parking_spot"]));
  const employment = r.employment.filter((e) => anyFilled(e, ["employer_name", "other_income_source", "position", "phone", "monthly_income", "other_income", "start_date"]));
  const insurance = r.insurance.filter((i) => anyFilled(i, ["provider", "policy_number", "policy_type", "status", "coverage_amount"]));
  const addresses = r.addresses.filter((a) => anyFilled(a, ["address_type", "street", "city", "state", "postal_code"]));
  const alternateContacts = r.alternateContacts.filter((c) => anyFilled(c, ["name", "relationship", "phone", "email"]));
  const hasTabs =
    vehicles.length || employment.length || insurance.length || addresses.length || alternateContacts.length;
  return (
    <div className="card px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-primary">{name}</h3>
        <span className="rounded bg-primary/5 px-1.5 py-0.5 text-[10px] font-bold uppercase text-primary/55">
          {r.is_primary ? "Primary" : "Occupant"}
        </span>
        {r.household_status ? <span className="text-xs text-muted">{r.household_status}</span> : null}
      </div>
      <p className="mt-1 text-xs text-muted">
        {[r.email, r.phone_numbers?.length ? r.phone_numbers.join(", ") : null].filter(Boolean).join(" · ") || "No contact on file"}
      </p>

      <MiniTable
        title="Vehicles"
        head={["Year", "Make", "Model", "Color", "Plate", "State"]}
        rows={vehicles.map((v) => [text(v.year), text(v.make), text(v.model), text(v.color), text(v.license_plate), text(v.license_plate_state)])}
      />
      <MiniTable
        title="Employment / Income"
        head={["Employer / Source", "Position", "Phone", "Monthly", "Other", "Start"]}
        rows={employment.map((e) => [text(e.employer_name || e.other_income_source), text(e.position), text(e.phone), money(e.monthly_income), money(e.other_income), date(e.start_date)])}
      />
      <MiniTable
        title="Insurance"
        head={["Provider", "Policy #", "Type", "Status", "Coverage", "Expires"]}
        rows={insurance.map((i) => [text(i.provider), text(i.policy_number), text(i.policy_type), text(i.status), money(i.coverage_amount), date(i.end_date)])}
      />
      <MiniTable
        title="Addresses"
        head={["Type", "Street", "City", "State", "Zip"]}
        rows={addresses.map((a) => [text(a.address_type), text(a.street), text(a.city), text(a.state), text(a.postal_code)])}
      />
      <MiniTable
        title="Alternate / Emergency Contacts"
        head={["Name", "Relationship", "Phone", "Email", "Emergency"]}
        rows={alternateContacts.map((c) => [text(c.name), text(c.relationship), text(c.phone), text(c.email), c.is_emergency_contact ? "Yes" : "No"])}
      />

      {!hasTabs ? <p className="mt-2 text-xs text-muted">No vehicles, employment, insurance, addresses, or contacts synced.</p> : null}
    </div>
  );
}

function LedgerTable({ transactions }: { transactions: ResmanTransactionSummary[] }) {
  if (transactions.length === 0) return <p className="card px-5 py-4 text-sm text-muted">No ledger entries for this lease.</p>;
  return (
    <div className="card overflow-x-auto">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Description</th>
            <th>Reference</th>
            <th>Charges</th>
            <th>Credits</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => (
            <tr key={t.resman_ledger_entry_id}>
              <td className="text-muted">{date(t.date)}</td>
              <td className="text-primary">{text(t.transaction_type)}</td>
              <td className="text-muted">{text(t.ledger_description)}</td>
              <td className="text-muted">{text(t.reference)}</td>
              <td className="tabular-nums text-primary">{t.charges == null ? "—" : money(t.charges)}</td>
              <td className="tabular-nums text-primary">{t.credits == null ? "—" : money(t.credits)}</td>
              <td className="tabular-nums text-primary">{money(t.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LeaseDetailView({ detail }: { detail: ResmanLeaseDetail }) {
  const { lease, residents, transactions } = detail;
  const backHref = lease.resman_unit_id ? `/admin/units/${lease.resman_unit_id}` : "/admin/units";

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <Link href={backHref} className="text-xs font-semibold text-primary/55 hover:text-primary">
            ‹ Back to Unit {text(lease.unit_number)}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-primary">
              Lease · {text(lease.unit_number)}
            </h1>
            <span className={`status-pill ${statusPill(lease.status)}`}>
              <span className="pill-dot" />
              {lease.status ?? "Unknown"}
            </span>
            {lease.is_current_lease ? <span className="status-pill pill-ok">Current</span> : null}
          </div>
        </div>
      </div>

      {/* Lease facts */}
      <div className="card px-5 py-5">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="Approval Status" value={text(lease.approval_status)} />
          <Field label="Leasing Agent" value={text(lease.leasing_agent)} />
          <Field label="Application Date" value={date(lease.application_date)} />
          <Field label="Signed Date" value={date(lease.signed_date)} />
          <Field label="Start" value={date(lease.start_date)} />
          <Field label="End" value={date(lease.end_date)} />
          <Field label="Move-in" value={date(lease.move_in_date)} />
          <Field label="Move-out" value={date(lease.move_out_date)} />
          <Field label="Renewal Date" value={date(lease.renewal_date)} />
          <Field label="Notice Given" value={date(lease.notice_given_date)} />
          <Field label="Market Rent" value={money(lease.market_rent)} />
          <Field label="Resident Rent" value={money(lease.resident_rent)} />
          <Field label="HAP Rent" value={money(lease.hap_rent)} />
          <Field label="Monthly Charge" value={money(lease.monthly_charge)} />
          <Field label="Balance" value={money(lease.balance)} />
          <Field label="Collection Balance" value={money(lease.collection_balance)} />
          {lease.reason_for_leaving ? <Field label="Reason for Leaving" value={text(lease.reason_for_leaving)} /> : null}
        </dl>
      </div>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-primary/55">
          Residents <span className="ml-1.5 font-medium text-primary/35">({residents.length})</span>
        </h2>
        {residents.length === 0 ? (
          <p className="card px-5 py-4 text-sm text-muted">No residents synced for this lease.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {residents.map((r) => (
              <ResidentCard key={r.resman_person_lease_id} r={r} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-primary/55">
          Ledger <span className="ml-1.5 font-medium text-primary/35">({transactions.length})</span>
        </h2>
        <LedgerTable transactions={transactions} />
      </section>
    </div>
  );
}
