import { describe, expect, test } from "bun:test";

import {
  canDictate,
  dictationNotice,
  shouldOfferDictation,
} from "@/lib/dictation/availability-notice";

const input = (over: Partial<Parameters<typeof dictationNotice>[0]> = {}) => ({
  availability: "ready" as const,
  moduleLinked: true,
  platform: "ios",
  ...over,
});

describe("shouldOfferDictation", () => {
  test("offers the mic on iOS", () => {
    expect(shouldOfferDictation(input())).toBe(true);
    // Even when it can't run — the point is that it explains itself.
    expect(shouldOfferDictation(input({ availability: "unsupported" }))).toBe(true);
  });

  test("hides it on Android, where Apple Speech has no twin", () => {
    expect(shouldOfferDictation(input({ platform: "android" }))).toBe(false);
  });
});

describe("canDictate", () => {
  test("ready and needsPermission both start a session", () => {
    // needsPermission is usable: the session prompts, then proceeds.
    expect(canDictate("ready")).toBe(true);
    expect(canDictate("needsPermission")).toBe(true);
  });

  test("denied and unsupported do not", () => {
    expect(canDictate("denied")).toBe(false);
    expect(canDictate("unsupported")).toBe(false);
  });
});

describe("dictationNotice", () => {
  test("is null when dictation can actually run", () => {
    expect(dictationNotice(input())).toBeNull();
    expect(dictationNotice(input({ availability: "needsPermission" }))).toBeNull();
  });

  test("points a denied device at Settings", () => {
    const notice = dictationNotice(input({ availability: "denied" }));
    expect(notice?.body).toContain("Settings");
  });

  test("distinguishes an old binary from a device that said no", () => {
    // This is the whole reason the module exists: these two used to be
    // indistinguishable, because the mic simply vanished for both.
    const oldBuild = dictationNotice(input({ availability: "unsupported", moduleLinked: false }));
    const noModel = dictationNotice(input({ availability: "unsupported", moduleLinked: true }));

    expect(oldBuild?.title).toBe("This build predates dictation");
    expect(oldBuild?.body).toContain("Reinstall");

    expect(noModel?.title).toBe("Dictation isn't available here");
    expect(noModel?.body).toContain("Keyboard");

    expect(oldBuild?.body).not.toBe(noModel?.body);
  });

  test("a denied device reads as denied even on an old binary", () => {
    // denied is decided before the module check — an explicit refusal is
    // better information than a guess about the build.
    const notice = dictationNotice(input({ availability: "denied", moduleLinked: false }));
    expect(notice?.title).toBe("Dictation is turned off");
  });
});
