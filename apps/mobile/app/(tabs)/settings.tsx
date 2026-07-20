import { useState } from 'react';
import { Alert, StyleSheet, Switch, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/colors';
import {
  GlassButton,
  GlassPanel,
  ResidentScreen,
  ScreenHeader,
  SectionLabel,
} from '@/components/resident-glass';
import { useAuth } from '@/lib/auth';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

interface InfoRowProps {
  icon: IconName;
  label: string;
  value: string;
}

function InfoRow({ icon, label, value }: InfoRowProps) {
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoIcon}>
        <Ionicons name={icon} size={18} color={Colors.primary} />
      </View>
      <View style={styles.infoText}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue}>{value}</Text>
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const {
    resident,
    name,
    logout,
    localUnlockEnabled,
    localUnlockAvailable,
    localUnlockLabel,
    localUnlockUnavailableReason,
    enableLocalUnlock,
    disableLocalUnlock,
  } = useAuth();
  const router = useRouter();
  const [isUpdatingLocalUnlock, setIsUpdatingLocalUnlock] = useState(false);

  async function handleLocalUnlockChange(enabled: boolean) {
    setIsUpdatingLocalUnlock(true);
    try {
      if (enabled) {
        await enableLocalUnlock();
      } else {
        await disableLocalUnlock();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Please try again.';
      Alert.alert(`${localUnlockLabel} Unavailable`, message);
    } finally {
      setIsUpdatingLocalUnlock(false);
    }
  }

  function handleSignOut() {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await logout();
              router.replace('/(auth)/login');
            } catch (error) {
              console.warn('Failed to sign out.', error);
              Alert.alert('Sign Out Failed', 'Please try again.');
            }
          })();
        },
      },
    ]);
  }

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';
  const displayName = resident?.name ?? name ?? 'Resident';

  return (
    <ResidentScreen>
      <ScreenHeader
        icon="settings-outline"
        title="Settings"
        subtitle="Account, security, and app details"
      />

      <GlassPanel strong style={styles.identityPanel}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{displayName.charAt(0).toUpperCase()}</Text>
        </View>
        <Text style={styles.displayName}>{displayName}</Text>
        <Text style={styles.unitText}>Unit {resident?.unitNumber ?? '—'}</Text>
      </GlassPanel>

      <GlassPanel style={styles.panel}>
        <SectionLabel>Account</SectionLabel>
        <InfoRow icon="home-outline" label="Unit" value={resident?.unitNumber ?? '—'} />
        <View style={styles.divider} />
        <InfoRow icon="shield-checkmark-outline" label="Access" value="Resident" />
      </GlassPanel>

      <GlassPanel style={styles.panel}>
        <SectionLabel>Security</SectionLabel>
        <View style={styles.settingRow}>
          <View style={styles.infoIcon}>
            <Ionicons name="scan-outline" size={18} color={Colors.primary} />
          </View>
          <View style={styles.settingText}>
            <Text style={styles.settingTitle}>{localUnlockLabel} Unlock</Text>
            <Text style={styles.settingDetail}>
              {localUnlockAvailable
                ? `Require ${localUnlockLabel} when reopening the app.`
                : localUnlockUnavailableReason ?? `${localUnlockLabel} is unavailable on this device.`}
            </Text>
          </View>
          <Switch
            value={localUnlockEnabled}
            onValueChange={handleLocalUnlockChange}
            disabled={isUpdatingLocalUnlock || (!localUnlockEnabled && !localUnlockAvailable)}
            trackColor={{ false: Colors.border, true: Colors.accent }}
            thumbColor={Colors.white}
            ios_backgroundColor={Colors.border}
          />
        </View>
      </GlassPanel>

      <GlassPanel style={styles.panel}>
        <SectionLabel>App</SectionLabel>
        <InfoRow icon="phone-portrait-outline" label="Version" value={appVersion} />
      </GlassPanel>

      <GlassButton
        label="Sign Out"
        icon="log-out-outline"
        variant="danger"
        onPress={handleSignOut}
      />
    </ResidentScreen>
  );
}

const styles = StyleSheet.create({
  identityPanel: {
    alignItems: 'center',
    marginBottom: 14,
  },
  panel: {
    marginBottom: 14,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 30,
    borderCurve: 'continuous',
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 14,
    elevation: 5,
  },
  avatarText: {
    color: Colors.white,
    fontSize: 32,
    fontWeight: '800',
  },
  displayName: {
    color: Colors.primary,
    fontSize: 23,
    fontWeight: '800',
    textAlign: 'center',
  },
  unitText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    marginTop: 4,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
  },
  infoIcon: {
    width: 38,
    height: 38,
    borderRadius: 14,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    backgroundColor: 'rgba(244, 241, 230, 0.78)',
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  infoText: {
    flex: 1,
  },
  infoLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  infoValue: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(38, 52, 138, 0.1)',
    marginLeft: 50,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 62,
  },
  settingText: {
    flex: 1,
    paddingRight: 10,
  },
  settingTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '800',
  },
  settingDetail: {
    color: Colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
});
