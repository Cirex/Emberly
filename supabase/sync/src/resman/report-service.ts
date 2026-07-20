/**
 * DevExpress report driver — port of
 * KrakenCore/Services/ResMan/ResManReportFormBuilder.swift and
 * ResManReportService.swift. Design §3.1 (`resman/reports.ts`).
 *
 * The report flow: GET the report viewer to harvest the CSRF token and the
 * DevExpress CSS/resource ids, build the export form (seeding the DevExpress
 * field conventions, including the ASP.NET checkbox "true then false" trick),
 * then POST it and download CSV. ResMan returns an HTML error page instead of
 * CSV on failure, so the export **rejects any non-200 or HTML response**.
 */

import { extractDXCss, extractRequestVerificationToken, formURLEncode } from "./client";
import type { ResManClient, ResManRequest, ResManResponse } from "./client";

export interface ResManReportEndpoint {
  viewerUrl: string;
  exportUrl: string;
  errorDomain: string;
  logName: string;
}

export interface ResManReportPageContext {
  html: string;
  csrfToken: string;
  dxCss: string;
}

/**
 * Builds the DevExpress report export form. Field order matters to the
 * DevExpress endpoint, so it is preserved exactly. Port of
 * `ResManReportFormBuilder`.
 */
export class ResManReportFormBuilder {
  private readonly fieldList: Array<[string, string]>;
  private readonly pageContext: ResManReportPageContext;

  constructor(pageContext: ResManReportPageContext, reportName: string, propertyOrGroupId: string) {
    this.pageContext = pageContext;
    this.fieldList = [
      ["__RequestVerificationToken", pageContext.csrfToken],
      ["DisplayableReportName", reportName],
      ["SetupRouteValues", "True"],
      ["PropertyOrGroupParameter.PropertyOrGroupIDs", propertyOrGroupId],
    ];
  }

  get fields(): ReadonlyArray<[string, string]> {
    return this.fieldList;
  }

  append(name: string, value: string): void {
    this.fieldList.push([name, value]);
  }

  appendMany(values: Array<[string, string]>): void {
    for (const [name, value] of values) this.fieldList.push([name, value]);
  }

  appendRepeated(name: string, values: string[]): void {
    for (const value of values) this.fieldList.push([name, value]);
  }

  /**
   * ASP.NET checkbox convention: when checked, emit `true` then `false`; when
   * unchecked, emit only `false`. Port of `appendCheckbox`.
   */
  appendCheckbox(name: string, checked: boolean): void {
    if (checked) this.fieldList.push([name, "true"]);
    this.fieldList.push([name, "false"]);
  }

  /** Append the trailing DXCss / ExportType / Export fields and return the form. */
  finish(exportType: string): Array<[string, string]> {
    this.fieldList.push(["DXCss", this.pageContext.dxCss]);
    this.fieldList.push(["ExportType", exportType]);
    this.fieldList.push(["Export", "True"]);
    return this.fieldList;
  }
}

export interface ReportServiceDeps {
  requestData: (request: ResManRequest, label: string) => Promise<ResManResponse>;
  userAgent: string;
  log?: (message: string) => void;
}

/**
 * Drives a DevExpress report end to end. Constructed from the shared client so
 * every request still passes through the rate-limited choke point. Port of
 * `ResManReportService`.
 */
export class ResManReportService {
  private readonly deps: ReportServiceDeps;

  constructor(deps: ReportServiceDeps) {
    this.deps = deps;
  }

  static fromClient(client: ResManClient): ResManReportService {
    return new ResManReportService({
      requestData: (request, label) => client.data(request, label),
      userAgent: client.userAgent,
    });
  }

  /** GET the report viewer and extract the CSRF token + DevExpress ids. */
  async loadViewerContext(endpoint: ResManReportEndpoint): Promise<ResManReportPageContext> {
    const response = await this.deps.requestData(
      {
        url: endpoint.viewerUrl,
        method: "GET",
        headers: { accept: "text/html,application/xhtml+xml" },
      },
      `GET ${endpoint.logName}-viewer`,
    );
    const html = response.text;
    const csrfToken = extractRequestVerificationToken(html);
    const dxCss = extractDXCss(html);
    this.deps.log?.(`[${endpoint.logName}-get] tokenLen=${csrfToken.length} dxCssLen=${dxCss.length}`);
    return { html, csrfToken, dxCss };
  }

  /**
   * POST the export form and return the CSV bytes. Rejects any non-200 response
   * or any response whose Content-Type contains "html" (ResMan's failure mode).
   * Port of `ResManReportService.exportCSV`.
   */
  async exportCSV(endpoint: ResManReportEndpoint, fields: Array<[string, string]>): Promise<Uint8Array> {
    const response = await this.deps.requestData(
      {
        url: endpoint.exportUrl,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: originString(endpoint.viewerUrl),
          referer: endpoint.viewerUrl,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        body: formURLEncode(fields),
      },
      `POST ${endpoint.logName}-export`,
    );

    this.deps.log?.(
      `[${endpoint.logName}] status=${response.status} contentType=${response.contentType} bytes=${response.bytes.length}`,
    );

    if (response.status !== 200 || response.contentType.toLowerCase().includes("html")) {
      const preview = response.text.slice(0, 500);
      throw new Error(
        `[${endpoint.errorDomain}] Export returned HTML, not CSV (status ${response.status}). Preview: ${preview}`,
      );
    }

    return response.bytes;
  }
}

function originString(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
