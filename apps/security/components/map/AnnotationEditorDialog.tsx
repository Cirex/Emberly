import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { Alert, Image, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { photoUri, useAnnotationPhotos } from "@/lib/stores/annotation-photos";
import { useAnnotations, type MapAnnotation } from "@/lib/stores/annotations";

/**
 * Centered edit dialog for a map pin — the RN take on the Swift app's
 * MapAnnotationEditorSheet: title, notes, a color for the pin, and photos.
 * Edits apply to the store as they're made (they sync on the next tick);
 * photos stay on this device, as they did in the original app.
 */

/** Swift offered a full color wheel; a curated grid covers the same ground
 *  without a custom picker — brand hues first, then the practical rest. */
const PIN_PALETTE = [
  "#A2A921", "#767B24", "#D1382E", "#E38736",
  "#E3B23A", "#2E8A5F", "#458ADB", "#7A6BC7",
  "#D4537E", "#5B7C99", "#70788F", "#091B54",
];

const THUMB = 84;

/** Guard-relevant pin glyphs (Ionicons). First entry is the classic note. */
export const PIN_ICONS: { name: React.ComponentProps<typeof Ionicons>["name"]; label: string }[] = [
  { name: "document-text", label: "Note" },
  { name: "lock-open", label: "Unlocked" },
  { name: "trash", label: "Trash" },
  { name: "warning", label: "Hazard" },
  { name: "build", label: "Repair" },
  { name: "car", label: "Vehicle" },
  { name: "water", label: "Leak" },
  { name: "paw", label: "Animal" },
  { name: "flash", label: "Power" },
  { name: "key", label: "Key" },
];

/** Stable empty result — a `?? []` inside a zustand selector mints a new array
 *  every snapshot, which React reads as "state changed" forever. */
const NO_PHOTOS: string[] = [];

export function AnnotationEditorDialog({
  annotation,
  onClose,
}: {
  annotation: MapAnnotation;
  onClose: () => void;
}) {
  const update = useAnnotations((s) => s.update);
  const removePin = useAnnotations((s) => s.remove);
  const photos = useAnnotationPhotos((s) => s.byAnnotation[annotation.id]) ?? NO_PHOTOS;
  const addPhoto = useAnnotationPhotos((s) => s.add);
  const removePhoto = useAnnotationPhotos((s) => s.remove);

  const pickPhoto = () => {
    const attach = async (result: ImagePicker.ImagePickerResult) => {
      const uri = result.assets?.[0]?.uri;
      if (!result.canceled && uri) await addPhoto(annotation.id, uri);
    };
    Alert.alert("Add photo", undefined, [
      {
        text: "Take Photo",
        onPress: () => void ImagePicker.launchCameraAsync({ quality: 0.7 }).then(attach),
      },
      {
        text: "Choose from Library",
        onPress: () =>
          void ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 }).then(attach),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const confirmDelete = () => {
    Alert.alert("Delete pin?", "The pin and its photos will be removed everywhere.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          removePin(annotation.id);
          onClose();
        },
      },
    ]);
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: "rgba(9,27,84,0.32)",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        {/* Pressable-in-Pressable: taps inside the card must not dismiss. */}
        <Pressable
          onPress={() => {}}
          className="bg-white dark:bg-night-surface"
          style={{ width: "100%", maxWidth: 480, borderRadius: 22, padding: 22, gap: 16 }}
        >
          <View className="flex-row items-center justify-between">
            <Text className="text-navy dark:text-white" style={{ fontSize: 19, fontWeight: "700" }}>
              Annotation
            </Text>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: annotation.color }} />
          </View>

          <View style={{ gap: 10 }}>
            <TextInput
              value={annotation.title}
              onChangeText={(t) => update(annotation.id, { title: t })}
              placeholder="Title"
              placeholderTextColor="rgba(112,120,143,0.6)"
              autoCorrect={false}
              className="text-navy dark:text-white"
              style={{
                fontSize: 16,
                fontWeight: "600",
                borderWidth: 1,
                borderColor: "rgba(9,27,84,0.14)",
                borderRadius: 12,
                paddingHorizontal: 13,
                paddingVertical: 10,
              }}
            />
            <TextInput
              value={annotation.notes}
              onChangeText={(t) => update(annotation.id, { notes: t })}
              placeholder="Notes (optional)"
              placeholderTextColor="rgba(112,120,143,0.6)"
              multiline
              className="text-slate dark:text-white/80"
              style={{
                fontSize: 14,
                minHeight: 64,
                borderWidth: 1,
                borderColor: "rgba(9,27,84,0.14)",
                borderRadius: 12,
                paddingHorizontal: 13,
                paddingVertical: 10,
                textAlignVertical: "top",
              }}
            />
          </View>

          <View style={{ gap: 8 }}>
            <Text className="text-slate dark:text-white/60" style={{ fontSize: 12, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" }}>
              Pin icon
            </Text>
            <View className="flex-row flex-wrap" style={{ gap: 9 }}>
              {PIN_ICONS.map((choice) => {
                const active = (annotation.icon || "document-text") === choice.name;
                return (
                  <Pressable
                    key={choice.name}
                    onPress={() => update(annotation.id, { icon: choice.name })}
                    accessibilityLabel={choice.label}
                    hitSlop={4}
                  >
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: active ? annotation.color : "rgba(9,27,84,0.06)",
                        borderWidth: active ? 2 : 0,
                        borderColor: "#FFFFFF",
                        shadowColor: "#000",
                        shadowOpacity: active ? 0.3 : 0,
                        shadowRadius: 4,
                        shadowOffset: { width: 0, height: 2 },
                      }}
                    >
                      <Ionicons name={choice.name} size={19} color={active ? "#FFFFFF" : "#70788F"} />
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <Text className="text-slate dark:text-white/60" style={{ fontSize: 12, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" }}>
              Pin color
            </Text>
            <View className="flex-row flex-wrap" style={{ gap: 10 }}>
              {PIN_PALETTE.map((c) => (
                <Pressable key={c} onPress={() => update(annotation.id, { color: c })} hitSlop={4}>
                  <View
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 15,
                      backgroundColor: c,
                      borderWidth: annotation.color === c ? 3 : 0,
                      borderColor: "#FFFFFF",
                      shadowColor: "#000",
                      shadowOpacity: annotation.color === c ? 0.35 : 0,
                      shadowRadius: 4,
                      shadowOffset: { width: 0, height: 2 },
                    }}
                  />
                </Pressable>
              ))}
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <Text className="text-slate dark:text-white/60" style={{ fontSize: 12, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" }}>
              Photos
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
              {photos.map((photoId) => (
                <View key={photoId} style={{ width: THUMB, height: THUMB }}>
                  <Image
                    source={{ uri: photoUri(photoId) }}
                    style={{ width: THUMB, height: THUMB, borderRadius: 12 }}
                    resizeMode="cover"
                  />
                  <Pressable
                    onPress={() => removePhoto(annotation.id, photoId)}
                    hitSlop={8}
                    accessibilityLabel="Remove photo"
                    style={{ position: "absolute", top: -7, right: -7 }}
                  >
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        backgroundColor: "#FFFFFF",
                        alignItems: "center",
                        justifyContent: "center",
                        shadowColor: "#000",
                        shadowOpacity: 0.2,
                        shadowRadius: 3,
                        shadowOffset: { width: 0, height: 1 },
                      }}
                    >
                      <Ionicons name="close" size={14} color="#D1382E" />
                    </View>
                  </Pressable>
                </View>
              ))}
              <Pressable onPress={pickPhoto} accessibilityLabel="Add photo">
                <View
                  style={{
                    width: THUMB,
                    height: THUMB,
                    borderRadius: 12,
                    borderWidth: 1.5,
                    borderStyle: "dashed",
                    borderColor: "rgba(9,27,84,0.25)",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 3,
                  }}
                >
                  <Ionicons name="camera" size={22} color="#70788F" />
                  <Text className="text-muted" style={{ fontSize: 11, fontWeight: "600" }}>
                    Add
                  </Text>
                </View>
              </Pressable>
            </ScrollView>
          </View>

          <View
            className="flex-row items-center justify-between"
            style={{ borderTopWidth: 1, borderTopColor: "rgba(9,27,84,0.10)", paddingTop: 14 }}
          >
            <Pressable onPress={confirmDelete} hitSlop={8}>
              <Text style={{ color: "#D1382E", fontSize: 15, fontWeight: "700" }}>Delete pin</Text>
            </Pressable>
            <Pressable
              onPress={onClose}
              className="bg-olive"
              style={{ borderRadius: 999, paddingHorizontal: 22, paddingVertical: 9 }}
            >
              <Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "700" }}>Done</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
