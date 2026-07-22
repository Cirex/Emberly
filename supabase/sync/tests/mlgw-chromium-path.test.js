const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DARWIN_CHROMIUM_CANDIDATES,
  LINUX_CHROMIUM_CANDIDATES,
  chromiumCandidates,
  chromiumPathDiagnostic,
  resolveChromiumExecutablePath,
} = require("../src/mlgw/capture/chromium-path.ts");

/** An existsSync stand-in over an explicit set of present paths. */
function fs(...present) {
  const set = new Set(present);
  return (path) => set.has(path);
}

test("CHROMIUM_PATH wins when it points at a real executable", () => {
  const resolved = resolveChromiumExecutablePath({
    env: { CHROMIUM_PATH: "/opt/chrome/headless" },
    platform: "linux",
    exists: fs("/opt/chrome/headless", "/usr/bin/chromium"),
  });
  assert.equal(resolved, "/opt/chrome/headless");
});

test("a stale CHROMIUM_PATH falls back to a real system browser and says so", () => {
  const options = {
    env: { CHROMIUM_PATH: "/nope/chromium" },
    platform: "linux",
    exists: fs("/usr/bin/chromium"),
  };
  assert.equal(resolveChromiumExecutablePath(options), "/usr/bin/chromium");
  assert.match(chromiumPathDiagnostic(options), /CHROMIUM_PATH=\/nope\/chromium does not exist/);
});

test("the container path (alpine `chromium` package) resolves with no configuration", () => {
  const resolved = resolveChromiumExecutablePath({
    env: {},
    platform: "linux",
    exists: fs("/usr/bin/chromium-browser"),
  });
  assert.equal(resolved, "/usr/bin/chromium-browser");
});

test("candidates are tried in preference order", () => {
  const resolved = resolveChromiumExecutablePath({
    env: {},
    platform: "linux",
    exists: fs("/usr/bin/google-chrome", "/usr/bin/chromium"),
  });
  assert.equal(resolved, "/usr/bin/chromium", "chromium is preferred over google-chrome");
});

test("a developer laptop resolves the common macOS locations", () => {
  for (const candidate of DARWIN_CHROMIUM_CANDIDATES) {
    assert.equal(
      resolveChromiumExecutablePath({ env: {}, platform: "darwin", exists: fs(candidate) }),
      candidate,
    );
  }
  assert.deepEqual(chromiumCandidates("darwin"), DARWIN_CHROMIUM_CANDIDATES);
  assert.deepEqual(chromiumCandidates("linux"), LINUX_CHROMIUM_CANDIDATES);
});

test("macOS candidates are not offered on linux (and vice versa)", () => {
  const macOnly = fs("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(resolveChromiumExecutablePath({ env: {}, platform: "linux", exists: macOnly }), null);
  const linuxOnly = fs("/usr/bin/chromium");
  assert.equal(resolveChromiumExecutablePath({ env: {}, platform: "darwin", exists: linuxOnly }), null);
});

test("no browser anywhere resolves to null with an actionable diagnostic", () => {
  const options = { env: {}, platform: "linux", exists: () => false };
  assert.equal(resolveChromiumExecutablePath(options), null);
  assert.match(chromiumPathDiagnostic(options), /no Chromium found \(set CHROMIUM_PATH/);
});

test("an empty CHROMIUM_PATH is ignored rather than treated as a path", () => {
  const resolved = resolveChromiumExecutablePath({
    env: { CHROMIUM_PATH: "   " },
    platform: "linux",
    exists: fs("/usr/bin/chromium"),
  });
  assert.equal(resolved, "/usr/bin/chromium");
});
