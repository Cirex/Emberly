import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Image,
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { Colors } from '@/constants/colors';
import { GlassPanel, ResidentScreen } from '@/components/resident-glass';
import { useAuth } from '@/lib/auth';
import { ApiRequestError, getResidentEntryToken, verifySession } from '@/lib/api';
import { capture } from '@/lib/analytics';
import { callWithAccessRetry } from '@/lib/entryPassRefresh';
import { secondsUntilEntryTokenExpiry } from '@/lib/residentEntryToken';

const ENTRY_TOKEN_PERIOD = 60;
const ENTRY_REFRESH_MARGIN_SECONDS = 5;
const flowerLogo = require('../../assets/logo-flower-transparent.png');

interface EntryPassState {
  qrValue: string;
  expiresAt: string;
  secondsRemaining: number;
}

export default function MyPassScreen() {
  const { token, deviceSession, resmanSession, logout, resident, name } = useAuth();
  const [entryPass, setEntryPass] = useState<EntryPassState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshInFlight = useRef(false);
  const progressWidth = useSharedValue(1);

  const animateProgress = useCallback((seconds: number) => {
    // Reanimated shared values are intentionally mutated through `.value`.
    // eslint-disable-next-line react-hooks/immutability
    progressWidth.value = Math.min(1, seconds / ENTRY_TOKEN_PERIOD);
    // eslint-disable-next-line react-hooks/immutability
    progressWidth.value = withTiming(0, {
      duration: seconds * 1000,
      easing: Easing.linear,
    });
  }, [progressWidth]);

  const refreshEntryPass = useCallback(async () => {
    if (!token || !deviceSession || refreshInFlight.current) return;
    refreshInFlight.current = true;

    try {
      setError(null);
      const result = await callWithAccessRetry({
        call: () => getResidentEntryToken(token, deviceSession),
        verifyAccess: resmanSession ? () => verifySession(token, resmanSession) : null,
        logout: async () => {
          capture('session_expired', { via: 'access_retry' });
          await logout();
        },
        logoutMessage: 'Your ResMan session has expired. Please sign in again.',
      });
      const secondsRemaining = secondsUntilEntryTokenExpiry(result.expiresAt);
      setEntryPass({
        qrValue: result.qrData,
        expiresAt: result.expiresAt,
        secondsRemaining,
      });
      animateProgress(secondsRemaining);
    } catch (err: unknown) {
      // Failures only — the pass refreshes every ~60s, so success events
      // would be noise. A spike here is the gate-QR health signal.
      capture('entry_pass_refresh_failed', {
        reason: err instanceof ApiRequestError
          ? (err.status === 401 || err.status === 403 ? 'rejected' : 'server')
          : 'network',
      });
      const msg = err instanceof Error ? err.message : 'Failed to load pass.';
      setError(msg);
    } finally {
      refreshInFlight.current = false;
      setIsLoading(false);
    }
  }, [animateProgress, deviceSession, logout, resmanSession, token]);

  useEffect(() => {
    if (!token || !deviceSession) {
      const timeout = setTimeout(() => {
        setIsLoading(false);
        setError('Your pass is missing session information. Please sign out and sign in again.');
      }, 0);
      return () => clearTimeout(timeout);
    }

    const timeout = setTimeout(() => {
      void refreshEntryPass();
    }, 0);
    return () => clearTimeout(timeout);
  }, [deviceSession, refreshEntryPass, token]);

  const entryPassExpiresAt = entryPass?.expiresAt;
  useEffect(() => {
    if (!entryPassExpiresAt) return;

    intervalRef.current = setInterval(() => {
      // Compute the countdown outside the state updater so the updater stays pure.
      const remaining = secondsUntilEntryTokenExpiry(entryPassExpiresAt);
      if (remaining <= ENTRY_REFRESH_MARGIN_SECONDS) {
        void refreshEntryPass();
      }
      setEntryPass((prev) => (prev ? { ...prev, secondsRemaining: remaining } : prev));
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [entryPassExpiresAt, refreshEntryPass]);

  const progressStyle = useAnimatedStyle(() => ({
    width: `${progressWidth.value * 100}%`,
  }));

  const progressColor = entryPass && entryPass.secondsRemaining <= 5
    ? Colors.error
    : entryPass && entryPass.secondsRemaining <= 10
    ? Colors.warning
    : Colors.accent;
  const residentName = resident?.name ?? name ?? 'Resident';
  const unitNumber = resident?.unitNumber ?? '—';

  if (isLoading) {
    return (
      <ResidentScreen centered>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.loadingText}>Loading your pass...</Text>
      </ResidentScreen>
    );
  }

  if (error || !entryPass) {
    return (
      <ResidentScreen centered>
        <Text style={styles.errorText} selectable>{error ?? 'Unable to load pass.'}</Text>
      </ResidentScreen>
    );
  }

  return (
    <ResidentScreen variant="login" contentStyle={styles.screenContent}>
      <View style={styles.passHeroHeader}>
        <Image source={flowerLogo} style={styles.flowerMark} resizeMode="contain" />
        <Text style={styles.heroTitle}>My Pass</Text>
        <View style={styles.verifiedBadge}>
          <Ionicons name="checkmark-circle" size={18} color={Colors.accent} />
          <Text style={styles.verifiedText}>Verified</Text>
        </View>
      </View>

        <GlassPanel strong style={styles.entryPassPanel}>
          <View style={styles.identityRow}>
            <View style={styles.identityText}>
              <Text style={styles.residentName}>{residentName}</Text>
              <Text style={styles.unitNumber}>{unitNumber}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.qrContainer}>
            <QRCode
              value={entryPass.qrValue}
              size={248}
              color={Colors.primary}
              backgroundColor={Colors.white}
              ecl="H"
              logo={flowerLogo}
              logoSize={54}
              logoBackgroundColor={Colors.white}
              logoMargin={5}
              logoBorderRadius={8}
              quietZone={3}
            />
          </View>

          <View style={styles.refreshRow}>
            <View style={styles.refreshTextRow}>
              <Ionicons name="refresh-outline" size={21} color={Colors.accent} />
              <Text style={styles.progressLabel}>Refreshes in</Text>
              <Text style={[styles.progressSeconds, { color: progressColor }]}>
                {entryPass.secondsRemaining}s
              </Text>
            </View>
          </View>

          <View style={styles.progressSection}>
            <View style={styles.progressTrack}>
              <Animated.View
                style={[styles.progressBar, progressStyle, { backgroundColor: progressColor }]}
              />
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.howItWorks}>
            <View style={styles.howItWorksIcon}>
              <Ionicons name="information-circle-outline" size={25} color={Colors.accent} />
            </View>
            <View style={styles.howItWorksCopy}>
              <Text style={styles.howItWorksTitle}>How it works</Text>
              <Text style={styles.howItWorksText}>
                This pass refreshes automatically and cannot be shared. Present this QR code at the gate for entry onto the property.
              </Text>
            </View>
          </View>
        </GlassPanel>
    </ResidentScreen>
  );
}

