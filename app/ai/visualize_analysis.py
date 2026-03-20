"""
visualize_analysis.py — Interactive audio analysis visualizer with playback
Outputs a self-contained HTML file with:
  - Audio player (audio file embedded as base64, no server needed)
  - Live playhead line that moves across all stem charts in sync with audio
  - Click any chart to seek to that timestamp
  - 4 Demucs stem RMS envelopes stacked
  - Cut point overlays colored by event type, with hover tooltips
  - Score timeline subplot (linked pan/zoom)
  - "Next cut" badge that counts down to the upcoming cut point
  - Debug mode: dropped candidates shown as grey ✕ markers with drop reason
  - BPM grid, label toggle
  - Keyboard: SPACE play/pause, ←/→ ±5s, J/K jump between cut points

Usage:
    python visualize_analysis.py [song_filename] [--debug] [--separate] [--max-duration 60]
    python visualize_analysis.py starships.mp3 --separate          # also saves drums/bass/vocals/other.wav
    python visualize_analysis.py starships.mp3 --debug --separate  # everything

Requirements:
    pip install librosa torch demucs numpy scipy soundfile
"""

import os
import sys
import json
import base64
import argparse
import numpy as np
import librosa
import soundfile as sf
import torch
from demucs import pretrained
from demucs.apply import apply_model
from scipy.ndimage import gaussian_filter1d

# ─── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
AUDIO_FOLDER = os.path.join(SCRIPT_DIR, "../backend/uploads/songs")
INPUT_JSON   = os.path.join(SCRIPT_DIR, "audio_analysis.json")
OUTPUT_HTML  = os.path.join(SCRIPT_DIR, "analysis_visualization.html")

# ─── Palette ──────────────────────────────────────────────────────────────────
STEM_COLORS = {
    "drums":  "#7F6FE8",
    "bass":   "#2EC4A0",
    "vocals": "#E8724A",
    "other":  "#888880",
}
EVENT_COLORS = {
    "vocal_repetition": "#F5A623",
    "vocal_transient":  "#E8724A",
    "bass_drop":        "#E24B4A",
    "drum_low":         "#7F77DD",
    "drum_mid":         "#A389CC",
    "drum_high":        "#C3AAEE",
    "pattern_change":   "#3B8BD4",
    "phrase_end":       "#1DB954",
    "other_peak":       "#00E5CC",
    "unknown":          "#AAAAAA",
}
STEM_ORDER = ["drums", "bass", "vocals", "other"]


