/**
 * ResMan employee lookup — resolves a technician DISPLAY NAME (what the
 * work-order report and therefore the maintenance app carry) to the person
 * GUID the edit form's AssignedToPersonID wants.
 *
 * Endpoint (from WorkOrder.js `getEmployees()`, verified live 2026-08-26):
 *   GET /Employees/EmployeeList?propertyID={guid}&employeeType=Maintenance
 *   → [{ Name, PersonID, Email, PropertyID, ... }]
 *
 * "Maintenance" is what the page's own assignee combobox is populated with, so
 * it is what a technician reassignment may target. Attribution note: ResMan
 * copies AssignedToPersonID into CompletedByPersonID on completion — the
 * assignee gets the credit, which is why resolving this name correctly is the
 * whole per-technician attribution story.
 */

import type { ResManClient } from "../client";
import { ResManScrapingError } from "../errors";

export interface ResManEmployee {
  name: string;
  personId: string;
}

export async function fetchMaintenanceEmployees(
  client: ResManClient,
  propertyId: string,
): Promise<ResManEmployee[]> {
  const base = client.configuration.consumerStartUrl.replace(/\/$/, "");
  const url =
    `${base}/Employees/EmployeeList?propertyID=${encodeURIComponent(propertyId)}` +
    `&employeeType=Maintenance`;
  const response = await client.data(
    {
      url,
      method: "GET",
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
        referer: base,
      },
    },
    "GET EmployeeList",
  );
  if (response.status !== 200) {
    throw ResManScrapingError.networkError(new Error(`EmployeeList HTTP ${response.status}`));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw ResManScrapingError.parsingFailed("EmployeeList did not return JSON");
  }
  if (!Array.isArray(parsed)) {
    throw ResManScrapingError.parsingFailed("EmployeeList JSON is not an array");
  }
  const employees: ResManEmployee[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const name = (item as Record<string, unknown>).Name;
    const personId = (item as Record<string, unknown>).PersonID;
    if (typeof name === "string" && typeof personId === "string" && name.trim() && personId.trim()) {
      employees.push({ name: name.trim(), personId: personId.trim() });
    }
  }
  return employees;
}

/**
 * Case-insensitive exact-name match, and it must be UNIQUE — two employees
 * sharing a display name is an ambiguity no writer should guess through.
 * Returns an error string (for the queue row) instead of throwing, so one
 * unresolvable name fails one row, not the run.
 */
export function resolveTechnician(
  employees: readonly ResManEmployee[],
  displayName: string,
): { personId: string } | { error: string } {
  const wanted = displayName.trim().toLowerCase();
  if (!wanted) return { error: "technician name is empty" };
  const matches = employees.filter((employee) => employee.name.toLowerCase() === wanted);
  if (matches.length === 0) {
    return { error: `no maintenance employee named ${JSON.stringify(displayName.trim())}` };
  }
  if (matches.length > 1) {
    return { error: `technician name ${JSON.stringify(displayName.trim())} is ambiguous (${matches.length} matches)` };
  }
  return { personId: matches[0].personId };
}
