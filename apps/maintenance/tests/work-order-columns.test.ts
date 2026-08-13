import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const API = path.join(__dirname, "..", "lib", "api", "work-orders.ts");
const SOURCE = fs.readFileSync(API, "utf8");

/**
 * The work-orders list must ask for the whole public row.
 *
 * The server's `resolveProjection` falls back to the resource's
 * `defaultColumns` when no `columns` param is sent, and the work-orders default
 * is a curated dozen that does NOT include `notes` or `completion_notes`.
 *
 * That combination fails silently, which is why it survived: WorkOrderSchema
 * declares both fields with `.default("")`, so a response missing them parses
 * without complaint and every row arrives with an empty description and empty
 * technician notes. There is no by-id detail fetch — the detail screen reads
 * `wo.raw` out of the list snapshot — so the list request is the only place
 * this can be fixed.
 */

describe("the work-orders request", () => {
  test("sends an explicit column projection", () => {
    expect(SOURCE).toMatch(/q\.set\("columns",\s*COLUMNS\)/);
    // Derived from the schema, so the request and the parser cannot drift.
    expect(SOURCE).toMatch(/const COLUMNS = Object\.keys\(WorkOrderSchema\.shape\)\.join\(","\)/);
  });

  test("sets it unconditionally, not behind a caller flag", () => {
    // A poll that only sometimes asks for the text fields would leave the
    // snapshot's rows inconsistent depending on which tick fetched them.
    const fn = SOURCE.slice(SOURCE.indexOf("export async function listWorkOrders"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    const line = body.split("\n").find((l) => l.includes('q.set("columns"'));
    expect(line).toBeDefined();
    expect(line!.trimStart().startsWith("q.set(")).toBe(true);
  });
});

describe("the fields the detail screen depends on", () => {
  const schema = SOURCE.slice(SOURCE.indexOf("export const WorkOrderSchema"));

  test("notes and completion_notes are declared", () => {
    // `notes` backs the work order's description, `completion_notes` the
    // technician notes — see app/work-order/[id].tsx.
    expect(schema).toMatch(/\bnotes:\s*z\.string\(\)/);
    expect(schema).toMatch(/\bcompletion_notes:\s*z\.string\(\)/);
  });

  test("they default to empty, which is why the gap was invisible", () => {
    // Pinning the reason this needs a test at all: the defaults mean a missing
    // column can never surface as a parse error.
    expect(schema).toMatch(/\bnotes:\s*z\.string\(\)\.default\(""\)/);
    expect(schema).toMatch(/\bcompletion_notes:\s*z\.string\(\)\.default\(""\)/);
  });
});
