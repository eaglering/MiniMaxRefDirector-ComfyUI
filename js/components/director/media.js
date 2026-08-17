// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: _ensureThumbnails, _ensureVideoEl, _getOrExtractAudio, _extractAudioOnClient, _isAudioDecodingAllowed, _preloadAudioSegment, loadMedia, handleImageUpload, _uploadVideoFile, handleVideoUpload, generateVideoPreviewThumbs, handleAudioUpload
import { api, genId, uploadImage, viewUrl } from "./shared.js";

export const media = {
  async _ensureThumbnails(seg) {
    if (seg.thumbnails) return;
    if (seg._extractingThumbs) return;
    if (seg.isStaticImage) return;

    const fileKey = seg.imageFile || seg.videoFile || seg._blobUrl;
    if (!fileKey) return;

    this._thumbnailCache = this._thumbnailCache || new Map();
    this._thumbnailPromises = this._thumbnailPromises || new Map();

    if (this._thumbnailCache.has(fileKey)) {
      seg.thumbnails = this._thumbnailCache.get(fileKey);
      this.render();
      return;
    }

    if (this._thumbnailPromises.has(fileKey)) {
      seg._extractingThumbs = true;
      try {
        const thumbs = await this._thumbnailPromises.get(fileKey);
        seg.thumbnails = thumbs;
      } catch (err) {
        console.error("Failed to await thumbnails promise:", err);
      } finally {
        seg._extractingThumbs = false;
        this.render();
      }
      return;
    }

    // Otherwise, we extract the thumbnails
    seg._extractingThumbs = true;
    seg.thumbnails = [];

    const extractPromise = (async () => {
      const thumbs = [];
      const parts = fileKey.split(/[/\\\\]/);
      const filename = parts.pop() || '';
      const subfolder = parts.join('/');
      const vidUrl = seg._blobUrl || (seg.videoEl ? seg.videoEl.src : null) || viewUrl(filename, subfolder);

      const bgVid = document.createElement('video');
      bgVid.crossOrigin = "Anonymous";
      bgVid.muted = true;
      bgVid.preload = 'auto';

      try {
        await new Promise(r => {
          let resolved = false;
          const done = () => {
            if (!resolved) {
              resolved = true;
              r();
            }
          };
          bgVid.onloadeddata = done;
          bgVid.onerror = done;
          bgVid.src = vidUrl;
          if (bgVid.readyState >= 2) {
            done();
          }
        });

        if (!bgVid.duration) {
          return thumbs;
        }

        const duration = bgVid.duration;
        const isLargeFile = seg.fileSize > 500 * 1024 * 1024;
        const numFrames = isLargeFile ? 15 : Math.max(10, Math.min(80, Math.ceil(duration * 5.0)));
        const canvas = document.createElement('canvas');
        let w = bgVid.videoWidth, h = bgVid.videoHeight;
        if (w === 0 || h === 0) return thumbs;

        if (h > this.blockHeight) {
          w = Math.round(w * (this.blockHeight / h));
          h = this.blockHeight;
        }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');

        for (let i = 0; i < numFrames; i++) {
          // Check if the file/segment is still active in the current timeline
          const exists = this.timeline.segments.find(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey);
          if (!exists) break;

          const time = (i / numFrames) * duration;
          bgVid.currentTime = time;

          await new Promise(r => {
            let resolved = false;
            const onSeek = () => { if (!resolved) { resolved = true; r(); } };
            bgVid.onseeked = onSeek;
            setTimeout(onSeek, 1000);
          });

          ctx.drawImage(bgVid, 0, 0, w, h);
          const img = new Image();
          img.src = canvas.toDataURL('image/jpeg', 0.5);
          await new Promise(r => { img.onload = r; });

          thumbs.push({ time, img });

          // Propagate the partial progress live to all active segments sharing this file
          const matchingSegs = [
            ...this.timeline.segments.filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey)
          ];
          for (const ms of matchingSegs) {
            ms.thumbnails = thumbs;
          }

          this.render();
        }
      } catch (err) {
        console.error("Thumbnail extraction loop failed:", err);
      } finally {
        try {
          bgVid.pause();
          bgVid.onloadeddata = null;
          bgVid.onerror = null;
          bgVid.onseeked = null;
          bgVid.src = "";
          bgVid.load();
        } catch (_) { }
      }
      return thumbs;
    })();

    this._thumbnailPromises.set(fileKey, extractPromise);

    try {
      const thumbs = await extractPromise;
      this._thumbnailCache.set(fileKey, thumbs);

      const matchingSegs = [
        ...this.timeline.segments.filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey)
      ];
      for (const ms of matchingSegs) {
        ms.thumbnails = thumbs;
        ms._extractingThumbs = false;

        // If fileKey is a blob URL, and the segment now has a server file path, cache under that path too
        if (fileKey.startsWith("blob:")) {
          const serverKey = ms.imageFile || ms.videoFile;
          if (serverKey) {
            this._thumbnailCache.set(serverKey, thumbs);
          }
        }
      }
    } catch (err) {
      console.error("Extraction error:", err);
      const matchingSegs = [
        ...this.timeline.segments.filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey)
      ];
      for (const ms of matchingSegs) {
        ms._extractingThumbs = false;
      }
    } finally {
      this._thumbnailPromises.delete(fileKey);
      this.render();
    }
  }
