#!/bin/bash

# Script to add test videos to iOS Simulator or Android Emulator
# Usage: ./add-videos-to-simulator.sh [ios|android] [path/to/video1.mp4] [path/to/video2.mp4] ...

PLATFORM=$1
shift
VIDEOS=("$@")

if [ -z "$PLATFORM" ]; then
    echo "Usage: ./add-videos-to-simulator.sh [ios|android] [video1.mp4] [video2.mp4] ..."
    echo ""
    echo "Examples:"
    echo "  ./add-videos-to-simulator.sh ios ~/Downloads/test1.mp4 ~/Downloads/test2.mp4"
    echo "  ./add-videos-to-simulator.sh android ~/Videos/sample.mp4"
    exit 1
fi

if [ ${#VIDEOS[@]} -eq 0 ]; then
    echo "Error: No video files specified"
    exit 1
fi

if [ "$PLATFORM" = "ios" ]; then
    echo "Adding videos to iOS Simulator..."
    for video in "${VIDEOS[@]}"; do
        if [ -f "$video" ]; then
            echo "Adding: $video"
            xcrun simctl addmedia booted "$video"
        else
            echo "Warning: File not found: $video"
        fi
    done
    echo "Done! Open the Photos app in the simulator to verify."
    
elif [ "$PLATFORM" = "android" ]; then
    echo "Adding videos to Android Emulator..."
    # Check if adb is available
    if ! command -v adb &> /dev/null; then
        echo "Error: adb (Android Debug Bridge) not found"
        echo "Please install Android SDK Platform Tools"
        exit 1
    fi
    
    # Check if emulator is running
    if ! adb devices | grep -q "emulator"; then
        echo "Warning: No Android emulator detected. Make sure it's running."
    fi
    
    for video in "${VIDEOS[@]}"; do
        if [ -f "$video" ]; then
            echo "Adding: $video"
            adb push "$video" /sdcard/Movies/
        else
            echo "Warning: File not found: $video"
        fi
    done
    echo "Done! Videos are in /sdcard/Movies/ on the emulator."
    
else
    echo "Error: Platform must be 'ios' or 'android'"
    exit 1
fi

