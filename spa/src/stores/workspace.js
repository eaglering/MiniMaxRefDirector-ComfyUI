// ===== 工作台中央状态：加载 / 防抖保存 / 状态指示 =====
import { defineStore } from "pinia";
import { computed, reactive, ref, toRaw } from "vue";
import { fetchState, saveState, fetchSkills, fetchSkillDict } from "../api/client.js";
import { genId } from "../utils/media.js";

// 与 js/components/director/shared.js parseInitial 对齐的默认值
function defaultTimeline() {
  return {
    segments: [],
    audioSegments: [],
    mainTrackEnabled: true,
    audioTrackEnabled: true,
    propHeight: 90,
    showFilenames: true,
    overrideAudio: false,
    inpaint_audio: true,
    normalStartFrame: 0,
    normalDurationFrames: 120,
    defaultCameraMotions: [],
  };
}

function parseInitial(jsonStr) {
  const parsed = defaultTimeline();
  try {
    if (jsonStr) {
      const p = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr;
      // 保留未知自定义字段（defaultShotSizes / defaultExpressions 等）
      for (const k of Object.keys(parsed)) {
        if (p[k] !== undefined) parsed[k] = p[k];
      }
      for (const k of Object.keys(p)) {
        if (!(k in parsed)) parsed[k] = p[k];
      }
      if (Array.isArray(p.segments)) {
        parsed.segments = p.segments.map((s) => {
          const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s || {};
          if (rest.cameraMotions === undefined && typeof rest.cameraMotion === "string" && rest.cameraMotion && rest.cameraMotion !== "auto") {
            rest.cameraMotions = [rest.cameraMotion];
          }
          delete rest.cameraMotion;
          if (Array.isArray(rest.expressions)) {
            rest.expressions = rest.expressions.filter((k) => typeof k === "string" && k.trim());
          } else if (typeof rest.expression === "string" && rest.expression.trim() && rest.expression !== "auto") {
            rest.expressions = [rest.expression.trim()];
          }
          delete rest.expression;
          return rest;
        });
      }
      if (Array.isArray(p.audioSegments)) {
        parsed.audioSegments = p.audioSegments.map((s) => {
          const { _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _decoding, ...rest } = s || {};
          return rest;
        });
      }
    }
  } catch (e) {
    console.warn("[SPA] parseInitial failed", e);
  }
  let currentStart = 0;
  for (const seg of parsed.segments) {
    if (seg.start === undefined) {
      seg.start = currentStart;
      currentStart += seg.length;
    }
    if (!seg.id) seg.id = genId();
  }
  for (const seg of parsed.audioSegments) {
    if (!seg.id) seg.id = genId();
    if (seg.trimStart === undefined) seg.trimStart = 0;
  }
  return parsed;
}

// 序列化：与 editing.js commitChanges 的 toSave 语义一致（保留未知字段）
function serializeTimeline(t) {
  const out = { ...toRaw(t) };
  out.segments = [...out.segments].map((s) => {
    const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
    return rest;
  });
  // 物化相邻分镜视频引用：
  //   firstFrameSource==="prevVideo" → imageFile = 上一分镜 videoFile
  //   lastFrameSource==="nextVideo"  → lastFrameFile = 下一分镜 videoFile
  // （后端只消费 imageFile / lastFrameFile，物化保证旧工作流兼容）
  out.segments = out.segments.map((s, i) => {
    if (s.firstFrameSource === "prevVideo") {
      const prev = out.segments[i - 1];
      if (prev && prev.videoFile) s.imageFile = prev.videoFile;
    }
    if (s.lastFrameSource === "nextVideo") {
      const next = out.segments[i + 1];
      if (next && next.videoFile) s.lastFrameFile = next.videoFile;
    }
    // 独立上传的首帧/尾帧参考视频（与首尾帧图互不关联）：优先作为帧锚点
    if (s.firstFrameVideo) s.imageFile = s.firstFrameVideo;
    if (s.lastFrameVideo) s.lastFrameFile = s.lastFrameVideo;
    return s;
  });
  out.audioSegments = [...(out.audioSegments || [])].map((s) => {
    const { _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _decoding, _blobUrl, _audioBuffer, ...rest } = s;
    return rest;
  });
  return out;
}

// ---- node_id 解析 ----
// 生产：由入口节点通过 URL query 传入（必需）。
// dev（vite dev server）：允许缺省，优先 localStorage 记住的上次节点，其次 "dev"，
// 便于 `npm run dev` + `?node_id=12` 直接联调热更新。
const DEV_NODE_ID = "dev";
const LS_KEY = "mrd_spa_node_id";

function resolveNodeId() {
  const q = (new URLSearchParams(location.search).get("node_id") || "").trim();
  if (q) {
    try {
      localStorage.setItem(LS_KEY, q);
    } catch {
      /* ignore */
    }
    return q;
  }
  if (import.meta.env.DEV) {
    try {
      return (localStorage.getItem(LS_KEY) || "").trim() || DEV_NODE_ID;
    } catch {
      return DEV_NODE_ID;
    }
  }
  return "";
}