,

  _ensureVideoEl(seg) {
    if (!seg) return;
    if (seg.isStaticImage) return;

    if (seg.videoEl) {
      if (seg.videoEl.duration && !seg.videoDurationFrames) {
        const frameRate = this.getFrameRate();
        seg.videoDurationFrames = Math.max(1, Math.ceil(seg.videoEl.duration * frameRate));
      }

      return;
    }

    const cacheKey = seg.imageFile || seg.videoFile || seg._blobUrl;
    if (!cacheKey) return;

    this._videoElementsCache = this._videoElementsCache || new Map();

    if (this._videoElementsCache.has(cacheKey)) {
      // Reuse the existing shared video element — do NOT re-seek it.
      // Running initVideoSeek on an already-initialized element causes cascading seeks
      // when multiple split segments share it (e.g. seg2 seeks to 5min, seg3 seeks to 10min),
      // which breaks playback on long videos. Just grab the reference and ensure thumbnails.
      seg.videoEl = this._videoElementsCache.get(cacheKey);
      if (seg.videoEl.duration && !seg.videoDurationFrames) {
        const frameRate = this.getFrameRate();
        seg.videoDurationFrames = Math.max(1, Math.ceil(seg.videoEl.duration * frameRate));
      }

      this._ensureThumbnails(seg);
      return;
    }

    const isVideo = seg.type === "video" && (seg.imageFile || seg._blobUrl);
    if (!isVideo) return;

    const fileKey = seg.imageFile;
    let vidUrl = seg._blobUrl;
    if (!vidUrl && fileKey) {
      const fileParts = fileKey.split(/[/\\\\]/);
      const justName = fileParts.pop() || '';
      const subfolder = fileParts.join('/');
      vidUrl = viewUrl(justName, subfolder);
    }
    if (!vidUrl) return;

    const vid = document.createElement('video');
    vid.crossOrigin = "Anonymous";
    vid.muted = true;
    vid.preload = 'auto';

    seg.videoEl = vid;
    this._videoElementsCache.set(cacheKey, vid);

    vid.addEventListener('seeked', () => {
      this.render();
    });

    const onSeekedHandler = () => {
      vid.removeEventListener('seeked', onSeekedHandler);
      // imageB64 已是服务器 API 路径时（上传完成回填 / 工作流恢复），用该 URL 加载预览，
      // 不要用 canvas 抽取 base64 覆盖，保持 API 路径。
      const isApiUrl = seg.imageB64 && /^(https?:)?\/\//.test(seg.imageB64);
      if (!seg.imageB64 || (!seg.imgObj && !isApiUrl)) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(vid.videoWidth, 512);
        canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * canvas.width);
        canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height);
        seg.imageB64 = canvas.toDataURL('image/jpeg');
        const img = new Image();
        img.onload = () => {
          seg.imgObj = img;
          this.render();
          this.commitChanges(true);
        };
        img.src = seg.imageB64;
      } else {
        if (isApiUrl && !seg.imgObj) {
          seg.imgObj = new Image();
          seg.imgObj.onload = () => { this.render(); };
          seg.imgObj.src = seg.imageB64;
        }
        this.render();
      }
    };

    let seekInitialized = false;
    const initVideoSeek = () => {
      if (seekInitialized) return;
      seekInitialized = true;

      if (vid.duration) {
        const frameRate = this.getFrameRate();
        const clipFrames = Math.max(1, Math.ceil(vid.duration * frameRate));
        seg.videoDurationFrames = clipFrames;
      }

      vid.addEventListener('seeked', onSeekedHandler);
      vid.currentTime = (seg.trimStart || 0) / this.getFrameRate() + 0.01;
      this._ensureThumbnails(seg);
    };

    vid.addEventListener('loadedmetadata', initVideoSeek, { once: true });
    vid.addEventListener('loadeddata', initVideoSeek, { once: true });

    vid.src = vidUrl;

    if (vid.readyState >= 1) {
      initVideoSeek();
    }
  }
