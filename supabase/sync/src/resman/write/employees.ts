/**
 * ResMan employee lookup — the sync-side fetch over the shared parsing and
 * resolution in @emberly/core (the maintenance app fetches the same endpoint
 * with the device session). Endpoint from WorkOrder.js `getEmployees()`,
 * verified live 2026-08-26:
 *
 *   GET /Employees/EmployeeList?propertyID={guid}&employeeType=Maintenance
 *   → [{ Name, PersonID, Email, PropertyID, ... }]
 *
 * "Maintenance" is what the page's own assignee combobox is populated with.
 * Attribution note: ResMan copies AssignedToPersonID into CompletedByPersonID
 * on completion — the assignee gets the credit, which is why resolving this
 * name correctly is the whole per-technician attribution story for
 * queue-driven writes.
 */

import { employeeListPath, parseEmployeeList, type ResManEmployee } from "@emberly/core";
import type { ResManClient } from "../client";
import { ResManScrapingError } from "../errors";

export { resolveTechnician, type ResManEmployee } from "@emberly/core";

export async function fetchMaintenanceEmployees(
  client: ResManClient,
  propertyId: string,
): Promise<ResManEmployee[]> {
  const base = client.configuration.consumerStartUrl.replace(/\/$/, "");
  const url = `${base}${employeeListPath(propertyId)}`;
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
  return parseEmployeeList(parsed);
}
