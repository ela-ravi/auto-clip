# live_stream_supa.py
import os
import subprocess
import time
import threading
import uuid
from datetime import datetime, timedelta
from dotenv import load_dotenv
from flask import Flask, send_from_directory, render_template_string, request, jsonify, send_file
from flask_cors import CORS
from supabase import create_client, Client

# ---- load config ----
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")  # service role key (keep secret)
SUPABASE_BUCKET = os.getenv("SUPABASE_BUCKET", "hls-bucket")  # bucket name

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ---- Flask app ----
app = Flask(__name__)
# Allow all origins globally; no credentials
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=False)

# ---- configuration ----
VIDEO_SOURCE = os.getenv("VIDEO_SOURCE", "test.mp4")
HLS_OUTPUT_DIR = os.getenv("HLS_OUTPUT_DIR", "stream")
CLIPS_DIR = os.getenv("CLIPS_DIR", "clips")
UPLOAD_DIR = os.getenv("UPLOAD_DIR", ".")
SEGMENT_PREFIX = "segment_"  # local segment filename prefix
SEGMENT_PATTERN = f"{SEGMENT_PREFIX}%03d.ts"
PLAYLIST_NAME = "stream.m3u8"
HLS_TIME = 20
HLS_LIST_SIZE = 30  # sliding window length
POLL_INTERVAL = 0.6  # seconds for uploader loop
REACTION_WINDOW_SEC = float(os.getenv("REACTION_WINDOW_SEC", 3))
REACTION_THRESHOLD = int(os.getenv("REACTION_THRESHOLD", 1))
CLIP_BACK_SECONDS = int(os.getenv("CLIP_BACK_SECONDS", 30))

# ---- state ----
CURRENT_FFMPEG_PROCESS = None
CURRENT_VIDEO_SOURCE = VIDEO_SOURCE

# In-memory reaction aggregation: {reaction_type: [ {time: server_ts, user_id: str, t: float} ]}
REACTION_EVENTS = {
    "heart": [],
    "dislike": [],
}

# create directories
os.makedirs(HLS_OUTPUT_DIR, exist_ok=True)
os.makedirs(CLIPS_DIR, exist_ok=True)