,

  async _getOrExtractAudio(seg) {
    if (!seg.audioFile) return;
    const isVideoFile = seg.audioFile.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/);
    if (!isVideoFile) return;

    this._audioExtractionPromises = this._audioExtractionPromises || new Map();
    const fileKey = seg.audioFile;

    if (this._audioExtractionPromises.has(fileKey)) {
      try {
        const res = await this._audioExtractionPromises.get(fileKey);
        if (res && res.audio_file && res.peaks) {
          seg.audioFile = res.audio_file;
          seg.waveformPeaks = res.peaks;
        }
      } catch (err) {
        console.warn("[LTXDirector] Awaiting shared server audio extract promise failed:", err);
      }
      return;
    }

    const extractionPromise = (async () => {
      const resp = await api.fetchApi(`/minimax_ref/api/h3/ltx_director_get_audio?filename=${encodeURIComponent(fileKey)}`);
      if (resp.status === 200) {
        return await resp.json();
      }
      throw new Error(`Server returned status ${resp.status}`);
    })();

    this._audioExtractionPromises.set(fileKey, extractionPromise);

    try {
      const res = await extractionPromise;
      if (res && res.audio_file && res.peaks) {
        seg.audioFile = res.audio_file;
        seg.waveformPeaks = res.peaks;

        // Update all other segments matching this fileKey in the timeline
        const allAudioSegs = this.timeline.audioSegments || [];
        for (const s of allAudioSegs) {
          if (s.audioFile === fileKey) {
            s.audioFile = res.audio_file;
            s.waveformPeaks = res.peaks;
          }
        }
      }
    } catch (err) {
      console.warn("[LTXDirector] Server audio check/extract failed:", err);
    } finally {
      this._audioExtractionPromises.delete(fileKey);
    }
  }
,

  _extractAudioOnClient(file, audSegId, blobUrl) {
    (async () => {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const channelData = audioBuffer.getChannelData(0);
        const peaks = [];
        const numPeaks = 200;
        const step = Math.floor(channelData.length / numPeaks);
        for (let i = 0; i < numPeaks; i++) {
          let max = 0;
          for (let j = 0; j < step; j++) {
            const val = Math.abs(channelData[i * step + j]);
            if (val > max) max = val;
          }
          peaks.push(max);
        }
        for (let s of this.timeline.audioSegments) {
          if (s.id === audSegId || (blobUrl && s._blobUrl === blobUrl)) {
            s.waveformPeaks = peaks;
            s._decoding = false;
            s._audioBuffer = audioBuffer;
          }
        }
        this.render();
      } catch (e) {
        console.warn("No audio in video or decode failed", e);
        for (let s of this.timeline.audioSegments) {
          if (s.id === audSegId || (blobUrl && s._blobUrl === blobUrl)) {
            s._decoding = false;
          }
        }
        this.render();
      }
    })();
  }
,

  _isAudioDecodingAllowed(seg) {
    if (seg.audioFile && seg.audioFile.toLowerCase().match(/\.(wav|mp3|ogg|flac|m4a)$/)) {
      return true;
    }
    const isVideo = (seg.audioFile && seg.audioFile.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/)) ||
      (!seg.audioFile && seg._blobUrl);
    if (isVideo) {
      const isSmall = seg.fileSize && seg.fileSize <= 100 * 1024 * 1024;
      return !!isSmall;
    }
    return true;
  }
,

  async _preloadAudioSegment(seg) {
    if (seg._audioBuffer || seg._decoding) return;
    if (!seg.audioFile && !seg._blobUrl) return;

    seg._decoding = true;
    if (!this._isDragging) this.render();

    try {
      await this._getOrExtractAudio(seg);

      if (!this._isAudioDecodingAllowed(seg)) {
        seg._decoding = false;
        return;
      }

      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      const parts = (seg.audioFile || "").split(/[/\\\\]/);
      const filename = parts.pop() || '';
      const subfolder = parts.join('/');
      const audioUrl = seg._blobUrl || viewUrl(filename, subfolder);

      this._audioBufferCache = this._audioBufferCache || new Map();
      this._audioBufferPromises = this._audioBufferPromises || new Map();
      const cacheKey = seg.audioFile || audioUrl;

      let audioBuffer;
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

      const matchingSegs = this.timeline.audioSegments.filter(s => s.audioFile === seg.audioFile || s._blobUrl === seg._blobUrl);
      for (const s of matchingSegs) {
        s._audioBuffer = audioBuffer;
        s._decoding = false;
      }
    } catch (err) {
      console.warn("Failed to preload audio segment:", err);
      seg._decoding = false;
    } finally {
      if (!this._isDragging) this.render();
    }
  }
