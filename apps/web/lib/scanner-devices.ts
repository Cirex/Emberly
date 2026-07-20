/**
 * Minimal structural client type for the scanner_devices registry — the sole
 * source of scanner keys. Used by the scanner-auth heartbeat.
 *
 * (`isRegisteredScannerEnabled` was removed with the env-key paths: scanner auth
 * now always loads and verifies the registry row, so there is nothing left to
 * re-check separately.)
 */
export type ScannerRegistryClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{
          data: { scanner_id: string; enabled: boolean } | null;
          error: unknown;
        }>;
      };
    };
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: string) => PromiseLike<unknown>;
    };
  };
};
