const AUTHENTICATION_TYPE_FINGERPRINT = 1;
const AUTHENTICATION_TYPE_FACE = 2;
const AUTHENTICATION_TYPE_IRIS = 3;

export interface LocalUnlockAvailabilityInput {
  hasHardware: boolean;
  isEnrolled: boolean;
  authenticationTypes: number[];
}

export interface LocalUnlockAvailability {
  available: boolean;
  label: string;
  unavailableReason: string | null;
}

export function getLocalUnlockLabel(authenticationTypes: number[]): string {
  if (authenticationTypes.includes(AUTHENTICATION_TYPE_FACE)) return 'Face ID';
  if (authenticationTypes.includes(AUTHENTICATION_TYPE_FINGERPRINT)) return 'Touch ID';
  if (authenticationTypes.includes(AUTHENTICATION_TYPE_IRIS)) return 'Biometric unlock';
  return 'Device unlock';
}

export function getLocalUnlockAvailability({
  hasHardware,
  isEnrolled,
  authenticationTypes,
}: LocalUnlockAvailabilityInput): LocalUnlockAvailability {
  const label = getLocalUnlockLabel(authenticationTypes);

  if (!hasHardware) {
    return {
      available: false,
      label,
      unavailableReason: 'Face ID is not available on this device.',
    };
  }

  if (!isEnrolled) {
    return {
      available: false,
      label,
      unavailableReason: 'Set up Face ID in iOS Settings to enable app unlock.',
    };
  }

  return {
    available: true,
    label,
    unavailableReason: null,
  };
}

export function shouldLockAppForLocalUnlock(localUnlockEnabled: boolean, hasActiveSession: boolean): boolean {
  return localUnlockEnabled && hasActiveSession;
}

export function localUnlockErrorMessage(error: string): string {
  switch (error) {
    case 'not_enrolled':
      return 'Set up Face ID in iOS Settings before enabling app unlock.';
    case 'not_available':
      return 'Face ID is not available on this device.';
    case 'lockout':
      return 'Face ID is temporarily locked. Use your device passcode and try again.';
    case 'passcode_not_set':
      return 'Set a device passcode before enabling app unlock.';
    case 'authentication_failed':
      return 'Face ID did not match. Please try again.';
    default:
      return 'Unable to verify Face ID right now. Please try again.';
  }
}