,

  loadMedia() {
    for (const seg of this.timeline.segments) {
      if (seg.imageB64 && !seg.imgObj) {
        seg.imgObj = new Image();
        seg.imgObj.onload = () => { if (!this._isDragging) this.render(); };
        seg.imgObj.src = seg.imageB64;
      }
      if (seg.type === "video") {
        this._ensureVideoEl(seg);
        this._ensureThumbnails(seg);
      }
    }

    if (this.timeline.audioSegments) {
      for (const seg of this.timeline.audioSegments) {
        if (seg.type === "audio") {
          this._preloadAudioSegment(seg);
        }
      }
    }

  }
,

  async handleImageUpload(files, targetFrameStart = null, explicitLength = null, seg = null) {
    const frameRate = this.getFrameRate();
    const durationFrames = this.getDurationFrames();
    const newLength = explicitLength !== null ? explicitLength : frameRate * 1; // Default to 1 second long

    for (let file of files) {
      const nameLower = file.name.toLowerCase();
      if (!(file.type.startsWith("image/") || nameLower.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/))) continue;

      await new Promise(async (resolve) => {
        try {
          const up = await uploadImage(file, "whatdreamscost");
          if (!up) { resolve(); return; }
          const { imageFile, imgUrl } = up;

          const img = new Image();
          img.onload = () => {
            if (!seg) {
              let newStart = targetFrameStart;
              if (newStart === null) {
                // Fallback: find the first free slot, or append past the end
                newStart = 0;
                this.timeline.segments.sort((a, b) => a.start - b.start);
                for (let i = 0; i < this.timeline.segments.length; i++) {
                  let seg = this.timeline.segments[i];
                  if (newStart + newLength <= seg.start) break;
                  newStart = Math.max(newStart, seg.start + seg.length);
                }
              }

              // Use the visual timeline as the physics bound so segments can
              // land anywhere in the padded visual area without touching duration_frames.
              const currentDuration = this.getVisualDurationFrames();

              if (targetFrameStart !== null) {
                // Resolve physics to push existing segments
                let tempId = "TEMP_" + Date.now();
                this.timeline.segments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
                let physicsCenter = newStart + this.getFrameRate() / 2;
                let result = this._applyCenterDragPhysics(this.timeline.segments, tempId, newStart, physicsCenter, currentDuration, currentDuration, 1);

                let siblingPhysics = (this.timeline.audioSegments || []).map(s => ({ ...s }));

                this._resolveGlobalPhysics(result, siblingPhysics, currentDuration, this.timeline.segments, this.timeline.audioSegments);

                // Update original segments with resolved physics to preserve imgObj
                for (let shiftedSeg of result) {
                  let original = this.timeline.segments.find(s => s.id === shiftedSeg.id);
                  if (original) {
                    original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
                  }
                }

                for (let shiftedSib of siblingPhysics) {
                  let originalSib = this.timeline.audioSegments.find(s => s.id === shiftedSib.id);
                  if (originalSib) {
                    originalSib.start = shiftedSib.start;
                  }
                }

                let tempSeg = this.timeline.segments.find(s => s.id === tempId);
                newStart = tempSeg.start;
                this.timeline.segments = this.timeline.segments.filter(s => s.id !== tempId);
                targetFrameStart = newStart + newLength; // For the next file in batch
              }

              // Use the full intended length — the timeline has already been grown to fit.
              let constrainedLength = newLength;

              seg = {
                id: genId(),
                start: newStart,
                length: constrainedLength,
                prompt: "",
                type: "image",
                imageFile: imageFile,
                imageB64: imgUrl
              };
              const displayImg = new Image();
              displayImg.onload = () => {
                seg.imgObj = displayImg;
                this.render();
                resolve(); // Resolve promise letting next image process
              };
              displayImg.src = imgUrl;
              this.timeline.segments.push(seg);
              this.timeline.segments.sort((a, b) => a.start - b.start);
              this.selectionType = "image";
              this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);

              this.growTimelineIfNeeded(seg.start + seg.length);
            } else {
              seg.type = "image";
              seg.imageFile = imageFile;
              seg.imageB64 = imgUrl;
              const displayImg = new Image();
              displayImg.onload = () => {
                seg.imgObj = displayImg;
                this.render();
                resolve(); // Resolve promise letting next image process
              };
              displayImg.src = imgUrl;
              this.selectionType = "image";
            }
            this.updateUIFromSelection();
            this.commitChanges(true);
          };
          img.src = imgUrl;
        } catch (err) {
          console.error("[PromptRelay] Image upload failed", err);
          resolve();
        }
      });
    }
    this.fileInput.value = "";
  }