export const useWorkspace = defineStore("workspace", () => {
  const nodeId = ref(resolveNodeId());
  const nodeTitle = ref("");
  const loaded = ref(false);
  const loadError = ref("");
  // idle | saving | saved | error | offline
  const saveStatus = ref("idle");
  const lastSavedAt = ref(0);
  const updatedAt = ref(0);

  const timeline = reactive(parseInitial(""));
  const widgets = reactive({
    outpu_resolution: "16:9横屏",
    million_pixels: 0.6,
    display_mode: "seconds",
    frame_rate: 24,
    start_second: 0,
    end_second: 5,
    guide_strength: "",
    inpaint_audio: true,
    override_audio: false,
  });
  const globalPrompt = ref("");
  const subjects = reactive({ subjects: [] });
  const subjectNodeId = ref("");
  const llm = reactive({
    mode: "llama-cpp",
    gguf_path: "",
    mmproj_path: "",
    provider: "",
    api_key: "",
    ollama_model: "",
    ollama_base_url: "",
    extension_id: "",
  });
  const customSkills = reactive({
    cameraMotions: [],
    shotSizes: [],
    framings: [],
    expressions: [],
  });

  // ---- 镜头技能词典（SQLite：/spa/skill_dict）----
  const skillDict = reactive({ loaded: false, loading: false, categories: [], skills: [] });

  // 内置类别名 → segment 字段；新增的自定义类别没有对应字段（field=""）
  const CATEGORY_FIELD = {
    "运镜": "cameraMotions",
    "景别": "shotSizes",
    "镜头结构": "framings",
    "微表情": "expressions",
  };

  async function loadSkillDict(force = false) {
    if (skillDict.loading || (skillDict.loaded && !force)) return;
    skillDict.loading = true;
    try {
      const res = await fetchSkillDict();
      if (res.success) {
        skillDict.categories = res.categories || [];
        skillDict.skills = res.skills || [];
        skillDict.loaded = true;
      }
    } catch (e) {
      console.error("[SPA] skill_dict load failed", e);
    } finally {
      skillDict.loading = false;
    }
  }

  // 按类别分组的技能组：{ id, label, field, items: [{key,label,desc,example,keyword,...}] }
  const skillGroups = computed(() =>
    skillDict.categories.map((c) => ({
      id: CATEGORY_FIELD[c.name] || `cat_${c.id}`,
      label: c.name,
      field: CATEGORY_FIELD[c.name] || "",
      categoryId: c.id,
      description: c.description,
      items: skillDict.skills
        .filter((s) => s.categoryId === c.id)
        .map((s) => ({
          ...s,
          label: s.name,
          title: s.desc,
        })),
    }))
  );

  // ---- 加载 ----
  async function load() {
    if (!nodeId.value) {
      loadError.value = "缺少 node_id 参数：请通过导演台入口节点打开本页面";
      return;
    }
    try {
      const [stateRes, skillsRes] = await Promise.all([
        fetchState(nodeId.value),
        fetchSkills().catch(() => null),
        loadSkillDict(),
      ]);
      if (!stateRes.success) throw new Error(stateRes.error || "加载失败");
      applyState(stateRes.state || {});
      if (skillsRes && skillsRes.success && skillsRes.skills) {
        Object.assign(customSkills, skillsRes.skills);
      }
      loaded.value = true;
      loadError.value = "";
    } catch (e) {
      loadError.value = e.message || String(e);
    }
  }

  function applyState(state) {
    nodeTitle.value = state.node_title || "";
    subjectNodeId.value = state.subject_node_id || "";
    const tl = parseInitial(state.timeline_data || "");
    for (const k of Object.keys(timeline)) delete timeline[k];
    Object.assign(timeline, tl);
    if (state.widgets) Object.assign(widgets, state.widgets);
    globalPrompt.value = state.global_prompt || "";
    if (state.subjects && Array.isArray(state.subjects.subjects)) {
      subjects.subjects = state.subjects.subjects;
    }
    if (state.llm) Object.assign(llm, state.llm);
    updatedAt.value = state.updated_at || 0;
  }

  // ---- 防抖保存 ----
  let saveTimer = null;
  let saving = false;
  let pendingAgain = false;

  function buildState() {
    return {
      node_id: nodeId.value,
      timeline_data: JSON.stringify(serializeTimeline(timeline)),
      widgets: JSON.parse(JSON.stringify(widgets)),
      global_prompt: globalPrompt.value,
      subjects: { subjects: toRaw(subjects.subjects) },
      subject_node_id: subjectNodeId.value,
      llm: { ...toRaw(llm) },
      updated_at: Date.now(),
    };
  }

  async function doSave() {
    if (!nodeId.value) return;
    saving = true;
    saveStatus.value = "saving";
    try {
      const res = await saveState(nodeId.value, buildState());
      if (!res.success) throw new Error(res.error || "保存失败");
      saveStatus.value = "saved";
      lastSavedAt.value = Date.now();
    } catch (e) {
      console.error("[SPA] save failed", e);
      saveStatus.value = "error";
    } finally {
      saving = false;
      if (pendingAgain) {
        pendingAgain = false;
        scheduleSave();
      }
    }
  }

  function scheduleSave() {
    if (!nodeId.value) return;
    if (saving) {
      pendingAgain = true;
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      doSave();
    }, 500);
  }

  // 任意编辑后调用
  function markDirty() {
    scheduleSave();
  }

  async function saveNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (saving) {
      pendingAgain = true;
      return;
    }
    await doSave();
  }

  async function reload() {
    await load();
  }

  return {
    nodeId, nodeTitle, loaded, loadError, saveStatus, lastSavedAt, updatedAt,
    timeline, widgets, globalPrompt, subjects, subjectNodeId, llm, customSkills,
    skillDict, skillGroups, loadSkillDict,
    load, reload, markDirty, saveNow, buildState,
  };
});
