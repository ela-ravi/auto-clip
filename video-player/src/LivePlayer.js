import React, { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

const LivePlayer = () => {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const apiBase = process.env.REACT_APP_API_BASE || "http://localhost:5001";
  // Use the local backend stream endpoint (serves HLS files from the server)
  // This avoids Supabase signed-url issues while developing locally.
  const streamURL = `${apiBase}/stream/stream.m3u8`;

  // Player State
  const [error, setError] = useState(null);
  const [status, setStatus] = useState("Initializing...");

  // Clip State
  const [clipping, setClipping] = useState(false);
  const [clipMessage, setClipMessage] = useState("");

  const [userId] = useState(() => {
    try {
      const existing = localStorage.getItem("anonUserId");
      if (existing) return existing;
      const generated = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random());
      localStorage.setItem("anonUserId", generated);
      return generated;
    } catch (_) {
      return String(Date.now() + Math.random());
    }
  });
  const [heartCount, setHeartCount] = useState(0);
  const [dislikeCount, setDislikeCount] = useState(0);
  const [clips, setClips] = useState([]);

  const maybeDownloadFile = async (res) => {
    const disposition = res.headers.get('Content-Disposition') || '';
    const ctype = (res.headers.get('Content-Type') || '').toLowerCase();
    const isAttachment = disposition.includes('attachment');
    const isMedia = ctype.includes('application/octet-stream') || ctype.includes('video/mp4');
    if (isAttachment || isMedia) {
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // try extract filename from Content-Disposition
      let filename = 'clip.mp4';
      const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disposition);
      if (match) {
        filename = decodeURIComponent(match[1] || match[2]);
      }
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      return true;
    }
    return false;
  };

  const fetchClips = async () => {
    try {
      const res = await fetch(`${apiBase}/clips`);
      if (!res.ok) return;
      const data = await res.json();
      setClips(Array.isArray(data.clips) ? data.clips : []);
    } catch (_) {}
  };

  // Video Management State
  const [videos, setVideos] = useState([]);
  const [currentVideo, setCurrentVideo] = useState("");
  const [uploading, setUploading] = useState(false);

  // Fetch available videos on mount
  useEffect(() => {
    fetchVideos();
    fetchClips();
    // eslint-disable-next-line
  }, []);

  const fetchVideos = async () => {
    try {
      const response = await fetch(`${apiBase}/videos`);
      const data = await response.json();
      setVideos(data.videos);
      setCurrentVideo(data.current);
    } catch (err) {
      console.error("Failed to fetch videos:", err);
    }
  };

  // Initialize HLS
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const initPlayer = () => {
      if (Hls.isSupported()) {
        if (hlsRef.current) {
          hlsRef.current.destroy();
        }

        const hls = new Hls({
          enableWorker: true,
          debug: false,
        });

        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setStatus("Stream ready");
          video.play().catch(err => console.error("Autoplay failed:", err));
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                setStatus("Network error, retrying...");
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                setStatus("Media error, recovering...");
                hls.recoverMediaError();
                break;
              default:
                hls.destroy();
                break;
            }
          }
        });

        hls.loadSource(streamURL);
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = streamURL;
        video.addEventListener('loadedmetadata', () => {
          video.play().catch(err => console.error("Autoplay failed:", err));
        });
      }
    };

    initPlayer();

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, [currentVideo, streamURL]); // Re-init when video changes

  const createClip = async (clipStartTime, clipEndTime) => {
    try {
      setClipping(true);
      setClipMessage(`Creating clip from ${Math.floor(clipStartTime)}s to ${Math.floor(clipEndTime)}s...`);

      const response = await fetch(`${apiBase}/clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_time: clipStartTime,
          end_time: clipEndTime,
        }),
      });

      if (!response.ok) throw new Error('Failed to create clip');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clip_${Math.floor(clipStartTime)}-${Math.floor(clipEndTime)}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      setClipMessage('Clip downloaded successfully!');
      setTimeout(() => {
        setClipping(false);
        setClipMessage('');
      }, 3000);
    } catch (error) {
      console.error('Error creating clip:', error);
      setClipMessage('Failed to create clip. Please try again.');
      setTimeout(() => {
        setClipping(false);
        setClipMessage('');
      }, 3000);
    }
  };

  // const triggerClipFromCurrent = async () => {
  //   const video = videoRef.current;
  //   if (!video) return;
  //   const endTime = Number.isFinite(video.duration) ? video.currentTime : video.currentTime;
  //   const startTime = Math.max(0, endTime - 30);
  //   await createClip(startTime, endTime);
  // };

  const handleVideoClick = async (e) => {
    const video = videoRef.current;
    if (!video) return;

    // Check for Ctrl+Alt (Windows) or Ctrl+Option (Mac)
    // const isModifierClick = e.ctrlKey && (e.altKey || e.metaKey);
    const isModifierClick = (e.metaKey || e.ctrlKey) && e.altKey;

    if (!isModifierClick) return;

    e.preventDefault();
    e.stopPropagation();

    try {
      const rect = video.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const videoWidth = rect.width;

      const clickRatio = clickX / videoWidth;
      // For VOD use duration to map click position to time. For live streams
      // video.duration may be Infinity, so fall back to currentTime which
      // represents the live edge position. This prevents huge/incorrect
      // timestamps (e.g., 3 minutes) when clipping the last 30 seconds.
      const clickedTime = Number.isFinite(video.duration)
        ? video.duration * clickRatio
        : video.currentTime;

      const clipEndTime = clickedTime;
      const clipStartTime = Math.max(0, clickedTime - 30);

      await createClip(clipStartTime, clipEndTime);

    } catch (error) {
      console.error('Error creating clip:', error);
      setClipMessage('Failed to create clip. Please try again.');
      setTimeout(() => {
        setClipping(false);
        setClipMessage('');
      }, 3000);
    }
  };

  const handleHeart = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      const t = Number.isFinite(video.duration) ? video.currentTime : video.currentTime;
      const res = await fetch(`${apiBase}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'heart', user_id: userId, t })
      });
      if (!res.ok) return;
      const downloaded = await maybeDownloadFile(res.clone());
      if (downloaded) return;
      const data = await res.json();
      setHeartCount(data.unique_in_window ?? 0);
      if (data.stored) {
        fetchClips();
      }
    } catch (_) {}
  };

  const handleDislike = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      const t = Number.isFinite(video.duration) ? video.currentTime : video.currentTime;
      const res = await fetch(`${apiBase}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'dislike', user_id: userId, t })
      });
      if (!res.ok) return;
      const downloaded = await maybeDownloadFile(res.clone());
      if (downloaded) return;
      const data = await res.json();
      setDislikeCount(data.unique_in_window ?? 0);
      if (data.stored) {
        fetchClips();
      }
    } catch (_) {}
  };

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${apiBase}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        await fetchVideos();
        alert("Upload successful!");
      } else {
        alert("Upload failed");
      }
    } catch (err) {
      console.error("Upload error:", err);
      alert("Upload error");
    } finally {
      setUploading(false);
    }
  };

  const handleVideoSelect = async (e) => {
    const filename = e.target.value;
    if (!filename) return;

    try {
      setStatus("Switching stream...");
      const response = await fetch(`${apiBase}/start_stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });

      if (response.ok) {
        setCurrentVideo(filename);
        // Force HLS reload is handled by useEffect dependency on currentVideo
      }
    } catch (err) {
      console.error("Switch error:", err);
      setStatus("Failed to switch stream");
    }
  };

  return (
    <div style={{ textAlign: "center", marginTop: "20px", fontFamily: "sans-serif" }}>
      <h2 style={{ color: "red" }}>LIVE STREAM</h2>

      {/* Video Controls */}
      <div style={{ marginBottom: "20px", padding: "10px", background: "#f5f5f5", display: "inline-block", borderRadius: "8px" }}>
        <div style={{ marginBottom: "10px" }}>
          <label style={{ marginRight: "10px", fontWeight: "bold" }}>Select Video:</label>
          <select
            value={currentVideo}
            onChange={handleVideoSelect}
            style={{ padding: "5px", borderRadius: "4px", minWidth: "200px" }}
          >
            {videos.map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ marginRight: "10px", fontWeight: "bold" }}>Upload New:</label>
          <input
            type="file"
            accept=".mp4"
            onChange={handleUpload}
            disabled={uploading}
            style={{ padding: "5px" }}
          />
          {uploading && <span style={{ color: "blue" }}>Uploading...</span>}
        </div>
      </div>

      <div style={{ marginBottom: "12px" }}>
        <button onClick={handleHeart} style={{ fontSize: "16px", padding: "6px 10px", marginRight: "8px", cursor: "pointer" }}>
          ❤️ {heartCount}
        </button>
        <button onClick={handleDislike} style={{ fontSize: "16px", padding: "6px 10px", cursor: "pointer" }}>
          👎 {dislikeCount}
        </button>
      </div>

      {status && <p style={{ color: "#666", fontSize: "14px" }}>Status: {status}</p>}
      {error && <p style={{ color: "red", fontSize: "14px" }}>⚠️ {error}</p>}

      {clipping && (
        <p style={{ color: "#4CAF50", fontSize: "14px", fontWeight: "bold" }}>
          🎬 {clipMessage}
        </p>
      )}

      {/* Clips Gallery */}
      <div style={{ marginTop: "20px", padding: "10px" }}>
        <h3 style={{ textAlign: "left", maxWidth: 980, margin: "0 auto 10px" }}>Recent Clips</h3>
        {clips.length === 0 ? (
          <p style={{ color: "#666", fontSize: "14px" }}>No clips yet.</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "12px", maxWidth: 980, margin: "0 auto" }}>
            {clips.map((c) => (
              <div key={c.path} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 8, background: "#fafafa" }}>
                {c.public_url ? (
                  <video src={c.public_url} controls style={{ width: "100%", borderRadius: 6 }} />
                ) : (
                  <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", background: "#eee", borderRadius: 6 }}>
                    <span style={{ color: "#999" }}>No public URL</span>
                  </div>
                )}
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 12, color: "#333", wordBreak: "break-all" }}>{c.name}</div>
                  {c.public_url && (
                    <a href={c.public_url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>Open</a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <p style={{ color: "#999", fontSize: "12px", marginTop: "10px" }}>
        💡 Tip: Hold Ctrl+Alt (Windows) or Ctrl+Option (Mac) and click on the video to clip 30 seconds backward
      </p>

      <video
        ref={videoRef}
        controls
        autoPlay
        muted
        onClick={handleVideoClick}
        style={{ width: "640px", border: "2px solid #333", cursor: "pointer", backgroundColor: "#000" }}
      ></video>
    </div>
  );
};

export default LivePlayer;
