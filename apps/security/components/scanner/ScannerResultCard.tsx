import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";
import { isConfigReason, reasonTitle, type VerifyResponse } from "@/lib/api/scanner";
import type { ScannerPhase } from "@/lib/stores/scanner";

const OLIVE = "#B4B925";
const DENIED = "#D12E21";
const AMBER = "#E38736";

interface Props {
  phase: ScannerPhase;
  result?: VerifyResponse;
  errorMessage?: string;
  onScanAnother: () => void;
  onConfigure: () => void;
  onAddPhoto?: (entryLogId: string) => void;
}

function Btn({
  label,
  onPress,
  filled,
  tint = "#FFFFFF",
}: {
  label: string;
  onPress: () => void;
  filled?: boolean;
  tint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{
        height: 46,
        paddingHorizontal: 18,
        borderRadius: 999,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: filled ? 0 : 1,
        borderColor: "rgba(255,255,255,0.28)",
        backgroundColor: filled ? tint : "rgba(255,255,255,0.06)",
        flexGrow: 1,
      }}
    >
      <Text style={{ color: filled ? "#0B1020" : "#FFFFFF", fontSize: 15, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}

/** Verification result card — granted / denied / unable (dark-chrome scanner). */
export function ScannerResultCard({
  phase,
  result,
  errorMessage,
  onScanAnother,
  onConfigure,
  onAddPhoto,
}: Props) {
  if (phase !== "granted" && phase !== "denied" && phase !== "unable") return null;

  const accent = phase === "granted" ? OLIVE : phase === "denied" ? DENIED : AMBER;
  const icon =
    phase === "granted" ? "shield-checkmark" : phase === "denied" ? "close-circle" : "alert-circle";
  const heading =
    phase === "granted"
      ? "Access granted"
      : phase === "denied"
        ? reasonTitle(result?.reasonCode, result?.reason)
        : "Unable to verify";

  const vehicle = result?.vehicles?.[0];

  return (
    <View
      style={{
        borderRadius: 28,
        padding: 22,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.12)",
        backgroundColor: "rgba(18,20,26,0.92)",
        gap: 14,
      }}
    >
      <View className="flex-row items-center" style={{ gap: 12 }}>
        <View
          style={{
            width: 46,
            height: 46,
            borderRadius: 999,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: `${accent}22`,
          }}
        >
          <Ionicons name={icon} size={26} color={accent} />
        </View>
        <Text style={{ color: "#FFFFFF", fontSize: 20, fontWeight: "700", flex: 1 }}>{heading}</Text>
      </View>

      {phase === "granted" && result ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: "#FFFFFF", fontSize: 22, fontWeight: "700" }}>
            {result.tenantName ?? (result.entryType === "guest" ? "Guest" : "Resident")}
          </Text>
          {result.unitAddress ? (
            <Text style={{ color: "rgba(255,255,255,0.72)", fontSize: 15 }}>{result.unitAddress}</Text>
          ) : null}
          {result.entryType ? (
            <Text style={{ color: accent, fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 1 }}>
              {result.entryType} entry
            </Text>
          ) : null}
          {vehicle ? (
            <Text style={{ color: "rgba(255,255,255,0.72)", fontSize: 14, marginTop: 2 }}>
              {[vehicle.color, vehicle.make, vehicle.model].filter(Boolean).join(" ")} · {vehicle.plate}
            </Text>
          ) : null}
        </View>
      ) : null}

      {phase === "denied" && result?.reason ? (
        <Text style={{ color: "rgba(255,255,255,0.72)", fontSize: 15 }}>{result.reason}</Text>
      ) : null}

      {phase === "unable" ? (
        <Text style={{ color: "rgba(255,255,255,0.72)", fontSize: 15 }}>
          {errorMessage ?? "Could not reach the server. Check the connection and try again."}
        </Text>
      ) : null}

      <View className="flex-row" style={{ gap: 10, marginTop: 4 }}>
        {phase === "granted" && result?.entryLogId && onAddPhoto ? (
          <Btn label="Add Photo" onPress={() => onAddPhoto(result.entryLogId!)} />
        ) : null}
        {(phase === "denied" && isConfigReason(result?.reasonCode)) || phase === "unable" ? (
          <Btn label="Scanner Settings" onPress={onConfigure} />
        ) : null}
        <Btn
          label={phase === "unable" ? "Try Again" : "Scan Another"}
          onPress={onScanAnother}
          filled
          tint={accent}
        />
      </View>
    </View>
  );
}
