// VideoEditorScreen.tsx
// Complete Mobile Video Editor with ALL features from web version

import Slider from '@react-native-community/slider';
import React, { useState } from 'react';
import {
  Alert,
  Dimensions,
  Modal,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const PIXELS_PER_SECOND = 60;
const TRACK_HEIGHT = 90;
const NUM_TRACKS = 2;

const Icons = {
  play: '▶',
  pause: '⏸',
  scissors: '✂',
  trash: '🗑',
  undo: '↶',
  plus: '+',
  music: '♪',
  sparkles: '✨',
  text: 'T',
  filter: '🎨',
  volume: '🔊',
  zoom: '🔍',
  layers: '⊞',
};

const initialClips = [
  { 
    id: 1, start: 0, duration: 3, videoId: 'video1', name: 'Clip 1', color: '#3b82f6', 
    transition: 'none', speed: 1, volume: 100, filter: 'none',
    zoom: 1, panX: 0, panY: 0, track: 0, texts: []
  },
  { 
    id: 2, start: 3, duration: 2, videoId: 'video2', name: 'Clip 2', color: '#8b5cf6', 
    transition: 'fade', speed: 1, volume: 100, filter: 'none',
    zoom: 1, panX: 0, panY: 0, track: 0, texts: []
  },
  { 
    id: 3, start: 5, duration: 2.5, videoId: 'video1', name: 'Clip 3', color: '#3b82f6', 
    transition: 'dissolve', speed: 1, volume: 80, filter: 'bw',
    zoom: 1.5, panX: 0, panY: 0, track: 0,
    texts: [{ id: 't1', text: 'Hello!', x: 50, y: 50, size: 24, color: '#ffffff' }]
  },
  { 
    id: 4, start: 7.5, duration: 1.5, videoId: 'video3', name: 'Clip 4', color: '#ec4899', 
    transition: 'slide', speed: 0.5, volume: 100, filter: 'sepia',
    zoom: 1, panX: 0, panY: 0, track: 0, texts: []
  },
  {
    id: 5, start: 2, duration: 2, videoId: 'video4', name: 'Overlay', color: '#10b981',
    transition: 'none', speed: 1, volume: 50, filter: 'none',
    zoom: 0.5, panX: 60, panY: 60, track: 1, texts: []
  }
];

const TRANSITIONS = [
  { value: 'none', label: 'None', icon: '—' },
  { value: 'fade', label: 'Fade', icon: '◐' },
  { value: 'dissolve', label: 'Dissolve', icon: '⊙' },
  { value: 'slide', label: 'Slide', icon: '→' },
  { value: 'wipe', label: 'Wipe', icon: '▶' },
  { value: 'zoom', label: 'Zoom', icon: '⊕' },
];

const FILTERS = [
  { value: 'none', label: 'None' },
  { value: 'bw', label: 'B&W' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'vintage', label: 'Vintage' },
  { value: 'vivid', label: 'Vivid' },
  { value: 'cool', label: 'Cool' },
  { value: 'warm', label: 'Warm' },
];

const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4];

const beatMarkers = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9];

