import fs from 'node:fs';
import path from 'node:path';

const scriptPath = path.join(
  process.cwd(),
  'node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh'
);

function patchFile(filePath, replacers) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  let source = fs.readFileSync(filePath, 'utf8');
  const original = source;

  for (const [needle, replacement, warning] of replacers) {
    if (source.includes(replacement)) {
      continue;
    }

    if (!source.includes(needle)) {
      if (warning) {
        console.warn(warning);
      }
      continue;
    }

    source = source.replace(needle, replacement);
  }

  if (source !== original) {
    fs.writeFileSync(filePath, source);
  }
}

function patchExpoConstantsPathQuoting() {
  const scriptPath = path.join(process.cwd(), 'node_modules/expo-constants/scripts/get-app-config-ios.sh');
  const podspecPath = path.join(process.cwd(), 'node_modules/expo-constants/ios/EXConstants.podspec');
  const podspecJsonPath = path.join(process.cwd(), 'ios/Pods/Local Podspecs/EXConstants.podspec.json');
  const podsProjectPath = path.join(process.cwd(), 'ios/Pods/Pods.xcodeproj/project.pbxproj');

  patchFile(scriptPath, [
    [
      'PROJECT_DIR_BASENAME=$(basename $PROJECT_DIR)',
      'PROJECT_DIR_BASENAME=$(basename "$PROJECT_DIR")',
      '[patch-expo-modules-jsi-xattr] Expected EXConstants iOS app config basename line not found.',
    ],
    [
      `if [ "$BUNDLE_FORMAT" == "shallow" ]; then
  RESOURCE_DEST="$DEST/$RESOURCE_BUNDLE_NAME"`,
      `if [ "$BUNDLE_FORMAT" == "shallow" ]; then
  RESOURCE_DEST="$DEST/$RESOURCE_BUNDLE_NAME"
  mkdir -p "$RESOURCE_DEST"`,
      '[patch-expo-modules-jsi-xattr] Expected EXConstants shallow bundle branch not found.',
    ],
  ]);

  patchFile(podspecPath, [
    [
      `:script => "bash -l -c \\"#{env_vars}$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\\""`,
      `:script => "bash -l -c \\"#{env_vars}\\\\\\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\\\\\\"\\""`,
      '[patch-expo-modules-jsi-xattr] Expected EXConstants podspec script phase not found.',
    ],
  ]);

  patchFile(podspecJsonPath, [
    [
      `"script": "bash -l -c \\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\\""`,
      `"script": "bash -l -c \\"\\\\\\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\\\\\\"\\""`,
      '[patch-expo-modules-jsi-xattr] Expected EXConstants local podspec script phase not found.',
    ],
  ]);

  patchFile(podsProjectPath, [
    [
      `shellScript = "bash -l -c \\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\\"";`,
      `shellScript = "bash -l -c \\"\\\\\\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\\\\\\"\\"";`,
      '[patch-expo-modules-jsi-xattr] Expected EXConstants Pods project script phase not found.',
    ],
  ]);
}

function patchReactNativeBundlePathQuoting() {
  const xcodeProjectPath = path.join(process.cwd(), 'ios/EmberlyResident.xcodeproj/project.pbxproj');
  const command = `require('path').dirname(require.resolve('react-native/package.json')) + '/scripts/react-native-xcode.sh'`;
  const rnNeedle = '`' + String.raw`\"$NODE_BINARY\" --print \"${command}\"` + '`';
  const malformedReplacement =
    String.raw`REACT_NATIVE_XCODE_SCRIPT="$(\"$NODE_BINARY\" --print \"${command}\")"\n\"$REACT_NATIVE_XCODE_SCRIPT\"`;
  const rnReplacement =
    String.raw`REACT_NATIVE_XCODE_SCRIPT=\"$(\"$NODE_BINARY\" --print \"${command}\")\"\n\"$REACT_NATIVE_XCODE_SCRIPT\"`;

  patchFile(xcodeProjectPath, [
    [
      malformedReplacement,
      rnReplacement,
      null,
    ],
    [
      rnNeedle,
      rnReplacement,
      '[patch-expo-modules-jsi-xattr] Expected React Native bundle script phase not found.',
    ],
  ]);
}

function patchWhatwgUrlMinimumTextEncoding() {
  const packageRoot = path.join(process.cwd(), 'node_modules/whatwg-url-minimum/dist');
  const files = [
    path.join(packageRoot, 'whatwg-url-minimum.js'),
    path.join(packageRoot, 'whatwg-url-minimum.mjs'),
  ];
  const needle = `const e = new TextEncoder;

const t = new TextDecoder("utf-8", {
  ignoreBOM: !0
});`;
  const replacement = `const TextEncoding = typeof require === "function" ? require("text-encoding") : {};
const TextEncoderBuiltin = globalThis.TextEncoder || TextEncoding.TextEncoder;
const TextDecoderBuiltin = globalThis.TextDecoder || TextEncoding.TextDecoder;
const e = new TextEncoderBuiltin;

const t = new TextDecoderBuiltin("utf-8", {
  ignoreBOM: !0
});`;

  for (const filePath of files) {
    patchFile(filePath, [
      [
        needle,
        replacement,
        `[patch-expo-modules-jsi-xattr] Expected whatwg-url-minimum TextEncoder block not found in ${filePath}.`,
      ],
    ]);
  }
}