# ─── Audio helpers ────────────────────────────────────────────────────────────
def load_and_separate(audio_path, max_duration=None, start_sec=0.0):
    print("Loading audio + running Demucs separation...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model  = pretrained.get_model("htdemucs")
    model.to(device).eval()

    # Load only the analyzed window so charts match the selected song section.
    load_kwargs = {"sr": 44100, "mono": False}
    start_sec = max(0.0, float(start_sec or 0.0))
    if start_sec > 0:
        load_kwargs["offset"] = start_sec
    if max_duration and float(max_duration) > 0:
        load_kwargs["duration"] = float(max_duration)

    wav_np, sr = librosa.load(audio_path, **load_kwargs)
    if wav_np.ndim == 1:
        wav_np = np.stack([wav_np, wav_np])
    elif wav_np.shape[0] == 1:
        wav_np = np.vstack([wav_np, wav_np])

    wav = torch.from_numpy(wav_np).float()
    with torch.no_grad():
        sources = apply_model(model, wav.unsqueeze(0).to(device), device=device)[0]

    stereo = {
        "drums":  sources[0].cpu().numpy(),
        "bass":   sources[1].cpu().numpy(),
        "other":  sources[2].cpu().numpy(),
        "vocals": sources[3].cpu().numpy(),
    }
    mono = {k: np.mean(v, axis=0) for k, v in stereo.items()}
    return mono, stereo, sr


def rms_envelope(audio, sr, hop=512, sigma=4, max_pts=4000):
    rms   = librosa.feature.rms(y=audio, frame_length=2048, hop_length=hop)[0]
    rms   = gaussian_filter1d(rms.astype(float), sigma=sigma)
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    if len(times) > max_pts:
        idx   = np.round(np.linspace(0, len(times)-1, max_pts)).astype(int)
        times = times[idx]; rms = rms[idx]
    return times.tolist(), rms.tolist()


def export_stems(stereo_stems, sr, song_name, out_dir):
    """Write each stem as a stereo WAV file into out_dir/stems/<song_name>/"""
    stem_dir = os.path.join(out_dir, "stems", os.path.splitext(song_name)[0])
    os.makedirs(stem_dir, exist_ok=True)
    for name, audio in stereo_stems.items():
        path = os.path.join(stem_dir, f"{name}.wav")
        # soundfile expects (samples, channels)
        sf.write(path, audio.T, sr, subtype="PCM_16")
        print(f"  saved → {path}")
    print(f"Stems written to: {stem_dir}")
    return stem_dir


def audio_to_base64(path):
    ext  = os.path.splitext(path)[1].lower().lstrip('.')
    mime = {'mp3':'audio/mpeg','wav':'audio/wav','ogg':'audio/ogg',
            'flac':'audio/flac','m4a':'audio/mp4','aac':'audio/aac'}.get(ext,'audio/mpeg')
    print(f"Embedding audio ({mime}) as base64...")
    with open(path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()
    return f"data:{mime};base64,{b64}"


# ─── HTML builder ─────────────────────────────────────────────────────────────
def build_html(song_name, stems_data, cut_points, dropped_candidates,
               bpm, debug_mode, audio_data_uri, stem_audio_uris=None,
               song_start_sec=0.0):

    duration      = max(max(t for t in times) for times, _ in stems_data.values())
    beat_interval = 60.0 / bpm if bpm > 0 else None

    stems_json = {s: {"times": t, "rms": r} for s, (t, r) in stems_data.items()}

    def ev(cp, kept=True):
        return {
            "t":      float(cp.get("timestamp", cp.get("time", 0))),
            "type":   cp.get("type", "unknown"),
            "score":  cp.get("score", 0),
            "kept":   kept,
            "reason": cp.get("drop_reason", ""),
        }

    kept    = [ev(c, True)  for c in cut_points]
    dropped = [ev(c, False) for c in dropped_candidates] if debug_mode else []

    stem_uris = stem_audio_uris or {}
    has_stems  = bool(stem_uris)

    blob = json.dumps({
        "song": song_name, "bpm": bpm, "duration": duration,
        "stems": stems_json, "kept": kept, "dropped": dropped,
        "beat_interval": beat_interval,
        "event_colors": EVENT_COLORS,
        "stem_colors":  STEM_COLORS,
        "stem_order":   STEM_ORDER,
        "debug": debug_mode,
        "stem_uris": stem_uris,   # dict: {"mix": uri, "drums": uri, ...}
        "has_stems": has_stems,
    })

    dur_fmt    = f"{int(duration//60)}:{int(duration%60):02d}.{int((duration%1)*10)}"
    n_dismissed = len(dropped_candidates)
    drop_badge  = (f'<div>DISMISSED <b>{n_dismissed}</b></div>' if debug_mode else '')
    drop_btn    = ('<button class="btn on" id="btn-drop" onclick="toggleDrop()">DISMISSED</button>'
                   if debug_mode else '')

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{song_name} — Cut Analysis</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.27.0/plotly.min.js"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Mono&family=Outfit:wght@300;400;500&display=swap');
*,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
:root{{
  --bg:#080810;--surface:#0f0f1a;--panel:#13131f;
  --border:#1e1e30;--text:#c0c0d8;--muted:#44445a;
  --accent:#7F6FE8;--green:#1DB954;--orange:#F5A623;
  --mono:'Space Mono',monospace;--body:'Outfit',sans-serif;
}}
html,body{{background:var(--bg);color:var(--text);font-family:var(--body);
  font-weight:300;min-height:100vh;overflow-x:hidden}}

header{{
  display:flex;align-items:center;gap:1.2rem;flex-wrap:wrap;
  padding:0.85rem 1.4rem;border-bottom:1px solid var(--border);
  background:var(--surface);position:sticky;top:0;z-index:100;
}}
.title{{font-family:var(--mono);font-size:0.82rem;color:#fff;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38vw}}
.meta{{font-family:var(--mono);font-size:0.62rem;color:var(--muted);
  display:flex;gap:1rem;flex-wrap:wrap}}
.meta b{{color:var(--accent)}}
.controls{{display:flex;gap:0.45rem;margin-left:auto;flex-wrap:wrap;align-items:center}}
.btn{{font-family:var(--mono);font-size:0.62rem;letter-spacing:0.05em;
  background:transparent;border:1px solid var(--border);color:var(--muted);
  padding:0.28rem 0.7rem;border-radius:2px;cursor:pointer;transition:all 0.14s}}
.btn:hover{{border-color:var(--accent);color:#fff}}
.btn.on{{border-color:var(--accent);color:var(--accent);background:#16162a}}

#player{{display:flex;align-items:center;gap:0.9rem;
  padding:0.65rem 1.4rem;background:var(--panel);border-bottom:1px solid var(--border)}}
#play-btn{{
  width:34px;height:34px;border-radius:50%;
  border:1.5px solid var(--accent);background:transparent;
  color:var(--accent);font-size:0.85rem;cursor:pointer;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;transition:all 0.14s;
}}
#play-btn:hover{{background:var(--accent);color:#080810}}

#seek{{
  flex:1;height:3px;-webkit-appearance:none;appearance:none;
  border-radius:2px;outline:none;cursor:pointer;
  background:linear-gradient(to right,
    var(--accent) 0%, var(--accent) var(--pct,0%),
    var(--border) var(--pct,0%), var(--border) 100%);
}}
#seek::-webkit-slider-thumb{{-webkit-appearance:none;width:11px;height:11px;
  border-radius:50%;background:var(--accent);cursor:pointer;
  box-shadow:0 0 5px rgba(127,111,232,.55)}}
