// 拆分自 minimax_ref_director.js 的 TimelineEditor 类方法（mixin，通过 Object.assign 合并到原型）
// 方法: onContextMenu, _checkClipboardForImage, _checkClipboardForText, showContextMenu,
//       showGapMenu, showGapContextMenu, dismissMenu
// 重构: 统一浮动菜单壳 openMenu/dismissMenu，合并原 showGapContextMenu 与 showGapMenu，
//       showContextMenu 改用配置数组式构建，公共逻辑提取为 _menuBtn/_menuDivider/_copySegment/_applyUploadedImage。
import { ICONS, RULER_HEIGHT, genId, viewUrl, uploadImage } from "./shared.js";
import { t } from "../../i18n.js";

const VID_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;

export const menus = {
  onContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();

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

      this.showGapMenu(e.clientX, e.clientY, gap);
    }
  },

  async _checkClipboardForImage(btn) {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: "clipboard-read" });
        if (status.state === "granted") {
          const items = await navigator.clipboard.read();
          const hasImg = items.some(item => item.types.some(t => t.startsWith("image/")));
          if (!hasImg) {
            btn.disabled = true;
            btn.style.opacity = "0.4";
            btn.style.cursor = "not-allowed";
            btn.title = t("No image found in clipboard");
          }
        } else if (status.state === "denied") {
          btn.disabled = true;
          btn.style.opacity = "0.4";
          btn.style.cursor = "not-allowed";
          btn.title = t("Clipboard permission denied");
        }
      }
    } catch (e) {
      console.warn("Clipboard read permission query failed:", e);
    }
  },

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
            btn.title = t("No text found in clipboard");
          }
        } else if (status.state === "denied") {
          btn.disabled = true;
          btn.style.opacity = "0.4";
          btn.style.cursor = "not-allowed";
          btn.title = t("Clipboard permission denied");
        }
      }
    } catch (e) {
      console.warn("Clipboard read text permission query failed:", e);
    }
  },

  // --- 浮动菜单基础设施（统一原 _contextMenu / _gapMenu 两套样板） ---
  openMenu(clientX, clientY, build) {
    this.dismissMenu();
    const menu = document.createElement("div");
    menu.className = "mrd-pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;
    build(menu);
    document.body.appendChild(menu);
    this._menu = menu;
    setTimeout(() => {
      if (this._menu !== menu) return; // 已被关闭
      this._menuDismisser = (ev) => { if (!this._menu || !this._menu.contains(ev.target)) this.dismissMenu(); };
      document.addEventListener("pointerdown", this._menuDismisser, true);
      document.addEventListener("wheel", this._menuDismisser, true);
    }, 0);
  },

  dismissMenu() {
    if (this._menu) { this._menu.remove(); this._menu = null; }
    if (this._menuDismisser) {
      document.removeEventListener("pointerdown", this._menuDismisser, true);
      document.removeEventListener("wheel", this._menuDismisser, true);
      this._menuDismisser = null;
    }
  },

  // 兼容别名（旧调用点）
  dismissContextMenu() { this.dismissMenu(); },
  dismissGapMenu() { this.dismissMenu(); },

  _menuBtn(label, o = {}) {
    const b = document.createElement("button");
    b.className = "mrd-pr-gap-menu-btn";
    b.innerHTML = label;
    if (o.color) b.style.color = o.color;
    if (o.disabled) {
      b.disabled = true;
      b.style.opacity = "0.4";
      b.style.cursor = "not-allowed";
      if (o.title) b.title = o.title;
    }
    if (o.onClick) b.onclick = () => o.onClick(b);
    return b;
  },

  _menuDivider() {
    const d = document.createElement("div");
    d.className = "mrd-pr-settings-divider";
    return d;
  },

  _copySegment(seg, trackType) {
    this._copiedSegment = { ...seg, id: genId() };
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
  },

  // 上传图片并替换 segment 的图像（clipboard / file 共用）
  async _applyUploadedImage(seg, trackType, file) {
    const up = await uploadImage(file, "whatdreamscost");
    if (!up) return;
    const img = new Image();
    img.onload = () => {
      seg.imageFile = up.imageFile;
      seg.imageB64 = up.imgUrl;
      seg.imgObj = img;
      this.commitChanges();
      this.render();
      if (this.selectedIndex === this.getSegmentArray(trackType).findIndex(s => s.id === seg.id)) {
        this.updateUIFromSelection();
      }
    };
    img.src = up.imgUrl;
  },

  showContextMenu(clientX, clientY, seg, trackType) {
    const isImage = trackType === "image" && seg.imageB64;

    const hasCopied = this._copiedSegment || window._ltxCopiedSegment;
    const copiedTrack = this._copiedSegmentTrack || window._ltxCopiedSegmentType;
    const copiedSegData = this._copiedSegment || (window._ltxCopiedSegment ? window._ltxCopiedSegment.main : null);
    const copiedSibData = window._ltxCopiedSegment ? window._ltxCopiedSegment.sibling : null;
    const canPaste = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(trackType) && copiedSegData;

    let fullResUrl = seg.imageB64;
    const fileKey = seg.imageFile || seg.videoFile;
    if (fileKey) fullResUrl = viewUrl(fileKey);

    const items = [];

    // Group 1: Split at Playhead (if available)
    const splitFrame = Math.round(this.currentFrame);
    if (splitFrame > seg.start && splitFrame < seg.start + seg.length) {
      items.push(this._menuBtn(t("Split at Playhead"), { onClick: () => { this.splitSegmentAtPlayhead(seg, trackType); this.dismissMenu(); } }));
      items.push(this._menuDivider());
    }

    // Group 2: Segment Options (always)
    items.push(this._menuBtn(t("Copy Segment"), { onClick: () => { this._copySegment(seg, trackType); this.dismissMenu(); } }));
    items.push(this._menuBtn(t("Paste Segment"), {
      disabled: !canPaste, title: t("No matching segment copied to clipboard"),
      onClick: () => {
        this.pasteSegmentAtFrame(copiedSegData, this.getCanonicalTrack(copiedTrack), copiedSibData, Math.round(this.currentFrame));
        this.dismissMenu();
      }
    }));
    items.push(this._menuBtn(t("Replace Segment"), {
      disabled: !canPaste, title: t("No matching segment copied to clipboard"),
      onClick: () => {
        const targetArray = this.getSegmentArray(this.getCanonicalTrack(trackType));
        const idx = targetArray.findIndex(s => s.id === seg.id);
        if (idx >= 0) {
          targetArray[idx] = { ...copiedSegData, id: genId(), start: seg.start, length: copiedSegData.length };
        }
        this.commitChanges();
        this.dismissMenu();
      }
    }));
    items.push(this._menuDivider());

    // Group 3: Prompt Options (if not audio)
    if (trackType !== "audio") {
      items.push(this._menuBtn(t("Copy Prompt"), {
        onClick: async () => {
          try { await navigator.clipboard.writeText(seg.prompt || ""); } catch (err) { console.error("Failed to copy prompt", err); }
          this.dismissMenu();
        }
      }));
      const pastePromptBtn = this._menuBtn(t("Paste Prompt"), {
        onClick: async () => {
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
          } catch (err) { console.error("Failed to paste prompt", err); }
          this.dismissMenu();
        }
      });
      this._checkClipboardForText(pastePromptBtn);
      items.push(pastePromptBtn);
      items.push(this._menuDivider());
    }

    // Group 4: Image Options (if isImage)
    if (isImage) {
      items.push(this._menuBtn(t("Copy Image"), {
        onClick: async () => {
          try {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.src = fullResUrl;
            await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext("2d").drawImage(img, 0, 0);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          } catch (err) { console.error("Failed to copy image", err); }
          this.dismissMenu();
        }
      }));
      items.push(this._menuBtn(t("Save Image"), {
        onClick: () => {
          const a = document.createElement("a");
          a.href = fullResUrl;
          a.download = "timeline_image.jpg";
          a.click();
          this.dismissMenu();
        }
      }));
      items.push(this._menuBtn(t("Open Image in New Tab"), {
        onClick: () => {
          const win = window.open();
          if (win) {
            win.document.write(`<body style="margin:0;display:flex;justify-content:center;align-items:center;background:#0e0e0e;height:100vh;"><img style="max-width:100%;max-height:100%;" src="${fullResUrl}" /></body>`);
            win.document.close();
          }
          this.dismissMenu();
        }
      }));
      const replaceImgBtn = this._menuBtn(t("Replace with Copied Image"), {
        onClick: async () => {
          try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              const imageTypes = item.types.filter(type => type.startsWith("image/"));
              if (imageTypes.length > 0) {
                const blob = await item.getType(imageTypes[0]);
                await this._applyUploadedImage(seg, trackType, new File([blob], "clipboard.png", { type: blob.type }));
                break;
              }
            }
          } catch (err) { console.error("Failed to read image from clipboard", err); }
          this.dismissMenu();
        }
      });
      this._checkClipboardForImage(replaceImgBtn);
      items.push(replaceImgBtn);
      items.push(this._menuBtn(t("Replace with..."), {
        onClick: () => {
          this.dismissMenu();
          const fi = document.createElement("input");
          fi.type = "file";
          fi.accept = "image/*";
          fi.addEventListener("change", (ev) => {
            const file = ev.target.files?.[0];
            if (file) this._applyUploadedImage(seg, trackType, file);
          });
          fi.click();
        }
      }));
      items.push(this._menuDivider());
    }

    // Group 5: Convert to another node type (main track: text / image / video)
    if (trackType !== "audio" && (seg.type === "text" || seg.type === "image" || seg.type === "video")) {
      const convertTargets = seg.type === "text" ? ["image", "video"]
        : ["text"];
      for (const target of convertTargets) {
        const label = t(target === "text" ? "Convert to Text" : target === "image" ? "Convert to Image" : "Convert to Video");
        items.push(this._menuBtn(label, {
          onClick: () => {
            this._convertSegmentType(seg, trackType, target);
            this.dismissMenu();
          }
        }));
      }
      items.push(this._menuDivider());
    }

    // Group 6: Unlink Media (linked vid/audio pairs)
    const isVidLink = trackType === "video" && seg.id.endsWith("_v");
    const isAudLink = trackType === "audio" && seg.id.endsWith("_a");
    const siblingForUnlink = (isVidLink || isAudLink)
      ? this.timeline[isVidLink ? "audioSegments" : "segments"].find(s => s.id === seg.id.slice(0, -2) + (isVidLink ? "_a" : "_v"))
      : null;
    if (siblingForUnlink) {
      items.push(this._menuBtn(t("Unlink Media"), {
        onClick: () => {
          seg.id = genId();
          siblingForUnlink.id = genId();
          this.commitChanges();
          this.render();
          this.dismissMenu();
        }
      }));
      items.push(this._menuDivider());
    }

    // Group 7: Latent Upscaler + Mark Selection + Delete
    items.push(this._menuBtn(t("Latent Upscaler"), {
      onClick: () => {
        seg.upscale = !seg.upscale;
        this.commitChanges();
        this.render();
        this.dismissMenu();
      }
    }));
    items.push(this._menuBtn(t("Mark Selection"), {
      onClick: () => {
        if (this.selectedSegmentIds && this.selectedSegmentIds.includes(seg.id)) this.markCurrentSelection();
        else this.markSegment(seg);
        this.dismissMenu();
      }
    }));
    items.push(this._menuDivider());
    items.push(this._menuBtn(t("Delete"), {
      color: "#ff4444",
      onClick: () => {
        this.selectionType = trackType;
        const list = this.getSegmentArray(trackType);
        this.selectedIndex = list.findIndex(s => s.id === seg.id);
        this.deleteSelectedSegment();
        this.dismissMenu();
      }
    }));

    this.openMenu(clientX, clientY, menu => { items.forEach(it => menu.appendChild(it)); });
  },

  // 转换主轨道 segment 节点类型（text / image / video），视频节点转文字/图片时同步移除关联音频兄弟
  _convertSegmentType(seg, trackType, newType) {
    if (!seg || seg.type === newType) return;

    // 清理旧类型专属字段
    if (seg.type === "video") {
      // 转换前提取首帧（thumbnails[0] 或 imageB64），video→image 时回填，避免空壳段导致首帧/尾帧资源条不显示
      const firstSrc = seg.thumbnails?.[0]?.img?.src || seg.imageB64;
      if (seg.videoEl) { try { seg.videoEl.pause(); } catch (_) {} }
      delete seg.videoFile;
      delete seg.videoEl;
      delete seg.videoDurationFrames;
      delete seg.thumbnails;
      delete seg.imageFile;
      delete seg.imageB64;
      delete seg.fileName;
      delete seg.fileSize;
      delete seg.trimStart;
      delete seg.imgObj;
      // 视频节点转文字/图片时，删除关联的音频兄弟节点
      if (seg.id && seg.id.endsWith("_v")) {
        const sibId = seg.id.slice(0, -2) + "_a";
        if (this.timeline.audioSegments) {
          this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== sibId);
        }
      }
      seg.id = seg.id.slice(0, -2)
      seg.type = newType;
      // 视频→图片：回填首帧缩略图，保证转换后图片段仍有内容可显示
      if (newType === "image" && firstSrc) {
        seg.imageB64 = firstSrc;
        const img = new Image();
        img.onload = () => { seg.imgObj = img; this.render(); };
        img.src = firstSrc;
      }
    } else if (seg.type === "image") {
      if (newType === "video") {
        // 图片→视频：保留图片作为视频段首帧占位（避免空壳），并弹框让用户选择真实视频文件
        seg.type = newType;
        const fi = document.createElement("input");
        fi.type = "file";
        fi.accept = "video/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) this.handleVideoUpload([ev.target.files[0]], null, seg);
        });
        fi.click();
      } else {
        // 图片→文字：清理图片字段
        delete seg.imageFile;
        delete seg.imageB64;
        delete seg.imgObj;
        seg.type = newType;
        seg.autoEndFrame = true;
      }
    } else if (seg.type === "text") {
      delete seg.imageFile; delete seg.imageB64; delete seg.imgObj;
      delete seg.videoFile; delete seg.videoEl; delete seg.thumbnails;
      if (newType === "image") {
          const fi = document.createElement("input");
          fi.type = "file";
          fi.accept = "image/*";
          fi.addEventListener("change", (ev) => {
            if (ev.target.files?.[0]) this.handleImageUpload([ev.target.files[0]], null, null, seg);
          });
          fi.click();
      } else if (newType === "video") {
        const fi = document.createElement("input");
        fi.type = "file";
        fi.accept = "video/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) this.handleVideoUpload([ev.target.files[0]], null, seg);
        });
        fi.click();
      }
    }

    this.commitChanges();

    // 若被转换的节点正处于选中状态，刷新 UI（transfer 面板按钮可见性依赖 seg.type）
    const arr = this.getSegmentArray(trackType);
    const idx = arr.findIndex(s => s.id === seg.id);
    if (idx !== -1 && this.selectionType === trackType && this.selectedIndex === idx) {
      this.updateUIFromSelection();
    }
    // 若被移除的音频兄弟节点正处于选中状态，清空选择
    if (this.selectionType === "audio" && this.selectedIndex >= (this.timeline.audioSegments?.length || 0)) {
      this.selectedIndex = -1;
      this.selectionType = "";
      this.updateUIFromSelection();
    }
  },

  // 合并原 showGapContextMenu 与 showGapMenu（差异仅为 dismiss 目标与起始帧计算）
  showGapMenu(clientX, clientY, gap) {
    const currentTrack = gap.track;
    const hasCopied = this._copiedSegment || window._ltxCopiedSegment;
    const copiedTrack = this._copiedSegmentTrack || window._ltxCopiedSegmentType;
    const copiedSegData = this._copiedSegment || (window._ltxCopiedSegment ? window._ltxCopiedSegment.main : null);
    const copiedSibData = window._ltxCopiedSegment ? window._ltxCopiedSegment.sibling : null;
    const canPaste = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(currentTrack) && copiedSegData;

    const startAt = Math.round(gap.clickedFrame !== undefined ? gap.clickedFrame : gap.frameStart);
    const gapLength = gap.frameEnd - gap.frameStart;

    const items = [];
    items.push(this._menuBtn(t("Paste Segment"), {
      disabled: !canPaste, title: t("No matching segment copied to clipboard"),
      onClick: () => {
        this.pasteSegmentAtFrame(copiedSegData, this.getCanonicalTrack(copiedTrack), copiedSibData, startAt);
        this.dismissMenu();
      }
    }));

    if (currentTrack === "image") {
      const pasteImageBtn = this._menuBtn(`${ICONS.upload} ${t("Paste Image")}`, {
        onClick: async () => {
          this.dismissMenu();
          try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              const imageTypes = item.types.filter(type => type.startsWith("image/"));
              if (imageTypes.length > 0) {
                const blob = await item.getType(imageTypes[0]);
                const file = new File([blob], "clipboard.png", { type: blob.type });
                await this.handleImageUpload([file], startAt, gap.frameEnd - startAt);
                break;
              }
            }
          } catch (err) { console.error("Failed to paste image from clipboard", err); }
        }
      });
      this._checkClipboardForImage(pasteImageBtn);
      items.push(pasteImageBtn);
      items.push(this._menuBtn(`${ICONS.text} ${t("Text Segment")}`, {
        onClick: () => { this.addSegmentInGap(gap.frameStart, gap.frameEnd, "text"); this.dismissMenu(); }
      }));
      items.push(this._menuBtn(`${ICONS.upload} ${t("Image Segment")}`, {
        onClick: () => {
          this.dismissMenu();
          const fi = document.createElement("input");
          fi.type = "file";
          fi.accept = "image/*";
          fi.addEventListener("change", (ev) => {
            if (ev.target.files?.[0]) this.handleImageUpload([ev.target.files[0]], gap.frameStart, gapLength);
          });
          fi.click();
        }
      }));
      items.push(this._menuBtn(`${VID_ICON} ${t("Video Segment")}`, {
        onClick: () => {
          this.dismissMenu();
          const fi = document.createElement("input");
          fi.type = "file";
          fi.accept = "video/*";
          fi.addEventListener("change", (ev) => {
            if (ev.target.files?.[0]) this.handleVideoUpload([ev.target.files[0]], gap.frameStart);
          });
          fi.click();
        }
      }));
    } else if (currentTrack === "audio") {
      items.push(this._menuBtn(`${ICONS.audio} ${t("Audio Segment")}`, {
        onClick: () => { this.promptAddAudioInGap(gap.frameStart, gap.frameEnd); this.dismissMenu(); }
      }));
    }

    this.openMenu(clientX, clientY, menu => { items.forEach(it => menu.appendChild(it)); });
  },

  // 兼容旧名（onContextMenu 内部旧调用点已改，此处保留以防外部引用）
  showGapContextMenu(clientX, clientY, gap) { this.showGapMenu(clientX, clientY, gap); }
};
