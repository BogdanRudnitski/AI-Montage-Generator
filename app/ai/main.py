#!/usr/bin/env python3
"""
Main entry point for AI video montage pipeline.
Runs analyze.py first, then clip_maker.py after successful analysis.
Reads configuration from uploads/options.json
"""
import os
import sys
import subprocess
import json

# Get the directory where this script is located
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)  # Parent directory

# Paths
ANALYZE_SCRIPT = os.path.join(SCRIPT_DIR, "analyze.py")
CLIP_MAKER_SCRIPT = os.path.join(SCRIPT_DIR, "clip_maker.py")
OPTIONS_FILE = os.path.join(PROJECT_ROOT, "backend", "uploads", "options.json")

def load_options():
    """Load configuration from options.json"""
    # Default options
    default_options = {
        "max_duration": 60,
        "density": "medium",
        "aggressiveness": 0.7
    }
    
    if not os.path.exists(OPTIONS_FILE):
        print(f"⚠️  Options file not found at {OPTIONS_FILE}")
        print(f"   Using defaults: max_duration={default_options['max_duration']}s\n")
        return default_options
    
    try:
        with open(OPTIONS_FILE, 'r') as f:
            options = json.load(f)
        
        # Merge with defaults (in case some keys are missing)
        merged = default_options.copy()
        merged.update(options)
        
        print(f"✅ Loaded options from {OPTIONS_FILE}")
        print(f"   max_duration: {merged['max_duration']}s")
        print(f"   density: {merged['density']}")
        print(f"   aggressiveness: {merged['aggressiveness']}\n")
        
        return merged
    except Exception as e:
        print(f"❌ Error loading options: {e}")
        print(f"   Using defaults: max_duration={default_options['max_duration']}s\n")
        return default_options

def run_analyze(max_duration):
    """Run the audio analysis script with max_duration parameter"""
    print("="*60)
    print("🎵 STEP 1: Running audio analysis...")
    print(f"   Max duration: {max_duration}s")
    print("="*60 + "\n")
    
    try:
        # Pass max_duration as environment variable
        env = os.environ.copy()
        env['MAX_DURATION'] = str(max_duration)
        
        result = subprocess.run(
            [sys.executable, ANALYZE_SCRIPT],
            cwd=SCRIPT_DIR,
            env=env,
            check=True
        )
        print("\n" + "="*60)
        print("✅ Audio analysis completed successfully!")
        print("="*60 + "\n")
        return True
    except subprocess.CalledProcessError as e:
        print("\n" + "="*60)
        print(f"❌ Audio analysis failed with exit code {e.returncode}")
        print("="*60 + "\n")
        return False
    except Exception as e:
        print("\n" + "="*60)
        print(f"❌ Error running audio analysis: {e}")
        print("="*60 + "\n")
        return False

def run_clip_maker(max_duration):
    """Run the clip maker script with max_duration parameter"""
    print("="*60)
    print("🎬 STEP 2: Creating video montage...")
    print(f"   Max duration: {max_duration}s")
    print("="*60 + "\n")
    
    try:
        # Pass max_duration as environment variable
        env = os.environ.copy()
        env['MAX_DURATION'] = str(max_duration)
        
        process = subprocess.Popen(
            [sys.executable, str(CLIP_MAKER_SCRIPT)],
            cwd=SCRIPT_DIR,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )
        
        # Print every line as it comes
        for line in process.stdout:
            print(line, end="")  # live logs
            
            # Optional: write to a log file
            with open("video_creation.log", "a") as f:
                f.write(line)
        
        process.wait()
        if process.returncode != 0:
            print(f"\n❌ Video creation failed with exit code {process.returncode}")
            return False

        print("\n✅ Video creation completed successfully!")
        return True

    except Exception as e:
        import traceback
        print(f"\n❌ Error running video creation: {e}")
        traceback.print_exc()
        return False

def main():
    """Main pipeline: analyze then create clips"""
    print("\n" + "="*60)
    print("🚀 AI VIDEO MONTAGE PIPELINE")
    print("="*60 + "\n")
    
    # Load options from JSON file
    options = load_options()
    max_duration = options.get('max_duration', 60)
    
    # Step 1: Run analysis
    if not run_analyze(max_duration):
        print("❌ Pipeline stopped: Analysis failed")
        sys.exit(1)
    
    # Step 2: Create video montage
    if not run_clip_maker(max_duration):
        print("❌ Pipeline stopped: Video creation failed")
        sys.exit(1)
    
    print("\n" + "="*60)
    print("🎉 PIPELINE COMPLETE!")
    if max_duration:
        print(f"   Generated {max_duration}s montage")
    print("="*60 + "\n")

if __name__ == "__main__":
    main()