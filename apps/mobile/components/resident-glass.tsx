import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/colors';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

interface ResidentScreenProps extends Pick<ScrollViewProps, 'keyboardShouldPersistTaps' | 'refreshControl'> {
  children: ReactNode;
  centered?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  scrollEnabled?: boolean;
  variant?: 'default' | 'login';
}

interface GlassPanelProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  strong?: boolean;
}

interface GlassButtonProps {
  label: string;
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  style?: StyleProp<ViewStyle>;
}

interface ScreenHeaderProps {
  icon: IconName;
  title: string;
  subtitle?: string;
}

export function ResidentScreen({
  children,
  centered = false,
  contentStyle,
  scrollEnabled = true,
  keyboardShouldPersistTaps,
  refreshControl,
  variant = 'default',
}: ResidentScreenProps) {
  const isLogin = variant === 'login';

  return (
    <SafeAreaView style={[styles.safeArea, isLogin && styles.loginSafeArea]}>
      <View style={[styles.ambientOlive, isLogin && styles.loginAmbientOlive]} />
      <View style={[styles.ambientBlue, isLogin && styles.loginAmbientBlue]} />
      <View style={[styles.ambientWhite, isLogin && styles.loginAmbientWhite]} />
      {isLogin && (
        <>
          <View style={styles.loginLeafTop} />
          <View style={styles.loginLeafMiddle} />
          <View style={styles.loginLeafLower} />
        </>
      )}
      <ScrollView
        scrollEnabled={scrollEnabled}
        refreshControl={refreshControl}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.screenContent,
          centered && styles.screenContentCentered,
          contentStyle,
        ]}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function GlassPanel({ children, style, strong = false }: GlassPanelProps) {
  return (
    <View style={[styles.glassPanel, strong && styles.glassPanelStrong, style]}>
      {children}
    </View>
  );
}

export function ScreenHeader({ icon, title, subtitle }: ScreenHeaderProps) {
  return (
    <View style={styles.header}>
      <View style={styles.headerIcon}>
        <Ionicons name={icon} size={22} color={Colors.primary} />
      </View>
      <View style={styles.headerText}>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
      </View>
    </View>
  );
}

export function GlassButton({
  label,
  icon,
  onPress,
  disabled = false,
  loading = false,
  variant = 'primary',
  style,
}: GlassButtonProps) {
  const isDanger = variant === 'danger';
  const isSecondary = variant === 'secondary';
  const iconColor = isDanger ? Colors.error : isSecondary ? Colors.primary : Colors.white;

  return (
    <TouchableOpacity
      style={[
        styles.button,
        isSecondary && styles.buttonSecondary,
        isDanger && styles.buttonDanger,
        disabled && styles.buttonDisabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.84}
    >
      {loading ? (
        <ActivityIndicator color={iconColor} />
      ) : (
        <>
          <Ionicons name={icon} size={19} color={iconColor} style={styles.buttonIcon} />
          <Text style={[styles.buttonText, isDanger && styles.buttonTextDanger]}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

export function FieldShell({ children }: { children: ReactNode }) {
  return <View style={styles.fieldShell}>{children}</View>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  loginSafeArea: {
    backgroundColor: Colors.creamWarm,
  },
  ambientOlive: {
    position: 'absolute',
    top: -70,
    right: -95,
    width: 190,
    height: 300,
    borderRadius: 92,
    transform: [{ rotate: '-18deg' }],
    backgroundColor: 'rgba(180, 181, 58, 0.15)',
  },
  loginAmbientOlive: {
    top: 62,
    right: -112,
    width: 110,
    height: 230,
    borderRadius: 55,
    opacity: 0.68,
  },
  ambientBlue: {
    position: 'absolute',
    bottom: -120,
    left: -110,
    width: 210,
    height: 330,
    borderRadius: 96,
    transform: [{ rotate: '18deg' }],
    backgroundColor: 'rgba(38, 52, 138, 0.11)',
  },
  loginAmbientBlue: {
    bottom: 24,
    left: -115,
    opacity: 0.55,
  },
  ambientWhite: {
    position: 'absolute',
    top: '38%',
    left: -70,
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: 'rgba(255, 255, 255, 0.45)',
  },
  loginAmbientWhite: {
    top: '50%',
    left: -42,
    width: 150,
    height: 230,
    borderRadius: 70,
    opacity: 0.6,
  },
  loginLeafTop: {
    position: 'absolute',
    top: 92,
    right: -18,
    width: 42,
    height: 130,
    borderRadius: 22,
    transform: [{ rotate: '-28deg' }],
    backgroundColor: 'rgba(111, 120, 47, 0.28)',
  },
  loginLeafMiddle: {
    position: 'absolute',
    top: 292,
    right: -36,
    width: 124,
    height: 40,
    borderRadius: 22,
    transform: [{ rotate: '23deg' }],
    backgroundColor: 'rgba(151, 157, 66, 0.26)',
  },
  loginLeafLower: {
    position: 'absolute',
    top: 422,
    right: -58,
    width: 114,
    height: 210,
    borderRadius: 56,
    transform: [{ rotate: '21deg' }],
    backgroundColor: 'rgba(143, 151, 64, 0.18)',
  },
  screenContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 112,
  },
  screenContentCentered: {
    justifyContent: 'center',
  },
  glassPanel: {
    backgroundColor: Colors.glass,
    borderRadius: 42,
    borderCurve: 'continuous',
    borderWidth: 1.5,
    borderColor: Colors.glassBorder,
    padding: 20,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 22 },
    shadowOpacity: 0.13,
    shadowRadius: 34,
    elevation: 5,
  },
  glassPanelStrong: {
    backgroundColor: Colors.glassStrong,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18,
  },
  headerIcon: {
    width: 46,
    height: 46,
    borderRadius: 18,
    borderCurve: 'continuous',
    backgroundColor: Colors.glassStrong,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    color: Colors.primary,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 0,
  },
  headerSubtitle: {
    color: Colors.text,
    fontSize: 14,
    lineHeight: 19,
    marginTop: 2,
  },
  button: {
    minHeight: 62,
    borderRadius: 22,
    borderCurve: 'continuous',
    borderWidth: 1.5,
    borderColor: Colors.glassBorder,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    paddingHorizontal: 16,
  },
  buttonSecondary: {
    backgroundColor: Colors.glassStrong,
    borderColor: Colors.glassBorder,
  },
  buttonDanger: {
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
    borderColor: 'rgba(211, 47, 47, 0.5)',
  },
  buttonDisabled: {
    opacity: 0.58,
  },
  buttonIcon: {
    marginRight: 8,
  },
  buttonText: {
    color: Colors.white,
    fontSize: 21,
    fontWeight: '800',
  },
  buttonTextDanger: {
    color: Colors.error,
  },
  fieldShell: {
    minHeight: 58,
    borderRadius: 20,
    borderCurve: 'continuous',
    borderWidth: 1.5,
    borderColor: Colors.glassBorder,
    backgroundColor: 'rgba(255, 255, 255, 0.48)',
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.06,
    shadowRadius: 18,
  },
  sectionLabel: {
    color: Colors.primary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
});