#seek::-moz-range-thumb{{width:11px;height:11px;border-radius:50%;
  background:var(--accent);border:none}}

.tdisp{{font-family:var(--mono);font-size:0.68rem;color:var(--muted);
  white-space:nowrap;min-width:88px;text-align:right}}
.tdisp b{{color:var(--text)}}

#next-cut{{font-family:var(--mono);font-size:0.6rem;white-space:nowrap;
  background:var(--panel);border:1px solid var(--border);
  padding:0.18rem 0.55rem;border-radius:2px;color:var(--muted);min-width:140px;
  transition:color 0.2s,border-color 0.2s}}
#next-cut.soon{{color:var(--orange);border-color:var(--orange)}}

/* ── stem switcher ── */
#stem-switcher{{
  display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;
  padding:0.5rem 1.4rem;background:var(--surface);
  border-bottom:1px solid var(--border);
}}
#stem-switcher .label{{
  font-family:var(--mono);font-size:0.58rem;color:var(--muted);
  margin-right:0.3rem;letter-spacing:0.06em;
}}
.stem-btn{{
  font-family:var(--mono);font-size:0.65rem;letter-spacing:0.04em;
  background:transparent;border:1px solid var(--border);color:var(--muted);
  padding:0.3rem 0.85rem;border-radius:2px;cursor:pointer;transition:all 0.14s;
  position:relative;
}}
.stem-btn:hover{{color:#fff;border-color:#555}}
.stem-btn.active{{color:#fff;border-color:var(--stem-color,var(--accent));
  background:color-mix(in srgb,var(--stem-color,var(--accent)) 12%,transparent);
  box-shadow:0 0 8px -2px var(--stem-color,var(--accent));}}
.stem-btn .dot{{
  display:inline-block;width:6px;height:6px;border-radius:50%;
  margin-right:0.4rem;background:var(--stem-color,var(--accent));
  vertical-align:middle;margin-top:-1px;
}}

.plot-wrap{{width:100%}}
#stems-chart{{height:560px}}
#score-chart{{height:135px;border-top:1px solid var(--border)}}

#legend{{display:flex;flex-wrap:wrap;gap:0.35rem 0.9rem;
  padding:0.65rem 1.4rem;border-top:1px solid var(--border);
  font-family:var(--mono);font-size:0.6rem;color:var(--muted)}}
.li{{display:flex;align-items:center;gap:0.32rem}}
.sw{{width:8px;height:8px;border-radius:1px;flex-shrink:0}}

#status{{font-family:var(--mono);font-size:0.58rem;color:var(--muted);
  padding:0.35rem 1.4rem 0.9rem;line-height:1.8}}
</style>
</head>
<body>

<header>
  <div class="title" title="{song_name}">{song_name}</div>
  <div class="meta">
    <div>BPM <b>{bpm:.1f}</b></div>
    <div>CUTS <b>{len(cut_points)}</b></div>
    {drop_badge}
    <div>DUR <b>{duration:.1f}s</b></div>
  </div>
  <div class="controls">
    <button class="btn" id="btn-bpm" onclick="toggleBPM()">BPM GRID</button>
    {drop_btn}
    <button class="btn" id="btn-lbl" onclick="toggleLabels()">LABELS</button>
  </div>