,

  async _uploadVideoFile(file) {
    const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB
    const safeFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');

    // First check if the file already exists on the server to de-duplicate
    try {
      const checkResp = await api.fetchApi(`/minimax_ref/api/h3/ltx_director_check_file?filename=${encodeURIComponent(safeFileName)}&size=${file.size}`);
      if (checkResp.status === 200) {
        const checkResult = await checkResp.json();
        if (checkResult.exists) {
          console.log(`[LTXDirector] File already exists: ${checkResult.name}. Reusing existing file.`);
          return checkResult.name;
        }
      }
    } catch (e) {
      console.warn("[LTXDirector] Failed to check for existing file, proceeding with upload", e);
    }

    if (file.size > CHUNK_SIZE) {
      // --- Chunked path ---
      const safeName = Date.now() + "_" + safeFileName;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const formData = new FormData();
        formData.append("file", chunk);
        formData.append("filename", safeName);
        formData.append("chunk_index", i);
        formData.append("total_chunks", totalChunks);
        const resp = await api.fetchApi("/minimax_ref/api/h3/ltx_director_upload_chunk", { method: "POST", body: formData });
        if (resp.status !== 200) throw new Error("LTX Director video chunk upload failed");
      }
      return safeName; // filename (no subfolder) in the input dir
    } else {
      // --- Single-shot path (small file) ---
      const up = await uploadImage(file, "whatdreamscost");
      if (!up) throw new Error("LTX Director video upload failed");
      return up.imageFile;
    }
  }
