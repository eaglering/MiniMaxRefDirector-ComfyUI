// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: updateSeekBarBackground, updatePlayerUI, togglePlay, toggleLoop, playAudio, pauseAudio
import { ICONS, api } from "./shared.js";

export const audio = {
  updateSeekBarBackground() {
    if (!this.seekBar) return;
    const max = parseFloat(this.seekBar.max) || 1;
    const val = parseFloat(this.seekBar.value) || 0;
    const pct = (val / max) * 100;
    this.seekBar.style.background = `linear-gradient(to right, #ff4444 0%, #ff4444 ${pct}%, #444 ${pct}%, #444 100%)`;
  },

  updatePlayerUI() {
    if (!this.playBtn || !this.loopBtn) return;
    this.playBtn.innerHTML = this.isPlaying ? ICONS.pause : ICONS.play;
    if (this.isLooping) {
      this.loopBtn.classList.add("active");
    } else {
      this.loopBtn.classList.remove("active");
    }
    if (this.seekBar) {
      this.seekBar.max = this.getVisualDurationFrames();
      this.seekBar.value = this.currentFrame;
      this.updateSeekBarBackground();
    }
    if (this.timeCodeDisplay) {
      this.timeCodeDisplay.textContent = this.formatTime(this.currentFrame);
    }
  },

  togglePlay() {
    if (this.isPlaying) {
      this.pauseAudio();
    } else {
      const playMax = this.retakeMode 
        ? (this.timeline.retakeVideo ? (this.timeline.retakeVideo.videoDurationFrames || this.getDurationFrames()) : this.getDurationFrames())
        : this.getVisualDurationFrames();
      if (this.currentFrame >= playMax) {
        this.currentFrame = 0;
      }
      this.playAudio();
    }
  },

  toggleLoop() {
    this.isLooping = !this.isLooping;
    this.updatePlayerUI();
  },

  async playAudio() {
    this.pauseAudio(true); // clear any existing playback, but don't suspend context if scrubbing

    this._playCounter = (this._playCounter || 0) + 1;
    const playId = this._playCounter;
    this._currentPlayId = playId;
    this.isPlaying = true;

    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state !== 'running') {
      try { await this.audioContext.resume(); } catch (e) { }
    }
    if (this._currentPlayId !== playId || !this.isPlaying) return;

    this.updatePlayerUI();

    const frameRate = this.getFrameRate();
    this.playbackStartFrame = this.currentFrame;
    this.playbackStartTime = this.audioContext.currentTime;

    // Build the list of active segments to play
    const segmentsToPlay = [];

    // 1. Standard Audio Segments on the audio track (only if the track is enabled and NOT in retake mode)
    if (this.audioTrackEnabled && !this.retakeMode) {
      if (this.timeline.audioSegments) {
        for (let seg of this.timeline.audioSegments) {
          segmentsToPlay.push({
            type: 'audio',
            originalSeg: seg,
            start: seg.start,
            length: seg.length,
            trimStart: seg.trimStart || 0,
            audioFile: seg.audioFile,
            audioB64: seg.audioB64,
            _blobUrl: seg._blobUrl,
            fileSize: seg.fileSize
          });
        }
      }
    }

    // 2. Motion Video Segments (only if overrideAudio toggle is ON and NOT in retake mode)
    const isOverrideAudio = !!(this.node.properties.overrideAudio || this.timeline.overrideAudio);
    if (isOverrideAudio && !this.retakeMode) {
      if (this.timeline.motionSegments) {
        for (let seg of this.timeline.motionSegments) {
          if (seg.videoFile || seg._blobUrl) {
            segmentsToPlay.push({
              type: 'motion',
              originalSeg: seg,
              start: seg.start,
              length: seg.length,
              trimStart: seg.trimStart || 0,
              audioFile: seg.videoFile || seg.fileName,
              audioB64: null,
              _blobUrl: seg._blobUrl,
              fileSize: seg.fileSize
            });
          }
        }
      }
    }

    // Decode and schedule all scheduled segments that happen AT or AFTER currentFrame in the background
    for (let item of segmentsToPlay) {
      const segStartFrame = item.start;
      const segEndFrame = item.start + item.length;

      if (segEndFrame <= this.currentFrame) continue;

      (async () => {
        try {
          // Build mock seg object for helper compatibility
          const mockSeg = {
            audioFile: item.audioFile,
            audioB64: item.audioB64,
            _blobUrl: item._blobUrl,
            fileSize: item.fileSize,
            waveformPeaks: item.originalSeg.waveformPeaks
          };

          await this._getOrExtractAudio(mockSeg);

          if (this._currentPlayId !== playId || !this.isPlaying) return;

          if (mockSeg.waveformPeaks && !item.originalSeg.waveformPeaks) {
            item.originalSeg.waveformPeaks = mockSeg.waveformPeaks;
            this.render();
          }

          if (!this._isAudioDecodingAllowed(mockSeg)) {
            return;
          }

          // Build audio buffer
          let audioBuffer = item.originalSeg._audioBuffer;
          if (!audioBuffer) {
            if (mockSeg.audioFile || mockSeg._blobUrl) {
              const parts = (mockSeg.audioFile || "").split(/[/\\\\]/);
              const filename = parts.pop() || '';
              const subfolder = parts.join('/');
              const audioUrl = mockSeg._blobUrl || api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

              this._audioBufferCache = this._audioBufferCache || new Map();
              this._audioBufferPromises = this._audioBufferPromises || new Map();
              const cacheKey = mockSeg.audioFile || audioUrl;

              if (this._audioBufferCache.has(cacheKey)) {
                audioBuffer = this._audioBufferCache.get(cacheKey);
              } else if (this._audioBufferPromises.has(cacheKey)) {
                audioBuffer = await this._audioBufferPromises.get(cacheKey);
              } else {
                const decodePromise = (async () => {
                  const resp = await fetch(audioUrl);
                  const arrayBuffer = await resp.arrayBuffer();
                  return await this.audioContext.decodeAudioData(arrayBuffer);
                })();
                this._audioBufferPromises.set(cacheKey, decodePromise);
                try {
                  audioBuffer = await decodePromise;
                  this._audioBufferCache.set(cacheKey, audioBuffer);
                } finally {
                  this._audioBufferPromises.delete(cacheKey);
                }
              }
              item.originalSeg._audioBuffer = audioBuffer;
            } else if (mockSeg.audioB64) {
              const binaryString = window.atob(mockSeg.audioB64);
              const len = binaryString.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              audioBuffer = await this.audioContext.decodeAudioData(bytes.buffer);
              item.originalSeg._audioBuffer = audioBuffer;
            } else {
              return;
            }
          }

          if (this._currentPlayId !== playId || !this.isPlaying) return;

          // Determine current playback position dynamically in Web Audio time
          const currentPlayTime = this.audioContext.currentTime;
          const elapsedSecSincePlayStart = currentPlayTime - this.playbackStartTime;
          const currentFrameCalculated = this.playbackStartFrame + elapsedSecSincePlayStart * frameRate;

          // If playback has already moved beyond the segment end, skip playing it
          if (currentFrameCalculated >= segEndFrame) return;

          let startTime, fileOffsetSec, playDurationSec;

          if (currentFrameCalculated < segStartFrame) {
            // Segment starts in the future relative to current playback position
            const waitFrames = segStartFrame - currentFrameCalculated;
            const waitTimeSec = waitFrames / frameRate;
            startTime = currentPlayTime + waitTimeSec;
            fileOffsetSec = item.trimStart / frameRate;
            playDurationSec = item.length / frameRate;
          } else {
            // Segment is already playing. Start immediately, but offset into the audio buffer
            startTime = currentPlayTime;
            const framesToSkip = currentFrameCalculated - segStartFrame;
            fileOffsetSec = (item.trimStart + framesToSkip) / frameRate;
            playDurationSec = (item.length - framesToSkip) / frameRate;
          }

          if (playDurationSec <= 0) return;

          const bufferNode = this.audioContext.createBufferSource();
          bufferNode.buffer = audioBuffer;
          bufferNode["connect"](this.audioContext.destination);
          bufferNode.start(startTime, fileOffsetSec, playDurationSec);

          this.activeAudioNodes.push(bufferNode);
        } catch (err) {
          console.error("Playback decode error for segment:", err);
        }
      })();
    }

    if (this._currentPlayId !== playId || !this.isPlaying) return;

    const loop = () => {
      if (!this.isPlaying || this._currentPlayId !== playId) return;

      const elapsedSec = this.audioContext.currentTime - this.playbackStartTime;
      const elapsedFrames = elapsedSec * frameRate;

      this.currentFrame = this.playbackStartFrame + elapsedFrames;

      const visualDurationFrames = this.getVisualDurationFrames();
      const durationFrames = this.getDurationFrames();

      let loopBound, stopBound;
      if (this.retakeMode) {
        const retakeLimit = this.timeline.retakeVideo ? (this.timeline.retakeVideo.videoDurationFrames || durationFrames) : durationFrames;
        loopBound = retakeLimit;
        stopBound = retakeLimit;
      } else {
        loopBound = (this.playbackStartFrame >= durationFrames) ? visualDurationFrames : durationFrames;
        stopBound = visualDurationFrames;
      }

      if (this.isLooping) {
        if (this.currentFrame >= loopBound) {
          this.currentFrame = 0;
          this.playAudio(); // Restart playback
          return;
        }
      } else {
        if (this.currentFrame >= stopBound) {
          this.currentFrame = stopBound;
          this.pauseAudio();
          this.render();
          return;
        }
      }

      // Sync video playback
      if (this.retakeMode) {
        if (this.timeline.retakeVideo) {
          const retakeVid = this.timeline.retakeVideo;
          this._ensureVideoEl(retakeVid);
          if (retakeVid.videoEl) {
            const expectedSec = this.currentFrame / frameRate;
            if (retakeVid.videoEl.paused && !retakeVid.videoEl.seeking) {
              retakeVid.videoEl.currentTime = expectedSec;
              retakeVid.videoEl.muted = false;
              retakeVid.videoEl.play().catch(e => console.warn("Retake video play prevented", e));
            } else if (!retakeVid.videoEl.paused && Math.abs(retakeVid.videoEl.currentTime - expectedSec) > 0.5) {
              retakeVid.videoEl.currentTime = expectedSec;
            }
          }
        }
        // Pause all other video elements
        const allSegments = [...(this.timeline.segments || []), ...(this.timeline.motionSegments || [])];
        for (const seg of allSegments) {
          if (seg.videoEl && !seg.videoEl.paused) {
            seg.videoEl.pause();
          }
        }
      } else {
        const activeSegments = (this._isDragging && this._previewSegments && this.selectionType !== "audio") ? this._previewSegments : this.timeline.segments;
        const activeSeg = activeSegments.find(s => s.type === "video" && this.currentFrame >= s.start && this.currentFrame < s.start + s.length);
        const activeVideoEl = activeSeg ? activeSeg.videoEl : null;

        for (const seg of activeSegments) {
          if (seg.type === "video" && seg.videoEl) {
            if (seg === activeSeg) {
              const expectedSec = (seg.trimStart + (this.currentFrame - seg.start)) / frameRate;
              if (seg.videoEl.paused && !seg.videoEl.seeking) {
                // Not playing and no seek in flight — start a fresh seek+play
                seg.videoEl.currentTime = expectedSec;
                seg.videoEl.play().catch(e => console.warn("Video play prevented", e));
              } else if (!seg.videoEl.paused && Math.abs(seg.videoEl.currentTime - expectedSec) > 0.5) {
                // Already playing but drifted — resync
                seg.videoEl.currentTime = expectedSec;
              }
              // If paused && seeking: a seek+play is already in flight, let it finish
            } else {
              // Only pause if this segment's video element is NOT shared with the currently active segment
              if (seg.videoEl !== activeVideoEl && !seg.videoEl.paused) {
                seg.videoEl.pause();
              }
            }
          }
        }
      }

      // Sync motion playback
      if (!this.retakeMode) {
        const activeMotionSegments = (this._isDragging && this._previewSegments && this.selectionType === "motion") ? this._previewSegments : this.timeline.motionSegments;
        const activeMotionSeg = activeMotionSegments.find(s => s.type === "motion_video" && this.currentFrame >= s.start && this.currentFrame < s.start + s.length);
        const activeMotionVideoEl = activeMotionSeg ? activeMotionSeg.videoEl : null;

        for (const seg of activeMotionSegments) {
          if (seg.type === "motion_video" && seg.videoEl) {
            if (seg === activeMotionSeg) {
              const expectedSec = (seg.trimStart + (this.currentFrame - seg.start)) / frameRate;
              if (seg.videoEl.paused && !seg.videoEl.seeking) {
                // Not playing and no seek in flight — start a fresh seek+play
                seg.videoEl.currentTime = expectedSec;
                seg.videoEl.play().catch(e => console.warn("Video play prevented", e));
              } else if (!seg.videoEl.paused && Math.abs(seg.videoEl.currentTime - expectedSec) > 0.5) {
                // Already playing but drifted — resync
                seg.videoEl.currentTime = expectedSec;
              }
              // If paused && seeking: a seek+play is already in flight, let it finish
            } else {
              // Only pause if this segment's video element is NOT shared with the currently active motion segment
              if (seg.videoEl !== activeMotionVideoEl && !seg.videoEl.paused) {
                seg.videoEl.pause();
              }
            }
          }
        }
      }

      this.render();
      this._playLoopId = requestAnimationFrame(loop);
    };

    this._playLoopId = requestAnimationFrame(loop);
  },

  pauseAudio(isScrubbing = false) {
    this.isPlaying = false;
    this._currentPlayId = null;

    if (!isScrubbing && this.audioContext && this.audioContext.state === 'running') {
      try { this.audioContext.suspend(); } catch (e) { }
    }

    if (this.retakeMode && this.timeline.retakeVideo) {
      const retakeVid = this.timeline.retakeVideo;
      if (retakeVid.videoEl) {
        if (!retakeVid.videoEl.paused) {
          retakeVid.videoEl.pause();
        }
        retakeVid.videoEl.muted = true; // Mute again on pause/stop to prevent transient audio bursts
        retakeVid.videoEl.currentTime = this.currentFrame / this.getFrameRate();
      }
    } else {
      // Sync video segments on pause
      for (const seg of this.timeline.segments) {
        if (seg.type === "video" && seg.videoEl) {
          if (!seg.videoEl.paused) {
            seg.videoEl.pause();
          }
          if (this.currentFrame >= seg.start && this.currentFrame < seg.start + seg.length) {
            seg.videoEl.currentTime = (seg.trimStart + (this.currentFrame - seg.start)) / this.getFrameRate();
          }
        }
      }

      // Sync motion segments on pause
      for (const seg of this.timeline.motionSegments) {
        if (seg.type === "motion_video" && seg.videoEl) {
          if (!seg.videoEl.paused) {
            seg.videoEl.pause();
          }
          if (this.currentFrame >= seg.start && this.currentFrame < seg.start + seg.length) {
            seg.videoEl.currentTime = (seg.trimStart + (this.currentFrame - seg.start)) / this.getFrameRate();
          }
        }
      }
    }

    for (let node of this.activeAudioNodes) {
      try { node.stop(); } catch (e) { }
      try { node.disconnect(); } catch (e) { }
    }
    this.activeAudioNodes = [];

    if (this._playLoopId) {
      cancelAnimationFrame(this._playLoopId);
      this._playLoopId = null;
    }
    this.updatePlayerUI();
  }
};
