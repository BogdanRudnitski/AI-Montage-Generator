#!/bin/bash

# Simple script to add videos to iOS Simulator
# Usage: ./add-videos-ios.sh video1.mp4 video2.mp4 ...

if [ $# -eq 0 ]; then
    echo "Usage: ./add-videos-ios.sh [video1.mp4] [video2.mp4] ..."
    echo ""
    echo "Example:"
    echo "  ./add-videos-ios.sh ~/Downloads/test1.mp4 ~/Downloads/test2.mp4"
    exit 1
fi

echo "Adding videos to iOS Simulator..."
echo "Make sure your simulator is running!"
echo ""

for video in "$@"; do
    if [ -f "$video" ]; then
        echo "Adding: $(basename "$video")"
        xcrun simctl addmedia booted "$video"
        if [ $? -eq 0 ]; then
            echo "  ✓ Successfully added"
        else
            echo "  ✗ Failed to add"
        fi
    else
        echo "  ✗ File not found: $video"
    fi
done

echo ""
echo "Done! Videos have been added to the simulator's media library."
echo "You can now use them in your app via the Import Video button."

