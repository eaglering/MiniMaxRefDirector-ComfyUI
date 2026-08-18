// ============================================================
// MiniMax Ref Director - 可复用统一弹窗（Modal）
//
// 统一 Segment Prompt / Minimax H3 Prompt / 添加主体 三个 UI 的
// 弹窗视觉：深色浮层（遮罩 + 居中卡片 + 标题栏 + 关闭按钮）。
// 支持：标题栏拖拽移动、右下角拖拽调整大小、双击标题栏还原居中。
// 供 transfer.js 等 Preact 组件复用（代码复用、样式统一）。
// ============================================================
import { h } from "../../vendor/preact.module.js";
import { useEffect, useRef, useState } from "../../vendor/hooks.module.js";
import htm from "../../vendor/htm.module.js";

const html = htm.bind(h);

const MODAL_CSS = `
.ref-modal-overlay{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.ref-modal{position:relative;background:#2d2d2d;border:1px solid #666;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.6);display:flex;flex-direction:column;max-width:94vw;max-height:90vh;min-width:320px;min-height:180px;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
.ref-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid #444;flex-shrink:0;cursor:move;user-select:none;-webkit-user-select:none;touch-action:none}
.ref-modal-title{font-size:12px;font-weight:600;color:#e0e0e0;text-transform:uppercase;letter-spacing:.5px;pointer-events:none}
.ref-modal-close{background:transparent;border:none;color:#aaa;cursor:pointer;font-size:15px;line-height:1;padding:2px 8px;border-radius:4px;flex-shrink:0;transition:all .15s}
.ref-modal-close:hover{background:rgba(255,255,255,.12);color:#fff}
.ref-modal-body{padding:10px 12px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;flex:1;min-height:0}
.ref-modal-foot{padding:8px 12px;border-top:1px solid #444;display:flex;justify-content:flex-end;gap:6px;flex-shrink:0}
.ref-modal-resize{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;touch-action:none}
.ref-modal-resize::after{content:"";position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-right:2px solid #777;border-bottom:2px solid #777;border-bottom-right-radius:2px}
.ref-modal-resize:hover::after{border-color:#bbb}

`;

let modalStyleEl = document.getElementById("minimax-ref-modal-styles");
if (!modalStyleEl) {
  modalStyleEl = document.createElement("style");
  modalStyleEl.id = "minimax-ref-modal-styles";
  document.head.appendChild(modalStyleEl);
}
modalStyleEl.textContent = MODAL_CSS;