</header>

<audio id="aud-mix"    src="{audio_data_uri}" preload="auto"></audio>
<!-- stem audio elements injected by JS from D.stem_uris -->

<div id="player">
  <button id="play-btn" onclick="togglePlay()">▶</button>
  <input id="seek" type="range" min="0" max="{duration:.3f}" step="0.01" value="0" oninput="seekTo(+this.value)">
  <div class="tdisp"><b id="t-now">0:00.0</b> / {dur_fmt}</div>
  <div id="next-cut">next cut: —</div>
</div>

<div id="stem-switcher">
  <span class="label">LISTENING TO</span>
  <!-- buttons injected by JS once D is parsed -->
</div>

<div>
  <div class="plot-wrap" id="stems-chart"></div>
  <div class="plot-wrap" id="score-chart"></div>
</div>
<div id="legend"></div>
<div id="status">
  SPACE play/pause &nbsp;·&nbsp; ←/→ ±5s &nbsp;·&nbsp; J next cut &nbsp;·&nbsp; K prev cut &nbsp;·&nbsp; click chart to seek &nbsp;·&nbsp; scroll/pinch to zoom
  {'&nbsp;·&nbsp; ⬡ debug mode on' if debug_mode else ''}
</div>

<script>
const D = {blob};
const songStart = {float(song_start_sec or 0.0):.6f};

let showBPM=false, showDrop={str(debug_mode).lower()}, showLabels=false;
let phT=0, xRange=[0,D.duration], linked=false, raf=null;

// ── audio nodes ────────────────────────────────────────────────────────────
// Build one <audio> per source (mix + each stem if available)
const audNodes = {{}};
audNodes['mix'] = document.getElementById('aud-mix');

if(D.has_stems){{
  Object.entries(D.stem_uris).forEach(([name, uri])=>{{
    if(name==='mix') return;
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.src = uri;
    document.body.appendChild(el);
    audNodes[name] = el;
  }});
}}

let activeSource = 'mix';
let aud = audNodes['mix'];   // always points to the currently active node
aud.currentTime = songStart;
function offsetForSource(src){{ return src === 'mix' ? songStart : 0; }}

const seek  = document.getElementById('seek');
const pBtn  = document.getElementById('play-btn');
const tNow  = document.getElementById('t-now');
const nCut  = document.getElementById('next-cut');

// ── stem switcher UI ───────────────────────────────────────────────────────
function buildSwitcher(){{
  const bar = document.getElementById('stem-switcher');
  if(!D.has_stems){{ bar.style.display='none'; return; }}

  const sources = ['mix', ...D.stem_order];
  const colors  = {{'mix':'#888', ...D.stem_colors}};

  sources.forEach(name=>{{
    const btn = document.createElement('button');
    btn.className = 'stem-btn' + (name==='mix'?' active':'');
    btn.id = 'sbtn-'+name;
    btn.style.setProperty('--stem-color', colors[name]||'#888');
    btn.innerHTML = `<span class="dot"></span>${{name.toUpperCase()}}`;
    btn.onclick = ()=>switchSource(name);
    bar.appendChild(btn);
  }});
}}

