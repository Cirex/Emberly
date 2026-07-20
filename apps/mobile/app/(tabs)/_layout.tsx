import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/colors';

type IoniconsName = React.ComponentProps<typeof Ionicons>['name'];

interface TabConfig {
  name: string;
  title: string;
  icon: IoniconsName;
  iconFocused: IoniconsName;
}

const TABS: TabConfig[] = [
  {
    name: 'index',
    title: 'My Pass',
    icon: 'qr-code-outline',
    iconFocused: 'qr-code',
  },
  {
    name: 'guest-pass',
    title: 'Guest Passes',
    icon: 'people-outline',
    iconFocused: 'people',
  },
  {
    name: 'settings',
    title: 'Settings',
    icon: 'settings-outline',
    iconFocused: 'settings',
  },
];

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textSecondary,
        tabBarStyle: {
          position: 'absolute',
          left: 14,
          right: 14,
          bottom: 10,
          backgroundColor: Colors.glassStrong,
          borderColor: Colors.glassBorder,
          borderTopWidth: 1,
          borderWidth: 1,
          borderRadius: 28,
          height: 72,
          paddingBottom: 12,
          paddingTop: 8,
          shadowColor: Colors.primary,
          shadowOffset: { width: 0, height: 12 },
          shadowOpacity: 0.13,
          shadowRadius: 24,
          elevation: 8,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '700',
        },
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarIcon: ({ focused, color, size }) => (
              <Ionicons
                name={focused ? tab.iconFocused : tab.icon}
                size={size}
                color={color}
              />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