,

  async handleVideoUpload(files, targetFrameStart = null, seg = null) {
    const frameRate = this.getFrameRate();

    for (let file of files) {
      const nameLower = file.name.toLowerCase();
      if (!(file.type.startsWith("video/") || nameLower.match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/))) continue;

      await new Promise(async (resolve) => {
        try {
          // Use a local blob URL so the video element loads instantly from disk —
          // no waiting for the server upload before the segment appears.
          const blobUrl = URL.createObjectURL(file);

          const vid = document.createElement('video');
          vid.crossOrigin = "Anonymous";
          vid.preload = 'auto';
          vid.muted = true;

          vid.onloadeddata = async () => {
            vid.onloadeddata = null; // prevent re-firing if src changes or browser buffers more data
            const clipDurationSecs = vid.duration || 1;
            const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));

            // 文本段 → 视频段：原位转换（不新增段、不改位置），转换后立即 resolve
            if (seg && seg.type === "text") {
              this._applyVideoToTextSegment(seg, vid, file, blobUrl, clipFrames);
              resolve();
              return;
            }

            let newLength = clipFrames;
            let newStart = targetFrameStart;

            if (newStart === null) {
              newStart = 0;
              this.timeline.segments.sort((a, b) => a.start - b.start);
              for (let i = 0; i < this.timeline.segments.length; i++) {
                let seg = this.timeline.segments[i];
                if (newStart + newLength <= seg.start) break;
                newStart = Math.max(newStart, seg.start + seg.length);
              }
            }

            const currentDuration = this.getVisualDurationFrames();

            if (targetFrameStart !== null) {
              let tempId = "TEMP_" + Date.now();
              let tempVidId = tempId + "_v";
              let tempAudId = tempId + "_a";

              this.timeline.segments.push({ id: tempVidId, start: newStart, length: newLength, type: "temp" });
              this.timeline.audioSegments.push({ id: tempAudId, start: newStart, length: newLength, type: "temp" });

              let physicsCenter = newStart + this.getFrameRate() / 2;

              let resultSegments = this._applyCenterDragPhysics(this.timeline.segments, tempVidId, newStart, physicsCenter, currentDuration, currentDuration, 1);
              let resultAudioSegments = this._applyCenterDragPhysics(this.timeline.audioSegments, tempAudId, newStart, physicsCenter, currentDuration, currentDuration, 1);

              this._resolveGlobalPhysics(resultSegments, resultAudioSegments, currentDuration, this.timeline.segments, this.timeline.audioSegments);

              for (let shiftedSeg of resultSegments) {
                let original = this.timeline.segments.find(s => s.id === shiftedSeg.id);
                if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
              }
              for (let shiftedSib of resultAudioSegments) {
                let originalSib = this.timeline.audioSegments.find(s => s.id === shiftedSib.id);
                if (originalSib) originalSib.start = shiftedSib.resolvedStart !== undefined ? shiftedSib.resolvedStart : shiftedSib.start;
              }

              let tempVidSeg = resultSegments.find(s => s.id === tempVidId);
              newStart = tempVidSeg.start;
              this.timeline.segments = this.timeline.segments.filter(s => s.id !== tempVidId);
              this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== tempAudId);
              targetFrameStart = newStart + newLength;
            }

            const sharedId = genId();

            const vidSeg = {
              id: sharedId + "_v",
              type: "video",
              start: newStart,
              length: newLength,
              trimStart: 0,
              videoDurationFrames: clipFrames,
              imageFile: "",  // filled in once background upload completes
              fileName: file.name,
              prompt: "",
              videoEl: vid,
              _uploading: true,
              _blobUrl: blobUrl,
              fileSize: file.size
            };

            const audSeg = {
              id: sharedId + "_a",
              type: "audio",
              start: newStart,
              length: newLength,
              trimStart: 0,
              audioDurationFrames: clipFrames,
              audioFile: "",  // filled in once background upload completes
              fileName: file.name,
              waveformPeaks: [],
              _uploading: true,
              _decoding: true,
              _blobUrl: blobUrl,
              fileSize: file.size
            };

            // Extract first-frame thumbnail from local blob — instant
            vid.currentTime = 0.01;
            vid.onseeked = () => {
              vid.onseeked = null;
              const canvas = document.createElement('canvas');
              canvas.width = Math.min(vid.videoWidth, 512);
              canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * canvas.width);
              const ctx = canvas.getContext('2d');
              ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
              vidSeg.imageB64 = canvas.toDataURL('image/jpeg');

              const imgObj = new Image();
              imgObj.onload = () => { vidSeg.imgObj = imgObj; this.render(); };
              imgObj.src = vidSeg.imageB64;

              // Add to timeline immediately
              this.timeline.segments.push(vidSeg);
              this.timeline.audioSegments.push(audSeg);
              this.timeline.segments.sort((a, b) => a.start - b.start);
              this.timeline.audioSegments.sort((a, b) => a.start - b.start);

              this.selectionType = "image";
              this.selectedIndex = this.timeline.segments.findIndex(s => s.id === vidSeg.id);
              this.updateUIFromSelection();
              this.commitChanges(true);
              resolve(); // resolve immediately — don't block on upload
              this._ensureThumbnails(vidSeg);

              // Background audio extraction (waveform peaks) — runs while user can already work
              const IS_LARGE_FILE = file.size > 100 * 1024 * 1024;
              if (IS_LARGE_FILE) {
                console.log(`[LTXDirector] Large file detected (${(file.size / 1024 / 1024).toFixed(1)} MB). Offloading audio extraction to server.`);
              } else {
                this._extractAudioOnClient(file, audSeg.id, blobUrl);
              }

              // Background upload — runs while the user can already work.
              // We intentionally do NOT change vid.src after upload — the blob URL
              // works perfectly for local playback. Only imageFile/audioFile
              // need updating so Python can find the file at generation time.
              // 后台：上传文件 + 回填 imageFile/audioFile + 波形提取（与文本段转换共用）
              this._backgroundUploadVideo(file, blobUrl, vidSeg, audSeg);
            };
          };

          vid.onerror = (e) => {
            console.error("Video load error", e);
            URL.revokeObjectURL(blobUrl);
            alert("Video Load Error:\n\nThis video format or codec is not supported by your web browser (e.g., MKV or ProRes).\n\nPlease convert the video to a standard MP4 (H.264 / AAC) to use it on the timeline.");
            resolve();
          };

          vid.src = blobUrl;

        } catch (err) {
          console.error("Video upload failed", err);
          resolve();
        }
      });
    }

    if (this.videoFileInput) {
      this.videoFileInput.value = "";
    }
  }
,

  // 文本段 → 视频段原位转换：保留 start/length/prompt/h3PromptJson/motionContext/autoEndFrame，
  // 附加视频字段并创建 _a 音频兄弟（与既有视频段 id 惯例一致，便于链接/解除链接逻辑）
  _applyVideoToTextSegment(seg, vid, file, blobUrl, clipFrames) {
    const sharedBase = seg.id.endsWith("_v") ? seg.id.slice(0, -2) : seg.id;
    const newVidId = sharedBase + "_v";
    const newAudId = sharedBase + "_a";

    // 幂等：清理可能已存在的同名段（防止重复转换）
    this.timeline.segments = this.timeline.segments.filter(s => s.id !== newVidId);
    this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== newAudId);

    // 原文本段改造为视频段（文本专属字段 prompt/h3PromptJson/motionContext/autoEndFrame 保留）
    seg.id = newVidId;
    seg.type = "video";
    seg.trimStart = 0;
    seg.videoDurationFrames = clipFrames;
    seg.imageFile = ""; // 后台上传完成后回填
    seg.fileName = file.name;
    seg.videoEl = vid;
    seg._uploading = true;
    seg._blobUrl = blobUrl;
    seg.fileSize = file.size;

    const audSeg = {
      id: newAudId,
      type: "audio",
      start: seg.start,
      length: seg.length,
      trimStart: 0,
      audioDurationFrames: clipFrames,
      audioFile: "", // 后台上传完成后回填
      fileName: file.name,
      waveformPeaks: [],
      _uploading: true,
      _decoding: true,
      _blobUrl: blobUrl,
      fileSize: file.size
    };
    this.timeline.audioSegments.push(audSeg);
    this.timeline.audioSegments.sort((a, b) => a.start - b.start);

    // 提取首帧缩略图（本地 blob，即时）
    vid.currentTime = 0.01;
    vid.onseeked = () => {
      vid.onseeked = null;
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(vid.videoWidth, 512);
      canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * canvas.width);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
      seg.imageB64 = canvas.toDataURL('image/jpeg');
      const imgObj = new Image();
      imgObj.onload = () => { seg.imgObj = imgObj; this.render(); };
      imgObj.src = seg.imageB64;
      this.selectionType = "image";
      this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);
      this.updateUIFromSelection();
      this.commitChanges(true);
      this._ensureThumbnails(seg);
    };

    // 后台：上传文件 + 回填 imageFile/audioFile + 波形提取
    this._backgroundUploadVideo(file, blobUrl, seg, audSeg);
  }