export default function VideoEditorScreen() {
  const [clips, setClips] = useState(initialClips);
  const [selectedClip, setSelectedClip] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [showProperties, setShowProperties] = useState(false);
  const [activeTab, setActiveTab] = useState('basic');
  const [history, setHistory] = useState([initialClips]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [snapToBeats, setSnapToBeats] = useState(true);
  const [cuttingMode, setCuttingMode] = useState(false);
  const [draggedClip, setDraggedClip] = useState<typeof initialClips[0] | null>(null);
  const [resizingClip, setResizingClip] = useState<number | null>(null);
  const [resizeEdge, setResizeEdge] = useState<'left' | 'right' | null>(null);

  const totalDuration = Math.max(...clips.map(c => c.start + c.duration), 10);

  const saveToHistory = (newClips: typeof initialClips) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newClips);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    setClips(newClips);
  };

  const undo = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setClips(history[newIndex]);
      setSelectedClip(null);
    }
  };

  const snapToNearestBeat = (time: number) => {
    if (!snapToBeats) return time;
    const nearest = beatMarkers.reduce((prev, curr) => 
      Math.abs(curr - time) < Math.abs(prev - time) ? curr : prev
    );
    return Math.abs(nearest - time) < 0.2 ? nearest : time;
  };

  const deleteClip = (clipId: number) => {
    Alert.alert('Delete Clip', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { 
        text: 'Delete', 
        style: 'destructive',
        onPress: () => {
          const newClips = clips.filter(c => c.id !== clipId);
          saveToHistory(newClips);
          setSelectedClip(null);
          setShowProperties(false);
        }
      }
    ]);
  };

  const splitClip = (clipId: number) => {
    const clip = clips.find(c => c.id === clipId);
    if (!clip) return;
    
    const cutPoint = clip.duration / 2;
    const newClips = clips.filter(c => c.id !== clipId);
    
    newClips.push(
      { ...clip, id: Date.now(), duration: cutPoint },
      { 
        ...clip, 
        id: Date.now() + 1, 
        start: clip.start + cutPoint, 
        duration: clip.duration - cutPoint,
        name: clip.name + ' (split)'
      }
    );
    
    saveToHistory(newClips);
    setSelectedClip(null);
  };

  const enterCuttingMode = () => {
    if (!selectedClip) {
      Alert.alert('Select Clip', 'Please select a clip first');
      return;
    }
    setCuttingMode(true);
    setShowProperties(false);
  };

  const executeCut = (clip: typeof initialClips[0], position: number) => {
    const cutPoint = position;
    const newClips = clips.filter(c => c.id !== clip.id);
    
    newClips.push(
      { ...clip, id: Date.now(), duration: cutPoint },
      { 
        ...clip, 
        id: Date.now() + 1, 
        start: clip.start + cutPoint, 
        duration: clip.duration - cutPoint,
        name: clip.name + ' (cut)'
      }
    );
    
    saveToHistory(newClips);
    setSelectedClip(null);
    setCuttingMode(false);
  };

  const updateClipProperty = (clipId: number, property: string, value: any) => {
    const newClips = clips.map(c => 
      c.id === clipId ? { ...c, [property]: value } : c
    );
    saveToHistory(newClips);
  };

  const addTextToClip = (clipId: number) => {
    const newClips = clips.map(c => {
      if (c.id === clipId) {
        return {
          ...c,
          texts: [...c.texts, {
            id: `t${Date.now()}`,
            text: 'New Text',
            x: 50,
            y: 50,
            size: 24,
            color: '#ffffff'
          }]
        };
      }
      return c;
    });
    saveToHistory(newClips);
  };

  const updateClipText = (clipId: number, textId: number | string, property: string, value: any) => {
    const newClips = clips.map(c => {
      if (c.id === clipId) {
        return {
          ...c,
          texts: c.texts.map(t => 
            t.id === textId ? { ...t, [property]: value } : t
          )
        };
      }
      return c;
    });
    saveToHistory(newClips);
  };

  const deleteClipText = (clipId: number, textId: number | string) => {
    const newClips = clips.map(c => {
      if (c.id === clipId) {
        return { ...c, texts: c.texts.filter(t => t.id !== textId) };
      }
      return c;
    });
    saveToHistory(newClips);
  };

  const autoArrangeToBeats = () => {
    let currentBeatIndex = 0;
    const arranged = clips.map((clip) => {
      const start = beatMarkers[currentBeatIndex] || currentBeatIndex * 0.5;
      const beatsNeeded = Math.ceil(clip.duration / 0.5);
      currentBeatIndex += beatsNeeded;
      return { ...clip, start };
    });
    saveToHistory(arranged);
  };

  const selectedClipData = clips.find(c => c.id === selectedClip);

  // Create draggable clips with pan responder
  const createClipPanResponder = (clip: typeof initialClips[0]) => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt, gestureState) => {
        const { locationX } = evt.nativeEvent;
        const clipWidth = clip.duration * PIXELS_PER_SECOND;
        
        // Check if touching edges (for resize)
        if (locationX < 15) {
          setResizingClip(clip.id);
          setResizeEdge('left');
        } else if (locationX > clipWidth - 15) {
          setResizingClip(clip.id);
          setResizeEdge('right');
        } else {
          setDraggedClip(clip);
        }
        setSelectedClip(clip.id);
      },
      onPanResponderMove: (evt, gestureState) => {
        if (resizingClip) {
          // Handle resize
          const deltaTime = gestureState.dx / PIXELS_PER_SECOND;
          const newClips = clips.map(c => {
            if (c.id !== resizingClip) return c;
            
            if (resizeEdge === 'left') {
              let newStart = clip.start + deltaTime;
              newStart = Math.max(0, newStart);
              if (snapToBeats) newStart = snapToNearestBeat(newStart);
              const newDuration = clip.duration - (newStart - clip.start);
              if (newDuration < 0.1) return c;
              return { ...c, start: newStart, duration: newDuration };
            } else {
              let newDuration = clip.duration + deltaTime;
              if (snapToBeats) {
                const endTime = clip.start + newDuration;
                const snappedEnd = snapToNearestBeat(endTime);
                newDuration = snappedEnd - clip.start;
              }
              if (newDuration < 0.1) return c;
              return { ...c, duration: newDuration };
            }
          });
          setClips(newClips);
        } else if (draggedClip) {
          // Handle drag
          const deltaTime = gestureState.dx / PIXELS_PER_SECOND;
          let newStart = clip.start + deltaTime;
          newStart = Math.max(0, newStart);
          if (snapToBeats) newStart = snapToNearestBeat(newStart);
          
          const newClips = clips.map(c => 
            c.id === clip.id ? { ...c, start: newStart } : c
          );
          setClips(newClips);
        }
      },
      onPanResponderRelease: () => {
        if (draggedClip || resizingClip) {
          saveToHistory([...clips]);
        }
        setDraggedClip(null);
        setResizingClip(null);
        setResizeEdge(null);
      },
    });
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Video Editor</Text>
        <View style={styles.headerButtons}>
          <TouchableOpacity style={[styles.headerButton, styles.buttonBlue]}>
            <Text style={styles.buttonText}>{Icons.plus} Import</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.headerButton, styles.buttonPurple]}>
            <Text style={styles.buttonText}>{Icons.music} Music</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Video Preview */}
      <View style={styles.previewContainer}>
        <View style={styles.previewBox}>
          <Text style={styles.previewIcon}>🎬</Text>
          <Text style={styles.previewText}>Video Preview</Text>
          <Text style={styles.previewTime}>
            {currentTime.toFixed(1)}s / {totalDuration.toFixed(1)}s
          </Text>
        </View>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity 
          style={styles.playButton}
          onPress={() => setIsPlaying(!isPlaying)}
        >
          <Text style={styles.playButtonText}>
            {isPlaying ? Icons.pause : Icons.play}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.controlButton, historyIndex === 0 && styles.buttonDisabled]}
          onPress={undo}
          disabled={historyIndex === 0}
        >
          <Text style={styles.controlButtonText}>{Icons.undo} Undo</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.controlButton, styles.buttonGreen]} onPress={autoArrangeToBeats}>
          <Text style={styles.controlButtonText}>Auto-Arrange</Text>
        </TouchableOpacity>
      </View>

      {cuttingMode && (
        <View style={styles.cuttingBanner}>
          <Text style={styles.cuttingText}>✂️ Tap on clip where you want to cut it</Text>
          <TouchableOpacity 
            onPress={() => setCuttingMode(false)}
            style={styles.cancelButton}
          >
            <Text style={styles.buttonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Timeline */}
      <View style={styles.timelineContainer}>
        <View style={styles.timelineHeader}>
          <Text style={styles.timelineLabel}>
            {cuttingMode ? '✂️ Cutting Mode' : 'Timeline - Drag clips to move, drag edges to trim'}
          </Text>
          <TouchableOpacity 
            onPress={() => setSnapToBeats(!snapToBeats)}
            style={styles.snapButton}
          >
            <Text style={[styles.snapButtonText, snapToBeats && styles.snapButtonActive]}>
              {snapToBeats ? '🧲 Snap ON' : 'Snap OFF'}
            </Text>
          </TouchableOpacity>
        </View>
        
        <ScrollView horizontal showsHorizontalScrollIndicator={true} style={styles.timelineScroll}>
          <View style={{ width: Math.max(totalDuration * PIXELS_PER_SECOND, SCREEN_WIDTH) }}>
            {/* Time ruler */}
            <View style={styles.timeRuler}>
              {Array.from({ length: Math.ceil(totalDuration) + 1 }, (_, i) => (
                <Text key={i} style={[styles.timeMarker, { left: i * PIXELS_PER_SECOND }]}>
                  {i}s
                </Text>
              ))}
            </View>

            {/* Beat markers */}
            <View style={styles.beatTrack}>
              {beatMarkers.map((beat, idx) => (
                <View
                  key={idx}
                  style={[styles.beatMarker, { left: beat * PIXELS_PER_SECOND }]}
                />
              ))}
              <Text style={styles.beatLabel}>Beat Markers</Text>
            </View>

            {/* Tracks */}
            {Array.from({ length: NUM_TRACKS }, (_, trackIndex) => (
              <View key={trackIndex} style={styles.track}>
                <Text style={styles.trackLabel}>Track {trackIndex + 1}</Text>
                
                {clips.filter(c => c.track === trackIndex).map(clip => {
                  const panResponder = createClipPanResponder(clip);
                  
                  return (
                    <View
                      key={clip.id}
                      {...panResponder.panHandlers}
                      style={[
                        styles.clip,
                        {
                          left: clip.start * PIXELS_PER_SECOND,
                          width: clip.duration * PIXELS_PER_SECOND,
                          backgroundColor: clip.color,
                        },
                        selectedClip === clip.id && styles.clipSelected
                      ]}
                    >
                      {/* Left resize handle */}
                      <View style={[styles.resizeHandle, styles.resizeHandleLeft]} />
                      
                      {/* Clip content */}
                      <TouchableOpacity
                        style={styles.clipContent}
                        onPress={() => {
                          if (cuttingMode && selectedClip === clip.id) {
                            // Cut at middle of clip
                            executeCut(clip, clip.duration / 2);
                          } else {
                            setSelectedClip(clip.id);
                            setShowProperties(true);
                          }
                        }}
                      >
                        <Text style={styles.clipName} numberOfLines={1}>{clip.name}</Text>
                        <View style={styles.clipBadges}>
                          <Text style={styles.clipDuration}>{clip.duration.toFixed(1)}s</Text>
                          {clip.speed !== 1 && (
                            <View style={styles.badge}>
                              <Text style={styles.badgeText}>{clip.speed}x</Text>
                            </View>
                          )}
                          {clip.filter !== 'none' && <Text style={styles.badgeText}>{Icons.filter}</Text>}
                          {clip.texts.length > 0 && <Text style={styles.badgeText}>{Icons.text}</Text>}
                          {clip.zoom !== 1 && <Text style={styles.badgeText}>{Icons.zoom}</Text>}
                        </View>
                      </TouchableOpacity>

                      {/* Right resize handle */}
                      <View style={[styles.resizeHandle, styles.resizeHandleRight]} />

                      {/* Transition indicator */}
                      {clip.transition !== 'none' && (
                        <View style={styles.transitionIndicator}>
                          <Text style={styles.transitionIcon}>{Icons.sparkles}</Text>
                        </View>
                      )}
                    </View>
                  );
                })}

                {/* Playhead */}
                {trackIndex === 0 && (
                  <View style={[styles.playhead, { left: currentTime * PIXELS_PER_SECOND }]} />
                )}
              </View>
            ))}
          </View>
        </ScrollView>
      </View>

      {/* Properties Modal */}
      <Modal
        visible={showProperties && selectedClipData !== undefined}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowProperties(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Clip Properties</Text>
              <TouchableOpacity onPress={() => setShowProperties(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Tabs */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs}>
              {[
                { id: 'basic', label: 'Basic', icon: Icons.layers },
                { id: 'speed', label: 'Speed', icon: Icons.play },
                { id: 'effects', label: 'Effects', icon: Icons.filter },
                { id: 'audio', label: 'Audio', icon: Icons.volume },
                { id: 'text', label: 'Text', icon: Icons.text },
              ].map(tab => (
                <TouchableOpacity
                  key={tab.id}
                  style={[styles.tab, activeTab === tab.id && styles.tabActive]}
                  onPress={() => setActiveTab(tab.id)}
                >
                  <Text style={styles.tabIcon}>{tab.icon}</Text>
                  <Text style={[styles.tabText, activeTab === tab.id && styles.tabTextActive]}>
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <ScrollView style={styles.tabContent}>
              {activeTab === 'basic' && selectedClipData && (
                <View>
                  <Text style={styles.sectionTitle}>Transition</Text>
                  <View style={styles.grid}>
                    {TRANSITIONS.map(t => (
                      <TouchableOpacity
                        key={t.value}
                        style={[
                          styles.gridButton,
                          selectedClipData.transition === t.value && styles.gridButtonActive
                        ]}
                        onPress={() => updateClipProperty(selectedClipData.id, 'transition', t.value)}
                      >
                        <Text style={styles.gridButtonIcon}>{t.icon}</Text>
                        <Text style={styles.gridButtonText}>{t.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <View style={styles.actionRow}>
                    <TouchableOpacity 
                      style={[styles.actionButton, styles.buttonOrange]}
                      onPress={enterCuttingMode}
                    >
                      <Text style={styles.buttonText}>{Icons.scissors} Cut Mode</Text>
                    </TouchableOpacity>
                    
                    <TouchableOpacity 
                      style={[styles.actionButton, styles.buttonYellow]}
                      onPress={() => splitClip(selectedClipData.id)}
                    >
                      <Text style={styles.buttonText}>Split in Half</Text>
                    </TouchableOpacity>
                  </View>

                  <TouchableOpacity 
                    style={[styles.actionButton, styles.buttonRed, { marginTop: 10 }]}
                    onPress={() => deleteClip(selectedClipData.id)}
                  >
                    <Text style={styles.buttonText}>{Icons.trash} Delete Clip</Text>
                  </TouchableOpacity>
                </View>
              )}

              {activeTab === 'speed' && selectedClipData && (
                <View>
                  <Text style={styles.sectionTitle}>Speed: {selectedClipData.speed}x</Text>
                  <View style={styles.grid}>
                    {SPEED_PRESETS.map(s => (
                      <TouchableOpacity
                        key={s}
                        style={[
                          styles.gridButton,
                          selectedClipData.speed === s && styles.gridButtonActive
                        ]}
                        onPress={() => updateClipProperty(selectedClipData.id, 'speed', s)}
                      >
                        <Text style={styles.gridButtonText}>{s}x</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={styles.helpText}>
                    Slow motion: 0.25x - 0.5x{'\n'}
                    Fast forward: 1.5x - 4x
                  </Text>
                </View>
              )}

              {activeTab === 'effects' && selectedClipData && (
                <View>
                  <Text style={styles.sectionTitle}>Filter</Text>
                  <View style={styles.grid}>
                    {FILTERS.map(f => (
                      <TouchableOpacity
                        key={f.value}
                        style={[
                          styles.gridButton,
                          selectedClipData.filter === f.value && styles.gridButtonActive
                        ]}
                        onPress={() => updateClipProperty(selectedClipData.id, 'filter', f.value)}
                      >
                        <Text style={styles.gridButtonText}>{f.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <Text style={styles.sectionTitle}>Zoom: {selectedClipData.zoom.toFixed(1)}x</Text>
                  <Slider
                    style={styles.slider}
                    minimumValue={0.5}
                    maximumValue={3}
                    step={0.1}
                    value={selectedClipData.zoom}
                    onValueChange={(val) => updateClipProperty(selectedClipData.id, 'zoom', val)}
                    minimumTrackTintColor="#3b82f6"
                    maximumTrackTintColor="#444"
                    thumbTintColor="#3b82f6"
                  />

                  <Text style={styles.sectionTitle}>Pan X: {selectedClipData.panX}%</Text>
                  <Slider
                    style={styles.slider}
                    minimumValue={-100}
                    maximumValue={100}
                    step={1}
                    value={selectedClipData.panX}
                    onValueChange={(val) => updateClipProperty(selectedClipData.id, 'panX', val)}
                    minimumTrackTintColor="#3b82f6"
                    maximumTrackTintColor="#444"
                    thumbTintColor="#3b82f6"
                  />

                  <Text style={styles.sectionTitle}>Pan Y: {selectedClipData.panY}%</Text>
                  <Slider
                    style={styles.slider}
                    minimumValue={-100}
                    maximumValue={100}
                    step={1}
                    value={selectedClipData.panY}
                    onValueChange={(val) => updateClipProperty(selectedClipData.id, 'panY', val)}
                    minimumTrackTintColor="#3b82f6"
                    maximumTrackTintColor="#444"
                    thumbTintColor="#3b82f6"
                  />
                </View>
              )}

              {activeTab === 'audio' && selectedClipData && (
                <View>
                  <Text style={styles.sectionTitle}>Volume: {selectedClipData.volume}%</Text>
                  <Slider
                    style={styles.slider}
                    minimumValue={0}
                    maximumValue={100}
                    step={1}
                    value={selectedClipData.volume}
                    onValueChange={(val) => updateClipProperty(selectedClipData.id, 'volume', val)}
                    minimumTrackTintColor="#3b82f6"
                    maximumTrackTintColor="#444"
                    thumbTintColor="#3b82f6"
                  />
                  
                  <View style={styles.actionRow}>
                    <TouchableOpacity 
                      style={styles.actionButton}
                      onPress={() => updateClipProperty(selectedClipData.id, 'volume', 0)}
                    >
                      <Text style={styles.buttonText}>Mute</Text>
                    </TouchableOpacity>
                    <TouchableOpacity 
                      style={styles.actionButton}
                      onPress={() => updateClipProperty(selectedClipData.id, 'volume', 100)}
                    >
                      <Text style={styles.buttonText}>Max</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {activeTab === 'text' && selectedClipData && (
                <View>
                  <TouchableOpacity 
                    style={[styles.actionButton, styles.buttonGreen, { marginBottom: 15 }]}
                    onPress={() => addTextToClip(selectedClipData.id)}
                  >
                    <Text style={styles.buttonText}>{Icons.plus} Add Text Overlay</Text>
                  </TouchableOpacity>

                  {selectedClipData.texts.length === 0 && (
                    <Text style={styles.emptyText}>No text overlays yet</Text>
                  )}

                  {selectedClipData.texts.map(text => (
                    <View key={text.id} style={styles.textItem}>
                      <View style={styles.textItemHeader}>
                        <Text style={styles.textItemTitle}>Text Overlay</Text>
                        <TouchableOpacity onPress={() => deleteClipText(selectedClipData.id, text.id)}>
                          <Text style={styles.textItemDelete}>{Icons.trash}</Text>
                        </TouchableOpacity>
                      </View>
                      
                      <TextInput
                        style={styles.textInput}
                        value={text.text}
                        onChangeText={(val) => updateClipText(selectedClipData.id, text.id, 'text', val)}
                        placeholder="Enter text"
                      />
                      
                      <Text style={styles.sectionTitle}>Size: {text.size}</Text>
                      <Slider
                        style={styles.slider}
                        minimumValue={12}
                        maximumValue={72}
                        step={2}
                        value={text.size}
                        onValueChange={(val) => updateClipText(selectedClipData.id, text.id, 'size', val)}
                        minimumTrackTintColor="#3b82f6"
                        maximumTrackTintColor="#444"
                        thumbTintColor="#3b82f6"
                      />
                      
                      <Text style={styles.sectionTitle}>Position X: {text.x}%</Text>
                      <Slider
                        style={styles.slider}
                        minimumValue={0}
                        maximumValue={100}
                        step={1}
                        value={text.x}
                        onValueChange={(val) => updateClipText(selectedClipData.id, text.id, 'x', val)}
                        minimumTrackTintColor="#3b82f6"
                        maximumTrackTintColor="#444"
                        thumbTintColor="#3b82f6"
                      />
                      
                      <Text style={styles.sectionTitle}>Position Y: {text.y}%</Text>
                      <Slider
                        style={styles.slider}
                        minimumValue={0}
                        maximumValue={100}
                        step={1}
                        value={text.y}
                        onValueChange={(val) => updateClipText(selectedClipData.id, text.id, 'y', val)}
                        minimumTrackTintColor="#3b82f6"
                        maximumTrackTintColor="#444"
                        thumbTintColor="#3b82f6"
                      />
                    </View>
                  ))}
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a1a' },
  header: { backgroundColor: '#2a2a2a', padding: 15, paddingTop: 50, borderBottomWidth: 1, borderBottomColor: '#444' },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: 'bold', marginBottom: 10 },
  headerButtons: { flexDirection: 'row', gap: 10 },
  headerButton: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  buttonBlue: { backgroundColor: '#3b82f6' },
  buttonPurple: { backgroundColor: '#8b5cf6' },
  buttonGreen: { backgroundColor: '#10b981' },
  buttonRed: { backgroundColor: '#ef4444' },
  buttonOrange: { backgroundColor: '#f97316' },
  buttonYellow: { backgroundColor: '#eab308' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  buttonDisabled: { backgroundColor: '#444', opacity: 0.5 },
  previewContainer: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  previewBox: { alignItems: 'center' },
  previewIcon: { fontSize: 64, marginBottom: 15 },
  previewText: { color: '#999', fontSize: 16 },
  previewTime: { color: '#666', fontSize: 12, marginTop: 5 },
  controls: { flexDirection: 'row', padding: 15, backgroundColor: '#2a2a2a', gap: 10 },
  playButton: { width: 50, height: 50, borderRadius: 25, backgroundColor: '#3b82f6', justifyContent: 'center', alignItems: 'center' },
  playButtonText: { fontSize: 24, color: '#fff' },
  controlButton: { flex: 1, paddingVertical: 12, backgroundColor: '#f97316', borderRadius: 8, alignItems: 'center' },
  controlButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  cuttingBanner: { backgroundColor: '#f97316', padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cuttingText: { color: '#fff', fontWeight: '600' },
  cancelButton: { paddingHorizontal: 15, paddingVertical: 5, backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 5 },
  timelineContainer: { backgroundColor: '#252525', paddingVertical: 10, maxHeight: SCREEN_HEIGHT * 0.35 },
  timelineHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 15, marginBottom: 10 },
  timelineLabel: { color: '#999', fontSize: 12, flex: 1 },
  snapButton: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#444', borderRadius: 6 },
  snapButtonText: { color: '#999', fontSize: 11 },
  snapButtonActive: { color: '#3b82f6', fontWeight: '600' },
  timelineScroll: { flex: 1 },
  timeRuler: { height: 25, position: 'relative', marginBottom: 5 },
  timeMarker: { position: 'absolute', fontSize: 10, color: '#666' },
  beatTrack: { height: 20, position: 'relative', marginBottom: 5, marginHorizontal: 10 },
  beatMarker: { position: 'absolute', width: 1, height: 15, backgroundColor: '#8b5cf6', top: 0 },
  beatLabel: { position: 'absolute', top: 0, left: 5, fontSize: 8, color: '#666' },
  track: { height: TRACK_HEIGHT, backgroundColor: '#333', marginBottom: 5, marginHorizontal: 10, borderRadius: 8, position: 'relative' },
  trackLabel: { position: 'absolute', top: 5, left: 8, fontSize: 10, color: '#666', zIndex: 1 },
  clip: { position: 'absolute', top: 8, height: TRACK_HEIGHT - 16, borderRadius: 6, flexDirection: 'row', alignItems: 'center' },
  clipSelected: { borderWidth: 2, borderColor: '#fff' },
  clipContent: { flex: 1, padding: 8, justifyContent: 'space-between', height: '100%' },
  clipName: { color: '#fff', fontSize: 11, fontWeight: '600' },
  clipBadges: { flexDirection: 'row', gap: 4, marginTop: 4 },
  clipDuration: { color: '#fff', fontSize: 10, opacity: 0.8 },
  badge: { backgroundColor: 'rgba(0,0,0,0.3)', paddingHorizontal: 4, paddingVertical: 2, borderRadius: 3 },
  badgeText: { color: '#fff', fontSize: 9 },
  resizeHandle: { width: 8, height: '100%', backgroundColor: 'rgba(255,255,255,0.5)', position: 'absolute', top: 0 },
  resizeHandleLeft: { left: 0, borderTopLeftRadius: 6, borderBottomLeftRadius: 6 },
  resizeHandleRight: { right: 0, borderTopRightRadius: 6, borderBottomRightRadius: 6 },
  transitionIndicator: { position: 'absolute', top: -8, right: 5, backgroundColor: '#8b5cf6', borderRadius: 10, width: 20, height: 20, justifyContent: 'center', alignItems: 'center' },
  transitionIcon: { fontSize: 10, color: '#fff' },
  playhead: { position: 'absolute', width: 2, height: TRACK_HEIGHT, backgroundColor: '#ef4444', top: 0, zIndex: 10 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#2a2a2a', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: SCREEN_HEIGHT * 0.75, paddingBottom: 30 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#444' },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  modalClose: { color: '#999', fontSize: 24 },
  tabs: { borderBottomWidth: 1, borderBottomColor: '#444', paddingHorizontal: 10, paddingVertical: 5 },
  tab: { paddingVertical: 12, paddingHorizontal: 15, alignItems: 'center', marginRight: 10, borderRadius: 8 },
  tabActive: { backgroundColor: '#3b82f6' },
  tabIcon: { fontSize: 16, marginBottom: 4 },
  tabText: { color: '#999', fontSize: 11 },
  tabTextActive: { color: '#fff', fontWeight: '600' },
  tabContent: { padding: 20 },
  sectionTitle: { color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 10, marginTop: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 15 },
  gridButton: { flex: 1, minWidth: '30%', paddingVertical: 12, backgroundColor: '#444', borderRadius: 8, alignItems: 'center' },
  gridButtonActive: { backgroundColor: '#3b82f6' },
  gridButtonIcon: { fontSize: 18, marginBottom: 4 },
  gridButtonText: { color: '#fff', fontSize: 13 },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: 15 },
  actionButton: { flex: 1, paddingVertical: 12, backgroundColor: '#444', borderRadius: 8, alignItems: 'center' },
  helpText: { color: '#999', fontSize: 11, marginTop: 10, textAlign: 'center' },
  slider: { width: '100%', height: 40 },
  emptyText: { color: '#999', fontSize: 12, textAlign: 'center', marginTop: 20 },
  textItem: { backgroundColor: '#333', padding: 15, borderRadius: 8, marginBottom: 15 },
  textItemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  textItemTitle: { color: '#fff', fontSize: 14, fontWeight: '600' },
  textItemDelete: { color: '#ef4444', fontSize: 18 },
  textInput: { backgroundColor: '#444', color: '#fff', padding: 12, borderRadius: 8, fontSize: 16, marginBottom: 15 },
});