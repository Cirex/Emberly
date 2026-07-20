import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Animated,
  Image,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Share,
  RefreshControl,
  PanResponder,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { formatShortDateTime } from '@emberly/core';
import { Colors } from '@/constants/colors';
import {
  FieldShell,
  GlassButton,
  GlassPanel,
  ResidentScreen,
} from '@/components/resident-glass';
import { useAuth } from '@/lib/auth';
import { ApiRequestError, createGuestPass, getGuestPasses, GuestPass, resendGuestPassEmail, revokeGuestPass, verifySession } from '@/lib/api';
import {
  buildGuestPassShareMessage,
  normalizeCreatedGuestPassResponse,
  upsertGuestPass,
} from '@/lib/guestPasses';
import { callWithAccessRetry } from '@/lib/entryPassRefresh';
import { shouldLogoutForHeartbeatResult } from '@/lib/sessionHeartbeat';
import { capture } from '@/lib/analytics';

interface FormState {
  name: string;
  email: string;
  phone: string;
}

const EMPTY_FORM: FormState = { name: '', email: '', phone: '' };
const REVOKE_ACTION_WIDTH = 96;
const REVEAL_REVOKE_THRESHOLD = REVOKE_ACTION_WIDTH / 2;
const FULL_SWIPE_REVOKE_THRESHOLD = REVOKE_ACTION_WIDTH * 0.92;
const flowerLogo = require('../../assets/logo-flower-transparent.png');

function initialsForName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('');
}

function SwipeableGuestPassRow({
  pass,
  statusLabel,
  isActivePass,
  isRevoking,
  isLast,
  formatDate,
  onRevoke,
}: {
  pass: GuestPass;
  statusLabel: string;
  isActivePass: boolean;
  isRevoking: boolean;
  isLast: boolean;
  formatDate: (iso: string) => string;
  onRevoke: (pass: GuestPass) => void;
}) {
  const [translateX] = useState(() => new Animated.Value(0));
  const [showRevokeAction, setShowRevokeAction] = useState(false);

  const settleSwipe = useCallback((toValue: number) => {
    Animated.spring(translateX, {
      toValue,
      useNativeDriver: true,
      tension: 70,
      friction: 11,
    }).start(() => {
      if (toValue === 0) setShowRevokeAction(false);
    });
  }, [translateX]);

  const requestRevoke = useCallback(() => {
    if (isRevoking) return;

    settleSwipe(0);
    setShowRevokeAction(false);
    onRevoke(pass);
  }, [isRevoking, onRevoke, pass, settleSwipe]);

  useEffect(() => {
    if (!isActivePass || isRevoking) {
      settleSwipe(0);
    }
  }, [isActivePass, isRevoking, settleSwipe]);

  const panResponder = useMemo(
    () => PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => (
        isActivePass
        && Math.abs(gesture.dx) > Math.abs(gesture.dy)
        && gesture.dx < -12
      ),
      onPanResponderMove: (_, gesture) => {
        setShowRevokeAction(true);
        const nextValue = Math.max(-REVOKE_ACTION_WIDTH, Math.min(0, gesture.dx));
        translateX.setValue(nextValue);
      },
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx <= -FULL_SWIPE_REVOKE_THRESHOLD) {
          requestRevoke();
          return;
        }

        const shouldStayOpen = gesture.dx < -REVEAL_REVOKE_THRESHOLD;
        setShowRevokeAction(shouldStayOpen);
        settleSwipe(shouldStayOpen ? -REVOKE_ACTION_WIDTH : 0);
      },
      onPanResponderTerminate: () => settleSwipe(0),
    }),
    [isActivePass, requestRevoke, settleSwipe, translateX]
  );

  return (
    <View style={styles.swipeContainer}>
      {isActivePass && showRevokeAction && (
        <TouchableOpacity
          style={styles.revokeAction}
          onPress={requestRevoke}
          disabled={isRevoking}
          activeOpacity={0.85}
        >
          {isRevoking ? (
            <ActivityIndicator size="small" color={Colors.white} />
          ) : (
            <>
              <Ionicons name="trash-outline" size={19} color={Colors.white} />
              <Text style={styles.revokeActionText}>Revoke</Text>
            </>
          )}
        </TouchableOpacity>
      )}
      <Animated.View
        {...(isActivePass ? panResponder.panHandlers : {})}
        style={[
          styles.passRow,
          isLast && styles.passRowLast,
          !isActivePass && styles.passRowUsed,
          { transform: [{ translateX }] },
        ]}
      >
        <View style={[styles.passAvatar, !isActivePass && styles.passAvatarUsed]}>
          <Text style={[styles.passAvatarText, !isActivePass && styles.passAvatarTextUsed]}>
            {initialsForName(pass.guestName)}
          </Text>
        </View>
        <View style={styles.passInfo}>
          <Text style={[styles.passName, !isActivePass && styles.passNameUsed]}>
            {pass.guestName}
          </Text>
          <Text style={styles.passMeta}>
            Expires {formatDate(pass.expiresAt)}
          </Text>
          {pass.used && pass.usedAt && (
            <Text style={styles.passUsedAt}>Used {formatDate(pass.usedAt)}</Text>
          )}
          <View style={[styles.statusBadge, isActivePass ? styles.statusActive : styles.statusUsed]}>
            <Text style={[styles.statusText, isActivePass ? styles.statusTextActive : styles.statusTextUsed]}>
              {statusLabel}
            </Text>
          </View>
        </View>
        <Ionicons name="chevron-forward" size={24} color={Colors.textSecondary} />
      </Animated.View>
    </View>
  );
}

