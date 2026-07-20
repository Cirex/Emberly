declare const require: {
  (moduleName: 'text-encoding'): typeof import('text-encoding');
};

const { TextDecoder, TextEncoder } = require('text-encoding');

const globalScope = globalThis as typeof globalThis & {
  TextDecoder?: typeof TextDecoder;
  TextEncoder?: typeof TextEncoder;
};

if (!globalScope.TextEncoder) {
  globalScope.TextEncoder = TextEncoder;
}

if (!globalScope.TextDecoder) {
  globalScope.TextDecoder = TextDecoder;
}