patchExpoConstantsPathQuoting();
patchReactNativeBundlePathQuoting();
patchWhatwgUrlMinimumTextEncoding();

function patchExpoModulesJsiPodsRoot() {
  const packageSwiftPath = path.join(process.cwd(), 'node_modules/expo-modules-jsi/apple/Package.swift');
  const helpersPath = path.join(process.cwd(), 'node_modules/expo-modules-jsi/apple/scripts/xcframework-helpers.sh');

  patchFile(packageSwiftPath, [
    [
      `return "\\(repoRoot)/apps/bare-expo/ios/Pods"`,
      `return "\\(repoRoot)/ios/Pods"`,
      '[patch-expo-modules-jsi-xattr] Expected Package.swift Pods fallback not found.',
    ],
  ]);

  patchFile(helpersPath, [
    [
      `PODS_ROOT="\${EXPO_ROOT_DIR}/apps/bare-expo/ios/Pods"`,
      `PODS_ROOT="\${EXPO_ROOT_DIR}/ios/Pods"`,
      '[patch-expo-modules-jsi-xattr] Expected xcframework helper Pods fallback not found.',
    ],
  ]);
}

function patchExpoModulesJsiBuildScript() {
  if (!fs.existsSync(scriptPath)) {
    return;
  }

  const stripMarker = 'Emberly: strip extended attributes before codesigning';
  const nestedMarker = 'Emberly: inherit parent environment for nested xcodebuild';
  const codeSignMarker = 'CODE_SIGNING_ALLOWED=NO';
  let source = fs.readFileSync(scriptPath, 'utf8');

  source = source.replaceAll(
    `PODS_ROOT="\${EXPO_ROOT_DIR}/apps/bare-expo/ios/Pods"`,
    `PODS_ROOT="\${EXPO_ROOT_DIR}/ios/Pods"`
  );

  if (!source.includes('Using existing SwiftPM product for ${platform}')) {
    const productNeedle = `  log "Building framework slice for \${platform}..."

  rm -rf "$BUILD_PRODUCTS_PATH"`;
    const productReplacement = `  log "Building framework slice for \${platform}..."

  local product_path="\${BUILD_PRODUCTS_PATH}/\${build_dir_name}"
  local framework_src="\${product_path}/PackageFrameworks/\${PACKAGE_NAME}.framework"
  local swiftmodule_src="\${product_path}/\${PACKAGE_NAME}.swiftmodule"

  if [[ -d "$framework_src" && -d "$swiftmodule_src" ]]; then
    log "Using existing SwiftPM product for \${platform}"
  else
    rm -rf "$BUILD_PRODUCTS_PATH"`;

    if (!source.includes(productNeedle)) {
      console.warn('[patch-expo-modules-jsi-xattr] Expected ExpoModulesJSI product cache insertion point not found.');
    } else {
      source = source.replace(productNeedle, productReplacement);
    }
  }

  if (!source.includes(nestedMarker)) {
    const nestedNeedles = [
      `    local env_args=(PATH="$PATH" HOME="$HOME" PODS_ROOT="$PODS_ROOT" RN_ROOT="$RN_ROOT")
    [[ -n "\${DEVELOPER_DIR:-}" ]] && env_args+=(DEVELOPER_DIR="$DEVELOPER_DIR")

    (cd "$PACKAGE_DIR" && env -i "\${env_args[@]}" \\
      xcodebuild \\`,
      `    local env_args=(PATH="$PATH" HOME="$HOME" PODS_ROOT="$PODS_ROOT" RN_ROOT="$RN_ROOT" COPYFILE_DISABLE=1)
    [[ -n "\${DEVELOPER_DIR:-}" ]] && env_args+=(DEVELOPER_DIR="$DEVELOPER_DIR")

    (cd "$PACKAGE_DIR" && env "\${env_args[@]}" \\
      xcodebuild \\`,
    ];
    const nestedReplacement = `    # ${nestedMarker}.
    # SwiftPM package detection fails under this local Xcode build when CocoaPods
    # path variables are forwarded. Package.swift now resolves this app's Pods
    # path by default, so keep those variables out of the nested xcodebuild.
    local developer_dir="\${DEVELOPER_DIR:-$(xcode-select -p)}"
    local xcodebuild_tool="\${developer_dir}/usr/bin/xcodebuild"
    (cd "$PACKAGE_DIR" && unset PODS_ROOT RN_ROOT REACT_NATIVE_PATH EXPO_ROOT_DIR && \\
      "$xcodebuild_tool" \\`;
    const nestedNeedle = nestedNeedles.find((needle) => source.includes(needle));

    if (!nestedNeedle) {
      console.warn('[patch-expo-modules-jsi-xattr] Expected nested xcodebuild insertion point not found.');
    } else {
      source = source.replace(nestedNeedle, nestedReplacement);
    }
  }

  if (!source.includes(codeSignMarker)) {
    const signingNeedles = [
      `    SWIFT_COMPILATION_MODE=wholemodule \\
    )`,
      `    SWIFT_COMPILATION_MODE=wholemodule \\
  )`,
    ];
    const signingNeedle = signingNeedles.find((needle) => source.includes(needle));
    const signingReplacement = signingNeedle === signingNeedles[1]
      ? `    SWIFT_COMPILATION_MODE=wholemodule \\
    ${codeSignMarker} \\
    CODE_SIGNING_REQUIRED=NO \\
    CODE_SIGN_IDENTITY= \\
  )`
      : `    SWIFT_COMPILATION_MODE=wholemodule \\
      ${codeSignMarker} \\
      CODE_SIGNING_REQUIRED=NO \\
      CODE_SIGN_IDENTITY= \\
    )`;

    if (!signingNeedle) {
      console.warn('[patch-expo-modules-jsi-xattr] Expected code signing insertion point not found.');
    } else {
      source = source.replace(signingNeedle, signingReplacement);
    }
  }

  if (
    source.includes('Using existing SwiftPM product for ${platform}') &&
    !source.includes(`  fi

  # GeneratedModuleMaps`)
  ) {
    const closeNeedles = [
      `    )

  # GeneratedModuleMaps`,
      `  )

  # GeneratedModuleMaps`,
    ];
    const closeNeedle = closeNeedles.find((needle) => source.includes(needle));

    if (!closeNeedle) {
      console.warn('[patch-expo-modules-jsi-xattr] Expected ExpoModulesJSI product cache close insertion point not found.');
    } else {
      source = source.replace(
        closeNeedle,
        closeNeedle.replace(
          `

  # GeneratedModuleMaps`,
          `
  fi

  # GeneratedModuleMaps`
        )
      );
    }
  }

  if (!source.includes(stripMarker)) {
    const needle = `  echo "$current_hash" > "\${staging_dir}/.build-hash"

  rm -rf "$slice_dir"`;

    const replacement = `  echo "$current_hash" > "\${staging_dir}/.build-hash"

  # ${stripMarker}
  # Xcode can attach com.apple.provenance/resource-fork metadata to SPM-built
  # frameworks on macOS. Codesign rejects that metadata inside app bundles.
  if command -v xattr >/dev/null 2>&1; then
    xattr -cr "$staging_dir" || true
  fi

  rm -rf "$slice_dir"`;

    if (!source.includes(needle)) {
      console.warn('[patch-expo-modules-jsi-xattr] Expected staging insertion point not found.');
    } else {
      source = source.replace(needle, replacement);
    }
  }

  if (!source.includes('xattr -cr "$slice_dir"')) {
    const moveNeedle = `  rm -rf "$slice_dir"
  mv "$staging_dir" "$slice_dir"
}`;
    const moveReplacement = `  rm -rf "$slice_dir"
  mv "$staging_dir" "$slice_dir"

  if command -v xattr >/dev/null 2>&1; then
    xattr -cr "$slice_dir" || true
  fi
}`;

    if (!source.includes(moveNeedle)) {
      console.warn('[patch-expo-modules-jsi-xattr] Expected move insertion point not found.');
    } else {
      source = source.replace(moveNeedle, moveReplacement);
    }
  }

  if (!source.includes('xattr -cr "$XCFRAMEWORK_PATH"')) {
    const plistNeedle = `write_xcframework_plist "$XCFRAMEWORK_PATH" "$PACKAGE_NAME"

SLICE_NAMES=`;
    const plistReplacement = `write_xcframework_plist "$XCFRAMEWORK_PATH" "$PACKAGE_NAME"

if command -v xattr >/dev/null 2>&1; then
  xattr -cr "$XCFRAMEWORK_PATH" || true
fi

SLICE_NAMES=`;

    if (!source.includes(plistNeedle)) {
      console.warn('[patch-expo-modules-jsi-xattr] Expected plist insertion point not found.');
    } else {
      source = source.replace(plistNeedle, plistReplacement);
    }
  }

  fs.writeFileSync(scriptPath, source);
}

patchExpoModulesJsiPodsRoot();
patchExpoModulesJsiBuildScript();
