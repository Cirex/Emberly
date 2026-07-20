/**
 * Resident picker — shown when multiple people share the same Resman portal login.
 * The user taps their name and gets issued a token scoped to their specific account.
 */
import { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/colors';
import { GlassPanel, ResidentScreen, ScreenHeader } from '@/components/resident-glass';
import { useAuth } from '@/lib/auth';
import { normalizeUnitLabel } from '@emberly/core';

export default function SelectResidentScreen() {
  const [selectedId, setSelectedId]   = useState<string | null>(null);
  const [isLoading, setIsLoading]     = useState(false);

  const { completeSelection, pendingSelection } = useAuth();
  const router = useRouter();
  const residents = pendingSelection?.residents ?? [];

  useEffect(() => {
    if (!pendingSelection) {
      router.replace('/(auth)/login');
    }
  }, [pendingSelection, router]);

  async function handleSelect(residentId: string) {
    setSelectedId(residentId);
    setIsLoading(true);
    try {
      if (!pendingSelection) {
        throw new Error('Resident selection has expired. Please sign in again.');
      }
      await completeSelection(pendingSelection.selectionToken, residentId);
      router.replace('/(tabs)');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      Alert.alert('Error', message);
      setSelectedId(null);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <ResidentScreen>
      <ScreenHeader
        icon="people-outline"
        title="Choose Resident"
        subtitle="Multiple residents are linked to this account"
      />

      <View style={styles.list}>
        {residents.map((item) => {
          const isSelected = selectedId === item.residentId;
          return (
            <TouchableOpacity
              key={item.residentId}
              style={[styles.card, isSelected && styles.cardSelected]}
              onPress={() => handleSelect(item.residentId)}
              disabled={isLoading}
              activeOpacity={0.75}
            >
              <View style={styles.cardLeft}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {item.name.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View>
                  <Text style={styles.residentName}>{item.name}</Text>
                  <Text style={styles.residentUnit}>
                    {normalizeUnitLabel(item.unitNumber) || item.unitNumber}
                  </Text>
                </View>
              </View>
              {isSelected && isLoading ? (
                <ActivityIndicator color={Colors.primary} />
              ) : (
                <Ionicons
                  name="chevron-forward"
                  size={20}
                  color={isSelected ? Colors.primary : Colors.textSecondary}
                />
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      <GlassPanel style={styles.helpPanel}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          disabled={isLoading}
        >
          <Ionicons name="arrow-back-outline" size={18} color={Colors.primary} style={styles.backIcon} />
          <Text style={styles.backButtonText}>Back to Sign In</Text>
        </TouchableOpacity>
      </GlassPanel>
    </ResidentScreen>
  );
}

const styles = StyleSheet.create({
  list:              { gap: 12, marginBottom: 16 },
  card:              {
    backgroundColor: Colors.glassStrong, borderRadius: 22, borderCurve: 'continuous', padding: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08, shadowRadius: 18, elevation: 4,
  },
  cardSelected:      { borderWidth: 2, borderColor: Colors.primary },
  cardLeft:          { flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1 },
  avatar:            {
    width: 48, height: 48, borderRadius: 18, borderCurve: 'continuous',
    backgroundColor: Colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText:        { fontSize: 20, fontWeight: '700', color: Colors.white },
  residentName:      { fontSize: 17, fontWeight: '600', color: Colors.text },
  residentUnit:      { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  helpPanel:         { padding: 0, overflow: 'hidden' },
  backButton:        {
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    minHeight: 54,
  },
  backIcon:          { marginRight: 8 },
  backButtonText:    { color: Colors.primary, fontSize: 15, fontWeight: '600' },
});
