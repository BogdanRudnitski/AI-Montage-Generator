#!/usr/bin/env python3
"""
Main entry point for AI video montage pipeline.
Runs analyze.py first, then clip_maker.py after successful analysis.
"""
import os
import sys
import subprocess

# Get the directory where this script is located
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Paths to the analysis and clip maker scripts
ANALYZE_SCRIPT = os.path.join(SCRIPT_DIR, "analyze.py")
CLIP_MAKER_SCRIPT = os.path.join(SCRIPT_DIR, "clip_maker.py")

def run_analyze():
    """Run the audio analysis script"""
    print("="*60)
    print("🎵 STEP 1: Running audio analysis...")
    print("="*60 + "\n")
    
    try:
        result = subprocess.run(
            [sys.executable, ANALYZE_SCRIPT],
            cwd=SCRIPT_DIR,
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

def run_clip_maker():
    print("="*60)
    print("🎬 STEP 2: Creating video montage...")
    print("="*60 + "\n")
    
    try:
        process = subprocess.Popen(
            [sys.executable, str(CLIP_MAKER_SCRIPT)],
            cwd=SCRIPT_DIR,
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
    
    # Step 1: Run analysis
    if not run_analyze():
        print("❌ Pipeline stopped: Analysis failed")
        sys.exit(1)
    
    # Step 2: Create video montage
    if not run_clip_maker():
        print("❌ Pipeline stopped: Video creation failed")
        sys.exit(1)
    
    print("\n" + "="*60)
    print("🎉 PIPELINE COMPLETE!")
    print("="*60 + "\n")

if __name__ == "__main__":
    main()

