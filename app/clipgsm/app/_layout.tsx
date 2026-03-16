import { Stack } from "expo-router";
import { AnalyzeProvider } from "../context/AnalyzeContext";

export default function RootLayout() {
  return (
    <AnalyzeProvider>
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      />
    </AnalyzeProvider>
  );
}