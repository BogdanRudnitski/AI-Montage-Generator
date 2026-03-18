import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AnalyzeProvider } from "../context/AnalyzeContext";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AnalyzeProvider>
        <Stack
          screenOptions={{
            headerShown: false,
          }}
        />
      </AnalyzeProvider>
    </GestureHandlerRootView>
  );
}