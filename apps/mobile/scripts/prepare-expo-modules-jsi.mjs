import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const appRoot = process.cwd();
const packageDir = path.join(appRoot, 'node_modules/expo-modules-jsi/apple');
const buildScriptDir = path.join(packageDir, 'scripts');
const derivedDataPath = path.join(packageDir, '.DerivedData');
const xcodebuild = '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild';

if (!fs.existsSync(packageDir)) {
  console.log('[prepare-expo-modules-jsi] expo-modules-jsi is not installed; skipping.');
  process.exit(0);
}

if (!fs.existsSync(path.join(appRoot, 'ios/Pods'))) {
  console.error('[prepare-expo-modules-jsi] ios/Pods is missing. Run `npx pod-install ios` first.');
  process.exit(1);
}

function run(label, command, args, cwd) {
  console.log(`[prepare-expo-modules-jsi] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    console.error(`[prepare-expo-modules-jsi] ${label} failed: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function buildSwiftPackage(platform, destination) {
  run(
    `Building ${platform} SwiftPM product`,
    xcodebuild,
    [
      'build',
      '-scheme',
      'ExpoModulesJSI',
      '-sdk',
      platform,
      '-destination',
      `generic/platform=${destination}`,
      '-derivedDataPath',
      derivedDataPath,
      '-configuration',
      'Release',
      '-quiet',
      '-disableAutomaticPackageResolution',
      '-skipPackagePluginValidation',
      '-skipMacroValidation',
      '-parallelizeTargets',
      'BUILD_LIBRARY_FOR_DISTRIBUTION=YES',
      'SKIP_INSTALL=NO',
      'DEBUG_INFORMATION_FORMAT=dwarf-with-dsym',
      'COMPILER_INDEX_STORE_ENABLE=NO',
      'SWIFT_COMPILATION_MODE=wholemodule',
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGNING_REQUIRED=NO',
      'CODE_SIGN_IDENTITY=',
    ],
    packageDir
  );
}

buildSwiftPackage('iphoneos', 'iOS');
buildSwiftPackage('iphonesimulator', 'iOS Simulator');
run('Building ExpoModulesJSI xcframework', './build-xcframework.sh', [], buildScriptDir);