function switchSource(name){{
  if(name===activeSource) return;
  const wasPlaying = !aud.paused;
  const tRel = Math.max(0, aud.currentTime - offsetForSource(activeSource));

  // pause old
  aud.pause();

  // switch
  activeSource = name;
  aud = audNodes[name];
  aud.currentTime = offsetForSource(name) + tRel;

  // update button states
  document.querySelectorAll('.stem-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('sbtn-'+name)?.classList.add('active');

  // resume if was playing
  if(wasPlaying) aud.play();

  // re-attach events to new node
  attachAudEvents();
}}

// ── utils ──────────────────────────────────────────────────────────────────
const rgba=(h,a)=>{{const r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return`rgba(${{r}},${{g}},${{b}},${{a}})`}};
const fmt=s=>{{const m=Math.floor(s/60),sec=(s%60).toFixed(1).padStart(4,'0');return`${{m}}:${{sec}}`}};

// ── stem traces ────────────────────────────────────────────────────────────
function stemTraces(){{
  const out=[];
  D.stem_order.forEach((s,i)=>{{
    const d=D.stems[s],c=D.stem_colors[s],y0=i*1.15;
    out.push({{x:d.times,y:d.rms.map(v=>v+y0),fill:'tonexty',fillcolor:rgba(c,.28),
      line:{{color:c,width:1.1}},name:s,showlegend:false,hoverinfo:'none',
      type:'scatter',mode:'lines'}});
    out.push({{x:d.times,y:d.rms.map(()=>y0),fill:'none',
      line:{{color:'rgba(0,0,0,0)',width:0}},name:s+'_b',showlegend:false,
      hoverinfo:'none',type:'scatter',mode:'lines'}});
  }});
  return out;
}}

// ── event marker traces ────────────────────────────────────────────────────
function eventTraces(){{
  const all=[...D.kept,...(showDrop?D.dropped:[])];
  const grp={{}};
  all.forEach(ev=>{{const k=ev.kept?ev.type:'__dropped__';(grp[k]=grp[k]||[]).push(ev)}});
  return Object.entries(grp).map(([k,list])=>{{
    const isDrop=k==='__dropped__';
    const color=isDrop?'#2a2a3e':(D.event_colors[k]||'#fff');
    const xs=[],ys=[],tips=[];
    list.forEach(ev=>{{
      D.stem_order.forEach((_,i)=>{{
        xs.push(ev.t); ys.push(i*1.15);
        tips.push(`<b>${{ev.type.replace(/_/g,' ')}}</b><br>t: ${{ev.t.toFixed(3)}}s<br>score: ${{ev.score}}${{ev.reason?'<br><span style="color:#F5A623">✕ '+ev.reason+'</span>':''}}`);
      }});
    }});
    return {{
      x:xs,y:ys,type:'scatter',
      mode:showLabels&&!isDrop?'markers+text':'markers',
      marker:{{symbol:isDrop?'x':'line-ns-open',color,
        size:isDrop?6:13,line:{{width:isDrop?1.5:2,color}},
        opacity:isDrop?0.3:.9}},
      text:list.flatMap(ev=>D.stem_order.map(()=>ev.type.replace('_',' ').slice(0,5))),
      textposition:'top center',textfont:{{size:7,color,family:'Space Mono'}},
      hovertemplate:'%{{customdata}}<extra></extra>',customdata:tips,
      name:isDrop?'dropped':k.replace(/_/g,' '),showlegend:false,
    }};
  }});
}}

// ── playhead shapes ────────────────────────────────────────────────────────
const phShape =t=>{{return{{type:'line',x0:t,x1:t,y0:0,y1:D.stem_order.length*1.15,line:{{color:'rgba(255,255,255,.85)',width:1.5}},layer:'above'}}}};
const phShapeS=t=>{{return{{type:'line',x0:t,x1:t,y0:0,y1:1,yref:'paper',line:{{color:'rgba(255,255,255,.7)',width:1.5}},layer:'above'}}}};

// ── BPM grid shapes ────────────────────────────────────────────────────────
function bpmShapes(){{
  if(!showBPM||!D.beat_interval)return[];
  const s=[];
  for(let t=0;t<D.duration;t+=D.beat_interval)
    s.push({{type:'line',x0:t,x1:t,y0:0,y1:D.stem_order.length*1.15,
      line:{{color:'rgba(127,111,232,.13)',width:.8,dash:'dot'}},layer:'below'}});
  return s;
}}

// ── stem label annotations ─────────────────────────────────────────────────
function stemAnns(){{
  return D.stem_order.map((s,i)=>{{return{{
    x:xRange[0]+0.4,y:i*1.15+0.03,xref:'x',yref:'y',text:s.toUpperCase(),
    showarrow:false,font:{{size:8,color:D.stem_colors[s],family:'Space Mono'}},
    xanchor:'left',yanchor:'bottom',
  }}}});
}}

// ── layouts ────────────────────────────────────────────────────────────────
function layoutStems(){{return{{
  paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'#0b0b14',
  font:{{family:'Space Mono',color:'#44445a',size:8}},
  margin:{{t:8,b:22,l:38,r:10}},
  xaxis:{{range:xRange,showgrid:false,zeroline:false,tickcolor:'#1e1e30',
    linecolor:'#1a1a28',tickfont:{{size:7.5}}}},
  yaxis:{{showticklabels:false,showgrid:false,zeroline:false,
    range:[-0.04,D.stem_order.length*1.15+.08]}},
  shapes:[...bpmShapes(),phShape(phT)],
  annotations:stemAnns(),
  hovermode:'closest',dragmode:'pan',showlegend:false,
}}}}

function layoutScore(){{return{{
  paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'#08080f',
  font:{{family:'Space Mono',color:'#333348',size:7}},
  margin:{{t:4,b:26,l:38,r:10}},
  xaxis:{{range:xRange,showgrid:false,zeroline:false,
    tickcolor:'#1a1a28',linecolor:'#1a1a28',tickfont:{{size:7}},
    title:{{text:'time (s)',font:{{size:7.5}},standoff:3}}}},
  yaxis:{{showgrid:true,gridcolor:'#111120',zeroline:false,
    tickfont:{{size:7}},title:{{text:'score',font:{{size:7.5}},standoff:2}}}},
  shapes:[phShapeS(phT)],
  hovermode:'closest',bargap:.35,showlegend:false,
}}}}

// ── score traces ───────────────────────────────────────────────────────────
function scoreTraces(){{
  const out=[{{
    x:D.kept.map(e=>e.t),y:D.kept.map(e=>e.score),type:'bar',
    marker:{{color:D.kept.map(e=>D.event_colors[e.type]||'#aaa'),opacity:.8}},
    hovertemplate:'<b>%{{x:.2f}}s</b>  score %{{y}}<extra></extra>',showlegend:false,
  }}];
  if(showDrop&&D.dropped.length)out.push({{
    x:D.dropped.map(e=>e.t),y:D.dropped.map(e=>e.score),type:'bar',
    marker:{{color:'#1e1e30',opacity:.7}},
    hovertemplate:'<b>%{{x:.2f}}s</b>  score %{{y}}<br>%{{customdata}}<extra></extra>',
    customdata:D.dropped.map(e=>e.reason||'—'),showlegend:false,
  }});
  return out;
}}

const cfg={{responsive:true,displayModeBar:false,scrollZoom:true}};

// ── full render ────────────────────────────────────────────────────────────
function render(){{
  Plotly.react('stems-chart',[...stemTraces(),...eventTraces()],layoutStems(),cfg);
  Plotly.react('score-chart',scoreTraces(),layoutScore(),cfg);
  linkAxes(); buildLegend();
}}

// ── playhead fast-update (no full re-render) ───────────────────────────────
function movePH(t){{
  phT=t;
  Plotly.relayout('stems-chart',{{shapes:[...bpmShapes(),phShape(t)]}});
  Plotly.relayout('score-chart',{{shapes:[phShapeS(t)]}});
}}

// ── linked pan/zoom ────────────────────────────────────────────────────────
function linkAxes(){{
  if(linked)return; linked=true;
  const sc=document.getElementById('stems-chart');
  const rc=document.getElementById('score-chart');
  sc.on('plotly_relayout',d=>{{
    if(d['xaxis.range[0]']!==undefined){{
      xRange=[d['xaxis.range[0]'],d['xaxis.range[1]']];
      Plotly.relayout(rc,{{'xaxis.range[0]':xRange[0],'xaxis.range[1]':xRange[1]}});
      Plotly.relayout(sc,{{annotations:stemAnns()}});
    }}
    if(d['xaxis.autorange']){{xRange=[0,D.duration];Plotly.relayout(rc,{{'xaxis.autorange':true}})}}
  }});
  rc.on('plotly_relayout',d=>{{
    if(d['xaxis.range[0]']!==undefined){{
      xRange=[d['xaxis.range[0]'],d['xaxis.range[1]']];
      Plotly.relayout(sc,{{'xaxis.range[0]':xRange[0],'xaxis.range[1]':xRange[1]}});
    }}
    if(d['xaxis.autorange']){{xRange=[0,D.duration];Plotly.relayout(sc,{{'xaxis.autorange':true}})}}
  }});
}}

// ── click-to-seek ──────────────────────────────────────────────────────────
function attachSeekClick(){{
  ['stems-chart','score-chart'].forEach(id=>{{
    document.getElementById(id).on('plotly_click',data=>{{
      if(data.points&&data.points.length&&typeof data.points[0].x==='number')
        seekTo(data.points[0].x);
    }});
  }});
}}

// ── playback controls ──────────────────────────────────────────────────────
function seekTo(t){{
  t=Math.max(0,Math.min(D.duration,t));
  aud.currentTime=offsetForSource(activeSource)+t;
  seek.value=t;
  seek.style.setProperty('--pct',(t/D.duration*100)+'%');
  tNow.textContent=fmt(t);
  movePH(t); updateNextCut(t);
}}

function togglePlay(){{
  if(aud.paused){{aud.play();pBtn.textContent='⏸'}}
  else{{aud.pause();pBtn.textContent='▶'}}
}}

// ── animation loop ─────────────────────────────────────────────────────────
function tick(){{
  const t=Math.min(D.duration,Math.max(0,aud.currentTime-offsetForSource(activeSource)));
  seek.value=t;
  seek.style.setProperty('--pct',(t/D.duration*100)+'%');
  tNow.textContent=fmt(t);
  movePH(t); updateNextCut(t);
  raf=requestAnimationFrame(tick);
}}

function attachAudEvents(){{
  // remove from all nodes first to avoid duplicate ticks
  Object.values(audNodes).forEach(el=>{{
    el.onplay=null; el.onpause=null; el.onended=null;
  }});
  aud.onplay  = ()=>{{ cancelAnimationFrame(raf); raf=requestAnimationFrame(tick); pBtn.textContent='⏸'; }};
  aud.onpause = ()=>{{ cancelAnimationFrame(raf); pBtn.textContent='▶'; }};
  aud.onended = ()=>{{ cancelAnimationFrame(raf); pBtn.textContent='▶'; }};
}}

// ── next-cut badge ─────────────────────────────────────────────────────────
const sortedCuts=[...D.kept].sort((a,b)=>a.t-b.t);
function updateNextCut(t){{
  const nc=sortedCuts.find(e=>e.t>t+0.06);
  if(!nc){{nCut.textContent='next cut: —';nCut.className='';return}}
  const d=(nc.t-t).toFixed(1);
  nCut.textContent=`next: ${{nc.type.replace(/_/g,' ')}} in ${{d}}s`;
  nCut.className=d<2?'soon':'';
}}

// ── legend ─────────────────────────────────────────────────────────────────
function buildLegend(){{
  const types=[...new Set(D.kept.map(e=>e.type))];
  document.getElementById('legend').innerHTML=
    types.map(t=>`<div class="li"><div class="sw" style="background:${{D.event_colors[t]||'#aaa'}}"></div><span>${{t.replace(/_/g,' ')}}</span></div>`).join('')
    +(D.debug&&D.dropped.length?'<div class="li"><div class="sw" style="background:#2a2a3e"></div><span>dropped</span></div>':'');
}}

// ── toggles ────────────────────────────────────────────────────────────────
function toggleBPM(){{showBPM=!showBPM;document.getElementById('btn-bpm').classList.toggle('on',showBPM);render()}}
function toggleDrop(){{showDrop=!showDrop;document.getElementById('btn-drop')?.classList.toggle('on',showDrop);render()}}
function toggleLabels(){{showLabels=!showLabels;document.getElementById('btn-lbl').classList.toggle('on',showLabels);render()}}

// ── keyboard ───────────────────────────────────────────────────────────────
document.addEventListener('keydown',e=>{{
  if(e.target.tagName==='INPUT')return;
  if(e.code==='Space'){{e.preventDefault();togglePlay()}}
  if(e.code==='ArrowRight')seekTo((aud.currentTime-offsetForSource(activeSource))+5);
  if(e.code==='ArrowLeft') seekTo((aud.currentTime-offsetForSource(activeSource))-5);
  if(e.code==='KeyJ'){{const n=sortedCuts.find(c=>c.t>(aud.currentTime-offsetForSource(activeSource))+0.1);if(n)seekTo(n.t)}}
  if(e.code==='KeyK'){{const p=[...sortedCuts].reverse().find(c=>c.t<(aud.currentTime-offsetForSource(activeSource))-0.1);if(p)seekTo(p.t)}}
}});

// ── boot ───────────────────────────────────────────────────────────────────
buildSwitcher();
attachAudEvents();
render();
updateNextCut(0);
setTimeout(attachSeekClick,800);
</script>
</body>
</html>"""


# ─── CLI ──────────────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(description="Visualize cut point analysis with audio playback")
    p.add_argument("song",           nargs="?",           help="Song filename in audio folder")
    p.add_argument("--debug",        action="store_true", help="Show dropped candidates")
    p.add_argument("--separate",     action="store_true", help="Export each stem as a WAV file")
    p.add_argument("--max-duration", type=float,          help="Limit audio to N seconds")
    p.add_argument("--output",       default=OUTPUT_HTML, help="Output HTML path")
    args = p.parse_args()

    if not os.path.exists(INPUT_JSON):
        print(f"ERROR: {INPUT_JSON} not found. Run analyze.py first.")
        sys.exit(1)

    with open(INPUT_JSON) as f:
        results = json.load(f)

    song = args.song or list(results.keys())[0]
    if song not in results:
        print(f"ERROR: '{song}' not found. Available: {list(results.keys())}")
        sys.exit(1)

    data        = results[song]
    cut_points  = data.get("cut_points", [])
    bpm         = data.get("bpm", 0)
    max_dur     = args.max_duration or data.get("max_duration")
    song_start_sec = float(data.get("song_start_sec", 0) or 0)

    # Support new key name (dismissed_cuts) and old names for backwards compat
    dismissed_candidates = (
        data.get("dismissed_cuts") or
        data.get("dismissed_candidates") or
        data.get("dropped_candidates") or
        []
    )

    # Always enable debug/dismissed view if the data is present
    debug_mode = args.debug or bool(dismissed_candidates)

    if not dismissed_candidates:
        print("NOTE: no dismissed_cuts in JSON — run the patched analyze.py to capture dismissed cuts.")

    audio_path = os.path.join(AUDIO_FOLDER, song)
    if not os.path.exists(audio_path):
        print(f"ERROR: Audio not found: {audio_path}")
        sys.exit(1)

    print(f"\nSong:       {song}")
    print(f"Song start: {song_start_sec:.2f}s")
    print(f"BPM:        {bpm:.1f}")
    print(f"Cuts kept:  {len(cut_points)}")
    print(f"Dismissed:  {len(dismissed_candidates)}")
    print(f"Debug mode: {debug_mode}\n")

    audio_uri          = audio_to_base64(audio_path)
    stems, stereo, sr  = load_and_separate(audio_path, max_duration=max_dur, start_sec=song_start_sec)

    # Export stem wavs if requested, and always collect their URIs for the player
    stem_audio_uris = {"mix": audio_uri}
    if args.separate:
        print("\nExporting stem WAVs...")
        stem_dir = export_stems(stereo, sr, song, out_dir=os.path.dirname(args.output))
        for stem_name in STEM_ORDER:
            wav_path = os.path.join(stem_dir, f"{stem_name}.wav")
            if os.path.exists(wav_path):
                stem_audio_uris[stem_name] = audio_to_base64(wav_path)
    else:
        # Still embed stems for in-browser switching by exporting to a temp dir
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            print("\nEncoding stems for browser playback (not saving to disk — use --separate to save)...")
            tmp_stems = export_stems(stereo, sr, song, out_dir=tmp)
            for stem_name in STEM_ORDER:
                wav_path = os.path.join(tmp_stems, f"{stem_name}.wav")
                if os.path.exists(wav_path):
                    stem_audio_uris[stem_name] = audio_to_base64(wav_path)

    print("Computing RMS envelopes...")
    stems_data = {}
    for name, audio in stems.items():
        t, r = rms_envelope(audio, sr)
        stems_data[name] = (t, r)
        print(f"  {name}: {len(t)} pts")

    print("\nBuilding HTML...")
    html = build_html(
        song_name          = song,
        stems_data         = stems_data,
        cut_points         = cut_points,
        dropped_candidates = dismissed_candidates,
        bpm                = bpm,
        debug_mode         = debug_mode,
        audio_data_uri     = audio_uri,
        stem_audio_uris    = stem_audio_uris,
        song_start_sec     = song_start_sec,
    )

    with open(args.output, "w", encoding="utf-8") as f:
        f.write(html)

    mb = os.path.getsize(args.output) / 1e6
    print(f"\nSaved → {args.output}  ({mb:.1f} MB)")
    print("\nKeyboard shortcuts in browser:")
    print("  SPACE      play / pause")
    print("  ←  /  →   seek ±5 seconds")
    print("  J          jump to next cut point")
    print("  K          jump to previous cut point")
    print("  click      seek to clicked time on any chart")


if __name__ == "__main__":
    main()
