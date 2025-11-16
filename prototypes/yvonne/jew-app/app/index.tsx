import { StatusBar } from 'expo-status-bar';
import VideoEditorScreen from '../screens/VideoEditorScreen';

export default function Index() {
  return (
    <>
      <VideoEditorScreen />
      <StatusBar style="light" />
    </>
  );
}