# Ensure permissive CORS headers (in addition to flask-cors defaults)
@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers.setdefault("Access-Control-Allow-Headers", "Content-Type, Authorization")
    response.headers.setdefault("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    response.headers.setdefault("Access-Control-Expose-Headers", "Content-Type, Content-Disposition")
    response.headers.setdefault("Access-Control-Max-Age", "86400")
    return response

# ---- HTML page (client pinned to LIVE) ----
HTML_PAGE = """
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Local Live Stream</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    body { background: #222; color: #fff; font-family: sans-serif; text-align:center; margin-top:40px; }
    video { width: 800px; max-width: 95%; border: 2px solid #333; background: black; }
    .live { color: red; font-weight: bold; }
  </style>
</head>
<body>
  <h1>Python Flask <span class="live">LIVE</span> Stream</h1>
  <video id="video" controls autoplay muted playsinline></video>
  <script>
    const video = document.getElementById('video');
    const playlist = '/stream/{{playlist}}';
    if (Hls.isSupported()) {
      const hls = new Hls({maxBufferLength: 3});
      hls.loadSource(playlist);
      hls.attachMedia(video);
      // Always play at live edge; prevent seeking backward
      hls.on(Hls.Events.LEVEL_LOADED, function() {
        // when level loaded, jump to live edge
        if (video.duration && !isNaN(video.duration)) {
          video.currentTime = video.duration;
        }
      });
      video.addEventListener('seeking', () => {
        // always snap to live edge
        if (video.duration) video.currentTime = video.duration - 0.1;
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playlist;
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = video.duration;
      });
      video.addEventListener('seeking', () => {
        if (video.duration) video.currentTime = video.duration - 0.1;
      });
    }
  </script>
</body>
</html>
""".replace("{{playlist}}", PLAYLIST_NAME)

# ---- helper: stop ffmpeg ----
def stop_transcoding():
    global CURRENT_FFMPEG_PROCESS
    if CURRENT_FFMPEG_PROCESS and CURRENT_FFMPEG_PROCESS.poll() is None:
        print("Stopping current FFmpeg process...")
        try:
            CURRENT_FFMPEG_PROCESS.terminate()
            CURRENT_FFMPEG_PROCESS.wait(timeout=5)
        except Exception:
            try:
                CURRENT_FFMPEG_PROCESS.kill()
            except Exception:
                pass
        CURRENT_FFMPEG_PROCESS = None

# ---- start transcoding: strict live mode ----
def start_transcoding(video_file: str = None):
    global CURRENT_FFMPEG_PROCESS, CURRENT_VIDEO_SOURCE

    if video_file:
        CURRENT_VIDEO_SOURCE = video_file

    stop_transcoding()

    # clean local hls directory
    for f in os.listdir(HLS_OUTPUT_DIR):
        if f.endswith(".ts") or f.endswith(".m3u8"):
            try:
                os.remove(os.path.join(HLS_OUTPUT_DIR, f))
            except Exception:
                pass

    print(f"[FFMPEG] Starting transcoding for: {CURRENT_VIDEO_SOURCE}")

    command = [
        "ffmpeg",
        "-re",
        "-stream_loop", "-1",
        "-i", CURRENT_VIDEO_SOURCE,
        # force constant frame rate & regenerate timestamps
        "-vf", "fps=25",
        "-fflags", "+genpts",
        # encode
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        # keyframes every HLS_TIME seconds
        "-force_key_frames", f"expr:gte(t,n_forced*{HLS_TIME})",
        "-c:a", "aac",
        "-b:a", "128k",
        # HLS options for strict live sliding window
        "-f", "hls",
        "-hls_time", str(HLS_TIME),
        "-hls_list_size", str(HLS_LIST_SIZE),
        "-hls_flags", "delete_segments+split_by_time+program_date_time",
        "-hls_segment_type", "mpegts",
        "-hls_segment_filename", os.path.join(HLS_OUTPUT_DIR, SEGMENT_PATTERN),
        os.path.join(HLS_OUTPUT_DIR, PLAYLIST_NAME)
    ]

    # run ffmpeg
    CURRENT_FFMPEG_PROCESS = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    # start uploader thread if not started
    if not any(t.name == "uploader" for t in threading.enumerate()):
        uploader = threading.Thread(target=upload_new_segments, name="uploader", daemon=True)
        uploader.start()

# ---- uploader: upload stable files to Supabase Storage ----
def is_file_stable(path: str, delay: float = 0.5) -> bool:
    """Return True if file size is stable for 'delay' seconds (not being written)."""
    try:
        size1 = os.path.getsize(path)
        time.sleep(delay)
        size2 = os.path.getsize(path)
        return size1 == size2 and size1 > 0
    except Exception:
        return False

def upload_to_supabase(local_path: str, remote_path: str, content_type: str = None):
    """Upload a file to Supabase storage bucket (overwrites if exists)."""
    try:
        with open(local_path, "rb") as f:
            data = f.read()
        # supabase.storage.from().upload signature may vary on client versions.
        # Using upsert behavior by deleting then uploading ensures replace.
        # Attempt to upload; if fails with conflict, remove and re-upload.
        try:
            supabase.storage.from_(SUPABASE_BUCKET).upload(remote_path, data)
        except Exception as e:
            # fallback: try remove then upload (some clients enforce unique paths)
            try:
                supabase.storage.from_(SUPABASE_BUCKET).remove([remote_path])
            except Exception:
                pass
            supabase.storage.from_(SUPABASE_BUCKET).upload(remote_path, data)
        # Optionally set metadata (not required)
        print(f"[UP] Uploaded {local_path} -> {remote_path}")
    except Exception as e:
        print(f"[UP-ERR] Failed upload {local_path} -> {remote_path}: {e}")

def upload_new_segments():
    """
    Poll HLS_OUTPUT_DIR for new stable files and upload to Supabase.
    Tracks uploaded filenames to avoid re-upload storms.
    Always re-upload playlist when modified.
    """
    uploaded = set()
    last_playlist_mtime = None

    while True:
        try:
            # upload segments
            for fname in sorted(os.listdir(HLS_OUTPUT_DIR)):
                if not (fname.endswith(".ts") or fname.endswith(".m3u8")):
                    continue
                local = os.path.join(HLS_OUTPUT_DIR, fname)

                # upload playlist every time it's updated, not only new
                if fname.endswith(".m3u8"):
                    try:
                        mtime = os.path.getmtime(local)
                        if last_playlist_mtime is None or mtime > last_playlist_mtime:
                            if is_file_stable(local, delay=0.2):
                                upload_to_supabase(local, f"live/{fname}", content_type="application/x-mpegURL")
                                last_playlist_mtime = mtime
                    except Exception as e:
                        print("[UP] playlist upload error:", e)
                    continue

                # for segments, ensure stable then upload once
                if fname not in uploaded and os.path.isfile(local):
                    if is_file_stable(local, delay=0.4):
                        # upload
                        ctype = "video/MP2T"
                        try:
                            upload_to_supabase(local, f"live/{fname}", content_type=ctype)
                            uploaded.add(fname)
                        except Exception as e:
                            print("[UP] segment upload err:", e)

        except Exception as e:
            print("[UP] watcher loop error:", e)

        time.sleep(POLL_INTERVAL)

# ---- routes ----
@app.route("/")
def index():
    # Render the HTML that plays local playlist by default (but your React front-end
    # can point to the supabase public URL if you prefer).
    return render_template_string(HTML_PAGE)

@app.route("/videos", methods=["GET"])
def list_videos():
    videos = [f for f in os.listdir(".") if f.endswith(".mp4")]
    return jsonify({"videos": videos, "current": CURRENT_VIDEO_SOURCE})

@app.route("/upload", methods=["POST"])
def upload_video():
    if "file" not in request.files:
        return jsonify({"error": "No file part"}), 400
    f = request.files["file"]
    if f.filename == "":
        return jsonify({"error": "No selected file"}), 400
    if not f.filename.endswith(".mp4"):
        return jsonify({"error": "Invalid file type"}), 400
    dest = os.path.join(UPLOAD_DIR, f.filename)
    f.save(dest)
    return jsonify({"message": "File uploaded", "filename": f.filename})

@app.route("/start_stream", methods=["POST"])
def switch_stream():
    data = request.get_json() or {}
    filename = data.get("filename")
    if not filename or not os.path.exists(filename):
        return jsonify({"error": "File not found"}), 404
    start_transcoding(filename)
    return jsonify({"message": f"Streaming {filename}"})

@app.route("/clip", methods=["POST"])
def create_clip():
    try:
        data = request.get_json()
        start_time = float(data.get("start_time", 0))
        end_time = float(data.get("end_time", 30))
        if start_time < 0 or end_time <= start_time:
            return jsonify({"error": "Invalid times"}), 400
        duration = end_time - start_time
        clip_filename = f"clip_{uuid.uuid4().hex[:8]}_{int(start_time)}_{int(end_time)}.mp4"
        clip_path = os.path.join(CLIPS_DIR, clip_filename)
        command = [
            "ffmpeg",
            "-ss", str(start_time),
            "-i", CURRENT_VIDEO_SOURCE,
            "-t", str(duration),
            "-c:v", "libx264",
            "-c:a", "aac",
            "-preset", "ultrafast",
            "-y",
            clip_path
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            print("Clip ffmpeg err:", result.stderr)
            return jsonify({"error": "Clip creation failed"}), 500
        return send_file(clip_path, as_attachment=True, download_name=os.path.basename(clip_path))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ---- reaction aggregation and server-side clipping ----
def _purge_old_events(now_ts: float):
    cutoff = now_ts - REACTION_WINDOW_SEC
    for key in list(REACTION_EVENTS.keys()):
        REACTION_EVENTS[key] = [e for e in REACTION_EVENTS[key] if e["time"] >= cutoff]

def _clip_async(start_time: float, end_time: float):
    try:
        duration = max(0.1, end_time - start_time)
        clip_filename = f"clip_{uuid.uuid4().hex[:8]}_{int(start_time)}_{int(end_time)}.mp4"
        clip_path = os.path.join(CLIPS_DIR, clip_filename)
        command = [
            "ffmpeg",
            "-ss", str(start_time),
            "-i", CURRENT_VIDEO_SOURCE,
            "-t", str(duration),
            "-c:v", "libx264",
            "-c:a", "aac",
            "-preset", "ultrafast",
            "-y",
            clip_path
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            print("[CLIP] ffmpeg error:", result.stderr)
        else:
            print(f"[CLIP] Created {clip_path}")
    except Exception as e:
        print("[CLIP] Exception:", e)

def _maybe_trigger_clip(reaction_type: str):
    now_ts = time.time()
    _purge_old_events(now_ts)
    events = REACTION_EVENTS.get(reaction_type, [])
    # Map latest event per user within window
    latest_by_user = {}
    for e in events:
        latest_by_user[e["user_id"]] = e
    unique_count = len(latest_by_user)
    if unique_count >= REACTION_THRESHOLD:
        # choose end_time as median of client-reported t's to reduce outliers
        times = sorted(ev["t"] for ev in latest_by_user.values())
        mid = len(times) // 2
        if len(times) % 2 == 1:
            end_time = times[mid]
        else:
            end_time = 0.5 * (times[mid - 1] + times[mid])
        start_time = max(0.0, end_time - CLIP_BACK_SECONDS)
        # Indicate a synchronous clip should be created by caller
        return True, start_time, end_time, unique_count
    return False, None, None, unique_count

@app.route("/react", methods=["POST", "OPTIONS"])
def react():
    # Handle preflight explicitly
    if request.method == "OPTIONS":
        return ("", 204)
    try:
        data = request.get_json() or {}
        reaction_type = str(data.get("type", "")).lower()
        if reaction_type not in REACTION_EVENTS:
            return jsonify({"error": "Invalid reaction type"}), 400
        user_id = str(data.get("user_id") or "").strip()
        if not user_id:
            return jsonify({"error": "user_id required"}), 400
        try:
            t = float(data.get("t"))
            if not (t >= 0):
                raise ValueError
        except Exception:
            return jsonify({"error": "valid 't' (seconds) required"}), 400

        now_ts = time.time()
        REACTION_EVENTS[reaction_type].append({
            "time": now_ts,
            "user_id": user_id,
            "t": t,
        })
        triggered, start_time, end_time, uniq = _maybe_trigger_clip(reaction_type)
        if triggered:
            # Create the clip synchronously and return it as a file download
            try:
                duration = max(0.1, end_time - start_time)
                clip_filename = f"clip_{uuid.uuid4().hex[:8]}_{int(start_time)}_{int(end_time)}.mp4"
                clip_path = os.path.join(CLIPS_DIR, clip_filename)
                command = [
                    "ffmpeg",
                    "-ss", str(start_time),
                    "-i", CURRENT_VIDEO_SOURCE,
                    "-t", str(duration),
                    "-c:v", "libx264",
                    "-c:a", "aac",
                    "-preset", "ultrafast",
                    "-y",
                    clip_path
                ]
                result = subprocess.run(command, capture_output=True, text=True)
                if result.returncode != 0:
                    print("[REACT CLIP] ffmpeg error:", result.stderr)
                    return jsonify({"error": "Clip creation failed"}), 500
                # Reset reaction window to avoid duplicate triggers
                REACTION_EVENTS[reaction_type] = []
                print(f"[REACT] Synchronous clip for '{reaction_type}' t={end_time:.2f} (start {start_time:.2f}) from {uniq} users")
                return send_file(clip_path, as_attachment=True, download_name=os.path.basename(clip_path))
            except Exception as e:
                return jsonify({"error": str(e)}), 500
        # Not yet at threshold: return JSON status
        return jsonify({
            "ok": True,
            "reaction": reaction_type,
            "unique_in_window": uniq,
            "window_sec": REACTION_WINDOW_SEC,
            "threshold": REACTION_THRESHOLD,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/stream/<path:filename>")
def stream_files(filename):
    # always ensure the browser gets the latest playlist/segments
    response = send_from_directory(HLS_OUTPUT_DIR, filename)
    response.cache_control.no_cache = True
    response.cache_control.no_store = True
    response.cache_control.must_revalidate = True
    return response

# ---- main ----
if __name__ == "__main__":
    print("[MAIN] Starting FFmpeg streaming...")
    start_transcoding(VIDEO_SOURCE)
    # give ffmpeg a second to produce initial files
    time.sleep(2)
    print("[MAIN] Starting Flask server on :5001")
    app.run(host="0.0.0.0", port=5001, debug=True, use_reloader=False)
