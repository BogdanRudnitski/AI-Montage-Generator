# Adding Test Videos to Simulators

## iOS Simulator

### Method 1: Using Command Line (Recommended - No Photos app needed!)
```bash
# Add a single video
xcrun simctl addmedia booted /path/to/your/video.mp4

# Add multiple videos
xcrun simctl addmedia booted video1.mp4 video2.mp4 video3.mp4

# Or use the helper script
./scripts/add-videos-ios.sh ~/Downloads/test1.mp4 ~/Downloads/test2.mp4
```

This directly adds videos to the simulator's media library - no Photos app needed!

### Method 2: Drag and Drop (If Photos app is available)
1. Open the iOS Simulator
2. Open the **Photos** app in the simulator
3. Drag video files from your computer directly into the Photos app
4. The videos will be added to the simulator's photo library
5. Your app should now be able to access them via `expo-media-library`

### Method 3: Using Safari
1. Open Safari in the iOS Simulator
2. Download a test video from the internet (or use a local file)
3. The video will be saved to Photos automatically

## Android Emulator

### Method 1: Drag and Drop
1. Open the Android Emulator
2. Drag video files directly onto the emulator screen
3. The files will be saved to Downloads
4. You may need to move them to the Gallery/Photos app manually

### Method 2: Using ADB (Android Debug Bridge)
```bash
# Push video to emulator
adb push /path/to/your/video.mp4 /sdcard/Movies/

# Or to Downloads
adb push /path/to/your/video.mp4 /sdcard/Download/
```

## Quick Test Videos

You can use any MP4 videos you have. Here are some options:
- Videos from your Downloads folder
- Videos from your Photos library (export them first)
- Sample videos from video editing software
- Videos from your phone (transfer them to your computer first)

## Testing Your App

After adding videos:
1. Make sure your app has media library permissions
2. Tap "Import Video" in your app
3. The videos should appear in the import modal
4. Select a video to add it to the timeline

