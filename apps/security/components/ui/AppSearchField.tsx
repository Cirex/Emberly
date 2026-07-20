import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { GlassSurface } from "./GlassSurface";

interface AppSearchFieldProps {
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  width?: number;
}

/**
 * AppSearchField (AppSearchField.swift): capsule height 44, glass surface,
 * magnifier leading, clear button, olive focus ring/stroke.
 */
export function AppSearchField({
  value,
  onChangeText,
  placeholder = "Search",
  width,
}: AppSearchFieldProps) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={{ width }}>
      <GlassSurface
        radius="control"
        style={{
          borderRadius: 999,
          borderColor: focused ? "rgba(162,169,33,0.72)" : undefined,
          borderWidth: focused ? 2 : undefined,
          shadowColor: focused ? "#A2A921" : "transparent",
          shadowOpacity: focused ? 0.16 : 0,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
        }}
      >
        <View
          className="flex-row items-center"
          style={{ height: 44, paddingHorizontal: 14, gap: 8 }}
        >
          <Ionicons name="search" size={17} color="#70788F" />
          <TextInput
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor="rgba(112,120,143,0.7)"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="flex-1 text-navy dark:text-white"
            style={{ fontSize: 16, paddingVertical: 0 }}
          />
          {value.length > 0 ? (
            <Pressable onPress={() => onChangeText("")} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color="#70788F" />
            </Pressable>
          ) : null}
        </View>
      </GlassSurface>
    </View>
  );
}
