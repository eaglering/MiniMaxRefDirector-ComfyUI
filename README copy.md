---
license: apache-2.0
base_model: Comfy-Org/MiniMax-H3
tags:
- minimax-h3
- lora
- text-to-video
- camera-movement
- cinematography
- video-generation
---

# Camera Motion LoRA — 使用指南
---
重新收集素材专门为训练运镜的LORA，稍微弥补MINIMAX H3模型的一些缺失的运镜方式。

## 一、触发词（必须）

```
camera motion
```

**必须放在 prompt 开头**。它是激活本 LoRA 运镜控制能力的开关，后面接具体运镜 + 场景。

## 二、文件版本

| 1000步文件 | 3000步文件 |
|---|---|
| `camera_motion_h3_lora_v1_1000_pruned.safetensors` | `camera_motion_h3_lora_v1_3000_pruned.safetensors` |


## 三、安装与加载

1. `_pruned` 文件放入 ComfyUI `models/loras/`
2. **LoraLoader** 加载，`strength_model` 建议 **0.8 ~ 1.0**
   - 0.8 运镜温和；1.0 运镜明确；>1.2 可能画面不稳
3. 底膜用 MiniMax-H3 视频工作流（pruned + int8 + convrot 版本）

## 四、提示词用法（核心）

### 素材提示词结构

训练素材的标注格式（也是本 LoRA 最匹配的写法）：

```
camera motion, [主体], [场景], [运镜描述], [光线/风格], [画质]
```

### 直接使用素材提示词（推荐）

`camera_motion_提示词库.md` 里有 **55 条从训练素材原样提取的完整提示词**，
按 9 类运镜组织（推近/拉远/推拉结合/环绕/跟拍/航拍/升降/摇镜/微距），
**直接复制粘贴即可**，效果与训练数据最接近。例如：

```
camera motion, a woman and a man in athletic wear, engaged in a dynamic rooftop martial arts fight with punches and defensive blocks, nighttime urban cityscape background, slow push-in to medium shot transitioning to slight pull-back as the woman falls, cinematic teal-orange grading, water droplet effects, sharp 4k, high production quality
```

### 换场景，保留运镜

把素材提示词里的 `[主体], [场景]` 换成你的内容，**保留逗号后面的运镜短语**：

```
camera motion, [你的主体], [你的场景], slow push-in with subtle lateral tracking, cinematic color grading, 4k, high quality
```

### 换运镜，保留场景

只替换运镜短语（如 `slow push-in` → `slow orbit`），其余不动。

### 完整示例（不同类型，直接可用）

**① 推近 Push-in（武术/夜景）**
```
camera motion, a woman and a man in athletic wear, engaged in a dynamic rooftop martial arts fight with punches and defensive blocks, nighttime urban cityscape background, slow push-in to medium shot transitioning to slight pull-back as the woman falls, cinematic teal-orange grading, water droplet effects, sharp 4k, high production quality
```

**② 拉远 Pull-back（工业/体积光）**
```
camera motion, two men in a dynamic martial arts fight, exchanging kicks and punches with defensive blocks and dodges, inside a vast abandoned industrial warehouse with crumbling pillars and dramatic shafts of sunlight, slow pull-back combined with gentle orbit around the fighters revealing the full scale of the environment, cinematic gritty texture, natural volumetric lighting, high production quality
```

**③ 环绕 Orbit（古风/雪景）**
```
camera motion, two martial artists in white and dark robes, dueling with sword and fan atop a snow-covered pavilion surrounded by swirling vortex energy, misty mountain landscape with weeping willow, dynamic pull-back from close-up vortex to wide establishing shot revealing the full rooftop confrontation, cinematic wuxia fantasy style, ethereal atmospheric lighting, 4k, high quality
```

**④ 手持跟拍 Handheld（动作/雨夜霓虹）**
```
camera motion, a man and woman in athletic wear, engaged in intense martial arts combat with punches kicks and takedowns, nighttime rooftop with wet pavement reflecting neon city skyline, dynamic handheld camera with push-in and slight tracking following action, cinematic teal-orange color grading, sharp 4k, high quality
```

**⑤ 航拍 Aerial（自然/山川）**
```
camera motion, majestic green mountain peaks and misty valleys, aerial drone descending over cloud-wrapped ridges, low-angle water-level shot of splashing stream, two hikers crossing stone bridge, mountain forest with flowing creek, slow aerial push-in, water-level tracking, static wide, cinematic natural lighting, 4k, high quality
```

**⑥ 微缩造景（微距/桌面 diorama）**
```
camera motion, a miniature seasonal village diorama on a desk, transforming through autumn, winter, and spring with changing foliage and weather effects, office desk environment with computer monitor and stationery, slow push-in dolly glide across the diorama surface revealing each season transition, whimsical miniature aesthetic, soft natural lighting, 4k, high quality
```

> 更多完整示例见 `camera_motion_提示词库.md`（55 条，覆盖全部 9 类运镜）。

## 测试视频

<div style="display:flex; flex-wrap:wrap; gap:10px">
  <video src="https://cdn-uploads.huggingface.co/production/uploads/6a6748afef317ed5adb30050/CVOIDuSdQ6QloKhh0j7Mi.mp4" controls muted style="width:32%"></video>
  <video src="https://cdn-uploads.huggingface.co/production/uploads/6a6748afef317ed5adb30050/Qjms49yRfHU3cYR4QCIBo.mp4" controls muted style="width:32%"></video>
  <video src="https://cdn-uploads.huggingface.co/production/uploads/6a6748afef317ed5adb30050/Kyq5tbbhht1AI1pDcuRMx.mp4" controls muted style="width:32%"></video>
  <video src="https://cdn-uploads.huggingface.co/production/uploads/6a6748afef317ed5adb30050/eBjG9MGbJy7iTSfGfwmzJ.mp4" controls muted style="width:32%"></video>
  <video src="https://cdn-uploads.huggingface.co/production/uploads/6a6748afef317ed5adb30050/LGDyj9P69yMqB14ozcauV.mp4" controls muted style="width:32%"></video>  
  <video src="https://cdn-uploads.huggingface.co/production/uploads/6a6748afef317ed5adb30050/NFj5L49VXxSyFpXWiuIa0.mp4" controls muted style="width:32%"></video>   
</div>







### 运镜强度与方向控制

| 需求 | 写法 |
|---|---|
| 更舒缓 | 加 `slow`：`slow puamic` / `aggressive`：`dynamic handheld` / `aggressive push-in` |
| 指定方向 | `push-in from left` / `orbit right` / `pan left` |

### 本 LoRA 覆盖的运镜类型（训练数据验证）

| 类型 | 效果 | 建议写法 |
|---|---|---|
| 推近 | ★★★ 最稳 | `slow push-in` / `dolly in` / `push in` |
| 拉远 | ★★★ 最稳 | `pull-back` / `dolly out` |
| 手持跟拍 | ★★★ 最稳 | `handheld tracking shot` / `dynamic handheld` |
| 环绕 | ★★☆ 稳 | `slow orbit` / `orbit around` |
| 航拍 | ★★☆ 稳 | `aerial drone shot` / `flyover` |
| 升降 | ★★☆ 稳 | `crane reveal` / `tilt up/down` |
| 推拉结合 | ★★☆ 稳 | `push-in then pull-back` |
| 摇镜 pan | ★☆☆ 较弱 | `pan left` / `pan right`（样本少，建议叠加其他词） |
| 微距/特写 | ★★☆ 稳 | `close-up` / `macro` / `extreme close-up` |