// 可复用统一弹窗：
//   open     - 是否显示
//   title    - 标题栏文字
//   width    - 可选，弹窗宽度（px）；打开时默认值，可被用户拖拽调整覆盖
//   height   - 可选，弹窗高度（px）；打开时默认值，可被用户拖拽调整覆盖
//   onClose  - 关闭回调（ESC / 点遮罩 / 点关闭按钮触发）
//   children - 内容区（内部滚动）
//   footer   - 可选底部栏
export function RefModal({ open, title, width, height, onClose, children, footer, minWidth = 320, minHeight = 180 }) {
  // style: { left, top, width, height }——用户拖拽/调整后的固定定位样式（坐标相对包含块）；null 表示自动居中
  const [style, setStyle] = useState(null);
  // drag: { mode: "move" | "resize", startX, startY, baseLeft, baseTop, baseW, baseH }
  const [drag, setDrag] = useState(null);
  const boxRef = useRef(null);

  // ESC 关闭（输入框 / textarea 内不拦截，避免打断文本编辑）
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      const t = e.target && e.target.tagName;
      if (t === "INPUT" || t === "TEXTAREA") return;
      if (e.key === "Escape" && onClose) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 每次打开重置为默认（居中 + 默认尺寸）
  useEffect(() => {
    if (open) setStyle(null);
  }, [open]);

  // 拖拽 / resize：window 级 pointermove/up 跟随
  useEffect(() => {
    if (!drag) return;
    const scale = drag.scale || 1;
    const onMove = (e) => {
      if (drag.mode === "move") {
        setStyle({
          left: drag.baseLeft + (e.clientX - drag.startX) / scale,
          top: drag.baseTop + (e.clientY - drag.startY) / scale,
          width: drag.baseW,
          height: drag.baseH,
        });
      } else {
        setStyle({
          left: drag.baseLeft,
          top: drag.baseTop,
          width: Math.max(minWidth, drag.baseW + (e.clientX - drag.startX) / scale),
          height: Math.max(minHeight, drag.baseH + (e.clientY - drag.startY) / scale),
        });
      }
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, minWidth, minHeight]);

  if (!open) return null;

  const beginDrag = (e, mode) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest(".ref-modal-close")) return; // 关闭按钮不触发拖拽
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    // 关键：节点 DOM 位于 ComfyUI 图容器（带 transform 平移/缩放）内，position:fixed 实际以该
    // transform 祖先为包含块解析。getBoundingClientRect 返回视口坐标，因此要先减去包含块左上角
    // 视口坐标，得到"相对包含块"的 left/top 再写入 fixed 定位——否则首拖会把视口坐标当作包含块
    // 坐标，窗体瞬间偏移一个"包含块偏移量 + 缩放倍数"。
    const cb = (box.offsetParent && box.offsetParent !== document.body) ? box.offsetParent : box.parentElement;
    const cbRect = cb ? cb.getBoundingClientRect() : { left: 0, top: 0 };
    // 包含块若在 ComfyUI 图容器（transform 平移/缩放）内，getBoundingClientRect 返回的
    // 是视口坐标（已含 scale 系数），而 offsetWidth 是布局宽，两者之比即缩放系数 scale。
    // 写入 fixed 定位的必须是布局值，故 left/top/width/height 及后续移动增量全部除以 scale，
    // 否则点击瞬间窗体尺寸会被再乘一次 scale 而变小、resize 拖动也不跟手。
    const scale = cb && cb.offsetWidth > 0 && cbRect.width > 0 ? cbRect.width / cb.offsetWidth : 1;
    const left = (rect.left - cbRect.left) / scale;
    const top = (rect.top - cbRect.top) / scale;
    // 先把当前渲染位置固化为 fixed 定位，避免从 flex 居中切换到 fixed 时跳动
    setStyle({ left, top, width: rect.width / scale, height: rect.height / scale });
    setDrag({
      mode,
      startX: e.clientX,
      startY: e.clientY,
      baseLeft: left,
      baseTop: top,
      baseW: rect.width / scale,
      baseH: rect.height / scale,
      scale,
    });
    document.body.style.userSelect = "none";
    document.body.style.cursor = mode === "move" ? "move" : "nwse-resize";
  };

  const boxStyle = style
    ? { position: "fixed", left: style.left + "px", top: style.top + "px", width: style.width + "px", height: style.height + "px" }
    : { width: width || null, height: height || null };

  return html`
    <div
      class="ref-modal-overlay"
      onMouseDown=${(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}
    >
      <div ref=${boxRef} class="ref-modal" style=${boxStyle}>
        <div
          class="ref-modal-head"
          onPointerDown=${(e) => beginDrag(e, "move")}
          onDblClick=${() => setStyle(null)}
          title="按住拖动移动，双击还原居中"
        >
          <span class="ref-modal-title">${title}</span>
          <button class="ref-modal-close" title="关闭" onClick=${(e) => { e.stopPropagation(); onClose && onClose(); }}>✕</button>
        </div>
        <div class="ref-modal-body">${children}</div>
        ${footer ? html`<div class="ref-modal-foot">${footer}</div>` : null}
        <div class="ref-modal-resize" onPointerDown=${(e) => beginDrag(e, "resize")} title="拖动调整大小"></div>
      </div>
    </div>
  `;
}
