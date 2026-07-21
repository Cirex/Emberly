import { useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/colors';
import { FieldShell, GlassButton, GlassPanel, ResidentScreen } from '@/components/resident-glass';
import { useAuth } from '@/lib/auth';
import { ApiRequestError } from '@/lib/api';
import { capture } from '@/lib/analytics';

const logo = require('../../assets/logo-transparent.png');

export default function LoginScreen() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [useFaceId, setUseFaceId] = useState(false);

  const {
    login,
    localUnlockAvailable,
    localUnlockLabel,
    enableLocalUnlock,
  } = useAuth();
  const router = useRouter();

  async function handleSignIn() {
    if (!username.trim() || !password.trim()) {
      Alert.alert('Missing Fields', 'Please enter your username and password.');
      return;
    }

    setIsLoading(true);
    try {
      const result = await login(username.trim(), password);

      // Example analytics capture (no PII). No-op unless PostHog is configured.
      capture('login_success', { requiresSelection: result.requiresSelection });

      if (!result.requiresSelection) {
        if (useFaceId && localUnlockAvailable) {
          await enableLocalUnlock().catch((error) => {
            console.warn(`Failed to enable ${localUnlockLabel} after sign in.`, error);
          });
        }
        router.replace('/(tabs)');
      } else {
        router.push('/(auth)/select-resident');
      }
    } catch (err: unknown) {
      // Categorized only — never the message, which can echo the username.
      capture('login_failed', {
        reason: err instanceof ApiRequestError
          ? (err.status === 401 || err.status === 403 ? 'rejected' : 'server')
          : 'network',
      });
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      Alert.alert('Sign In Failed', message);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.keyboardAvoid}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ResidentScreen
        variant="login"
        keyboardShouldPersistTaps="handled"
        contentStyle={styles.screenContent}
      >
        <View style={styles.loginShell}>
          <View style={styles.header}>
            <Image source={logo} style={styles.brandLogo} resizeMode="contain" />
          </View>

          <GlassPanel strong style={styles.loginPanel}>
            <View style={styles.panelHeader}>
              <Text style={styles.panelTitle}>Welcome Home</Text>
              <Text style={styles.panelSubtitle}>Sign in to access your resident account.</Text>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Username</Text>
              <FieldShell>
                <Ionicons
                  name="person-outline"
                  size={26}
                  color={Colors.textSecondary}
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.input}
                  value={username}
                  onChangeText={setUsername}
                  placeholder="Enter your username"
                  placeholderTextColor={Colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                  editable={!isLoading}
                />
              </FieldShell>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <FieldShell>
                <Ionicons
                  name="lock-closed-outline"
                  size={25}
                  color={Colors.textSecondary}
                  style={styles.inputIcon}
                />
                <TextInput
                  style={styles.input}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Enter your password"
                  placeholderTextColor={Colors.textSecondary}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleSignIn}
                  editable={!isLoading}
                />
                <TouchableOpacity
                  onPress={() => setShowPassword((value) => !value)}
                  style={styles.eyeButton}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={26}
                    color={Colors.textSecondary}
                  />
                </TouchableOpacity>
              </FieldShell>
            </View>

            <TouchableOpacity
              style={[styles.faceIdRow, !localUnlockAvailable && styles.faceIdRowDisabled]}
              onPress={() => localUnlockAvailable && setUseFaceId((value) => !value)}
              activeOpacity={0.82}
              disabled={!localUnlockAvailable}
            >
              <Ionicons
                name="scan-outline"
                size={25}
                color={localUnlockAvailable ? Colors.accent : Colors.textSecondary}
                style={styles.faceIdIcon}
              />
              <Text style={styles.faceIdText}>Use Face ID</Text>
              <View style={[styles.faceIdSwitch, useFaceId && styles.faceIdSwitchOn]}>
                <View style={[styles.faceIdThumb, useFaceId && styles.faceIdThumbOn]} />
              </View>
            </TouchableOpacity>

            <GlassButton
              label="Sign In"
              icon="lock-closed-outline"
              onPress={handleSignIn}
              disabled={isLoading}
              loading={isLoading}
              style={styles.signInButton}
            />
          </GlassPanel>

          <Text style={styles.supportNote}>Having issues? Contact your property manager.</Text>
        </View>
      </ResidentScreen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboardAvoid: {
    flex: 1,
  },
  screenContent: {
    paddingHorizontal: 24,
    paddingTop: 38,
    paddingBottom: 32,
  },
  loginShell: {
    width: '100%',
    maxWidth: 390,
    alignSelf: 'center',
    flexGrow: 1,
    justifyContent: 'flex-start',
  },
  header: {
    alignItems: 'center',
    marginBottom: 38,
  },
  brandLogo: {
    width: '100%',
    maxWidth: 290,
    height: 154,
  },
  loginPanel: {
    paddingHorizontal: 28,
    paddingTop: 34,
    paddingBottom: 30,
    borderRadius: 48,
    shadowOffset: { width: 0, height: 26 },
    shadowOpacity: 0.16,
    shadowRadius: 38,
  },
  panelHeader: {
    alignItems: 'center',
    marginBottom: 26,
  },
  panelTitle: {
    color: Colors.primary,
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
  },
  panelSubtitle: {
    color: Colors.textSecondary,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 22,
    marginTop: 8,
    textAlign: 'center',
  },
  inputGroup: {
    marginBottom: 16,
  },
  label: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 12,
  },
  inputIcon: {
    marginRight: 18,
  },
  input: {
    flex: 1,
    height: 58,
    color: Colors.text,
    fontSize: 16,
  },
  eyeButton: {
    padding: 4,
  },
  faceIdRow: {
    minHeight: 58,
    borderRadius: 20,
    borderCurve: 'continuous',
    borderWidth: 1.5,
    borderColor: Colors.glassBorder,
    backgroundColor: 'rgba(255, 255, 255, 0.48)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    marginTop: 10,
    marginBottom: 22,
  },
  faceIdRowDisabled: {
    opacity: 0.58,
  },
  faceIdIcon: {
    marginRight: 18,
  },
  faceIdText: {
    flex: 1,
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  faceIdSwitch: {
    width: 54,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(180, 181, 58, 0.42)',
    padding: 3,
    justifyContent: 'center',
  },
  faceIdSwitchOn: {
    backgroundColor: Colors.accent,
  },
  faceIdThumb: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.white,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 8,
  },
  faceIdThumbOn: {
    alignSelf: 'flex-end',
  },
  signInButton: {
    minHeight: 64,
    borderRadius: 20,
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.34,
    shadowRadius: 24,
  },
  supportNote: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 16,
    textAlign: 'center',
  },
});