const styles = StyleSheet.create({
  screenContent: {
    paddingHorizontal: 24,
    paddingTop: 34,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: Colors.primary,
  },
  errorText: {
    fontSize: 16,
    color: Colors.error,
    textAlign: 'center',
  },
  passHeroHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
  },
  flowerMark: {
    width: 58,
    height: 58,
    marginRight: 16,
  },
  heroTitle: {
    flex: 1,
    color: Colors.primary,
    fontSize: 34,
    fontWeight: '700',
  },
  entryPassPanel: {
    paddingHorizontal: 30,
    paddingTop: 36,
    paddingBottom: 32,
    marginBottom: 16,
    borderRadius: 48,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  identityText: {
    flex: 1,
  },
  residentName: {
    color: Colors.primary,
    fontSize: 26,
    fontWeight: '700',
  },
  unitNumber: {
    color: Colors.textSecondary,
    fontSize: 18,
    fontWeight: '600',
    marginTop: 3,
  },
  verifiedBadge: {
    borderRadius: 22,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: 'rgba(180, 181, 58, 0.72)',
    backgroundColor: 'rgba(255, 255, 255, 0.42)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  verifiedText: {
    color: '#7E841B',
    fontSize: 16,
    fontWeight: '800',
    marginLeft: 6,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(27, 37, 95, 0.13)',
    marginVertical: 26,
  },
  qrContainer: {
    alignSelf: 'center',
    padding: 5,
    backgroundColor: Colors.white,
    borderRadius: 24,
    borderCurve: 'continuous',
    borderWidth: 1.5,
    borderColor: Colors.glassBorder,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    alignItems: 'center',
  },
  progressSection: {
    width: '100%',
  },
  refreshRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'center',
    marginTop: 18,
    marginBottom: 10,
  },
  refreshTextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  progressLabel: {
    fontSize: 18,
    color: Colors.textSecondary,
    fontWeight: '600',
    marginLeft: 10,
    marginRight: 6,
  },
  progressSeconds: {
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  progressTrack: {
    height: 7,
    backgroundColor: 'rgba(255, 255, 255, 0.7)',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    borderRadius: 4,
  },
  howItWorks: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  howItWorksIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1.5,
    borderColor: Colors.glassBorder,
    backgroundColor: 'rgba(255, 255, 255, 0.48)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  howItWorksCopy: {
    flex: 1,
  },
  howItWorksTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.primary,
  },
  howItWorksText: {
    fontSize: 15,
    color: Colors.textSecondary,
    fontWeight: '600',
    lineHeight: 21,
    marginTop: 4,
  },
});
