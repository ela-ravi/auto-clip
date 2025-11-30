import React, { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

const LivePlayer = () => {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  // Use the local backend stream endpoint (serves HLS files from the server)
  // This avoids Supabase signed-url issues while developing locally.
  const streamURL = "http://localhost:5001/stream/stream.m3u8";

  // Player State
  const [error, setError] = useState(null);
  const [status, setStatus] = useState("Initializing...");

  // Clip State
  const [clipping, setClipping] = useState(false);
  const [clipMessage, setClipMessage] = useState("");

  // Video Management State
  const [videos, setVideos] = useState([]);
  const [currentVideo, setCurrentVideo] = useState("");
  const [uploading, setUploading] = useState(false);

  // Fetch available videos on mount
  useEffect(() => {
    fetchVideos();
  }, []);

  const fetchVideos = async () => {
    try {
      const response = await fetch('http://localhost:5001/videos');
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
  }, [currentVideo]); // Re-init when video changes

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

      setClipping(true);
      setClipMessage(`Creating clip from ${Math.floor(clipStartTime)}s to ${Math.floor(clipEndTime)}s...`);

      const response = await fetch('http://localhost:5001/clip', {
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

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('http://localhost:5001/upload', {
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
      const response = await fetch('http://localhost:5001/start_stream', {
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

      {status && <p style={{ color: "#666", fontSize: "14px" }}>Status: {status}</p>}
      {error && <p style={{ color: "red", fontSize: "14px" }}>⚠️ {error}</p>}

      {clipping && (
        <p style={{ color: "#4CAF50", fontSize: "14px", fontWeight: "bold" }}>
          🎬 {clipMessage}
        </p>
      )}

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