,

  // 后台上传视频文件并回填 imageFile/audioFile/波形峰值（添加视频与文本段转换共用）
  _backgroundUploadVideo(file, blobUrl, vidSeg, audSeg) {
    const IS_LARGE_FILE = file.size > 100 * 1024 * 1024;
    this._uploadVideoFile(file).then(filePath => {
      for (let s of this.timeline.segments) {
        if (s._blobUrl === blobUrl || s.id === vidSeg.id) {
          s.imageFile = filePath;
          // 上传完成后把 imageB64 从首帧 base64 缩略图替换为服务器 API 路径，
          // imgObj 已加载 base64，仍可本地即时预览，两者互不影响。
          s.imageB64 = viewUrl(filePath);
          s._uploading = false;
        }
      }
      for (let s of this.timeline.audioSegments) {
        if (s._blobUrl === blobUrl || s.id === audSeg.id) {
          s.audioFile = filePath;
          s._uploading = false;
        }
      }
      if (blobUrl && filePath) {
        this._thumbnailCache = this._thumbnailCache || new Map();
        this._thumbnailPromises = this._thumbnailPromises || new Map();
        if (this._thumbnailCache.has(blobUrl)) {
          this._thumbnailCache.set(filePath, this._thumbnailCache.get(blobUrl));
        }
        if (this._thumbnailPromises.has(blobUrl)) {
          this._thumbnailPromises.set(filePath, this._thumbnailPromises.get(blobUrl));
        }
      }

      // Query server for extracted WAV audio file and waveform peaks
      if (filePath) {
        api.fetchApi(`/minimax_ref/api/h3/ltx_director_get_audio?filename=${encodeURIComponent(filePath)}`)
          .then(r => r.json())
          .then(res => {
            if (res.audio_file && res.peaks) {
              for (let s of this.timeline.audioSegments) {
                if (s.audioFile === filePath || s._blobUrl === blobUrl) {
                  s.audioFile = res.audio_file;
                  s.waveformPeaks = res.peaks;
                  s._decoding = false;
                  this._preloadAudioSegment(s);
                }
              }
            } else {
              // Fallback
              if (IS_LARGE_FILE) {
                console.warn("[LTXDirector] Server audio extraction failed for large file, skipping.");
                for (let s of this.timeline.audioSegments) {
                  if (s.audioFile === filePath || s._blobUrl === blobUrl) {
                    s._decoding = false;
                  }
                }
              } else {
                this._extractAudioOnClient(file, audSeg.id, blobUrl);
              }
            }
            this.commitChanges(true);
            this.render();
          })
          .catch(err => {
            console.error("[LTXDirector] Server audio extraction query failed:", err);
            for (let s of this.timeline.audioSegments) {
              if (s.audioFile === filePath || s._blobUrl === blobUrl) {
                s._decoding = false;
              }
            }
            this.render();
          });
      } else {
        this.commitChanges(true);
        this.render();
      }
    }).catch(err => {
      console.error("[LTXDirector] Background video upload failed", err);
      const currentVidSeg = this.timeline.segments.find(s => s.id === vidSeg.id);
      if (currentVidSeg) currentVidSeg._uploading = false;
      const currentAudSeg = this.timeline.audioSegments.find(s => s.id === audSeg.id);
      if (currentAudSeg) currentAudSeg._uploading = false;
      this.render();
    });
  }
