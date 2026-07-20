import '@/lib/polyfills';
import { initSentry, Sentry, sentryEnabled } from '@/lib/sentry';
import { PropsWithChildren, useEffect } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PostHogProvider } from 'posthog-react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/colors';
import { GlassButton, GlassPanel, ResidentScreen } from '@/components/resident-glass';
import { AuthProvider, useAuth } from '@/lib/auth';
import { posthog } from '@/lib/analytics';

// Initialize crash/error reporting as early as possible. No-op without a DSN.
initSentry();

// Wrap the app in PostHogProvider only when a client exists (key configured);
// otherwise render children untouched so analytics stays fully inert.
function AnalyticsProvider({ children }: PropsWithChildren) {
  if (!posthog) return <>{children}</>;
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}

function RootNavigator() {
  const {
    token,
    isLoading,
    isAppLocked,
    isLocalUnlocking,
    localUnlockLabel,
    unlockWithLocalAuth,
    logout,
  } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (!token && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (token && inAuthGroup) {
      router.replace('/(tabs)');
    }
	  }, [token, isLoading, segments, router]);

	  if (isLoading) {
	    return (
	      <ResidentScreen centered>
          <GlassPanel strong style={styles.loadingPanel}>
	          <ActivityIndicator size="large" color={Colors.primary} />
	          <Text style={styles.loadingTitle}>Verifying access...</Text>
	          <Text style={styles.loadingDetail}>Checking your ResMan session before loading passes.</Text>
          </GlassPanel>
	      </ResidentScreen>
	    );
	  }

  async function handleLocalUnlock() {
    try {
      await unlockWithLocalAuth();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Please try again.';
      Alert.alert('Unlock Failed', message);
    }
  }

  async function handleSignOut() {
    try {
      await logout();
      router.replace('/(auth)/login');
    } catch (error) {
      console.warn('Failed to sign out from locked screen.', error);
      Alert.alert('Sign Out Failed', 'Please try again.');
    }
  }

  if (token && isAppLocked) {
    return (
      <ResidentScreen centered>
        <GlassPanel strong style={styles.lockedPanel}>
          <View style={styles.lockIcon}>
            <Ionicons name="lock-closed-outline" size={38} color={Colors.primary} />
          </View>
          <Text style={styles.lockTitle}>Emberly Apartments is locked</Text>
          <Text style={styles.lockDetail}>Use {localUnlockLabel} to continue.</Text>
        <GlassButton
          label={isLocalUnlocking ? 'Unlocking...' : `Unlock with ${localUnlockLabel}`}
          icon="scan-outline"
          onPress={handleLocalUnlock}
          disabled={isLocalUnlocking}
          loading={isLocalUnlocking}
          style={styles.unlockButton}
        />
        <TouchableOpacity style={styles.lockSignOutButton} onPress={handleSignOut} activeOpacity={0.85}>
          <Ionicons name="log-out-outline" size={18} color={Colors.textSecondary} />
          <Text style={styles.lockSignOutText}>Sign Out</Text>
        </TouchableOpacity>
        </GlassPanel>
      </ResidentScreen>
    );
  }

	  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
    </Stack>
	  );
	}

const styles = StyleSheet.create({
  loadingPanel: {
    alignItems: 'center',
    width: '100%',
  },
  loadingTitle: {
    color: Colors.primary,
    fontSize: 18,
    fontWeight: '700',
    marginTop: 16,
  },
  loadingDetail: {
    color: Colors.textSecondary,
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  lockedPanel: {
    alignItems: 'center',
    width: '100%',
  },
  lockIcon: {
    alignItems: 'center',
    backgroundColor: Colors.glassStrong,
    borderColor: Colors.glassBorder,
    borderCurve: 'continuous',
    borderRadius: 24,
    borderWidth: 1,
    height: 68,
    justifyContent: 'center',
    marginBottom: 18,
    width: 68,
  },
  lockTitle: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  lockDetail: {
    color: Colors.textSecondary,
    fontSize: 15,
    marginTop: 8,
    textAlign: 'center',
  },
  unlockButton: {
    marginTop: 28,
    width: '100%',
  },
  lockSignOutButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    marginTop: 18,
    padding: 12,
  },
  lockSignOutText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
  },
});

function RootLayout() {
  return (
    <SafeAreaProvider>
      <AnalyticsProvider>
        <AuthProvider>
          <RootNavigator />
          <StatusBar style="dark" />
        </AuthProvider>
      </AnalyticsProvider>
    </SafeAreaProvider>
  );
}

// Sentry.wrap enables automatic performance/routing instrumentation and error
// boundary capture. Wrapping without an init'd client (no DSN configured) makes
// Sentry warn "`Sentry.wrap` was called before `Sentry.init`" on every launch —
// a blank native LogBox toast — so the wrap is gated with the init.
export default sentryEnabled ? Sentry.wrap(RootLayout) : RootLayout;
