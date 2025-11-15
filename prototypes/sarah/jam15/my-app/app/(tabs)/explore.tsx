import React, { useState } from "react";
import { View, Text, Button, Image, ScrollView, Alert, ActivityIndicator, Linking } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Video, ResizeMode } from "expo-av";

export default function ExploreScreen() {
  const [mediaList, setMediaList] = useState<any[]>([]);
  const [song, setSong] = useState<{ uri: string; name: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const SERVER_URL = "http://10.121.222.165:8000"; // replace with your Mac's IP

  // Pick multiple images/videos
  async function pickMedia() {
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) {
      Alert.alert("Permission required", "Gallery permission is needed.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsMultipleSelection: true,
      selectionLimit: 0,
      quality: 1,
    });

    if (!result.canceled) {
      setMediaList(result.assets);
    }
  }

  // Pick one mandatory song
  async function pickSong() {
    try {
      const result = await DocumentPicker.getDocumentAsync({ 
        type: "audio/*",
        copyToCacheDirectory: true
      });
      
      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        setSong({
          uri: asset.uri,
          name: asset.name || "song.mp3",
        });
        Alert.alert("Success", `Selected: ${asset.name}`);
      } else {
        console.log("Song selection cancelled");
      }
    } catch (err) {
      console.error("Song picker error:", err);
      Alert.alert("Error", "Could not select song.");
    }
  }

  // Upload media and song
  async function uploadToBackend() {
    if (!song || !song.uri) {
      return Alert.alert("Song required", "Please select a song first.");
    }

    if (mediaList.length === 0) {
      return Alert.alert("No media", "Select some images or videos.");
    }

    const formData = new FormData();

    mediaList.forEach((item, index) => {
      formData.append("files", {
        uri: item.uri,
        name: item.filename || `file_${index}.${item.type === "video" ? "mp4" : "jpg"}`,
        type: item.type === "video" ? "video/mp4" : "image/jpeg",
      } as any);
    });

    formData.append("song", {
      uri: song.uri,
      name: song.name,
      type: "audio/mpeg",
    } as any);

    try {
      setLoading(true);

      const res = await fetch(`${SERVER_URL}/upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        return Alert.alert("Upload failed", "Backend returned an error.");
      }

      const data = await res.json();
      Alert.alert(
        "Upload complete!",
        `Saved ${data.files_saved.length} media files and song: ${data.song_saved}`
      );
      console.log("Upload result:", data);
    } catch (err) {
      console.error(err);
      Alert.alert("Upload failed", "Check network/backend connection.");
    } finally {
      setLoading(false);
    }
  }

  // View uploaded files (JSON alert)
  async function viewUploadedFiles() {
    try {
      setLoading(true);
      const res = await fetch(`${SERVER_URL}/list-files`);
      
      if (!res.ok) {
        return Alert.alert("Error", "Could not fetch files from server.");
      }
      
      const data = await res.json();
      console.log("Uploaded files:", data);
      
      const mediaList = data.media.map((f: any) => `${f.name} (${f.type})`).join('\n');
      const songList = data.songs.map((f: any) => f.name).join('\n');
      
      const message = `📸 MEDIA (${data.media.length}):\n${mediaList || 'None'}\n\n🎵 SONGS (${data.songs.length}):\n${songList || 'None'}\n\nTotal: ${data.total} files`;
      
      Alert.alert("Uploaded Files", message);
    } catch (err) {
      console.error(err);
      Alert.alert("Error", "Could not fetch files. Is the server running?");
    } finally {
      setLoading(false);
    }
  }

  // NEW: Open web viewer in browser
  async function openWebViewer() {
    const url = `${SERVER_URL}/viewer`;
    const supported = await Linking.canOpenURL(url);
    
    if (supported) {
      await Linking.openURL(url);
    } else {
      Alert.alert("Error", `Cannot open URL: ${url}`);
    }
  }

  return (
    <ScrollView style={{ flex: 1, paddingTop: 50 }} contentContainerStyle={{ alignItems: "center", paddingBottom: 60 }}>
      <Button title="Pick images/videos" onPress={pickMedia} />
      <View style={{ marginTop: 10 }} />
      <Button title="Pick a song (mandatory)" color="purple" onPress={pickSong} />

      {song && (
        <Text style={{ marginTop: 10, fontSize: 16 }}>Selected song: {song.name}</Text>
      )}

      <View style={{ marginTop: 10 }} />
      <Button title="Upload" onPress={uploadToBackend} />
      
      <View style={{ marginTop: 10 }} />
      <Button title="View Uploaded Files" color="green" onPress={viewUploadedFiles} />
      
      <View style={{ marginTop: 10 }} />
      <Button title="Open Web Viewer 🌐" color="blue" onPress={openWebViewer} />

      {loading && (
        <View style={{ marginTop: 20 }}>
          <ActivityIndicator size="large" color="#333" />
          <Text style={{ marginTop: 10, color: "#888" }}>Loading...</Text>
        </View>
      )}

      {mediaList.length > 0 && (
        <Text style={{ marginTop: 20, fontSize: 18 }}>Selected: {mediaList.length} items</Text>
      )}

      {mediaList.map((m, i) => (
        <View key={i} style={{ marginTop: 20, alignItems: "center" }}>
          <Text style={{ marginBottom: 10 }}>{m.type}</Text>
          {m.type === "image" && <Image source={{ uri: m.uri }} style={{ width: 250, height: 250, borderRadius: 8 }} />}
          {m.type === "video" && (
            <Video
              source={{ uri: m.uri }}
              useNativeControls
              resizeMode={ResizeMode.CONTAIN}
              style={{ width: 300, height: 300, borderRadius: 8 }}
            />
          )}
        </View>
      ))}
    </ScrollView>
  );
}