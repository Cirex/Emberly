import { expect, test } from "bun:test";
import { emergencyWorkOrderIdFrom } from "../lib/push-routing";

test("reads the work-order id from an emergency push payload", () => {
  expect(emergencyWorkOrderIdFrom({ workOrderId: "wo-123", unitNumber: "14B" })).toBe("wo-123");
});

test("tolerates a numeric id by normalizing it to a string", () => {
  expect(emergencyWorkOrderIdFrom({ workOrderId: 42 })).toBe("42");
});

test("rejects payloads that are not emergency pushes", () => {
  expect(emergencyWorkOrderIdFrom(undefined)).toBeNull();
  expect(emergencyWorkOrderIdFrom(null)).toBeNull();
  expect(emergencyWorkOrderIdFrom("wo-123")).toBeNull();
  expect(emergencyWorkOrderIdFrom({})).toBeNull();
  expect(emergencyWorkOrderIdFrom({ workOrderId: "" })).toBeNull();
  expect(emergencyWorkOrderIdFrom({ unitNumber: "14B" })).toBeNull();
});