export default function GuestPassScreen() {
  const { token, resmanSession, logout } = useAuth();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdPass, setCreatedPass] = useState<GuestPass | null>(null);
  const [passes, setPasses] = useState<GuestPass[]>([]);
  const [isLoadingPasses, setIsLoadingPasses] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [passListError, setPassListError] = useState<string | null>(null);
  const [revokingPassIds, setRevokingPassIds] = useState<Set<string>>(new Set());

  const loadPasses = useCallback(async () => {
    if (!token) return null;
    try {
      const data = await getGuestPasses(token);
      setPasses(data);
      setPassListError(null);
      return data;
    } catch (err: unknown) {
      const isAuthFailure = err instanceof ApiRequestError && (err.status === 401 || err.status === 403);
      if (isAuthFailure && resmanSession) {
        // Route auth failures through the same heartbeat/logout handling used
        // elsewhere on this screen.
        const heartbeat = await verifySession(token, resmanSession);
        if (shouldLogoutForHeartbeatResult(heartbeat)) {
          await logout();
          return null;
        }
      }
      // Don't block the creation form, but let the user know the list is stale.
      setPassListError(
        isAuthFailure
          ? 'Your session could not be verified. Pull to refresh, or sign in again if this continues.'
          : 'Guest passes could not be refreshed. Pull to refresh to try again.'
      );
      return null;
    }
  }, [logout, resmanSession, token]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      loadPasses().finally(() => setIsLoadingPasses(false));
    }, 0);
    return () => clearTimeout(timeout);
  }, [loadPasses]);

  async function handleRefresh() {
    setIsRefreshing(true);
    await loadPasses();
    setIsRefreshing(false);
  }

  async function handleCreatePass() {
    if (!form.name.trim()) {
      Alert.alert('Required', 'Please enter the guest name.');
      return;
    }
    if (!form.email.trim()) {
      Alert.alert('Required', 'Please enter the guest email.');
      return;
    }
    if (!form.phone.trim()) {
      Alert.alert('Required', 'Please enter the guest phone number.');
      return;
    }
    if (!token) return;

    const guest = {
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
    };

    setIsSubmitting(true);
    try {
      const result = await callWithAccessRetry({
        call: () => createGuestPass(token, guest),
        verifyAccess: resmanSession ? () => verifySession(token, resmanSession) : null,
        logout,
        logoutMessage: 'Your resident access could not be verified. Please sign in again.',
      });
      const pass = normalizeCreatedGuestPassResponse(result);
      // Example analytics capture (no guest PII). No-op unless PostHog is configured.
      capture('guest_pass_created', { emailWarning: Boolean(result.warning) });
      setCreatedPass(pass);
      setPasses((current) => upsertGuestPass(current, pass));
      setForm(EMPTY_FORM);
      const refreshed = await loadPasses();
      if (!refreshed?.some((item) => item.passId === pass.passId)) {
        setPasses((current) => upsertGuestPass(current, pass));
      }
      if (result.warning) {
        Alert.alert(
          'Pass Created',
          'The guest pass was created, but the email could not be sent. Use Share Pass to send it manually or try resending the email.'
        );
      }
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.reason === 'active_guest_pass_exists' && err.existingPassId) {
        const existingPassId = err.existingPassId;
        Alert.alert(
          'Active pass already exists',
          'This guest already has an active pass. You can resend the email instead of creating another pass.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Resend Email',
              onPress: () => {
                void resendGuestPassEmail(token, existingPassId)
                  .then(() => Alert.alert('Email Sent', 'The active guest pass email was resent.'))
                  .catch((resendErr: unknown) => {
                    const resendMsg = resendErr instanceof Error ? resendErr.message : 'Failed to resend email.';
                    Alert.alert('Error', resendMsg);
                  });
              },
            },
          ]
        );
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to create pass.';
      Alert.alert('Error', msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleShare(pass: GuestPass) {
    try {
      await Share.share({ message: buildGuestPassShareMessage(pass) });
    } catch {
      // User dismissed share sheet
    }
  }

  async function confirmRevokePass(pass: GuestPass) {
    if (!token || !pass.passId) return;

    setRevokingPassIds((current) => new Set(current).add(pass.passId));
    try {
      const result = await revokeGuestPass(token, pass.passId);
      const revokedPass = result.pass
        ? normalizeCreatedGuestPassResponse({ pass: result.pass })
        : { ...pass, status: 'revoked' as const };

      setPasses((current) => current.map((item) => (
        item.passId === pass.passId
          ? { ...item, ...revokedPass, status: 'revoked', used: false }
          : item
      )));
      if (createdPass?.passId === pass.passId) {
        setCreatedPass(null);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to revoke guest pass.';
      Alert.alert('Error', msg);
    } finally {
      setRevokingPassIds((current) => {
        const next = new Set(current);
        next.delete(pass.passId);
        return next;
      });
    }
  }

  function handleRevokePass(pass: GuestPass) {
    Alert.alert(
      'Revoke Guest Pass',
      `${pass.guestName}'s pass will stop working immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () => {
            void confirmRevokePass(pass);
          },
        },
      ]
    );
  }

  function formatDate(iso: string): string {
    return formatShortDateTime(iso, 'Unknown');
  }

  function formatPassStatus(pass: GuestPass): string {
    if (pass.status === 'revoked') return 'Revoked';
    if (pass.status === 'expired') return 'Expired';
    if (pass.status === 'used' || pass.used) return 'Used';
    return 'Active';
  }

  return (
    <ResidentScreen
        variant="login"
        contentStyle={styles.screenContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={Colors.primary}
          />
        }
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.guestHeroHeader}>
          <Image source={flowerLogo} style={styles.heroFlower} resizeMode="contain" />
          <Text style={styles.heroTitle}>Guest Passes</Text>
        </View>

        {/* Creation Form */}
        <GlassPanel strong style={styles.invitePanel}>
          <Text style={styles.panelTitle}>Create a Guest Pass</Text>
          <Text style={styles.panelSubtitle}>24-hour single-use access</Text>

          {[
            { key: 'name', placeholder: 'Guest Name', icon: 'person-outline' as const, keyboard: 'default' as const },
            { key: 'email', placeholder: 'Email', icon: 'mail-outline' as const, keyboard: 'email-address' as const },
            { key: 'phone', placeholder: 'Phone Number', icon: 'call-outline' as const, keyboard: 'phone-pad' as const },
          ].map(({ key, placeholder, icon, keyboard }) => (
            <View key={key} style={styles.inputGroup}>
              <FieldShell>
                <Ionicons name={icon} size={24} color={Colors.textSecondary} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  value={form[key as keyof FormState]}
                  onChangeText={(v) => setForm((f) => ({ ...f, [key]: v }))}
                  placeholder={placeholder}
                  placeholderTextColor={Colors.textSecondary}
                  keyboardType={keyboard}
                  autoCapitalize={key === 'name' ? 'words' : 'none'}
                  autoCorrect={false}
                  editable={!isSubmitting}
                />
              </FieldShell>
            </View>
          ))}

          <GlassButton
            label="Create Pass"
            icon="id-card-outline"
            onPress={handleCreatePass}
            disabled={isSubmitting}
            loading={isSubmitting}
            style={styles.createButton}
          />
        </GlassPanel>

        {/* Newly Created Pass QR */}
        {createdPass && (
          <GlassPanel style={styles.guestTicketPanel}>
            <View style={styles.successBadge}>
              <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
              <Text style={styles.successText}>Pass Created!</Text>
            </View>
            <View style={styles.qrCenter}>
              <QRCode value={createdPass.qrData} size={180} color={Colors.primary} backgroundColor={Colors.white} />
            </View>
            <TouchableOpacity
              style={styles.shareButton}
              onPress={() => handleShare(createdPass)}
              activeOpacity={0.85}
            >
              <Ionicons name="share-outline" size={18} color={Colors.primary} style={styles.buttonIcon} />
              <Text style={styles.shareButtonText}>Share Pass</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setCreatedPass(null)} style={styles.dismissButton}>
              <Text style={styles.dismissText}>Dismiss</Text>
            </TouchableOpacity>
          </GlassPanel>
        )}

        {/* Pass History */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionHeaderTitle}>Recent Passes</Text>
          <TouchableOpacity
            style={styles.viewAllButton}
            onPress={() => void handleRefresh()}
            activeOpacity={0.82}
          >
            <Text style={styles.viewAllText}>View All</Text>
            <Ionicons name="chevron-forward" size={18} color={Colors.primary} />
          </TouchableOpacity>
          {isLoadingPasses && <ActivityIndicator size="small" color={Colors.primary} />}
        </View>
        {passListError && (
          <Text style={styles.passListError} selectable>{passListError}</Text>
        )}
        {passes.length === 0 && !isLoadingPasses ? (
          <GlassPanel style={styles.emptyState}>
            <Ionicons name="person-add-outline" size={40} color={Colors.border} />
            <Text style={styles.emptyText}>No guest passes yet</Text>
          </GlassPanel>
        ) : (
          <GlassPanel style={styles.recentPassesPanel}>
            {passes.map((pass, index) => {
              const statusLabel = formatPassStatus(pass);
              const isActivePass = statusLabel === 'Active';

              return (
                <SwipeableGuestPassRow
                  key={pass.passId}
                  pass={pass}
                  statusLabel={statusLabel}
                  isActivePass={isActivePass}
                  isRevoking={revokingPassIds.has(pass.passId)}
                  isLast={index === passes.length - 1}
                  formatDate={formatDate}
                  onRevoke={handleRevokePass}
                />
              );
            })}
          </GlassPanel>
        )}

        <View style={styles.guestPassNote}>
          <View style={styles.noteIcon}>
            <Ionicons name="shield-checkmark-outline" size={24} color={Colors.accent} />
          </View>
          <Text style={styles.noteText}>
            Guest passes are single-use and expire after 24 hours. You&apos;ll be notified when a pass is used.
          </Text>
        </View>
      </ResidentScreen>
  );
}

const styles = StyleSheet.create({
  screenContent: {
    paddingHorizontal: 24,
    paddingTop: 34,
  },
  guestHeroHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: 28,
  },
  heroFlower: {
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
  invitePanel: {
    paddingHorizontal: 26,
    paddingTop: 34,
    paddingBottom: 30,
    borderRadius: 48,
    marginBottom: 28,
  },
  guestTicketPanel: {
    borderRadius: 42,
    marginBottom: 16,
  },
  panelTitle: {
    color: Colors.primary,
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
  },
  panelSubtitle: {
    color: Colors.textSecondary,
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 20,
  },
  inputGroup: {
    marginBottom: 14,
  },
  inputIcon: {
    marginRight: 18,
  },
  input: {
    flex: 1,
    height: 58,
    fontSize: 15,
    color: Colors.text,
  },
  createButton: {
    marginTop: 12,
    minHeight: 52,
    borderRadius: 18,
  },
  buttonIcon: {
    marginRight: 8,
  },
  successBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(244, 241, 230, 0.78)',
    borderRadius: 16,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 16,
  },
  successText: {
    color: Colors.primary,
    fontWeight: '700',
    fontSize: 16,
    marginLeft: 6,
  },
  qrCenter: {
    alignSelf: 'center',
    alignItems: 'center',
    width: 204,
    padding: 12,
    borderRadius: 26,
    borderCurve: 'continuous',
    borderWidth: 1.5,
    borderColor: Colors.accent,
    backgroundColor: Colors.white,
    marginBottom: 16,
  },
  shareButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: Colors.primary,
    borderRadius: 20,
    borderCurve: 'continuous',
    backgroundColor: Colors.glassStrong,
    height: 48,
    marginBottom: 8,
  },
  shareButtonText: {
    color: Colors.primary,
    fontSize: 15,
    fontWeight: '600',
  },
  dismissButton: {
    alignItems: 'center',
    padding: 8,
  },
  dismissText: {
    color: Colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    marginTop: 6,
    paddingHorizontal: 2,
  },
  sectionHeaderTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.primary,
  },
  viewAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  viewAllText: {
    color: Colors.primary,
    fontSize: 16,
    fontWeight: '700',
    marginRight: 4,
  },
  passListError: {
    color: Colors.error,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
    paddingHorizontal: 2,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
    marginBottom: 24,
  },
  emptyText: {
    marginTop: 12,
    fontSize: 15,
    color: Colors.textSecondary,
  },
  swipeContainer: {
    borderRadius: 0,
    borderCurve: 'continuous',
    marginBottom: 0,
    overflow: 'hidden',
  },
  revokeAction: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: REVOKE_ACTION_WIDTH,
    backgroundColor: Colors.error,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  revokeActionText: {
    color: Colors.white,
    fontSize: 12,
    fontWeight: '700',
  },
  passRow: {
    backgroundColor: 'rgba(255, 255, 255, 0.78)',
    borderRadius: 0,
    borderCurve: 'continuous',
    paddingVertical: 14,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(27, 37, 95, 0.12)',
  },
  passRowLast: {
    borderBottomWidth: 0,
  },
  passRowUsed: {
    opacity: 0.55,
    borderLeftColor: Colors.textSecondary,
  },
  passInfo: {
    flex: 1,
  },
  passAvatar: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 1.5,
    borderColor: Colors.glassBorder,
    backgroundColor: 'rgba(255, 255, 255, 0.56)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  passAvatarUsed: {
    opacity: 0.75,
  },
  passAvatarText: {
    color: '#7E841B',
    fontSize: 20,
    fontWeight: '800',
  },
  passAvatarTextUsed: {
    color: Colors.textSecondary,
  },
  passName: {
    fontSize: 17,
    fontWeight: '800',
    color: Colors.primary,
    marginBottom: 3,
  },
  passNameUsed: {
    textDecorationLine: 'line-through',
    color: Colors.textSecondary,
  },
  passMeta: {
    fontSize: 14,
    color: Colors.textSecondary,
  },
  passUsedAt: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  statusBadge: {
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingVertical: 4,
    paddingHorizontal: 10,
    alignSelf: 'flex-start',
    marginTop: 7,
    borderWidth: 1,
  },
  statusActive: {
    backgroundColor: Colors.cream,
    borderColor: Colors.accent,
  },
  statusUsed: {
    backgroundColor: Colors.background,
    borderColor: Colors.border,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
  },
  statusTextActive: {
    color: Colors.primary,
  },
  statusTextUsed: {
    color: Colors.textSecondary,
  },
  recentPassesPanel: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    marginBottom: 28,
    overflow: 'hidden',
  },
  guestPassNote: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  noteIcon: {
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
  noteText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
});
