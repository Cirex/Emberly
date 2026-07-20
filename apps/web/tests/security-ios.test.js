
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const nodeTest = require("node:test");

const iosRoot = path.join(process.cwd(), "..", "emberly-security-ios", "EmberlySecurity");

// The native iOS repo is intentionally NOT part of this monorepo, so these
// source-content assertions can only run where it's checked out as a sibling.
// Skip (don't fail) when it's absent.
const test = fs.existsSync(iosRoot) ? nodeTest : nodeTest.skip;

// The scanner feature is being renamed from Features/FastPass to
// Features/Scanner (with FastPass* types becoming Scanner*). Resolve whichever
// candidate exists and assert on rename-stable content.
const scannerFeatureDirCandidates = [
  path.join(iosRoot, "Features", "Scanner"),
  path.join(iosRoot, "Features", "FastPass"),
];

function readScannerFeatureSource() {
  const featureDir = scannerFeatureDirCandidates.find((dir) => fs.existsSync(dir));
  assert.ok(
    featureDir,
    `Expected one of ${scannerFeatureDirCandidates.join(", ")} to exist`
  );

  // Scanner infrastructure (photo upload service, verification/endpoint
  // configuration) lives under Core/ since the feature was split into
  // focused files.
  const coreConfigDir = path.join(iosRoot, "Core", "Configuration");
  const sourceDirs = [
    { dir: featureDir, filter: () => true },
    { dir: path.join(iosRoot, "Core", "Services", "Scanner"), filter: () => true },
    { dir: coreConfigDir, filter: (file) => file.startsWith("Scanner") },
  ].filter(({ dir }) => fs.existsSync(dir));

  const swiftFiles = sourceDirs.flatMap(({ dir, filter }) =>
    fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".swift") && filter(file))
      .sort()
      .map((file) => path.join(dir, file))
  );
  assert.ok(swiftFiles.length > 0, `Expected Swift sources in ${sourceDirs.join(", ")}`);

  return swiftFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

function readCoreConfigurationSource(fileName) {
  return fs.readFileSync(path.join(iosRoot, "Core", "Configuration", fileName), "utf8");
}

test("security app resolves its API endpoints through the shared endpoint configuration", () => {
  const endpointConfiguration = readCoreConfigurationSource("EndpointConfiguration.swift");
  const source = readScannerFeatureSource();

  assert.match(endpointConfiguration, /static var defaultAPIBaseURL: String/);
  assert.match(endpointConfiguration, /static func resolve\(/);
  assert.match(source, /EndpointConfiguration\.resolve\(/);
  assert.match(source, /infoKey: "EmberlyScannerAPIBaseURL"/);
  assert.match(source, /api\/verify-pass/);
});

test("security app treats network failures as unable to verify instead of access denied", () => {
  const source = readScannerFeatureSource();

  assert.match(source, /case unableToVerify\(String\)/);
  assert.match(source, /catch let error as URLError/);
  assert.match(source, /\.unableToVerify\("Cannot reach Emberly Web/);
  assert.match(source, /private func unableToVerifyLayer\(message: String\)/);
  assert.match(source, /(FastPass|Scanner)VerificationGlassCard/);
  assert.match(source, /secondaryActionTitle: "Scanner Settings"/);
  assert.match(source, /"wifi\.exclamationmark"/);
});

test("security app gives scanner setup and revoked guest passes specific displays", () => {
  const contract = readCoreConfigurationSource("Contract.swift");
  const source = readScannerFeatureSource();

  assert.match(contract, /case scannerAuthRequired = "scanner_auth_required"/);
  assert.match(contract, /case scannerDisabled = "scanner_disabled"/);
  assert.match(contract, /case guestPassRevoked = "guest_pass_revoked"/);

  assert.match(source, /code == \.scannerAuthRequired \|\| code == \.scannerDisabled/);
  assert.match(source, /case \.guestPassRevoked:\s*"Pass Revoked"/);
  assert.match(source, /case \.scannerAuthRequired:\s*"Scanner Setup Required"/);
  assert.match(source, /case \.scannerDisabled:\s*"Scanner Disabled"/);
  assert.match(source, /Scanner ID must match an enabled scanner in the admin portal/);
});

test("security app uploads scan photos after a granted pass", () => {
  const source = readScannerFeatureSource();

  assert.match(source, /let entryLogId: String\?/);
  assert.match(source, /case uploadPhoto/);
  assert.match(source, /Add Photo/);
  assert.match(source, /UIImagePickerController/);
  assert.match(source, /jpegData\(compressionQuality: 0\.82\)/);
  assert.match(source, /api\/entry-logs\/\\\(entryLogId\)\/photos/);
  assert.match(source, /URLQueryItem\(name: "scannerId", value: scannerId\)/);
  assert.match(source, /multipart\/form-data; boundary=/);
  assert.match(source, /savedPhotoCount \+= 1/);
  assert.match(source, /photoUploadState = \.saved/);
});

test("security app confirms scan photos and queues failed uploads", () => {
  const source = readScannerFeatureSource();

  assert.match(source, /struct (FastPass|Scanner)PendingPhotoUpload: Codable, Identifiable/);
  assert.match(source, /final class (FastPass|Scanner)PendingPhotoUploadStore/);
  assert.match(source, /loadPendingUploads/);
  assert.match(source, /savePendingUpload/);
  assert.match(source, /retryPendingUploads/);
  assert.match(source, /Confirm Photo/);
  assert.match(source, /Retake/);
  assert.match(source, /Use Photo/);
  assert.match(source, /Image\(uiImage: pendingCapturedPhoto\)/);
  assert.match(source, /photoUploadState = \.queued/);
  assert.match(source, /savedPhotoCount/);
  assert.ok(source.includes('return "\\(max(queuedPhotoCount, 1)) queued"'));
  assert.match(source, /return "Needs retry"/);
});
