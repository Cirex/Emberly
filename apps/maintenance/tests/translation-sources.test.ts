import { describe, expect, test } from "bun:test";

import {
  orderedTranslationSources,
  type TranslatableWorkOrder,
} from "@/lib/translation/sources";

const wo = (id: string, over: Partial<TranslatableWorkOrder> = {}): TranslatableWorkOrder => ({
  resman_work_order_id: id,
  title: `title ${id}`,
  notes: `notes ${id}`,
  ...over,
});

describe("orderedTranslationSources", () => {
  test("puts the visible work orders' prose first, in the order given", () => {
    const orders = [wo("a"), wo("b"), wo("c")];
    const out = orderedTranslationSources(orders, ["c", "a"]);
    expect(out.slice(0, 4)).toEqual(["title c", "notes c", "title a", "notes a"]);
    expect(out.slice(4)).toEqual(["title b", "notes b"]);
  });

  test("still emits every source — priority reorders, it never drops", () => {
    const orders = [wo("a"), wo("b"), wo("c")];
    const all = orderedTranslationSources(orders, []);
    const prioritized = orderedTranslationSources(orders, ["b"]);
    expect(prioritized.slice().sort()).toEqual(all.slice().sort());
  });

  test("skips priority ids whose work order is gone", () => {
    // A My Day stop can outlive the work order that created it; that is not an
    // error, it just has no prose to contribute.
    const out = orderedTranslationSources([wo("a")], ["ghost", "a"]);
    expect(out).toEqual(["title a", "notes a"]);
  });

  test("never repeats a work order listed twice in the priority set", () => {
    // Two stops can name the same work order; translating it twice would waste
    // a slot at the front of the queue, which is the scarce thing here.
    const out = orderedTranslationSources([wo("a"), wo("b")], ["a", "a"]);
    expect(out).toEqual(["title a", "notes a", "title b", "notes b"]);
  });

  test("includes completion notes and skips blank fields", () => {
    const orders = [wo("a", { notes: "", completion_notes: "done a" })];
    expect(orderedTranslationSources(orders, [])).toEqual(["title a", "done a"]);
  });

  test("with no priority ids, order follows the work orders themselves", () => {
    const orders = [wo("a"), wo("b")];
    expect(orderedTranslationSources(orders)).toEqual([
      "title a",
      "notes a",
      "title b",
      "notes b",
    ]);
  });
});