,

  async generateVideoPreviewThumbs(file, count = 18) {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("preview metadata failed"));
    });
    const duration = Math.max(0.001, video.duration || 0.001);
    const canvas = document.createElement("canvas");
    const maxW = 160, maxH = 90;
    const scale = Math.min(maxW / Math.max(1, video.videoWidth || maxW), maxH / Math.max(1, video.videoHeight || maxH));
    canvas.width = Math.max(1, Math.round((video.videoWidth || maxW) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || maxH) * scale));
    const ctx = canvas.getContext("2d");
    const thumbs = [];
    const seekTo = (t) => new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          thumbs.push(canvas.toDataURL("image/jpeg", 0.78));
        } catch (_) { }
        resolve();
      };
      video.onseeked = done;
      video.currentTime = Math.min(duration - 0.001, Math.max(0, t));
      setTimeout(done, 700);
    });
    for (let i = 0; i < count; i++) {
      const t = (duration * (i + 0.5)) / count;
      await seekTo(t);
    }
    URL.revokeObjectURL(url);
    return thumbs.filter(Boolean);
  }
,

  async handleAudioUpload(files, targetFrameStart = null) {
    const frameRate = this.getFrameRate();
    const durationFrames = this.getDurationFrames();

    for (let file of files) {
      const nameLower = file.name.toLowerCase();
      if (!(file.type.startsWith("audio/") || nameLower.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/))) continue;

      await new Promise(async (resolve) => {
        try {
          const up = await uploadImage(file, "whatdreamscost");
          if (!up) { resolve(); return; }
          const audioFile = up.imageFile;

          const arrayBuffer = await file.arrayBuffer();
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          const clipDurationSecs = audioBuffer.duration;
          const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));

          const channelData = audioBuffer.getChannelData(0);
          const peaks = [];
          const numPeaks = 200;
          const step = Math.floor(channelData.length / numPeaks);
          for (let i = 0; i < numPeaks; i++) {
            let max = 0;
            for (let j = 0; j < step; j++) {
              const val = Math.abs(channelData[i * step + j]);
              if (val > max) max = val;
            }
            peaks.push(max);
          }

          let newLength = clipFrames;
          let newStart = targetFrameStart;

          if (newStart === null) {
            // Find the first free slot, or place past the end of all existing audio
            newStart = 0;
            this.timeline.audioSegments.sort((a, b) => a.start - b.start);
            for (let i = 0; i < this.timeline.audioSegments.length; i++) {
              let seg = this.timeline.audioSegments[i];
              if (newStart + newLength <= seg.start) break;
              newStart = Math.max(newStart, seg.start + seg.length);
            }
          }

          // Use the visual timeline as the physics bound so segments can
          // land anywhere in the padded visual area without touching duration_frames.
          const currentDuration = this.getVisualDurationFrames();

          if (targetFrameStart !== null) {
            let tempId = "TEMP_" + Date.now();
            this.timeline.audioSegments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
            let physicsCenter = newStart + this.getFrameRate() / 2;
            let result = this._applyCenterDragPhysics(this.timeline.audioSegments, tempId, newStart, physicsCenter, currentDuration, currentDuration, 1);

            let siblingPhysics = (this.timeline.segments || []).map(s => ({ ...s }));

            this._resolveGlobalPhysics(siblingPhysics, result, currentDuration, this.timeline.segments, this.timeline.audioSegments);

            for (let shiftedSeg of result) {
              let original = this.timeline.audioSegments.find(s => s.id === shiftedSeg.id);
              if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
            }

            for (let shiftedSib of siblingPhysics) {
              let originalSib = this.timeline.segments.find(s => s.id === shiftedSib.id);
              if (originalSib) {
                originalSib.start = shiftedSib.start;
              }
            }

            let tempSeg = this.timeline.audioSegments.find(s => s.id === tempId);
            newStart = tempSeg.start;
            this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== tempId);
            targetFrameStart = newStart + newLength;
          }

          // Use the full clip length — timeline has already grown to fit.
          let constrainedLength = newLength;

          const seg = {
            id: genId(),
            type: "audio",
            start: newStart,
            length: constrainedLength,
            trimStart: 0,
            audioDurationFrames: clipFrames,
            audioFile: audioFile,
            fileName: file.name,
            waveformPeaks: peaks,
            _audioBuffer: audioBuffer
          };

          this.timeline.audioSegments.push(seg);
          this.timeline.audioSegments.sort((a, b) => a.start - b.start);

          this.selectionType = "audio";
          this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === seg.id);

          this.updateUIFromSelection();
          this.commitChanges(true);
          this.render();
          resolve();
        } catch (err) {
          console.error("[PromptRelay] Audio processing failed", err);
          resolve();
        }
      });
    }
    this.audioFileInput.value = "";
  }
};
