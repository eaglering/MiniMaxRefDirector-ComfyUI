// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: onContextMenu, _deleteRetakeVideo, _showRetakeContextMenu, _checkClipboardForImage, _checkClipboardForText, showContextMenu, showGapContextMenu, dismissContextMenu, showGapMenu, dismissGapMenu
import { ICONS, RULER_HEIGHT, api } from "./shared.js";

export const menus = {
  onContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();

    // In retake mode: suppress the normal timeline context menu entirely.
    // If a retake video is loaded, show a minimal retake-specific menu instead.
    if (this.retakeMode) {
      if (this.timeline.retakeVideo) {
        this._showRetakeContextMenu(e.clientX, e.clientY);
      }
      return;
    }

    const { x: mouseX, y: mouseY } = this.getMousePos(e);

    const trackHeight = this.blockHeight;
    const isAudioTrack = mouseY >= RULER_HEIGHT + trackHeight && mouseY <= RULER_HEIGHT + trackHeight + this.audioTrackHeight;
    const isImageTrack = mouseY >= RULER_HEIGHT && mouseY <= RULER_HEIGHT + trackHeight;

    const logicalWidth = this.canvas.offsetWidth || 1;
    const totalFrames = this.getVisualDurationFrames();
    const cursor = mouseX * (totalFrames / logicalWidth);

    let clickedSeg = null;
    let trackType = "";

    if (isAudioTrack) {
      clickedSeg = this.timeline.audioSegments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = "audio";
    } else if (isImageTrack) {
      clickedSeg = this.timeline.segments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = clickedSeg ? clickedSeg.type : "";
    }

    if (clickedSeg) {
      this.showContextMenu(e.clientX, e.clientY, clickedSeg, trackType);
    } else if (isImageTrack || isAudioTrack) {
      const gapRegions = this.getGapRegions();
      const currentTrack = isAudioTrack ? "audio" : "image";
      let gap = gapRegions.find(g => cursor >= g.frameStart && cursor <= g.frameEnd && g.track === currentTrack);

      if (!gap) {
        const startFrame = Math.round(cursor);
        gap = {
          track: currentTrack,
          frameStart: startFrame,
          frameEnd: startFrame + Math.max(1, this.getFrameRate())
        };
      }
      gap.clickedFrame = cursor;

      this.showGapContextMenu(e.clientX, e.clientY, gap);
    }
  },

  _deleteRetakeVideo() {
    if (!this.timeline.retakeVideo) return;
    // Clean up the video element
    const vid = this.timeline.retakeVideo;
    if (vid.videoEl) {
      vid.videoEl.pause();
      vid.videoEl.src = "";
      vid.videoEl.load();
    }
    if (vid._blobUrl) {
      URL.revokeObjectURL(vid._blobUrl);
    }
    this.timeline.retakeVideo = null;
    this.timeline.retakeStart = 0;
    this.timeline.retakeLength = this.getDurationFrames();
    this.commitChanges();
    this.render();
  },

  _showRetakeContextMenu(clientX, clientY) {
    this.dismissContextMenu();

    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "pr-gap-menu-btn";
    deleteBtn.innerHTML = `${ICONS.trash} Delete`;
    deleteBtn.style.color = "#ffaaaa";
    deleteBtn.onclick = () => {
      this.dismissContextMenu();
      this._deleteRetakeVideo();
    };
    menu.appendChild(deleteBtn);

    document.body.appendChild(menu);
    this._contextMenu = menu;
    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
      document.addEventListener("wheel", this._contextMenuDismisser, true);
    }, 0);
  },

  async _checkClipboardForImage(btn) {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: "clipboard-read" });
        if (status.state === "granted") {
          const items = await navigator.clipboard.read();
          let hasImg = false;
          for (const item of items) {
            if (item.types.some(t => t.startsWith("image/"))) {
              hasImg = true;
              break;
            }
          }
          if (!hasImg) {
            btn.disabled = true;
            btn.style.opacity = "0.4";
            btn.style.cursor = "not-allowed";
            btn.title = "No image found in clipboard";
          }
        } else if (status.state === "denied") {
          btn.disabled = true;
          btn.style.opacity = "0.4";
          btn.style.cursor = "not-allowed";
          btn.title = "Clipboard permission denied";
        }
      }
    } catch (e) {
      console.warn("Clipboard read permission query failed:", e);
    }
  },

  async _checkClipboardForText(btn) {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: "clipboard-read" });
        if (status.state === "granted") {
          const text = await navigator.clipboard.readText();
          if (!text || text.trim() === "") {
            btn.disabled = true;
            btn.style.opacity = "0.4";
            btn.style.cursor = "not-allowed";
            btn.title = "No text found in clipboard";
          }
        } else if (status.state === "denied") {
          btn.disabled = true;
          btn.style.opacity = "0.4";
          btn.style.cursor = "not-allowed";
          btn.title = "Clipboard permission denied";
        }
      }
    } catch (e) {
      console.warn("Clipboard read text permission query failed:", e);
    }
  },

  showContextMenu(clientX, clientY, seg, trackType) {
    this.dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const isImage = trackType === "image" && seg.imageB64;

    const makeDivider = () => {
      const d = document.createElement("div");
      d.className = "pr-settings-divider";
      return d;
    };

    // ==========================================
    // 1. Define Segment options (Copy, Paste, Replace Segment, Split)
    // ==========================================
    const copySegBtn = document.createElement("button");
    copySegBtn.className = "pr-gap-menu-btn";
    copySegBtn.innerHTML = `Copy Segment`;
    copySegBtn.onclick = () => {
      this._copiedSegment = { ...seg, id: Date.now().toString() + Math.random().toString(36).substr(2, 5) };
      this._copiedSegmentTrack = trackType;
      window._ltxCopiedSegment = { main: { ...seg }, sibling: null };
      window._ltxCopiedSegmentType = this.getCanonicalTrack(trackType);
      if (seg.imgObj) window._ltxCopiedSegment.main.imgObj = seg.imgObj;
      if (seg.videoEl) window._ltxCopiedSegment.main.videoEl = seg.videoEl;

      if (seg.id && (seg.id.endsWith("_v") || seg.id.endsWith("_a"))) {
        const isVid = seg.id.endsWith("_v");
        const sibId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
        const sibArr = isVid ? this.timeline.audioSegments : this.timeline.segments;
        const sib = sibArr.find(s => s.id === sibId);
        if (sib) {
          window._ltxCopiedSegment.sibling = { ...sib };
          if (sib.imgObj) window._ltxCopiedSegment.sibling.imgObj = sib.imgObj;
          if (sib.videoEl) window._ltxCopiedSegment.sibling.videoEl = sib.videoEl;
        }
      }
      this.dismissContextMenu();
    };

    const hasCopied = this._copiedSegment || window._ltxCopiedSegment;
    const copiedTrack = this._copiedSegmentTrack || window._ltxCopiedSegmentType;
    const copiedSegData = this._copiedSegment || (window._ltxCopiedSegment ? window._ltxCopiedSegment.main : null);
    const copiedSibData = window._ltxCopiedSegment ? window._ltxCopiedSegment.sibling : null;

    const canPaste = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(trackType) && copiedSegData;
    const pasteSegBtn = document.createElement("button");
    pasteSegBtn.className = "pr-gap-menu-btn";
    pasteSegBtn.innerHTML = `Paste Segment`;
    if (!canPaste) {
      pasteSegBtn.disabled = true;
      pasteSegBtn.style.opacity = "0.4";
      pasteSegBtn.style.cursor = "not-allowed";
      pasteSegBtn.title = "No matching segment copied to clipboard";
    } else {
      pasteSegBtn.onclick = () => {
        const startFrame = Math.round(this.currentFrame);
        this.pasteSegmentAtFrame(copiedSegData, this.getCanonicalTrack(copiedTrack), copiedSibData, startFrame);
        this.dismissContextMenu();
      };
    }

    const currentTrack = trackType;
    const canReplace = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(currentTrack) && copiedSegData;
    const pasteReplaceBtn = document.createElement("button");
    pasteReplaceBtn.className = "pr-gap-menu-btn";
    pasteReplaceBtn.innerHTML = `Replace Segment`;
    if (!canReplace) {
      pasteReplaceBtn.disabled = true;
      pasteReplaceBtn.style.opacity = "0.4";
      pasteReplaceBtn.style.cursor = "not-allowed";
      pasteReplaceBtn.title = "No matching segment copied to clipboard";
    } else {
      pasteReplaceBtn.onclick = () => {
        const newSeg = {
          ...copiedSegData,
          id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
          start: seg.start,
          length: copiedSegData.length
        };
        const targetArray = this.getSegmentArray(this.getCanonicalTrack(currentTrack));
        const idx = targetArray.findIndex(s => s.id === seg.id);
        if (idx >= 0) targetArray[idx] = newSeg;
        this.commitChanges();
        this.dismissContextMenu();
      };
    }

    let splitBtn = null;
    const splitFrame = Math.round(this.currentFrame);
    if (splitFrame > seg.start && splitFrame < seg.start + seg.length) {
      splitBtn = document.createElement("button");
      splitBtn.className = "pr-gap-menu-btn";
      splitBtn.innerHTML = `Split at Playhead`;
      splitBtn.onclick = () => {
        this.splitSegmentAtPlayhead(seg, trackType);
        this.dismissContextMenu();
      };
    }

    // ==========================================
    // 2. Define Prompt options (if not audio)
    // ==========================================
    let copyPromptBtn = null;
    let pastePromptBtn = null;
    if (trackType !== "audio") {
      copyPromptBtn = document.createElement("button");
      copyPromptBtn.className = "pr-gap-menu-btn";
      copyPromptBtn.innerHTML = `Copy Prompt`;
      copyPromptBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(seg.prompt || "");
        } catch (err) {
          console.error("Failed to copy prompt", err);
        }
        this.dismissContextMenu();
      };

      pastePromptBtn = document.createElement("button");
      pastePromptBtn.className = "pr-gap-menu-btn";
      pastePromptBtn.innerHTML = `Paste Prompt`;
      this._checkClipboardForText(pastePromptBtn);
      pastePromptBtn.onclick = async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            seg.prompt = text;
            this.commitChanges();
            this.render();
            if (this.selectedIndex === this.timeline.segments.findIndex(s => s.id === seg.id)) {
              this.updateUIFromSelection();
            }
          }
        } catch (err) {
          console.error("Failed to paste prompt", err);
        }
        this.dismissContextMenu();
      };
    }

    // ==========================================
    // 3. Define Image options (if isImage)
    // ==========================================
    let copyImgBtn = null;
    let saveImgBtn = null;
    let openImgBtn = null;
    let replaceImgBtn = null;
    let replaceWithFileBtn = null;

    if (isImage) {
      let fullResUrl = seg.imageB64;
      const fileKey = seg.imageFile || seg.videoFile;
      if (fileKey) {
        const parts = fileKey.split(/[/\\]/);
        const filename = parts.pop();
        const subfolder = parts.join('/');
        fullResUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
      }

      copyImgBtn = document.createElement("button");
      copyImgBtn.className = "pr-gap-menu-btn";
      copyImgBtn.innerHTML = `Copy Image`;
      copyImgBtn.onclick = async () => {
        try {
          const img = new Image();
          img.crossOrigin = "Anonymous";
          img.src = fullResUrl;
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
          });
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          canvas.getContext("2d").drawImage(img, 0, 0);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        } catch (err) {
          console.error("Failed to copy image", err);
        }
        this.dismissContextMenu();
      };

      saveImgBtn = document.createElement("button");
      saveImgBtn.className = "pr-gap-menu-btn";
      saveImgBtn.innerHTML = `Save Image`;
      saveImgBtn.onclick = () => {
        const a = document.createElement("a");
        a.href = fullResUrl;
        a.download = "timeline_image.jpg";
        a.click();
        this.dismissContextMenu();
      };

      openImgBtn = document.createElement("button");
      openImgBtn.className = "pr-gap-menu-btn";
      openImgBtn.innerHTML = `Open Image in New Tab`;
      openImgBtn.onclick = () => {
        const win = window.open();
        if (win) {
          win.document.write(`<body style="margin:0;display:flex;justify-content:center;align-items:center;background:#0e0e0e;height:100vh;"><img style="max-width:100%;max-height:100%;" src="${fullResUrl}" /></body>`);
          win.document.close();
        }
        this.dismissContextMenu();
      };

      replaceImgBtn = document.createElement("button");
      replaceImgBtn.className = "pr-gap-menu-btn";
      replaceImgBtn.innerHTML = `Replace with Copied Image`;
      this._checkClipboardForImage(replaceImgBtn);
      replaceImgBtn.onclick = async () => {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imageTypes = item.types.filter(type => type.startsWith("image/"));
            if (imageTypes.length > 0) {
              const blob = await item.getType(imageTypes[0]);
              const file = new File([blob], "clipboard.png", { type: blob.type });

              const body = new FormData();
              body.append("image", file);
              body.append("subfolder", "whatdreamscost");
              const resp = await api.fetchApi("/upload/image", { method: "POST", body });
              if (resp.status === 200) {
                const data = await resp.json();
                const filename = data.name;
                const subfolder = data.subfolder || "";
                const imageFile = subfolder ? subfolder + "/" + filename : filename;
                const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

                const img = new Image();
                img.onload = () => {
                  seg.imageFile = imageFile;
                  seg.imageB64 = imgUrl;
                  seg.imgObj = img;
                  this.commitChanges();
                  this.render();
                  if (this.selectedIndex === this.getSegmentArray(trackType).findIndex(s => s.id === seg.id)) {
                    this.updateUIFromSelection();
                  }
                };
                img.src = imgUrl;
              }
              break;
            }
          }
        } catch (err) {
          console.error("Failed to read image from clipboard", err);
        }
        this.dismissContextMenu();
      };

      replaceWithFileBtn = document.createElement("button");
      replaceWithFileBtn.className = "pr-gap-menu-btn";
      replaceWithFileBtn.innerHTML = `Replace with...`;
      replaceWithFileBtn.onclick = () => {
        this.dismissContextMenu();
        const fi = document.createElement("input");
        fi.type = "file";
        fi.accept = "image/*";
        fi.addEventListener("change", async (ev) => {
          const file = ev.target.files?.[0];
          if (!file) return;
          try {
            const body = new FormData();
            body.append("image", file);
            body.append("subfolder", "whatdreamscost");
            const resp = await api.fetchApi("/upload/image", { method: "POST", body });
            if (resp.status === 200) {
              const data = await resp.json();
              const filename = data.name;
              const subfolder = data.subfolder || "";
              const imageFile = subfolder ? subfolder + "/" + filename : filename;
              const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

              const img = new Image();
              img.onload = () => {
                seg.imageFile = imageFile;
                seg.imageB64 = imgUrl;
                seg.imgObj = img;
                this.commitChanges();
                this.render();
                if (this.selectedIndex === this.getSegmentArray(trackType).findIndex(s => s.id === seg.id)) {
                  this.updateUIFromSelection();
                }
              };
              img.src = imgUrl;
            }
          } catch (err) {
            console.error("Failed to upload replacement image", err);
          }
        });
        fi.click();
      };
    }

    // ==========================================
    // 4. Define Convert to End Frame options (only image segment with type === "image")
    // ==========================================
    let toggleEndFrameBtn = null;
    if (trackType === "image" && seg.type === "image") {
      toggleEndFrameBtn = document.createElement("button");
      toggleEndFrameBtn.className = "pr-gap-menu-btn";
      if (seg.isEndFrame) {
        toggleEndFrameBtn.innerHTML = `Convert to Start Frame`;
        toggleEndFrameBtn.onclick = () => {
          seg.isEndFrame = false;
          this.commitChanges();
          this.render();
          this.dismissContextMenu();
        };
      } else {
        toggleEndFrameBtn.innerHTML = `Convert to End Frame`;
        toggleEndFrameBtn.onclick = () => {
          seg.isEndFrame = true;
          this.commitChanges();
          this.render();
          this.dismissContextMenu();
        };
      }
    }

    // ==========================================
    // 5. Define Unlink Media & Mark Selection options
    // ==========================================
    const isVidLink = trackType === "video" && seg.id.endsWith("_v");
    const isAudLink = trackType === "audio" && seg.id.endsWith("_a");
    let siblingForUnlink = null;

    if (isVidLink) {
      siblingForUnlink = this.timeline.audioSegments.find(s => s.id === seg.id.slice(0, -2) + "_a");
    } else if (isAudLink) {
      siblingForUnlink = this.timeline.segments.find(s => s.id === seg.id.slice(0, -2) + "_v");
    }

    let unlinkBtn = null;
    if (siblingForUnlink) {
      unlinkBtn = document.createElement("button");
      unlinkBtn.className = "pr-gap-menu-btn";
      unlinkBtn.innerHTML = `Unlink Media`;
      unlinkBtn.onclick = () => {
        seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        siblingForUnlink.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        this.commitChanges();
        this.render();
        this.dismissContextMenu();
      };
    }

    const markSelectionBtn = document.createElement("button");
    markSelectionBtn.className = "pr-gap-menu-btn";
    markSelectionBtn.innerHTML = `Mark Selection`;
    markSelectionBtn.onclick = () => {
      if (this.selectedSegmentIds && this.selectedSegmentIds.includes(seg.id)) {
        this.markCurrentSelection();
      } else {
        this.markSegment(seg);
      }
      this.dismissContextMenu();
    };

    // ==========================================
    // 6. Define Delete Option
    // ==========================================
    const delBtn = document.createElement("button");
    delBtn.className = "pr-gap-menu-btn";
    delBtn.innerHTML = `Delete`;
    delBtn.style.color = "#ff4444";
    delBtn.onclick = () => {
      this.selectionType = trackType;
      const list = this.getSegmentArray(trackType);
      this.selectedIndex = list.findIndex(s => s.id === seg.id);
      this.deleteSelectedSegment();
      this.dismissContextMenu();
    };

    // Very top: Split at Playhead (if active/available)
    if (splitBtn) {
      menu.appendChild(splitBtn);
      menu.appendChild(makeDivider());
    }

    // Group 1: Segment Options (Always present)
    menu.appendChild(copySegBtn);
    menu.appendChild(pasteSegBtn);
    menu.appendChild(pasteReplaceBtn);
    menu.appendChild(makeDivider());

    // Group 2: Prompt Options (Only if not audio)
    if (copyPromptBtn && pastePromptBtn) {
      menu.appendChild(copyPromptBtn);
      menu.appendChild(pastePromptBtn);
      menu.appendChild(makeDivider());
    }

    // Group 3: Image Options (Only if isImage)
    if (isImage) {
      menu.appendChild(copyImgBtn);
      menu.appendChild(saveImgBtn);
      menu.appendChild(openImgBtn);
      menu.appendChild(replaceImgBtn);
      menu.appendChild(replaceWithFileBtn);
      menu.appendChild(makeDivider());
    }

    // Group 4: Convert to End Frame (Only if toggleEndFrameBtn is defined)
    if (toggleEndFrameBtn) {
      menu.appendChild(toggleEndFrameBtn);
      menu.appendChild(makeDivider());
    }

    // Group 5: Unlink Media & Mark Selection
    if (unlinkBtn) {
      menu.appendChild(unlinkBtn);
      menu.appendChild(makeDivider());
    }
    menu.appendChild(markSelectionBtn);
    menu.appendChild(makeDivider());

    // Group 6: Delete Option
    menu.appendChild(delBtn);

    document.body.appendChild(menu);
    this._contextMenu = menu;

    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
    }, 0);
  },

  showGapContextMenu(clientX, clientY, gap) {
    this.dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const currentTrack = gap.track;

    const hasCopied = this._copiedSegment || window._ltxCopiedSegment;
    const copiedTrack = this._copiedSegmentTrack || window._ltxCopiedSegmentType;
    const copiedSegData = this._copiedSegment || (window._ltxCopiedSegment ? window._ltxCopiedSegment.main : null);
    const copiedSibData = window._ltxCopiedSegment ? window._ltxCopiedSegment.sibling : null;

    const canPaste = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(currentTrack) && copiedSegData;
    const pasteBtn = document.createElement("button");
    pasteBtn.className = "pr-gap-menu-btn";
    pasteBtn.innerHTML = `Paste Segment`;
    if (!canPaste) {
      pasteBtn.disabled = true;
      pasteBtn.style.opacity = "0.4";
      pasteBtn.style.cursor = "not-allowed";
      pasteBtn.title = "No matching segment copied to clipboard";
    } else {
      pasteBtn.onclick = () => {
        const startFrame = Math.round(gap.clickedFrame !== undefined ? gap.clickedFrame : gap.frameStart);
        this.pasteSegmentAtFrame(copiedSegData, this.getCanonicalTrack(copiedTrack), copiedSibData, startFrame);
        this.dismissContextMenu();
      };
    }
    menu.appendChild(pasteBtn);

    if (currentTrack === "image") {
      const textBtn = document.createElement("button");
      textBtn.className = "pr-gap-menu-btn";
      textBtn.innerHTML = `${ICONS.text} Text Segment`;
      textBtn.onclick = () => {
        this.addSegmentInGap(gap.frameStart, gap.frameEnd, "text");
        this.dismissContextMenu();
      };
      menu.appendChild(textBtn);

      const imgBtn = document.createElement("button");
      imgBtn.className = "pr-gap-menu-btn";
      imgBtn.innerHTML = `${ICONS.upload} Image Segment`;
      imgBtn.onclick = () => {
        this.dismissContextMenu();
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = "image/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) {
            const gapLength = gap.frameEnd - gap.frameStart;
            this.handleImageUpload([ev.target.files[0]], gap.frameStart, gapLength);
          }
        });
        fi.click();
      };
      menu.appendChild(imgBtn);

      const pasteImageBtn = document.createElement("button");
      pasteImageBtn.className = "pr-gap-menu-btn";
      pasteImageBtn.innerHTML = `${ICONS.upload} Paste Image`;
      this._checkClipboardForImage(pasteImageBtn);
      pasteImageBtn.onclick = async () => {
        this.dismissContextMenu();
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imageTypes = item.types.filter(type => type.startsWith("image/"));
            if (imageTypes.length > 0) {
              const blob = await item.getType(imageTypes[0]);
              const file = new File([blob], "clipboard.png", { type: blob.type });
              const startFrame = Math.round(gap.clickedFrame !== undefined ? gap.clickedFrame : gap.frameStart);
              const gapLength = gap.frameEnd - startFrame;

              await this.handleImageUpload([file], startFrame, gapLength);
              break;
            }
          }
        } catch (err) {
          console.error("Failed to paste image from clipboard", err);
        }
      };

      const vidBtn = document.createElement("button");
      vidBtn.className = "pr-gap-menu-btn";
      vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Video Segment`;
      vidBtn.onclick = () => {
        this.dismissContextMenu();
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = "video/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) this.handleVideoUpload([ev.target.files[0]], gap.frameStart);
        });
        fi.click();
      };

      menu.appendChild(pasteImageBtn);
      menu.appendChild(textBtn);
      menu.appendChild(imgBtn);
      menu.appendChild(vidBtn);
    } else if (currentTrack === "audio") {
      const audBtn = document.createElement("button");
      audBtn.className = "pr-gap-menu-btn";
      audBtn.innerHTML = `${ICONS.audio} Audio Segment`;
      audBtn.onclick = () => {
        this.dismissContextMenu();
        this.promptAddAudioInGap(gap.frameStart, gap.frameEnd);
      };
      menu.appendChild(audBtn);
    }

    document.body.appendChild(menu);
    this._contextMenu = menu;
    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
      document.addEventListener("wheel", this._contextMenuDismisser, true);
    }, 0);
  },

  dismissContextMenu() {
    if (this._contextMenu) { this._contextMenu.remove(); this._contextMenu = null; }
    if (this._contextMenuDismisser) {
      document.removeEventListener("pointerdown", this._contextMenuDismisser, true);
      document.removeEventListener("wheel", this._contextMenuDismisser, true);
      this._contextMenuDismisser = null;
    }
  },

  showGapMenu(clientX, clientY, gap) {
    this.dismissGapMenu();
    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const currentTrack = gap.track;

    const hasCopied = this._copiedSegment || window._ltxCopiedSegment;
    const copiedTrack = this._copiedSegmentTrack || window._ltxCopiedSegmentType;
    const copiedSegData = this._copiedSegment || (window._ltxCopiedSegment ? window._ltxCopiedSegment.main : null);
    const copiedSibData = window._ltxCopiedSegment ? window._ltxCopiedSegment.sibling : null;

    const canPaste = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(currentTrack) && copiedSegData;
    const pasteBtn = document.createElement("button");
    pasteBtn.className = "pr-gap-menu-btn";
    pasteBtn.innerHTML = `Paste Segment`;
    if (!canPaste) {
      pasteBtn.disabled = true;
      pasteBtn.style.opacity = "0.4";
      pasteBtn.style.cursor = "not-allowed";
      pasteBtn.title = "No matching segment copied to clipboard";
    } else {
      pasteBtn.onclick = () => {
        const startFrame = Math.round(gap.frameStart);
        this.pasteSegmentAtFrame(copiedSegData, this.getCanonicalTrack(copiedTrack), copiedSibData, startFrame);
        this.dismissGapMenu();
      };
    }
    menu.appendChild(pasteBtn);

    if (currentTrack === "image") {
      const textBtn = document.createElement("button");
      textBtn.className = "pr-gap-menu-btn";
      textBtn.innerHTML = `${ICONS.text} Text Segment`;
      textBtn.addEventListener("click", () => {
        this.addSegmentInGap(gap.frameStart, gap.frameEnd, "text");
        this.dismissGapMenu();
      });

      const imgBtn = document.createElement("button");
      imgBtn.className = "pr-gap-menu-btn";
      imgBtn.innerHTML = `${ICONS.upload} Image Segment`;
      imgBtn.addEventListener("click", () => {
        this.dismissGapMenu();
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = "image/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) {
            const gapLength = gap.frameEnd - gap.frameStart;
            this.handleImageUpload([ev.target.files[0]], gap.frameStart, gapLength);
          }
        });
        fi.click();
      });

      const pasteImageBtn = document.createElement("button");
      pasteImageBtn.className = "pr-gap-menu-btn";
      pasteImageBtn.innerHTML = `${ICONS.upload} Paste Image`;
      this._checkClipboardForImage(pasteImageBtn);
      pasteImageBtn.addEventListener("click", async () => {
        this.dismissGapMenu();
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imageTypes = item.types.filter(type => type.startsWith("image/"));
            if (imageTypes.length > 0) {
              const blob = await item.getType(imageTypes[0]);
              const file = new File([blob], "clipboard.png", { type: blob.type });
              const gapLength = gap.frameEnd - gap.frameStart;
              await this.handleImageUpload([file], gap.frameStart, gapLength);
              break;
            }
          }
        } catch (err) {
          console.error("Failed to paste image from clipboard", err);
        }
      });

      const vidBtn = document.createElement("button");
      vidBtn.className = "pr-gap-menu-btn";
      vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Video Segment`;
      vidBtn.addEventListener("click", () => {
        this.dismissGapMenu();
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = "video/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) {
            this.handleVideoUpload([ev.target.files[0]], gap.frameStart);
          }
        });
        fi.click();
      });

      menu.appendChild(pasteImageBtn);
      menu.appendChild(textBtn);
      menu.appendChild(imgBtn);
      menu.appendChild(vidBtn);
    } else if (currentTrack === "audio") {
      const audBtn = document.createElement("button");
      audBtn.className = "pr-gap-menu-btn";
      audBtn.innerHTML = `${ICONS.audio} Audio Segment`;
      audBtn.addEventListener("click", () => {
        this.dismissGapMenu();
        this.promptAddAudioInGap(gap.frameStart, gap.frameEnd);
      });
      menu.appendChild(audBtn);
    }

    document.body.appendChild(menu);
    this._gapMenu = menu;
    setTimeout(() => {
      this._gapMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissGapMenu(); };
      document.addEventListener("pointerdown", this._gapMenuDismisser, true);
      document.addEventListener("wheel", this._gapMenuDismisser, true);
    }, 0);
  },

  dismissGapMenu() {
    if (this._gapMenu) { this._gapMenu.remove(); this._gapMenu = null; }
    if (this._gapMenuDismisser) {
      document.removeEventListener("pointerdown", this._gapMenuDismisser, true);
      document.removeEventListener("wheel", this._gapMenuDismisser, true);
      this._gapMenuDismisser = null;
    }
  }
};
