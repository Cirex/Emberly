const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const DOCKERFILE = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
const CMD_LINE = DOCKERFILE.split("\n").filter((l) => l.startsWith("CMD ")).at(-1) ?? "";

test("the image CMD does not run a sync pass on start", () => {
  // This was `CMD ["bun", "run", "sync:all:once"]`, which cannot work as a
  // Coolify Application: it runs one full pass and EXITS, an Application that
  // exits reads as a crash, and Coolify restarts it — on success exactly as on
  // failure — until it hits the 10/10 restart limit. With a missing env var it
  // burned all ten restarts in seconds; with a correct environment it would
  // instead have looped full ResMan scrapes back to back.
  //
  // Work is driven by scheduled tasks that `exec` into an idle container, so
  // the CMD must keep the container alive and do nothing else.
  assert.doesNotMatch(
    CMD_LINE,
    /sync:all|run-[a-z-]+\.ts/,
    `the CMD must not start a sync pass — found: ${CMD_LINE}`,
  );
});

test("the image CMD keeps the container alive for scheduled tasks", () => {
  // Scheduled tasks docker-exec into a RUNNING container. A CMD that exits
  // leaves nothing to exec into, and the task fails with a container-not-found
  // error that looks nothing like the real cause.
  assert.match(
    CMD_LINE,
    /sleep|tail -f/,
    `the CMD must keep the container running — found: ${CMD_LINE}`,
  );
});
