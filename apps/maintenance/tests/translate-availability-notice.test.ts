import { describe, expect, test } from "bun:test";

import {
  shouldCheckTranslation,
  translateNotice,
} from "@/lib/translation/availability-notice";

const input = (over: Partial<Parameters<typeof translateNotice>[0]> = {}) => ({
  availability: "installed" as const,
  moduleLinked: true,
  platform: "ios",
  ...over,
});

describe("shouldCheckTranslation", () => {
  test("checks when switching to Spanish on iOS", () => {
    expect(shouldCheckTranslation("es", "ios")).toBe(true);
  });

  test("stays quiet in English — ResMan prose is already English", () => {
    expect(shouldCheckTranslation("en", "ios")).toBe(false);
  });

  test("stays quiet on Android, where Apple Translation has no twin", () => {
    expect(shouldCheckTranslation("es", "android")).toBe(false);
  });
});

describe("translateNotice", () => {
  test("is null once the pack is installed — the silent case is the good one", () => {
    expect(translateNotice(input())).toBeNull();
  });

  test("explains the one-time download for a supported-but-absent pack", () => {
    // The bug this whole module exists for: `supported` used to fail the batch,
    // get swallowed, and leave English on screen with no explanation.
    const notice = translateNotice(input({ availability: "supported" }));
    expect(notice?.title).toBe("Downloading the language pack");
    expect(notice?.body).toContain("once");
  });

  test("distinguishes an old binary from a device that can't translate", () => {
    const oldBuild = translateNotice(input({ availability: "unsupported", moduleLinked: false }));
    const noPair = translateNotice(input({ availability: "unsupported", moduleLinked: true }));

    expect(oldBuild?.title).toBe("This build predates translation");
    expect(oldBuild?.body).toContain("Reinstall");

    expect(noPair?.title).toBe("Translation isn't available here");
    expect(oldBuild?.body).not.toBe(noPair?.body);
  });

  test("a downloadable pack reads as downloading even on an old binary", () => {
    // availability is the OS's answer and outranks our guess about the build.
    const notice = translateNotice(input({ availability: "supported", moduleLinked: false }));
    expect(notice?.title).toBe("Downloading the language pack");
  });
});
