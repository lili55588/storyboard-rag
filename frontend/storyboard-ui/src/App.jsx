import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const PIPELINE_RUN_ID_KEY = "storyboard_pipeline_run_id";
const STYLE_MODE_KEY = "micro_epic_style_mode";
const DIRECTOR_PROFILE_KEY = "micro_epic_director_profile";
const ART_PROFILE_KEY = "micro_epic_art_profile";
const CINE_PROFILE_KEY = "micro_epic_cine_profile";
const PACK_DELIVERY_MODE_KEY = "micro_epic_pack_delivery_mode";
const SCENE_IMAGE_PROMPT_MODE_KEY = "micro_epic_scene_image_prompt_mode";
const INSPIRATION_HISTORY_KEY = "micro_epic_inspiration_history_v1";
const API_BASE = "http://127.0.0.1:8001";
const DEFAULT_COMFYUI_URL = "https://q3c-m3i4il8suzahuz3wq-twtdmo9e-custom.service.onethingrobot.com";
const IMAGE_MODEL_PRESETS = [
  {
    label: "GPT Image",
    group: "api",
    slot: "master",
    model: "gpt-image-2",
    url: "https://yibuapi.com/v1",
    note: "保留原有 GPT 生图流程，支持当前 reference_images 兼容重试。"
  },
  {
    label: "Imagen 4",
    group: "api",
    slot: "master",
    model: "imagen-4.0-generate-001",
    url: "https://yibuapi.com/v1",
    note: "Google Imagen 图片模型。若通道提示 only imagen models are supported，优先选这个。"
  },
  {
    label: "Imagen 4 Fast",
    group: "api",
    slot: "master",
    model: "imagen-4.0-fast-generate-001",
    url: "https://yibuapi.com/v1",
    note: "Imagen 4 快速版，适合批量场景图试跑。"
  },
  {
    label: "Imagen 4 Ultra",
    group: "api",
    slot: "master",
    model: "imagen-4.0-ultra-generate-001",
    url: "https://yibuapi.com/v1",
    note: "Imagen 4 高质量版，适合最终场景图。"
  },
  {
    label: "FLUX 2 Pro",
    group: "api",
    slot: "master",
    model: "flux-2-pro",
    url: "https://yibuapi.com/v1",
    note: "走 /v1/images/generations + aspect_ratio；当前通道若报 endpoint not supported，需要换 FLUX 生图渠道。"
  },
  {
    label: "FLUX Kontext",
    group: "api",
    slot: "repaint",
    model: "flux-kontext-pro",
    url: "https://yibuapi.com/v1",
    note: "有参考图时走 /v1/images/edits，更适合角色或上一帧一致性。"
  },
  {
    label: "ComfyUI 高质3D场景",
    group: "comfy-master",
    slot: "both",
    workflow: "auto",
    model: "comfyui:protovisionXLHighFidelity3D_releaseV660Bakedvae.safetensors|workflow=auto|steps=32|cfg=6.5|sampler=dpmpp_2m_sde|scheduler=karras|timeout=600",
    url: DEFAULT_COMFYUI_URL,
    note: "推荐用于最终空场景图；workflow=auto 会在有参考图时自动走垫图重绘模板。API Key 可留空。"
  },
  {
    label: "ComfyUI 电影写实场景",
    group: "comfy-master",
    slot: "both",
    workflow: "auto",
    model: "comfyui:juggernautXL_v8Rundiffusion.safetensors|workflow=auto|steps=34|cfg=6|sampler=dpmpp_2m_sde|scheduler=karras|timeout=600",
    url: DEFAULT_COMFYUI_URL,
    note: "偏电影写实和自然环境，适合森林、山谷、水面、光线层次；有参考图时自动垫图重绘。"
  },
  {
    label: "ComfyUI 快速草稿",
    group: "comfy-master",
    slot: "both",
    workflow: "auto",
    model: "comfyui:dreamshaperXL_v21TurboDPMSDE.safetensors|workflow=auto|steps=18|cfg=5.5|sampler=dpmpp_2m|scheduler=karras|timeout=360",
    url: DEFAULT_COMFYUI_URL,
    note: "快速验证构图和提示词；workflow=auto 会自动选择空场景或垫图模板。"
  },
  {
    label: "ComfyUI LoRA细节",
    group: "comfy-master",
    slot: "master",
    workflow: "lora_sdxl_scene",
    model: "comfyui:dreamshaperXL_v21TurboDPMSDE.safetensors|workflow=lora_sdxl_scene|lora=SDXL/add-detail-xl.safetensors|lora_strength=0.55|steps=24|cfg=5.5|sampler=dpmpp_2m|scheduler=karras|timeout=480",
    url: DEFAULT_COMFYUI_URL,
    note: "使用 SDXL/add-detail-xl LoRA 增强场景细节；适合空场景母版，不吃参考图。"
  },
  {
    label: "ComfyUI 2x高清放大",
    group: "comfy-repaint",
    slot: "repaint",
    workflow: "upscale_image",
    model: "comfyui:workflow=upscale_image|upscale_model=RealESRGAN_x2.pth|timeout=360",
    url: DEFAULT_COMFYUI_URL,
    note: "对已绑定图片做 2x 放大；需要参考图，适合放在 4B 或已有场景图重处理。"
  },
  {
    label: "ComfyUI Canny锁构图",
    group: "comfy-repaint",
    slot: "repaint",
    workflow: "controlnet_canny_sdxl",
    model: "comfyui:dreamshaperXL_v21TurboDPMSDE.safetensors|workflow=controlnet_canny_sdxl|steps=24|cfg=5|sampler=dpmpp_2m|scheduler=karras|denoise=0.45|control_strength=0.55|canny_low=0.22|canny_high=0.72|timeout=600",
    url: DEFAULT_COMFYUI_URL,
    note: "用参考图边缘锁定轮廓和道具位置；需要已绑定图片，适合 4B 重绘。"
  },
  {
    label: "ComfyUI Depth锁空间",
    group: "comfy-repaint",
    slot: "repaint",
    workflow: "controlnet_depth_sdxl",
    model: "comfyui:dreamshaperXL_v21TurboDPMSDE.safetensors|workflow=controlnet_depth_sdxl|steps=24|cfg=5|sampler=dpmpp_2m|scheduler=karras|denoise=0.45|control_strength=0.5|depth_ckpt=depth_anything_v2_vits.pth|depth_resolution=512|timeout=600",
    url: DEFAULT_COMFYUI_URL,
    note: "用参考图深度锁定前中后景和空间层次；需要已绑定图片，适合 4B 重绘。"
  },
  {
    label: "ComfyUI IPAdapter一致",
    group: "comfy-repaint",
    slot: "repaint",
    workflow: "ipadapter_sdxl_reference",
    model: "comfyui:dreamshaperXL_v21TurboDPMSDE.safetensors|workflow=ipadapter_sdxl_reference|steps=24|cfg=5|sampler=dpmpp_2m|scheduler=karras|denoise=0.65|ipadapter_preset=STANDARD (medium strength)|ipadapter_weight=0.75|ipadapter_weight_type=style transfer|ipadapter_end=1.0|timeout=600",
    url: DEFAULT_COMFYUI_URL,
    note: "用当前图作底图，额外风格参考图作 IPAdapter 条件，增强跨场景光线、材质和世界元素一致性。"
  }
];

const IMAGE_PRESET_GROUPS = [
  { id: "api", label: "通用图片 API" },
  { id: "comfy-master", label: "ComfyUI 母版" },
  { id: "comfy-repaint", label: "ComfyUI 参考重绘" },
];

const imagePresetVisibleForRoute = (preset, routeId) => {
  if (routeId === IMAGE_MASTER_ROUTE_ID) return preset.slot !== "repaint";
  if (routeId === IMAGE_REPAINT_ROUTE_ID) return preset.slot !== "master";
  return true;
};

const extractComfyWorkflow = (model = "") => {
  const match = String(model || "").match(/(?:^|[|;])workflow=([^|;]+)/i);
  return match ? match[1].trim() : "";
};

const createPipelineRunId = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

const COMPLETION_END_MARKER_INSTRUCTION = `【完整输出结束标记】
当且仅当你已经完整完成本阶段全部交付内容时，请在最后单独另起一行输出：end
如果内容尚未完整、需要继续生成或可能被截断，不要提前输出 end。`;

const withEndMarkerInstruction = (prompt = "") => (
  prompt.includes("最后单独另起一行输出：end")
    ? prompt
    : `${prompt}\n\n${COMPLETION_END_MARKER_INSTRUCTION}`
);

const stripCompletionEndMarker = (text = "") => (
  text.replace(/\n+\s*end\s*$/i, "").trim()
);

const extractFormalShotBody = (text = "") => {
  const source = stripCompletionEndMarker(text || "")
    .replace(/```markdown\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
  if (!source) return "";

  const sceneHeaders = [...source.matchAll(/^##\s*\|\s*S\d+\s*\|[^\r\n]*$/gm)];
  if (sceneHeaders.length) {
    const firstScene = sceneHeaders.find(match => /\|\s*S1\s*\|/.test(match[0])) || sceneHeaders[0];
    return source.slice(firstScene.index ?? 0).trim();
  }

  const firstS1Unit = source.match(/^###\s+生成单元\s+S1-U1\b[^\r\n]*$/m);
  if (firstS1Unit) {
    return source.slice(firstS1Unit.index ?? 0).trim();
  }

  const unitMatches = [...source.matchAll(/^###\s+生成单元\s+(S\d+-U\d+)[^\r\n]*$/gm)];
  const firstExecutableUnit = unitMatches.find((match, index) => {
    const start = match.index ?? 0;
    const end = unitMatches[index + 1]?.index ?? source.length;
    const section = source.slice(start, end);
    return /-\s*(?:成片时长|生成时长)\s*[:：]/.test(section)
      && /-\s*(?:完整提示词|镜头类型\/运镜|动作&情绪)\s*[:：]/.test(section);
  });
  return firstExecutableUnit ? source.slice(firstExecutableUnit.index ?? 0).trim() : source;
};

const estimateTokenCount = (text = "") => {
  const clean = (text || "").replace(/\u200b/g, "");
  const cjk = (clean.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const nonCjk = clean.replace(/[\u3400-\u9fff\uf900-\ufaff\s]/g, "").length;
  return cjk + Math.ceil(nonCjk / 4);
};

const _extractImageFrames = (text = "") => {
  const source = text || "";
  const fieldPrefix = String.raw`-\s*(?:\*\*)?`;
  const fieldSuffix = String.raw`(?:\*\*)?\s*[:：]`;
  const nextField = String.raw`\r?\n${fieldPrefix}(?:Negative Prompt|连续性备注|英文版|来源生成单元|帧类型|用途|建议上传参考图|静态画面描述|中文生图\s*Prompt)${fieldSuffix}`;
  const sectionMatches = [...source.matchAll(/^###\s+(?:\*\*)?(KF-[^\r\n*]+)(?:\*\*)?\r?$/gm)];
  return sectionMatches.map((match, index) => {
    const start = match.index;
    const end = sectionMatches[index + 1]?.index ?? source.length;
    const section = source.slice(start, end).trim();
    const title = match[1].trim();
    const id = (title.split("·")[0] || title).trim();
    const promptMatch = section.match(new RegExp(`${fieldPrefix}中文生图\\s*Prompt${fieldSuffix}\\s*(?:\\r?\\n)?([\\s\\S]*?)(?=${nextField}|\\r?\\n###\\s+(?:\\*\\*)?KF-|$)`));
    const negativeMatch = section.match(new RegExp(`${fieldPrefix}Negative Prompt${fieldSuffix}\\s*(?:\\r?\\n)?([\\s\\S]*?)(?=${nextField}|\\r?\\n###\\s+(?:\\*\\*)?KF-|$)`));
    const refsMatch = section.match(new RegExp(`${fieldPrefix}建议上传参考图${fieldSuffix}\\s*([^\\r\\n]+)`));
    const usageMatch = section.match(new RegExp(`${fieldPrefix}用途${fieldSuffix}\\s*([^\\r\\n]+)`));
    const sourceMatch = section.match(new RegExp(`${fieldPrefix}来源生成单元${fieldSuffix}\\s*([^\\r\\n]+)`));
    const frameTypeMatch = section.match(new RegExp(`${fieldPrefix}帧类型${fieldSuffix}\\s*([^\\r\\n]+)`));
    const prompt = (promptMatch?.[1] || "")
      .replace(/^\s*\[[\s\S]*?\]\s*$/g, "")
      .trim();
    const frameType = (frameTypeMatch?.[1] || "").trim();
    const bindMatch = frameType.match(/@图片\s*(\d+)/);
    return {
      id,
      title,
      prompt,
      negative: (negativeMatch?.[1] || "").trim(),
      refs: (refsMatch?.[1] || "").trim(),
      usage: (usageMatch?.[1] || "").trim(),
      sourceUnit: (sourceMatch?.[1] || "").trim(),
      frameType,
      bindId: bindMatch ? Number(bindMatch[1]) : null,
      section,
    };
  }).filter(frame => frame.id && frame.prompt);
};

const extractRefIds = (text = "") => (
  [...new Set([...(text || "").matchAll(/@图片\s*(\d+)/g)].map(match => Number(match[1])).filter(Boolean))]
);

const categoryForAssetId = (id) => {
  if (id >= 1 && id <= 9) return "character";
  if (id >= 10 && id <= 49) return "scene";
  return "other";
};

const assetDisplayName = (id, asset = null) => (
  asset?.display_name || (asset?.label ? String(asset.label).replace(/^@/, "") : "") || `图片${id}`
);

const assetFileLabel = (asset = null) => {
  if (!asset) return "未绑定";
  if (asset.filename) return asset.filename;
  const raw = asset.path || asset.public_url || asset.url || "";
  if (!raw) return "已绑定";
  const parts = String(raw).split(/[\\/]/);
  return parts[parts.length - 1] || "已绑定";
};

const isMostlyEnglishPrompt = (text = "") => {
  const clean = (text || "").replace(/\s+/g, "");
  if (!clean) return false;
  const cjk = (clean.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (clean.match(/[A-Za-z]/g) || []).length;
  return latin >= 80 && cjk <= Math.max(12, latin * 0.08);
};

const SCENE_WORLD_STYLE_BIBLE_CN = `【默认场景世界风格 Bible · 参考 ASSET-SCENE-10】
这不是固定向日葵题材，而是后续所有场景图默认继承的统一视觉语言；除非用户明确指定另一套美术方向，否则 @图片10-49 都以此作为世界观风格锚点。
风格定位：风格化半写实 3D 动画电影场景，电影感但非照片写实；不是纯卡通，不是玩具质感。画面材质柔软可信，细节丰富，有高质量 CG 渲染感，同时保留绘本/动画电影的温润色彩。
光线与色彩：自然日光，柔和、通透、有斑驳光影。整体偏温暖清新，背景用蓝绿色森林空气感拉开空间层次。色彩是绘画式调色，不追求照片真实，而追求动画电影里的干净、可读、舒服。
空间气质：开阔、透气、童话自然感。画面不能压抑，不能像密集植物隧道，也不能像封闭森林。中景必须保留清晰的表演空地，方便后续角色合成或做分镜动作。
材质语言：草地、泥土、落叶、苔藓、碎石、野花都要自然混合。地面不能像人工草皮，也不能是重复贴图；要有长短不一的草丛、裸露土壤、潮湿暗色斑块、自然杂草和轻微踩压痕迹。
镜头语言：适合做多机位环境设计板：一个大画格展示主空间布局，其他小画格展示低机位、侧视、近景背景、前景遮挡等实用机位。所有机位必须属于同一个空间，地标、光线方向、草高、地面纹理要互相对应。
尺度感：偏童话微缩花园尺度。草、叶子、花盘、石头等植物地标可以比香蕉猫、刀盾狗这类小体型角色更大，但这只是尺度语言，不要求每场都出现向日葵。
可直接复用的中文风格提示词：风格化半写实 3D 动画电影环境，电影感但非照片写实，柔软可信材质，自然日光，柔和斑驳光影，绘画感色彩分级，高细节 CG 渲染，清新通透的蓝绿色空气透视，童话微缩花园尺度，开阔透气的自然场景，前景有植物遮挡，中景保留清晰表演空地，后景有可读的森林空间深度。地面材质自然混合：长短不一的草丛、裸露有机土壤、落叶、碎石、潮湿暗色苔藓斑块、小野花、自然踩压痕迹。整体不是纯卡通，不是玩具质感，不是写实摄影，不压抑，不封闭，不是植物隧道。`;

const SCENE_WORLD_STYLE_BIBLE_EN = `Default Scene World Style Bible, referenced from ASSET-SCENE-10, not sunflower-specific:
Use this as the default shared visual language for all @image10-49 scene assets unless the user explicitly asks for a different art direction.
Stylized semi-realistic 3D animated film environment, cinematic but not photorealistic, soft believable materials, high-detail CG rendering, warm storybook / animated film color warmth, not pure cartoon, not toy-like.
Natural daylight with gentle dappled lighting, soft transparent illumination, painterly color grading, warm fresh foreground color balanced by fresh blue-green atmospheric forest depth in the background.
Airy and open fairy-natural space. The location should feel breathable, not oppressive, not a dense plant tunnel, not an enclosed forest corridor. Keep a clear midground performance space for later character compositing and storyboard action.
Natural ground material language: mixed grass, exposed organic soil, fallen leaves, moss, pebbles, small wildflowers, damp dark moss patches, natural weeds, varied grass lengths and subtle compression marks. Avoid artificial turf, plastic grass, repeated texture tiles or mesh grass.
Multi-camera environment design board language: one large panel establishes the master spatial layout; smaller panels show practical low-angle, side-view, close background plate and foreground-occlusion angles. All panels must belong to the same physical location with matching landmarks, light direction, grass height, ground texture and camera corridors.
Fairy miniature garden scale when appropriate: grass, leaves, flower heads, stones and natural landmarks can be larger than banana-cat / shield-dog sized characters, while still reading as a usable animated film environment, not a macro texture sample.
Reusable English style prompt: Stylized semi-realistic 3D animated film environment, cinematic but not photorealistic, soft believable materials, natural daylight, gentle dappled lighting, painterly color grading, high-detail CG rendering, fresh blue-green atmospheric depth, fairy miniature garden scale, airy and open natural setting, foreground plant occlusion, clear midground performance space, readable background depth. Natural ground materials with varied grass lengths, exposed organic soil, fallen leaves, pebbles, damp dark moss patches, small wildflowers, and subtle compression marks. Not cartoonish, not toy-like, not realistic photography, not oppressive, not enclosed, not a plant tunnel.`;

const ENGLISH_SCENE_REFERENCE_GUARD = `Scene reference constraints:
This is an empty multi-angle environment design sheet for later character compositing. Divide the 16:9 canvas into 3 to 5 clean panels: one larger left panel, about 45-55% of the canvas width, showing the master spatial layout / overhead or wide establishing view, and 2-4 smaller panels showing practical camera-angle plates such as low eye-level, side view, close background plate, and foreground-occlusion angle. Thin panel dividers are allowed, but do not include text labels, captions, logos, or watermarks.
Do not include banana cat, shield dog, animals, people, humanoid characters, extra creatures, or character action props such as shields, swords, paws, eyes, faces, or body parts. Scene sheets describe the empty location only; character interaction belongs to storyboard/video prompts.
Apply the default Scene World Style Bible as the shared visual language for the project:
${SCENE_WORLD_STYLE_BIBLE_EN}
Create a readable animated film environment, not a microscopic macro texture sample. Every panel must represent the same physical location with consistent landmarks, scale, light direction, ground texture, horizon logic, and camera corridors. Keep clear foreground, midground performance space, and readable background depth in the usable camera-angle panels.
For banana cat / shield dog stories, use fairy miniature garden scale when appropriate: oversized grass, leaves, mushrooms, roots, stones, and props can be larger than the characters.
Ground materials must look natural: varied grass lengths, uneven density, exposed soil, leaves, pebbles, damp dark patches, natural weeds, and local compression marks. Avoid artificial turf, plastic grass, mesh grass, repeated woven texture, heavy fog, horror lighting, dark canyon, photographic travel landscape, text, and watermarks.`;

const ENGLISH_SCENE_WORLD_STYLE_GUARD = `Project-wide scene world style continuity:
Default visual style anchor:
${SCENE_WORLD_STYLE_BIBLE_EN}
Before writing individual scene prompts, derive one reusable visual bible for the whole project: shared art direction, color temperature, lighting logic, material language, ground texture, plant/landmark shape vocabulary, scale language, atmosphere, and render style. In Stage 2 overview or Stage 4 execution strategy, explicitly write this as a "Scene World Style Bible" so later image prompts can inherit it.
Every scene prompt must explicitly inherit that same visual bible while changing only the scene-specific spatial task, landmark, composition, light direction/state, and local props. Do not let one scene become a warm fairytale forest and the next become a cold photorealistic cave unless the script explicitly requires that contrast or the user explicitly replaces this default style bible.
Scene image prompts have no fixed word or character limit. Preserve and expand useful visual detail instead of compressing: spatial layout, panel structure, foreground/midground/background, material texture, lighting logic, color palette, atmosphere, continuity anchors, and negative constraints should stay explicit.
If @image10 / @图片10 is the first or master scene anchor, later scene prompts must carry concrete words that keep them in the same world style as that anchor, not only a vague phrase like "same style".`;

const CHINESE_SCENE_WORLD_STYLE_GUARD = `【场景世界观统一硬约束】
默认视觉风格锚点如下：
${SCENE_WORLD_STYLE_BIBLE_CN}
在写单张场景图提示词之前，先从阶段二视觉意图总览、色彩演进表和第一张核心场景图中提炼一套“全片场景世界观基线”：统一的美术方向、色温逻辑、光线语言、材质语言、地面质感、植物/地标形状词、尺度语言、空气感和渲染风格。阶段二视觉意图总览或阶段四执行策略里必须显式写出这套“场景世界观基线”，让后续每条生图 prompt 都有可继承的共同锚点。
每条场景生图 prompt 必须继承这套基线，同时只变化本场的空间任务、童话地标物、构图引导线、光源状态和局部道具。不要让一张是暖橙童话森林，下一张突然变成冷蓝写实洞穴、摄影风景照、玩具渲染或二次元平面风，除非剧本或用户明确要求换风格。
场景图生图提示词不设字数上限，不要为了变短而删掉空间结构、分格策略、前中后景、材质、光线、色彩、空气感、连续性锚点或负面约束；越详细越稳定，越能直接提交图片 API。
如果 @图片10 是第一张/主场景锚点，@图片11-49 必须用具体词继承 @图片10 的世界风格，例如同一色温体系、同类植物/蘑菇/树根/苔藓语言、同类地面材质、同类空气透视和同一 3D 动画电影质感；不要只写“同风格”。`;

const SCENE_REPAINT_EMPHASIS_OPTIONS = [
  { id: "auto", label: "自动纠偏" },
  { id: "structure", label: "锁本场结构" },
  { id: "style", label: "只取参考风格" },
  { id: "loose", label: "弱化强调" },
];

const getScenePromptModeInstruction = (mode = "jimeng", target = "sceneCard") => {
  const isImageList = target === "imageList";
  if (mode === "mj") {
    return `【场景图提示词模式：MJ英文生图】
${isImageList ? "阶段四逐场景生图请求" : "每个场景卡"}必须输出且只输出一种场景生图提示词字段：**MJ英文场景生图提示词**。
真正用于图片 API 的 prompt 必须是英文；字段名和说明文字可以是中文，但不要输出“中文生图 Prompt”“即梦中文场景生图提示词”或任何中文场景 prompt 字段。
${ENGLISH_SCENE_WORLD_STYLE_GUARD}
Length policy: no fixed word count, no character cap, no prompt-shortening. Write a detailed, self-contained image prompt that can be submitted directly to an image API.
要求：适合 SDXL / DreamShaper / ComfyUI 类英文提示词模型；不要写运镜、生成时长、首尾帧；重点写 multi-angle empty environment design sheet, one large master spatial layout panel plus 2-4 smaller camera-angle plates, foreground / midground / background, clear performance space, readable background depth, light direction, materials, color palette, style, 16:9。
风格锁：每条英文 prompt 必须继承默认 Scene World Style Bible，并包含 stylized semi-realistic 3D animated film environment, cinematic but not photorealistic, soft believable materials, natural daylight, gentle dappled lighting, painterly color grading, high-detail CG rendering, fresh blue-green atmospheric depth, fairy miniature garden scale when appropriate, airy and open natural setting, foreground plant occlusion, clear midground performance space, readable background depth；同时明确 not cartoonish, not toy-like, not realistic photography, not oppressive, not enclosed, not a plant tunnel。不要把这句固定放在开头，开头应使用本场最强视觉特征，避免多张图风格头雷同。
必须是空场景多视角设计板，允许无文字分格排版，但禁止角色、动物、人物、文字标注和角色动作道具；banana cat / shield dog stories may use fairy miniature garden scale; grass/moss ground must be uneven natural ground with varied grass clumps, soil, leaves, pebbles and damp dark patches；禁止默认写 microscopic macro close-up、extreme shallow depth of field、fully blurred background、artificial turf、plastic grass、mesh grass。`;
  }
  return `【场景图提示词模式：即梦中文生图】
${isImageList ? "阶段四逐场景生图请求" : "每个场景卡"}必须输出且只输出一种场景生图提示词字段：**即梦中文场景生图提示词**。
真正用于图片 API 的 prompt 必须是中文；不要输出 MJ 英文场景生图提示词，不要双语并列。
${CHINESE_SCENE_WORLD_STYLE_GUARD}
长度策略：不设字数上限，不做字符上限，不要压缩成短提示词；写成可直接提交图片 API 的详细完整 prompt。
要求：适合即梦生图；不要写运镜、生成时长、首尾帧；重点写空场景多视角设计板、左侧大格全场景布局、右侧/其余小格不同拍摄角度、主体留白、前景/中景/后景、光线、材质、色彩、风格与画幅比例。每条 prompt 必须继承“风格化半写实 3D 动画电影环境、电影感但非照片写实、柔软可信材质、自然日光、柔和斑驳光影、绘画感调色、高细节 CG、蓝绿色空气透视、童话微缩花园尺度、开阔中景表演空间、自然草地泥土苔藓材质”的默认风格 Bible。必须是空场景，允许无文字分格排版，保留可读远景；禁止角色、动物、人物、文字标注和角色动作道具；香蕉猫/刀盾狗故事可使用童话微缩花园尺度；草地/苔藓必须是非均匀自然地表，禁止塑料草皮、人工草坪、网格草地、重复编织纹理；禁止默认写显微镜视角、微距局部素材、极浅景深、背景完全虚化。`;
};

const normalizeSceneAssetPrompt = (prompt = "", description = "") => {
  const base = (prompt || description || "")
    .replaceAll("3D半写实梦幻动物动画风格", "3D半写实梦幻动画电影场景风格")
    .replaceAll("3D半写实梦幻动物动画", "3D半写实梦幻动画电影场景")
    .replaceAll("3D semi-realistic dreamy animal animation style", "3D semi-realistic dreamy animated film environment style")
    .replaceAll("dreamy animal animation style", "dreamy animated film environment style")
    .trim();
  const fallback = description || "空场景多视角设计板，继承 ASSET-SCENE-10 默认场景世界风格 Bible：风格化半写实3D动画电影环境，自然日光，柔和斑驳光影，绘画感调色，高细节CG，蓝绿色空气透视，童话微缩花园尺度，开阔中景表演空间，自然草地泥土苔藓材质，16:9";
  if (isMostlyEnglishPrompt(base)) {
    return `${base || fallback}

${ENGLISH_SCENE_WORLD_STYLE_GUARD}

${ENGLISH_SCENE_REFERENCE_GUARD}`;
  }
  return `${base || fallback}

【场景参考图硬约束】
${CHINESE_SCENE_WORLD_STYLE_GUARD}
这是一张空场景多视角设计板，用于后续角色合成。画面分成3到5个干净分格：左侧大格约占45%-55%宽度，画全场景俯视/斜俯视/远景布局；其余小格画同一地点的低机位平拍、侧面机位、近景背景板、前景遮挡角度等拍摄画面。允许细分格线，但不要出现文字、标注、水印。
画面中不要出现香蕉猫、刀盾狗或任何其他动物、人物、拟人角色；不要出现兔子、狐狸、鹿、熊、水獭、小狗、小猫等生物；不要出现盾牌、刀剑、猫爪、狗眼、角色身体局部等角色动作道具。场景图只锁定空间，角色关系和触碰动作交给分镜提示词。
可读动画电影场景空间，不是显微镜视角、微距摄影或苔藓局部素材。同一张设计板内所有分格必须属于同一个真实物理地点，保持地标位置、光源方向、地面材质、尺度关系和可通行表演区一致。若项目是香蕉猫/刀盾狗或剧本明确“小生命面对大世界”，允许童话微缩花园尺度：花朵、叶片、蘑菇、草坡或环境道具可明显大过角色。可以靠近角色高度、中低机位、斜俯拍或俯拍观察，有少量前景草叶/雨滴/叶片自然虚化遮挡，但远景森林、山谷、水道、树根结构或光束必须可读，不要背景完全虚化。
治愈童话场景优先采用“童话地标物 + 柔软自然地表舞台 + 前景叶片/花草包围 + 可读森林纵深 + 少量透明空气感 + 暖光斑”的构成；童话地标物可以是向日葵、雏菊、粉色蘑菇、树根拱门、浅溪石头、藤蔓秋千、苔藓木桥等，每场选择1-2个即可。
雾只能作为极轻透明水汽或远景空气透视，不得成为主视觉。除非用户明确要求悬疑/惊悚，不要使用浓雾、厚雾、冷青绿浓雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、神秘恐怖、惊悚、悬疑、写真摄影感。
草地、苔藓和森林地面必须是真实自然材质：草叶长短不一、疏密不均，混有裸露泥土、落叶、小石子、湿润暗部、自然杂草和局部踩压痕迹；禁止塑料草皮、人工草坪、网格草地、重复编织纹理或像一张塑料网。
保留中景角色活动留白，只允许出现提示词明确要求的环境道具，例如树根、石坡、水珠、光斑、水面、浮叶。`;
};

const buildCharacterIdentityBoardPrompt = ({ characterName = "", roleCard = "", sourcePrompt = "" } = {}) => {
  const name = (characterName || "Unnamed Character").trim();
  const roleContext = (roleCard || "").replace(/\n{3,}/g, "\n\n").trim();
  const seed = (sourcePrompt || roleContext || name).trim();

  return `Create a fully original, copyright-safe character and present them as an artistic CHARACTER IDENTITY BOARD.

[CHARACTER SEED]:
${seed || name}

[AGE / BODY TYPE]:
Infer and fill this from the script and role card: age impression, body type, posture, physical presence, creature anatomy, permanent props, recognizable silhouette, and how the character's body expresses their personality.

[VISUAL MEDIUM]:
Infer and fill the exact rendering medium from the project video style and visual development direction.

Examples:
realistic cinematic character design, fashion editorial photography look, semi-realistic painterly realism, modern 3D animation character design, 2D anime character design, graphic novel illustration, watercolor storybook illustration, flat vector poster illustration, oil-painting-inspired character art, ink and wash illustration, semi-realistic creature concept art.

[STYLE]:
Infer and fill the aesthetic direction from the script, character personality, world rules and current art profile.

Examples:
urban street fashion, luxury sports editorial, dark cinematic noir, soft melancholic artbook mood, post-apocalyptic survival wear, retro-future fashion, minimalist high-fashion, cozy slice-of-life, gritty underground music-video energy, elegant fantasy costume design, poetic coastal fantasy, bioluminescent natural history mood.

[OTHER DETAILS - OPTIONAL]:
Character name: ${name}. Use the script and role card below as the source for extra details, constraints, mood, outfit hints, props, colors, themes, personality hints or presentation preferences.

<role_card_source>
${roleContext || "No detailed role card was supplied; infer from the current script and character name."}
</role_card_source>

Invent everything else:
character name, alias or title, role, personality traits, emotional tone, visual theme, outfit design or body design, color palette, signature prop or signature biological feature, recognizable silhouette, pose language, small identity notes.

Originality rules:
The character must not resemble any existing anime, manga, game, movie, comic, celebrity, athlete, mascot, franchise character or known copyrighted creature. Do not copy recognizable IP elements, costumes, hairstyles, uniforms, weapons, logos, symbols, color combinations, silhouettes, powers or signature visual traits. Avoid fan-art aesthetics. Create a fresh visual identity from scratch.

Character authenticity rules:
Create the character with a strong sense of individuality and non-generic design.
Avoid overly polished, overly idealized or repetitive visual features that make the character feel like a default AI-generated face, stock design, cloned archetype or generic creature.

If the character is human or humanoid:
Use distinctive facial structure, subtle asymmetry, natural variation, small imperfections and believable proportions.
The character should feel specific, grounded and recognizably individual.
If the character is attractive, keep the appeal natural, tasteful and appropriate to the chosen visual medium.

If the character is stylized:
Preserve uniqueness through original shape language, expressive proportions, distinctive features, posture and clear personality cues.
Avoid default genre clichés and repeated beauty standards.

If the character is non-human:
Preserve uniqueness through original anatomy, believable biological structure, distinctive proportions, functional features, surface texture and clear personality cues.
Do not make it feel like a generic mascot, pet monster or stock fantasy creature.

Medium and style control:
[VISUAL MEDIUM] controls the rendering language.
[STYLE] controls the aesthetic direction.
The character identity board format is only the presentation format.
The presentation must adapt to [VISUAL MEDIUM] and [STYLE], not override them.
Use visual traits that belong naturally to the selected medium.

Create an artistic 16:9 CHARACTER IDENTITY BOARD.

The board should feel like a curated visual identity presentation, not a generic turnaround sheet.

Board content:
large full-body main character view, neutral full-body view, back view, profile view, secondary attitude pose, 4 to 6 face or expression studies, outfit detail close-ups or anatomy detail close-ups, key prop close-up or signature feature close-up, small silhouette or shape study, color palette strip, short readable identity notes.

Layout:
asymmetrical, elegant, visually memorable, large empty space, clean separation between all views, no overlapping bodies, no cropped faces, no hidden limbs, no clutter.

Text on the board may include:
character name, alias, role, personality traits, core theme, signature prop or feature, color notes.

Background:
pure white or soft off-white, minimal clean graphic design, no environment, no logo, no watermark.

Prioritize:
accurate visual medium, strong unique identity, readable outfit design or anatomy design, clear personality, original character design, natural or stylized individuality as appropriate, believable uniqueness, non-repetitive character design, artistic identity-board presentation.`;
};

const normalizeCharacterAssetPrompt = (prompt = "", characterName = "", roleCard = "") => {
  const base = (prompt || "").trim();
  const boardPrompt = /CHARACTER IDENTITY BOARD|角色身份板|角色设计图/i.test(base)
    ? base
    : buildCharacterIdentityBoardPrompt({ characterName, roleCard, sourcePrompt: base });

  return boardPrompt;
};

const extractCharacterAssetPrompts = (text = "") => {
  const source = stripCompletionEndMarker(text || "");
  const assets = {};

  const extractField = (section = "") => {
    const label = String.raw`(?:\*\*)?(?:(?:角色身份板|角色设计图|角色原图)[^\r\n:：]{0,120}(?:生图|生成|绘制|设计)?提示词|Character\s+Identity\s+Board[^\r\n:：]{0,120}(?:Prompt|提示词))(?:[^\r\n:：]{0,120})?(?:\*\*)?\s*[:：]`;
    const fencedMatch = section.match(new RegExp(String.raw`${label}\s*(?:\r?\n)?\`\`\`(?:[a-zA-Z]*)?\s*([\s\S]*?)\`\`\``, "i"));
    if (fencedMatch?.[1]) return fencedMatch[1].trim();

    const stop = String.raw`(?:\r?\n\s*(?:\*\*[^*\r\n]{1,40}\*\*\s*[:：]|###\s+角色卡|###\s+场景卡|##\s+四、|##\s+五、)|$)`;
    const patterns = [
      new RegExp(String.raw`${label}\s*([\s\S]*?)(?=${stop})`, "i"),
      new RegExp(String.raw`(?:\*\*)?角色身份板(?:生图|生成|绘制|设计)?提示词[^\r\n:：]{0,120}(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=${stop})`, "i"),
      new RegExp(String.raw`(?:\*\*)?角色设计图(?:生图|生成|绘制|设计)?提示词[^\r\n:：]{0,120}(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=${stop})`, "i"),
      new RegExp(String.raw`(?:\*\*)?角色原图(?:生图|生成|绘制|设计)?提示词[^\r\n:：]{0,120}(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=${stop})`, "i"),
      new RegExp(String.raw`(?:\*\*)?Character\s+Identity\s+Board(?:\s+Prompt)?[^\r\n:：]{0,120}(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=${stop})`, "i"),
    ];
    for (const pattern of patterns) {
      const match = section.match(pattern);
      if (match?.[1]?.trim()) return match[1].trim();
    }
    return "";
  };

  const roleMatches = [...source.matchAll(/^###\s*(?:\*\*)?角色卡\s*[·:：\-|]?\s*([^\r\n*]+?)(?:\*\*)?\s*$[\s\S]*?(?=^###\s*(?:\*\*)?(?:角色卡|场景卡)\s*[·:：\-|]?|^##\s+四、|^##\s+场景卡|^##\s+五、|(?![\s\S]))/gm)];
  roleMatches.forEach((match, index) => {
    const section = match[0].trim();
    const characterName = (match[1] || `角色${index + 1}`).replace(/\*\*/g, "").trim();
    const refIdMatch =
      section.match(/参考图登记[^\r\n]*@图片\s*(\d+)/) ||
      section.match(/角色原图引用写法[^\r\n]*@图片\s*(\d+)/) ||
      section.match(/@图片编号[^\r\n]*@图片\s*(\d+)/) ||
      section.match(/@图片\s*(\d+)/);
    const id = Number(refIdMatch?.[1] || index + 1);
    if (!(id >= 1 && id <= 9)) return;

    const referenceMode = section.match(/角色参考模式(?:\*\*)?\s*[:：]\s*([^\r\n]+)/)?.[1] || "";
    const referenceLine = section.match(/角色原图引用写法[^\r\n]*[:：]\s*([^\r\n]+)/)?.[1] || "";
    const hasUploadedMode = /已有角色原图/.test(referenceMode) && !/无角色原图/.test(referenceMode);
    const prompt = extractField(section);
    const promptSaysSkip = /已有角色原图[^，。；\n\r]*(?:不生成|无需生成)|不生成角色身份板|不生成角色图/.test(prompt);
    const hasNoImageMode = /无角色原图|使用文字锁定/.test(referenceMode) || /无角色原图|使用文字锁定/.test(referenceLine);
    const shouldGenerate = Boolean(prompt && !promptSaysSkip) || (!hasUploadedMode && hasNoImageMode);
    if (!shouldGenerate || hasUploadedMode || promptSaysSkip) return;

    const description = `${characterName} 角色身份板`;
    assets[id] = {
      id,
      characterName,
      description,
      hasStructuredPrompt: Boolean(prompt),
      prompt: normalizeCharacterAssetPrompt(prompt, characterName, section),
    };
  });

  return assets;
};

const mergeCharacterAssetPrompts = (...texts) => {
  const merged = {};
  texts.filter(Boolean).forEach((text, sourceIndex) => {
    Object.values(extractCharacterAssetPrompts(text)).forEach(asset => {
      const existing = merged[asset.id];
      const candidateSourceIsLater = existing && sourceIndex > (existing.sourceIndex ?? -1);
      const candidateHasBetterPrompt = existing && (
        (asset.hasStructuredPrompt && !existing.hasStructuredPrompt) ||
        (asset.hasStructuredPrompt === existing.hasStructuredPrompt && candidateSourceIsLater) ||
        (asset.prompt.length > existing.prompt.length && !existing.hasStructuredPrompt)
      );
      if (!existing || candidateHasBetterPrompt) {
        merged[asset.id] = { ...asset, sourceIndex };
      }
    });
  });
  return Object.fromEntries(
    Object.entries(merged).map(([id, asset]) => {
      const { sourceIndex: _sourceIndex, ...cleanAsset } = asset;
      return [id, cleanAsset];
    })
  );
};

const _extractShotBindMap = (text = "") => {
  const map = {};
  const source = extractFormalShotBody(text || "");
  const sections = [...source.matchAll(/^###\s+生成单元\s+([A-Z]\d+-U\d+)[^\r\n]*\r?$/gm)];
  sections.forEach((match, index) => {
    const start = match.index;
    const end = sections[index + 1]?.index ?? source.length;
    const section = source.slice(start, end);
    const bindMatch = section.match(/待补图\s*[:：】]?\s*@图片\s*(\d+)/);
    if (bindMatch) map[match[1]] = Number(bindMatch[1]);
  });
  return map;
};

const extractSceneAssetPrompts = (text = "") => {
  const source = text || "";
  const assets = {};

  const buildSceneAsset = ({ id, sceneId = "", description = "", structuredPrompt = "" }) => {
    const imageId = Number(id);
    if (!(imageId >= 10 && imageId <= 49)) return;
    const cleanDescription = (description || `${sceneId || `@图片${imageId}`} 场景参考图`)
      .replace(/\*\*/g, "")
      .replace(/^[-\s:：|]+|[-\s:：|]+$/g, "")
      .trim();
    const cleanPrompt = (structuredPrompt || "").replace(/\*\*/g, "").trim();
    const hasStructuredPrompt = Boolean(cleanPrompt);
    const candidate = {
      id: imageId,
      sceneId: sceneId || `S${imageId - 9}`,
      description: cleanDescription || `${sceneId || `@图片${imageId}`} 场景参考图`,
      hasStructuredPrompt,
      prompt: normalizeSceneAssetPrompt(
        cleanPrompt || `${cleanDescription || `@图片${imageId} 场景参考图`}，3D半写实动画电影场景风格，电影级CG质感，材质可信，非玩具渲染，非照片写实，16:9`,
        cleanDescription
      ),
    };
    const existing = assets[imageId];
    if (
      !existing ||
      (candidate.hasStructuredPrompt && !existing.hasStructuredPrompt) ||
      (candidate.hasStructuredPrompt === existing.hasStructuredPrompt && candidate.prompt.length > existing.prompt.length)
    ) {
      assets[imageId] = candidate;
    }
  };

  const extractPromptField = (section = "") => {
    const fencedMatch = section.match(/(?:\*\*)?(?:(?:即梦中文|MJ英文|English)\s*)?场景(?:生图|图)?提示词(?:\*\*)?\s*[:：]?\s*(?:\r?\n)?```(?:[a-zA-Z]*)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) return fencedMatch[1].trim();

    const fieldStop = String.raw`(?:\r?\n\s*(?:\*\*|###|##|\| @图片|-\s*(?:Negative Prompt|生成前内部自检|即梦使用备注|使用备注|连续性注意|连续性备注|来源生成单元|帧类型|用途|空间任务|构图策略|场景描述|类型|归属场景))|$)`;
    const fieldPatterns = [
      new RegExp(String.raw`(?:\*\*)?MJ英文场景生图提示词(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=${fieldStop})`, "i"),
      new RegExp(String.raw`(?:\*\*)?English Scene Generation Prompt(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=${fieldStop})`, "i"),
      new RegExp(String.raw`(?:\*\*)?即梦中文场景生图提示词(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=${fieldStop})`),
      new RegExp(String.raw`(?:\*\*)?中文生图\s*Prompt(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=${fieldStop})`, "i"),
      new RegExp(String.raw`(?:\*\*)?场景生图提示词(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=${fieldStop})`),
      new RegExp(String.raw`(?:\*\*)?最终生图提示词(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=${fieldStop})`),
    ];
    for (const pattern of fieldPatterns) {
      const match = section.match(pattern);
      if (match?.[1]?.trim()) return match[1].trim();
    }

    const lockMatch = section.match(/(?:\*\*)?完整场景锁定描述[^：:]*[:：](?:\*\*)?\s*(?:\r?\n)?([\s\S]*?)(?=\r?\n\*\*|\r?\n###|\r?\n---|$)/);
    return (lockMatch?.[1] || "").trim();
  };

  const extractSceneDescriptionFromHeader = (header = "", sceneId = "") => (
    header
      .replace(/^#+\s*/, "")
      .replace(/^场景卡\s*[·:：-]?\s*/, "")
      .replace(new RegExp(`\\|\\s*${sceneId}\\s*\\|`), "")
      .replace(/^@图片\s*\d+\s*[·:：-]?\s*/, "")
      .trim()
  );

  const sceneHeaderRegex = /^###\s+场景卡\s*·\s*\|\s*(S\d+)\s*\|[^\r\n]*/gm;
  const sceneMatches = [...source.matchAll(sceneHeaderRegex)];
  const sceneCards = sceneMatches.length
    ? sceneMatches.map((match, index) => {
        const start = match.index ?? 0;
        const end = sceneMatches[index + 1]?.index ?? source.length;
        return source.slice(start, end);
      })
    : source.split(/\n(?=###\s+场景卡)/g);

  sceneCards.forEach(section => {
    const sceneMatch = section.match(/###\s+场景卡\s*·\s*\|\s*(S\d+)\s*\|[^\r\n]*/);
    const sceneId = sceneMatch?.[1] || "";
    const sceneDescription = extractSceneDescriptionFromHeader(sceneMatch?.[0] || "", sceneId);
    const structuredPrompt = extractPromptField(section);

    const refLine = section.match(/场景参考图[^\r\n]*[:：]\s*([^\r\n]+)/)?.[1] || "";
    [...refLine.matchAll(/@图片\s*(\d+)/g)].forEach(match => {
      const id = Number(match[1]);
      if (id >= 10 && id <= 49) {
        const tail = refLine.slice((match.index || 0) + match[0].length).split(/[;；，,、]/)[0].trim();
        buildSceneAsset({ id, sceneId, description: tail || sceneDescription || `@图片${id} 场景参考图`, structuredPrompt });
      }
    });

    const idLines = [...section.matchAll(/@图片\s*(\d+)[^：:\r\n]*[：:]\s*([^\r\n]+)/g)];
    idLines.forEach(match => {
      const id = Number(match[1]);
      if (id >= 10 && id <= 49) {
        buildSceneAsset({ id, sceneId, description: match[2] || sceneDescription, structuredPrompt });
      }
    });

    if (!refLine && sceneId) {
      [...section.matchAll(/@图片\s*(\d+)/g)].forEach(match => {
        const id = Number(match[1]);
        if (id >= 10 && id <= 49) {
          buildSceneAsset({ id, sceneId, description: sceneDescription || `@图片${id} 场景参考图`, structuredPrompt });
        }
      });
    }
  });

  [...source.matchAll(/^\|\s*@图片\s*(\d+)\s*\|\s*场景图\s*\|\s*([^|\r\n]+?)\s*\|\s*(S\d+)\s*\|[^\r\n]*$/gm)].forEach(match => {
    buildSceneAsset({ id: match[1], sceneId: match[3], description: match[2] });
  });

  const imageSections = [...source.matchAll(/^###\s+@图片\s*(\d+)\s*·\s*\|\s*(S\d+)\s*\|[^\r\n]*/gm)];
  imageSections.forEach((match, index) => {
    const start = match.index ?? 0;
    const end = imageSections[index + 1]?.index ?? source.length;
    const section = source.slice(start, end);
    buildSceneAsset({
      id: match[1],
      sceneId: match[2],
      description: extractSceneDescriptionFromHeader(match[0] || "", match[2]),
      structuredPrompt: extractPromptField(section),
    });
  });

  return assets;
};

const mergeSceneAssetPrompts = (...args) => {
  const firstArg = args[0];
  const hasOptions = firstArg && typeof firstArg === "object" && !Array.isArray(firstArg);
  const options = hasOptions ? firstArg : {};
  const texts = hasOptions ? args.slice(1) : args;
  const merged = {};
  texts.filter(Boolean).forEach((text, sourceIndex) => {
    Object.values(extractSceneAssetPrompts(text)).forEach(asset => {
      const existing = merged[asset.id];
      const assetIsEnglish = isMostlyEnglishPrompt(asset.prompt);
      const existingIsEnglish = existing ? isMostlyEnglishPrompt(existing.prompt) : false;
      const candidateIsPreferredEnglish = options.preferEnglish && assetIsEnglish && !existingIsEnglish;
      const existingIsPreferredEnglish = options.preferEnglish && existingIsEnglish && !assetIsEnglish;
      const candidateSourceIsLater = existing && sourceIndex > (existing.sourceIndex ?? -1);
      const candidateHasBetterPrompt = existing && (
        (asset.hasStructuredPrompt && !existing.hasStructuredPrompt) ||
        (asset.hasStructuredPrompt && existing.hasStructuredPrompt && candidateSourceIsLater) ||
        (asset.hasStructuredPrompt === existing.hasStructuredPrompt && !candidateSourceIsLater && asset.prompt.length > existing.prompt.length)
      );
      if (
        !existing ||
        candidateIsPreferredEnglish ||
        (!existingIsPreferredEnglish && candidateHasBetterPrompt)
      ) {
        merged[asset.id] = { ...asset, sourceIndex };
      }
    });
  });
  return Object.fromEntries(
    Object.entries(merged).map(([id, asset]) => {
      const { sourceIndex: _sourceIndex, ...cleanAsset } = asset;
      return [id, cleanAsset];
    })
  );
};

const extractSceneChunks = (visualText = "") => {
  const source = stripCompletionEndMarker(visualText || "");
  const sceneRegex = /^###\s+场景卡\s*·\s*\|\s*(S\d+)\s*\|[^\r\n]*(?:\r?\n)?/gm;
  const matches = [...source.matchAll(sceneRegex)];
  const seen = new Set();
  return matches
    .map((match, index) => {
      const sceneId = match[1];
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? source.length;
      const header = (match[0] || "").trim();
      const content = source.slice(start, end).trim();
      return {
        sceneId,
        header,
        sceneName: header.replace(/^###\s+场景卡\s*·\s*\|\s*S\d+\s*\|\s*/, "").trim(),
        content,
        order: Number(sceneId.replace(/\D/g, "")),
      };
    })
    .filter(chunk => {
      if (!chunk.sceneId || seen.has(chunk.sceneId)) return false;
      seen.add(chunk.sceneId);
      return Boolean(chunk.content);
    })
    .sort((a, b) => a.order - b.order);
};

const extractVisualGlobalContext = (visualText = "") => {
  const source = stripCompletionEndMarker(visualText || "");
  const firstScene = source.match(/^###\s+场景卡\s*·\s*\|\s*S\d+\s*\|/m);
  return (firstScene ? source.slice(0, firstScene.index) : source).trim();
};

const compactSceneWorldStyleContext = (text = "", _limit = 0) => {
  const source = (text || "").replace(/\n{3,}/g, "\n\n").trim();
  return source;
};

const extractSceneWorldStyleContext = (text = "") => {
  const source = stripCompletionEndMarker(text || "");
  if (!source.trim()) return "";
  const explicitMatch = source.match(/(?:场景世界观基线|全片场景世界观基线|Scene World Style Bible|项目级场景风格基线)[\s\S]*?(?=\n\s*(?:##|###|【|---)|$)/i);
  if (explicitMatch?.[0]) return compactSceneWorldStyleContext(explicitMatch[0]);

  const global = extractVisualGlobalContext(source);
  const lines = global.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /视觉意图|总体色彩|色彩演进|主导色|辅助色|情绪温度|美术方向|视觉命题|色温|光线|材质|地面|植物|地标|空气感|渲染|风格|palette|lighting|material|atmosphere|render/i.test(line));
  return compactSceneWorldStyleContext(lines.join("\n"));
};

const buildSceneWorldStyleContext = (...texts) => {
  const seen = new Set();
  const chunks = [];
  texts.forEach(text => {
    const chunk = extractSceneWorldStyleContext(text);
    if (chunk && !seen.has(chunk)) {
      seen.add(chunk);
      chunks.push(chunk);
    }
  });
  return compactSceneWorldStyleContext(chunks.join("\n\n"));
};

const appendSceneWorldStyleContext = (prompt = "", context = "") => {
  const cleanPrompt = prompt || "";
  const cleanContext = (context || "").trim();
  if (!cleanContext || cleanPrompt.includes("本项目场景世界观基线") || cleanPrompt.includes("Scene World Style Bible")) {
    return cleanPrompt;
  }
  if (isMostlyEnglishPrompt(cleanPrompt) && !isMostlyEnglishPrompt(cleanContext)) {
    return cleanPrompt;
  }
  return `${cleanPrompt}\n\n【本项目场景世界观基线（生成时必须继承）】\n${cleanContext}`;
};

const buildSceneRepaintEmphasis = (scene = {}, styleReferenceAsset = null, mode = "auto") => {
  const cleanMode = mode || "auto";
  if (cleanMode === "loose") return "";

  const source = `${scene.description || ""}\n${scene.prompt || ""}`;
  const lower = source.toLowerCase();
  const english = isMostlyEnglishPrompt(scene.prompt || source);
  const hasStyleReference = Boolean(styleReferenceAsset?.path || styleReferenceAsset?.public_url || styleReferenceAsset?.url);
  const wantsStructureLock = cleanMode === "auto" || cleanMode === "structure";
  const wantsStyleOnly = cleanMode === "auto" || cleanMode === "style";
  const isMushroomBounce = /mushroom|蘑菇|铇|伞盖|canopy|gills|underside|downlight|弹射|正下方|垂直|vertical|bounce/.test(lower);
  const isGrassBuffer = /草堆|缓冲|坡|厚草|落点|landing|buffer|slope|grass mound|mound/.test(lower);

  if (english) {
    const lines = ["Repaint emphasis:"];
    if (wantsStyleOnly && hasStyleReference) {
      lines.push("Use the style reference image only for color palette, lighting mood, material language, plant/mushroom vocabulary, ground texture, atmosphere, and render style.");
      lines.push("Do not copy the style reference image's camera angle, path layout, horizon, landmark positions, or spatial composition.");
    }
    if (wantsStructureLock) {
      lines.push("The target scene prompt has priority over all reference images. Preserve this scene's specific spatial task, main landmark, composition, and midground performance area.");
      lines.push("If a reference image conflicts with the target scene structure, keep the target structure and ignore the reference structure.");
    }
    if (cleanMode === "auto" && isMushroomBounce) {
      lines.push("Scene-specific lock: show the underside and visible gills of a giant teal glowing mushroom cap overhead, with a compact vertical bounce chamber directly below it.");
      lines.push("Do not turn this into a root bridge, wooden arch, open forest walkway, canyon passage, or generic forest path.");
      lines.push("Keep a damp soil performance zone under the mushroom glow, with pine needles, pebbles, moss, ferns, and blue-green overhead light beams.");
    }
    if (cleanMode === "auto" && isGrassBuffer) {
      lines.push("Scene-specific lock: the soft grass mound or sloped landing buffer must be visibly readable as the functional landmark, not just a generic forest path.");
      lines.push("Keep the landing surface soft, thick, tactile, and clearly separated from surrounding soil, moss, leaves, and pebbles.");
    }
    if (lines.length === 1) return "";
    return `\n\n${lines.join("\n")}`;
  }

  const lines = ["【重绘强调】"];
  if (wantsStyleOnly && hasStyleReference) {
    lines.push("风格参考图只用于继承色彩、光线、材质、植物/蘑菇形状词、地面质感、空气感和渲染风格。");
    lines.push("不要复制风格参考图的机位、路径布局、地平线、地标位置或空间构图。");
  }
  if (wantsStructureLock) {
    lines.push("本场景 prompt 的空间任务优先于所有参考图，必须保留本场的地标物、构图、中景表演区和前中后景关系。");
    lines.push("如果参考图结构与本场任务冲突，以本场任务为准，只取参考图的风格。");
  }
  if (cleanMode === "auto" && isMushroomBounce) {
    lines.push("本场特定锁定：必须画出巨大青绿色发光蘑菇伞盖的正下方，可见伞褶/伞底，形成紧凑的垂直弹射空间。");
    lines.push("不要画成树根拱桥、木桥拱门、开放林间小路、峡谷通道或普通森林路径。");
    lines.push("蘑菇冷光下方保留潮湿泥土表演区，带松针、小石子、苔藓、蕨类和蓝绿色向下光束。");
  }
  if (cleanMode === "auto" && isGrassBuffer) {
    lines.push("本场特定锁定：柔软草堆/斜坡缓冲区必须作为清晰功能地标出现，不要退化成普通林间小路。");
    lines.push("落地区域要厚、软、有触感，并与周围泥土、苔藓、落叶、小石子区分开。");
  }
  if (lines.length === 1) return "";
  return `\n\n${lines.join("\n")}`;
};

const findFirstChunkMarker = (text = "", sceneIds = []) => {
  const allowed = new Set(sceneIds);
  const markerRegexes = [
    /^#{1,4}\s*\|\s*(S\d+)\s*\|[^\r\n]*$/gm,
    /^(?:#{1,4}\s*)?生成单元\s+(S\d+)-U\d+[^\r\n]*$/gm,
    /^\|\s*\d+\s*\|\s*(S\d+)-U\d+\s*\|[^\r\n]*$/gm,
  ];
  let firstAllowed = -1;
  let firstUnauthorized = -1;

  markerRegexes.forEach(regex => {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const sceneId = match[1];
      if (allowed.has(sceneId)) {
        firstAllowed = firstAllowed === -1 ? match.index : Math.min(firstAllowed, match.index);
      } else {
        firstUnauthorized = firstUnauthorized === -1 ? match.index : Math.min(firstUnauthorized, match.index);
      }
    }
  });

  return { firstAllowed, firstUnauthorized };
};

const sanitizeChunkOutput = (text = "", sceneIds = []) => {
  if (!text || !sceneIds.length) return text || "";
  let clean = text.replace(/```markdown\n?/g, "").replace(/```\n?/g, "");
  const markers = findFirstChunkMarker(clean, sceneIds);
  if (markers.firstAllowed > 0) {
    const prefix = clean.slice(0, markers.firstAllowed);
    if (/总体导演策略|目录|总览|场景顺序|提交顺序|全片|参考图使用策略/.test(prefix)) {
      clean = clean.slice(markers.firstAllowed).trimStart();
    }
  }

  const updatedMarkers = findFirstChunkMarker(clean, sceneIds);
  if (updatedMarkers.firstUnauthorized >= 0) {
    clean = clean.slice(0, updatedMarkers.firstUnauthorized).trimEnd();
  }
  return clean;
};

const compactForBoardPrompt = (text = "", _limit = 0) => {
  const source = stripCompletionEndMarker(text || "").trim();
  return source;
};

const compactHeadForBoardPrompt = (text = "", _limit = 0) => {
  const source = stripCompletionEndMarker(text || "").trim();
  return source;
};

const extractBulletBlock = (section = "", label = "") => {
  const bullet = String.raw`\r?\n\s*[-*]\s*(?:\*\*)?`;
  const fieldPrefix = String.raw`(?:^|\r?\n)\s*[-*]\s*(?:\*\*)?`;
  const fieldSuffix = String.raw`(?:\*\*)?\s*[:：]`;
  const pattern = new RegExp(
    `${fieldPrefix}${label}${fieldSuffix}\\s*(?:\\r?\\n)?([\\s\\S]*?)(?=${bullet}[^\\r\\n：:]{1,32}${fieldSuffix}|\\r?\\n###\\s+生成单元|\\r?\\n\\*\\*本场提交顺序表|\\r?\\n---|$)`
  );
  return (section.match(pattern)?.[1] || "").trim();
};

const extractProjectTitle = (...texts) => {
  for (const text of texts) {
    const source = stripCompletionEndMarker(text || "");
    const titleMatch = source.match(/^#\s+(.+?)(?:\s*[·-]\s*.+)?$/m);
    if (titleMatch?.[1]) return titleMatch[1].replace(/\[[^\]]+\]/g, "").trim() || "未命名项目";
  }
  return "未命名项目";
};

const extractScriptContextForBoard = (script = "", sceneIds = []) => {
  const source = stripCompletionEndMarker(script || "").trim();
  if (!source) return "";

  const introMatch = source.match(/([\s\S]*?)(?=\n\s*剧本内容\s*[:：]?|\n\s*场景[一二三四五六七八九十\d]+[:：]?|$)/);
  const intro = (introMatch?.[1] || "").trim()
    .replace(/故事梗概\s*\n[\s\S]*?(?=\n故事背景|\n故事设定|\n一句话故事|\n剧本内容|$)/, "故事梗概\n见当前片段源分镜单元；本段禁止提前表现后续剧情。\n")
    .replace(/一句话故事\s*\n[\s\S]*?(?=\n剧本内容|$)/, "")
    .trim();

  const bodyStart = source.search(/\n\s*剧本内容\s*[:：]?/);
  const body = bodyStart >= 0 ? source.slice(bodyStart) : source;
  const sceneBlocks = [];
  sceneIds.forEach(sceneId => {
    const pattern = new RegExp(`\\|\\s*${sceneId}\\s*\\|`);
    const match = pattern.exec(body);
    if (!match) return;
    const idx = match.index;
    let start = body.lastIndexOf("\n场景", idx);
    if (start < 0) start = Math.max(0, idx - 500);
    let end = body.indexOf("\n场景", idx + 1);
    if (end < 0) end = Math.min(body.length, idx + 1800);
    const block = body.slice(start, end).trim();
    if (block && !sceneBlocks.includes(block)) sceneBlocks.push(block);
  });

  return [
    intro ? `【全片基础设定摘录（只作背景，不得画后续情节）】\n${compactHeadForBoardPrompt(intro, 900)}` : "",
    sceneBlocks.length ? `【当前片段剧本相关段落】\n${compactHeadForBoardPrompt(sceneBlocks.join("\n\n---\n\n"), 1800)}` : "",
  ].filter(Boolean).join("\n\n");
};

const extractCharacterRulesForBoard = (visual = "") => {
  const source = stripCompletionEndMarker(visual || "").trim();
  if (!source) return "";
  const roleMatches = [...source.matchAll(/###\s+角色卡\s*·\s*[^\r\n]+[\s\S]*?(?=\n###\s+角色卡|\n###\s+场景卡|\n##\s+四、场景卡|\n##\s+场景卡|$)/g)];
  if (roleMatches.length) {
    return compactHeadForBoardPrompt(roleMatches.map(match => match[0].trim()).join("\n\n---\n\n"), 2200);
  }
  const beforeScenes = (source.match(/^[\s\S]*?(?=\n###\s+场景卡|\n##\s+四、场景卡|\n##\s+场景卡|$)/)?.[0] || source)
    .replace(/##\s+一、视觉意图总览[\s\S]*?(?=\n##\s+二、|\n##\s+三、|$)/, "")
    .replace(/\*\*三个情绪峰值：\*\*[\s\S]*?(?=\n\*\*总体色彩策略：\*\*|\n##|$)/, "")
    .trim();
  return compactHeadForBoardPrompt(beforeScenes, 1800);
};

const extractImagePlanForScenes = (imagePlan = "", sceneIds = []) => {
  const source = stripCompletionEndMarker(imagePlan || "").trim();
  if (!source || !sceneIds.length) return "";
  const sections = [];
  sceneIds.forEach(sceneId => {
    const sectionRegex = new RegExp(`^###\\s+@图片\\d+\\s*·\\s*\\|\\s*${sceneId}\\s*\\|[\\s\\S]*?(?=^###\\s+@图片\\d+\\s*·\\s*\\|\\s*S\\d+\\s*\\||^##\\s+四、|\\Z)`, "m");
    const section = source.match(sectionRegex)?.[0]?.trim();
    if (section) sections.push(section);
  });
  if (sections.length) return compactHeadForBoardPrompt(sections.join("\n\n---\n\n"), 1800);
  const matchingLines = source.split(/\r?\n/).filter(line => sceneIds.some(sceneId => line.includes(sceneId)));
  return matchingLines.length ? compactHeadForBoardPrompt(matchingLines.join("\n"), 900) : "";
};

const formatBoardSeconds = (value = 0) => {
  const n = Number(value) || 0;
  const rounded = Math.round(n * 2) / 2;
  return Number.isInteger(rounded) ? `${rounded}秒` : `${rounded.toFixed(1)}秒`;
};

const formatDurationValue = (value = 0) => {
  const n = Math.round((Number(value) || 0) * 2) / 2;
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
};

const getBoardFrameCount = (duration = 15, unitCount = 1) => {
  const d = Number(duration) || 15;
  const byDuration = d <= 6.5 ? 4 : d <= 8.5 ? 5 : d <= 11.5 ? 6 : d <= 13.5 ? 7 : 8;
  return Math.min(12, Math.max(byDuration, Math.min(12, unitCount || 1)));
};

const getBoardFrameTimings = (duration = 15, count = 8) => {
  const frames = Math.max(1, Number(count) || 1);
  const totalHalfSeconds = Math.max(frames, Math.round((Number(duration) || 15) * 2));
  const base = Math.floor(totalHalfSeconds / frames);
  const remainder = totalHalfSeconds - base * frames;
  return Array.from({ length: frames }, (_, index) => {
    const halfSeconds = base + (index < remainder ? 1 : 0);
    return halfSeconds / 2;
  });
};

const getBoardFrameTimingText = (duration = 15, count = 8) => (
  getBoardFrameTimings(duration, count)
    .map((seconds, index) => `镜${index + 1}=${formatDurationValue(seconds)}s`)
    .join("、")
);

const normalizeOneLine = (text = "") => (
  (text || "")
    .replace(/\s+/g, " ")
    .replace(/[【】]/g, "")
    .trim()
);

const compactBoardLine = (text = "", limit = 90) => {
  const clean = normalizeOneLine(text);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trim()}…`;
};

const compactJimengLine = (text = "", limit = 180) => {
  const clean = normalizeOneLine(text)
    .replace(/（[^）]{12,80}）/g, "")
    .replace(/\([^)]{12,80}\)/g, "")
    .replace(/\s*\/\s*/g, " / ")
    .trim();
  if (clean.length <= limit) return clean;
  const sliced = clean.slice(0, limit).trim();
  const breakpoints = ["。", "；", ";", ".", "，", ",", " / "]
    .map(mark => sliced.lastIndexOf(mark))
    .filter(pos => pos > Math.floor(limit * 0.55));
  const cut = breakpoints.length ? Math.max(...breakpoints) : limit;
  return sliced.slice(0, cut).replace(/[，,；;。.\/\s]+$/g, "").trim();
};

const compactJimengStyleLine = (text = "", limit = 220) => (
  compactJimengLine(
    text || "High-end stylized semi-realistic 3D animated film, soft believable materials, cinematic natural light, readable background space, not photorealistic, not toy-like.",
    limit
  )
);

const hasCjkText = (text = "") => /[\u3400-\u9fff\uf900-\ufaff]/.test(text || "");

const englishJimengLine = (text = "", fallback = "", limit = 180) => {
  const clean = compactJimengLine(text, limit);
  if (!clean || hasCjkText(clean)) return compactJimengLine(fallback, limit);
  return clean;
};

const splitPromptSentences = (text = "") => (
  normalizeOneLine(text)
    .split(/(?<=[。！？；;])\s*/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
);

const stripVideoPromptTail = (text = "") => (
  normalizeOneLine(text)
    .replace(/3D半写实[\s\S]*$/g, "")
    .replace(/音效[\s\S]*$/g, "")
    .replace(/生成时长[\s\S]*$/g, "")
    .replace(/16:9[\s\S]*$/g, "")
    .trim()
);

const extractCameraForBoard = (unit = {}) => {
  if (unit.camera) return compactBoardLine(unit.camera, 46);
  const sentences = splitPromptSentences(unit.prompt || unit.section || "");
  const cameraSentence = sentences.find(sentence => /镜头|机位|视角|跟拍|推近|拉远|摇移|手持|固定|俯|仰|平拍|近景|中景|远景|特写/.test(sentence)) || sentences[0];
  return compactBoardLine(cameraSentence || "按源分镜机位执行", 46);
};

const extractActionForBoard = (unit = {}, phaseLabel = "") => {
  if (unit.action) return compactBoardLine(`${phaseLabel ? `${phaseLabel}：` : ""}${unit.action}`, 92);
  const clean = stripVideoPromptTail(unit.prompt || unit.section || "");
  const sentences = splitPromptSentences(clean);
  const actionSentences = sentences
    .filter(sentence => !/镜头|机位|视角|跟拍|推近|拉远|摇移|手持|固定|俯|仰|平拍/.test(sentence))
    .slice(0, 2)
    .join("");
  const base = actionSentences || unit.title || unit.emotion || "按源分镜动作推进";
  return compactBoardLine(`${phaseLabel ? `${phaseLabel}：` : ""}${base}`, 92);
};

const extractLightingForBoard = (unit = {}) => {
  if (unit.light) return compactBoardLine(unit.light, 62);
  const sentences = splitPromptSentences(unit.prompt || unit.section || "");
  const lightSentence = sentences.find(sentence => /光|雾|雨|水汽|荧|暖|冷|色温|反射|阴影|氛围|森林|场景|质感/.test(sentence));
  return compactBoardLine(lightSentence || `${unit.sceneName || unit.sceneId || "当前场景"}光线和空气感连续`, 62);
};

const extractCameraForBlueprint = (unit = {}) => {
  if (unit.camera) return normalizeOneLine(unit.camera);
  const sentences = splitPromptSentences(unit.prompt || unit.section || "");
  const cameraSentence = sentences.find(sentence => /镜头|机位|视角|跟拍|推近|拉远|摇移|手持|固定|俯|仰|平拍|近景|中景|远景|特写/.test(sentence)) || sentences[0];
  return normalizeOneLine(cameraSentence || "按源分镜机位执行");
};

const extractActionForBlueprint = (unit = {}, phaseLabel = "") => {
  if (unit.action) return normalizeOneLine(`${phaseLabel ? `${phaseLabel}：` : ""}${unit.action}`);
  const clean = stripVideoPromptTail(unit.prompt || unit.section || "");
  const sentences = splitPromptSentences(clean);
  const actionSentences = sentences
    .filter(sentence => !/镜头|机位|视角|跟拍|推近|拉远|摇移|手持|固定|俯|仰|平拍/.test(sentence))
    .slice(0, 4)
    .join("");
  const base = actionSentences || unit.title || unit.emotion || "按源分镜动作推进";
  return normalizeOneLine(`${phaseLabel ? `${phaseLabel}：` : ""}${base}`);
};

const extractLightingForBlueprint = (unit = {}) => {
  if (unit.light) return normalizeOneLine(unit.light);
  const sentences = splitPromptSentences(unit.prompt || unit.section || "");
  const lightSentences = sentences
    .filter(sentence => /光|雾|雨|水汽|荧|暖|冷|色温|反射|阴影|氛围|森林|场景|质感|材质|水面|地面/.test(sentence))
    .slice(0, 3)
    .join("");
  return normalizeOneLine(lightSentences || `${unit.sceneName || unit.sceneId || "当前场景"}光线、材质、空气感和空间透视连续`);
};

const getPhaseLabel = (index = 0, count = 1) => {
  if (count <= 1) return "完整节拍";
  if (index === 0) return "起势";
  if (index === count - 1) return "交接";
  if (count === 2) return "推进";
  if (index === 1) return "推进";
  if (index === count - 2) return "反应";
  return "细化";
};

const buildBoardFramePlan = (segment = {}, frameCount = 8) => {
  const units = segment.units || [];
  const boardDuration = Math.max(1, Math.round((Number(segment.duration) || 15) * 2) / 2);
  const timings = getBoardFrameTimings(boardDuration, frameCount);
  const unitRanges = [];
  let unitCursor = 0;
  units.forEach((unit, index) => {
    const duration = Math.max(0.5, Number(unit.duration) || boardDuration / Math.max(1, units.length));
    const start = unitCursor;
    const end = index === units.length - 1 ? boardDuration : unitCursor + duration;
    unitRanges.push({ unit, start, end });
    unitCursor = end;
  });

  let frameCursor = 0;
  const frames = timings.map((duration, index) => {
    const start = frameCursor;
    const end = index === timings.length - 1 ? boardDuration : frameCursor + duration;
    const midpoint = start + (end - start) / 2;
    const range = unitRanges.find(item => midpoint >= item.start && midpoint < item.end) || unitRanges[unitRanges.length - 1] || {};
    frameCursor = end;
    return {
      no: index + 1,
      duration,
      start,
      end,
      unit: range.unit || units[0] || {},
      unitKey: range.unit?.id || "unit",
    };
  });

  const countsByUnit = {};
  frames.forEach(frame => {
    countsByUnit[frame.unitKey] = (countsByUnit[frame.unitKey] || 0) + 1;
  });
  const seenByUnit = {};

  return frames.map(frame => {
    seenByUnit[frame.unitKey] = (seenByUnit[frame.unitKey] || 0) + 1;
    const phaseLabel = getPhaseLabel(seenByUnit[frame.unitKey] - 1, countsByUnit[frame.unitKey]);
    const unit = frame.unit || {};
    return {
      ...frame,
      phaseLabel,
      sourceId: unit.id || "未标注",
      sceneLabel: `| ${unit.sceneId || "S?"} | ${unit.sceneName || "当前场景"}`,
      camera: extractCameraForBoard(unit),
      action: extractActionForBoard(unit, phaseLabel),
      light: extractLightingForBoard(unit),
      cameraFull: extractCameraForBlueprint(unit),
      actionFull: extractActionForBlueprint(unit, phaseLabel),
      lightFull: extractLightingForBlueprint(unit),
      emotion: compactBoardLine(unit.emotion || "按源分镜情绪推进", 42),
      handoff: compactBoardLine(unit.handoff || "保持角色位置、朝向和动作动势连续", 70),
      handoffFull: normalizeOneLine(unit.handoff || "保持角色位置、朝向和动作动势连续"),
      refs: compactBoardLine(unit.refs || "角色原图 + 当前场景图", 54),
    };
  });
};

const formatFramePlanForBoardPrompt = (frames = []) => (
  frames.map(frame => (
    `镜${frame.no}｜${formatDurationValue(frame.duration)}s｜源：${frame.sourceId}｜${frame.phaseLabel}｜镜头/运镜：${frame.camera}
- 场景/参考：${frame.sceneLabel}；${frame.refs}
- 动作&情绪：${frame.action}
- 灯光/氛围：${frame.light}
- 衔接状态：${frame.handoff}`
  )).join("\n\n")
);

const formatFramePlanForJimeng = (frames = []) => (
  frames.map(frame => (
    `${frame.no}. ${formatDurationValue(frame.duration)}秒｜${frame.sourceId}｜${frame.phaseLabel}
镜头/运镜：${frame.camera}
动作&情绪：${frame.action}
灯光/氛围：${frame.light}
衔接：${frame.handoff}`
  )).join("\n\n")
);

const formatFramePlanForJimengBlueprint = (frames = []) => (
  frames.map(frame => {
    const camera = compactJimengLine(frame.cameraFull || frame.camera, 115);
    const action = compactJimengLine(frame.actionFull || frame.action, 220);
    const light = compactJimengLine(frame.lightFull || frame.light, 95);
    const endState = compactJimengLine(frame.handoffFull || frame.handoff, 105);
    return `SHOT ${frame.no}: ${formatDurationValue(frame.duration)}s / ${frame.sourceId} / ${camera} / ${action} / ${light} / END: ${endState} / SFX: physical sound.`;
  }).join("\n")
);

const inferJimengSfx = (frame = {}) => {
  const text = normalizeOneLine([
    frame.actionFull,
    frame.action,
    frame.lightFull,
    frame.cameraFull,
    frame.sceneLabel,
  ].filter(Boolean).join(" "));
  if (/水|池|湖|波|涟漪|水面|水下|泡|游|潜|沉|雨/.test(text)) return "water ripple, bubbles, cloth drag.";
  if (/金属|机器|螺丝|齿轮|机械|机器人|刀|盾|撞|砸|摔/.test(text)) return "metal clicks, impact, dust.";
  if (/风|飞|云|羽|跳|冲|滑|坠|落/.test(text)) return "air rush, cloth snap, landing.";
  if (/草|叶|花|蘑菇|泥|土|森林/.test(text)) return "grass brush, soft footfalls.";
  return "natural physical sound.";
};

const formatFramePlanForJimengShotSequence = (frames = []) => (
  frames.map(frame => {
    const camera = englishJimengLine(
      frame.cameraFull || frame.camera,
      `storyboard panel ${frame.no} framing and camera movement`,
      78
    );
    const action = englishJimengLine(
      (frame.actionFull || frame.action || "")
        .replace(/^(完整节拍|起势|推进|反应|交接|细化)\s*[：:.]\s*/i, ""),
      `follow storyboard panel ${frame.no}: preserve the visible action, body weight, contact point, environment response and end state`,
      145
    );
    return `SHOT ${frame.no}: ${camera} / ${action} / SFX: ${inferJimengSfx(frame)}`;
  }).join("\n")
);

const formatFramePlanForJimengOneTakeBeats = (frames = []) => (
  frames.map(frame => {
    const camera = englishJimengLine(
      frame.cameraFull || frame.camera,
      `preserve panel ${frame.no} framing and camera motion`,
      62
    );
    const action = englishJimengLine(
      (frame.actionFull || frame.action || "")
        .replace(/^(完整节拍|起势|推进|反应|交接|细化)\s*[：:.]\s*/i, ""),
      `follow storyboard beat ${frame.no}: preserve the visible action, route, body weight, contact point, environment response and end state`,
      150
    );
    return `${frame.no}. ${action} / camera beat: ${camera} / SFX: ${inferJimengSfx(frame)}`;
  }).join("\n")
);

const getSegmentUnitReferenceIdsForJimeng = (segment = {}, min = 1, max = 99) => (
  [...new Set((segment.units || []).flatMap(unit => extractRefIds([
    unit.refs,
    unit.prompt,
    unit.section,
  ].filter(Boolean).join("\n"))).map(Number).filter(id => Number.isFinite(id) && id > 0))]
    .filter(id => id >= min && id <= max)
);

const cleanActionChainBeat = (text = "", limit = 72) => (
  compactJimengLine(
    (text || "")
      .replace(/^(完整节拍|起势|推进|反应|交接|细化)\s*[：:.]\s*/i, "")
      .replace(/面部五官稳定[\s\S]*$/g, "")
      .replace(/只需要音效[\s\S]*$/g, ""),
    limit
  )
);

const collectJimengModeText = (segment = {}, framePlan = []) => normalizeOneLine([
  segment.title,
  segment.range,
  ...(segment.units || []).flatMap(unit => [
    unit.id,
    unit.title,
    unit.camera,
    unit.action,
    unit.emotion,
    unit.handoff,
    unit.prompt,
    unit.section,
  ]),
  ...framePlan.flatMap(frame => [
    frame.cameraFull,
    frame.camera,
    frame.actionFull,
    frame.action,
    frame.handoffFull,
    frame.handoff,
  ]),
].filter(Boolean).join(" "));

const inferJimengVideoMode = (segment = {}, framePlan = []) => {
  const text = collectJimengModeText(segment, framePlan);
  const oneTakeExplicit = /一镜到底|单镜头|长镜头|无剪辑|不切镜|不中断|连续镜头|one[-\s]?take|one continuous|continuous unbroken|single continuous|no cuts|rear[-\s]?FPV|FPV|first[-\s]?person|第一视角|后方跟拍|背后跟拍/i.test(text);
  const continuousCamera = /跟拍|追拍|手持|尾随|后方|背后|绕拍|环绕|orbit|handheld|follow camera|chase camera|tracking/i.test(text);
  const continuousAction = /追逐|逃跑|跑酷|冲刺|奔跑|滑行|飞行|飞翔|穿行|攀爬|摆荡|潜游|游动|舞蹈|旋转|sprint|chase|parkour|run|glide|fly|flight|skate|surf|swing|climb/i.test(text);
  const multiShotCue = /插入|特写组|宏观|分屏|反打|切到|剪辑|蒙太奇|拆解|螺丝|机关|按钮|多机位|staccato|insert triplet|rapid inserts|split screen|cutaway/i.test(text);
  if (oneTakeExplicit) return "one_take";
  if (continuousCamera && continuousAction && !multiShotCue && framePlan.length >= 5) return "one_take";
  return "multi_shot";
};

const inferOneTakeCameraMode = (segment = {}, framePlan = []) => {
  const text = collectJimengModeText(segment, framePlan);
  if (/rear[-\s]?FPV|后方跟拍|背后跟拍|背后追拍|第一视角|FPV/i.test(text)) return "continuous rear-FPV chase camera";
  if (/侧跟|侧面跟拍|side tracking|side[-\s]?track/i.test(text)) return "continuous side-tracking camera";
  if (/环绕|绕拍|orbit/i.test(text)) return "continuous orbit-follow camera";
  if (/俯拍|overhead|top[-\s]?down/i.test(text)) return "continuous overhead drifting camera";
  if (/手持|handheld/i.test(text)) return "continuous handheld follow camera";
  return "continuous physically motivated follow camera";
};

const formatFramePlanForActionChain = (frames = [], limit = 9) => {
  const beats = [];
  frames.forEach(frame => {
    const beat = cleanActionChainBeat(frame.actionFull || frame.action || frame.phaseLabel, 74);
    if (beat && beat !== beats[beats.length - 1]) beats.push(beat);
  });
  return beats.slice(0, limit).join(" -> ");
};

const formatFramePlanForEnglishActionChain = (frames = [], limit = 9) => {
  const chain = formatFramePlanForActionChain(frames, limit);
  if (chain && !hasCjkText(chain)) return chain;
  return frames.slice(0, limit).map(frame => `storyboard beat ${frame.no}`).join(" -> ");
};

const formatFramePlanForCameraRhythm = (frames = [], limit = 7) => {
  const beats = [];
  frames.forEach(frame => {
    const beat = compactJimengLine(frame.cameraFull || frame.camera, 42);
    if (beat && beat !== beats[beats.length - 1]) beats.push(beat);
  });
  return beats.slice(0, limit).join(" -> ");
};

const formatFramePlanForEnglishCameraRhythm = (frames = [], limit = 7) => {
  const rhythm = formatFramePlanForCameraRhythm(frames, limit);
  if (rhythm && !hasCjkText(rhythm)) return rhythm;
  return frames.slice(0, limit).map(frame => `panel ${frame.no} camera beat`).join(" -> ");
};

const STORY_FRAME_REALISM_PRINCIPLE_CN = `【真实剧情帧原则｜仅用于全案分镜图、关键帧和最终视频，不用于角色身份板】
角色身份板 / IP设定图必须继续使用完整 Character Identity Board 模板，展示正面、侧面、背面、表情、道具、轮廓和身份 notes；不要把角色身份板改成剧情帧。
分镜图和关键帧必须像一部高端 3D 动画电影中真实截取的视频帧，而不是角色展示图、宣传海报、玩具摄影、静态摆拍或 AI 设定图。每个画面格里的角色都必须正在经历当前剧情，有明确动作意图、身体重心、接触点、视线方向和情绪状态。角色、道具和环境要自然融合，不能像后期贴上去；地面/水面/道具必须能承载动作，光源方向、阴影、反光、遮挡、材质细节和空间透视必须一致。动作幅度可以克制，但必须肉眼可见；环境微动只服务动作和情绪，不抢戏。`;

const STORYBOARD_REF_TOKEN = "@[storyboard ref] / @全案分镜图";

const buildSegmentJimengPrompt = ({
  projectTitle,
  segment,
  segmentIndex,
  totalSegments,
  boardDurationLabel,
  boardFrameCount,
  framePlan,
  styleText,
  boardReferenceIds = [],
}) => {
  const sourceRange = `${segment.units[0]?.id || ""} - ${segment.units[segment.units.length - 1]?.id || ""}`;
  const sceneLine = [...new Set(segment.units.map(unit => `| ${unit.sceneId || "S?"} | ${unit.sceneName || "当前场景"}`))]
    .filter(Boolean)
    .join("；");
  const moodLine = [...new Set(segment.units.map(unit => unit.emotion).filter(Boolean))]
    .slice(0, 4)
    .join(" / ") || "Follow the storyboard's emotional escalation and key reveal beats.";
  const corePlotLine = normalizeOneLine(
    segment.units.map(unit => (
      `${unit.id}${unit.title ? ` ${unit.title}` : ""}: ${compactJimengLine(unit.action || extractActionForBlueprint(unit, "本格"), 180)}`
    )).join(" → ")
  );
  const rawActionLogic = `${framePlan[0]?.actionFull || framePlan[0]?.action || ""} -> ${framePlan[framePlan.length - 1]?.actionFull || framePlan[framePlan.length - 1]?.action || ""}`;
  const actionLogic = englishJimengLine(
    rawActionLogic,
    "Each action beat must visibly cause the next through body motion, contact, weight shift, prop behavior, water/ground response, or environmental reaction",
    220
  );
  const actionChain = formatFramePlanForEnglishActionChain(framePlan);
  const cameraRhythm = formatFramePlanForEnglishCameraRhythm(framePlan);
  const unitCharacterReferenceIds = getSegmentUnitReferenceIdsForJimeng(segment, 1, 9);
  const characterReferenceIds = unitCharacterReferenceIds.length
    ? unitCharacterReferenceIds.filter(id => boardReferenceIds.includes(id) || categoryForAssetId(id) === "character")
    : boardReferenceIds.filter(id => categoryForAssetId(id) === "character");
  const sceneReferenceIds = boardReferenceIds.filter(id => categoryForAssetId(id) === "scene");
  const characterRefText = characterReferenceIds.map(id => `@图片${id}`).join(", ") || "uploaded character references / character identity boards";
  const sceneRefText = sceneReferenceIds.map(id => `@图片${id}`).join(", ") || "uploaded scene or bridge environment reference";
  const environmentLine = sceneReferenceIds.length
    ? sceneRefText
    : englishJimengLine(sceneLine, "the uploaded environment reference and current scene card", 180);
  const styleLine = (characterReferenceIds.length || sceneReferenceIds.length)
    ? "Match @图片 references. Stylized semi-realistic 3D animated film, cinematic CG, clean silhouettes, readable motion, no identity redesign, not photorealistic, not toy-like."
    : englishJimengLine(
      styleText,
      "High-end stylized semi-realistic 3D animated film, cinematic CG, clean silhouettes, readable motion, coherent lighting and materials, not photorealistic, not toy-like.",
      190
    );
  const storyboardRefText = STORYBOARD_REF_TOKEN;
  const shotSequence = formatFramePlanForJimengShotSequence(framePlan);
  const oneTakeBeats = formatFramePlanForJimengOneTakeBeats(framePlan);
  const videoMode = inferJimengVideoMode(segment, framePlan);
  const oneTakeCameraMode = inferOneTakeCameraMode(segment, framePlan);
  const sceneSummary = englishJimengLine(
    corePlotLine,
    `This segment covers ${sourceRange}. Follow the storyboard reference for the exact story cause, readable route, character intention, action goal, escalation and final reveal.`,
    420
  );
  const moodSummary = englishJimengLine(
    moodLine,
    "Controlled emotional escalation from setup to action progression to final payoff.",
    120
  );

  if (videoMode === "one_take") {
    return `Seedance 2.0 Prompt:

FORMAT: ${boardDurationLabel} / ${boardFrameCount} storyboard beats / one continuous unbroken take.

SUBJECTS: ${characterRefText} as PRIMARY VISUAL SOURCE. Preserve identity exactly from the reference images; do not redesign.

STORYBOARD: Use ${storyboardRefText} as the authoritative shot blueprint. Do not render the storyboard sheet itself. Ignore all borders, panel frames, text, labels, headers, swatches, director-strip graphics and layout elements. Treat each panel as one sequential beat inside a single continuous unbroken ${oneTakeCameraMode} shot.

ENVIRONMENT: ${environmentLine} as authoritative environment reference.

SCENE: ${sceneSummary} Keep the route readable: ${actionChain || "follow the storyboard action chain continuously"}. Every visible change must be caused by body motion, contact, prop behavior or environment response; no action happens by itself.

CAMERA MODE: ${oneTakeCameraMode}, no cuts. The camera stays physically present, reacts to speed, obstacles, occlusion, refocus and body distance, and never teleports to a new angle.

ACTION RULE: ${actionLogic}. Contact -> force/choice -> visible result. No magic correction, no skipped transition, no reset between beats.

BEAT SEQUENCE:
${oneTakeBeats}

MOOD: ${moodSummary}
STYLE: ${styleLine}

Do not render storyboard artifacts: no panel borders, labels, headers, arrows, timing notes, grid lines, UI, watermark, logo, or text.

NEGATIVE: no cuts, no hard scene cuts, no camera teleport, no captions, subtitles, storyboard borders, panel numbers, grid lines, text labels, headers, arrows, timing notes, UI, watermark, logo, extra characters, new plot beats, future-segment events, changed character design, missing permanent props, changed environment direction, action reset, broken continuity, face deformation, toy render, poster composition, static showcase, low-resolution output.`;
  }

  return `Seedance 2.0 Prompt:

FORMAT: ${boardDurationLabel} / ${boardFrameCount} shots / concise cinematic action.

SUBJECTS: ${characterRefText} as PRIMARY VISUAL SOURCE. Preserve identity exactly from the reference images; do not redesign.

STORYBOARD: Use ${storyboardRefText} ONLY as motion planning reference. Follow panel order, framing progression, camera rhythm, emotional escalation, action flow and reveal structure. Treat each panel as a sequential keyframe, not as a collage.

ENVIRONMENT: ${environmentLine} as authoritative environment reference.

SEGMENT RANGE: ${sourceRange}
SCENE: ${sceneSummary} Keep the route readable: ${actionChain || "follow the storyboard action chain continuously"}. Every visible change must be caused by body motion, contact, prop behavior or environment response; no action happens by itself.

ACTION RULE: ${actionLogic}. Contact -> force/choice -> visible result. No magic correction, no skipped transition, no reset between shots.

SHOT SEQUENCE:
${shotSequence}

MOOD: ${moodSummary}
CAMERA RHYTHM: ${cameraRhythm || "follow the storyboard camera rhythm shot-by-shot"}.
STYLE: ${styleLine}

Do not render storyboard artifacts: no panel borders, labels, headers, arrows, timing notes, grid lines, UI, watermark, logo, or text.

NEGATIVE: no captions, subtitles, storyboard borders, panel numbers, grid lines, text labels, headers, arrows, timing notes, UI, watermark, logo, extra characters, new plot beats, future-segment events, changed character design, missing permanent props, changed environment direction, action reset, broken continuity, face deformation, toy render, poster composition, static showcase, low-resolution output.`;
};

const extractFinalVideoPromptForBoard = (shotText = "") => {
  const source = stripCompletionEndMarker(shotText || "");
  const fenced = source.match(/^##\s+最终即梦视频提示词[\s\S]*?```(?:text|markdown)?\s*([\s\S]*?)```/m);
  if (fenced?.[1]?.trim()) return fenced[1].trim();
  const section = source.match(/^##\s+最终即梦视频提示词[^\r\n]*\r?\n([\s\S]*?)(?=^##\s+|\s*$)/m);
  return (section?.[1] || "")
    .replace(/^[-\s:：]+/, "")
    .trim();
};

const parseShotUnitsForBoard = (shotText = "", visualText = "") => {
  const source = extractFormalShotBody(shotText || "");
  const sceneChunks = extractSceneChunks(visualText || "");
  const sceneInfoMap = Object.fromEntries(sceneChunks.map(chunk => [chunk.sceneId, chunk]));
  const sceneHeaders = [...source.matchAll(/^##\s*\|\s*(S\d+)\s*\|\s*([^\r\n]*)/gm)].map(match => ({
    index: match.index ?? 0,
    sceneId: match[1],
    title: (match[2] || "").trim(),
  }));
  const unitMatches = [...source.matchAll(/^###\s+生成单元\s+(S\d+-U\d+)(?:\s*·\s*([^\r\n]+))?/gm)];

  return unitMatches.map((match, index) => {
    const start = match.index ?? 0;
    const end = unitMatches[index + 1]?.index ?? source.length;
    const section = source.slice(start, end).trim();
    const unitId = match[1];
    const sceneId = unitId.split("-U", 1)[0];
    const headerScene = [...sceneHeaders].reverse().find(scene => scene.index < start && (!scene.sceneId || scene.sceneId === sceneId));
    const durationRaw = extractBulletBlock(section, "成片时长") || extractBulletBlock(section, "生成时长");
    const duration = Number((durationRaw.match(/[\d.]+/) || [])[0]) || 2;
    return {
      id: unitId,
      sceneId,
      title: (match[2] || "").replace(/\*\*/g, "").trim(),
      sceneName: headerScene?.title || sceneInfoMap[sceneId]?.sceneName || "",
      duration,
      emotion: extractBulletBlock(section, "情绪功能"),
      strategy: extractBulletBlock(section, "提交策略"),
      refs: extractBulletBlock(section, "使用参考图"),
      camera: extractBulletBlock(section, "镜头类型/运镜"),
      action: extractBulletBlock(section, "动作&情绪"),
      light: extractBulletBlock(section, "灯光/氛围"),
      prompt: extractBulletBlock(section, "完整提示词"),
      handoff: extractBulletBlock(section, "给下一个生成单元的接口"),
      section,
    };
  });
};

const splitUnitsIntoBoardSegments = (units = []) => {
  const segments = [];
  let current = [];
  let total = 0;
  units.forEach(unit => {
    const duration = unit.duration || 2;
    const wouldOverflow = current.length > 0 && (total + duration > 15.5 || current.length >= 12);
    if (wouldOverflow) {
      segments.push({ units: current, duration: total });
      current = [];
      total = 0;
    }
    current.push(unit);
    total += duration;
  });
  if (current.length) segments.push({ units: current, duration: total });
  return segments;
};

const buildSegmentFullBoardPrompt = ({
  projectTitle,
  segment,
  segmentIndex,
  totalSegments,
  script,
  visual,
  imagePlan,
  characterRefs,
  styleText,
  boardReferenceIds = [],
}) => {
  const involvedSceneIds = [...new Set(segment.units.map(unit => unit.sceneId).filter(Boolean))];
  const sceneContext = extractSceneChunks(visual || "")
    .filter(chunk => involvedSceneIds.includes(chunk.sceneId))
    .map(chunk => chunk.content)
    .join("\n\n---\n\n");
  const scriptContext = extractScriptContextForBoard(script, involvedSceneIds);
  const characterContext = extractCharacterRulesForBoard(visual || "");
  const imagePlanContext = extractImagePlanForScenes(imagePlan, involvedSceneIds);
  const sourceRange = `${segment.units[0]?.id || ""} 至 ${segment.units[segment.units.length - 1]?.id || ""}`;
  const boardDuration = Math.max(1, Math.round((Number(segment.duration) || 15) * 2) / 2);
  const boardDurationLabel = formatBoardSeconds(boardDuration);
  const boardFrameCount = getBoardFrameCount(boardDuration, segment.units.length);
  const frameTimingText = getBoardFrameTimingText(boardDuration, boardFrameCount);
  const framePlan = buildBoardFramePlan(segment, boardFrameCount);
  const framePlanText = formatFramePlanForBoardPrompt(framePlan);
  const boardVideoMode = inferJimengVideoMode(segment, framePlan);
  const boardModeInstruction = boardVideoMode === "one_take"
    ? `【本段视频模式：一镜到底连续型】
本图的 ${boardFrameCount} 个分镜格不是 ${boardFrameCount} 个剪辑镜头，而是同一个连续不中断摄影机运动里的 ${boardFrameCount} 个 sequential beat。版面仍然分格，但每格必须明确承接上一格的摄影机位置、角色运动方向、速度、遮挡、接触点和环境反应；不要画成多机位跳切。顶部或底部备注必须写明 ONE CONTINUOUS TAKE / no cuts / panels are beat divisions only。`
    : `【本段视频模式：多镜头执行型】
本图的 ${boardFrameCount} 个分镜格按镜头顺序组织，每格是一个可独立读取的 shot blueprint。可以有景别和机位变化，但每个切换都必须服务动作因果、情绪升级或揭示结构；不要生成无意义的氛围跳切。`;
  const boardReferenceText = boardReferenceIds.length
    ? boardReferenceIds.map(id => `@图片${id}${categoryForAssetId(id) === "character" ? "（角色）" : categoryForAssetId(id) === "scene" ? "（场景）" : "（参考）"}`).join("、")
    : "未识别到已编号参考图，请以已上传素材和文字锁定说明为准";
  const shotPlan = segment.units.map((unit, index) => (
    `镜${index + 1}｜来源：${unit.id}${unit.title ? ` · ${unit.title}` : ""}｜建议时长：${unit.duration || 2}s
- 场景：| ${unit.sceneId} | ${unit.sceneName || "未命名场景"}
- 情绪功能：${unit.emotion || "未注明"}
- 提交策略：${unit.strategy || "未注明"}
- 使用参考图：${unit.refs || "以随本次上传的两个角色参考图为主，场景按阶段二/四自行还原"}
- 分镜提示词：${unit.prompt || compactForBoardPrompt(unit.section, 420)}
- 下镜头接口：${unit.handoff || "保持动作连续，按下一镜头承接"}`
  )).join("\n\n");

  return `【最高优先级生成硬约束】
请基于可用参考图、角色锁定说明、场景设计和下方分镜生成单元，生成一张单张 16:9 宽高比的“即梦视频执行型高密度黑白全案分镜规划板”。这不是最终彩色视频，也不是单张插画；它是后续即梦 I2V 的结构参考图，用来统一动作、镜头节奏、构图和揭示结构，避免先用生图工具生成彩色关键帧造成风格漂移和算力浪费。

制作逻辑借鉴 cinematic storyboard 节点工作流，但必须套用到当前项目内容：只画当前剧本、当前角色和当前场景，不要复刻任何参考案例的无关角色、运动、场景或 Logo Reveal。黑白全案图只负责“动作流/镜头语言/节奏/叙事升级/衔接”，最终彩色角色和场景由后续视频节点的角色原图、彩色空场景图或桥接环境图承担。

${STORY_FRAME_REALISM_PRINCIPLE_CN}

项目：${projectTitle}
片段：第 ${segmentIndex + 1}/${totalSegments} 段
片段来源：${sourceRange}
源分镜估算时长：${Number(segment.duration || 15).toFixed(1)} 秒
本图目标成片时长：${boardDurationLabel}
当前片段场景：${involvedSceneIds.map(id => `| ${id} |`).join("、") || "未识别"}

必须是完整全案分镜图，不是单张插画。版面按从左到右、从上到下的阅读顺序组织，镜头顺序一眼可读。总时长严格保持为 ${boardDurationLabel}，不要强行拉伸或压缩成15秒；共 ${boardFrameCount} 个分镜格，每个镜头标注精确时长；建议时长分配：${frameTimingText}。可以把源分镜单元拆细或合并成 ${boardFrameCount} 个视觉节拍，但不得新增剧情、不得改变因果顺序。

${boardModeInstruction}

核心目标：每一格都必须同时有“画面动作”和“可执行文字说明”。不要只写镜号和一句短标题；每格说明至少包含镜头/运镜、动作&情绪、灯光/氛围、衔接状态四类信息。尤其是“镜头语言/运镜”必须出现在每一个 panel 的可读文字里，不能只写在顶部总说明里。

【每格底部技术标注格式】
每个分镜格底部必须有一行或两行小号但清晰可读的 storyboard 技术标注，格式建议：
镜X｜Xs｜源单元｜节拍｜镜头/运镜：景别 + 机位 + 摄影机运动
动作：当前可见动作与情绪｜END：本格结束时角色位置/方向/道具/环境状态
这些文字是全案分镜图给后续视频模型看的 motion planning notes，允许出现在黑白全案图中；但最终即梦视频提示词必须排除它们，不得把这些文字、边框或标签渲染进成片。

【本片段硬边界】
- 本图只表现当前片段 ${sourceRange}，不得画出其他生成单元、其他场景或全片后续结尾。
- ${boardFrameCount}个分镜格只是对当前源分镜单元的视觉节拍拆分，不允许新增剧情、提前剧透、改变因果顺序。
- 如果下方全片背景里提到后续地点、后续情绪峰值或结局，只作为理解世界观，绝对不要画进本段。
- @图片编号只是内部文本索引；如果没有实际上传参考图，请按角色锁定说明和场景文字执行。黑白全案图阶段不要混入彩色角色图或彩色场景图的质感，彩色参考留到后续即梦视频阶段使用。
- 如果本段是两个15秒视频节点之间的桥接段，必须在画面和备注里保留可抽帧的环境锚点：角色离开后的空场景、光线方向、地面痕迹、前景遮挡和远景地标要清楚，方便后续执行“抽帧擦除角色/临时道具 → 得到下一节点 Environment Reference”。

【参考图/角色锁定规则】
本段项目 API 应上传并使用的参考图编号：${boardReferenceText}。生成时必须读取这些参考图的角色轮廓、体型比例、永久道具、场景空间布局、光线方向、地面材质、前景遮挡和后景纵深；不要只把 @图片 编号当作文字标签。
${characterRefs || "角色A：使用我上传的第一张角色参考图。\n角色B：使用我上传的第二张角色参考图。"}
可用参考图和文字锁定说明是唯一角色锚点。必须保持角色外形、体型、道具/标志性特征全程一致，只允许姿态、表情和动作随剧情变化。禁止新增第三个主角或改变角色身份。

【统一视觉风格】
${styleText}

【阶段三·本片段源分镜单元（最高剧情依据，优先级高于所有背景信息）】
${shotPlan}

【逐镜文字执行稿（必须对应画进每个分镜格，禁止简化成短标题）】
${framePlanText}

【阶段一·剧本相关上下文】
${scriptContext || "未提供剧本相关上下文，请以分镜单元为最高剧情依据。"}

【阶段二·角色一致性规则】
${characterContext || "未提供角色卡文字，请严格以两张上传角色参考图为最高角色依据。"}

【阶段二·本片段涉及场景卡】
${compactHeadForBoardPrompt(sceneContext, 1900) || "未匹配到具体场景卡，请根据源分镜和参考图自行脑补场景，但不要违背已有设定。"}

【阶段四·本片段场景图设计补充（如果有）】
${imagePlanContext || "未提供本片段相关阶段四场景图清单，可忽略。"}

【顶部通栏·共享创意指导】
创建一个设计过的电影分镜 masthead，不要做成表格标题栏。
- TITLE LOCKUP：${projectTitle} 第 ${segmentIndex + 1} 段 ${boardDurationLabel}全案分镜图。
- META LINE：${boardDurationLabel} / ${boardFrameCount} panels / ${boardVideoMode === "one_take" ? "one continuous take beat-board" : "cinematic storyboard blueprint"} / black-and-white previs。
- PRIORITY LINE：${sourceRange} / 关键动作流、镜头语言、叙事升级和构图，不画后续片段。
- 统一环境规则：严格继承阶段二场景卡和阶段四场景图设计，空间逻辑连贯，无重复相似镜头。
- 统一动作规则：${boardVideoMode === "one_take" ? `${boardFrameCount}个 panel 是同一连续镜头里的动作节拍，必须保持摄影机不中断、角色运动不断线、地理路线可读。` : `${boardFrameCount}个镜头组成一个连续动作链，不能只是${boardFrameCount}张氛围图。`}
- 即梦执行规则：全案图作为 visual guide，负责 key beats、action flow、camera language、composition、escalation；最终视频可自然补足格与格之间的过渡。
- 真实剧情帧规则：每个分镜格都像从动画电影镜头里抽出的一帧，角色有动作意图、身体重心、接触点、视线方向和环境承载；不要画成角色展示、摆拍、海报或玩具摄影。

【上半区左栏·角色与风格参考区】
展示角色的稳定形象参考：正面/侧面/关键动作轮廓/关键身体特征。每个角色旁用短标签标注“角色锚点、允许变化、禁止跑偏”。角色必须与参考图或文字锁定高度一致，不要重新设计角色。该区域保持清晰，不超过整张图的20%。

【上半区右栏·环境与场景设计区】
展示本片段核心场景空间概念图，并包含动线/机位示意：角色从哪里来、向哪里去、镜头如何推进、光源方向如何保持。只展示当前片段涉及场景，不展示后续地点。该区域保持清晰，不超过整张图的20%。

【下半区通栏·核心故事板分镜区】
生成 ${boardFrameCount} 个等比网格排列的编号分镜帧，每帧画幅统一 16:9。故事板${boardFrameCount}格区域必须占整张图面积的60%以上，是即梦读取顺序的主体区域。每帧采用“上方画面 + 下方文字条”或“左侧画面 + 右侧文字条”的结构，文字不要遮挡角色动作。每帧必须包含这些清晰中文字段：
1. 镜头编号 + 精确时长 + 来源单元
2. 镜头类型/运镜：广角、中景、近景、特写、跟拍、推近、拉远、摇移、低机位、斜俯拍、俯拍等
3. 动作&情绪：写清角色站位、距离变化、道具状态、身体动作和表情反应
4. 灯光/氛围：写清光源方向、雾/水汽/荧光/光点等环境动态
5. 衔接状态：写清本格结束时角色朝向、位置、道具高低、视线方向，方便下一格承接
6. 禁止只写“继续前进、温暖、治愈、看向远方”这类空泛短句

【底部备注区】
- 情绪关键词：列出本段视频的情绪变化。
- 声音氛围：列出环境音/音乐气质。
- 摄影笔记：列出整体镜头语言、剪辑节奏、后期质感。
- 即梦直投提醒：说明“分镜文字仅作生成参考，成片中不出现文字/边框/网格”。

【排版要求】
参考专业影视预制作规划板：信息密度高但结构整齐，分区标题、镜头编号、角色角度标签清晰可读。中文文字必须真实可读，使用短标签和2-4条短说明，不要生成乱码伪文字。镜头画面主体必须大于文字说明，不能让文字遮挡角色和动作。

【负面排除词】
禁止画出当前片段以外的后续剧情、禁止提前出现后续场景、禁止场景重复相似、禁止内容过度简单、禁止文字描述过少、禁止只有氛围图没有动作链、禁止模糊不清、禁止乱码伪文字、禁止长文本段落、禁止排版混乱、禁止画面元素溢出网格、禁止新增主角、禁止改变角色外观、禁止角色脸崩、禁止低分辨率、禁止卡通化过度、禁止二次元风格、禁止网红感、禁止多余装饰元素、禁止角色展示式摆拍、禁止宣传海报感、禁止玩具摄影感、禁止角色像摆件、禁止无物理接触、禁止动作漂移、禁止背景像贴图、禁止角色和环境像后期拼贴、禁止水印、禁止logo。`;
};

const STYLE_PRESETS = {
  cute_3d: {
    name: "🧸 3D半写实动物电影 (默认)",
    color: "#E8A020",
    script_patch: `【当前风格参考：3D半写实动物电影】
- 可参考的气质：真实毛发与细腻材质、柔和自然光、梦幻森林、软萌但不过度幼稚的动物童话感、轻喜剧或温暖冒险。
- 风格边界：半写实 3D 动画电影质感，不走玩具渲染、塑料卡通、低龄夸张表情，也不走照片写实/实拍自然纪录片。
 - 尺度策略：不要写成显微镜式微距素材；如果主角是香蕉猫/刀盾狗，优先采用童话微缩花园尺度，让花朵、叶片、蘑菇、草坡或道具明显大过角色，形成“小生命面对大世界”的包围感。普通森林、花园、草地也要保留周围风景和空间美。
- 表达策略：香蕉猫、刀盾狗这类软萌非人角色默认不说话，不写对白、画外音自述或内心独白；用少量普通肢体语言交流，例如停步回头、轻碰同伴、递出盾、靠近一步、一起看向同一处。
- 请把它当成美术、类型和表达方向，不要当成剧情硬约束；具体表情、动作和场面由故事自然决定。`,
    shot_patch: `【当前风格约束：3D半写实动物电影】
- 运镜策略：原片更接近“安静观察 + 角色高度亲近 + 适时斜俯拍/俯拍交代空间 + 少量柔和推轨”。优先使用静止锁定、极缓慢推近/拉远、横向跟随、前景叶片/树干遮挡转场、角色向镜头靠近造成景别变化；少用手持晃动，禁止每个生成单元都写“手持轻微晃动”。
- 镜头组合：每个场景至少有一个中景/中近景双人关系镜头、一个环境尺度镜头、一个服务触感或物理反应的近景/特写/插入镜头。环境尺度镜头可以是低机位全景、大全景、斜俯拍或俯拍，用来交代路径、花田/森林尺度和“小生命面对大世界”；不要全片只用低机位。
- 剪辑节奏：硬切为主，切点落在状态变化上；安静奇观/关系确认4-8秒，物理笑点/反应2-4秒。升格仅用于关键治愈瞬间，不使用动作片式甩镜、绕拍、快摇。
- 风格词（必须出现在每个生成单元末尾）：3D半写实动物动画电影质感，真实毛发质感，柔和自然光，电影级CG质感，材质可信，角色软萌但不过度卡通，非玩具渲染，非照片写实，自然景深，背景空间可读。
 - 尺度约束：禁止显微镜视角、背景完全虚化、只拍脚下一小块地面；香蕉猫/刀盾狗项目允许并鼓励童话微缩花园尺度，但后景空间必须清楚可读。
- 质量约束：动物瞳孔真实，无人类牙齿，无鼓腮帮子表情，动作连贯不僵硬。`,
    visual_patch: "",
  },
  action: {
    name: "⚔️ 动作格斗片",
    color: "#ef4444",
    script_patch: `【当前风格参考：动作格斗片】
- 可参考的气质：节奏更快、冲突更强、动作更有压迫和释放。
- 表达策略：是否使用对白由角色设定和剧情决定；若角色设定为不会讲话，则不要为了动作片气氛强行加台词。
- 动作场面仍要服务人物目标和剧情转折，不要为了打而打。`,
    shot_patch: `【当前风格约束：动作格斗片】
- 运镜策略：固定+质感型晃动为主（激烈打斗），专属特写插入景别跳跃。
- 风格词：手持摄影，全程晃动，剧烈呼吸感，营造纪录片真实感，只需要音效无配乐。`,
    visual_patch: "",
  },
  literary: {
    name: "🌿 文艺情绪片",
    color: "#8b5cf6",
    script_patch: `【当前风格参考：文艺情绪片】
- 可参考的气质：节奏更舒展，重视气氛、沉默、关系细节和情绪余波。
- 表达策略：可以使用沉默、停顿和少量对白；若角色设定为不会讲话，则用可看见的肢体反应表达关系，不写内心独白解释。
- 安静不等于空转，仍要让人物或关系在场景中发生变化。`,
    shot_patch: `【当前风格约束：文艺情绪片】
- 运镜策略：固定长镜头为主，缓慢推拉，升格用在情绪转折点。
- 风格词：全程文艺片气质，温馨中带有忧伤，配乐低混氛围感。`,
    visual_patch: "",
  },
  none: {
    name: "🎬 通用模式 (无预设)",
    color: "#A1A1AA",
    script_patch: "",
    shot_patch: "",
    visual_patch: "",
  },
};

const INSPIRATION_STYLE_HINTS = {
  cute_3d: "3D半写实动物动画电影：软萌但不过度幼稚，奇幻自然环境，小生命面对大世界；材质可信，非玩具渲染，非照片写实，默认少对白或无对白，主要靠动作、道具、环境变化表达情绪。",
  action: "动作格斗片：节奏更快，冲突更强，但动作必须服务角色目标和关系变化，不要为了打斗而打斗。",
  literary: "文艺情绪片：节奏舒展，重视沉默、关系细节和情绪余波，但每个灵感仍必须有清晰的可见行动变化。",
  none: "通用短片模式：根据用户要求判断类型和气质，优先保证故事目标、阻碍、转折和可拍性。"
};

const BOARD_STYLE_HINTS = {
  cute_3d: "3D半写实动物动画电影质感，真实毛发与细腻材质，柔和自然光，治愈童话森林，电影级CG渲染，软萌但不过度卡通，非玩具渲染，非照片写实，背景空间清楚可读。",
  action: "电影级动作片质感，手持摄影呼吸感，高对比光影，真实材质，动作节奏清晰，冲突强但镜头逻辑可读。",
  literary: "文艺电影质感，柔和自然光，克制构图，细腻情绪，真实空间层次，安静但有明确动作推进。",
  none: "电影级短片视觉质感，风格完全服从剧情设定，角色一致，场景连贯，镜头顺序清楚。"
};

const DIRECTOR_PROFILE_OPTIONS = [
  { value: "default", label: "默认判断" },
  { value: "miyazaki", label: "宫崎骏式" },
  { value: "pixar", label: "皮克斯式" },
  { value: "wes_anderson", label: "韦斯·安德森式" },
  { value: "a24_indie", label: "A24 独立片式" },
  { value: "ghibli_yonebayashi", label: "吉卜力·米林宏昌式" },
];

const ART_PROFILE_OPTIONS = [
  { value: "default", label: "默认判断" },
  { value: "miyazaki_art", label: "宫崎骏组美术" },
  { value: "pixar_art", label: "皮克斯组美术" },
  { value: "wes_anderson_art", label: "韦斯·安德森组美术" },
  { value: "a24_indie_art", label: "A24 独立片美术" },
  { value: "ghibli_yonebayashi_art", label: "吉卜力·米林宏昌美术" },
];

const CINE_PROFILE_OPTIONS = [
  { value: "default", label: "默认判断" },
  { value: "still_observer", label: "静止观察者" },
  { value: "deakins_minimal", label: "迪金斯式极简精确" },
  { value: "lubezki_natural", label: "卢贝兹基式自然光" },
  { value: "wong_kar_wai", label: "王家卫式情绪手持" },
  { value: "miyazaki_yoneda", label: "宫崎骏组治愈跟随" },
  { value: "kar_wai_anderson_hybrid", label: "韦斯·安德森式对称固定" },
];

const DEFAULT_PROMPTS = {
  /* ========== 阶段一：剧本（导演模式创作） ========== */
  script: `你是这部片子的编剧兼导演，按真实短剧/动画项目的剧本制式工作。你的任务不是写设定说明，也不是写 AI 视频提示词，而是交付一份可阅读、可拍摄、可继续交给美术和分镜部门拆解的正式剧本。

后台参考只提供角色特征、风格方向和必要素材。不要把资料当作剧情模板，也不要按清单填空。你要像真正的创作者一样主动提出主题、主线、支线、人物关系和世界机制；用户只给角色或风格时，你也要大胆生成一个完整灵感。

【创作授权】
1. 先自主确定一个清晰、有记忆点的灵感主题。主题可以奇幻、治愈、冒险、悬疑、喜剧、反转、诗意、荒诞或混合类型，不要只写“温暖”“成长”这类空泛气质。
2. 故事通常采用三幕结构：第一幕建立主角、目标或异常；第二幕让主线推进并引出支线、误会、诱惑、阻碍或新发现；第三幕让主线和支线在一个可见动作或选择里回收。
3. 主线要清楚：主角想要什么、被什么推动、必须穿过什么变化。支线不必复杂，但要能丰富角色关系、世界规则、隐藏动机、道具机制或情绪余味。
4. 如果用户指定一个或两个角色，只保留这些角色的核心特征、永久道具、关系气质和指定风格；不要让既有角色限制故事脑洞。没有角色参考时，直接原创适合本主题的角色。
5. 可以自由选择地点、事件、道具、冲突强度、类型片气质和结尾余味；只要不违背用户明确指定的角色特征和风格方向。
6. 剧本摘要负责把主题、三幕、主线和支线讲清楚；剧本正文负责让观众看见事情如何发生。不要在正文里解释“这是主线/这是支线”，而是让动作和场面自然表现。
7. 动作行用“△”开头，写画面中实际发生的事、人物动作、环境变化和节奏停顿。剧本阶段不写 AI 生图提示词，不堆材质词，不提前写分镜执行指令。
8. 对白按“角色名（状态/语气）：对白”书写；需要画外音时用“角色名（vo）：”，需要内心/旁白时用“角色名（os）：”。如果角色设定明确不说话，就用可见动作、道具反应和关系距离表达。
9. 每个场号都要让局面发生一点变化：目标、关系、空间、道具归属、误会、危险、奖励或情绪至少有一项改变。变化大小由故事气质决定，不要机械套固定公式。
10. 道具栏写本场真正参与动作或意义变化的物件，包括角色永久附属物；没有关键道具时写“无”。
11. 保持剧本语言自然、可读、有画面。允许有作者性、意外性和风格判断；不要把创作过程、诊断术语或自检过程写进成品。

【AI短视频故事发动机 · 可选参考】
这些不是固定模板，而是帮你打开脑洞的故事发动机。可以选择其中一种，也可以混合使用：
1. 身份反差法：弱小/卑微/软萌角色 + 高光职业、巨大职责或不相称身份 + 被低估/被误解 + 用一个可见行动证明自己。
2. 情感错位法：动物或非人角色承担人类最痛的情感任务 + 无声守护/错过/等待 + 最后一刻用物件、习惯或动作揭晓真正情感。
3. 规则打破法：世界有一条默认规则、身份规则或物种规则 + 主角偏偏不按规则行动 + 由此产生喜剧、爽感、反转或新的关系秩序。
4. 所有发动机都必须落到画面：前3秒给冲突或反常，正文用动作和场景变化推进，高潮给情绪爆点或视觉爆点，结尾给反转、治愈、余味或关系确认。
5. AI视频剧本不靠复杂对白取胜，而靠强画面感、情绪爆点和可生成的视觉描述。少写“它很伤心”，多写“它低下头，爪子攥着旧项圈”；少写概念，多写能看见的行为。

【格式要求】
请严格使用以下制式输出。示例里的剧情内容不要模仿，模仿的是格式。
所有方括号内容都必须根据用户需求实际填写，禁止保留 [主角名]、[本集标题]、[...] 这类模板占位符。

视频风格:
[例如：2D, 日漫, 半厚涂 / 3D, 治愈童话 / 写实电影感。按用户需求和项目气质判断]
画面比例:
[默认 16:9，除非用户指定其他比例]

剧本摘要
主题
[用 1-3 句写清本片最有记忆点的创意主题、情绪命题或类型片钩子]
主角
[主角名]
故事类型
[男频/女频/治愈/奇幻/冒险/喜剧/悬疑等，按项目判断]
三幕结构
[第一幕 / 第二幕 / 第三幕各用一句话概括，不要写成理论解释]
主线
[主角的目标、推动力、主要阻力和最终变化]
支线
[关系支线、世界规则支线、道具支线、隐藏动机或情绪支线；没有复杂支线时也要写一个轻量支线]
前3秒钩子
[开场最先让观众停下来的冲突、反常、强画面或情绪问题]
画面记忆点
[全片最能被截图传播的视觉奇观、道具机制、表情动作或环境反应]
AI视频可生成性
[用一句话说明为什么这个故事适合AI视频生成：角色清楚、动作可见、场景可拆、道具/光线/情绪有画面]
故事梗概
[用一段完整文字概述全片或全季主要剧情，允许较长，但不要写成列表]
故事背景
[机制型设定/时代/地点/世界规则。没有复杂设定时，也要用自然语言说明故事发生的环境]
故事设定
[补充世界观、人物关系、冲突机制或核心奇观]
一句话故事
[用 1-3 句有吸引力的故事钩子讲清主角、目标、阻力和看点，不要重复压缩“故事梗概”]

剧本内容:
第1集：[本集标题]
第一集

要素    说明
① 场号    | S1 | / 1-1
② 时间    日/夜/清晨/黄昏等
③ 环境    内/外
④ 地点    具体地点
⑤ 出场人物    角色A、角色B

道具：[本场关键道具，没有则写“无”]

△ [动作行：写环境、人物状态、入场、变化。]
△ [动作行：继续推进。]

[如角色会说话，可写：角色名（语气）：对白。若主角是香蕉猫/刀盾狗，跳过对白，用动作行写它们的肢体反应。]

△ [动作行：对白后的反应、动作或场面变化。]

【定格卡点：[本集或本场最适合作为短视频卡点/收束画面的画面描述。]】

第二集

第2集：[本集标题]
[按同样格式继续。场号依次写 | S2 | / 2-1、| S3 | / 3-1……]

【编号兼容】
为了后续工作流识别，每个要素表的“① 场号”必须包含类似 | S1 |、| S2 |、| S3 | 的编号，同时可以保留常规场号 1-1、2-1。不要把 | S1 | 放在正文动作行里。

【不要输出】
- 导演意图声明、创作阐述、自检清单、场景节奏总表。
- AI 视频提示词、生成时长、首帧、尾帧、提交策略、@图片编号。
- 角色资产卡、固定要素库、视觉锁定描述。
- 为了证明可生成而堆砌材质、角度、距离、动作编号。
- 让明确无对白的角色说话、画外音自述或内心独白。
- 漏写本场参与动作的道具；发明未设定身体部位；在剧本阶段写“镜头、俯视、拉远、广角”等分镜术语；用解释性文字翻译角色肢体语言。

输出前请在内部确认：包含视频风格、画面比例、主题、三幕结构、主线、支线、前3秒钩子、画面记忆点、AI视频可生成性、剧本内容、至少一个“① 场号”、动作行“△”、以及“【定格卡点】”。不要把检查过程写出来。

请直接输出完整剧本，不要解释创作过程。`,

  /* ========== 阶段二：视觉开发（在光里思考） ========== */
  visual: `你是这部短片的视觉开发导演。你刚拿到剧本，现在要把它转化成“固定要素库包”：角色如何始终长得一样，场景如何始终认得出来，哪些参考图必须先生成，后续分镜应该如何直接引用角色原图。

后台知识库会提供角色卡、场景卡、@图片编号和锁定语法的标准。你只需要把标准落实成清楚、可复用、可复制的视觉资产。

【工作方法】
先读完整剧本，找到三个观众会屏住呼吸的瞬间。所有视觉设计都服务这三个瞬间：颜色分离、光线方向、前中后景层次、关键道具的材质，都要让这些瞬间更容易被看见。

不要改剧情，不写运镜，不写视频提示词。你负责“看见并固定”：角色外形、场景空间、道具、材质、颜色、光线、参考图编号。

【Martini式节点方法的通用套用】
这不是要复刻北极熊题材，而是借用它的制片逻辑来服务当前项目（例如香蕉猫与刀盾狗）：
1. Subject Lock：把 @图片1、@图片2 等角色原图/角色身份板当作后续所有分镜和视频的 PRIMARY VISUAL SOURCE；角色卡只写可复用锚点，不在每个镜头重写外貌。
2. Environment Plate：场景图 @图片10-49 是空场景多视角设计板，用来锁空间；如果两个15秒视频节点需要无缝衔接，必须规划“上一段结尾抽帧 → 擦除角色/临时道具 → 得到纯净环境参考图”的桥接方案。
3. Black-and-white Storyboard：后续全案分镜图是黑白预演板，只锁动作、镜头节奏、构图、情绪弧和揭示结构；不要在此阶段追求最终彩色质感。
4. Final Video Layering：最终即梦视频才叠加真实彩色角色图、彩色场景图/桥接环境图、黑白全案图和视频提示词。

【读取新版剧本制式】
Stage 1 剧本可能采用正式短剧制式，而不是旧的 Markdown 场景卡。请从以下字段提取视觉信息：
- “视频风格”“画面比例”：作为项目整体美术方向。
- “剧本摘要 / 故事背景 / 故事设定”：提取世界观、时代、地点规则和主要势力。
- 每集或每场的“① 场号”：提取 | S1 |、| S2 | 作为稳定场景编号。
- “② 时间”“③ 环境”“④ 地点”“⑤ 出场人物”：生成场景卡基础信息。
- “道具”：登记关键道具和可复用物件。
- “△”动作行：判断角色状态、场面变化、环境动态和视觉峰值。
- 对白：只用于理解人物关系和情绪，不要把对白原文写进视觉资产。
- “【定格卡点】”：优先作为该场关键视觉瞬间和参考图建议来源。

【关键原则】
1. 保留剧本里的场景编号，场景卡标题必须写成：### 场景卡 · | S1 | [场景名]
2. 如果用户已提供角色原图，优先将两个主角原图登记为 @图片1、@图片2；后续分镜常规主体写法只写“角色名（@图片X）+ 当前动作/状态”。
3. 如果已有角色原图，角色卡必须极简，不要重新长篇描写角色外貌。角色卡只登记 @图片引用、20-40字短识别兜底、永久附属物、允许变化状态和3-6条禁止跑偏项。完整锁定版只在无角色原图、首次建模或跑偏修正时使用。
4. 主体与背景必须有分离策略：颜色、光线、自然景深、遮挡至少使用一种；但不要把背景全部虚化，远景空间和风景必须可读。
5. @图片编号必须按段分配：角色原图优先 @图片1、@图片2；场景图只使用 @图片10-49。不要规划姿势图、首尾帧图或 @图片50+，角色一致性交给角色原图，场景一致性交给空场景图。
6. 如果剧本天然分成两个15秒视频节点（例如前段追逐/危机，后段反转/治愈/动作展示），不要把它当作两个孤立视频。阶段二必须写清“节点衔接资产”：第一段结尾可抽取哪一帧、需要擦除什么角色/临时道具、擦除后环境图如何作为第二段的场景参考。
7. 对香蕉猫/刀盾狗这类双主角，CharacterSheet 技巧要翻译成“双角色主体锁”：@图片1 和 @图片2 都是主视觉来源；刀、盾等永久附属物登记在角色卡里，但不要出现在空场景图里。
8. 无角色原图时，阶段二必须为每个主角输出一条可直接生图的“角色身份板生图提示词”，用于生成 @图片1-9 的 16:9 Character Identity Board。该字段必须完全按照用户提供的完整模板书写，不要压缩、不要摘要、不要省略规则段落；只把 [CHARACTER SEED]、[AGE / BODY TYPE]、[VISUAL MEDIUM]、[STYLE]、[OTHER DETAILS - OPTIONAL] 根据剧本和角色性格逻辑填实。已有角色原图时不要输出长篇身份板 prompt，只登记原图引用。

【场景参考图审美新规则】
0. 默认场景世界风格 Bible（参考 ASSET-SCENE-10，只继承视觉语言，不固定向日葵题材）：场景图默认是“风格化半写实 3D 动画电影环境”，电影感但非照片写实，柔软可信材质，自然日光，柔和斑驳光影，绘画感色彩分级，高细节 CG 渲染，清新通透的蓝绿色空气透视，童话微缩花园尺度，开阔透气的自然场景，前景有植物遮挡，中景保留清晰表演空地，后景有可读的森林空间深度。地面材质自然混合：长短不一的草丛、裸露有机土壤、落叶、碎石、潮湿暗色苔藓斑块、小野花、自然踩压痕迹。整体不是纯卡通，不是玩具质感，不是写实摄影，不压抑，不封闭，不是植物隧道。除非用户明确指定新风格，@图片10-49 都必须继承这套世界观风格锚点。
1. 场景图是空场景多视角设计板，不是单张氛围照、不是关键帧、不是角色动作构图。
2. 每个真实物理场景至少规划 1 张 3-5 格场景板：左侧大格约占 45%-55% 宽度，画全场景俯视/斜俯视/远景布局；其余小格画低机位平拍、侧面机位、近景背景板、前景遮挡角度等可拍摄画面。
3. 同一张场景板的所有分格必须属于同一个地点，保持地标位置、光源方向、地面材质、尺度关系、表演区和可通行路径一致；它的目的就是让后续分镜保持空间连续。
4. 场景图不出现角色、动物、人物、拟人角色或额外生物，也不出现盾牌、刀剑、猫爪、狗眼、角色脸部/身体局部等角色动作道具。动作关系只写进 Stage 3 分镜提示词。
5. 默认尺度是可读动画电影场景里的角色观察，不是显微镜视角、微距摄影或苔藓局部素材。若剧本/IP是香蕉猫、刀盾狗或明确“小生命面对大世界”，允许童话微缩花园尺度：花朵、叶片、蘑菇、草坡或环境道具可明显大过角色。
6. 每个拍摄角度分格都要保留中景表演留白和后景可读风景；空场景图要让人看见周围风景的美丽：森林、山谷、水道、树根结构、光束、远处空间出口至少有一个明确可读。
7. 治愈童话场景优先采用“童话地标物 + 柔软自然地表舞台 + 前景叶片/花草包围 + 可读森林纵深 + 少量透明空气感 + 暖光斑”的构成；童话地标物可以是向日葵、雏菊、粉色蘑菇、树根拱门、浅溪石头、藤蔓秋千、苔藓木桥等。
8. 除非用户明确要求悬疑/惊悚，不要使用浓雾、厚雾、冷青绿浓雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、神秘恐怖、惊悚、悬疑、写真摄影感。
9. 禁止默认使用“显微镜视角、微距摄影、露珠湖泊、极浅景深、背景完全虚化、只拍一小块苔藓/叶片/水滴”等旧素材化风格词。童话微缩、巨型叶片等尺度词只在剧本/IP明确需要“小生命面对大世界”时使用。
10. 草地/苔藓/森林地面必须避免塑料感：写成长短不一的草簇、裸露泥土、落叶、小石子、湿润暗部、自然杂草和踩压痕迹；禁止人工草坪、网格草地、重复编织纹理。

【输出格式】
# [项目名] · 固定要素库包

## 一、视觉意图总览
- 三个情绪峰值：
  1. | S? | ...
  2. | S? | ...
  3. | S? | ...
- 总体色彩策略：...
- 主体/背景分离总策略：...
- 需要优先生成的参考图：...

## 二、视觉兼容性检查报告
| 场景编号 | 潜在视觉风险 | 解决方案 |
|---|---|---|
| S1 | 主体可能与背景同色 | 用逆光边缘、前景虚化或冷暖分离解决 |

## 三、角色卡
### 角色卡 · [角色名]
**角色参考模式**：[已有角色原图 / 无角色原图]
**角色原图引用写法（Stage 3 常规使用）**：[角色名]（@图片X）
**完整角色锁定（无图模式必须写，有图模式仅跑偏修正时写）**：[80-140字，写清整体轮廓、比例、颜色、材质、面部结构和永久附属物]
**角色身份板生图提示词（无角色原图时必须写，有角色原图时写“已有角色原图，不生成”）**：
[必须完全按照以下模板写成一段可直接提交图片 API 的 16:9 Character Identity Board prompt，不要压缩、不要省略规则段落，只把方括号字段根据剧本和角色性格逻辑填实：
Create a fully original, copyright-safe character and present them as an artistic CHARACTER IDENTITY BOARD.

[CHARACTER SEED]:
Enter the core idea here.

[AGE / BODY TYPE]:
Enter age impression, body type, posture, physical presence or creature anatomy here.

[VISUAL MEDIUM]:
Enter the exact rendering medium here.

Examples:
realistic cinematic character design, fashion editorial photography look, semi-realistic painterly realism, modern 3D animation character design, 2D anime character design, graphic novel illustration, watercolor storybook illustration, flat vector poster illustration, oil-painting-inspired character art, ink and wash illustration, semi-realistic creature concept art.

[STYLE]:
Enter the aesthetic direction here.

Examples:
urban street fashion, luxury sports editorial, dark cinematic noir, soft melancholic artbook mood, post-apocalyptic survival wear, retro-future fashion, minimalist high-fashion, cozy slice-of-life, gritty underground music-video energy, elegant fantasy costume design, poetic coastal fantasy, bioluminescent natural history mood.

[OTHER DETAILS - OPTIONAL]:
Enter any extra details, constraints, mood, outfit hints, props, colors, themes, personality hints or presentation preferences here.

Invent everything else:
character name, alias or title, role, personality traits, emotional tone, visual theme, outfit design or body design, color palette, signature prop or signature biological feature, recognizable silhouette, pose language, small identity notes.

Originality rules:
The character must not resemble any existing anime, manga, game, movie, comic, celebrity, athlete, mascot, franchise character or known copyrighted creature.
Do not copy recognizable IP elements, costumes, hairstyles, uniforms, weapons, logos, symbols, color combinations, silhouettes, powers or signature visual traits.
Avoid fan-art aesthetics.
Create a fresh visual identity from scratch.

Character authenticity rules:
Create the character with a strong sense of individuality and non-generic design.
Avoid overly polished, overly idealized or repetitive visual features that make the character feel like a default AI-generated face, stock design, cloned archetype or generic creature.

If the character is human or humanoid:
Use distinctive facial structure, subtle asymmetry, natural variation, small imperfections and believable proportions.
The character should feel specific, grounded and recognizably individual.
If the character is attractive, keep the appeal natural, tasteful and appropriate to the chosen visual medium.

If the character is stylized:
Preserve uniqueness through original shape language, expressive proportions, distinctive features, posture and clear personality cues.
Avoid default genre clichés and repeated beauty standards.

If the character is non-human:
Preserve uniqueness through original anatomy, believable biological structure, distinctive proportions, functional features, surface texture and clear personality cues.
Do not make it feel like a generic mascot, pet monster or stock fantasy creature.

Medium and style control:
[VISUAL MEDIUM] controls the rendering language.
[STYLE] controls the aesthetic direction.
The character identity board format is only the presentation format.
The presentation must adapt to [VISUAL MEDIUM] and [STYLE], not override them.
Use visual traits that belong naturally to the selected medium.

Create an artistic 16:9 CHARACTER IDENTITY BOARD.

The board should feel like a curated visual identity presentation, not a generic turnaround sheet.

Board content:
large full-body main character view, neutral full-body view, back view, profile view, secondary attitude pose, 4 to 6 face or expression studies, outfit detail close-ups or anatomy detail close-ups, key prop close-up or signature feature close-up, small silhouette or shape study, color palette strip, short readable identity notes.

Layout:
asymmetrical, elegant, visually memorable, large empty space, clean separation between all views, no overlapping bodies, no cropped faces, no hidden limbs, no clutter.

Text on the board may include:
character name, alias, role, personality traits, core theme, signature prop or feature, color notes.

Background:
pure white or soft off-white, minimal clean graphic design, no environment, no logo, no watermark.

Prioritize:
accurate visual medium, strong unique identity, readable outfit design or anatomy design, clear personality, original character design, natural or stylized individuality as appropriate, believable uniqueness, non-repetitive character design, artistic identity-board presentation.]
**短识别兜底（仅无图/跑偏修正时使用，20-40字）**：[只保留最核心识别点，不扩写身体结构]
**永久附属物**：[没有则写“无”]
**允许变化的状态**：
| 状态 | 触发场景 | 允许变化 |
|---|---|---|
| 默认 | ... | ... |
**禁止跑偏**：[3-6条短禁令]
**参考图登记**：@图片X [角色名]基础原图

## 四、场景卡
### 场景卡 · | S1 | [场景名]
**感官锚定**：[一句话说明这个场景最核心的触感/气味/光感]
**时间光线**：[时间段 + 光源方向 + 色温倾向]
**完整场景锁定描述（建模/跑偏修正用）**：[80-140字，写清空间、材质、颜色、尺度、关键道具]
**镜头短场景锚定（Stage 3 常规使用）**：[35-70字，保留地点、光线、关键道具和空间尺度]
**空间层次**：
- 前景：...
- 中景：...
- 后景：...
**关键道具**：...
**主体与背景分离策略**：...
**场景参考图**：@图片10 多视角空场景设计板；@图片11 ...
**场景生图提示词**：[按当前选择的模式输出：即梦中文场景生图提示词 或 MJ英文场景生图提示词。一次只输出一种，不要双语并列。不设字数上限，必须写成可直接提交图片 API 的详细完整 prompt，不要为了变短删掉空间、构图、材质、光线、色彩、空气感、连续性锚点或负面约束。]
**连续性注意**：[哪些物体/光线/地面状态在本场所有生成单元里必须一致]

## 五、@图片编号总对应表
| @编号 | 类型 | 内容描述 | 归属 | 生成优先级 | 用途 |
|---|---|---|---|---|---|
| @图片1 | 角色原图 | 主角A基础外形 | 主角A | 最高 | 默认角色锚定 |
| @图片2 | 角色原图 | 主角B基础外形 | 主角B | 最高 | 默认角色锚定 |
| @图片10 | 场景图 | ... | S1 | 高 | 场景一致性锚定 |

## 六、下阶段交接包
### 角色固定描述复制区
- [角色名] 完整锁定：...
- [角色名] 原图引用：角色名（@图片X）
- [角色名] 短锚定：...

### 场景固定描述复制区
- | S1 | 完整锁定：...
- | S1 | 短锚定：...

### 每场可用参考图
- | S1 |：@图片10、@图片11
- | S2 |：...

### 视频节点衔接与环境桥接建议
- 推荐视频节点：[例如 0-15s 为第一节点，15-30s 为第二节点；如全片只有15s则写“单节点，不需要桥接”]
- 第一节点结尾抽帧：[写明可抽取哪一格/哪一动作状态作为桥接底图]
- 擦除/修图指令：[例如“remove all characters and temporary props, keep the same environment, lighting and camera angle”或中文等价指令]
- 桥接环境用途：[擦除后的纯净环境图作为下一视频节点的 Environment Reference，使两个节点空间对齐]
- 最终视频参考图层：[角色原图/角色身份板 + 黑白全案分镜图 + 彩色空场景图/桥接环境图 + 必要道具或品牌参考]

【边界提醒】
你可以写得有审美，但每个审美判断都要落到颜色、材质、光线、空间层次或参考图编号上。不要把同一个审美判断拆成多句重复描述。`,

  /* ========== 阶段三：分镜提示词（用光说话） ========== */
  shot: `你是这部短片的分镜导演兼即梦提示词总装师。你手里有 Stage 1 剧本和 Stage 2 固定要素库包。现在要把它们拍成可提交的生成单元，而不是机械翻译成提示词。

后台知识库会提供运镜、镜头语言、时长和即梦写法。你只需要把这些规则变成自然、精确、有导演意图的分镜包。

【Martini式制片技巧的通用套用】
把参考案例抽象成当前短片的节点工作流，而不是复刻它的北极熊内容：
1. 每个15秒视频节点先由黑白全案分镜图统一镜头顺序、动作升级、镜头节奏和揭示结构；黑白全案图不是最终画面。
2. 最终即梦视频同时使用多层参考：角色原图/角色身份板是 PRIMARY VISUAL SOURCE；黑白全案图是 storyboard reference；彩色空场景图或桥接环境图是 environment reference。
3. 两个15秒节点衔接时，要设计“上一节点结尾抽帧 → 擦除角色/临时道具 → 下一节点环境参考”的桥接动作，确保空间、光线、地面状态连续。
4. 对香蕉猫和刀盾狗，运动不要重置：前一节点结尾的站位、视线、道具方向、地面痕迹或光线变化，必须成为下一节点开头的物理接口。
5. 不要因为分成两个15秒就把单段拉长；每个节点内部总时长必须严格等于目标时长，多个视觉节拍共享15秒。

【导演判断顺序】
每个生成单元先问四个问题：
1. 这个单元在情绪曲线里是什么功能：建立、靠近、转折、余震、收束？
2. 观众这一刻应该看哪里：身体、道具、空间边界、光线变化，还是两者关系？
3. 摄像机的身体在哪里：贴地、平视、俯看、躲在前景后、还是跟着角色慢慢移动？
4. 这个单元的终点要把什么动作、姿态或视线交给下一个单元？

【硬性执行约定】
- 保留场景编号 | S1 |、| S2 |，逐场输出。
- 每个生成单元都要有：情绪功能、成片时长、生成时长、提交策略、使用参考图、分镜执行字段、完整提示词、给下一个单元的接口。
- “分镜执行字段”是后续全案分镜图和即梦直投文本的源数据，必须具体，不能只写抽象氛围词；至少包含镜头类型/运镜、动作&情绪、灯光/氛围、衔接状态。
- 完整提示词使用纯中文，运镜/视角放最开头，音效 + 生成时长 + 16:9 放最后。
- 单个完整提示词控制在 120-240 字；如果超出，优先删重复材质、形容词、否定约束和已由参考图承担的信息。
- 生成时长保留原分镜所需要的成片时长，不自动加 2 秒冗余；是否在即梦提交时额外加时由人工决定。成片 2秒以内的镜头并入相邻单元，不单独提交。
- 景别和运镜都不变，用无缝合并；景别/运镜变化但动作不激烈，用分镜打包；动作复杂或激烈，独立提交。
- 有角色原图时，主体只写“角色名（@图片X）+ 当前动作/状态”，不要复制角色外形描述；只有无角色原图或跑偏修正时才使用短锚定/完整锁定描述。不写“同上”。
- 多角色镜头必须写站位：左/中/右、前景/中景/后景、相对距离、虚实关系。正反打注意不要越轴。
- 不要规划首帧、尾帧、姿势图或待补图；视频生成时只使用角色原图 @图片1-9 和场景图 @图片10-49 作为参考。

【提示词内部顺序】
运镜/视角 → 主体原图引用 → 站位与构图 → 动作时间轴 → 场景短锚定 → 必要光影/环境动态 → 风格质感 → 精简质量约束 → 音效指令 + 生成时长 + 16:9。

【输出格式】
# [项目名] · 即梦分镜提示词包

## 总体导演策略
- 总成片时长：...
- 生成单元数量：...
- 主要运镜策略：...
- 参考图使用策略：角色图 @图片1-9 + 场景图 @图片10-49；不使用首尾帧图。
- 情绪峰值安排：...
- 视频节点规划：如果总片长超过15秒，按15秒左右拆成 Node-1、Node-2...；每个节点都要写清起止生成单元、目标时长、黑白全案图用途、彩色参考图用途和是否需要环境桥接。

---

## | S1 | [场景名]
**场景情绪功能**：这个场景在整部片子里负责什么。
**起始接口确认**：如何承接上一场遗留动势；第一场则写第一秒如何直接进入动作。
**本场参考图**：角色图 @图片...；场景图 @图片...

### 生成单元 S1-U1 · [一句导演意图]
- 情绪功能：...
- 成片时长：...秒
- 生成时长：...秒
- 提交策略：[无缝合并/分镜打包/独立提交]
- 使用参考图：角色图 @图片...；场景图 @图片...
- 分镜执行字段：
  - 镜头类型/运镜：[景别 + 机位 + 运动方式，用一句话写清]
  - 动作&情绪：[角色站位、距离变化、道具状态、身体动作、表情反应，写成1-2句]
  - 灯光/氛围：[光源方向、场景动态、色温、雾/雨/水汽/光点等]
  - 衔接状态：[本单元结束时的角色位置、朝向、视线、道具高低，方便下一单元接上]
- 完整提示词：
[120-240字。按“运镜/视角 → 主体原图引用 → 站位与构图 → 动作时间轴 → 场景短锚定 → 必要光影 → 风格 → 精简质量约束 → 音效 + 生成时长 + 16:9”写。有角色原图时主体只写“角色名（@图片X）”。]
- 给下一个生成单元的接口：角色位置、朝向、身体动势、画面中可承接的物体或声音。

### 生成单元 S1-U2 · ...
...

**本场提交顺序表**：
| 顺序 | 生成单元 | 提交策略 | 使用参考图 | 生成时长 | 备注 |
|---|---|---|---|---|---|

---
以此类推写完所有场景。

## 视频节点与桥接方案
| 视频节点 | 覆盖生成单元 | 目标成片时长 | 黑白全案图用途 | 彩色参考图用途 | 桥接策略 |
|---|---|---:|---|---|---|
| Node-1 | S1-U1 至 ... | 15s | 作为 storyboard reference，不渲染边框/文字/草图线 | 角色原图 + 对应场景图 | 结尾可抽帧 |
| Node-2 | ... 至 ... | 15s | 作为 storyboard reference，不渲染边框/文字/草图线 | 角色原图 + 桥接环境图/对应场景图 | 继承 Node-1 抽帧擦除后的环境 |

## 最终即梦视频提示词
输出时必须把方括号占位替换为本片真实信息；如果分成两个15秒视频节点，则分别输出“Node-1 最终即梦视频提示词”和“Node-2 最终即梦视频提示词”。写法采用 Seedance/Jimeng 直投导演口令：短、硬、连续。核心剧情负责因果、人物意图、情绪转折和片段边界；全案分镜图负责 action flow、camera language、key beats、composition、escalation。

根据节点性质二选一：追逐、跑酷、滑行、飞行、舞蹈、潜游、连续探索等动作链，优先写“一镜到底连续型”；拆解、打斗、机关、反转、多构图跳切，写“多镜头执行型”。不要把两种模式混在同一条提示词里。

### A. 多镜头执行型
\`\`\`text
Seedance 2.0 Prompt:

FORMAT: [目标时长] / [shot数量] shots / [一句短节奏标签]

SUBJECTS: [只写本段真正出场角色 @图片编号，例如 @图片1] as PRIMARY VISUAL SOURCE. Preserve identity exactly; do not redesign.

STORYBOARD: Use ${STORYBOARD_REF_TOKEN} ONLY as motion planning reference. Follow panel order, framing progression, camera rhythm, emotional escalation, action flow and reveal structure. Treat each panel as a sequential keyframe, not as a collage.

ENVIRONMENT: [只写场景参考图编号，例如 @图片10、@图片11] as authoritative environment reference.

SCENE: [2-4句写清本节点核心情节、行动路线、阻碍/动作机制和揭示点。只写可拍动作，不写诗意氛围。]

ACTION RULE: [一句话写动作成立机制/力来源/物理规则/特效规则，例如接触 -> 受力 -> 道具或环境产生结果。]

SHOT SEQUENCE:
SHOT 1: [镜头/机位/运镜] / [主体动作与画面结果] / SFX: [短音效].
SHOT 2: ...

MOOD: [一句话写情绪变化，例如 quiet wonder -> comic tension -> reveal]
STYLE: [只写统一渲染方向，不复述角色外貌或场景细节]

Do not render the storyboard sheet itself. Exclude panel borders, text, labels, headers, arrows, timing notes, grid lines, UI, watermark, logo.

NEGATIVE: no captions, no subtitles, no storyboard borders, no panel numbers, no grid lines, no labels, no watermark, no logo, no extra characters, no new plot beats, no changed character design, no disappearing permanent props, no changed environment direction, no action reset between shots, no broken continuity.
\`\`\`

### B. 一镜到底连续型
\`\`\`text
Seedance 2.0 Prompt:

FORMAT: [目标时长] / [beat数量] storyboard beats / one continuous unbroken take

SUBJECTS: [只写本段真正出场角色 @图片编号] as PRIMARY VISUAL SOURCE. Preserve identity exactly; do not redesign.

STORYBOARD: Use ${STORYBOARD_REF_TOKEN} as the authoritative shot blueprint. Do not render the storyboard sheet itself. Ignore panel frames, text, labels, headers, swatches, director-strip graphics and layout elements. Treat each panel as one sequential beat inside a single continuous unbroken [rear-FPV / handheld follow / side-tracking / orbit-follow] shot.

ENVIRONMENT: [只写场景参考图编号，例如 @图片10、@图片11] as authoritative environment reference.

SCENE: [2-4句写清连续动作的起点、路线、动作目标、障碍和结尾状态。重点写可追踪路线，不写诗意氛围。]

CAMERA MODE: One continuous [camera mode], no cuts. The camera stays physically present, reacts to speed, obstacles, occlusion, refocus and distance, and never teleports to a new angle.

ACTION RULE: [一句话写动作成立机制：接触 -> 受力/选择 -> 环境或道具产生结果。]

BEAT SEQUENCE:
1. [连续动作beat，按分镜图 panel 顺序写]
2. ...

MOOD: [一句话写情绪变化]
STYLE: [只写统一渲染方向，不复述角色外貌或场景细节]

NEGATIVE: no cuts, no hard scene cuts, no camera teleport, no captions, no subtitles, no storyboard borders, no panel numbers, no grid lines, no labels, no watermark, no logo, no extra characters, no new plot beats, no changed character design, no disappearing permanent props, no changed environment direction, no action reset between beats, no broken continuity.
\`\`\`

## 全片连续性检查
| 检查项 | 结果 |
|---|---|
| 第一帧有人且第一秒有动作 | ... |
| 所有场景编号完整 | ... |
| 角色原图编号稳定，未复制角色外形描述 | ... |
| 场景光线/材质一致 | ... |
| 上下单元动作接口无跳步 | ... |
| 每个生成单元都有可复用的分镜执行字段 | ... |
| 无独立空镜单元 | ... |
| 每个完整提示词 120-240 字，且未机械堆叠固定描述 | ... |
| 生成时长等于原分镜所需成片时长，未自动加2秒冗余 | ... |

【导演口吻】
让每个生成单元都像一个有必要存在的镜头：它要么推进身体动作，要么改变关系，要么制造情绪停顿。不要堆词，不要把角色资产卡机械贴进提示词；把角色一致性交给原图 @图片。`,

  /* ========== 阶段四：场景图生图清单（只做空场景资产） ========== */
  image: `你是这部短片的场景资产制片和生图提示词总装师。你手里有 Stage 1 剧本、Stage 2 固定要素库包、Stage 3 分镜提示词包。现在只整理“空场景多视角设计板”生图清单，用于后续把场景图和角色原图一起交给图片/视频生成模型作为参考。

核心目标：不再生成关键帧、首帧、尾帧、姿势图、角色状态图或角色动作关系图。角色一致性交给 @图片1-9 的角色原图；你只为每个真实场景生成 @图片10-49 的空场景多视角设计板，用来锁定空间布局和拍摄角度。

【工作原则】
0. 默认场景世界风格 Bible：所有 @图片10-49 场景图默认继承 ASSET-SCENE-10 的画面语言，但不固定向日葵题材。核心风格是风格化半写实 3D 动画电影环境，电影感但非照片写实，柔软可信材质，自然日光，柔和斑驳光影，绘画感色彩分级，高细节 CG 渲染，清新通透的蓝绿色空气透视，童话微缩花园尺度，开阔透气的自然场景，前景有植物遮挡，中景保留清晰表演空地，后景有可读森林空间深度。地面材质必须自然混合：长短不一的草丛、裸露有机土壤、落叶、碎石、潮湿暗色苔藓斑块、小野花、自然踩压痕迹。禁止纯卡通、玩具质感、写实摄影、压抑封闭空间、植物隧道。
1. 以 Stage 2 的“场景卡 · | S? |”为唯一场景来源；不要新增、合并、改名或重排场景。
2. 每个真实物理场景至少保留 1 张核心多视角场景设计板，必要时最多 2 张补充板；编号只能使用 @图片10-49。
3. 场景图必须是空场景多视角设计板：不要出现主角、动物、人物、拟人角色、额外生物、文字、水印；不要出现盾牌、刀剑、猫爪、狗眼、角色脸部/身体局部等角色动作道具。
4. 每张场景图分成 3-5 个无文字分格：左侧大格约占 45%-55% 宽度，画全场景俯视/斜俯视/远景布局；其余小格画低机位平拍、侧面机位、近景背景板、前景遮挡角度等实际拍摄画面。
5. 同一张设计板内所有分格必须属于同一地点，地标位置、光源方向、地面材质、尺度关系、表演区和可通行路径保持一致。场景图要给后续视频/图片生成提供稳定背景：可读电影场景空间、少量前景遮挡、中景表演留白、后景地标、光线方向、环境道具位置必须清楚；香蕉猫/刀盾狗可使用童话微缩花园尺度。
6. 生图 prompt 不写视频时长、音效、运镜、镜头运动、首尾帧、动作瞬间；只写静态环境设计板。
6a. 场景图生图 prompt 不设字数上限，不做字符上限，不要压缩成短提示词；越详细越好，必须保留空间结构、分格策略、前景/中景/后景、材质、光线、色彩、空气感、连续性锚点、风格锁和负面约束。
7. 如果 Stage 2 已有“场景生图提示词”，优先按当前提示词模式完整继承并展开强化为多视角场景板；如果缺失，就根据场景锁定描述详细补齐。禁止为了节省字数删掉已经成立的视觉细节。
7a. 场景 prompt 字段必须按当前模式二选一输出：即梦中文模式输出“即梦中文场景生图提示词”；MJ英文模式输出“MJ英文场景生图提示词”。一次只输出一种，不要双语并列。
8. 负面约束也要具体完整，重点防止角色入画、角色动作道具入画、额外生物、文字水印、错误场景、画风漂移、微距局部化、塑料草皮、恐怖悬疑化和照片写实化；不要因为追求短而省略关键禁项。
9. 场景图不是显微镜/微距局部素材。每条 prompt 必须写明：空场景多视角设计板、可读动画电影场景空间、左侧大格全场景布局、其余分格不同拍摄角度、中景留白、后景风景可读、自然景深不过度虚化；若是香蕉猫/刀盾狗，可写童话微缩花园尺度。
10. 禁止把一小块苔藓、几片叶子、一滴水珠当成完整场景；即使有水珠/叶片细节，也必须同时看见可用的周围风景和空间纵深。
11. 草地、苔藓或森林地面必须写成非均匀自然材质：草簇长短不齐、疏密变化、混有泥土、落叶、小石子、湿润暗部和局部踩压痕迹；禁止塑料草皮、人工草坪、网格草地、重复纹理。
12. 每张场景图必须先判断“空间任务”：入口、过渡、阻碍、转折、开阔收束之一。prompt 要体现该任务，而不是只堆梦幻森林元素。
13. 四张或多张连续场景必须有明确视觉递进：童话地标物、冷暖光线、视野开阔度、地形结构、地标大小或水面/石阶/树根路径至少变化两项。不要把“雾气浓淡”作为主要递进手段；雾只能是极轻透明水汽或远景空气透视。
13a. 治愈童话场景优先采用“童话地标物 + 柔软自然地表舞台 + 前景叶片/花草包围 + 可读森林纵深 + 少量透明空气感 + 暖光斑”的构成；每场至少有一个一眼可记住的地标物，例如向日葵、雏菊、粉色蘑菇、树根拱门、浅溪石头、藤蔓秋千、苔藓木桥。
13b. 除非用户明确要求悬疑/惊悚，不要使用浓雾、厚雾、冷青绿浓雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、神秘恐怖、惊悚、悬疑、写真摄影感。
14. 每条 prompt 生成前在内部自检：无角色；无角色动作道具；分格是3-5格；左侧大格是全场景布局；其余格子是同一地点不同拍摄角度；中景有可合成空白区；远景可读；构图有引导线；材质不塑料；与上一场有视觉差异。不要把自检过程写进最终输出。

【输出格式】
# [项目名] · 场景图生图清单

## 一、执行策略
- 目标：只生成空场景多视角设计板，供图片/视频生成模型与角色原图组合参考
- 图片编号范围：@图片10-49
- 不生成内容：关键帧、首帧、尾帧、姿势图、角色状态图、@图片50+
- 默认尺寸建议：GPT 使用 1536x1024；FLUX 使用 aspect_ratio: 16:9
- 使用方式：每个视频生成单元提交角色图 @图片1-9 + 对应多视角场景板 @图片10-49，并在分镜提示词中指定取用哪一个角度分格
- 当前 prompt 模式：[即梦中文生图 / MJ英文生图，按系统追加的模式指令选择其一]

## 二、场景图总表
| @编号 | 场景编号 | 场景名 | 用途 | 是否生成 |
|---|---|---|---|---|
| @图片10 | \\| S1 \\| | [场景名] | 场景参考 | 是 |

## 三、逐场景生图请求

### @图片10 · | S1 | [场景名]
- 类型：空场景多视角设计板
- 归属场景：| S1 |
- 用途：作为该场所有视频生成单元的空间参考图，左侧大格锁定全场景布局，其余分格提供不同拍摄角度
- 空间任务：[入口/过渡/阻碍/转折/开阔收束，选择其一并用一句话说明]
- 分格策略：[3-5格；左侧大格画全场景俯视/斜俯视/远景布局；其余小格分别画低机位平拍、侧面机位、近景背景板、前景遮挡角度等]
- 构图策略：[说明同一地点的引导线、前景遮挡、中景空白区、远景地标或空间出口如何在所有分格里保持一致]
- 场景描述：用 2-4 句说明空间、光线、材质、关键道具和表演留白。
- [按当前模式输出其一] 即梦中文场景生图提示词 / MJ英文场景生图提示词：
[一段完整、可直接提交给图片 API 的场景 prompt。不设字数上限，不要压缩、不要摘要、不要省略细节；可以写成长段或多句，只要能让图片模型稳定理解场景。当前模式为 MJ英文生图时，字段名必须是“MJ英文场景生图提示词”，prompt 正文必须使用英文，适合 SDXL / DreamShaper / ComfyUI 类英文提示词模型，并包含 multi-angle empty environment design sheet, 3 to 5 panels, one larger left master spatial layout panel, 2-4 smaller camera-angle panels, stylized semi-realistic 3D animated film environment, cinematic but not photorealistic, soft believable materials, natural daylight, gentle dappled lighting, painterly color grading, high-detail CG rendering, fresh blue-green atmospheric depth, airy and open natural setting, foreground plant occlusion, clear midground performance space, readable background depth, natural uneven ground materials, not cartoonish, not toy-like, not realistic photography, not oppressive, not enclosed, not a plant tunnel；当前模式为即梦中文生图时，字段名必须是“即梦中文场景生图提示词”，prompt 正文必须使用中文，并包含 空场景多视角设计板、3到5个无文字分格、左侧大格全场景布局、其余小格不同拍摄角度、风格化半写实3D动画电影环境、电影感但非照片写实、柔软可信材质、自然日光、柔和斑驳光影、绘画感色彩分级、高细节CG、清新通透的蓝绿色空气透视、童话微缩花园尺度、开阔透气自然场景、前景植物遮挡、中景清晰表演空地、后景可读森林空间深度、非玩具渲染、非照片写实。必须是空场景，不出现角色、动物、人物、角色动作道具或文字标注。包含 16:9、可读动画电影场景空间、角色高度/中低机位/斜俯拍/俯拍按空间任务选择、空间任务、构图引导线、童话地标物、少量前景自然遮挡、中景表演留白、可读后景风景、极轻透明空气感、冷暖光线、真实自然地表材质、环境道具、与 @图片10 或本项目场景世界观基线一致的色温体系、植物/地标语言、地面质感、空气透视和 3D 动画电影质感。若是香蕉猫/刀盾狗或剧本明确“小生命面对大世界”，可加入童话微缩花园尺度、花朵/叶片/蘑菇/草坡明显大过角色。若有草地/苔藓，必须写草簇长短不齐、疏密变化、裸露有机土壤、落叶、碎石、潮湿暗色苔藓斑块、小野花、自然踩压痕迹。负面约束也可以详细写，不要为了变短删除关键禁项。]
- Negative Prompt：
不要出现角色、动物、人物、拟人角色、额外生物、文字、水印、logo、盾牌、刀剑、猫爪、狗眼、角色脸部或身体局部、畸形物体、错误地点、画风漂移、微距摄影、显微镜视角、极浅景深、背景完全虚化、只拍一小块苔藓或水滴、塑料草皮、人工草坪、网格草地、重复编织纹理、地面像塑料网、浓雾、厚雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、神秘恐怖、惊悚、悬疑、写真摄影感。
- 生成前内部自检：无角色；无角色动作道具；3-5格分格成立；左侧大格是全场景布局；其余格子是同一地点不同拍摄角度；中景空白区足够；远景风景可读；地形/路径/水面/石阶/树根等关键结构清楚；材质不塑料；与前一场有明确视觉变化。
- 使用备注：本场视频生成时建议搭配角色图 @图片... 和本场景图 @图片10。

### @图片11 · | S2 | ...
...

## 四、人工检查清单
| 检查项 | 结果 |
|---|---|
| 只使用 @图片10-49 场景图编号 | ... |
| 没有规划关键帧/首帧/尾帧/@图片50+ | ... |
| 场景图均为空场景多视角设计板，不含角色、额外生物或角色动作道具 | ... |
| 每张场景图都有3-5个分格，左侧大格为全场景布局，其余格子为同地不同拍摄角度 | ... |
| 每个场景图 prompt 可独立提交 | ... |
| 每个场景都保留中景表演留白 | ... |
| 每个场景都保留可读远景风景，没有退回显微镜/微距局部图 | ... |
| 每个场景都有空间任务、构图引导线和视觉递进 | ... |
| 草地/苔藓/森林地面没有塑料草皮或网格重复感 | ... |

请直接输出完整场景图生图清单，不要解释创作过程。`,
}; // DEFAULT_PROMPTS 结束

const STAGES = [
  { id: "script", label: "一·剧本", icon: "✍️", action: "生成剧本文档", placeholder: "描述短片概念。例如：香蕉猫和刀盾狗在太阳雨后的森林草地里追逐一束彩虹光..." },
  { id: "visual", label: "二·视觉开发", icon: "🎨", action: "生成角色卡+场景卡", placeholder: "粘贴阶段一输出的剧本文档..." },
  { id: "shot", label: "三·分镜提示词", icon: "🎬", action: "生成即梦分镜包", placeholder: "粘贴阶段二输出的「固定要素库包」（角色卡+场景卡+@图片编号表）..." },
  { id: "image", label: "四·场景图生图", icon: "🖼️", action: "生成场景图清单", placeholder: "粘贴阶段三输出的「分镜提示词包」，或直接点击上一阶段的“传入下一阶段”..." },
];

const WORKFLOW_TEMPLATES = [];

const mdCell = (value = "") => String(value || "")
  .replace(/\|/g, "\\|")
  .replace(/\r?\n/g, " ")
  .trim();

const getWorkflowTemplateDuration = (template = {}) => (
  (template.scenes || []).reduce((sum, scene) => sum + (Number(scene.duration) || 0), 0)
  || (template.tracks || []).reduce((sum, track) => sum + (Number(track.duration) || 0), 0)
  || template.duration
  || template.totalDuration
  || 0
);

const getWorkflowTemplateUnitCount = (template = {}) => (
  (template.scenes || []).length
  || (template.tracks || []).reduce((sum, track) => sum + (track.actions || []).length, 0)
  || 0
);

const buildWorkflowTemplateBoardRefs = (template = {}) => {
  if (template.workflowType === "dual_track_video_pipeline") {
    const assets = template.assets || {};
    return [
      `CharacterSheet：最终视频阶段使用 ${assets.characterSheet || "@image_file_1"} 作为角色主视觉来源。`,
      `Storyboard-1：Part-1 的黑白逃亡分镜，只作为 motion planning reference。`,
      `Storyboard-2：Part-2 的黑白花滑全案图，最终即梦阶段作为 ${assets.storyboard2 || "@image_file_2"} storyboard reference。`,
      `Environment：从 Part-1 抽帧后执行 remove all the people，得到 ${assets.environment || "@image_file_3"}，用于 Part-2 背景对齐。`,
      `Watermark：${assets.watermark || "@image_file_4"} 只作为最终冰面轨迹 Logo 形状参考，不提前显示。`
    ].join("\n");
  }

  return `${template.subject?.name || "角色A"}：黑白全案图阶段使用 ${template.subject?.assetId || "@图片1"} 或文字锁定保持体型/动作一致；最终即梦阶段用 @image_file_1 作为彩色角色主视觉来源。\n黑白全案图：最终即梦阶段作为 @image_file_2 storyboard reference。\n彩色环境图：最终即梦阶段用 @image_file_3，不在黑白全案图阶段混入彩色质感。\n品牌 Logo：仅在最终揭示镜头作为轨迹形状参考。`;
};

const buildDualTrackWorkflowTemplateOutputs = (template) => {
  const nodes = Array.isArray(template.nodes) ? template.nodes : [];
  const edges = Array.isArray(template.edges) ? template.edges : [];
  const tracks = Array.isArray(template.tracks) ? template.tracks : [];
  const assets = template.assets || {};
  const nodeRows = nodes.map(node => (
    `| ${node.nodeNum} | ${mdCell(node.key)} | ${mdCell(node.type)} | ${mdCell(node.model)} | ${mdCell(node.role)} |`
  )).join("\n");
  const edgeRows = edges.map(edge => (
    `| Edge #${edge.edgeNum} | ${mdCell(edge.source)} | ${mdCell(edge.target)} | ${mdCell(edge.meaning)} |`
  )).join("\n");
  const trackRows = tracks.map(track => (
    `| ${mdCell(track.title)} | ${track.duration}s | ${mdCell(track.storyboardNode)} | ${mdCell(track.videoNode)} | ${mdCell(track.actions?.[0] || "")} → ${mdCell(track.actions?.[track.actions.length - 1] || "")} |`
  )).join("\n");

  let sceneCounter = 1;
  const unitSections = tracks.map(track => {
    const refs = track.id === "part1_escape"
      ? "CharacterSheet；Storyboard-1"
      : "CharacterSheet；Storyboard-2；Environment；Watermark";
    const cameraHint = track.id === "part1_escape"
      ? "handheld thriller energy / long-lens surveillance / emergency motion"
      : "sports-performance camera / close-up, orbit, overhead, low angle, final top-down reveal";
    return (track.actions || []).map((action, index) => {
      const sceneId = `S${sceneCounter++}`;
      const duration = Number(track.durations?.[index] || (track.duration / Math.max(1, track.actions.length))).toFixed(1).replace(/\.0$/, "");
      const phase = index === 0 ? "起势" : index === track.actions.length - 1 ? "交接/揭示" : "推进";
      return `## | ${sceneId} | ${track.title}
**场景注意力调度**：本格服务 ${track.storyboardNode} 的 ${phase}，必须承接上一格动作，不允许动作重置。
**本场参考图**：${refs}

### 生成单元 ${sceneId}-U1 · ${action}
- 情绪功能：${track.id === "part1_escape" ? "从家庭松弛逐步进入危险感和逃生本能" : "奥运金牌级花滑动作持续升级，冰面轨迹逐步接近最终 Logo 揭示"}
- 成片时长：${duration}秒
- 生成时长：${duration}秒
- 视频提交时长：${duration}秒
- 提交策略：独立关键节拍；黑白 storyboard 阶段只锁动作和镜头，不生成最终彩色质感
- 使用参考图：${refs}
- 分镜执行字段：
  - 镜头类型/运镜：${cameraHint}
  - 注意力调度：从主体动势到环境反应，再落到下一格的运动出口。
  - 主动作与表演层：${action}
  - 灯光/氛围：${track.id === "part1_escape" ? "寒冷冰湖、远山、低冬日光、冷雾和紧张空旷感" : "极简北极冰湖、反光冰面、雪粒、冷雾、远山和柔和极光"}
  - 衔接状态：保持角色位置、朝向、速度、视线和环境空间连续，下一格从当前运动出口接起。
- 完整提示词：
${track.videoPrompt}
- 给下一个生成单元的接口：动作方向、场景地理和镜头节奏必须连续。`;
    }).join("\n\n");
  }).join("\n\n");

  const storyboardPrompts = tracks.map(track => `## ${track.storyboardNode} · ${track.title} 黑白全案图 Prompt
\`\`\`text
${track.storyboardPrompt}
\`\`\``).join("\n\n");
  const videoPrompts = tracks.map(track => `## 最终视频提示词 · ${track.videoNode}
\`\`\`text
${track.videoPrompt}
\`\`\``).join("\n\n");

  return {
    script: `# ${template.title} · 阶段一制片剧本

视频风格:
双轨道 3D 动画广告 / 电影 previs：Part-1 悬疑逃亡，Part-2 花滑 Logo 演绎
画面比例:
${template.aspectRatio || "16:9"}

剧本摘要
主角
CharacterSheet 锁定的北极熊
故事类型
悬疑逃亡 + 运动广告 + Logo Reveal
故事梗概
前 15 秒，一家人在偏远雪地冰湖玩耍，被远处北极熊窥视后仓皇逃离。通过 Extract Frame 抽取 Part-1 结尾冰湖画面，并用 Environment 节点擦除人物和车辆，得到空间完全一致的纯净冰湖。后 15 秒，同一只北极熊在同一冰湖空间中完成奥运级花样滑冰，滑行刻痕最终形成品牌 Logo。
故事背景
开放北极荒原、反光冰面、远山、冷雾、雪粒与极光。Part-1 和 Part-2 不是两个随意生成的场景，而是通过环境桥接共享同一空间。
故事设定
CharacterSheet 是唯一角色主锚点；Storyboard-1/2 是黑白 motion planning reference；Environment 是由 Part-1 抽帧擦除得到的背景锚点；Watermark 只作为 Part-2 最终 Logo 轨迹参考。
一句话故事
一家人逃离冰湖后，空出的同一片冰面成为北极熊完成花滑 Logo 演绎的舞台。
（主题命题：同一空间换一种命运，仅供制作团队参考，不出现在成片）

## 双轨道剧情表
| 轨道 | 时长 | Storyboard | Video | 叙事推进 |
|---|---:|---|---|---|
${trackRows}`,
    visual: `# ${template.title} · 阶段二固定要素库包

## 一、视觉意图总览
- 工作流定位：${template.boardPurpose}
- 角色一致性：${assets.characterSheet || "CharacterSheet"} 是后续 Storyboard-1、Part-1、Storyboard-2、Part-2 的主视觉来源。
- 环境一致性：Part-1 → Extract Frame → Environment(remove all the people) → Part-2，保证两段视频的冰湖空间无缝对齐。
- Logo 一致性：${assets.watermark || "Watermark"} 只进入 Storyboard-2 和 Part-2，不在 Part-2 最终揭示前暴露 Logo。
- 风格策略：黑白 storyboard 只控制动作、镜头、节奏和构图；彩色角色/环境/Logo 留到最终视频节点。

## 二、13 节点资产/工具表
| Node | 名称 | 类型 | 模型 | 业务作用 |
|---:|---|---|---|---|
${nodeRows}

## 三、14 条连线关系
| 连线 | Source | Target | 功能 |
|---|---|---|---|
${edgeRows}

## 四、关键资产映射
| 资产 | 用途 |
|---|---|
| Polar Bear | ${assets.polarBear || "Midjourney 北极熊原型"} |
| CharacterSheet | ${assets.characterSheet || "角色主视觉来源"} |
| Storyboard-1 | ${assets.storyboard1 || "Part-1 黑白分镜参考"} |
| Storyboard-2 | ${assets.storyboard2 || "Part-2 黑白分镜参考"} |
| Environment | ${assets.environment || "Part-2 环境参考"} |
| Watermark | ${assets.watermark || "最终 Logo 轨迹参考"} |

## 五、CharacterSheet 原始 Prompt
\`\`\`text
${template.characterSheetPrompt || ""}
\`\`\`

${storyboardPrompts}`,
    shot: `# ${template.title} · 阶段三节点式视频执行包

## 总体导演策略
- 总时长：${template.totalDuration || 30}s，由两个 15s 视频节点组成。
- Part-1：CharacterSheet + Storyboard-1 → 15s suspense survival video。
- 环境桥接：Part-1 → Extract Frame → Environment，修图指令为 \`${template.bridge?.inpaintPrompt || "remove all the people."}\`。
- Part-2：CharacterSheet + Storyboard-2 + Environment + Watermark → 15s figure skating Logo reveal。
- Combined Video：Part-1 + Part-2 → 30s previs。
- Upscaled：Topaz 4X + 60fps。
- 黑白全案图定位：storyboard reference，不是最终彩色视频；最终视频必须去除分镜边框、手写注释、箭头、标签和草图线。

## 逐节点执行顺序
1. Node 5 Polar Bear → Node 1 CharacterSheet。
2. Node 1 → Node 2 Storyboard-1；Node 1 + Node 2 → Node 3 Part-1。
3. Node 3 → Node 8 Extract Frame → Node 9 Environment，执行：${template.bridge?.inpaintPrompt || "remove all the people."}
4. Node 1 + Node 6 → Node 4 Storyboard-2。
5. Node 1 + Node 4 + Node 9 + Node 6 → Node 7 Part-2。
6. Node 10 拼接，Node 11 超分。

${unitSections}

${videoPrompts}`,
    image: `# ${template.title} · 阶段四黑白全案图 / 环境桥接资产清单

## 一、执行策略
- 不先生成彩色关键帧。先生成 Storyboard-1 和 Storyboard-2 两张黑白全案分镜图，统一动作、镜头、情绪和揭示结构。
- CharacterSheet 是彩色/造型主视觉来源，但 storyboard 本体保持黑白 pencil previs。
- Environment 不是重新脑补的冰湖，而是从 Part-1 抽帧后擦除人物/车辆得到的同空间空场景。
- Part-2 最终视频输入顺序：CharacterSheet + Storyboard-2 + Environment + Watermark。

## 二、黑白全案图生成清单
| 编号 | 节点 | 类型 | Prompt |
|---|---|---|---|
| @Storyboard1 | Storyboard-1 | 9 格黑白悬疑逃亡分镜 | 见阶段二 Storyboard-1 Prompt |
| @Storyboard2 | Storyboard-2 | 12 格黑白花滑 Logo 分镜 | 见阶段二 Storyboard-2 Prompt |

## 三、环境桥接资产
- Extract Frame：${template.bridge?.extractFrame || ""}
- Environment Inpaint Prompt：\`${template.bridge?.inpaintPrompt || "remove all the people."}\`
- Environment 作用：${template.bridge?.role || ""}

## 四、最终视频资产组装
| 视频节点 | 输入资产 | 目标 |
|---|---|---|
| Part-1 | CharacterSheet + Storyboard-1 | 15s 悬疑逃亡视频 |
| Part-2 | CharacterSheet + Storyboard-2 + Environment + Watermark | 15s 花滑 Logo 演绎视频 |
| Combined Video | Part-1 + Part-2 | 30s previs |
| Upscaled | Combined Video | 4X / 60fps 高保真输出 |`,
  };
};

const buildWorkflowTemplateOutputs = (template) => {
  if (template?.workflowType === "dual_track_video_pipeline") {
    return buildDualTrackWorkflowTemplateOutputs(template);
  }

  const scenes = Array.isArray(template.scenes) ? template.scenes : [];
  const subject = template.subject || {};
  const mainScene = template.mainScene || {};
  const finalAsset = template.finalAsset || {};
  const finalVideoPrompt = (template.finalVideoPrompt || "").trim();
  const totalDuration = scenes.reduce((sum, scene) => sum + (Number(scene.duration) || 0), 0) || template.duration || 0;
  const sceneRows = scenes.map((scene, index) => (
    `| ${index + 1} | ${mdCell(scene.sceneNum)} | ${mdCell(scene.title)} | ${mdCell(scene.cameraMove)} | ${scene.duration || 6}s | ${mdCell(scene.imagePrompt)} |`
  )).join("\n");
  const scriptScenes = scenes.map((scene, index) => `第${index + 1}场

要素    说明
① 场号    | ${scene.sceneNum} | / ${index + 1}-1
② 时间    雪夜 / 灰白天光
③ 环境    冰湖、薄雪、深色冰面、白色刻痕
④ 地点    ${mainScene.name || "Snowy Frozen Lake"}
⑤ 出场人物    ${subject.name || "Gliding Bear"}

道具：透明 PNG 品牌 Logo（仅作为最终轨迹参考，不直接贴在前 11 个镜头中）

△ ${scene.title}：${scene.imagePrompt.replace(/^Scene\s+\d+\.\s*/i, "")}
△ 冰面刻痕从这一场继续累积，白色线条逐步从运动残留变成可识别的图形线索。

【定格卡点】：${scene.cameraMove} 下，${subject.name || "北极熊"}的动作姿态与冰面轨迹同时清楚可读。`).join("\n\n");

  const visualSceneCards = scenes.map((scene) => `### 场景卡 · | ${scene.sceneNum.replace(/^S/, "S")} | ${scene.title} / ${mainScene.name || "Snowy Frozen Lake"}
- 场景参考图：${mainScene.assetId || "@图片10"} ${mainScene.name || "Snowy Frozen Lake"}
- 场景任务：为 ${scene.title} 提供同一冰湖空间下的可读表演区域、冰面刻痕与雪雾层次。
- 构图锚点：${scene.cameraMove}；冰面白色轨迹必须和黑色湖面形成强对比。
- 场景生图提示词：
${template.globalStyle}
Empty snowy frozen lake environment plate for ${scene.title}, dark ice surface, white carved scratch trails, drifting snow, readable foreground/midground/background, no characters, no text, no watermark, 16:9.
- 连续性备注：此场与其他 11 场共享 ${mainScene.assetId || "@图片10"}，只允许冰面轨迹复杂度、雪雾密度和机位任务发生变化。`).join("\n\n");

  const shotSections = scenes.map((scene, index) => `## | ${scene.sceneNum} | ${scene.title}
**场景注意力调度**：观众视线从北极熊身体重心转移到冰面白色轨迹，再回到下一步动作的发力点。
**起始接口确认**：继承上一场冰面刻痕；${index === 0 ? "第一场直接从运动中切入，不做空镜铺垫。" : "上一场轨迹在本场继续延展。"}
**本场参考图**：角色图 ${subject.assetId || "@图片1"}；场景图 ${mainScene.assetId || "@图片10"}${scene.sceneNum === "S12" ? `；Logo 参考 ${finalAsset.assetId || "@Logo"}` : ""}

### 生成单元 ${scene.sceneNum}-U1 · ${scene.title}
- 注意力调度：主体动作与冰面刻线同时可读，视觉中心从爪部/身体重心移动到轨迹方向。
- 动作有效时长：${scene.duration || 6}秒
- 成片时长：${scene.duration || 6}秒
- 视频提交时长：${scene.duration || 6}秒
- 生成时长：${scene.duration || 6}秒
- 动作时间轴（核心动作 beat）：
  - 0.0-${Math.max(1.2, Math.round((scene.duration || 6) * 0.35 * 10) / 10)}s：${scene.title} 的发力动作建立，冰面出现新的白色刻痕。
  - ${Math.max(1.2, Math.round((scene.duration || 6) * 0.35 * 10) / 10)}-${Math.max(2.4, Math.round((scene.duration || 6) * 0.75 * 10) / 10)}s：动作进入主段，雪粉、冰屑或线稿运动增强。
  - ${Math.max(2.4, Math.round((scene.duration || 6) * 0.75 * 10) / 10)}-${scene.duration || 6}s：镜头保留下一场可衔接的身体朝向和轨迹出口。
- 提交策略：独立提交
- 使用参考图：角色图 ${subject.assetId || "@图片1"}；场景图 ${mainScene.assetId || "@图片10"}${scene.sceneNum === "S12" ? `；品牌 Logo 透明 PNG ${finalAsset.assetId || "@Logo"}` : ""}
- 分镜执行字段：
  - 镜头类型/运镜：${scene.cameraMove}
  - 注意力调度：从主体轮廓到爪部刻冰，再到冰面轨迹方向。
  - 主动作与表演层：${subject.name || "Gliding Bear"} 保持大型运动员体态，动作优雅但带重量。
  - 灯光/氛围：黑白铅笔线稿，高对比雪夜冰湖，白色刻痕清晰。
  - 衔接状态：保留可延续的滑行方向、身体朝向和冰面轨迹出口。
- 完整提示词：
${scene.videoPrompt}
- 给下一个生成单元的接口：冰面刻痕、身体朝向和运动速度连续，不让角色外形漂移。`).join("\n\n");

  const imageFrameSections = scenes.map((scene) => `### KF-${scene.sceneNum} · ${scene.title}
- 来源生成单元：${scene.sceneNum}-U1
- 帧类型：Storyboard Shot Card
- 用途：I2V input image / ${scene.cameraMove}
- 建议上传参考图：${subject.assetId || "@图片1"} ${subject.name || "Gliding Bear"}；${mainScene.assetId || "@图片10"} ${mainScene.name || "Snowy Frozen Lake"}${scene.sceneNum === "S12" ? `；${finalAsset.assetId || "@Logo"} transparent logo PNG` : ""}
- 静态画面描述：${scene.imagePrompt}
- 中文生图 Prompt：
${scene.imagePrompt} Global style: ${template.globalStyle} Use ${subject.assetId || "@图片1"} as the character reference and ${mainScene.assetId || "@图片10"} as the frozen lake environment reference. Keep black and white pencil storyboard art only, no color, 16:9.
- Negative Prompt：
${template.negativePrompt || "color, realistic photo, 3d render, text, watermark"}`).join("\n\n");

  return {
    script: `# ${template.title} · 阶段一剧本

视频风格:
黑白铅笔线稿预演分镜，花样滑冰运动短片，Logo 演绎广告片
画面比例:
${template.aspectRatio || "16:9"}

剧本摘要
主角
${subject.name || "Gliding Bear"}，一只大型运动员体态的手绘北极熊
故事类型
品牌 Logo 演绎 / 运动表演 / 冰面轨迹奇观
故事梗概
北极熊在雪夜冰湖上完成一套连续花样滑冰动作。每一次切刃、旋转、腾空和落地都在冰面留下白色刻痕；观众起初只看到运动的力量，直到最终俯视拉远，才发现所有轨迹共同雕刻成品牌 Logo。
故事背景
深色冰湖、飘雪天空、黑白铅笔线稿世界。冰面像一张巨大的草图纸，角色的滑行动作就是画笔。
故事设定
冰面轨迹不是后期贴图，而是角色动作的结果。Logo 只在最后作为透明 PNG 品牌参考参与构图。
一句话故事
一只北极熊用一整套花样滑冰，把品牌 Logo 刻进雪夜冰湖。
（主题命题：动作让标志被看见，仅供制作团队参考，不出现在成片）

剧本内容:
第1集：冰面上的签名

${scriptScenes}`,
    visual: `# ${template.title} · 阶段二固定要素库包

## 视觉意图总览
- 视觉命题：冰面是画布，滑行动作是铅笔。
- 画幅：${template.aspectRatio || "16:9"}
- 全局风格：${template.globalStyle}
- 负面约束：${template.negativePrompt}
- 四层控制模型：Global Style 锁风格；Subject Reference 锁北极熊；Shot Prompt 锁静态构图；Video Prompt 锁运动和物理。

## 角色卡 · ${subject.name || "Gliding Bear"}（${subject.assetId || "@图片1"}）
- 角色原图引用：${subject.assetId || "@图片1"}
- 短识别锚底：${subject.description || "A large, athletic polar bear, rough pencil sketch anatomy."}
- 一致性规则：${subject.consistencyRule || "所有镜头保持同一体型、头部比例、爪部尺度和粗糙铅笔线稿质感。"}
- 禁止跑偏：不要变成写实照片、彩色 3D、卡通玩具、不同熊种、不同体型或服装化角色。
- 阶段三使用方式：只写“${subject.name || "Gliding Bear"}（${subject.assetId || "@图片1"}）+ 当前动作”，不要重复长篇外形描述。

## 场景世界观基线
- 主场景参考图：${mainScene.assetId || "@图片10"} ${mainScene.name || "Snowy Frozen Lake"}
- 场景锁定：${mainScene.description || "A wide dark frozen lake under a gray snowy sky."}
- 材质语言：深色冰面、白色刻痕、雪粉、粗糙铅笔阴影、未完成的预演线条。
- 光线逻辑：灰白雪天，高对比，冰面轨迹是最亮的视觉信息。
- 空间策略：湖面必须保留足够大面积，方便轨迹在 S12 俯视拉远时形成 Logo。

## @图片编号总对应表
| @编号 | 类型 | 名称 | 归属 | 用途 |
|---|---|---|---|---|
| ${subject.assetId || "@图片1"} | 角色图 | ${subject.name || "Gliding Bear"} | 全片 | 北极熊主体一致性 |
| ${mainScene.assetId || "@图片10"} | 场景图 | ${mainScene.name || "Snowy Frozen Lake"} | S1-S12 | 冰湖环境与轨迹材质 |
| ${finalAsset.assetId || "@Logo"} | 品牌参考 | transparent logo PNG | S12 | 最终轨迹合成参考 |

${visualSceneCards}`,
    shot: `# ${template.title} · 阶段三即梦/I2V 分镜提示词包

## 总体导演策略
- 总成片时长：约 ${totalDuration}s
- 生成单元数量：${scenes.length}
- 主要运镜策略：由近到远、由动作细节到轨迹图形，最终以俯视拉远完成 Logo 揭示。
- 参考图使用策略：角色图 ${subject.assetId || "@图片1"} + 场景图 ${mainScene.assetId || "@图片10"}；S12 额外接入 ${finalAsset.assetId || "@Logo"}。
- 风格硬约束：${template.globalStyle}
- 运动强度建议：4-5/10，优先保持铅笔线条稳定，不让角色和轨迹溶解。
- 黑白全案图定位：${template.boardPurpose || "先生成黑白全案分镜图作为 storyboard reference；后续即梦视频阶段再使用彩色角色图和环境图。"}

## 导演剪辑总表
| 顺序 | 生成单元 | 标题 | 运镜 | 时长 | 静态画面核心 |
|---|---|---|---|---:|---|
${sceneRows}

${shotSections}

## 全片连续性检查
| 检查项 | 结果 |
|---|---|
| 角色参考图稳定 | ${subject.assetId || "@图片1"} 贯穿所有镜头 |
| 场景参考图稳定 | ${mainScene.assetId || "@图片10"} 贯穿所有镜头 |
| Logo 只在最终揭示使用 | S12 接入 ${finalAsset.assetId || "@Logo"} |
| 黑白铅笔风格 | 全片禁止彩色、照片写实和 3D 渲染 |${finalVideoPrompt ? `

## 最终即梦视频提示词
\`\`\`text
${finalVideoPrompt}
\`\`\`` : ""}`,
    image: `# ${template.title} · 阶段四分镜静帧与场景图生图清单

## 一、执行策略
- 目标：先生成 ${mainScene.assetId || "@图片10"} 冰湖空场景图，再生成 12 张 Shot Card 静帧作为 I2V 输入。
- 黑白全案图用途：本阶段的 Shot Card / 全案图只服务动作、镜头、节奏和风格统一，不是最终彩色视频；最终即梦阶段使用 @image_file_2 作为 storyboard reference，并叠加 @image_file_1 彩色角色图与 @image_file_3 彩色环境图。
- 图片编号范围：角色 ${subject.assetId || "@图片1"}，场景 ${mainScene.assetId || "@图片10"}，Shot Card 使用 KF-S1 到 KF-S12。
- 不生成内容：彩色照片、写实 3D、文字、水印、额外动物、额外角色。
- 默认尺寸建议：横版 ${template.aspectRatio || "16:9"}。

## 二、场景图资产

### ${mainScene.assetId || "@图片10"} · | S1 | ${mainScene.name || "Snowy Frozen Lake"}
- 类型：空场景图
- 归属场景：| S1-S12 |
- 用途：作为全部滑冰镜头的冰湖环境参考图
- 空间任务：为最终 Logo 轨迹留出大面积可读冰面。
- 构图策略：深色冰面占主要画幅，远处灰白雪空，少量飘雪，冰面可出现浅淡旧划痕但不能提前形成 Logo。
- 场景描述：${mainScene.description || ""}
- 中文生图 Prompt：
${template.globalStyle} Empty snowy frozen lake environment plate, dark ice surface, large readable open performance space, subtle old scratch lines but no completed logo, gray snowy sky, high contrast black and white pencil storyboard art, no characters, no animals, no text, no watermark, 16:9.
- Negative Prompt：
${template.negativePrompt || "color, realistic photo, 3d render, text, watermark"}
- 即梦使用备注：所有 I2V 单元搭配 ${subject.assetId || "@图片1"} 和 ${mainScene.assetId || "@图片10"}；S12 额外接入 ${finalAsset.assetId || "@Logo"}。

## 三、Shot Card 静帧清单

${imageFrameSections}`,
  };
};

const REVIEW_ROUTES = [
  { id: "audience", label: "观众留存评审", hint: "推荐：doubao-seed-2-0-pro-260215" },
  { id: "visual", label: "视觉奇观评审", hint: "推荐：gemini-3.1-pro-preview" },
  { id: "story", label: "导演编剧评审", hint: "推荐：claude-opus-4-7-thinking" },
  { id: "execution", label: "执行制片评审", hint: "推荐：DeepSeek V4 Pro" },
  { id: "summary", label: "仲裁总结模型", hint: "推荐：Qwen3.6-Max-Preview" },
];

const EMPTY_ROUTE_CONFIG = {
  name: "",
  url: "",
  key: "",
  model: "",
  is_thinking: false,
  use_proxy: false,
  proxy_url: "",
};

const IMAGE_MASTER_ROUTE_ID = "image_master";
const IMAGE_REPAINT_ROUTE_ID = "image_repaint";

const createDefaultRoutes = () => ({
  script: { ...EMPTY_ROUTE_CONFIG, name: "1. 剧本生成" },
  visual: { ...EMPTY_ROUTE_CONFIG, name: "2. 视觉开发" },
  shot: { ...EMPTY_ROUTE_CONFIG, name: "3. 分镜提示词 (兼数据提炼)" },
  image: { ...EMPTY_ROUTE_CONFIG, name: "4. 场景图清单文本" },
  [IMAGE_MASTER_ROUTE_ID]: { ...EMPTY_ROUTE_CONFIG, name: "4A. 母版生图 API" },
  [IMAGE_REPAINT_ROUTE_ID]: {
    ...EMPTY_ROUTE_CONFIG,
    name: "4B. ComfyUI垫图重绘 API",
    url: DEFAULT_COMFYUI_URL,
    model: "comfyui:protovisionXLHighFidelity3D_releaseV660Bakedvae.safetensors|workflow=repaint_sdxl_img2img|steps=32|cfg=6.5|sampler=dpmpp_2m_sde|scheduler=karras|denoise=0.35|timeout=600"
  },
});

const DEFAULT_ROUTE_SOURCES = Object.fromEntries(Object.keys(createDefaultRoutes()).map(routeId => [routeId, "self"]));
const DEFAULT_REVIEW_ROUTE_SOURCES = Object.fromEntries(REVIEW_ROUTES.map(route => [route.id, "self"]));

const normalizeRouteConfig = (route = {}, fallback = {}) => ({
  ...EMPTY_ROUTE_CONFIG,
  ...fallback,
  ...(route || {}),
  is_thinking: Boolean(route?.is_thinking),
  use_proxy: Boolean(route?.use_proxy),
  proxy_url: route?.proxy_url || "",
});

const isComfyuiImageRoute = (route = {}) => (
  (route?.model || "").trim().toLowerCase().startsWith("comfyui")
  || (route?.url || "").trim().toLowerCase().includes("onethingrobot.com")
  || /\/(prompt|system_stats|object_info)\s*$/i.test((route?.url || "").trim())
);

const mergeSourceDefaults = (defaults, stored = {}) => (
  Object.fromEntries(Object.keys(defaults).map(key => [key, stored?.[key] || defaults[key]]))
);

export default function App() {
  const [stage, setStage] = useState(0);
  const [inputs, setInputs] = useState(["", "", "", ""]);
  const [outputs, setOutputs] = useState(["", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  
  const [showSettings, setShowSettings] = useState(false);
  const [showRadar, setShowRadar] = useState(false);
  const [radarMode, setRadarMode] = useState("core");
  const [styleMode, setStyleMode] = useState(() => localStorage.getItem(STYLE_MODE_KEY) || 'cute_3d'); // 默认为3D半写实梦幻动物动画
  const [directorProfile, setDirectorProfile] = useState(() => localStorage.getItem(DIRECTOR_PROFILE_KEY) || "default");
  const [artProfile, setArtProfile] = useState(() => localStorage.getItem(ART_PROFILE_KEY) || "default");
  const [cineProfile, setCineProfile] = useState(() => localStorage.getItem(CINE_PROFILE_KEY) || "default");
  const [packDeliveryMode, setPackDeliveryMode] = useState(() => localStorage.getItem(PACK_DELIVERY_MODE_KEY) || "file");

  const [config, setConfig] = useState({
    prompts: { ...DEFAULT_PROMPTS },
    routes: createDefaultRoutes(),
    route_sources: { ...DEFAULT_ROUTE_SOURCES },
    review_routes: {
      audience: { ...EMPTY_ROUTE_CONFIG, name: "观众留存评审" },
      visual: { ...EMPTY_ROUTE_CONFIG, name: "视觉奇观评审" },
      story: { ...EMPTY_ROUTE_CONFIG, name: "导演编剧评审" },
      execution: { ...EMPTY_ROUTE_CONFIG, name: "执行制片评审" },
      summary: { ...EMPTY_ROUTE_CONFIG, name: "仲裁总结模型" }
    },
    review_route_sources: { ...DEFAULT_REVIEW_ROUTE_SOURCES }
  });

  const [availableIPs, setAvailableIPs] = useState([]);
  const [selectedIPs, setSelectedIPs] = useState([]);
  const [isFetchingIPs, setIsFetchingIPs] = useState(false); 
  const [rawAnalysisText, setRawAnalysisText] = useState("");
  const [newIpName, setNewIpName] = useState("香蕉猫宇宙"); 
  const [washing, setWashing] = useState(false);
  const [washResult, setWashResult] = useState("");
  const [washJson, setWashJson] = useState("");
  const [runId, setRunId] = useState(() => localStorage.getItem(PIPELINE_RUN_ID_KEY) || "");
  const [activeRouteTab, setActiveRouteTab] = useState("script");
  const [activeReviewRouteTab, setActiveReviewRouteTab] = useState("audience");
  const [executionMode, setExecutionMode] = useState('sequential');  // 'sequential' = 逐段推演 / 'batch' = 全量出片
  const [sceneImagePromptMode, setSceneImagePromptMode] = useState(
    () => localStorage.getItem(SCENE_IMAGE_PROMPT_MODE_KEY) || 'jimeng'
  ); // 'jimeng' = 中文即梦 / 'mj' = 英文 Midjourney
  const [directorIntent, setDirectorIntent] = useState("");
  const [showDirectorIntent, setShowDirectorIntent] = useState(false);
  const [inspirationLoading, setInspirationLoading] = useState(false);
  const [inspirationIdeas, setInspirationIdeas] = useState([]);
  const [inspirationError, setInspirationError] = useState("");
  const [scriptAppealLoading, setScriptAppealLoading] = useState(false);
  const [scriptAppealReview, setScriptAppealReview] = useState("");
  const [scriptAppealError, setScriptAppealError] = useState("");
  const [scriptRewriteLoading, setScriptRewriteLoading] = useState(false);
  const [outputCollapsed, setOutputCollapsed] = useState(false);
  const [reviewCollapsed, setReviewCollapsed] = useState(true);
  const [imageSize, setImageSize] = useState("1536x1024");
  const [imageGeneratingId, setImageGeneratingId] = useState("");
  const [, setGeneratedImages] = useState({});
  const [imageGenError, setImageGenError] = useState("");
  const [showAssetLibrary, setShowAssetLibrary] = useState(false);
  const [imageAssets, setImageAssets] = useState({});
  const [sceneStyleReferenceIds, setSceneStyleReferenceIds] = useState({});
  const [sceneRepaintEmphasisModes, setSceneRepaintEmphasisModes] = useState({});
  const [assetError, setAssetError] = useState("");
  const [assetUploadingId, setAssetUploadingId] = useState("");
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectLoadError, setProjectLoadError] = useState("");
  const [projectRuns, setProjectRuns] = useState([]);
  const [projectRunsLoading, setProjectRunsLoading] = useState(false);
  const [selectedProjectRunId, setSelectedProjectRunId] = useState(() => localStorage.getItem(PIPELINE_RUN_ID_KEY) || "");
  const [assetAutoGenerating, setAssetAutoGenerating] = useState(false);
  const [assetAutoProgress, setAssetAutoProgress] = useState("");
  const [boardCharacterRefs, setBoardCharacterRefs] = useState("角色A：使用我上传的第一张角色参考图。\n角色B：使用我上传的第二张角色参考图。");
  const [boardStyle, setBoardStyle] = useState("");
  const [boardPrompts, setBoardPrompts] = useState({ segments: [] });
  const [boardCopied, setBoardCopied] = useState("");
  const [expandedBoardPrompt, setExpandedBoardPrompt] = useState(0);
  const [boardPromptError, setBoardPromptError] = useState("");
  const [boardImageResults, setBoardImageResults] = useState({});
  const [boardImageGenerating, setBoardImageGenerating] = useState("");
  const [codexJobCreating, setCodexJobCreating] = useState("");
  const [codexJobResults, setCodexJobResults] = useState({});
  const [boardOptimizeCreating, setBoardOptimizeCreating] = useState("");
  const [boardOptimizeSyncing, setBoardOptimizeSyncing] = useState("");

  // 🌟 自动化切片推演的状态管理
  const [chunkQueue, setChunkQueue] = useState([]);
  const [, setChunkIndex] = useState(0);
  const [completedChunkIndex, setCompletedChunkIndex] = useState(-1);
  const [showChunkModal, setShowChunkModal] = useState(false);
  const [chunkSceneCards, setChunkSceneCards] = useState([]);

  const abortControllerRef = useRef(null);
  const timeoutRef = useRef(null);
  const timeoutTriggeredRef = useRef(false);
  const outputRef = useRef(null);
  const outputBoxRef = useRef(null);
  const reviewBoxRef = useRef(null);

  const fetchIPs = async () => {
    setIsFetchingIPs(true);
    try {
      const res = await fetch(`${API_BASE}/get_available_ips`);
      const textData = await res.text();
      const data = JSON.parse(textData);
      if (data.status === "success" && data.ips) {
        setAvailableIPs(data.ips);
      }
    } catch (e) {
      console.error("获取IP列表失败", e);
    } finally {
      setIsFetchingIPs(false);
    }
  };

  const fetchImageAssets = async (targetRunId = "") => {
    try {
      const activeRunId = targetRunId || runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "";
      const query = activeRunId ? `?run_id=${encodeURIComponent(activeRunId)}` : "";
      const res = await fetch(`${API_BASE}/image_library${query}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "读取参考图资产失败");
      setImageAssets(data.images || {});
    } catch (e) {
      setAssetError(e.message || "读取参考图资产失败");
    }
  };

  const fetchProjectRuns = async (preferredRunId = "") => {
    setProjectRunsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/run_folders`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "读取项目列表失败");
      const runs = data.runs || [];
      setProjectRuns(runs);
      const activeRunId = preferredRunId || selectedProjectRunId || runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "";
      if (activeRunId && runs.some(item => item.run_id === activeRunId)) {
        setSelectedProjectRunId(activeRunId);
      } else if (runs[0]?.run_id) {
        setSelectedProjectRunId(runs[0].run_id);
      }
    } catch (e) {
      setProjectLoadError(e.message || "读取项目列表失败");
    } finally {
      setProjectRunsLoading(false);
    }
  };

  const loadPipelineRun = async (targetRunId = "") => {
    const selectedRunId = targetRunId || selectedProjectRunId || runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "";
    setProjectLoading(true);
    setProjectLoadError("");
    try {
      const query = selectedRunId ? `?run_id=${encodeURIComponent(selectedRunId)}` : "";
      const res = await fetch(`${API_BASE}/run_outputs${query}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "载入项目失败");
      const loadedOutputs = STAGES.map(s => data.outputs?.[s.id] || "");
      setOutputs(loadedOutputs);
      setRunId(data.run_id || selectedRunId);
      if (data.run_id) {
        localStorage.setItem(PIPELINE_RUN_ID_KEY, data.run_id);
        setSelectedProjectRunId(data.run_id);
      }
      setGeneratedImages(data.generated_images || {});
      await fetchImageAssets(data.run_id || selectedRunId);
      fetchProjectRuns(data.run_id || selectedRunId);
      return loadedOutputs;
    } catch (e) {
      setProjectLoadError(e.message || "载入项目失败");
      return null;
    } finally {
      setProjectLoading(false);
    }
  };

  useEffect(() => {
    fetchIPs();
    fetchProjectRuns(localStorage.getItem(PIPELINE_RUN_ID_KEY) || "");
    fetchImageAssets();
    const savedRunId = localStorage.getItem(PIPELINE_RUN_ID_KEY);
    if (savedRunId) {
      loadPipelineRun(savedRunId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 🌟 从后端拉取提示词（前后端解耦）：后端 prompts.json 为单一事实来源
  useEffect(() => {
    const loadRemotePrompts = async () => {
      try {
        const res = await fetch(`${API_BASE}/get_prompts`);
        const remote = await res.json();
        if (remote && Object.keys(remote).length > 0) {
          setConfig(prev => ({
            ...prev,
            prompts: {
              ...prev.prompts,
              ...remote,
              visual: DEFAULT_PROMPTS.visual,
              shot: DEFAULT_PROMPTS.shot,
              image: DEFAULT_PROMPTS.image,
            },
          }));
        }
      } catch (e) {
        console.warn("未能加载远程提示词，使用本地默认值", e);
      }
    };
    loadRemotePrompts();
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("micro_epic_config_v30");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setConfig(prev => ({
          ...prev,
          prompts: {
            ...prev.prompts,              // 保留远程/default 提示词
            ...(parsed.prompts || {}),    // 用户本地编辑覆盖（如有）
            script: prev.prompts.script,  // 🔒 强制锁死剧本、视觉、分镜提示词
            visual: prev.prompts.visual,
            shot: prev.prompts.shot,
            image: prev.prompts.image,
          },
          routes: Object.fromEntries(Object.keys(prev.routes).map(key => [
            key,
            normalizeRouteConfig(parsed.routes?.[key], prev.routes[key])
          ])),
          route_sources: mergeSourceDefaults(DEFAULT_ROUTE_SOURCES, parsed.route_sources),
          review_routes: Object.fromEntries(Object.keys(prev.review_routes).map(key => [
            key,
            normalizeRouteConfig(parsed.review_routes?.[key], prev.review_routes[key])
          ])),
          review_route_sources: mergeSourceDefaults(DEFAULT_REVIEW_ROUTE_SOURCES, parsed.review_route_sources)
        }));
      } catch {
        console.warn("本地配置解析失败，已使用默认配置");
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STYLE_MODE_KEY, styleMode);
  }, [styleMode]);

  useEffect(() => {
    localStorage.setItem(DIRECTOR_PROFILE_KEY, directorProfile);
  }, [directorProfile]);

  useEffect(() => {
    localStorage.setItem(ART_PROFILE_KEY, artProfile);
  }, [artProfile]);

  useEffect(() => {
    localStorage.setItem(CINE_PROFILE_KEY, cineProfile);
  }, [cineProfile]);

  useEffect(() => {
    localStorage.setItem(SCENE_IMAGE_PROMPT_MODE_KEY, sceneImagePromptMode);
  }, [sceneImagePromptMode]);

  useEffect(() => {
    localStorage.setItem(PACK_DELIVERY_MODE_KEY, packDeliveryMode);
  }, [packDeliveryMode]);

  useEffect(() => {
    if (outputs[stage] && outputRef.current) {
      outputRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [outputs, stage]);

  useEffect(() => {
    if (!outputCollapsed && outputBoxRef.current && outputs[stage]) {
      requestAnimationFrame(() => {
        outputBoxRef.current.scrollTop = outputBoxRef.current.scrollHeight;
      });
    }
  }, [outputs, stage, outputCollapsed]);

  useEffect(() => {
    if (!reviewCollapsed && reviewBoxRef.current && scriptAppealReview) {
      requestAnimationFrame(() => {
        reviewBoxRef.current.scrollTop = reviewBoxRef.current.scrollHeight;
      });
    }
  }, [scriptAppealReview, reviewCollapsed]);

  useEffect(() => {
    setScriptAppealReview("");
    setScriptAppealError("");
    setOutputCollapsed(false);
    setReviewCollapsed(true);
    setImageGenError("");
  }, [stage]);

  const buildPersistableConfig = (sourceConfig = config) => {
    const { prompts: _prompts, ...rest } = sourceConfig || {};
    return rest;
  };

  const handleSaveConfig = () => {
    localStorage.setItem("micro_epic_config_v30", JSON.stringify(buildPersistableConfig(config)));
    setShowSettings(false);
  };

  const getMainRouteFallback = (routeId) => config.routes?.[routeId] || { name: routeId };

  const resolveMainRoute = (routeId, stack = []) => {
    const ownRoute = normalizeRouteConfig(config.routes?.[routeId], getMainRouteFallback(routeId));
    const source = config.route_sources?.[routeId] || "self";
    if (!source || source === "self") return ownRoute;

    const refId = String(source).replace(/^route:/, "");
    if (!config.routes?.[refId] || refId === routeId || stack.includes(refId)) {
      return ownRoute;
    }

    const resolved = resolveMainRoute(refId, [...stack, routeId]);
    return { ...resolved, name: ownRoute.name || resolved.name };
  };

  const getEffectiveRoutes = () => {
    const resolved = Object.fromEntries(
      Object.keys(config.routes || {}).map(routeId => [routeId, resolveMainRoute(routeId)])
    );
    if (resolved.image && !resolved.image.key && resolved.shot?.key) {
      resolved.image = {
        ...resolved.shot,
        name: "4. 场景图生图清单（文本组装用第3阶段模型）"
      };
    }
    return resolved;
  };

  const routeHasImageConfig = (route = {}) => Boolean(
    (route.url || "").trim() ||
    (route.key || "").trim() ||
    (route.model || "").trim()
  );

  const getImageGenerationRoute = (purpose = "master") => {
    const routeId = purpose === "repaint" ? IMAGE_REPAINT_ROUTE_ID : IMAGE_MASTER_ROUTE_ID;
    const defaults = createDefaultRoutes();
    const route = normalizeRouteConfig(resolveMainRoute(routeId), defaults[routeId] || { name: routeId });
    if (purpose !== "repaint" && !routeHasImageConfig(route) && routeHasImageConfig(config.routes?.image)) {
      return normalizeRouteConfig(config.routes?.image, { name: "4A. 母版生图 API（沿用旧配置）" });
    }
    return route;
  };

  const hasImageGenerationRouteKey = (purpose = "master") => {
    const route = getImageGenerationRoute(purpose);
    if (isComfyuiImageRoute(route)) {
      return Boolean((route.url || "").trim());
    }
    return Boolean(route.key);
  };

  const resolveReviewRoute = (slot, resolvedRoutes = getEffectiveRoutes(), stack = []) => {
    const reviewFallback = config.review_routes?.[slot] || { name: slot };
    const ownRoute = normalizeRouteConfig(config.review_routes?.[slot], reviewFallback);
    const source = config.review_route_sources?.[slot] || "self";
    if (!source || source === "self") return ownRoute;

    if (String(source).startsWith("route:")) {
      const routeId = String(source).replace(/^route:/, "");
      const resolved = resolvedRoutes[routeId];
      return resolved ? { ...resolved, name: ownRoute.name || resolved.name } : ownRoute;
    }

    const refSlot = String(source).replace(/^review:/, "");
    if (!config.review_routes?.[refSlot] || refSlot === slot || stack.includes(refSlot)) {
      return ownRoute;
    }
    const resolved = resolveReviewRoute(refSlot, resolvedRoutes, [...stack, slot]);
    return { ...resolved, name: ownRoute.name || resolved.name };
  };

  const getEffectiveReviewRoutes = () => {
    const resolvedRoutes = getEffectiveRoutes();
    return Object.fromEntries(
      Object.keys(config.review_routes || {}).map(slot => [slot, resolveReviewRoute(slot, resolvedRoutes)])
    );
  };

  const hasEffectiveRouteKey = (stageId) => Boolean(getEffectiveRoutes()[stageId]?.key);

  const updateRouteField = (routeId, field, value) => {
    setConfig(prev => ({
      ...prev,
      routes: {
        ...prev.routes,
        [routeId]: {
          ...normalizeRouteConfig(prev.routes?.[routeId], { name: routeId }),
          [field]: value
        }
      }
    }));
  };

  const updateReviewRouteField = (slot, field, value) => {
    setConfig(prev => ({
      ...prev,
      review_routes: {
        ...prev.review_routes,
        [slot]: {
          ...normalizeRouteConfig(prev.review_routes?.[slot], { name: slot }),
          [field]: value
        }
      }
    }));
  };

  const updateRouteSource = (routeId, value) => {
    setConfig(prev => ({
      ...prev,
      route_sources: {
        ...mergeSourceDefaults(DEFAULT_ROUTE_SOURCES, prev.route_sources),
        [routeId]: value
      }
    }));
  };

  const updateReviewRouteSource = (slot, value) => {
    setConfig(prev => ({
      ...prev,
      review_route_sources: {
        ...mergeSourceDefaults(DEFAULT_REVIEW_ROUTE_SOURCES, prev.review_route_sources),
        [slot]: value
      }
    }));
  };

  const persistOutput = async (stageId, content, currentRunId) => {
    const clean = (content || "").replace(/\u200b/g, "").trim();
    if (!clean) return;
    try {
      await fetch(`${API_BASE}/save_output`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: stageId,
          content,
          run_id: currentRunId
        })
      });
    } catch (error) {
      console.warn("前端兜底保存失败", error);
    }
  };

  const ensureCurrentRunId = () => {
    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId();
    setRunId(currentRunId);
    setSelectedProjectRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);
    return currentRunId;
  };

  const handleCreateNewProject = () => {
    const hasProjectContent = inputs.some(value => value.trim())
      || outputs.some(value => value.trim())
      || Object.keys(imageAssets || {}).length > 0
      || inspirationIdeas.length > 0
      || scriptAppealReview.trim()
      || (boardPrompts?.segments || []).length > 0;
    if (hasProjectContent && !window.confirm("创建新项目会清空当前工作台内容，但不会删除已保存的旧项目文件。继续吗？")) {
      return;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const nextRunId = createPipelineRunId();
    localStorage.setItem(PIPELINE_RUN_ID_KEY, nextRunId);
    setRunId(nextRunId);
    setSelectedProjectRunId(nextRunId);
    setStage(0);
    setInputs(["", "", "", ""]);
    setOutputs(["", "", "", ""]);
    setLoading(false);
    setCopied(false);
    setProjectLoadError("");
    setAssetError("");
    setImageGenError("");
    setGeneratedImages({});
    setImageAssets({});
    setSceneStyleReferenceIds({});
    setSceneRepaintEmphasisModes({});
    setInspirationIdeas([]);
    setInspirationError("");
    setScriptAppealReview("");
    setScriptAppealError("");
    setScriptRewriteLoading(false);
    setOutputCollapsed(false);
    setReviewCollapsed(true);
    setDirectorIntent("");
    setAssetAutoGenerating(false);
    setAssetAutoProgress("");
    setBoardPrompts({ segments: [] });
    setBoardCopied("");
    setExpandedBoardPrompt(0);
    setBoardPromptError("");
    setBoardImageResults({});
    setBoardImageGenerating("");
    setCodexJobCreating("");
    setCodexJobResults({});
    setBoardOptimizeCreating("");
    setBoardOptimizeSyncing("");
    setChunkQueue([]);
    setChunkIndex(0);
    setCompletedChunkIndex(-1);
    setChunkSceneCards([]);
    setShowChunkModal(false);
  };

  const applyWorkflowTemplate = async (template) => {
    const templateOutputs = buildWorkflowTemplateOutputs(template);
    const nextOutputs = STAGES.map(item => templateOutputs[item.id] || "");
    const nextInputs = [
      template.userInput || template.description || "",
      templateOutputs.script || "",
      templateOutputs.visual || "",
      templateOutputs.shot || "",
    ];
    const currentRunId = ensureCurrentRunId();

    setInputs(nextInputs);
    setOutputs(nextOutputs);
    setStage(0);
    setOutputCollapsed(false);
    setReviewCollapsed(true);
    setBoardCharacterRefs(buildWorkflowTemplateBoardRefs(template));
    setBoardStyle(template.globalStyle || template.boardPurpose || "");
    setStyleMode("none");
    setSceneImagePromptMode("mj");
    localStorage.setItem(STYLE_MODE_KEY, "none");
    localStorage.setItem(SCENE_IMAGE_PROMPT_MODE_KEY, "mj");

    await Promise.all(
      STAGES.map(item => persistOutput(item.id, templateOutputs[item.id] || "", currentRunId))
    );
    alert(`✅ 已导入「${template.title}」工作流模板：四个阶段产出已填充并保存到当前项目。`);
  };

  const copyPromptFromPack = async (path, body, successLabel) => {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "打包失败");
      if (!data.prompt) throw new Error("后端没有返回 prompt");
      const useFileMode = packDeliveryMode === "file";
      let fileJob = data;
      if (useFileMode && !fileJob.cli_instruction) {
        const fallbackRes = await fetch(`${API_BASE}/save_cli_job`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: data.prompt,
            job_kind: path.replace(/^\/+/, "").replace(/_job$/, ""),
            label: `${successLabel}任务包`,
            run_id: body?.run_id || ensureCurrentRunId(),
          }),
        });
        const fallbackData = await fallbackRes.json().catch(() => ({}));
        if (!fallbackRes.ok) {
          throw new Error(fallbackData.detail || "后端仍是旧版，没有 /save_cli_job；请重启后端后再打包。");
        }
        fileJob = {...data, ...fallbackData};
      }
      const copyText = useFileMode ? fileJob.cli_instruction : data.prompt;
      await navigator.clipboard.writeText(copyText);
      const savedLine = useFileMode && fileJob.job_path ? `\n\n任务文件：${fileJob.job_path}` : "";
      const targetLine = useFileMode && fileJob.target_path ? `\n目标主文件：${fileJob.target_path}` : "";
      const beforeLine = useFileMode && fileJob.before_backup_path ? `\n写入前备份：${fileJob.before_backup_path}` : "";
      const backupLine = useFileMode && fileJob.backup_path ? `\n结果备份：${fileJob.backup_path}` : "";
      const modeLine = useFileMode
        ? "剪贴板里是短指令：粘贴给 CLI，让它读取任务文件后执行并自动写回项目文件。"
        : "剪贴板里是完整任务包：粘贴到高级模型执行。";
      const copiedPreview = useFileMode ? `\n\n已复制到剪贴板的短指令：\n\n${fileJob.cli_instruction}` : "";
      const importLine = useFileMode && fileJob.target_path ? "CLI 保存完成后，点“载入项目”或刷新项目即可看到新文件；如果 CLI 没有文件写入能力，再用“导入结果”。" : "拿到结果后点击对应“导入结果”。";
      alert(`✅ ${successLabel} 已打包（${fileJob.char_count || data.char_count || data.prompt.length} 字 ≈ ${fileJob.token_estimate || data.token_estimate || Math.ceil(data.prompt.length / 2)} tokens）${savedLine}${targetLine}${beforeLine}${backupLine}\n\n${modeLine}${copiedPreview}\n\n${importLine}`);
    } catch (error) {
      alert(`打包失败：${error.message}`);
    }
  };

  const savePromptAsCliJob = async ({ prompt, jobKind, label, successLabel, targetStage = "", targetLabel = "" }) => {
    try {
      const res = await fetch(`${API_BASE}/save_cli_job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          job_kind: jobKind,
          label,
          target_stage: targetStage,
          target_label: targetLabel,
          run_id: ensureCurrentRunId(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "保存 CLI 任务文件失败");
      if (!data.cli_instruction) throw new Error("后端没有返回 CLI 短指令");
      await navigator.clipboard.writeText(data.cli_instruction);
      const targetLine = data.target_path ? `\n目标主文件：${data.target_path}` : "";
      const beforeLine = data.before_backup_path ? `\n写入前备份：${data.before_backup_path}` : "";
      const backupLine = data.backup_path ? `\n结果备份：${data.backup_path}` : "";
      const modeLine = data.target_path
        ? "剪贴板里是短指令：粘贴给 CLI，让它读取任务文件后执行并自动写回项目文件。"
        : "剪贴板里是短指令：粘贴给 CLI，让它读取任务文件后执行。";
      alert(`✅ ${successLabel} 已保存为任务文件（${data.char_count || prompt.length} 字 ≈ ${data.token_estimate || Math.ceil(prompt.length / 2)} tokens）\n\n任务文件：${data.job_path}${targetLine}${beforeLine}${backupLine}\n\n${modeLine}\n\n已复制到剪贴板的短指令：\n\n${data.cli_instruction}`);
      return data;
    } catch (error) {
      alert(`打包失败：${error.message}`);
      return null;
    }
  };

  const fetchShotPackPrompt = async () => {
    const script = stripCompletionEndMarker(outputs[0] || "");
    const visual = stripCompletionEndMarker(outputs[1] || "");
    if (!script || !visual) {
      throw new Error("阶段三打包需要阶段一剧本和阶段二固定要素库包。");
    }
    const res = await fetch(`${API_BASE}/pack_shot_job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script,
        visual,
        ip_names: selectedIPs,
        cinematographer_profile: cineProfile,
        run_id: ensureCurrentRunId(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "阶段三打包失败");
    if (!data.prompt) throw new Error("后端没有返回阶段三 prompt");
    return data;
  };

  const buildWebModelPackPrompt = (packedPrompt, title = "阶段三分镜提示词包") => `【网页版大模型执行说明】
你现在运行在网页版大模型环境（例如 ChatGPT 网页版、Gemini 网页版、Claude 网页版），不是 CLI、不是 Codex、不是 Claude Code。

请直接在当前聊天回复里输出完整成品，不要声称读取或写入本地文件，不要调用工具，不要输出文件路径，不要说“已保存到某某文件”。

如果一次回复无法完整输出，请在本次回复末尾单独写：
【待续：从这里继续】

当用户发送“继续”时，请从上一条最后一个未完成的位置无缝续写，不要重写标题，不要复述已经输出过的段落，不要解释原因。

输出目标：${title}
交付方式：只输出完整正文，不要解释创作过程，不要写前言后语。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【正式任务包】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${packedPrompt}`;

  const getScriptPackStyleHint = () => {
    const activePreset = STYLE_PRESETS[styleMode] || {};
    return [
      activePreset.name ? `风格预设：${activePreset.name}` : "",
      activePreset.script_patch || "",
      directorIntent.trim() ? `【导演意图】\n${directorIntent.trim()}` : "",
    ].filter(Boolean).join("\n\n");
  };

  const copyCliJobInstructionWithAlert = async (data, title, extraNote = "") => {
    if (!data?.cli_instruction) throw new Error("后端没有返回 CLI 短指令");
    await navigator.clipboard.writeText(data.cli_instruction);
    const targetLine = data.target_path ? `\n目标主文件：${data.target_path}` : "";
    const beforeLine = data.before_backup_path ? `\n写入前备份：${data.before_backup_path}` : "";
    const backupLine = data.backup_path ? `\n结果备份：${data.backup_path}` : "";
    alert(`✅ ${title} 已生成\n\n任务文件：${data.job_path}${targetLine}${beforeLine}${backupLine}\n\n剪贴板里是短指令，直接粘贴给 Gemini CLI / Codex / Claude Code 执行。CLI 会读取任务文件并按落盘规则写回目标主文件；完整成品会替换，续写片段会追加。\n\n${extraNote ? `${extraNote}\n\n` : ""}已复制：\n\n${data.cli_instruction}`);
  };

  const fetchScriptPackPrompt = async () => {
    const input = inputs[0].trim();
    if (!input) {
      throw new Error("阶段一打包需要先填写剧本创作请求。");
    }
    const res = await fetch(`${API_BASE}/pack_script_job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input,
        ip_names: selectedIPs,
        style_hint: getScriptPackStyleHint(),
        director_profile: directorProfile,
        run_id: ensureCurrentRunId(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "阶段一打包失败");
    if (!data.prompt) throw new Error("后端没有返回阶段一 prompt");
    return data;
  };

  const handlePackScriptForCli = async () => {
    try {
      const data = await fetchScriptPackPrompt();
      await copyCliJobInstructionWithAlert(data, "阶段一 剧本 CLI/Agent 任务包", "完成后刷新或载入当前项目即可读取新剧本。");
    } catch (error) {
      alert(`打包失败：${error.message}`);
    }
  };

  const handlePackScriptForWeb = async () => {
    try {
      const data = await fetchScriptPackPrompt();
      const webPrompt = buildWebModelPackPrompt(data.prompt, "完整剧本文档");
      await navigator.clipboard.writeText(webPrompt);
      alert(`✅ 阶段一网页版模型 Prompt 已复制\n\n这是给 ChatGPT / Gemini / Claude 网页版直接粘贴的完整任务包。\n\n长度：${webPrompt.length} 字 ≈ ${Math.ceil(webPrompt.length / 2)} tokens`);
    } catch (error) {
      alert(`打包失败：${error.message}`);
    }
  };

  const fetchVisualPackPrompt = async () => {
    const script = stripCompletionEndMarker(outputs[0] || "");
    if (!script) {
      throw new Error("阶段二打包需要先完成阶段一剧本。");
    }
    const res = await fetch(`${API_BASE}/pack_visual_job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script,
        ip_names: selectedIPs,
        art_director_profile: artProfile,
        scene_prompt_mode: sceneImagePromptMode,
        run_id: ensureCurrentRunId(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "阶段二打包失败");
    if (!data.prompt) throw new Error("后端没有返回阶段二 prompt");
    return data;
  };

  const handlePackVisualForCli = async () => {
    try {
      const data = await fetchVisualPackPrompt();
      await copyCliJobInstructionWithAlert(data, "阶段二 视觉开发 CLI/Agent 任务包", "完成后刷新或载入当前项目即可读取新固定要素库包。");
    } catch (error) {
      alert(`打包失败：${error.message}`);
    }
  };

  const handlePackVisualForWeb = async () => {
    try {
      const data = await fetchVisualPackPrompt();
      const webPrompt = buildWebModelPackPrompt(data.prompt, "完整固定要素库包");
      await navigator.clipboard.writeText(webPrompt);
      alert(`✅ 阶段二网页版模型 Prompt 已复制\n\n这是给 ChatGPT / Gemini / Claude 网页版直接粘贴的完整任务包。\n\n长度：${webPrompt.length} 字 ≈ ${Math.ceil(webPrompt.length / 2)} tokens`);
    } catch (error) {
      alert(`打包失败：${error.message}`);
    }
  };

  const handlePackShotForCli = async () => {
    try {
      const data = await fetchShotPackPrompt();
      await copyCliJobInstructionWithAlert(data, "阶段三 分镜 CLI/Agent 任务包", "CLI 不会把整篇分镜吐在聊天框里。");
    } catch (error) {
      alert(`打包失败：${error.message}`);
    }
  };

  const handlePackShotForWeb = async () => {
    try {
      const data = await fetchShotPackPrompt();
      const webPrompt = buildWebModelPackPrompt(data.prompt, "完整即梦分镜提示词包");
      await navigator.clipboard.writeText(webPrompt);
      alert(`✅ 阶段三网页版模型 Prompt 已复制\n\n这是给 ChatGPT / Gemini / Claude 网页版直接粘贴的完整任务包。\n\n长度：${webPrompt.length} 字 ≈ ${Math.ceil(webPrompt.length / 2)} tokens\n\n它会要求网页模型直接输出完整正文；如果输出不完，末尾写“【待续：从这里继续】”，你再发“继续”。`);
    } catch (error) {
      alert(`打包失败：${error.message}`);
    }
  };

  const handlePackVisual = () => {
    const script = stripCompletionEndMarker(outputs[0] || "");
    if (!script) return alert("阶段二打包需要先完成阶段一剧本。");
    copyPromptFromPack("/pack_visual_job", {
      script,
      ip_names: selectedIPs,
      art_director_profile: artProfile,
      scene_prompt_mode: sceneImagePromptMode,
      run_id: ensureCurrentRunId(),
    }, "阶段二任务包");
  };

  const handlePackShot = () => {
    const script = stripCompletionEndMarker(outputs[0] || "");
    const visual = stripCompletionEndMarker(outputs[1] || "");
    if (!script || !visual) return alert("阶段三打包需要阶段一剧本和阶段二固定要素库包。");
    copyPromptFromPack("/pack_shot_job", {
      script,
      visual,
      ip_names: selectedIPs,
      cinematographer_profile: cineProfile,
      run_id: ensureCurrentRunId(),
    }, "阶段三任务包");
  };

  const handlePackArtCut = (forceScene = "auto") => {
    const script = stripCompletionEndMarker(outputs[0] || "");
    const visual = stripCompletionEndMarker(outputs[1] || "");
    if (!visual) return alert("美术二稿打包需要阶段二一稿。");
    copyPromptFromPack("/pack_art_cut_job", {
      visual,
      script,
      ip_names: selectedIPs,
      art_director_profile: artProfile,
      force_scene: forceScene,
      scene_prompt_mode: sceneImagePromptMode,
      run_id: ensureCurrentRunId(),
    }, forceScene === "first" ? "美术二稿 S1 任务包" : forceScene === "last" ? "美术二稿末场任务包" : "美术二稿任务包");
  };

  const handlePackCineCut = (forceUnit = "auto") => {
    const script = stripCompletionEndMarker(outputs[0] || "");
    const visual = stripCompletionEndMarker(outputs[1] || "");
    const shot = stripCompletionEndMarker(outputs[2] || "");
    if (!shot) return alert("摄影二稿打包需要阶段三一稿。");
    copyPromptFromPack("/pack_cine_cut_job", {
      shot,
      visual,
      script,
      ip_names: selectedIPs,
      cinematographer_profile: cineProfile,
      force_unit: forceUnit,
      run_id: ensureCurrentRunId(),
    }, forceUnit === "first" ? "摄影二稿首镜任务包" : forceUnit === "last" ? "摄影二稿末镜任务包" : "摄影二稿任务包");
  };

  const importStageFromClipboard = async (targetStageId) => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || text.trim().length < 100) {
        return alert("剪贴板内容太短，请先复制高级模型完整输出。");
      }
      const targetIndex = STAGES.findIndex(s => s.id === targetStageId);
      if (targetIndex < 0) return;
      const currentRunId = ensureCurrentRunId();
      setOutputs(prev => {
        const next = [...prev];
        next[targetIndex] = text;
        return next;
      });
      await persistOutput(targetStageId, text, currentRunId);
      alert(`✅ 已导入并保存到 outputs/${currentRunId}/${STAGES[targetIndex].label}`);
    } catch (error) {
      alert(`导入失败：${error.message}`);
    }
  };

  const handleDirectCut = async (targetStageId) => {
    const targetIndex = STAGES.findIndex(s => s.id === targetStageId);
    if (targetIndex < 0) return;
    const currentText = stripCompletionEndMarker(outputs[targetIndex] || "");
    if (!currentText) return alert(`还没有${STAGES[targetIndex].label}一稿，无法做二稿。`);
    if (!hasEffectiveRouteKey(targetStageId)) {
      return alert(`请先在系统设置中配置 ${STAGES[targetIndex].label} 的 API Key。`);
    }

    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    const currentRunId = ensureCurrentRunId();
    setLoading(true);
    setOutputs(prev => {
      const next = [...prev];
      next[targetIndex] = "";
      return next;
    });

    const activePreset = STYLE_PRESETS[styleMode] || {};
    const styleHint = [
      activePreset.name && `风格预设：${activePreset.name}`,
      targetStageId === "script" && activePreset.script_patch,
      targetStageId === "visual" && activePreset.visual_patch,
      targetStageId === "shot" && activePreset.shot_patch,
    ].filter(Boolean).join("\n\n");
    const visualModeInstruction = sceneImagePromptMode === "mj"
      ? "【场景图提示词模式：MJ英文生图】阶段二二稿必须只输出 MJ英文场景生图提示词字段。"
      : "【场景图提示词模式：即梦中文生图】阶段二二稿必须只输出 即梦中文场景生图提示词字段。";

    const endpointByStage = {
      script: "/director_cut_script",
      visual: "/art_director_cut_visual",
      shot: "/cinematographer_cut_shot",
    };
    const bodyByStage = {
      script: {
        script: currentText,
        original_input: inputs[0] || "",
        ip_names: selectedIPs,
        routes: getEffectiveRoutes("script"),
        style_hint: styleHint,
        director_profile: directorProfile,
        force_scene: "auto",
      },
      visual: {
        visual: currentText,
        script: stripCompletionEndMarker(outputs[0] || ""),
        original_input: inputs[1] || inputs[0] || "",
        ip_names: selectedIPs,
        routes: getEffectiveRoutes("visual"),
        art_director_profile: artProfile,
        revision_focus: [styleHint, visualModeInstruction].filter(Boolean).join("\n\n"),
        force_scene: "auto",
      },
      shot: {
        shot: currentText,
        visual: stripCompletionEndMarker(outputs[1] || ""),
        script: stripCompletionEndMarker(outputs[0] || ""),
        original_input: inputs[2] || inputs[0] || "",
        ip_names: selectedIPs,
        routes: getEffectiveRoutes("shot"),
        cinematographer_profile: cineProfile,
        revision_focus: styleHint,
        force_unit: "auto",
      },
    };

    try {
      const res = await fetch(`${API_BASE}${endpointByStage[targetStageId]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyByStage[targetStageId]),
        signal: abortControllerRef.current.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        let detail = text;
        try {
          detail = JSON.parse(text).detail || text;
        } catch {
          detail = text;
        }
        throw new Error(detail || "二稿生成失败");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let cutText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        cutText += decoder.decode(value, { stream: true });
        setOutputs(prev => {
          const next = [...prev];
          next[targetIndex] = cutText;
          return next;
        });
      }
      cutText += decoder.decode();
      setOutputs(prev => {
        const next = [...prev];
        next[targetIndex] = cutText;
        return next;
      });
      await persistOutput(targetStageId, cutText, currentRunId);
    } catch (error) {
      if (error.name !== "AbortError") {
        setOutputs(prev => {
          const next = [...prev];
          next[targetIndex] = (prev[targetIndex] || "") + "\n\n> 二稿生成错误：" + error.message;
          return next;
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleUploadAsset = async (assetId, category, file, description = "") => {
    if (!file) return;
    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId();
    setRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);
    setAssetUploadingId(String(assetId));
    setAssetError("");

    const body = new FormData();
    body.append("file", file);
    body.append("img_id", String(assetId));
    body.append("category", category);
    body.append("description", description || `@图片${assetId}`);
    body.append("ip_name", selectedIPs[0] || "");
    body.append("run_id", currentRunId);

    try {
      const res = await fetch(`${API_BASE}/image_library/upload`, {
        method: "POST",
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "上传参考图失败");
      await fetchImageAssets(currentRunId);
    } catch (e) {
      setAssetError(e.message || "上传参考图失败");
    } finally {
      setAssetUploadingId("");
    }
  };

  const handleDeleteAsset = async (assetId) => {
    setAssetError("");
    try {
      const activeRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "";
      const query = activeRunId ? `?run_id=${encodeURIComponent(activeRunId)}` : "";
      const res = await fetch(`${API_BASE}/image_library/${assetId}${query}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "删除参考图失败");
      await fetchImageAssets(activeRunId);
    } catch (e) {
      setAssetError(e.message || "删除参考图失败");
    }
  };

  const handleUploadSceneStyleReference = async (sceneId, file) => {
    if (!file) return;
    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId();
    setRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);
    setAssetUploadingId(`style-${sceneId}`);
    setAssetError("");
    setImageGenError("");

    const body = new FormData();
    body.append("file", file);
    body.append("category", "other");
    body.append("description", `图片${sceneId} 风格参考`);
    body.append("ip_name", selectedIPs[0] || "");
    body.append("run_id", currentRunId);

    try {
      const res = await fetch(`${API_BASE}/image_library/upload`, {
        method: "POST",
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "上传风格参考图失败");
      if (data.asset?.id) {
        setSceneStyleReferenceIds(prev => ({...prev, [String(sceneId)]: data.asset.id}));
        setImageAssets(prev => ({...prev, [String(data.asset.id)]: data.asset}));
      }
      await fetchImageAssets(currentRunId);
    } catch (e) {
      setImageGenError(e.message || "上传风格参考图失败");
    } finally {
      setAssetUploadingId("");
    }
  };

  const generateAndBindAsset = async ({ assetId, category, prompt, description, frameId, referenceIds = [], styleReferenceIds = [], assetMap, allowSelfReference = false, routePurpose = "master" }) => {
    const imageRoute = getImageGenerationRoute(routePurpose);
    if (!hasImageGenerationRouteKey(routePurpose)) {
      const routeName = routePurpose === "repaint" ? "4B. ComfyUI垫图重绘 API" : "4A. 母版生图 API";
      throw new Error(`请先在系统设置的 [${routeName}] 里填写图片 API Key / URL / Model。ComfyUI 模式可不填 API Key，但必须填写 URL 和 comfyui:模型名。`);
    }
    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId();
    setRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);

    const boundReferenceIds = referenceIds
      .filter(id => allowSelfReference || id !== assetId)
      .filter(id => assetMap[String(id)]?.path);
    const boundStyleReferenceIds = styleReferenceIds
      .filter(id => id && id !== assetId)
      .filter(id => assetMap[String(id)]?.path);

    const res = await fetch(`${API_BASE}/generate_image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        frame_id: frameId || `ASSET-${assetId}`,
        run_id: currentRunId,
        route: {
          ...imageRoute,
          model: imageRoute.model || "gpt-image-2-pro"
        },
        size: imageSize,
        response_format: "b64_json",
        n: 1,
        reference_image_ids: boundReferenceIds,
        style_reference_image_ids: boundStyleReferenceIds,
        bind_to_image_id: assetId,
        bind_category: category,
        bind_description: description || `@图片${assetId}`
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `@图片${assetId} 生成失败`);
    return data;
  };

  const handleGenerateCharacterAsset = async (character) => {
    if (!character?.prompt || !character?.id) return;
    setImageGeneratingId(`character-${character.id}`);
    setImageGenError("");

    try {
      const data = await generateAndBindAsset({
        assetId: character.id,
        category: "character",
        prompt: character.prompt,
        description: character.description || `@图片${character.id} 角色身份板`,
        frameId: `ASSET-CHARACTER-${character.id}`,
        referenceIds: [],
        assetMap: imageAssets,
        routePurpose: "master",
      });
      if (data.bound_asset) {
        setImageAssets(prev => ({...prev, [String(character.id)]: data.bound_asset}));
      }
      await fetchImageAssets(runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "");
    } catch (e) {
      setImageGenError(e.message || "角色身份板生成失败");
    } finally {
      setImageGeneratingId("");
    }
  };

  const reviewGeneratedSceneAsset = async (scene, imageData) => {
    const effectiveReviewRoutes = getEffectiveReviewRoutes();
    const visualReviewRoute = effectiveReviewRoutes.visual || {};
    if (!visualReviewRoute.key || !imageData?.images?.[0]) return null;

    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "";
    const firstImage = imageData.images[0];
    const imagePath = firstImage.path || firstImage.public_url || firstImage.url || "";
    if (!imagePath) return null;

    const res = await fetch(`${API_BASE}/review_image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_path: imagePath,
        shot_id: `ASSET-SCENE-${scene.id}`,
        scene_id: scene.sceneId || "",
        run_id: currentRunId,
        review_routes: effectiveReviewRoutes,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "自动审片失败");
    return data;
  };

  const formatReviewIssues = (issues = []) => (
    issues.slice(0, 5).map(issue => {
      const dim = issue.dimension || "审片";
      const desc = issue.description || issue.actual || "未给出具体描述";
      return `· [${dim}] ${desc}`;
    }).join("\n")
  );

  const handleAutoCompleteReferenceAssets = async () => {
    if (assetAutoGenerating) return;
    setAssetError("");
    setImageGenError("");
    setAssetAutoGenerating(true);
    setAssetAutoProgress("正在分析缺失参考图...");

    try {
      let assetMap = {...imageAssets};
      const characterAssets = mergeCharacterAssetPrompts(
        outputs[1],
        inputs[2],
        outputs[3],
        inputs[3]
      );
      const sceneAssets = mergeSceneAssetPrompts(
        { preferEnglish: sceneImagePromptMode === "mj" },
        outputs[1],
        inputs[2],
        outputs[3],
        inputs[3]
      );
      const sceneWorldStyleContext = buildSceneWorldStyleContext(outputs[1], outputs[3], inputs[3]);
      const sceneIds = Object.keys(sceneAssets).map(Number).filter(Boolean).sort((a, b) => a - b);
      const characterIds = Object.keys(characterAssets).map(Number).filter(Boolean).sort((a, b) => a - b);
      if (!sceneIds.length && !characterIds.length) {
        throw new Error("没有从阶段二输出、阶段三输入或阶段四清单里识别到可生成参考图。请确认固定要素库包已包含无角色原图的角色身份板提示词，或已导入 @图片10-49 场景图清单。");
      }

      const missingCharacterIds = characterIds.filter(id => id >= 1 && id <= 9 && !assetMap[String(id)]?.path);
      const missingSceneIds = sceneIds.filter(id => id >= 10 && id <= 49 && !assetMap[String(id)]?.path);
      if (!missingCharacterIds.length && !missingSceneIds.length) {
        setAssetAutoProgress("参考图已经补齐。");
        return;
      }

      for (const assetId of missingCharacterIds) {
        const character = characterAssets[assetId];
        if (!character?.prompt) continue;
        setAssetAutoProgress(`正在生成角色身份板 @图片${assetId}...`);
        const data = await generateAndBindAsset({
          assetId,
          category: "character",
          prompt: character.prompt,
          description: character.description || `@图片${assetId} 角色身份板`,
          frameId: `ASSET-CHARACTER-${assetId}`,
          referenceIds: [],
          assetMap,
        });
        if (data.bound_asset) assetMap[String(assetId)] = data.bound_asset;
        await fetchImageAssets(runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "");
      }

      for (const assetId of missingSceneIds) {
        const scene = sceneAssets[assetId] || {
          description: `@图片${assetId} 场景参考图`,
          prompt: sceneImagePromptMode === "mj"
            ? `@image${assetId} empty multi-angle environment design sheet, same project-wide visual bible as the other scene assets. ${SCENE_WORLD_STYLE_BIBLE_EN.replace(/\s+/g, " ")} Use a readable animated film environment with clear foreground plant occlusion, clear midground performance space, readable background depth, character-height view / low angle / high three-quarter view chosen by the spatial task, shared lighting palette, shared material language, natural uneven ground with varied grass clumps, exposed organic soil, fallen leaves, pebbles, small wildflowers and damp dark moss patches, no characters, no animals, no people, no text, no watermark, 16:9`
            : `@图片${assetId} 可读动画电影空场景多视角设计板，继承本项目统一场景世界观基线。${SCENE_WORLD_STYLE_BIBLE_CN} 与其他场景保持同一色温体系、材质语言、地面质感、植物/地标形状词、空气感和3D动画电影渲染风格；无角色、无动物、无人物，按空间任务选择角色高度、中低机位、斜俯拍或俯拍，少量前景自然虚化遮挡，中景保留表演留白，远景森林、水道、树根或光束清楚可读；若是香蕉猫/刀盾狗，可采用童话微缩花园尺度；草地和苔藓为真实自然地表，草簇长短不齐、疏密变化、混有裸露泥土、落叶、小石子、小野花、湿润暗部和轻微踩压痕迹，禁止塑料草皮、人工草坪、网格草地、重复贴图；3D半写实动画电影场景，材质可信，电影级CG质感，非玩具渲染，非照片写实，自然景深，16:9`
        };
        setAssetAutoProgress(`正在生成场景参考 @图片${assetId}...`);
        const data = await generateAndBindAsset({
          assetId,
          category: "scene",
          prompt: appendSceneWorldStyleContext(scene.prompt, sceneWorldStyleContext),
          description: scene.description || `@图片${assetId} 场景参考图`,
          frameId: `ASSET-SCENE-${assetId}`,
          referenceIds: [],
          assetMap,
        });
        if (data.bound_asset) assetMap[String(assetId)] = data.bound_asset;
        await fetchImageAssets(runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "");
      }

      setImageAssets(assetMap);
      setAssetAutoProgress("参考图已补齐。");
    } catch (e) {
      const msg = e.message || "自动补齐参考图失败";
      setAssetError(msg);
      setImageGenError(msg);
      setAssetAutoProgress("");
    } finally {
      setAssetAutoGenerating(false);
      await fetchImageAssets(runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "");
    }
  };

  const handleGenerateSceneAsset = async (scene) => {
    if (!scene?.prompt || !scene?.id) return;
    setImageGeneratingId(`scene-${scene.id}`);
    setImageGenError("");

    try {
      const useSelfAsComfyBase = isComfyuiImageRoute(getImageGenerationRoute("repaint"))
        && Boolean(imageAssets[String(scene.id)]?.path);
      const styleReferenceId = Number(sceneStyleReferenceIds[String(scene.id)] || 0);
      const styleReferenceAsset = imageAssets[String(styleReferenceId)];
      const styleReferencePrompt = useSelfAsComfyBase && styleReferenceAsset?.path
        ? `\n\nAdditional style/world reference: use ${assetDisplayName(styleReferenceId, styleReferenceAsset)} only for the project-wide visual bible: shared lighting palette, material language, plant/landmark/prop shape vocabulary, scale language, atmosphere, ground texture, and overall art direction. Preserve this target scene's spatial task and composition.`
        : "";
      const repaintEmphasisMode = sceneRepaintEmphasisModes[String(scene.id)] || "auto";
      const repaintEmphasisPrompt = useSelfAsComfyBase
        ? buildSceneRepaintEmphasis(scene, styleReferenceAsset, repaintEmphasisMode)
        : "";
      const sceneWorldStyleContext = buildSceneWorldStyleContext(outputs[1], outputs[3], inputs[3]);
      const data = await generateAndBindAsset({
        assetId: scene.id,
        category: "scene",
        prompt: appendSceneWorldStyleContext(`${scene.prompt}${styleReferencePrompt}${repaintEmphasisPrompt}`, sceneWorldStyleContext),
        description: scene.description || `@图片${scene.id} 场景参考图`,
        frameId: `ASSET-SCENE-${scene.id}`,
        referenceIds: useSelfAsComfyBase ? [scene.id] : [],
        styleReferenceIds: useSelfAsComfyBase && styleReferenceId ? [styleReferenceId] : [],
        assetMap: imageAssets,
        allowSelfReference: useSelfAsComfyBase,
        routePurpose: useSelfAsComfyBase ? "repaint" : "master",
      });
      if (data.bound_asset) {
        setImageAssets(prev => ({...prev, [String(scene.id)]: data.bound_asset}));
      }
      if (data.reference_strategy === "no_refs" && (data.reference_assets_used?.length || 0) === 0 && extractRefIds(scene.prompt).length > 0) {
        setImageGenError(`@图片${scene.id} 已生成，但当前通道未能使用参考图，角色/场景一致性可能下降。`);
      }
      try {
        const reviewData = await reviewGeneratedSceneAsset(scene, data);
        if (reviewData?.review && reviewData.review.pass === false) {
          setImageGenError(
            `@图片${scene.id} 审片未通过 (${reviewData.review.score ?? 0}/100)\n` +
            formatReviewIssues(reviewData.review.issues || [])
          );
        }
      } catch (reviewError) {
        console.warn("自动审片失败", reviewError);
      }
      await fetchImageAssets(runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "");
    } catch (e) {
      setImageGenError(e.message || "场景图生成失败");
    } finally {
      setImageGeneratingId("");
    }
  };

  const handleGenerateInspirations = async () => {
    if (!hasEffectiveRouteKey("script")) {
      setInspirationError("请先在系统设置的 [1. 剧本生成] 里配置 API Key。");
      return;
    }

    setInspirationLoading(true);
    setInspirationError("");
    setInspirationIdeas([]);

    try {
      const activePreset = STYLE_PRESETS[styleMode];
      const storedHistory = (() => {
        try {
          const raw = localStorage.getItem(INSPIRATION_HISTORY_KEY);
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      const previousIdeas = [...storedHistory, ...inspirationIdeas]
        .filter(item => item && typeof item === "object")
        .slice(-80);
      const res = await fetch(`${API_BASE}/generate_inspirations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: inputs[0],
          style_hint: INSPIRATION_STYLE_HINTS[styleMode] || activePreset?.name || "",
          ip_names: selectedIPs,
          previous_ideas: previousIdeas,
          routes: getEffectiveRoutes()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "灵感生成失败");
      const ideas = Array.isArray(data.ideas) ? data.ideas : [];
      setInspirationIdeas(ideas);
      const seen = new Set();
      const mergedHistory = [...previousIdeas, ...ideas]
        .filter(item => item && typeof item === "object")
        .filter(item => {
          const signature = [
            item.title || "",
            item.story_engine || "",
            item.spark || item.logline || "",
            item.visual_hook || "",
          ].join("|").replace(/\s+/g, "").slice(0, 220);
          if (!signature || seen.has(signature)) return false;
          seen.add(signature);
          return true;
        })
        .slice(-120);
      localStorage.setItem(INSPIRATION_HISTORY_KEY, JSON.stringify(mergedHistory));
    } catch (e) {
      setInspirationError(e.message || "灵感生成失败");
    } finally {
      setInspirationLoading(false);
    }
  };

  const formatInspirationForInput = (idea = {}) => [
    idea.title ? `灵感标题：${idea.title}` : "",
    idea.story_engine ? `故事发动机：${idea.story_engine}` : "",
    idea.genre ? `类型气质：${idea.genre}` : "",
    idea.spark ? `灵感火花：${idea.spark}` : "",
    idea.logline ? `故事钩子：${idea.logline}` : "",
    idea.visual_hook ? `视觉记忆点：${idea.visual_hook}` : "",
    idea.conflict ? `核心冲突：${idea.conflict}` : "",
    idea.emotional_turn ? `情绪/关系转折：${idea.emotional_turn}` : "",
    idea.best_for ? `适合方向：${idea.best_for}` : "",
    idea.risk ? `需要避开的风险：${idea.risk}` : "",
    idea.story_input ? `剧本阶段创作委托：${idea.story_input}` : "",
  ].filter(Boolean).join("\n");

  const applyInspiration = (idea) => {
    const picked = formatInspirationForInput(idea);

    setInputs(prev => {
      const next = [...prev];
      next[0] = picked;
      return next;
    });
    setStage(0);
  };

  const normalizeBoardReferenceIds = (ids = []) => (
    [...new Set(ids.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0))]
  );

  const collectBoardReferenceIds = ({
    segment = {},
    gpt = "",
    jimeng = "",
    sceneAssetMap = {},
    characterAssetMap = {},
  } = {}) => {
    const involvedSceneIds = new Set((segment.units || []).map(unit => unit.sceneId).filter(Boolean));
    const sceneReferenceIds = Object.values(sceneAssetMap || {})
      .filter(asset => involvedSceneIds.has(asset.sceneId))
      .map(asset => asset.id);
    const availableCharacterReferenceIds = Object.keys(characterAssetMap || {})
      .map(Number)
      .filter(id => id >= 1 && id <= 9);
    const unitReferenceIds = (segment.units || []).flatMap(unit => extractRefIds([
      unit.refs,
      unit.prompt,
      unit.section,
    ].filter(Boolean).join("\n")));
    const promptReferenceIds = extractRefIds([gpt, jimeng].filter(Boolean).join("\n"));
    const unitCharacterReferenceIds = normalizeBoardReferenceIds(unitReferenceIds).filter(id => id >= 1 && id <= 9);
    const promptCharacterReferenceIds = normalizeBoardReferenceIds(promptReferenceIds).filter(id => id >= 1 && id <= 9);
    const promptSceneReferenceIds = normalizeBoardReferenceIds(promptReferenceIds).filter(id => id >= 10);
    const boundCharacterReferenceIds = Object.keys(imageAssets || {})
      .map(Number)
      .filter(id => id >= 1 && id <= 9 && imageAssets[String(id)]?.path);
    const selectedCharacterReferenceIds = (
      unitCharacterReferenceIds.length
        ? unitCharacterReferenceIds
        : promptCharacterReferenceIds.length
          ? promptCharacterReferenceIds
          : availableCharacterReferenceIds.length
            ? availableCharacterReferenceIds
            : boundCharacterReferenceIds
    );
    const fallbackCharacterReferenceIds = (
      selectedCharacterReferenceIds.length || boundCharacterReferenceIds.length
        ? []
        : [1, 2]
    );

    return normalizeBoardReferenceIds([
      ...fallbackCharacterReferenceIds,
      ...selectedCharacterReferenceIds,
      ...sceneReferenceIds,
      ...unitReferenceIds.filter(id => id >= 10),
      ...promptSceneReferenceIds,
    ]);
  };

  const getBoardReferenceIds = (segment = {}) => (
    normalizeBoardReferenceIds([
      ...(Array.isArray(segment.referenceIds) ? segment.referenceIds : []),
      ...extractRefIds([segment.gpt, segment.jimeng].filter(Boolean).join("\n")),
    ])
  );

  const getBoundBoardReferenceIds = (segment = {}) => (
    getBoardReferenceIds(segment).filter(id => imageAssets[String(id)]?.path)
  );

  const formatBoardReferenceSummary = (ids = []) => (
    ids.length
      ? ids.map(id => `@图片${id}${categoryForAssetId(id) === "character" ? "角色" : categoryForAssetId(id) === "scene" ? "场景" : "参考"}`).join("、")
      : "未识别到参考图编号"
  );

  const buildFullBoardPrompts = () => {
    const script = stripCompletionEndMarker(outputs[0] || "");
    const visual = stripCompletionEndMarker(outputs[1] || "");
    const shot = stripCompletionEndMarker(outputs[2] || "");
    const imagePlan = stripCompletionEndMarker(outputs[3] || "");
    if (!shot) {
      setBoardPromptError("请先完成阶段三分镜提示词包，再生成全案分镜图 prompt。");
      return;
    }

    const units = parseShotUnitsForBoard(shot, visual);
    if (!units.length) {
      setBoardPromptError("没有识别到“### 生成单元 Sx-Uy”。请确认阶段三输出是标准分镜包格式。");
      return;
    }

    const projectTitle = extractProjectTitle(script, visual, shot);
    const styleText = (boardStyle || BOARD_STYLE_HINTS[styleMode] || BOARD_STYLE_HINTS.none).trim();
    const characterRefs = (boardCharacterRefs || "").trim();
    const finalVideoPrompt = extractFinalVideoPromptForBoard(shot);
    const sceneAssetMap = mergeSceneAssetPrompts(
      { preferEnglish: sceneImagePromptMode === "mj" },
      visual,
      inputs[2],
      imagePlan,
      inputs[3]
    );
    const characterAssetMap = mergeCharacterAssetPrompts(
      visual,
      inputs[2],
      imagePlan,
      inputs[3]
    );
    const segments = splitUnitsIntoBoardSegments(units);
    const builtSegments = segments.map((segment, segmentIndex) => {
      const boardDuration = Math.max(1, Math.round((Number(segment.duration) || 15) * 2) / 2);
      const boardDurationLabel = formatBoardSeconds(boardDuration);
      const boardFrameCount = getBoardFrameCount(boardDuration, segment.units.length);
      const framePlan = buildBoardFramePlan(segment, boardFrameCount);
      const preliminaryReferenceIds = collectBoardReferenceIds({
        segment,
        sceneAssetMap,
        characterAssetMap,
      });
      const gpt = buildSegmentFullBoardPrompt({
        projectTitle,
        segment,
        segmentIndex,
        totalSegments: segments.length,
        script,
        visual,
        imagePlan,
        characterRefs,
        styleText,
        boardReferenceIds: preliminaryReferenceIds,
      });
      const canReuseExtractedFinalPrompt = finalVideoPrompt
        && segments.length === 1
        && /ENVIRONMENT:|ACTION LOGIC:|SHOT\s+1:/i.test(finalVideoPrompt)
        && !/香蕉猫\/刀盾狗|banana cat and knife-shield dog/i.test(finalVideoPrompt);
      const jimeng = canReuseExtractedFinalPrompt
        ? finalVideoPrompt
        : buildSegmentJimengPrompt({
          projectTitle,
          segment,
          segmentIndex,
          totalSegments: segments.length,
          boardDurationLabel,
          boardFrameCount,
          framePlan,
          styleText,
          boardReferenceIds: preliminaryReferenceIds,
        });
      const referenceIds = collectBoardReferenceIds({
        segment,
        gpt,
        jimeng,
        sceneAssetMap,
        characterAssetMap,
      });
      return {
        id: `第${segmentIndex + 1}段`,
        title: `${projectTitle} · 第 ${segmentIndex + 1}/${segments.length} 段 · ${boardDurationLabel}`,
        range: `${segment.units[0]?.id || ""} - ${segment.units[segment.units.length - 1]?.id || ""}`,
        duration: boardDuration,
        frameCount: boardFrameCount,
        unitCount: segment.units.length,
        sceneIds: [...new Set(segment.units.map(unit => unit.sceneId).filter(Boolean))],
        referenceIds,
        gpt,
        jimeng,
      };
    });
    setBoardPrompts({ segments: builtSegments });
    setExpandedBoardPrompt(0);
    setBoardCopied("");
    setBoardPromptError("");
  };

  const cleanJimengDirectPrompt = (prompt = "") => {
    let cleanPrompt = stripCompletionEndMarker(prompt || "").trim();
    const seedanceIndex = cleanPrompt.search(/Seedance\s+2\.0\s+Prompt\s*:/i);
    if (seedanceIndex > 0) cleanPrompt = cleanPrompt.slice(seedanceIndex).trim();
    cleanPrompt = cleanPrompt
      .replace(/^```(?:text|markdown)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    return cleanPrompt;
  };

  const setBoardSegmentJimengPrompt = (index = 0, prompt = "", meta = {}) => {
    const cleanPrompt = cleanJimengDirectPrompt(prompt || "");
    if (!cleanPrompt) return "";
    setBoardPrompts(prev => {
      const segments = [...(prev.segments || [])];
      if (!segments[index]) return prev;
      segments[index] = {
        ...segments[index],
        jimeng: cleanPrompt,
        jimengOptimizedPath: meta.path || segments[index].jimengOptimizedPath || "",
        jimengOptimizedAt: meta.updated_at || segments[index].jimengOptimizedAt || "",
      };
      return {...prev, segments};
    });
    return cleanPrompt;
  };

  const refreshBoardOptimizedJimeng = async (index = 0, { silent = false, minUpdatedTs = 0 } = {}) => {
    const targetStage = `jimeng_direct_board_${index + 1}`;
    const activeRunId = runId || selectedProjectRunId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "";
    const tryStaticFallback = async () => {
      if (!activeRunId || minUpdatedTs) return "";
      const staticPath = `/outputs/${encodeURIComponent(activeRunId)}/${targetStage}.txt`;
      const staticRes = await fetch(`${API_BASE}${staticPath}`);
      if (!staticRes.ok) return "";
      const content = (await staticRes.text()).trim();
      if (!content) return "";
      return setBoardSegmentJimengPrompt(index, content, { path: staticPath });
    };
    const params = new URLSearchParams({ target_stage: targetStage });
    if (activeRunId) params.set("run_id", activeRunId);
    if (minUpdatedTs) params.set("min_updated_ts", String(minUpdatedTs));
    if (!silent) {
      setBoardOptimizeSyncing(`board-${index}`);
      setBoardPromptError("");
    }
    try {
      const res = await fetch(`${API_BASE}/cli_stage_output?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 404) {
          const fallbackContent = await tryStaticFallback();
          if (fallbackContent) return fallbackContent;
        }
        throw new Error(data.detail || "读取看图优化结果失败");
      }
      const content = (data.content || "").trim();
      if (!data.found || !content) {
        const fallbackContent = await tryStaticFallback();
        if (fallbackContent) return fallbackContent;
        if (!silent) {
          setBoardPromptError(data.stale ? "看图优化任务已打包，等待 CLI/Agent 写回新的直投指令。" : `还没有找到 ${targetStage}.txt，请先让 CLI/Agent 执行看图优化任务。`);
        }
        return "";
      }
      const cleanPrompt = setBoardSegmentJimengPrompt(index, content, data);
      if (!silent) setBoardPromptError("");
      return cleanPrompt;
    } catch (error) {
      if (!silent) setBoardPromptError(error.message || "读取看图优化结果失败");
      return "";
    } finally {
      if (!silent) setBoardOptimizeSyncing("");
    }
  };

  const startBoardOptimizedJimengPolling = (index = 0, minUpdatedTs = 0) => {
    let attempts = 0;
    const maxAttempts = 60;
    const timer = window.setInterval(async () => {
      attempts += 1;
      const loaded = await refreshBoardOptimizedJimeng(index, { silent: true, minUpdatedTs });
      if (loaded || attempts >= maxAttempts) {
        window.clearInterval(timer);
      }
    }, 3000);
  };

  const copyBoardPrompt = async (kind, index = 0) => {
    const segment = boardPrompts.segments?.[index];
    let text = kind === "gpt" ? segment?.gpt : segment?.jimeng;
    if (kind === "jimeng") {
      const optimizedText = await refreshBoardOptimizedJimeng(index, { silent: true });
      if (optimizedText) text = optimizedText;
    }
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setBoardCopied(`${kind}-${index}`);
    setTimeout(() => setBoardCopied(""), 1800);
  };

  const handleGenerateBoardImage = async (index = 0) => {
    const segment = boardPrompts.segments?.[index];
    if (!segment?.gpt) return;
    if (!hasImageGenerationRouteKey("master")) {
      setBoardPromptError("请先在系统设置的 [4A. 母版生图 API] 中填写图片 API Key / URL / Model。ComfyUI 模式可不填 API Key，但必须填写 URL 和 comfyui:模型名。");
      return;
    }
    const expectedReferenceIds = getBoardReferenceIds(segment);
    const boundReferenceIds = getBoundBoardReferenceIds(segment);
    const missingCharacterRefs = expectedReferenceIds
      .filter(id => id >= 1 && id <= 9)
      .filter(id => !imageAssets[String(id)]?.path);
    const expectedSceneRefs = expectedReferenceIds.filter(id => id >= 10 && id <= 49);
    const boundSceneRefs = boundReferenceIds.filter(id => id >= 10 && id <= 49);
    if (missingCharacterRefs.length) {
      setBoardPromptError(`请先在“参考图资产库”上传并绑定 ${missingCharacterRefs.map(id => `@图片${id}`).join("、")}，全案图会把角色图和本段场景图一起作为参考图传入。`);
      return;
    }
    if (!boundReferenceIds.length) {
      setBoardPromptError("本段没有找到任何已绑定参考图，请先在“参考图资产库”上传或生成角色图/场景图。");
      return;
    }
    if (expectedSceneRefs.length && !boundSceneRefs.length) {
      setBoardPromptError(`本段识别到场景参考 ${expectedSceneRefs.map(id => `@图片${id}`).join("、")}，但资产库没有找到对应已绑定图片。请先生成或上传这些场景图，再用项目 API 生成全案分镜图。`);
      return;
    }

    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId();
    setRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);
    setBoardImageGenerating(`board-${index}`);
    setBoardPromptError("");

    try {
      const imageRoute = getImageGenerationRoute("master");
      const safeRange = (segment.range || `segment-${index + 1}`).replace(/[^0-9A-Za-z_\-\u4e00-\u9fa5]+/g, "_");
      const res = await fetch(`${API_BASE}/generate_image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: segment.gpt,
          frame_id: `FULL-BOARD-${index + 1}-${safeRange}`,
          run_id: currentRunId,
          route: {
            ...imageRoute,
            model: imageRoute.model || "gpt-image-2-pro",
          },
          size: imageSize || "1536x1024",
          response_format: "b64_json",
          n: 1,
          reference_image_ids: boundReferenceIds,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "全案分镜图生成失败");
      setBoardImageResults(prev => ({...prev, [index]: data}));
      const usedRefIds = new Set((data.reference_assets_used || []).map(asset => Number(asset.id)).filter(Boolean));
      const droppedRefs = boundReferenceIds.filter(id => !usedRefIds.has(id));
      if (!usedRefIds.size || droppedRefs.length) {
        setBoardPromptError(
          `全案图已生成，但当前生图通道实际使用的参考图不完整：已传入 ${formatBoardReferenceSummary(boundReferenceIds)}；后端实际使用 ${usedRefIds.size ? formatBoardReferenceSummary([...usedRefIds]) : "0 张参考图"}。如果画面仍不像角色/场景，请检查当前图片模型是否支持多参考图。`
        );
      }
    } catch (error) {
      setBoardPromptError(error.message || "全案分镜图生成失败");
    } finally {
      setBoardImageGenerating("");
    }
  };

  const handleCreateCodexBoardJob = async (index = 0) => {
    const segment = boardPrompts.segments?.[index];
    if (!segment?.gpt) return;
    const boundReferenceIds = getBoundBoardReferenceIds(segment);

    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId();
    setRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);
    setCodexJobCreating(`board-${index}`);
    setBoardPromptError("");

    try {
      const res = await fetch(`${API_BASE}/codex_storyboard_job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: currentRunId,
          segment_index: index,
          segment_title: segment.title || "",
          segment_range: segment.range || "",
          board_prompt: segment.gpt,
          jimeng_prompt: segment.jimeng || "",
          character_refs: (boardCharacterRefs || "").trim(),
          style_text: (boardStyle || BOARD_STYLE_HINTS[styleMode] || BOARD_STYLE_HINTS.none).trim(),
          reference_image_ids: boundReferenceIds,
          image_size: imageSize || "1536x1024",
          stage_outputs: {
            script: stripCompletionEndMarker(outputs[0] || ""),
            visual: stripCompletionEndMarker(outputs[1] || ""),
            shot: stripCompletionEndMarker(outputs[2] || ""),
            image: stripCompletionEndMarker(outputs[3] || ""),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Codex 任务包创建失败");
      setCodexJobResults(prev => ({...prev, [index]: data}));
    } catch (error) {
      setBoardPromptError(error.message || "Codex 任务包创建失败");
    } finally {
      setCodexJobCreating("");
    }
  };

  const makeBoardRangeSlug = (segment = {}, index = 0) => (
    (segment.range || `segment-${index + 1}`).replace(/[^0-9A-Za-z_\-\u4e00-\u9fa5]+/g, "_")
  );

  const buildBoardImageCandidateLines = (segment = {}, index = 0) => {
    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "";
    const safeRange = makeBoardRangeSlug(segment, index);
    const projectImagesDir = currentRunId
      ? `C:\\Users\\Administrator\\Desktop\\storyboard-rag\\outputs\\${currentRunId}\\images`
      : "当前项目 outputs/images 目录";
    const apiImages = (boardImageResults[index]?.images || [])
      .map(img => img.path || img.public_url || img.url || "")
      .filter(Boolean);
    const codexTarget = codexJobResults[index]?.target || {};
    const candidates = [
      ...apiImages,
      codexTarget.image_pattern || "",
      codexTarget.metadata_path || "",
      `${projectImagesDir}\\CODEX-FULL-BOARD-${index + 1}-${safeRange}_*.png`,
      `${projectImagesDir}\\FULL-BOARD-${index + 1}-${safeRange}_*.png`,
    ].filter(Boolean);
    return [...new Set(candidates)].map(item => `- ${item}`).join("\n");
  };

  const buildBoardReferenceAssetLines = (segment = {}) => {
    const ids = getBoardReferenceIds(segment);
    if (!ids.length) return "- 未识别到参考图编号；请按任务内文字锚定角色和场景。";
    return ids.map(id => {
      const asset = imageAssets[String(id)];
      const category = categoryForAssetId(id);
      const categoryLabel = category === "character" ? "角色参考" : category === "scene" ? "场景参考" : "参考图";
      return `- @图片${id} | ${categoryLabel} | ${asset?.path || asset?.public_url || "未绑定本地文件"}`;
    }).join("\n");
  };

  const buildBoardJimengOptimizePack = (segment = {}, index = 0) => {
    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "";
    const projectTitle = extractProjectTitle(outputs[0], outputs[1], outputs[2]) || "未命名项目";
    const expectedPanelLabel = Number(segment.frameCount) || "N";
    const requiredNegativeText = "no captions, subtitles, storyboard borders, panel numbers, grid lines, text labels, headers, arrows, timing notes, UI, watermark, logo, extra characters, new plot beats, future-segment events, changed character design, missing permanent props, changed environment direction, action reset, broken continuity, face deformation, toy render, poster composition, static character showcase, low-resolution output";
    return `# 看图优化即梦直投指令任务

## 任务目标

你是一位 AI 视频导演提示词优化师。请先读取并观察“已生成的黑白全案分镜图”，再结合下方核心剧情、分镜源数据和原始即梦直投指令，重写一版更适合即梦 / Seedance 2.0 直投的视频提示词。

这不是只靠图片写提示词，也不是只靠文字复述分镜。全案分镜图负责可见的 camera language、composition、action flow、key beats、visual escalation；核心剧情和分镜源数据负责 cause/effect、角色意图、情绪边界、动作逻辑和不能越界的剧情范围。

## 必须先看的图片

请在本地文件系统中寻找并打开最新一张匹配当前段落的全案分镜图。优先使用已经存在的 PNG 图片；如果同一路径下有多张，选择 LastWriteTime 最新的一张。

候选路径 / pattern：
${buildBoardImageCandidateLines(segment, index)}

如果找不到图片，不要凭空优化；请明确说明缺少全案分镜图，并列出你尝试查找的路径。

找到图片后，最终即梦直投指令里必须显式引用这张全案分镜图：使用 ${STORYBOARD_REF_TOKEN} 作为占位引用名。即使全案分镜图没有被登记成 @图片编号，也不能省略 storyboard reference；如果即梦上传后自动显示为真实引用编号，用户可把 ${STORYBOARD_REF_TOKEN} 替换为实际引用。

## 当前段落信息

- 项目：${projectTitle}
- run_id：${currentRunId || "未提供"}
- 段落：第 ${index + 1} 段
- 段落标题：${segment.title || "未命名段落"}
- 来源范围：${segment.range || "未提供"}
- 目标时长：约 ${formatBoardSeconds(segment.duration || 0)}
- 全案图格数：${segment.frameCount || "未标注"}

## 参考图资产

这些资产是最终即梦视频的参考来源。优化提示词时需要保留引用协议，不要把角色身份板、角色外貌、服装道具、场景布局、场景材质或光线设计重新写成文字说明；有高清角色/场景参考图时，最终正文只用 @图片X 表示视觉锚点。

${buildBoardReferenceAssetLines(segment)}

## 看图分析要求

请从全案分镜图中提取：
- 实际可见的镜头顺序、每格构图、主体站位、摄影机高度、推拉/下沉/跟随关系。
- 角色真实动作意图、身体重心、接触点、运动入出口、道具/披风/水面/荷叶/水下环境承载关系。
- 分镜图中比文字更清楚的视觉信息：遮挡、光源方向、前景/中景/后景层次、节奏升级、结尾状态。
- 分镜图中的潜在问题：角色是否提前出场、是否有不该出现的角色、动作是否和剧情冲突、是否有文字/边框需要在最终视频里排除。

如果全案分镜图某个细节和核心剧情冲突：以核心剧情为准，用全案图只修正镜头、构图、动线和节奏表达。

## 原始即梦直投指令

${segment.jimeng || "（未提供）"}

## 全案分镜图生成 Prompt / 源分镜依据

${segment.gpt || "（未提供）"}

## 阶段一剧本核心上下文

${stripCompletionEndMarker(outputs[0] || "") || "（未提供）"}

## 阶段三分镜提示词包上下文

${stripCompletionEndMarker(outputs[2] || "") || "（未提供）"}

## 输出格式

只输出“优化后的即梦直投指令”正文，不要输出分析过程，不要输出任务说明，不要加 Markdown 代码围栏。
最终正文目标长度：1800-3200 字符；硬上限 4200 字符。必须像 Seedance/Jimeng 直投导演口令：短、硬、连续；每句话服务动作、因果、镜头或负面约束，不写散文式氛围段落。
最终正文必须使用英文。即使源剧本、全案图文字、阶段三分镜或原始直投指令是中文，也必须把 SCENE、ACTION RULE、SHOT SEQUENCE / BEAT SEQUENCE、MOOD 等内容翻译并重写成英文。唯一允许保留中文字符的是固定引用 token，例如 @图片1、@图片10、@全案分镜图。不要输出中文标题，例如“第1段 看图优化即梦直投指令”。

先判断当前段落适合哪种视频提示词模式：
- 一镜到底连续型：追逐、跑酷、滑行、飞行、舞蹈、潜游、连续探索、单角色连续路线、全案图明显是同一摄影机持续跟拍。
- 多镜头执行型：拆解、打斗、机关、反转、多构图跳切、插入特写、staccato inserts、需要切镜表达因果。

优化后的正文必须严格采用下方两种结构之一，不要混用：

【多镜头执行型】

Seedance 2.0 Prompt:

FORMAT: [目标时长] / ${expectedPanelLabel} shots / [一句短节奏标签]

SUBJECTS: [只写本段真正出场角色的 @图片编号] as PRIMARY VISUAL SOURCE. Preserve identity exactly; do not redesign.

STORYBOARD: Use ${STORYBOARD_REF_TOKEN} ONLY as motion planning reference. Follow panel order, framing progression, camera rhythm, emotional escalation, action flow and reveal structure. Treat each panel as a sequential keyframe, not as a collage.

ENVIRONMENT: [只写本段使用的场景参考图编号，例如 @图片10、@图片11] as authoritative environment reference.

SCENE: [用 2-4 句写清本段剧情因果、路线、动作目标和揭示点。只写可拍的动作，不写诗意形容。]

ACTION RULE: [一句话写动作成立机制：接触点、受力、道具/环境反应、先因后果。]

SHOT SEQUENCE:
SHOT 1: [镜头/机位/运镜] / [主体动作与画面结果] / SFX: [短音效].
SHOT 2: ...
按全案图实际格数写完，每个 shot 只写一行，不扩写成长段。

Do not render the storyboard sheet itself. Exclude panel borders, text, labels, headers, arrows, timing notes, grid lines, UI, watermark, logo.

SEGMENT RANGE: ${segment.range || "本段来源范围"}
MOOD: [情绪递进，限 100 字符内]
STYLE: [统一渲染方向，限 180 字符内；有 @图片参考时不复述角色外貌和场景细节]

NEGATIVE: ${requiredNegativeText}.

【一镜到底连续型】

Seedance 2.0 Prompt:

FORMAT: [目标时长] / ${expectedPanelLabel} storyboard beats / one continuous unbroken take

SUBJECTS: [只写本段真正出场角色的 @图片编号] as PRIMARY VISUAL SOURCE. Preserve identity exactly; do not redesign.

STORYBOARD: Use ${STORYBOARD_REF_TOKEN} as the authoritative shot blueprint. Do not render the storyboard sheet itself. Ignore panel frames, text, labels, headers, swatches, director-strip graphics and layout elements. Treat each panel as one sequential beat inside a single continuous unbroken [rear-FPV / handheld follow / side-tracking / orbit-follow] shot.

ENVIRONMENT: [只写本段使用的场景参考图编号，例如 @图片10、@图片11] as authoritative environment reference.

SCENE: [用 2-4 句写清连续动作的起点、路线、动作目标、障碍和结尾状态。重点写可追踪路线，不写诗意形容。]

CAMERA MODE: One continuous [camera mode], no cuts. The camera stays physically present, reacts to speed, obstacles, occlusion, refocus and distance, and never teleports to a new angle.

ACTION RULE: [一句话写动作成立机制：接触点、受力、道具/环境反应、先因后果。]

BEAT SEQUENCE:
1. [按全案图 panel 顺序写连续动作 beat]
2. ...
按全案图实际格数写完，每个 beat 只写一行，不扩写成长段。

MOOD: [情绪递进，限 100 字符内]
STYLE: [统一渲染方向，限 180 字符内；有 @图片参考时不复述角色外貌和场景细节]

NEGATIVE: no cuts, no hard scene cuts, no camera teleport, ${requiredNegativeText}.

## 优化规则

- 必须明确“不要渲染分镜图本身”：排除 panel borders、text、labels、headers、arrows、timing notes、grid lines、UI、watermark、logo。
- 必须显式写出 ${STORYBOARD_REF_TOKEN}；不能只写 uploaded storyboard、black-and-white storyboard 或 storyboard image 这种没有引用锚点的泛称。
- 如果角色/场景已有高清完整图片参考，最终即梦提示词里角色和场景只写 @图片编号，不要在引用句、ENVIRONMENT 或 STYLE 里补写外貌、服装、材质、场景地标、光线细节、颜色细节；这些视觉信息全部交给参考图。
- 多镜头执行型必须输出 \`SHOT SEQUENCE:\`，并按全案图实际格数写 \`SHOT 1:\`、\`SHOT 2:\`...；每行只保留“镜头/运镜 / 动作结果 / SFX”，不要把全案图长 prompt 或技术备注复制进去。
- 一镜到底连续型必须输出 \`BEAT SEQUENCE:\`，不要写 \`SHOT 1:\`；要明确 no cuts、single continuous unbroken take、camera stays physically present。
- STORYBOARD 引用必须显式写 ${STORYBOARD_REF_TOKEN}；多镜头型写 ONLY as motion planning reference，一镜到底型写 authoritative shot blueprint，并说明每个 panel 是同一个连续镜头里的 sequential beat。
- SCENE 负责故事因果和路线；SHOT SEQUENCE / BEAT SEQUENCE 负责执行；不要再单独写长篇 CORE STORY、MOTION LANGUAGE、ACTION CHAIN 段落。
- NEGATIVE 必须完整覆盖这些约束，不得删减：${requiredNegativeText}。
- 必须保留核心剧情因果，不新增后续段落剧情，不提前出现后续角色。
- 必须使用看图得到的镜头语言：不要只复述原始提示词。
- 必须让最终视频像高端 3D 动画电影中的运动镜头，不像角色展示、静态摆拍、玩具渲染、海报或设定图。
- 删除所有重复形容词、长篇风格说明、完整场景卡复述、角色身份板复述和无效礼貌语。
- 如果当前段只出现某个角色，不要把未出场角色写进 onscreen action；可以在 NEGATIVE 里禁止提前出现。
- 最终即梦直投正文必须是英文；不要中英混写。只有 @图片、@全案分镜图 这类固定引用 token 可以保留中文字符。

## 输出前静默自检

在最终输出前请自行检查，但不要把检查过程写出来：
1. 是否显式写了 ${STORYBOARD_REF_TOKEN}。
2. 是否正确选择了多镜头执行型或一镜到底连续型，没有混用。
3. 多镜头是否有 \`SHOT SEQUENCE:\` 且 shot 数等于全案图格数；一镜到底是否有 \`BEAT SEQUENCE:\` 且 beat 数等于全案图格数。
4. 每个 shot / beat 是否一行完成“镜头/动作/SFX”或“动作/camera beat/SFX”，没有散文段落。
5. SCENE 是否写清本段核心因果、动作路线和揭示点。
6. NEGATIVE 是否包含全部必备项。
7. 除 @图片、@全案分镜图 之外，最终正文是否没有任何中文字符。
8. 最终正文是否不超过 4200 字符。
任何一项不满足，都必须压缩重写后再输出正文。
`;
  };

  const handlePackBoardJimengOptimize = async (index = 0) => {
    const segment = boardPrompts.segments?.[index];
    if (!segment?.jimeng) {
      setBoardPromptError("请先生成每段全案 Prompt，确保已有即梦直投指令。");
      return;
    }
    setBoardOptimizeCreating(`board-${index}`);
    setBoardPromptError("");
    try {
      const job = await savePromptAsCliJob({
        prompt: buildBoardJimengOptimizePack(segment, index),
        jobKind: `jimeng_visual_optimize_board_${index + 1}`,
        label: `第${index + 1}段 看图优化即梦直投指令`,
        successLabel: `第${index + 1}段 看图优化即梦直投指令任务包`,
        targetStage: `jimeng_direct_board_${index + 1}`,
        targetLabel: `第${index + 1}段看图优化后的即梦直投指令`,
      });
      if (job?.target_path) {
        startBoardOptimizedJimengPolling(index, Number(job.target_existing_mtime || 0));
      }
    } finally {
      setBoardOptimizeCreating("");
    }
  };

  const getPreviousStageContext = (stageIndex = stage) => {
    if (stageIndex === 1) {
      const script = stripCompletionEndMarker(outputs[0] || "");
      return script ? `【阶段一剧本】\n${script}` : "";
    }
    if (stageIndex === 2) {
      const script = stripCompletionEndMarker(outputs[0] || "");
      const visual = stripCompletionEndMarker(outputs[1] || "");
      return [
        script ? `【阶段一剧本】\n${script}` : "",
        visual ? `【阶段二视觉开发】\n${visual}` : ""
      ].filter(Boolean).join("\n\n---\n\n");
    }
    if (stageIndex === 3) {
      const script = stripCompletionEndMarker(outputs[0] || "");
      const visual = stripCompletionEndMarker(outputs[1] || "");
      const shot = stripCompletionEndMarker(outputs[2] || "");
      return [
        script ? `【阶段一剧本】\n${script}` : "",
        visual ? `【阶段二视觉开发】\n${visual}` : "",
        shot ? `【阶段三分镜提示词包】\n${shot}` : ""
      ].filter(Boolean).join("\n\n---\n\n");
    }
    return "";
  };

  const getReviewLabels = () => {
    if (stage === 1) {
      return {
        quick: "视觉快速检查",
        full: "视觉四方会审",
        final: "视觉定稿检查",
        rewrite: "按建议重写视觉开发",
        loading: "视觉会审中..."
      };
    }
    if (stage === 2) {
      return {
        quick: "分镜快速检查",
        full: "分镜四方会审",
        final: "分镜定稿检查",
        rewrite: "按建议重写分镜包",
        loading: "分镜会审中..."
      };
    }
    if (stage === 3) {
      return {
        quick: "生图包快速检查",
        full: "生图包四方会审",
        final: "生图包定稿检查",
        rewrite: "按建议重写生图包",
        loading: "生图包会审中..."
      };
    }
    return {
      quick: "快速复盘",
      full: "五方会审",
      final: "定稿检查",
      rewrite: "按会审建议重写",
      loading: "复盘中..."
    };
  };

  const buildChunkReviewConstraint = () => {
    const review = scriptAppealReview?.trim();
    if (!review) return "";

    const wantedHeadings = [
      "会审结论",
      "仲裁总结",
      "共识问题",
      "分歧点",
      "进入下一阶段判断",
      "可直接复制的修稿指令",
      "定稿结论",
      "硬伤检查",
      "下一步",
      "阻断风险",
      "修改建议"
    ];

    const sections = review
      .split(/(?=^#{1,3}\s+)/m)
      .map(s => s.trim())
      .filter(Boolean);

    let distilled = sections
      .filter(section => {
        const firstLine = section.split("\n")[0] || "";
        return wantedHeadings.some(h => firstLine.includes(h));
      })
      .join("\n\n");

    if (!distilled) {
      const summaryStart = review.indexOf("# 仲裁总结");
      distilled = summaryStart >= 0 ? review.slice(summaryStart) : review;
    }

    distilled = distilled
      .replace(/^# 各方原始意见[\s\S]*$/m, "")
      .replace(/^---\s*$/gm, "")
      .trim();

    const maxLen = 2400;
    if (distilled.length > maxLen) {
      distilled = distilled.slice(0, maxLen) + "\n\n（以上为会审意见节选，已自动截断）";
    }

    return distilled;
  };

  const handleReviewScriptAppeal = async (reviewMode = "quick") => {
    const content = outputs[stage]?.trim();
    if (!content) return;
    const stageId = STAGES[stage].id;
    const needsMainRoute = reviewMode === "quick" || reviewMode === "final";
    if (needsMainRoute && !hasEffectiveRouteKey(stageId)) {
      const routeName = stageId === "image" ? "3. 分镜提示词（用于检查第4阶段请求包）" : (config.routes[stageId]?.name || STAGES[stage].label);
      setScriptAppealError(`请先在系统设置的 [${routeName}] 里配置 API Key。`);
      return;
    }

    setScriptAppealLoading(true);
    setScriptAppealError("");
    setScriptAppealReview("");
    setReviewCollapsed(false);

    try {
      const res = await fetch(`${API_BASE}/review_stage_stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: stageId,
          content,
          previous_content: getPreviousStageContext(stage),
          original_input: inputs[0],
          ip_names: selectedIPs,
          routes: getEffectiveRoutes(stageId),
          review_routes: getEffectiveReviewRoutes(),
          review_mode: reviewMode
        })
      });
      if (!res.ok) {
        const text = await res.text();
        let detail = text;
        try {
          detail = JSON.parse(text).detail || text;
        } catch {
          detail = text;
        }
        throw new Error(detail || "阶段会审失败");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let reviewText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        reviewText += decoder.decode(value, { stream: true });
        setScriptAppealReview(reviewText);
      }
    } catch (e) {
      setScriptAppealError(e.message || "阶段会审失败");
    } finally {
      setScriptAppealLoading(false);
    }
  };

  const handleRewriteScriptFromReview = async () => {
    const stageId = STAGES[stage].id;
    const currentContent = stripCompletionEndMarker(outputs[stage] || "");
    const review = scriptAppealReview?.trim();
    if (!currentContent || !review) return;
    if (!hasEffectiveRouteKey(stageId)) {
      const routeName = stageId === "image" ? "3. 分镜提示词（用于组装第4阶段场景图清单）" : (config.routes[stageId]?.name || STAGES[stage].label);
      setScriptAppealError(`请先在系统设置的 [${routeName}] 里配置 API Key。`);
      return;
    }

    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();

    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId();
    setRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutTriggeredRef.current = false;
    timeoutRef.current = setTimeout(() => {
      timeoutTriggeredRef.current = true;
      if (abortControllerRef.current) abortControllerRef.current.abort();
    }, 300000);

    setLoading(true);
    setScriptRewriteLoading(true);
    setScriptAppealError("");
    setOutputs(prev => {
      const next = [...prev];
      next[stage] = "";
      return next;
    });

    try {
      const activePreset = STYLE_PRESETS[styleMode];
      let sysPrompt = config.prompts[stageId];
      if (activePreset.script_patch && stageId === "script") {
        sysPrompt += "\n\n" + activePreset.script_patch;
      }
      if (activePreset.visual_patch && stageId === "visual") {
        sysPrompt += "\n\n" + activePreset.visual_patch;
      }
      if (activePreset.shot_patch && stageId === "shot") {
        sysPrompt += "\n\n" + activePreset.shot_patch;
      }
      if (stageId === "visual" || stageId === "image") {
        sysPrompt += "\n\n" + getScenePromptModeInstruction(
          sceneImagePromptMode,
          stageId === "image" ? "imageList" : "sceneCard"
        );
      }
      sysPrompt = withEndMarkerInstruction(sysPrompt);

      const stageRewriteGuides = {
        script: "请重写为修订后的正式剧本。保留核心主角、核心奇观、核心关系弧和无对白/少对白设定，不要换成新故事。",
        visual: "请重写为修订后的固定要素库包。重点修正角色/场景/道具/色彩/材质/场景图提示词/参考图编号问题，不要输出分镜或视频提示词。",
        shot: "请重写为修订后的分镜提示词包。重点修正镜头顺序、景别运镜、动作因果、剪辑节奏、连续性和生成单元可执行性。",
        image: "请重写为修订后的场景图生图清单。重点修正 @图片10-49 场景编号、空场景 prompt、表演留白、光线材质和负面约束；不要生成关键帧、首尾帧、姿势图或 @图片50+。"
      };

      let revisionInput = `【任务】请根据会审报告，对下方现有${STAGES[stage].label}阶段产出进行“小修重写”。

【硬性要求】
1. 只输出修订后的当前阶段正式产出，不要输出复盘、解释、修改清单或对比说明。
2. ${stageRewriteGuides[stageId] || "保留原项目核心设定，只做针对性修订。"}
3. 优先执行会审报告里的“共识问题”“最需要立刻修的风险”“可直接复制的修稿指令”。
4. 如果会审意见互相冲突，优先听“执行制片评审”和“会审结论”中的最终决策。
5. 修稿目标是让当前阶段产出可以直接进入下一阶段：表达更清楚、连续性更稳、制作执行更可靠。

【原始用户要求】
${inputs[0]?.trim() || "（无）"}

【前置阶段内容】
${getPreviousStageContext(stage) || "（无）"}

【当前阶段原产出】
${currentContent}

【会审报告】
${review}`;

      if (stageId === "shot") {
        const script = stripCompletionEndMarker(outputs[0] || "");
        const shotContinuityGuard = `【阶段连续性硬约束】
1. 只允许使用阶段一剧本和阶段二固定要素库中已经存在的场景编号、地点、道具和参考图编号；不要新增、删除或改名场景。
2. 每个生成单元必须继承对应场景卡的场景图编号，例如 | S1 | 使用 @图片10，| S2 | 使用 @图片11；不要把 @图片编号挪给其他地点。
3. 如果总览、编号表、示例或旧历史内容互相冲突，以阶段一剧本正文和阶段二“场景卡 · | S? |”为准。
4. 禁止把后续场景改写成固定要素库里没有的浅溪、蘑菇林、发光植物等新场景，除非这些词已在剧本正文和对应场景卡中明确出现。
5. 每个场景必须覆盖剧本中该场的目标、阻力、角色选择和可见结果；不要只写追逐、凝视、对峙、站立、怒吼、转身离开等姿态镜头。
6. 总览里的生成单元数量和总成片时长必须与正文实际生成单元一致，输出前自行核算一遍。`;
        revisionInput = (script ? "【完整剧本文档（阶段一产出）】\n" + script + "\n\n---\n\n" : "")
          + "【分镜重写任务】\n" + revisionInput
          + "\n\n【场景顺序强制规则】\n请严格按照剧本与场景卡编号从 | S1 |、| S2 |、| S3 | 依次往后生成。"
          + "\n\n" + shotContinuityGuard;
      }
      if (stageId === "image") {
        const script = stripCompletionEndMarker(outputs[0] || "");
        const visual = stripCompletionEndMarker(outputs[1] || "");
        const shot = stripCompletionEndMarker(outputs[2] || "");
        const imageContinuityGuard = `【阶段连续性硬约束】
0. 默认继承 ASSET-SCENE-10 场景世界风格 Bible：风格化半写实 3D 动画电影环境，电影感但非照片写实，自然日光，柔和斑驳光影，绘画感调色，高细节 CG，蓝绿色空气透视，童话微缩花园尺度，开阔中景表演空间，自然草地/泥土/苔藓/碎石/野花混合材质；除非用户明确指定新风格，否则不要偏成纯卡通、玩具渲染、写实摄影、压抑封闭空间或植物隧道。
1. 阶段二“场景卡 · | S? |”里的 @图片10-49 对应关系是最高场景裁判；如果阶段三分镜中出现与阶段二冲突的场景名、参考图编号或地点，第四阶段必须修正为阶段二场景卡。
2. 只输出 @图片10-49 空场景图请求，不要输出关键帧清单、逐帧生图请求、首帧、尾帧、姿势图或 @图片50+。
3. 所有场景图必须是空场景或明确要求的道具场景，不要把角色、小动物、额外生物混进 @图片10-49 场景资产。
4. 后续即梦视频使用方式是“角色原图 + 场景图”，所以本阶段不解决角色姿态一致性，只负责场景稳定。
5. 场景图必须是可读动画电影场景空间：可接近角色高度、中低机位、斜俯拍或俯拍观察，香蕉猫/刀盾狗可使用童话微缩花园尺度，但后景风景和空间结构必须可读；禁止退回显微镜视角、微距局部素材、极浅景深、背景完全虚化或只拍局部苔藓/水滴。
6. 草地/苔藓/森林地面必须是真实自然材质：草簇长短不齐、疏密变化、混有泥土、落叶、小石子、湿润暗部和踩压痕迹；禁止塑料草皮、人工草坪、网格草地、重复编织纹理。
7. 每个场景图提示词必须有明确空间任务和构图策略：入口/过渡/阻碍/转折/开阔收束之一；写清引导线、中景空白区、远景地标、童话地标物、极轻透明空气感和冷暖光变化。
8. 治愈童话场景优先采用“童话地标物 + 柔软自然地表舞台 + 前景叶片/花草包围 + 可读森林纵深 + 少量透明空气感 + 暖光斑”的构成；不要把雾气浓淡作为主要递进手段，不要使用浓雾、厚雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、惊悚、悬疑、写真摄影感。
9. 先提炼一套全片场景世界观基线，并让 @图片10-49 都继承同一套色温逻辑、光线语言、材质语言、地面质感、植物/地标形状词、空气感和3D动画电影渲染风格；每场只改变空间任务、地标物、构图和局部光源状态。`;
        revisionInput = [
          script ? "【完整剧本文档（阶段一产出）】\n" + script : "",
          visual ? "【固定要素库包（阶段二产出）】\n" + visual : "",
          shot ? "【分镜提示词包（阶段三产出）】\n" + shot : "",
          "【场景图生图清单重写任务】\n" + revisionInput + "\n\n" + imageContinuityGuard
        ].filter(Boolean).join("\n\n---\n\n");
      }

      const rewriteBody = {
        stage: stageId,
        input: revisionInput,
        session_id: "session_" + stageId,
        system_prompt: sysPrompt,
        ip_names: selectedIPs,
        run_id: currentRunId,
        routes: getEffectiveRoutes(stageId)
      };
      if (stageId === "visual") {
        rewriteBody.art_director_profile = artProfile;
      }
      if (stageId === "shot") {
        rewriteBody.cinematographer_profile = cineProfile;
      }

      const res = await fetch(`${API_BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rewriteBody),
        signal: abortControllerRef.current.signal,
      });

      if (!res.ok) throw new Error("HTTP 错误: " + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let revisedText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (abortControllerRef.current?.signal.aborted) break;
        revisedText += decoder.decode(value, { stream: true });
        setOutputs(prev => {
          const next = [...prev];
          next[stage] = revisedText;
          return next;
        });
      }

      await persistOutput(stageId, revisedText, currentRunId);
    } catch (e) {
      if (e.name === "AbortError") {
        setOutputs(prev => {
          const next = [...prev];
          const errMsg = timeoutTriggeredRef.current && !prev[stage]
            ? "\n\n> 请求超时（300秒），请检查网络或后端日志。"
            : "";
          if (errMsg) next[stage] = prev[stage] + errMsg;
          return next;
        });
      } else {
        setOutputs(prev => {
          const next = [...prev];
          next[stage] = (prev[stage] || "") + "\n\n> 重写错误：" + e.message;
          return next;
        });
      }
    } finally {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setLoading(false);
      setScriptRewriteLoading(false);
    }
  };

  const buildReviewRewritePackPrompt = () => {
    const stageId = STAGES[stage].id;
    const currentContent = stripCompletionEndMarker(outputs[stage] || "");
    const review = scriptAppealReview?.trim();
    if (!currentContent || !review) return "";

    const activePreset = STYLE_PRESETS[styleMode] || {};
    let systemRules = config.prompts[stageId] || "";
    if (activePreset.script_patch && stageId === "script") {
      systemRules += "\n\n" + activePreset.script_patch;
    }
    if (activePreset.visual_patch && stageId === "visual") {
      systemRules += "\n\n" + activePreset.visual_patch;
    }
    if (activePreset.shot_patch && stageId === "shot") {
      systemRules += "\n\n" + activePreset.shot_patch;
    }
    if (stageId === "visual" || stageId === "image") {
      systemRules += "\n\n" + getScenePromptModeInstruction(
        sceneImagePromptMode,
        stageId === "image" ? "imageList" : "sceneCard"
      );
    }

    const selectedProfileText = [
      `导演风格：${DIRECTOR_PROFILE_OPTIONS.find(option => option.value === directorProfile)?.label || directorProfile}`,
      `美术画像：${ART_PROFILE_OPTIONS.find(option => option.value === artProfile)?.label || artProfile}`,
      `摄影画像：${CINE_PROFILE_OPTIONS.find(option => option.value === cineProfile)?.label || cineProfile}`,
    ].join("\n");

    const stageRewriteGuides = {
      script: "请重写为修订后的正式剧本。保留核心主角、核心奇观、核心关系弧和无对白/少对白设定，不要换成新故事。",
      visual: "请重写为修订后的固定要素库包。重点修正角色/场景/道具/色彩/材质/场景图提示词/参考图编号问题，不要输出分镜或视频提示词。",
      shot: "请重写为修订后的分镜提示词包。重点修正镜头顺序、景别运镜、动作因果、剪辑节奏、连续性和生成单元可执行性。",
      image: "请重写为修订后的场景图生图清单。重点修正 @图片10-49 场景编号、空场景 prompt、表演留白、光线材质和负面约束；不要生成关键帧、首尾帧、姿势图或 @图片50+。"
    };

    let revisionInput = `【任务】请根据会审报告，对下方现有${STAGES[stage].label}阶段产出进行“小修重写”。

【硬性要求】
1. 只输出修订后的当前阶段正式产出，不要输出复盘、解释、修改清单或对比说明。
2. ${stageRewriteGuides[stageId] || "保留原项目核心设定，只做针对性修订。"}
3. 优先执行会审报告里的“共识问题”“最需要立刻修的风险”“可直接复制的修稿指令”。
4. 如果会审意见互相冲突，优先听“执行制片评审”和“会审结论”中的最终决策。
5. 修稿目标是让当前阶段产出可以直接进入下一阶段：表达更清楚、连续性更稳、制作执行更可靠。
6. 输出给前端导入使用：不要包 Markdown 代码块，不要额外输出 end 标记。

【原始用户要求】
${inputs[0]?.trim() || "（无）"}

【前置阶段内容】
${getPreviousStageContext(stage) || "（无）"}

【当前阶段原产出】
${currentContent}

【会审报告】
${review}`;

    if (stageId === "shot") {
      const script = stripCompletionEndMarker(outputs[0] || "");
      const shotContinuityGuard = `【阶段连续性硬约束】
1. 只允许使用阶段一剧本和阶段二固定要素库中已经存在的场景编号、地点、道具和参考图编号；不要新增、删除或改名场景。
2. 每个生成单元必须继承对应场景卡的场景图编号，例如 | S1 | 使用 @图片10，| S2 | 使用 @图片11；不要把 @图片编号挪给其他地点。
3. 如果总览、编号表、示例或旧历史内容互相冲突，以阶段一剧本正文和阶段二“场景卡 · | S? |”为准。
4. 禁止把后续场景改写成固定要素库里没有的新场景，除非这些词已在剧本正文和对应场景卡中明确出现。
5. 每个场景必须覆盖剧本中该场的目标、阻力、角色选择和可见结果。
6. 总览里的生成单元数量和总成片时长必须与正文实际生成单元一致，输出前自行核算一遍。`;
      revisionInput = (script ? "【完整剧本文档（阶段一产出）】\n" + script + "\n\n---\n\n" : "")
        + "【分镜重写任务】\n" + revisionInput
        + "\n\n【场景顺序强制规则】\n请严格按照剧本与场景卡编号从 | S1 |、| S2 |、| S3 | 依次往后生成。"
        + "\n\n" + shotContinuityGuard;
    }

    if (stageId === "image") {
      const script = stripCompletionEndMarker(outputs[0] || "");
      const visual = stripCompletionEndMarker(outputs[1] || "");
      const shot = stripCompletionEndMarker(outputs[2] || "");
      revisionInput = [
        script ? "【完整剧本文档（阶段一产出）】\n" + script : "",
        visual ? "【固定要素库包（阶段二产出）】\n" + visual : "",
        shot ? "【分镜提示词包（阶段三产出）】\n" + shot : "",
        "【场景图生图清单重写任务】\n" + revisionInput
      ].filter(Boolean).join("\n\n---\n\n");
    }

    return `你是一个高级模型 CLI 执行代理。请严格按下面任务重写当前阶段产出，并只返回可导入前端的完整新版正文。

==============================
【当前阶段系统规则】
==============================
${systemRules}

==============================
【当前选择的导演/美术/摄影画像】
==============================
${selectedProfileText}

==============================
【会审后重写任务包】
==============================
${revisionInput}`;
  };

  const handlePackReviewRewrite = async () => {
    const packed = buildReviewRewritePackPrompt();
    if (!packed) {
      return alert("需要先有当前阶段输出，并完成一次会审，才能打包会审重写任务。");
    }
    if (packDeliveryMode === "clipboard") {
      await navigator.clipboard.writeText(packed);
      alert(`✅ 会审重写任务包已复制完整 prompt（${packed.length} 字 ≈ ${Math.ceil(packed.length / 2)} tokens）\n\n剪贴板里是完整任务包：粘贴到高级模型执行。`);
      return;
    }
    const stageId = STAGES[stage].id;
    await savePromptAsCliJob({
      prompt: packed,
      jobKind: `review_rewrite_${stageId}`,
      label: `${STAGES[stage].label}会审重写任务包`,
      successLabel: "会审重写任务包",
      targetStage: stageId,
      targetLabel: `${STAGES[stage].label}会审重写结果`,
    });
  };

  const handleGenerate = async () => {
    const input = inputs[stage].trim();
    if (!input) return;

    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();

    const stageId = STAGES[stage].id;
    const currentRunId = stageId === "script"
      ? createPipelineRunId()
      : (runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId());
    setRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);
    if (stageId === "script") {
      setImageAssets({});
      setGeneratedImages({});
    }

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutTriggeredRef.current = false;
    timeoutRef.current = setTimeout(() => {
      timeoutTriggeredRef.current = true;
      if (abortControllerRef.current) abortControllerRef.current.abort();
    }, 300000);

    setLoading(true);
    setScriptAppealReview("");
    setScriptAppealError("");
    setOutputs(prev => { const next = [...prev]; next[stage] = ""; return next; });

    try {
      // 🌟 组合风格补丁到 System Prompt
      const activePreset = STYLE_PRESETS[styleMode];
      let sysPrompt = config.prompts[stageId];

      if (activePreset.script_patch && (stageId === "script")) {
        sysPrompt += "\n\n" + activePreset.script_patch;
      }
      if (activePreset.visual_patch && (stageId === "visual")) {
        sysPrompt += "\n\n" + activePreset.visual_patch;
      }
      if (activePreset.shot_patch && (stageId === "shot")) {
        sysPrompt += "\n\n" + activePreset.shot_patch;
      }

      if (stageId === "visual" || stageId === "image") {
        sysPrompt += "\n\n" + getScenePromptModeInstruction(
          sceneImagePromptMode,
          stageId === "image" ? "imageList" : "sceneCard"
        );
      }
      sysPrompt = withEndMarkerInstruction(sysPrompt);

      // 🌟 阶段三(分镜提示词)：自动将阶段一的剧本注入上下文
      // 确保 AI 同时看到 剧本 + 固定要素库包（V2 §6 要求两样都传入）
      let finalInput = input;
      if (stageId === "shot") {
        const script = stripCompletionEndMarker(outputs[0] || "");
        const shotContinuityGuard = `【阶段连续性硬约束】
1. 只允许使用阶段一剧本和阶段二固定要素库中已经存在的场景编号、地点、道具和参考图编号；不要新增、删除或改名场景。
2. 每个生成单元必须继承对应场景卡的场景图编号，例如 | S1 | 使用 @图片10，| S2 | 使用 @图片11；不要把 @图片编号挪给其他地点。
3. 如果总览、编号表、示例或旧历史内容互相冲突，以阶段一剧本正文和阶段二“场景卡 · | S? |”为准。
4. 禁止把后续场景改写成固定要素库里没有的浅溪、蘑菇林、发光植物等新场景，除非这些词已在剧本正文和对应场景卡中明确出现。
5. 每个场景必须覆盖剧本中该场的目标、阻力、角色选择和可见结果；不要只写追逐、凝视、对峙、站立、怒吼、转身离开等姿态镜头。
6. 总览里的生成单元数量和总成片时长必须与正文实际生成单元一致，输出前自行核算一遍。`;
        finalInput = (script ? "【完整剧本文档（阶段一产出）】\n" + script + "\n\n---\n\n" : "")
                   + "【固定要素库包（阶段二产出，粘贴在下方）】\n" + input
                   + "\n\n【场景顺序强制规则】\n请严格按照剧本与场景卡编号从 | S1 |、| S2 |、| S3 | 依次往后生成。不要因为固定要素库包总览、情绪峰值、参考图表或相关概念里先出现了其他编号，就改变场景顺序。"
                   + "\n\n" + shotContinuityGuard;
      }
      if (stageId === "image") {
        const script = stripCompletionEndMarker(outputs[0] || "");
        const visual = stripCompletionEndMarker(outputs[1] || "");
        const shot = stripCompletionEndMarker(outputs[2] || input);
        const manualNote = input && stripCompletionEndMarker(input) !== shot
          ? "【用户补充要求/局部指定】\n" + input
          : "";
        finalInput = [
          script ? "【完整剧本文档（阶段一产出）】\n" + script : "",
          visual ? "【固定要素库包（阶段二产出）】\n" + visual : "",
          shot ? "【分镜提示词包（阶段三产出）】\n" + shot : "",
          manualNote,
          `【第四阶段任务】
请基于以上完整上下文，生成适合无状态按次图片 API 的“场景图生图清单”。本阶段只生成空场景资产，用于后续和角色原图一起交给图片/视频生成模型做参考。

【阶段连续性硬约束】
0. 默认继承 ASSET-SCENE-10 场景世界风格 Bible：风格化半写实 3D 动画电影环境，电影感但非照片写实，自然日光，柔和斑驳光影，绘画感调色，高细节 CG，蓝绿色空气透视，童话微缩花园尺度，开阔中景表演空间，自然草地/泥土/苔藓/碎石/野花混合材质；除非用户明确指定新风格，否则不要偏成纯卡通、玩具渲染、写实摄影、压抑封闭空间或植物隧道。
1. 阶段二“场景卡 · | S? |”里的 @图片10-49 对应关系是最高场景裁判；如果阶段三分镜中出现与阶段二冲突的场景名、参考图编号或地点，第四阶段必须修正为阶段二场景卡。
2. 只输出 @图片10-49 空场景图请求，不要输出关键帧清单、逐帧生图请求、首帧、尾帧、姿势图或 @图片50+。
3. 所有场景图必须是空场景或明确要求的道具场景，不要把角色、小动物、额外生物混进 @图片10-49 场景资产。
4. 后续即梦视频使用方式是“角色原图 + 场景图”，所以本阶段不解决角色姿态一致性，只负责场景稳定。
5. 场景图必须是可读动画电影场景空间：可接近角色高度、中低机位、斜俯拍或俯拍观察，香蕉猫/刀盾狗可使用童话微缩花园尺度，但后景风景和空间结构必须可读；禁止退回显微镜视角、微距局部素材、极浅景深、背景完全虚化或只拍局部苔藓/水滴。
6. 草地/苔藓/森林地面必须是真实自然材质：草簇长短不齐、疏密变化、混有泥土、落叶、小石子、湿润暗部和踩压痕迹；禁止塑料草皮、人工草坪、网格草地、重复编织纹理。
7. 每个场景图提示词必须有明确空间任务和构图策略：入口/过渡/阻碍/转折/开阔收束之一；写清引导线、中景空白区、远景地标、童话地标物、极轻透明空气感和冷暖光变化。
8. 治愈童话场景优先采用“童话地标物 + 柔软自然地表舞台 + 前景叶片/花草包围 + 可读森林纵深 + 少量透明空气感 + 暖光斑”的构成；不要把雾气浓淡作为主要递进手段，不要使用浓雾、厚雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、惊悚、悬疑、写真摄影感。
9. 先提炼一套全片场景世界观基线，并让 @图片10-49 都继承同一套色温逻辑、光线语言、材质语言、地面质感、植物/地标形状词、空气感和3D动画电影渲染风格；每场只改变空间任务、地标物、构图和局部光源状态。
10. 场景图生图提示词不设字数上限，不要为了缩短而删掉空间布局、分格策略、前中后景、材质细节、光线状态、色彩逻辑、空气感、连续性锚点或负面约束；越详细越好，必须能直接提交图片 API。`
        ].filter(Boolean).join("\n\n---\n\n");
      }

      // 🌟 导演意图前置注入：仅在剧本阶段，将用户的主观感受描述前置到输入最前面
      if (directorIntent.trim() && stageId === "script") {
        finalInput = `【导演意图】\n${directorIntent.trim()}\n\n---\n\n${finalInput}`;
      }

      // 基础请求体
      const reqBody = {
        stage: stageId,
        input: finalInput,
        session_id: "session_" + stageId,
        system_prompt: sysPrompt, // 🌟 修改这里：使用组装后的 sysPrompt
        ip_names: selectedIPs,
        run_id: currentRunId,
        routes: getEffectiveRoutes(stageId)
      };

      if (stageId === "visual") {
        reqBody.art_director_profile = artProfile;
      }
      if (stageId === "shot") {
        reqBody.cinematographer_profile = cineProfile;
      }

      // 🛡️ Bug 7 修复：仅在分镜 (shot) 阶段附加特有字段
      if (stageId === "shot") {
        reqBody.execution_mode = executionMode;
        reqBody.segments = []; // 正常生成时传空，自动切片由 executeChunk 管理
      }

      const res = await fetch(`${API_BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: abortControllerRef.current.signal,
      });

      if (!res.ok) throw new Error("HTTP 错误: " + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let currentText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (abortControllerRef.current?.signal.aborted) break;
        currentText += decoder.decode(value, { stream: true });
        setOutputs(prev => { const next = [...prev]; next[stage] = currentText; return next; });
      }

      await persistOutput(stageId, currentText, currentRunId);

      // 全量出片模式完成：清除残留的分段状态，防止进度条卡顿
      if (executionMode === 'batch' && stageId === 'shot') {
        setShowChunkModal(false);
        setChunkQueue([]);
        setChunkSceneCards([]);
        setChunkIndex(0);
      }
    } catch (e) {
      if (e.name === "AbortError") {
        setOutputs(prev => {
          const next = [...prev];
          const isTimeout = timeoutTriggeredRef.current;
          const errMsg = isTimeout && !prev[stage]
            ? "\n\n> 请求超时（300秒），请检查网络或后端日志。"
            : "";
          if (errMsg) next[stage] = prev[stage] + errMsg;
          return next;
        });
      } else {
        setOutputs(prev => {
          const next = [...prev];
          next[stage] = (prev[stage] || "") + "\n\n> 错误：" + e.message;
          return next;
        });
      }
    } finally {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setLoading(false);
    }
  };

  // 1. 启动自动切片流程
  const startChunkProcess = async () => {
    const text = inputs[2]; // 仅在分镜提示词阶段(stage 2)生效
    if (!text.trim()) return alert("请先粘贴固定要素库包！");

    const sceneChunks = extractSceneChunks(text);
    if (sceneChunks.length === 0) {
      return alert("没有检测到标准格式的场景卡：### 场景卡 · | S1 | 场景名。请确保粘贴的是阶段二固定要素库包。");
    }

    const hasReviewConstraint = Boolean(buildChunkReviewConstraint());
    if (hasReviewConstraint) {
      console.log("逐段生成将注入当前分镜会审修正约束。");
    }

    const queue = sceneChunks.map(chunk => [chunk.sceneId]);

    setChunkQueue(queue);
    setChunkSceneCards(sceneChunks);
    setChunkIndex(0);
    setCompletedChunkIndex(-1);
    setShowChunkModal(false);
    setOutputs(prev => { const next = [...prev]; next[2] = ""; return next; });
    try {
      await fetch(`${API_BASE}/clear_memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "session_shot" }),
      });
    } catch (error) {
      console.warn("清理分镜会话记忆失败，将继续执行切片", error);
    }

    // 启动第一刀
    await executeChunk(queue, 0, text, sceneChunks);
  };

  // 2. 执行每一刀切片
  const executeChunk = async (queue, index, fullInput, sceneChunksOverride = null) => {
    setShowChunkModal(false);
    if (!queue[index]) {
      setLoading(false);
      setShowChunkModal(false);
      return;
    }
    setChunkIndex(index);
    const currentSceneIds = queue[index];
    const targetScenes = currentSceneIds.join(" 和 ");
    const activeSceneChunks = sceneChunksOverride?.length
      ? sceneChunksOverride
      : (chunkSceneCards.length ? chunkSceneCards : extractSceneChunks(fullInput));
    const targetSceneCards = activeSceneChunks.filter(chunk => currentSceneIds.includes(chunk.sceneId));
    const targetSceneContent = targetSceneCards.map(chunk => chunk.content).join("\n\n---\n\n");
    const visualGlobalContext = extractVisualGlobalContext(fullInput || "");

    // 🌟 修复问题 1：注入风格补丁 (Active Preset)
    const activePreset = STYLE_PRESETS[styleMode];
    let chunkSysPrompt = config.prompts.shot;
    if (activePreset && activePreset.shot_patch) {
      chunkSysPrompt += "\n\n" + activePreset.shot_patch;
    }
    if (index === queue.length - 1) {
      chunkSysPrompt = withEndMarkerInstruction(chunkSysPrompt);
    } else {
      chunkSysPrompt += "\n\n【切片输出说明】本次只是分段生成中的中间切片，绝对不要在本段末尾输出 end。";
    }

    // 🌟 修复致命 Bug：无论第几段，始终携带全量剧本，用自然语言限制其只生成 targetScenes
    const prevOutput = index > 0 ? stripCompletionEndMarker(outputs[2] || "") : "";
    // 扩大截取范围，确保能包含上一段结尾的完整单元
    const lastContext = index > 0 ? prevOutput.slice(-800).trim() : "";

    // 🌟 动态提取上一段的最后一个生成单元编号
    let lastUnitStr = "";
    if (index > 0) {
      const matches = [...prevOutput.matchAll(/生成单元\s+(S\d+-U\d+)/g)];
      if (matches.length > 0) {
        lastUnitStr = matches[matches.length - 1][1];
      }
    }

    // 🌟 注入剧本全文（阶段一产出），确保 AI 不会丢失叙事上下文
    const script = stripCompletionEndMarker(outputs[0] || "");
    let prompt = `【自动化分段执行指令·场景物理隔离版】
为了保证镜头密度和防止算力截断，我们采用逐场景分段推演。你现在只拥有处理下列场景的权限。

【当前授权处理的场景】
场景编号：${targetScenes}

【该场景的完整场景卡（只读，不可修改）】
<scene_card>
${targetSceneContent || "未找到对应场景卡，请只根据当前授权场景编号生成，禁止展开其他场景。"}
</scene_card>

【全局角色与视觉规则参考（不含其他场景卡正文）】
<visual_global_context>
${visualGlobalContext || "（无）"}
</visual_global_context>

【硬性规则】
1. 只生成 ${targetScenes} 的分镜内容。禁止输出、预告、续写或展开任何未授权场景。
2. 输出一个场景段即可：可以包含“## | Sx | 场景名”和该场景下的“### 生成单元 Sx-U1”等内容；不要输出总体导演策略、目录、全局总览、全片参考图策略或跨场景提交顺序表。
3. 生成单元编号必须使用当前授权场景前缀，例如 ${targetScenes}-U1、${targetScenes}-U2。每个新场景从 U1 开始，不要沿用上一场的 U 编号，也不要把上一场写成 ${targetScenes} 的内容。
4. 如果场景卡或剧本中提到其他场景，只写当前场景的承接接口，不要展开其他场景的镜头。
5. 当前场景必须覆盖剧本中该场的目标、阻力、角色选择和可见结果；不要只写移动、凝视、对峙、站立、怒吼、转身离开等姿态镜头。
6. 你的输出会被前端直接拼接到已有分镜文档后面，请避免重复已有内容。`;

    if (script) {
      prompt += "\n\n【完整剧本文档（叙事参考，只用于理解当前场景的前因后果）】\n" + script;
    }

    const reviewConstraint = buildChunkReviewConstraint();
    if (reviewConstraint) {
      prompt += "\n\n【分镜会审修正约束】\n以下是本阶段会审后提炼出的关键修正方向。请在本次只生成 " + targetScenes + " 的前提下贯彻这些约束；不要复述会审报告，不要输出解释。\n<会审修正约束>\n" + reviewConstraint + "\n</会审修正约束>";
    }

    if (index > 0) {
      prompt += "\n\n【物理接戏锚点】：上一段分镜的结尾状态如下，请确保本段的首镜头完美承接其物理位置与因果关系：\n<上一段结尾参考>\n..." + lastContext + "\n</上一段结尾参考>";

      // 🌟 强制注入编号顺延指令
      if (lastUnitStr) {
        prompt += "\n\n【上一段编号参考】：上一段最后一个生成单元是「" + lastUnitStr + "」。这只用于物理承接，不用于本场编号续写；当前场景仍必须使用 " + targetScenes + "-U1、" + targetScenes + "-U2 这样的当前场景编号。";
      } else {
        prompt += "\n\n【当前场景编号规则】：本次输出只允许使用 " + targetScenes + "-U1、" + targetScenes + "-U2 这样的当前场景编号。";
      }
    }

    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId();
    setRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);

    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "shot",
          input: prompt,
          session_id: "session_shot",
          system_prompt: chunkSysPrompt, // 🌟 真正应用补丁
          ip_names: selectedIPs,
          run_id: currentRunId,
          routes: getEffectiveRoutes("shot"),
          cinematographer_profile: cineProfile,
          execution_mode: "default", // 明确告诉后端这是普通单次执行
          segments: []
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!res.ok) throw new Error("HTTP 错误: " + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");

      let appendedText = "";
      let baseOutputCaptured = false;
      const initialBaseText = index === 0 ? "" : (outputs[2] || "");
      let baseText = initialBaseText; // 用来动态锁定屏幕上的已有文本
      let latestCleanText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (abortControllerRef.current?.signal.aborted) break;
        appendedText += decoder.decode(value, { stream: true });

        let cleanText = sanitizeChunkOutput(appendedText, currentSceneIds);
        if (index > 0) {
            // 核心魔法：后台自动剔除后续切片的表头和代码块标记
            cleanText = cleanText.replace(/```markdown\n?/g, "").replace(/```\n?/g, "");
            cleanText = cleanText.replace(/^\|.*镜头编号.*\|\n/m, "");
            cleanText = cleanText.replace(/^\|[\s:|-]+\|\n/m, "");
            cleanText = cleanText.replace(/^\s+/, "");
        }
        latestCleanText = cleanText;

        setOutputs(prev => {
          const next = [...prev];
          if (!baseOutputCaptured) {
            // 第一刀清空底板；后续追加时，静态锁定屏幕当前的已有文本
            baseText = index === 0 ? "" : prev[2];
            baseOutputCaptured = true;
          }
          const spacer = index > 0 && cleanText.length > 0 ? "\n" : "";
          next[2] = baseText + spacer + cleanText;
          return next;
        });
      }

      const stableBaseText = baseText || initialBaseText;
      const assembledText = index === 0
        ? latestCleanText
        : stableBaseText + (latestCleanText.length > 0 ? "\n" : "") + latestCleanText;
      await persistOutput("shot", assembledText, currentRunId);

      // 生成完毕后，判断是否还有下一块肉要切
      setCompletedChunkIndex(index);
      if (index < queue.length - 1) {
        setShowChunkModal(true);
      } else {
        setShowChunkModal(false);
        setChunkQueue([]);
        setChunkSceneCards([]);
        setChunkIndex(0);
        setCompletedChunkIndex(-1);
        setTimeout(() => alert("🎉 所有场景已全部分段推演完毕，并且已为您无缝拼接成一份完整文档！"), 500);
      }

    } catch (e) {
      if (e.name !== "AbortError") {
        setOutputs(prev => { const next = [...prev]; next[2] = prev[2] + "\n\n> 切片生成错误：" + e.message; return next; });
      }
      // 出错时允许重试当前段；弹窗内会按是否存在下一组来显示继续按钮。
      setCompletedChunkIndex(index);
      if (index < queue.length) setShowChunkModal(true);
    } finally {
      setLoading(false);
    }
  };

  const handleContinue = async () => {
    if (!outputs[stage]) return;
    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutTriggeredRef.current = false;
    timeoutRef.current = setTimeout(() => {
      timeoutTriggeredRef.current = true;
      if (abortControllerRef.current) abortControllerRef.current.abort();
    }, 300000);

    setLoading(true);
    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId();
    setRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);
    const cleanText = stripCompletionEndMarker(outputs[stage]
      .replace(/\n\n\n?> 请求超时[\s\S]*$/, '')
      .replace(/\n\n\n?> 错误：[\s\S]*$/, '')
      .replace(/\n\n\n?> \[异常\][\s\S]*$/, '')
      .replace(/\n\n\n?> 接续错误：[\s\S]*$/, '')
      .replace(/\u200b/g, ''));
    const baseText = cleanText;
    // 提取尾部800字作为断点续写的上下文锚点，防止模型"接不上前面的内容"
    const tailContext = baseText.length > 800 ? baseText.slice(-800) : baseText;

    try {
      const stageId = STAGES[stage].id;
      const continueInstruction = `【系统最高防断裂指令】你刚才的输出因为Token长度限制被物理截断了！请你直接、无缝地接着上一个字符继续输出！绝对不要包含任何前言后语，绝对不要使用Markdown代码块格式包裹，直接输出刚才断掉的后续文本或代码，拼上去必须完全合法！

【断点锚点——以下是已生成内容的结尾片段，仅供定位用，绝对禁止重复生成】：
\`\`\`
...${tailContext}
\`\`\``;

      const activePreset = STYLE_PRESETS[styleMode];
      let sysPrompt = config.prompts[stageId];

      if (activePreset.script_patch && stageId === "script") {
        sysPrompt += "\n\n" + activePreset.script_patch;
      }
      if (activePreset.visual_patch && stageId === "visual") {
        sysPrompt += "\n\n" + activePreset.visual_patch;
      }
      if (activePreset.shot_patch && stageId === "shot") {
        sysPrompt += "\n\n" + activePreset.shot_patch;
      }
      if (stageId === "visual" || stageId === "image") {
        sysPrompt += "\n\n" + getScenePromptModeInstruction(
          sceneImagePromptMode,
          stageId === "image" ? "imageList" : "sceneCard"
        );
      }
      sysPrompt = withEndMarkerInstruction(sysPrompt);

      const continueBody = {
        stage: stageId,
        input: continueInstruction,
        session_id: "session_" + stageId,
        system_prompt: sysPrompt,
        ip_names: selectedIPs,
        run_id: currentRunId,
        routes: getEffectiveRoutes(stageId)
      };
      if (stageId === "visual") {
        continueBody.art_director_profile = artProfile;
      }
      if (stageId === "shot") {
        continueBody.cinematographer_profile = cineProfile;
      }

      const res = await fetch(`${API_BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(continueBody),
        signal: abortControllerRef.current.signal,
      });

      if (!res.ok) throw new Error("HTTP 错误: " + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let appendedText = "";
      let finalText = baseText;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (abortControllerRef.current?.signal.aborted) break;
        appendedText += decoder.decode(value, { stream: true });
        finalText = baseText + appendedText;
        setOutputs(prev => { const next = [...prev]; next[stage] = finalText; return next; });
      }
      finalText = baseText + appendedText;
      setOutputs(prev => { const next = [...prev]; next[stage] = finalText; return next; });
      await persistOutput(stageId, finalText, currentRunId);
    } catch (e) {
      if (e.name !== "AbortError") {
         setOutputs(prev => { const next = [...prev]; next[stage] = prev[stage] + "\n\n> 接续错误：" + e.message; return next; });
      }
    } finally {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setLoading(false);
    }
  };

  const handleClearMemory = async () => {
    if(window.confirm("确定要清空本阶段AI记忆吗？")) {
      try {
        await fetch(`${API_BASE}/clear_memory`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "session_" + STAGES[stage].id })
        });
        setOutputs(prev => { const next = [...prev]; next[stage] = ""; return next; });
        alert("记忆已清空！");
      } catch(error) {
        console.error("清空记忆失败", error);
        alert("清空失败");
      }
    }
  };

  const handleWashText = async () => {
    if (!rawAnalysisText.trim()) return alert("请先粘贴视频分析或大白话内容！");
    if (!hasEffectiveRouteKey("shot")) return alert("请先在系统设置的 [3. 分镜提示词] 选项卡中配置 API Key！");

    // 强制引导：如果用户选了JSON模式但文字过多，提出拦截警告
    if (radarMode === "json" && rawAnalysisText.length > 2000) {
      if (!confirm("⚠️ JSON 截断警告\n\n当前文本过长，提取 JSON 极易触发大模型物理截断！\n建议：每次仅粘贴 3-5 个镜头的描述进行提取。\n\n是否仍然强行继续？")) {
        return;
      }
    }

    setWashing(true);
    setWashResult("");
    setWashJson("");

    // 魔法补丁：告诉后端用第3步的 Key 当作提炼引擎的 Key 用
    const effectiveRoutes = getEffectiveRoutes("shot");
    const patchedRoutes = { ...effectiveRoutes, jimeng: effectiveRoutes.shot };

    try {
      if (radarMode === "json") {
        setWashResult("正在启动 JSON 范例提取引擎...\n请稍候，正在将自然语言精确映射为 5 字段场景空镜 JSON 结构...");
        const res = await fetch(`${API_BASE}/extract_json_example`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ raw_text: rawAnalysisText, ip_name: "core", routes: patchedRoutes }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "JSON 提取失败");
        setWashJson(JSON.stringify(data.json_content, null, 2));
        setWashResult("【JSON 范例库】更新完成\n\n" + data.message);

      } else if (radarMode === "core") {
        setWashResult("正在启动通用法则蒸馏引擎...\n\n[轨1]: 提炼视觉执行法则\n[轨2]: 建立美学档案\n[轨3]: 梳理叙事节拍\n\n请稍候，法则即将注入 core 目录...");
        const res = await fetch(`${API_BASE}/distill_knowledge`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ raw_text: rawAnalysisText, ip_name: "core", routes: patchedRoutes }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "法则提炼失败");
        setWashResult(`【通用核心库】更新完成！\n\n### 视觉执行法则\n${data.tracks.visual}\n\n### 视觉美学锚定\n${data.tracks.aesthetic}\n\n### 叙事结构法则\n${data.tracks.narrative}`);

      } else {
        if (!newIpName.trim()) throw new Error("请输入要提取的IP宇宙名称！");
        setWashResult("正在启动IP角色圣经提取引擎...\n\n目标宇宙：[" + newIpName + "]\n\n正在并行执行 V3.0 三轮深层提炼...\n由于需进行4次深度推理，耗时可能较长，请耐心等待！");
        const res = await fetch(`${API_BASE}/extract_ip_bible`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ raw_text: rawAnalysisText, ip_name: newIpName, routes: patchedRoutes }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "IP提取失败");
        setWashResult("【专属IP库】资产建立完成！\n\n" + data.message + "\n\n### 提取出的完整IP圣经 V3.0：\n" + data.bible_content);
        if (!availableIPs.includes(newIpName)) setAvailableIPs(prev => [...prev, newIpName]);
      }
    } catch (e) {
      setWashResult("**处理出错**：" + e.message);
    } finally {
      setRawAnalysisText("");
      setWashing(false);
    }
  };

  const cur = STAGES[stage];
  const reviewLabels = getReviewLabels();
  const canShowReferenceAssetGeneration = stage === 1 || stage === 3;
  const sceneAssetMap = canShowReferenceAssetGeneration
    ? mergeSceneAssetPrompts(
      { preferEnglish: sceneImagePromptMode === "mj" },
      outputs[1],
      inputs[2],
      outputs[3],
      inputs[3]
    )
    : {};
  const characterAssetMap = canShowReferenceAssetGeneration
    ? mergeCharacterAssetPrompts(
      outputs[1],
      inputs[2],
      outputs[3],
      inputs[3]
    )
    : {};
  const characterAssetList = Object.values(characterAssetMap).sort((a, b) => a.id - b.id);
  const sceneAssetList = Object.values(sceneAssetMap).sort((a, b) => a.id - b.id);
  const neededAssetIds = canShowReferenceAssetGeneration
    ? [...new Set([
      ...characterAssetList.map(character => character.id),
      ...sceneAssetList.map(scene => scene.id),
    ])].sort((a, b) => a - b)
    : [];
  const projectRunById = Object.fromEntries(projectRuns.map(item => [item.run_id, item]));
  const selectedProjectRun = projectRunById[selectedProjectRunId];
  const selectedProjectIsUnsaved = Boolean(selectedProjectRunId && !selectedProjectRun);
  const formatProjectRunLabel = (item) => {
    if (!item) return "选择项目目录";
    const stageTags = (item.stages || []).map(stageId => {
      const stageInfo = STAGES.find(s => s.id === stageId);
      return stageInfo ? stageInfo.label.replace(/^[一二三四]·/, "") : stageId;
    }).join("/");
    const created = item.created_at || item.updated_at
      ? new Date(item.created_at || item.updated_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "未知时间";
    return `${item.run_id} · 创建 ${created}${stageTags ? ` · ${stageTags}` : ""}`;
  };
  const renderPackDeliveryToggle = (accentColor) => (
    <div style={{display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.24)', border: '1px solid ' + BORDER, borderRadius: '6px', padding: '3px'}}>
      {[
        { id: "file", label: "md短指令" },
        { id: "clipboard", label: "复制全文" },
      ].map(option => {
        const active = packDeliveryMode === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => setPackDeliveryMode(option.id)}
            style={{
              border: '0',
              borderRadius: '4px',
              padding: '4px 8px',
              cursor: 'pointer',
              fontSize: '11px',
              color: active ? '#020617' : TEXT,
              background: active ? accentColor : 'transparent',
              fontWeight: active ? 800 : 600,
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div style={styles.root}>
      <div style={styles.grain} />

      <header style={styles.header}>
        <div style={styles.headerInner}>
          <span style={styles.logo}>◈</span>
          <div>
            <div style={styles.title}>MICRO EPIC WORKFLOW</div>
            <div style={styles.titleSub}>IP分层架构 · 导演工作台</div>
          </div>
        </div>
        <div style={{display: 'flex', gap: '15px', alignItems: 'center'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.05)', padding: '4px 12px', borderRadius: '4px', border: "1px solid " + BORDER, flexWrap: 'wrap', maxWidth: '600px'}}>
            <div style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
              <span style={{fontSize: '12px', color: MUTED}}>多选挂载:</span>
              <button
                onClick={fetchIPs}
                disabled={isFetchingIPs}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: AMBER, fontSize: '12px', padding: '0 4px',
                  opacity: isFetchingIPs ? 0.5 : 1
                }}
                title="重新拉取后台IP资产"
              >
                {isFetchingIPs ? "↻..." : "↻"}
              </button>
            </div>
            {availableIPs.map(ip => (
              <button 
                key={ip}
                onClick={() => setSelectedIPs(prev => prev.includes(ip) ? prev.filter(x => x !== ip) : [...prev, ip])}
                style={{
                  background: selectedIPs.includes(ip) ? AMBER : "transparent",
                  color: selectedIPs.includes(ip) ? "#000" : MUTED,
                  border: "1px solid " + (selectedIPs.includes(ip) ? AMBER : BORDER),
                  padding: '2px 8px', borderRadius: '4px', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold'
                }}
              >
                {selectedIPs.includes(ip) ? "✓ " : "+"}{ip}
              </button>
            ))}
            {availableIPs.length === 0 && <span style={{fontSize: '12px', color: MUTED}}>暂无专属IP资产</span>}
            {selectedIPs.length === 0 && <span style={{fontSize: '12px', color: AMBER, marginLeft: '4px'}}>仅通用法则</span>}
          </div>
          
          <button onClick={() => setShowRadar(true)} style={{...styles.settingsBtn, borderColor: '#E8A020', color: '#E8A020'}}>
            结构化洗稿雷达
          </button>
          <button onClick={() => { setShowAssetLibrary(true); fetchImageAssets(); }} style={{...styles.settingsBtn, borderColor: '#4ade80', color: '#4ade80'}}>
            参考图资产
          </button>
          <div style={styles.projectPicker}>
            <span style={styles.projectPickerLabel}>项目目录</span>
            <select
              value={selectedProjectRunId}
              onChange={(e) => setSelectedProjectRunId(e.target.value)}
              disabled={projectLoading || projectRunsLoading}
              title={selectedProjectRun ? formatProjectRunLabel(selectedProjectRun) : (selectedProjectRunId ? `${selectedProjectRunId} · 新项目（尚未保存）` : "选择要载入的项目目录")}
              style={styles.projectSelect}
            >
              {projectRuns.length === 0 && <option value="">暂无项目目录</option>}
              {selectedProjectIsUnsaved && (
                <option value={selectedProjectRunId}>
                  {selectedProjectRunId} · 新项目（尚未保存）
                </option>
              )}
              {projectRuns.map(item => (
                <option key={item.run_id} value={item.run_id}>
                  {formatProjectRunLabel(item)}
                </option>
              ))}
            </select>
            <button
              onClick={() => fetchProjectRuns(selectedProjectRunId || runId)}
              disabled={projectRunsLoading}
              title="刷新项目目录列表"
              style={{...styles.projectRefreshBtn, opacity: projectRunsLoading ? 0.6 : 1}}
            >
              {projectRunsLoading ? "↻..." : "↻"}
            </button>
            <button
              onClick={() => loadPipelineRun(selectedProjectRunId)}
              disabled={projectLoading || projectRunsLoading || projectRuns.length === 0 || selectedProjectIsUnsaved}
              title={selectedProjectIsUnsaved ? "当前新项目还没有保存内容，生成或导入任一阶段后会创建项目目录" : "载入选中的已保存项目"}
              style={{...styles.settingsBtn, borderColor: '#86efac', color: '#86efac', opacity: (projectLoading || projectRunsLoading || projectRuns.length === 0 || selectedProjectIsUnsaved) ? 0.6 : 1}}
            >
              {projectLoading ? "载入中..." : "载入项目"}
            </button>
            <button
              onClick={handleCreateNewProject}
              disabled={projectLoading}
              title="创建一个空白工作台并切换到新的项目目录；不会删除旧项目"
              style={{...styles.settingsBtn, borderColor: '#93c5fd', color: '#93c5fd', opacity: projectLoading ? 0.6 : 1}}
            >
              新建项目
            </button>
          </div>
          <button onClick={() => setShowSettings(true)} style={styles.settingsBtn}>系统设置</button>
        </div>
      </header>

      {projectLoadError && (
        <div style={styles.projectLoadError}>{projectLoadError}</div>
      )}

      <div style={{
        padding: '10px 32px', background: 'rgba(255,255,255,0.02)',
        borderBottom: '1px solid ' + BORDER, display: 'flex', gap: '15px', alignItems: 'center', flexWrap: 'wrap'
      }}>
        <span style={{fontSize: '12px', color: MUTED, fontWeight: 'bold'}}>当前美学预设:</span>
        {Object.entries(STYLE_PRESETS).map(([key, preset]) => (
          <button
            key={key}
            onClick={() => setStyleMode(key)}
            style={{
              padding: '6px 16px', borderRadius: '20px', fontSize: '12px', cursor: 'pointer',
              border: '1px solid ' + (styleMode === key ? preset.color : BORDER),
              background: styleMode === key ? `${preset.color}20` : 'transparent',
              color: styleMode === key ? preset.color : MUTED,
              fontWeight: 'bold', transition: 'all 0.3s'
            }}
          >
            {preset.name}
          </button>
        ))}
        <div style={{height: '24px', width: '1px', background: BORDER}} />
        <label style={{display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: MUTED, fontWeight: 'bold'}}>
          导演风格
          <select value={directorProfile} onChange={e => setDirectorProfile(e.target.value)} style={{background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '6px 10px', borderRadius: '6px', fontSize: '12px'}}>
            {DIRECTOR_PROFILE_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label style={{display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: MUTED, fontWeight: 'bold'}}>
          美术
          <select value={artProfile} onChange={e => setArtProfile(e.target.value)} style={{background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '6px 10px', borderRadius: '6px', fontSize: '12px'}}>
            {ART_PROFILE_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label style={{display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: MUTED, fontWeight: 'bold'}}>
          摄影
          <select value={cineProfile} onChange={e => setCineProfile(e.target.value)} style={{background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '6px 10px', borderRadius: '6px', fontSize: '12px'}}>
            {CINE_PROFILE_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <nav style={styles.nav}>
        {STAGES.map((s, i) => (
          <button
            key={s.id}
            onClick={() => {
              if (loading || scriptRewriteLoading || scriptAppealLoading) return;
              setStage(i);
            }}
            disabled={loading || scriptRewriteLoading || scriptAppealLoading}
            style={{
              ...styles.navBtn,
              ...(stage === i ? styles.navBtnActive : {}),
              ...(loading || scriptRewriteLoading || scriptAppealLoading ? styles.btnDisabled : {})
            }}
          >
            <span style={styles.navIcon}>{s.icon}</span><div style={styles.navLabel}><span style={styles.navStep}>0{i + 1}</span>{s.label}</div>
          </button>
        ))}
      </nav>

      <main style={styles.main}>
        <section style={styles.panel}>
          <div style={styles.panelHeader}><div style={styles.panelTitle}>{cur.label}阶段</div></div>

          {/* 🌟 导演意图前置层：仅在剧本阶段显示 */}
          {stage === 0 && (
            <div style={{ marginBottom: '12px' }}>
              <button
                onClick={() => setShowDirectorIntent(!showDirectorIntent)}
                style={{
                  background: 'none', border: 'none', color: AMBER, fontSize: '13px',
                  cursor: 'pointer', padding: '0', display: 'flex', alignItems: 'center', gap: '6px'
                }}
              >
                <span>{showDirectorIntent ? '▼' : '▶'}</span>
                <span>导演意图（可选）— 描述你真正想要的那种感觉</span>
              </button>
              {showDirectorIntent && (
                <textarea
                  style={{
                    ...styles.textarea,
                    minHeight: '80px',
                    marginTop: '8px',
                    flex: 'none',
                    borderColor: 'rgba(232,160,32,0.4)',
                    boxShadow: 'inset 0 0 0 1px rgba(232,160,32,0.1)'
                  }}
                  value={directorIntent}
                  onChange={(e) => setDirectorIntent(e.target.value)}
                  placeholder={`描述你真正想要的那种感觉，不用技术词汇。\n比如："我想要那种在老家屋檐下躲雨的下午，时间像停住了的感觉"\n比如："宫崎骏《龙猫》开头10分钟那种——一切都是第一次，每件小事都值得郑重对待"\n比如："一个很小的生命独自面对很大的世界，但它不害怕，只是很好奇"`}
                />
              )}
            </div>
          )}

          {/* 阶段一：故事灵感生成器 */}
          {stage === 0 && (
            <div style={styles.inspirationBox}>
              <div style={styles.inspirationHeader}>
                <div>
                  <div style={styles.inspirationTitle}>灵感生成器</div>
                  <div style={styles.inspirationSub}>使用“剧本生成”同一套API模型；可先写一点限制，也可以留空。点击灵感会填入下方用户要求。</div>
                </div>
                <button
                  onClick={handleGenerateInspirations}
                  disabled={inspirationLoading || loading}
                  style={{...styles.btnGhost, padding: '9px 14px', ...(inspirationLoading || loading ? styles.btnDisabled : {})}}
                >
                  {inspirationLoading ? "生成中..." : "生成5个灵感"}
                </button>
              </div>

              {inspirationError && (
                <div style={styles.inspirationError}>{inspirationError}</div>
              )}

              {inspirationIdeas.length > 0 && (
                <div style={styles.inspirationList}>
                  {inspirationIdeas.map((idea, idx) => (
                    <button
                      key={`${idea.id || idx}-${idea.title || idx}`}
                      onClick={() => applyInspiration(idea)}
                      style={styles.inspirationItem}
                    >
                      <div style={styles.inspirationItemTop}>
                        <span style={styles.inspirationIndex}>{idea.id || idx + 1}</span>
                        <span style={styles.inspirationItemTitle}>{idea.title || "未命名灵感"}</span>
                      </div>
                      {Number.isFinite(Number(idea.overall_score)) && (
                        <div style={styles.scoreRow}>
                          <span style={styles.scoreBadge}>综合 {idea.overall_score}/10</span>
                          {Number.isFinite(Number(idea.hook_score)) && <span style={styles.scoreTiny}>钩子 {idea.hook_score}</span>}
                          {Number.isFinite(Number(idea.visual_score)) && <span style={styles.scoreTiny}>视觉 {idea.visual_score}</span>}
                          {Number.isFinite(Number(idea.ai_feasibility_score)) && <span style={styles.scoreTiny}>生成 {idea.ai_feasibility_score}</span>}
                          {idea.story_engine && <span style={styles.scoreTiny}>{idea.story_engine}</span>}
                        </div>
                      )}
                      {idea.spark && <div style={styles.inspirationSpark}>{idea.spark}</div>}
                      <div style={styles.inspirationLogline}>{idea.logline || idea.story_input || ""}</div>
                      {idea.visual_hook && <div style={styles.inspirationHook}>{idea.visual_hook}</div>}
                      {idea.conflict && <div style={styles.inspirationMeta}>冲突：{idea.conflict}</div>}
                      {idea.emotional_turn && <div style={styles.inspirationMeta}>转折：{idea.emotional_turn}</div>}
                      {idea.best_for && <div style={styles.inspirationMeta}>{idea.best_for}</div>}
                      {idea.risk && <div style={styles.inspirationRisk}>风险：{idea.risk}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {stage === 0 && WORKFLOW_TEMPLATES.length > 0 && (
            <div style={styles.templateGallery}>
              <div style={styles.inspirationHeader}>
                <div>
                  <div style={styles.inspirationTitle}>经典制片工作流模板</div>
                  <div style={styles.inspirationSub}>一键载入结构化案例，把四层控制模型直接展开为四个阶段的可编辑产出。</div>
                </div>
              </div>
              <div style={styles.templateList}>
                {WORKFLOW_TEMPLATES.map(template => {
                  const totalDuration = getWorkflowTemplateDuration(template);
                  const unitCount = getWorkflowTemplateUnitCount(template);
                  const unitLabel = template.workflowType === "dual_track_video_pipeline" ? "关键节拍" : "镜头";
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => applyWorkflowTemplate(template)}
                      disabled={loading || scriptRewriteLoading}
                      style={{
                        ...styles.templateCard,
                        ...(loading || scriptRewriteLoading ? styles.btnDisabled : {})
                      }}
                    >
                      <div style={styles.templateCardTop}>
                        <span style={styles.templateEyebrow}>{template.aspectRatio || "16:9"} · {unitCount} {unitLabel} · 约 {totalDuration}s</span>
                        <span style={styles.templateAction}>导入工作流</span>
                      </div>
                      <div style={styles.templateTitle}>{template.title}</div>
                      <div style={styles.templateDesc}>{template.description}</div>
                      <div style={styles.templateLayerRow}>
                        {(template.layers || []).slice(0, 4).map(layer => (
                          <span key={layer.name} style={styles.templateLayerChip}>{layer.label}</span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 阶段二/四：场景卡与空场景图生图提示词语言/平台 */}
          {(stage === 1 || stage === 3) && (
            <div style={{ marginBottom: '15px' }}>
              <div style={{ fontSize: '12px', color: MUTED, marginBottom: '8px' }}>
                场景图 prompt 模式：影响阶段二场景卡和阶段四场景图生图清单
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setSceneImagePromptMode('jimeng')}
                style={{
                  flex: 1, padding: '12px', borderRadius: '8px',
                  border: sceneImagePromptMode === 'jimeng' ? `2px solid ${AMBER}` : `1px solid ${BORDER}`,
                  background: sceneImagePromptMode === 'jimeng' ? 'rgba(232,160,32,0.2)' : 'transparent',
                  color: TEXT, cursor: 'pointer', fontSize: '13px'
                }}
              >
                即梦中文场景图
              </button>
              <button
                onClick={() => setSceneImagePromptMode('mj')}
                style={{
                  flex: 1, padding: '12px', borderRadius: '8px',
                  border: sceneImagePromptMode === 'mj' ? `2px solid ${AMBER}` : `1px solid ${BORDER}`,
                  background: sceneImagePromptMode === 'mj' ? 'rgba(232,160,32,0.2)' : 'transparent',
                  color: TEXT, cursor: 'pointer', fontSize: '13px'
                }}
              >
                MJ英文场景图
              </button>
              </div>
            </div>
          )}

          <textarea style={styles.textarea} value={inputs[stage]} onChange={(e) => { const next = [...inputs]; next[stage] = e.target.value; setInputs(next); }} placeholder={cur.placeholder} />

          {/* 🌟 分镜阶段：全量出片 vs 逐段确认 模式切换 */}
          {stage === 2 && (
            <div style={{ marginBottom: '15px', display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setExecutionMode('batch')}
                style={{
                  flex: 1, padding: '12px', borderRadius: '8px',
                  border: executionMode === 'batch' ? `2px solid ${AMBER}` : `1px solid ${BORDER}`,
                  background: executionMode === 'batch' ? 'rgba(232,160,32,0.2)' : 'transparent',
                  color: TEXT, cursor: 'pointer', fontSize: '13px'
                }}
              >
                🚀 全量出片
              </button>
              <button
                onClick={() => setExecutionMode('sequential')}
                style={{
                  flex: 1, padding: '12px', borderRadius: '8px',
                  border: executionMode === 'sequential' ? `2px solid ${AMBER}` : `1px solid ${BORDER}`,
                  background: executionMode === 'sequential' ? 'rgba(232,160,32,0.2)' : 'transparent',
                  color: TEXT, cursor: 'pointer', fontSize: '13px'
                }}
              >
                📑 逐段确认 (Claude 模式)
              </button>
            </div>
          )}

          <div style={{display: 'flex', gap: '10px'}}>
            {stage === 2 && executionMode === 'sequential' ? (
              <button onClick={startChunkProcess} disabled={loading || !inputs[2].trim()} style={{...styles.btn, flex: 1, background: "#4ade80", color: "#000", ...(loading || !inputs[2].trim() ? styles.btnDisabled : {})}}>
                {loading ? "引擎运转中..." : "⚔️ 自动化切片推演 (防截断)"}
              </button>
            ) : (
              <button onClick={() => handleGenerate()} disabled={loading || !inputs[stage].trim()} style={{...styles.btn, flex: 1, ...(loading || !inputs[stage].trim() ? styles.btnDisabled : {})}}>
                {loading ? "引擎运转中..." : cur.action}
              </button>
            )}
            <button onClick={handleClearMemory} style={{...styles.btnGhost, padding: '0 15px'}}>清空记忆</button>
          </div>

          {stage === 0 && (
            <div style={{
              marginTop: '12px',
              padding: '12px',
              border: '1px solid rgba(232,160,32,0.28)',
              background: 'rgba(232,160,32,0.06)',
              borderRadius: '8px',
              display: 'grid',
              gap: '8px'
            }}>
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap'}}>
                <div style={{fontSize: '12px', color: AMBER, fontWeight: 'bold'}}>高级模型任务包 · 阶段一</div>
              </div>
              <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
                <button onClick={handlePackScriptForCli} disabled={!inputs[0].trim()} style={{...styles.btnGhost, color: AMBER, borderColor: 'rgba(232,160,32,0.35)', ...(!inputs[0].trim() ? styles.btnDisabled : {})}}>📋 剧本给CLI/Agent</button>
                <button onClick={handlePackScriptForWeb} disabled={!inputs[0].trim()} style={{...styles.btnGhost, color: '#fbbf24', borderColor: 'rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.08)', ...(!inputs[0].trim() ? styles.btnDisabled : {})}}>🌐 剧本给网页版</button>
                <button onClick={() => importStageFromClipboard('script')} style={{...styles.btnGhost, color: AMBER, borderColor: 'rgba(232,160,32,0.35)'}}>📥 导入剧本结果</button>
              </div>
            </div>
          )}

          {stage === 1 && (
            <div style={{
              marginTop: '12px',
              padding: '12px',
              border: '1px solid rgba(34,211,238,0.25)',
              background: 'rgba(34,211,238,0.06)',
              borderRadius: '8px',
              display: 'grid',
              gap: '8px'
            }}>
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap'}}>
                <div style={{fontSize: '12px', color: '#67e8f9', fontWeight: 'bold'}}>高级模型任务包 · 阶段二</div>
                {renderPackDeliveryToggle('#67e8f9')}
              </div>
              <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
                <button onClick={handlePackVisualForCli} disabled={!outputs[0]} style={{...styles.btnGhost, color: '#67e8f9', borderColor: 'rgba(34,211,238,0.35)', ...(!outputs[0] ? styles.btnDisabled : {})}}>📋 视觉给CLI/Agent</button>
                <button onClick={handlePackVisualForWeb} disabled={!outputs[0]} style={{...styles.btnGhost, color: '#a5f3fc', borderColor: 'rgba(103,232,249,0.35)', background: 'rgba(34,211,238,0.08)', ...(!outputs[0] ? styles.btnDisabled : {})}}>🌐 视觉给网页版</button>
                <button onClick={() => importStageFromClipboard('visual')} style={{...styles.btnGhost, color: '#67e8f9', borderColor: 'rgba(34,211,238,0.35)'}}>📥 导入视觉结果</button>
                <button onClick={() => handlePackArtCut('auto')} disabled={!outputs[1]} style={{...styles.btnGhost, color: '#facc15', borderColor: 'rgba(250,204,21,0.35)', ...(!outputs[1] ? styles.btnDisabled : {})}}>📋 美术二稿</button>
                <button onClick={() => handlePackArtCut('first')} disabled={!outputs[1]} style={{...styles.btnGhost, color: '#facc15', borderColor: 'rgba(250,204,21,0.35)', ...(!outputs[1] ? styles.btnDisabled : {})}}>📋 二稿S1</button>
                <button onClick={() => handlePackArtCut('last')} disabled={!outputs[1]} style={{...styles.btnGhost, color: '#facc15', borderColor: 'rgba(250,204,21,0.35)', ...(!outputs[1] ? styles.btnDisabled : {})}}>📋 二稿末场</button>
                <button onClick={handlePackReviewRewrite} disabled={!outputs[1] || !scriptAppealReview} title={!scriptAppealReview ? "先在右侧完成一次会审，再打包给 CLI 重写" : ""} style={{...styles.btnGhost, color: '#86efac', borderColor: 'rgba(74,222,128,0.35)', ...(!outputs[1] || !scriptAppealReview ? styles.btnDisabled : {})}}>📋 会审重写包</button>
              </div>
            </div>
          )}

          {stage === 2 && (
            <div style={{
              marginTop: '12px',
              padding: '12px',
              border: '1px solid rgba(168,85,247,0.25)',
              background: 'rgba(168,85,247,0.06)',
              borderRadius: '8px',
              display: 'grid',
              gap: '8px'
            }}>
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap'}}>
                <div style={{fontSize: '12px', color: '#d8b4fe', fontWeight: 'bold'}}>高级模型任务包 · 阶段三</div>
                {renderPackDeliveryToggle('#d8b4fe')}
              </div>
              <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
                <button onClick={handlePackShotForCli} style={{...styles.btnGhost, color: '#d8b4fe', borderColor: 'rgba(168,85,247,0.35)'}}>📋 分镜给CLI/Agent</button>
                <button onClick={handlePackShotForWeb} style={{...styles.btnGhost, color: '#f0abfc', borderColor: 'rgba(217,70,239,0.35)', background: 'rgba(217,70,239,0.08)'}}>🌐 分镜给网页版</button>
                <button onClick={() => importStageFromClipboard('shot')} style={{...styles.btnGhost, color: '#d8b4fe', borderColor: 'rgba(168,85,247,0.35)'}}>📥 导入分镜结果</button>
                <button onClick={() => handlePackCineCut('auto')} disabled={!outputs[2]} style={{...styles.btnGhost, color: '#c4b5fd', borderColor: 'rgba(196,181,253,0.35)', ...(!outputs[2] ? styles.btnDisabled : {})}}>📋 摄影二稿</button>
                <button onClick={() => handlePackCineCut('first')} disabled={!outputs[2]} style={{...styles.btnGhost, color: '#c4b5fd', borderColor: 'rgba(196,181,253,0.35)', ...(!outputs[2] ? styles.btnDisabled : {})}}>📋 二稿首镜</button>
                <button onClick={() => handlePackCineCut('last')} disabled={!outputs[2]} style={{...styles.btnGhost, color: '#c4b5fd', borderColor: 'rgba(196,181,253,0.35)', ...(!outputs[2] ? styles.btnDisabled : {})}}>📋 二稿末镜</button>
                <button onClick={handlePackReviewRewrite} disabled={!outputs[2] || !scriptAppealReview} title={!scriptAppealReview ? "先在右侧完成一次会审，再打包给 CLI 重写" : ""} style={{...styles.btnGhost, color: '#86efac', borderColor: 'rgba(74,222,128,0.35)', ...(!outputs[2] || !scriptAppealReview ? styles.btnDisabled : {})}}>📋 会审重写包</button>
              </div>
            </div>
          )}
        </section>

        <section style={styles.panel} ref={outputRef}>
          <div style={styles.panelHeader}><div style={styles.panelTitle}>生成结果</div></div>
          {outputs[stage] ? (
            <>
              <div style={styles.foldableHeader}>
                <div>
                  <div style={styles.foldableTitle}>输出正文</div>
                  <div style={styles.foldableMeta}>当前阶段生成结果 · 约 {estimateTokenCount(outputs[stage])} token</div>
                </div>
                <button
                  onClick={() => setOutputCollapsed(prev => !prev)}
                  style={styles.toggleBtn}
                  aria-expanded={!outputCollapsed}
                >
                  {outputCollapsed ? "展开" : "折叠"}
                </button>
              </div>
              {outputCollapsed ? (
                <div style={styles.collapsedBox}>输出正文已折叠，展开后查看完整内容。</div>
              ) : (
                <div ref={outputBoxRef} style={styles.output} className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{outputs[stage]}</ReactMarkdown></div>
              )}

              <div style={styles.outputActions}>
                <button onClick={() => { navigator.clipboard.writeText(outputs[stage]); setCopied(true); setTimeout(() => setCopied(false), 2000); }} style={styles.btnGhost}>{copied ? "已复制" : "复制全文"}</button>
                {stage === 0 && (
                  <button
                    onClick={() => handleDirectCut('script')}
                    disabled={loading || !outputs[0]}
                    style={{...styles.btnGhost, borderColor: "rgba(74,222,128,0.45)", color: "#86efac", ...(loading || !outputs[0] ? styles.btnDisabled : {})}}
                  >
                    导演二稿
                  </button>
                )}
                {stage === 1 && (
                  <button
                    onClick={() => handleDirectCut('visual')}
                    disabled={loading || !outputs[1]}
                    style={{...styles.btnGhost, borderColor: "rgba(250,204,21,0.45)", color: "#facc15", ...(loading || !outputs[1] ? styles.btnDisabled : {})}}
                  >
                    美术API二稿
                  </button>
                )}
                {stage === 2 && (
                  <button
                    onClick={() => handleDirectCut('shot')}
                    disabled={loading || !outputs[2]}
                    style={{...styles.btnGhost, borderColor: "rgba(196,181,253,0.45)", color: "#c4b5fd", ...(loading || !outputs[2] ? styles.btnDisabled : {})}}
                  >
                    摄影API二稿
                  </button>
                )}
                {stage === 2 && (
                  <button onClick={() => { navigator.clipboard.writeText(outputs[stage]); setCopied(true); setTimeout(() => setCopied(false), 2000); }} style={{...styles.btn, background: "#4ade80", color: "#000"}}>
                    复制即梦分镜包
                  </button>
                )}
                {stage === 3 && (
                  <button onClick={() => { navigator.clipboard.writeText(outputs[stage]); setCopied(true); setTimeout(() => setCopied(false), 2000); }} style={{...styles.btn, background: "#4ade80", color: "#000"}}>
                    复制场景图清单
                  </button>
                )}
                <>
                  <button
                    onClick={() => handleReviewScriptAppeal("quick")}
                    disabled={scriptAppealLoading || loading}
                    style={{...styles.btnGhost, borderColor: "#4ade80", color: "#4ade80", ...(scriptAppealLoading || loading ? styles.btnDisabled : {})}}
                  >
                    {scriptAppealLoading ? reviewLabels.loading : reviewLabels.quick}
                  </button>
                  {stage === 0 && (
                    <button
                      onClick={() => handleReviewScriptAppeal("three")}
                      disabled={scriptAppealLoading || loading}
                      style={{...styles.btnGhost, borderColor: "#4ade80", color: "#4ade80", ...(scriptAppealLoading || loading ? styles.btnDisabled : {})}}
                    >
                      三方会审
                    </button>
                  )}
                  <button
                    onClick={() => handleReviewScriptAppeal(stage === 0 ? "five" : "full")}
                    disabled={scriptAppealLoading || loading}
                    style={{...styles.btnGhost, borderColor: "#4ade80", color: "#4ade80", ...(scriptAppealLoading || loading ? styles.btnDisabled : {})}}
                  >
                    {reviewLabels.full}
                  </button>
                  <button
                    onClick={() => handleReviewScriptAppeal("final")}
                    disabled={scriptAppealLoading || loading}
                    style={{...styles.btnGhost, borderColor: "#E8A020", color: "#E8A020", ...(scriptAppealLoading || loading ? styles.btnDisabled : {})}}
                  >
                    {reviewLabels.final}
                  </button>
                  {scriptAppealReview && (
                    <button
                      onClick={handleRewriteScriptFromReview}
                      disabled={scriptAppealLoading || scriptRewriteLoading || loading}
                      style={{...styles.btn, background: "#4ade80", color: "#000", ...(scriptAppealLoading || scriptRewriteLoading || loading ? styles.btnDisabled : {})}}
                    >
                      {scriptRewriteLoading ? "按建议重写中..." : reviewLabels.rewrite}
                    </button>
                  )}
                </>
                <button onClick={handleContinue} disabled={loading} style={{...styles.btnGhost, color: "#4ade80", borderColor: "#4ade80", ...(loading ? {opacity: 0.5} : {})}}>
                  {loading ? "无缝拼接中..." : "接续生成 (防截断)"}
                </button>

                {stage < STAGES.length - 1 && <button onClick={() => {
                  if (loading || scriptRewriteLoading) return;
                  const next = [...inputs];
                  let cleanedOutput = outputs[stage]
                    .replace(/\u200b/g, '')
                    .replace(/> 🎬 引擎正在进行前置推演[\s\S]*?\n\n/g, '')
                    .replace(/> 📝 规划推演完成[\s\S]*?\n\n/g, '')
                    .trim();
                  cleanedOutput = stripCompletionEndMarker(cleanedOutput);
                  next[stage + 1] = cleanedOutput;
                  setInputs(next);
                  setStage(stage + 1);
                }} disabled={loading || scriptRewriteLoading} style={{...styles.btn, marginLeft: 'auto', ...(loading || scriptRewriteLoading ? styles.btnDisabled : {})}}>传入下一阶段 →</button>}
              </div>
              {(stage === 2 || stage === 3) && outputs[2] && (
                <div style={styles.fullBoardBox}>
                  <div style={styles.inspirationHeader}>
                    <div>
                      <div style={styles.inspirationTitle}>片段全案分镜图 Prompt 批量生成</div>
                      <div style={styles.inspirationSub}>基于阶段一剧本、阶段二视觉/场景卡、阶段三分镜单元{outputs[3] ? "、阶段四场景图清单" : ""}，自动按源分镜时长拆段；可复制给 GPTImage2，也可直接调用第4阶段图片模型生成全案分镜图。</div>
                    </div>
                    <button
                      onClick={buildFullBoardPrompts}
                      disabled={!outputs[2]}
                      style={{...styles.btnGhost, padding: "9px 14px", ...(!outputs[2] ? styles.btnDisabled : {})}}
                    >
                      生成每段全案 Prompt
                    </button>
                  </div>

                  <div style={styles.fullBoardGrid}>
                    <label style={styles.fullBoardField}>
                      <span style={styles.fullBoardLabel}>两张角色参考图说明</span>
                      <textarea
                        value={boardCharacterRefs}
                        onChange={(e) => setBoardCharacterRefs(e.target.value)}
                        style={styles.fullBoardTextarea}
                        placeholder="角色A：第一张参考图；角色B：第二张参考图。"
                      />
                    </label>
                    <label style={styles.fullBoardField}>
                      <span style={styles.fullBoardLabel}>风格方向覆盖（可留空，默认用当前美学预设）</span>
                      <textarea
                        value={boardStyle}
                        onChange={(e) => setBoardStyle(e.target.value)}
                        style={styles.fullBoardTextarea}
                        placeholder={BOARD_STYLE_HINTS[styleMode] || BOARD_STYLE_HINTS.none}
                      />
                    </label>
                  </div>

                  {boardPromptError && <div style={styles.reviewError}>{boardPromptError}</div>}
                  {boardPrompts.segments?.length > 0 && (
                    <div style={styles.fullBoardResults}>
                      {boardPrompts.segments.map((segment, index) => (
                        <div key={`${segment.id}-${segment.range}`} style={styles.fullBoardResultCard}>
                          <button
                            onClick={() => {
                              const nextExpanded = expandedBoardPrompt === index ? -1 : index;
                              setExpandedBoardPrompt(nextExpanded);
                              if (nextExpanded === index) {
                                refreshBoardOptimizedJimeng(index, { silent: true });
                              }
                            }}
                            style={styles.fullBoardSegmentHeader}
                            aria-expanded={expandedBoardPrompt === index}
                          >
                            <span>{segment.title}</span>
                            <span style={styles.fullBoardSegmentMeta}>{segment.range} · 源单元 {segment.unitCount} 个 · 约 {Number(segment.duration || 0).toFixed(1)}s</span>
                          </button>
                          {expandedBoardPrompt === index && (
                            <>
                              <div style={styles.fullBoardResultTop}>
                                <span style={styles.fullBoardLabel}>给 GPTImage2 的全案分镜图 Prompt</span>
                                <div style={{display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end"}}>
                                  <button onClick={() => copyBoardPrompt("gpt", index)} style={{...styles.btnGhost, padding: "6px 10px", fontSize: "12px"}}>
                                    {boardCopied === `gpt-${index}` ? "已复制" : "复制"}
                                  </button>
                                  <button
                                    onClick={() => handleGenerateBoardImage(index)}
                                    disabled={Boolean(boardImageGenerating)}
                                    style={{...styles.btn, padding: "6px 10px", fontSize: "12px", ...(boardImageGenerating ? styles.btnDisabled : {})}}
                                  >
                                    {boardImageGenerating === `board-${index}` ? "生成中..." : "用项目API生成"}
                                  </button>
                                  <button
                                    onClick={() => handleCreateCodexBoardJob(index)}
                                    disabled={Boolean(codexJobCreating)}
                                    style={{...styles.btnGhost, padding: "6px 10px", fontSize: "12px", color: "#93c5fd", borderColor: "rgba(147,197,253,0.35)", background: "rgba(59,130,246,0.08)", ...(codexJobCreating ? styles.btnDisabled : {})}}
                                  >
                                    {codexJobCreating === `board-${index}` ? "打包中..." : "Codex内置生图"}
                                  </button>
                                </div>
                              </div>
                              <textarea readOnly value={segment.gpt} style={styles.fullBoardOutput} />
                              {codexJobResults[index]?.job_path && (
                                <div style={styles.codexJobNote}>
                                  <div>Codex 任务包已生成：{codexJobResults[index].job_path}</div>
                                  <div>下一步在聊天里说：执行最新全案分镜图任务。任务包已写明只用 Codex 内置生图；第2段起会自动参考上一张全案图。</div>
                                </div>
                              )}
                              {boardImageResults[index]?.images?.length > 0 && (
                                <div style={styles.generatedImageList}>
                                  {boardImageResults[index].images.map((img, imgIndex) => {
                                    const src = img.public_url ? `${API_BASE}${img.public_url}` : img.url || "";
                                    return (
                                      <div key={`${img.frame_id || index}-${imgIndex}`} style={styles.generatedImageItem}>
                                        {src && <img src={src} alt={`全案分镜图 ${index + 1}`} style={styles.generatedImageThumb} />}
                                        <div style={styles.generatedImagePath}>{assetFileLabel(img)}</div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              <div style={styles.fullBoardResultTop}>
                                <div style={{display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap"}}>
                                  <span style={styles.fullBoardLabel}>给即梦的直投指令</span>
                                  <span style={{
                                    color: (segment.jimeng?.length || 0) > 4200 ? "#fca5a5" : MUTED,
                                    border: `1px solid ${(segment.jimeng?.length || 0) > 4200 ? "rgba(239,68,68,0.35)" : "rgba(255,255,255,0.12)"}`,
                                    borderRadius: "999px",
                                    padding: "2px 7px",
                                    fontSize: "11px",
                                    lineHeight: 1.35
                                  }}>
                                    {(segment.jimeng?.length || 0).toLocaleString()} / 4200
                                  </span>
                                </div>
                                <div style={{display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end"}}>
                                  <button
                                    onClick={() => handlePackBoardJimengOptimize(index)}
                                    disabled={Boolean(boardOptimizeCreating)}
                                    title="把已生成全案图、核心剧情和当前直投指令打包给 CLI/Agent，看图后重写即梦提示词"
                                    style={{...styles.btnGhost, padding: "6px 10px", fontSize: "12px", color: "#fbbf24", borderColor: "rgba(251,191,36,0.35)", background: "rgba(251,191,36,0.08)", ...(boardOptimizeCreating ? styles.btnDisabled : {})}}
                                  >
                                    {boardOptimizeCreating === `board-${index}` ? "打包中..." : "看图优化"}
                                  </button>
                                  <button
                                    onClick={() => refreshBoardOptimizedJimeng(index)}
                                    disabled={Boolean(boardOptimizeSyncing)}
                                    title="从项目输出文件读取看图优化后的直投指令，并刷新到下方文本框"
                                    style={{...styles.btnGhost, padding: "6px 10px", fontSize: "12px", color: "#86efac", borderColor: "rgba(74,222,128,0.35)", background: "rgba(74,222,128,0.08)", ...(boardOptimizeSyncing ? styles.btnDisabled : {})}}
                                  >
                                    {boardOptimizeSyncing === `board-${index}` ? "同步中..." : "同步优化结果"}
                                  </button>
                                  <button onClick={() => copyBoardPrompt("jimeng", index)} style={{...styles.btnGhost, padding: "6px 10px", fontSize: "12px"}}>
                                    {boardCopied === `jimeng-${index}` ? "已复制" : "复制"}
                                  </button>
                                </div>
                              </div>
                              {segment.jimengOptimizedPath && (
                                <div style={styles.codexJobNote}>
                                  已载入看图优化结果：{segment.jimengOptimizedPath}{segment.jimengOptimizedAt ? ` · ${segment.jimengOptimizedAt}` : ""}
                                </div>
                              )}
                              <textarea readOnly value={segment.jimeng} style={{...styles.fullBoardOutput, minHeight: "110px"}} />
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {canShowReferenceAssetGeneration && (
                <div style={styles.imageGenSection}>
                  <div style={styles.foldableHeader}>
                    <div>
                      <div style={styles.foldableTitle}>参考图生成</div>
                      <div style={styles.foldableMeta}>
                        识别到 {characterAssetList.length} 张可生成角色身份板、{sceneAssetList.length} 张可生成场景图；图片会绑定到当前项目 outputs/images 目录。无角色原图时，可直接在这里用角色身份板提示词生成 @图片1-9。
                      </div>
                    </div>
                    <select
                      value={imageSize}
                      onChange={(e) => setImageSize(e.target.value)}
                      style={styles.imageSizeSelect}
                    >
                      <option value="1536x1024">1536x1024 横版</option>
                      <option value="1024x1024">1024x1024 方图</option>
                      <option value="1024x1536">1024x1536 竖版</option>
                      <option value="auto">auto</option>
                    </select>
                  </div>
                  {imageGenError && <div style={styles.reviewError}>{imageGenError}</div>}
                  {neededAssetIds.length > 0 && (
                    <div style={styles.assetStrip}>
                      {neededAssetIds.map(id => {
                        const asset = imageAssets[String(id)];
                        const src = asset?.public_url ? `${API_BASE}${asset.public_url}` : "";
                        return (
                          <div key={id} style={{...styles.assetChip, ...(asset ? styles.assetChipReady : {})}}>
                            {src && <img src={src} alt={assetDisplayName(id, asset)} style={styles.assetChipThumb} />}
                            <span>{assetDisplayName(id, asset)}</span>
                            <span style={styles.assetChipStatus}>{asset ? "已绑定" : "未绑定"}</span>
                          </div>
                        );
                      })}
                      <button onClick={() => { setShowAssetLibrary(true); fetchImageAssets(); }} style={{...styles.btnGhost, padding: "7px 10px", fontSize: "12px"}}>
                        绑定参考图
                      </button>
                      <button
                        onClick={handleAutoCompleteReferenceAssets}
                        disabled={assetAutoGenerating || Boolean(imageGeneratingId)}
                        style={{...styles.btn, padding: "7px 10px", fontSize: "12px", ...(assetAutoGenerating || imageGeneratingId ? styles.btnDisabled : {})}}
                      >
                        {assetAutoGenerating ? "补齐中..." : "自动补齐参考图"}
                      </button>
                    </div>
                  )}
                  {assetAutoProgress && <div style={styles.assetProgress}>{assetAutoProgress}</div>}
                  {characterAssetList.length === 0 && (
                    <div style={styles.collapsedBox}>还没有识别到可生成的角色身份板提示词。请确认阶段二角色卡里包含“角色身份板生图提示词”，并且不是“已有角色原图，不生成”。</div>
                  )}
                  {characterAssetList.length > 0 && (
                    <div style={styles.imageFrameGrid}>
                      {characterAssetList.map(character => {
                        const asset = imageAssets[String(character.id)];
                        const src = asset?.public_url ? `${API_BASE}${asset.public_url}` : "";
                        return (
                          <div key={`character-${character.id}`} style={styles.imageFrameCard}>
                            <div style={styles.imageFrameTop}>
                              <div>
                                <div style={styles.imageFrameTitle}>{assetDisplayName(character.id, asset)} · {character.description || "角色身份板"}</div>
                                <div style={styles.imageFrameMeta}>类型：角色原图 / Character Identity Board，用作后续 PRIMARY VISUAL SOURCE</div>
                                <div style={styles.imageFrameMeta}>绑定状态：{asset?.path ? "已绑定" : "未绑定"}</div>
                              </div>
                              <button
                                onClick={() => handleGenerateCharacterAsset(character)}
                                disabled={Boolean(imageGeneratingId)}
                                style={{
                                  ...styles.btn,
                                  padding: "9px 14px",
                                  fontSize: "12px",
                                  ...(imageGeneratingId ? styles.btnDisabled : {})
                                }}
                              >
                                {imageGeneratingId === `character-${character.id}` ? "生成中..." : asset?.path ? "重新生成" : "生成角色图"}
                              </button>
                            </div>
                            <div style={styles.imagePromptPreview}>{character.prompt}</div>
                            {src && (
                              <div>
                                <img src={src} alt={assetDisplayName(character.id, asset)} style={styles.generatedImageThumb} />
                                <div style={styles.generatedImagePath}>{assetFileLabel(asset)}</div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {stage === 3 && sceneAssetList.length === 0 ? (
                    <div style={styles.collapsedBox}>还没有识别到 @图片10-49 场景图。请确认固定要素库包已导入阶段二，或已粘贴到阶段三输入框；现在支持识别“场景参考图：@图片10”和“@图片编号总对应表”。无角色原图时，会额外识别角色卡里的“角色身份板生图提示词”。</div>
                  ) : sceneAssetList.length > 0 ? (
                    <div style={styles.imageFrameGrid}>
                      {sceneAssetList.map(scene => {
                        const asset = imageAssets[String(scene.id)];
                        const src = asset?.public_url ? `${API_BASE}${asset.public_url}` : "";
                        const comfyBaseRepaint = Boolean(asset?.path) && isComfyuiImageRoute(getImageGenerationRoute("repaint"));
                        const styleReferenceId = Number(sceneStyleReferenceIds[String(scene.id)] || 0);
                        const repaintEmphasisMode = sceneRepaintEmphasisModes[String(scene.id)] || "auto";
                        const styleReferenceAsset = imageAssets[String(styleReferenceId)];
                        const styleReferenceSrc = styleReferenceAsset?.public_url ? `${API_BASE}${styleReferenceAsset.public_url}` : "";
                        const styleReferenceOptions = Object.entries(imageAssets)
                          .map(([id, item]) => ({ id: Number(id), asset: item }))
                          .filter(item => item.id && item.id !== scene.id && item.asset?.path)
                          .sort((a, b) => a.id - b.id);
                        return (
                          <div key={scene.id} style={styles.imageFrameCard}>
                            <div style={styles.imageFrameTop}>
                              <div>
                                <div style={styles.imageFrameTitle}>{assetDisplayName(scene.id, asset)} · {scene.description || "场景参考图"}</div>
                                <div style={styles.imageFrameMeta}>类型：空场景图，不生成角色或姿势图</div>
                                <div style={styles.imageFrameMeta}>绑定状态：{asset?.path ? "已绑定" : "未绑定"}</div>
                              </div>
                              <button
                                onClick={() => handleGenerateSceneAsset(scene)}
                                disabled={Boolean(imageGeneratingId)}
                                style={{
                                  ...styles.btn,
                                  padding: "9px 14px",
                                  fontSize: "12px",
                                  ...(imageGeneratingId ? styles.btnDisabled : {})
                                }}
                              >
                                {imageGeneratingId === `scene-${scene.id}` ? "生成中..." : comfyBaseRepaint && styleReferenceId ? "参考重绘" : comfyBaseRepaint ? "垫图重绘" : asset?.path ? "重新生成" : "生成场景图"}
                              </button>
                            </div>
                            <div style={styles.imagePromptPreview}>{scene.prompt}</div>
                            {asset?.path && (
                              <div style={styles.styleReferenceBox}>
                                <div style={styles.styleReferenceHeader}>
                                  <span>风格参考</span>
                                  <span style={styles.imageFrameMeta}>用于 IPAdapter 双参考重绘</span>
                                </div>
                                <div style={styles.styleReferenceControls}>
                                  <select
                                    value={styleReferenceId || ""}
                                    onChange={e => setSceneStyleReferenceIds(prev => ({
                                      ...prev,
                                      [String(scene.id)]: e.target.value ? Number(e.target.value) : 0
                                    }))}
                                    style={styles.styleReferenceSelect}
                                  >
                                    <option value="">不使用额外风格图</option>
                                    {styleReferenceOptions.map(item => (
                                      <option key={item.id} value={item.id}>
                                        {assetDisplayName(item.id, item.asset)} · {item.asset.description || assetFileLabel(item.asset)}
                                      </option>
                                    ))}
                                  </select>
                                  <div style={styles.styleReferenceActions}>
                                    <label style={styles.styleReferenceUploadBtn}>
                                      {assetUploadingId === `style-${scene.id}` ? "上传中..." : "上传风格参考"}
                                      <input
                                        type="file"
                                        accept="image/png,image/jpeg,image/webp"
                                        disabled={Boolean(assetUploadingId)}
                                        style={{display: "none"}}
                                        onChange={e => {
                                          const file = e.target.files?.[0];
                                          e.target.value = "";
                                          handleUploadSceneStyleReference(scene.id, file);
                                        }}
                                      />
                                    </label>
                                    {scene.id !== 10 && imageAssets["10"]?.path && (
                                      <button
                                        type="button"
                                        onClick={() => setSceneStyleReferenceIds(prev => ({...prev, [String(scene.id)]: 10}))}
                                        style={styles.styleReferenceMiniBtn}
                                      >
                                        用图片10
                                      </button>
                                    )}
                                    {styleReferenceId ? (
                                      <button
                                        type="button"
                                        onClick={() => setSceneStyleReferenceIds(prev => ({...prev, [String(scene.id)]: 0}))}
                                        style={styles.styleReferenceMiniBtn}
                                      >
                                        清除
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                                <div style={styles.repaintEmphasisControls}>
                                  <span style={styles.imageFrameMeta}>重绘强调</span>
                                  <select
                                    value={repaintEmphasisMode}
                                    onChange={e => setSceneRepaintEmphasisModes(prev => ({
                                      ...prev,
                                      [String(scene.id)]: e.target.value
                                    }))}
                                    style={styles.styleReferenceSelect}
                                  >
                                    {SCENE_REPAINT_EMPHASIS_OPTIONS.map(option => (
                                      <option key={option.id} value={option.id}>{option.label}</option>
                                    ))}
                                  </select>
                                </div>
                                {styleReferenceAsset && (
                                  <div style={styles.styleReferencePreview}>
                                    {styleReferenceSrc && <img src={styleReferenceSrc} alt={assetDisplayName(styleReferenceId, styleReferenceAsset)} style={styles.styleReferenceThumb} />}
                                    <div>
                                      <div style={styles.assetTitle}>{assetDisplayName(styleReferenceId, styleReferenceAsset)}</div>
                                      <div style={styles.assetMeta}>{styleReferenceAsset.description || assetFileLabel(styleReferenceAsset)}</div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                            {src && (
                              <div style={styles.generatedImageList}>
                                <div style={styles.generatedImageItem}>
                                  <img src={src} alt={assetDisplayName(scene.id, asset)} style={styles.generatedImageThumb} />
                                  <div style={styles.generatedImagePath}>{assetFileLabel(asset)}</div>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              )}
              {scriptAppealError && (
                <div style={styles.reviewError}>{scriptAppealError}</div>
              )}
              {scriptAppealReview && (
                <div style={styles.reviewSection}>
                  <div style={styles.foldableHeader}>
                    <div>
                      <div style={{...styles.foldableTitle, color: "#86efac"}}>会审报告</div>
                      <div style={styles.foldableMeta}>约 {estimateTokenCount(scriptAppealReview)} token，折叠后不影响按建议重写</div>
                    </div>
                    <button
                      onClick={() => setReviewCollapsed(prev => !prev)}
                      style={{...styles.toggleBtn, borderColor: "rgba(74,222,128,0.35)", color: "#86efac", background: "rgba(74,222,128,0.06)"}}
                      aria-expanded={!reviewCollapsed}
                    >
                      {reviewCollapsed ? "展开" : "折叠"}
                    </button>
                  </div>
                  {reviewCollapsed ? (
                    <div style={styles.collapsedBox}>会审报告已折叠，展开后查看完整意见。</div>
                  ) : (
                    <div ref={reviewBoxRef} style={styles.reviewBox} className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{scriptAppealReview}</ReactMarkdown>
                    </div>
                  )}
                </div>
              )}
              </>
          ) : (<div style={styles.empty}>输入内容并点击生成以开始 (已挂载 {selectedIPs.length} 个IP知识库)</div>)}
        </section>
      </main>

      {showAssetLibrary && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modalContent, width: "980px"}}>
            <div style={styles.modalHeader}>
              <h2 style={{margin: 0, color: "#4ade80"}}>参考图资产库</h2>
              <button onClick={() => setShowAssetLibrary(false)} style={styles.closeBtn}>×</button>
            </div>
            <div style={styles.modalBody}>
              <div style={styles.assetHelp}>
                上传时直接绑定编号：角色原图/角色身份板用 @图片1-@图片9，场景图用 @图片10-@图片49。没有角色原图时，阶段二角色卡里的“角色身份板生图提示词”可在阶段四自动生成绑定。当前流程不再生成姿势图、首尾帧或 @图片50+。
              </div>
              {assetError && <div style={styles.reviewError}>{assetError}</div>}
              <div style={styles.assetGrid}>
                {[...new Set([1, 2, ...neededAssetIds])].sort((a, b) => a - b).map(id => {
                  const asset = imageAssets[String(id)];
                  const category = categoryForAssetId(id);
                  const src = asset?.public_url ? `${API_BASE}${asset.public_url}` : "";
                  return (
                    <div key={id} style={styles.assetCard}>
                      <div style={styles.assetCardTop}>
                        <div>
                          <div style={styles.assetTitle}>{assetDisplayName(id, asset)}</div>
                          <div style={styles.assetMeta}>{category === "character" ? "角色原图 / 身份板" : category === "scene" ? "场景参考图" : "其他资产"}</div>
                        </div>
                        {asset && <button onClick={() => handleDeleteAsset(id)} style={styles.assetDeleteBtn}>删除</button>}
                      </div>
                      {src ? (
                        <img src={src} alt={assetDisplayName(id, asset)} style={styles.assetPreview} />
                      ) : (
                        <div style={styles.assetEmpty}>未绑定图片</div>
                      )}
                      <div style={styles.assetMeta}>{asset ? assetFileLabel(asset) : "上传后会写入 image_registry.json"}</div>
                      <label style={styles.assetUploadBtn}>
                        {assetUploadingId === String(id) ? "上传中..." : asset ? "替换图片" : "上传绑定"}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          disabled={Boolean(assetUploadingId)}
                          style={{display: "none"}}
                          onChange={e => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            handleUploadAsset(id, category, file, asset?.description || assetDisplayName(id, asset));
                          }}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={styles.modalFooter}>
              <button onClick={fetchImageAssets} style={styles.btnGhost}>刷新资产</button>
              <button onClick={() => setShowAssetLibrary(false)} style={styles.btn}>完成</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalContent}>
            <div style={styles.modalHeader}>
              <h2 style={{margin: 0, color: "#E8A020"}}>主线引擎配置 (四阶段模型路由)</h2>
              <button onClick={() => setShowSettings(false)} style={styles.closeBtn}>×</button>
            </div>
            <div style={styles.modalBody}>
              <div style={styles.configCard}>
                <h3 style={styles.modalH3}>高级模型路由配置 (Model Routing)</h3>

                <div style={{ display: 'flex', gap: '5px', background: '#000', padding: '4px', borderRadius: '6px', marginBottom: '15px' }}>
                  {Object.entries(config.routes).map(([key, r]) => (
                    <button
                      key={key}
                      onClick={() => setActiveRouteTab(key)}
                      style={{ flex: 1, padding: '8px', border: 'none', borderRadius: '4px', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold', background: activeRouteTab === key ? AMBER : 'transparent', color: activeRouteTab === key ? '#000' : MUTED }}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>

                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '8px', border: `1px solid ${BORDER}` }}>
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '12px', color: MUTED, marginBottom: '5px' }}>API 来源</div>
                    <select
                      value={config.route_sources?.[activeRouteTab] || "self"}
                      onChange={e => updateRouteSource(activeRouteTab, e.target.value)}
                      style={{ width: '100%', background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '8px', borderRadius: '4px', outline: 'none' }}
                    >
                      <option value="self">使用本项配置</option>
                      {Object.entries(config.routes).filter(([key]) => key !== activeRouteTab).map(([key, route]) => (
                        <option key={key} value={`route:${key}`}>复用：{route.name}</option>
                      ))}
                    </select>
                    {(config.route_sources?.[activeRouteTab] || "self") !== "self" && (
                      <div style={{ fontSize: '11px', color: MUTED, marginTop: '6px' }}>
                        {[IMAGE_MASTER_ROUTE_ID, IMAGE_REPAINT_ROUTE_ID].includes(activeRouteTab)
                          ? "当前生图槽位会使用被复用来源的 URL / Key / Model / 代理；4A 用于母版首图，4B 用于已有场景图的 ComfyUI 垫图重绘。"
                          : "当前请求会使用被复用阶段的 URL / Key / Model / 代理；本页字段保留为备用配置。"}
                      </div>
                    )}
                  </div>
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '12px', color: MUTED, marginBottom: '5px' }}>代理地址池 (Base URLs)</div>
                    <textarea value={config.routes[activeRouteTab]?.url || ""} onChange={e => updateRouteField(activeRouteTab, "url", e.target.value)} style={{ width: '100%', background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '8px', borderRadius: '4px', resize: 'vertical', minHeight: '40px' }} placeholder="如: https://api.openai.com/v1" />
                  </div>
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '12px', color: MUTED, marginBottom: '5px' }}>API Key 池 (API Keys)</div>
                    <textarea value={config.routes[activeRouteTab]?.key || ""} onChange={e => updateRouteField(activeRouteTab, "key", e.target.value)} style={{ width: '100%', background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '8px', borderRadius: '4px', resize: 'vertical', minHeight: '40px' }} placeholder="如: sk-..." />
                  </div>
                  <div>
                    <div style={{ fontSize: '12px', color: MUTED, marginBottom: '5px' }}>模型池 (Models)</div>
                    <textarea value={config.routes[activeRouteTab]?.model || ""} onChange={e => updateRouteField(activeRouteTab, "model", e.target.value)} style={{ width: '100%', background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '8px', borderRadius: '4px', resize: 'vertical', minHeight: '40px' }} placeholder="如: gpt-4o" />
                  </div>
                  {[IMAGE_MASTER_ROUTE_ID, IMAGE_REPAINT_ROUTE_ID].includes(activeRouteTab) && (
                    <div style={{ marginTop: "12px", border: `1px solid rgba(74,222,128,0.24)`, background: "rgba(74,222,128,0.06)", borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                        <div style={{ color: "#86efac", fontSize: "12px", fontWeight: "bold" }}>图片模型 / ComfyUI 工作流</div>
                        {extractComfyWorkflow(config.routes[activeRouteTab]?.model) && (
                          <div style={{ color: "#bbf7d0", fontSize: "11px", background: "rgba(0,0,0,0.24)", border: "1px solid rgba(74,222,128,0.22)", borderRadius: "999px", padding: "3px 8px" }}>
                            workflow: {extractComfyWorkflow(config.routes[activeRouteTab]?.model)}
                          </div>
                        )}
                      </div>
                      {IMAGE_PRESET_GROUPS.map(group => {
                        const presets = IMAGE_MODEL_PRESETS.filter(preset => (
                          preset.group === group.id && imagePresetVisibleForRoute(preset, activeRouteTab)
                        ));
                        if (!presets.length) return null;
                        return (
                          <div key={group.id} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                            <div style={{ color: MUTED, fontSize: "11px", fontWeight: "bold" }}>{group.label}</div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "8px" }}>
                              {presets.map(preset => {
                                const selected = (config.routes[activeRouteTab]?.model || "").trim() === preset.model;
                                return (
                                  <button
                                    key={`${group.id}-${preset.model}`}
                                    type="button"
                                    title={preset.note || preset.label}
                                    onClick={() => setConfig(prev => ({
                                      ...prev,
                                      routes: {
                                        ...prev.routes,
                                        [activeRouteTab]: {
                                          ...prev.routes[activeRouteTab],
                                          url: preset.url || prev.routes[activeRouteTab].url,
                                          model: preset.model
                                        }
                                      }
                                    }))}
                                    style={{
                                      minHeight: "48px",
                                      background: selected ? "#86efac" : "rgba(0,0,0,0.28)",
                                      color: selected ? "#06130a" : "#86efac",
                                      border: selected ? "1px solid #bbf7d0" : "1px solid rgba(74,222,128,0.35)",
                                      borderRadius: "6px",
                                      padding: "7px 10px",
                                      fontSize: "12px",
                                      cursor: "pointer",
                                      fontWeight: "bold",
                                      textAlign: "left",
                                      display: "flex",
                                      flexDirection: "column",
                                      justifyContent: "center",
                                      gap: "3px"
                                    }}
                                  >
                                    <span>{preset.label}</span>
                                    {preset.workflow && (
                                      <span style={{ fontSize: "10px", opacity: 0.76, fontWeight: 700 }}>
                                        {preset.workflow}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                      <div style={{ color: MUTED, fontSize: "11px", lineHeight: 1.6 }}>
                        4A 负责母版首图；4B 负责已有参考图重绘、一致性、放大。ComfyUI API Key 可留空，普通图片 API 仍需填写 API Key。
                      </div>
                    </div>
                  )}

                  <div style={{ marginTop: '15px', display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(232,160,32,0.1)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(232,160,32,0.3)' }}>
                    <div style={{ fontSize: '13px', color: '#E8A020', fontWeight: 'bold' }}>🧠 开启深度思考模式 (仅限支持模型)</div>
                    <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', position: 'relative' }}>
                      <input
                        type="checkbox"
                        checked={config.routes[activeRouteTab]?.is_thinking || false}
                        onChange={e => updateRouteField(activeRouteTab, "is_thinking", e.target.checked)}
                        style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#E8A020' }}
                      />
                    </label>
                    <span style={{ fontSize: '11px', color: MUTED }}>勾选后后台将附带 extra_body 触发 reasoning_content</span>
                  </div>
                  <div style={{ marginTop: '10px', background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '6px', border: `1px solid ${BORDER}` }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(config.routes[activeRouteTab]?.use_proxy)}
                        onChange={e => updateRouteField(activeRouteTab, "use_proxy", e.target.checked)}
                        style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#E8A020' }}
                      />
                      <span style={{ fontSize: '13px', color: '#E8A020', fontWeight: 'bold' }}>使用代理</span>
                    </label>
                    <input
                      value={config.routes[activeRouteTab]?.proxy_url || ""}
                      onChange={e => updateRouteField(activeRouteTab, "proxy_url", e.target.value)}
                      style={{ width: '100%', marginTop: '8px', background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '8px', borderRadius: '4px', boxSizing: 'border-box' }}
                      placeholder="可选代理，例如 http://127.0.0.1:10808"
                    />
                  </div>
                </div>
              </div>

              <div style={{...styles.configCard, borderColor: 'rgba(74,222,128,0.28)'}}>
                <h3 style={{...styles.modalH3, color: '#4ade80'}}>会审模型配置 (独立 API 槽位)</h3>
                <div style={{display: 'flex', gap: '5px', background: '#000', padding: '4px', borderRadius: '6px', marginBottom: '15px', flexWrap: 'wrap'}}>
                  {REVIEW_ROUTES.map(r => (
                    <button
                      key={r.id}
                      onClick={() => setActiveReviewRouteTab(r.id)}
                      style={{
                        flex: '1 1 130px',
                        padding: '8px 10px',
                        border: 'none',
                        borderRadius: '4px',
                        background: activeReviewRouteTab === r.id ? '#4ade80' : 'transparent',
                        color: activeReviewRouteTab === r.id ? '#000' : MUTED,
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        fontSize: '12px'
                      }}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>

                <div style={{background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '8px', border: `1px solid ${BORDER}`}}>
                  <div style={{fontSize: '12px', color: '#4ade80', marginBottom: '12px'}}>
                    {REVIEW_ROUTES.find(r => r.id === activeReviewRouteTab)?.hint}
                  </div>
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '12px', color: MUTED, marginBottom: '5px' }}>API 来源</div>
                    <select
                      value={config.review_route_sources?.[activeReviewRouteTab] || "self"}
                      onChange={e => updateReviewRouteSource(activeReviewRouteTab, e.target.value)}
                      style={{ width: '100%', background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '8px', borderRadius: '4px', outline: 'none' }}
                    >
                      <option value="self">使用本项配置</option>
                      <optgroup label="复用主阶段/工具路由">
                        {Object.entries(config.routes).map(([key, route]) => (
                          <option key={key} value={`route:${key}`}>复用：{route.name}</option>
                        ))}
                      </optgroup>
                      <optgroup label="复用其它会审槽位">
                        {REVIEW_ROUTES.filter(route => route.id !== activeReviewRouteTab).map(route => (
                          <option key={route.id} value={`review:${route.id}`}>复用：{config.review_routes[route.id]?.name || route.label}</option>
                        ))}
                      </optgroup>
                    </select>
                    {(config.review_route_sources?.[activeReviewRouteTab] || "self") !== "self" && (
                      <div style={{ fontSize: '11px', color: MUTED, marginTop: '6px' }}>
                        当前会审槽位会使用被复用来源的 URL / Key / Model / 代理；本项字段保留备用。
                      </div>
                    )}
                  </div>
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '12px', color: MUTED, marginBottom: '5px' }}>API URL</div>
                    <textarea
                      value={config.review_routes[activeReviewRouteTab]?.url || ""}
                      onChange={e => updateReviewRouteField(activeReviewRouteTab, "url", e.target.value)}
                      style={{ width: '100%', background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '8px', borderRadius: '4px', resize: 'vertical', minHeight: '36px' }}
                      placeholder="例如：https://api.openai.com/v1 或对应平台的 OpenAI-compatible 地址"
                    />
                  </div>
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '12px', color: MUTED, marginBottom: '5px' }}>API Key</div>
                    <textarea
                      value={config.review_routes[activeReviewRouteTab]?.key || ""}
                      onChange={e => updateReviewRouteField(activeReviewRouteTab, "key", e.target.value)}
                      style={{ width: '100%', background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '8px', borderRadius: '4px', resize: 'vertical', minHeight: '36px' }}
                      placeholder="填这个评审模型所属平台的 API Key"
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: '12px', color: MUTED, marginBottom: '5px' }}>Model</div>
                    <textarea
                      value={config.review_routes[activeReviewRouteTab]?.model || ""}
                      onChange={e => updateReviewRouteField(activeReviewRouteTab, "model", e.target.value)}
                      style={{ width: '100%', background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '8px', borderRadius: '4px', resize: 'vertical', minHeight: '36px' }}
                      placeholder="例如：doubao-seed-2-0-pro-260215"
                    />
                  </div>
                  <div style={{ marginTop: '10px', background: 'rgba(74,222,128,0.06)', padding: '10px', borderRadius: '6px', border: '1px solid rgba(74,222,128,0.24)' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(config.review_routes[activeReviewRouteTab]?.use_proxy)}
                        onChange={e => updateReviewRouteField(activeReviewRouteTab, "use_proxy", e.target.checked)}
                        style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#4ade80' }}
                      />
                      <span style={{ fontSize: '13px', color: '#4ade80', fontWeight: 'bold' }}>使用代理</span>
                    </label>
                    <input
                      value={config.review_routes[activeReviewRouteTab]?.proxy_url || ""}
                      onChange={e => updateReviewRouteField(activeReviewRouteTab, "proxy_url", e.target.value)}
                      style={{ width: '100%', marginTop: '8px', background: '#000', border: `1px solid ${BORDER}`, color: '#FFF', padding: '8px', borderRadius: '4px', boxSizing: 'border-box' }}
                      placeholder="可选代理，例如 http://127.0.0.1:10808"
                    />
                  </div>
                </div>
              </div>

              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px'}}>
                <h3 style={{...styles.modalH3, marginTop: 0}}>核心系统提示词</h3>
                <button onClick={() => {
  if(window.confirm("确定恢复默认？")) {
    const newConfig = { ...config, prompts: { ...DEFAULT_PROMPTS } };
    setConfig(newConfig);
    localStorage.setItem("micro_epic_config_v30", JSON.stringify(buildPersistableConfig(newConfig)));
  }
}} style={styles.resetBtn}>恢复默认</button>
              </div>
              <div style={styles.promptTabs}>
                {STAGES.map(s => (
                  <div key={s.id} style={{marginBottom: '15px'}}>
                    <label style={{color: '#E8A020', fontSize: '13px', display:'block', marginBottom:'5px'}}>{s.label}指令</label>
                    <textarea style={styles.promptInput} value={config.prompts[s.id]} onChange={e => setConfig({...config, prompts: {...config.prompts, [s.id]: e.target.value}})} />
                  </div>
                ))}
              </div>
            </div>
            <div style={styles.modalFooter}>
              <button onClick={() => setShowSettings(false)} style={styles.btnGhost}>取消</button>
              <button onClick={handleSaveConfig} style={styles.btn}>保存配置</button>
            </div>
          </div>
        </div>
      )}

      {showRadar && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modalContent, width: '1000px'}}>
            <div style={styles.modalHeader}>
              <h2 style={{margin: 0, color: "#E8A020"}}>RAG 数据蒸馏引擎</h2>
              <button onClick={() => setShowRadar(false)} style={styles.closeBtn}>×</button>
            </div>
            <div style={{...styles.modalBody, display: 'flex', gap: '20px'}}>
              <div style={{flex: 1, display: 'flex', flexDirection: 'column', gap: '15px'}}>

                {/* 🌟 核心修改点：三分天下按钮 🌟 */}
                <div style={{display: 'flex', gap: '8px', padding: '4px', background: '#000', borderRadius: '6px'}}>
                   <button onClick={() => {setRadarMode("json"); setWashResult(""); setWashJson("");}} style={{flex: 1, padding: '8px 4px', border: 'none', borderRadius: '4px', background: radarMode === "json" ? AMBER : "transparent", color: radarMode === "json" ? "#000" : MUTED, cursor: 'pointer', fontWeight: 'bold', fontSize: '12px'}}>1. 提取 JSON 范例</button>
                   <button onClick={() => {setRadarMode("core"); setWashResult(""); setWashJson("");}} style={{flex: 1, padding: '8px 4px', border: 'none', borderRadius: '4px', background: radarMode === "core" ? AMBER : "transparent", color: radarMode === "core" ? "#000" : MUTED, cursor: 'pointer', fontWeight: 'bold', fontSize: '12px'}}>2. 提炼通用法则</button>
                   <button onClick={() => {setRadarMode("ip"); setWashResult(""); setWashJson("");}} style={{flex: 1, padding: '8px 4px', border: 'none', borderRadius: '4px', background: radarMode === "ip" ? AMBER : "transparent", color: radarMode === "ip" ? "#000" : MUTED, cursor: 'pointer', fontWeight: 'bold', fontSize: '12px'}}>3. 逆向推演专属 IP</button>
                </div>

                <div style={{background: 'rgba(232,160,32,0.1)', padding: '15px', borderRadius: '6px', border: '1px dashed #E8A020'}}>
                  {radarMode === "json" && (
                    <p style={{color: '#4ade80', fontSize: '13px', margin: '0 0 10px 0'}}>
                      💡 <b>局部高精提取：</b>由于 JSON 结构极为复杂，为防止大模型输出被截断，<b>请每次仅粘贴 3-5 个神级镜头的描述进行提取。</b>
                    </p>
                  )}
                  {radarMode === "core" && (
                    <p style={{color: '#D4D0C8', fontSize: '13px', margin: '0 0 10px 0'}}>将拉片内容提炼为通用分镜规律与美学法则，自动存入 <b>core/</b> 目录供所有项目复用。</p>
                  )}
                  {radarMode === "ip" && (
                    <div style={{display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px'}}>
                       <span style={{color: '#D4D0C8', fontSize: '13px'}}>建立圣经目标宇宙名称：</span>
                       <input type="text" value={newIpName} onChange={e => setNewIpName(e.target.value)} style={{background: "#000", border: "1px solid #222226", color: "#FFF", padding: "10px 12px", borderRadius: "4px", fontSize: "13px", outline: "none", flex: 1}} placeholder="例如：刀盾狗宇宙" />
                    </div>
                  )}
                  <textarea
                    style={{background: "#000", border: "1px solid #222226", color: "#D4D0C8", padding: "12px", borderRadius: "4px", width: "100%", resize: "vertical", fontSize: "12px", outline: "none", boxSizing: "border-box", fontFamily: "inherit", height: '280px'}}
                    value={rawAnalysisText}
                    onChange={e => setRawAnalysisText(e.target.value)}
                    placeholder={
                      radarMode === "json" ? "粘贴 3-5 个镜头的动作大白话描述，引擎将其精准转换为 Few-Shot 范例..." :
                      radarMode === "core" ? "粘贴长篇优秀视频拉片描述，提炼底层经验库法则..." :
                      "粘贴您让Kimi/Qwen分析角色的原始反馈数据，引擎将其整理出 V3.0 专属圣经！"
                    }
                  />
                </div>
                <button onClick={handleWashText} disabled={washing || !rawAnalysisText.trim()} style={{background: AMBER, color: BG, border: "none", padding: "12px 24px", borderRadius: "6px", fontWeight: "bold", cursor: "pointer", width: '100%', ...(washing || !rawAnalysisText.trim() ? {opacity: 0.5, cursor: "not-allowed"} : {})}}>
                  {washing ? "深度推理提炼中..." : (
                    radarMode === "json" ? "提取 JSON 镜头范例" :
                    radarMode === "core" ? "提取通用导演法则" :
                    "四步执行提取IP圣经 V3.0"
                  )}
                </button>
              </div>
              
              <div style={{flex: 1.2, background: '#000', border: '1px solid #222226', borderRadius: '6px', padding: '15px', overflowY: 'auto', maxHeight: '500px'}}>
                {washResult ? (
                  <div>
                    <div className="markdown-body" style={{fontSize: '13px', whiteSpace: 'pre-wrap'}}><ReactMarkdown remarkPlugins={[remarkGfm]}>{washResult}</ReactMarkdown></div>
                    {washJson && (
                      <div style={{marginTop: '12px', position: 'relative'}}>
                        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px'}}>
                          <span style={{color: '#8BC34A', fontSize: '12px', fontWeight: 'bold'}}>提取的镜头参数 JSON：</span>
                          <button onClick={() => {navigator.clipboard.writeText(washJson);}} style={{background: '#333', color: '#ccc', border: '1px solid #555', borderRadius: '4px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer'}}>复制</button>
                        </div>
                        <pre style={{background: '#0D0D0D', border: '1px solid #333', borderRadius: '4px', padding: '12px', overflowX: 'auto', fontSize: '12px', lineHeight: '1.5', maxHeight: '400px', overflowY: 'auto'}}><code style={{color: '#E0E0E0'}}>{washJson}</code></pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{color: '#5A5750', textAlign: 'center', marginTop: '200px'}}>等待提炼素材...</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 自动化切片暂停确认弹窗 */}
      {showChunkModal && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modalContent, width: '400px', padding: '30px', textAlign: 'center'}}>
            <h3 style={{color: "#E8A020", marginTop: 0}}>切片生成暂停</h3>
            <p style={{color: "#E4E4E7", fontSize: '14px', lineHeight: '1.6'}}>
              ✅ <b>{chunkQueue[completedChunkIndex]?.join(" & ")}</b> 已完美推演并无缝拼接！<br/><br/>
              {chunkQueue[completedChunkIndex + 1] ? (
                <>即将推演下一组：<b>{chunkQueue[completedChunkIndex + 1].join(" & ")}</b><br/>是否确认继续？</>
              ) : (
                <>当前已是最后一组，可重试本段或终止推演。</>
              )}
            </p>
            <div style={{display: 'flex', gap: '15px', justifyContent: 'center', marginTop: '25px'}}>
              <button onClick={() => {
                setShowChunkModal(false);
                setChunkQueue([]);
                setChunkSceneCards([]);
                setChunkIndex(0);
                setCompletedChunkIndex(-1);
              }} style={styles.btnGhost}>终止推演</button>
              {/* 新增重试按钮 */}
              <button
                onClick={() => executeChunk(chunkQueue, completedChunkIndex, inputs[2])}
                style={{...styles.btnGhost, color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.3)'}}
              >
                ↻ 重试本段
              </button>
              {chunkQueue[completedChunkIndex + 1] && (
                <button
                  onClick={() => {
                    const nextIdx = completedChunkIndex + 1;
                    setChunkIndex(nextIdx);
                    executeChunk(chunkQueue, nextIdx, inputs[2]);
                  }}
                  style={styles.btn}
                >
                  🚀 确认继续
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const AMBER = "#E8A020";
const AMBER_HOVER = "#FBBF24";
const BG = "#09090B";
const SURFACE = "#141417";
const BORDER = "#27272A";
const TEXT = "#E4E4E7";
const MUTED = "#A1A1AA";

const styles = {
  root: { height: "100vh", width: "100vw", background: BG, color: TEXT, fontFamily: "'Noto Serif SC', serif", position: "relative", display: "flex", flexDirection: "column", overflow: "hidden" },
  grain: { position: "fixed", inset: 0, backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E")`, pointerEvents: "none", zIndex: 0 },

  header: { borderBottom: "1px solid " + BORDER, padding: "16px 32px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative", zIndex: 10, background: "rgba(9, 9, 11, 0.7)", backdropFilter: "blur(12px)" },
  headerInner: { display: "flex", alignItems: "center", gap: 16 },
  logo: { fontSize: 26, color: AMBER, textShadow: "0 0 15px rgba(232,160,32,0.4)" },
  title: { fontSize: 18, fontWeight: "800", color: "#FFF", letterSpacing: "1px" },
  titleSub: { fontSize: 12, color: AMBER, marginTop: 4, opacity: 0.8 },
  settingsBtn: { background: "rgba(255,255,255,0.03)", color: TEXT, border: "1px solid " + BORDER, padding: "8px 18px", borderRadius: "6px", cursor: "pointer", transition: "all 0.2s ease", fontSize: "13px" },
  projectPicker: { display: "flex", alignItems: "center", gap: "8px", padding: "4px 8px", border: "1px solid " + BORDER, borderRadius: "6px", background: "rgba(255,255,255,0.03)", minWidth: 0 },
  projectPickerLabel: { color: MUTED, fontSize: "12px", whiteSpace: "nowrap" },
  projectSelect: { background: "#000", color: TEXT, border: "1px solid " + BORDER, borderRadius: "5px", padding: "7px 9px", outline: "none", fontSize: "12px", minWidth: "260px", maxWidth: "420px" },
  projectRefreshBtn: { background: "transparent", color: AMBER, border: "1px solid rgba(232,160,32,0.28)", borderRadius: "5px", padding: "6px 9px", cursor: "pointer", fontSize: "12px", lineHeight: 1 },

  nav: { display: "flex", borderBottom: "1px solid " + BORDER, position: "relative", zIndex: 1, background: SURFACE },
  navBtn: { flex: 1, display: "flex", justifyContent: "center", alignItems: "center", gap: 12, padding: "16px 24px", background: "none", border: "none", borderRight: "1px solid " + BORDER, color: MUTED, cursor: "pointer", outline: "none", transition: "all 0.3s ease" },
  navBtnActive: { color: "#FFF", background: "rgba(232,160,32,0.08)", boxShadow: "inset 0 -2px 0 " + AMBER },
  navStep: { color: AMBER, fontSize: "12px", marginRight: "4px", fontWeight: "bold", opacity: 0.8 },

  main: { display: "grid", gridTemplateColumns: "1fr 1.3fr", flex: 1, position: "relative", zIndex: 1, overflow: "hidden" },
  panel: { padding: "24px 32px", borderRight: "1px solid " + BORDER, display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", height: "100%", boxSizing: "border-box" },
  panelHeader: { borderBottom: "1px solid " + BORDER, paddingBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" },
  panelTitle: { fontSize: "16px", fontWeight: "bold", color: "#FFF", display: "flex", alignItems: "center", gap: "8px" },

  textarea: { background: "rgba(0,0,0,0.3)", border: "1px solid " + BORDER, color: TEXT, padding: "20px", borderRadius: "8px", flex: 1, minHeight: "300px", resize: "none", outline: "none", lineHeight: 1.7, fontSize: "14px", transition: "border-color 0.3s ease" },
  inspirationBox: { border: "1px solid rgba(232,160,32,0.25)", background: "rgba(232,160,32,0.05)", borderRadius: "8px", padding: "14px", display: "flex", flexDirection: "column", gap: "12px" },
  inspirationHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" },
  inspirationTitle: { color: "#FFF", fontSize: "14px", fontWeight: "bold" },
  inspirationSub: { color: MUTED, fontSize: "12px", marginTop: "4px", lineHeight: 1.5 },
  inspirationError: { color: "#fca5a5", border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.08)", borderRadius: "6px", padding: "8px 10px", fontSize: "12px" },
  inspirationList: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "12px", maxHeight: "520px", overflowY: "auto", paddingRight: "4px", alignItems: "stretch" },
  inspirationItem: { textAlign: "left", background: "rgba(0,0,0,0.22)", color: TEXT, border: "1px solid " + BORDER, borderRadius: "8px", padding: "14px", cursor: "pointer", outline: "none", display: "flex", flexDirection: "column", alignItems: "stretch", gap: "10px", minHeight: "128px", width: "100%", minWidth: 0, boxSizing: "border-box", whiteSpace: "normal", lineHeight: 1.55, overflow: "hidden", fontFamily: "inherit" },
  inspirationItemTop: { display: "flex", alignItems: "flex-start", gap: "8px", minWidth: 0 },
  inspirationIndex: { width: "22px", height: "22px", borderRadius: "50%", background: AMBER, color: "#000", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: "bold", flex: "0 0 auto" },
  inspirationItemTitle: { color: "#FFF", fontSize: "13px", fontWeight: "bold", lineHeight: 1.45, flex: 1, minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" },
  inspirationSpark: { color: "#FFF", fontSize: "12px", lineHeight: 1.65, fontStyle: "italic", overflowWrap: "anywhere", wordBreak: "break-word" },
  inspirationLogline: { color: TEXT, fontSize: "12px", lineHeight: 1.65, overflowWrap: "anywhere", wordBreak: "break-word" },
  inspirationHook: { color: AMBER, fontSize: "12px", lineHeight: 1.6, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "8px", overflowWrap: "anywhere", wordBreak: "break-word" },
  inspirationMeta: { color: MUTED, fontSize: "11px", lineHeight: 1.6, overflowWrap: "anywhere", wordBreak: "break-word" },
  inspirationRisk: { color: "#fca5a5", fontSize: "11px", lineHeight: 1.6, overflowWrap: "anywhere", wordBreak: "break-word" },
  scoreRow: { display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center", minWidth: 0 },
  scoreBadge: { background: AMBER, color: "#000", borderRadius: "999px", padding: "3px 8px", fontSize: "11px", fontWeight: "bold", lineHeight: 1.35 },
  scoreTiny: { border: "1px solid rgba(255,255,255,0.15)", color: TEXT, borderRadius: "999px", padding: "2px 7px", fontSize: "11px", lineHeight: 1.35 },
  templateGallery: { border: "1px solid rgba(147,197,253,0.24)", background: "rgba(59,130,246,0.055)", borderRadius: "8px", padding: "14px", display: "flex", flexDirection: "column", gap: "12px" },
  templateList: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "10px" },
  templateCard: { textAlign: "left", background: "rgba(0,0,0,0.24)", color: TEXT, border: "1px solid rgba(147,197,253,0.24)", borderRadius: "8px", padding: "14px", cursor: "pointer", outline: "none", display: "flex", flexDirection: "column", gap: "9px", minWidth: 0, fontFamily: "inherit", lineHeight: 1.5 },
  templateCardTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  templateEyebrow: { color: "#bfdbfe", fontSize: "11px", fontWeight: "bold", overflowWrap: "anywhere" },
  templateAction: { color: "#020617", background: "#bfdbfe", borderRadius: "999px", padding: "3px 8px", fontSize: "11px", fontWeight: "bold", flex: "0 0 auto" },
  templateTitle: { color: "#FFF", fontSize: "14px", fontWeight: "bold", overflowWrap: "anywhere" },
  templateDesc: { color: TEXT, fontSize: "12px", lineHeight: 1.6, overflowWrap: "anywhere" },
  templateLayerRow: { display: "flex", gap: "6px", flexWrap: "wrap" },
  templateLayerChip: { color: "#bfdbfe", border: "1px solid rgba(147,197,253,0.24)", background: "rgba(59,130,246,0.08)", borderRadius: "999px", padding: "3px 7px", fontSize: "11px", lineHeight: 1.35 },
  fullBoardBox: { border: "1px solid rgba(74,222,128,0.25)", background: "rgba(74,222,128,0.055)", borderRadius: "8px", padding: "14px", display: "flex", flexDirection: "column", gap: "12px" },
  fullBoardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "10px" },
  fullBoardField: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 },
  fullBoardLabel: { color: "#86efac", fontSize: "12px", fontWeight: "bold", lineHeight: 1.4 },
  fullBoardTextarea: { background: "rgba(0,0,0,0.28)", color: TEXT, border: "1px solid rgba(74,222,128,0.22)", borderRadius: "6px", padding: "10px", minHeight: "86px", resize: "vertical", outline: "none", lineHeight: 1.55, fontSize: "12px", fontFamily: "inherit", boxSizing: "border-box", width: "100%" },
  fullBoardResults: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "10px" },
  fullBoardResultCard: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 },
  fullBoardResultTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" },
  fullBoardOutput: { background: "#050505", color: TEXT, border: "1px solid rgba(74,222,128,0.24)", borderRadius: "6px", padding: "10px", minHeight: "220px", resize: "vertical", outline: "none", lineHeight: 1.55, fontSize: "11px", fontFamily: "inherit", boxSizing: "border-box", width: "100%" },
  fullBoardSegmentHeader: { textAlign: "left", background: "rgba(0,0,0,0.24)", color: "#FFF", border: "1px solid rgba(74,222,128,0.22)", borderRadius: "6px", padding: "10px", cursor: "pointer", display: "flex", flexDirection: "column", gap: "4px", fontFamily: "inherit", lineHeight: 1.4 },
  fullBoardSegmentMeta: { color: MUTED, fontSize: "11px", overflowWrap: "anywhere" },
  codexJobNote: { color: "#bfdbfe", border: "1px solid rgba(147,197,253,0.28)", background: "rgba(59,130,246,0.08)", borderRadius: "6px", padding: "9px 10px", fontSize: "12px", lineHeight: 1.55, overflowWrap: "anywhere" },

  btn: { background: AMBER, color: "#000", border: "none", padding: "14px 28px", borderRadius: "6px", fontWeight: "bold", cursor: "pointer", transition: "all 0.2s ease", fontSize: "14px" },
  btnDisabled: { opacity: 0.5, cursor: "not-allowed", filter: "grayscale(100%)" },
  btnGhost: { background: "rgba(232,160,32,0.05)", color: AMBER, border: "1px solid rgba(232,160,32,0.3)", padding: "12px 20px", borderRadius: "6px", cursor: "pointer", outline: "none", transition: "all 0.2s ease", fontSize: "13px" },

  foldableHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", background: "rgba(255,255,255,0.025)", border: "1px solid " + BORDER, borderRadius: "8px", padding: "10px 12px" },
  foldableTitle: { color: "#FFF", fontSize: "13px", fontWeight: "bold" },
  foldableMeta: { color: MUTED, fontSize: "11px", marginTop: "3px", lineHeight: 1.4 },
  toggleBtn: { background: "rgba(232,160,32,0.06)", color: AMBER, border: "1px solid rgba(232,160,32,0.32)", padding: "7px 14px", borderRadius: "6px", cursor: "pointer", outline: "none", fontSize: "12px", fontWeight: "bold", flex: "0 0 auto" },
  collapsedBox: { border: "1px dashed " + BORDER, borderRadius: "8px", padding: "16px", color: MUTED, fontSize: "13px", background: "rgba(0,0,0,0.18)", textAlign: "center" },
  output: { background: "rgba(0,0,0,0.2)", border: "1px solid " + BORDER, borderRadius: "8px", padding: "24px", flex: 1, minHeight: "280px", overflowY: "auto", boxShadow: "inset 0 2px 15px rgba(0,0,0,0.2)" },
  outputActions: { display: "flex", gap: "12px", marginTop: "16px", paddingTop: "16px", borderTop: "1px solid " + BORDER, flexWrap: "wrap" },
  reviewSection: { display: "flex", flexDirection: "column", gap: "10px", marginTop: "16px" },
  reviewBox: { background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.28)", borderRadius: "8px", padding: "20px", overflowY: "auto", maxHeight: "420px" },
  projectLoadError: { margin: "10px 32px 0", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.08)", borderRadius: "6px", padding: "10px 12px", fontSize: "13px" },
  reviewError: { color: "#fca5a5", border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.08)", borderRadius: "6px", padding: "10px 12px", marginTop: "16px", fontSize: "13px" },
  imageGenSection: { display: "flex", flexDirection: "column", gap: "12px", marginTop: "16px" },
  imageSizeSelect: { background: "#000", color: TEXT, border: "1px solid " + BORDER, borderRadius: "6px", padding: "8px 10px", outline: "none", fontSize: "12px", flex: "0 0 auto" },
  imageFrameGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "12px" },
  imageFrameCard: { border: "1px solid " + BORDER, borderRadius: "8px", background: "rgba(0,0,0,0.18)", padding: "14px", display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 },
  imageFrameTop: { display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" },
  imageFrameTitle: { color: "#FFF", fontSize: "13px", fontWeight: "bold", lineHeight: 1.45, overflowWrap: "anywhere" },
  imageFrameMeta: { color: MUTED, fontSize: "11px", lineHeight: 1.5, marginTop: "4px", overflowWrap: "anywhere" },
  imagePromptPreview: { color: TEXT, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "6px", padding: "10px", fontSize: "12px", lineHeight: 1.6, maxHeight: "130px", overflowY: "auto", overflowWrap: "anywhere" },
  styleReferenceBox: { border: "1px solid rgba(147,197,253,0.24)", background: "rgba(59,130,246,0.07)", borderRadius: "6px", padding: "10px", display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 },
  styleReferenceHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", color: "#bfdbfe", fontSize: "12px", fontWeight: "bold", flexWrap: "wrap" },
  styleReferenceControls: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "8px", alignItems: "center" },
  styleReferenceSelect: { background: "#050505", color: TEXT, border: "1px solid rgba(147,197,253,0.28)", borderRadius: "6px", padding: "7px 9px", outline: "none", fontSize: "12px", minWidth: 0 },
  styleReferenceActions: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" },
  repaintEmphasisControls: { display: "grid", gridTemplateColumns: "auto minmax(150px, 1fr)", gap: "8px", alignItems: "center" },
  styleReferenceUploadBtn: { background: "rgba(147,197,253,0.1)", color: "#bfdbfe", border: "1px solid rgba(147,197,253,0.36)", padding: "7px 9px", borderRadius: "6px", fontSize: "11px", cursor: "pointer", fontWeight: "bold", whiteSpace: "nowrap" },
  styleReferenceMiniBtn: { background: "rgba(0,0,0,0.24)", color: "#bfdbfe", border: "1px solid rgba(147,197,253,0.3)", padding: "7px 9px", borderRadius: "6px", fontSize: "11px", cursor: "pointer", fontWeight: "bold", whiteSpace: "nowrap" },
  styleReferencePreview: { display: "flex", gap: "8px", alignItems: "center", minWidth: 0 },
  styleReferenceThumb: { width: "72px", aspectRatio: "16 / 10", objectFit: "cover", borderRadius: "5px", border: "1px solid rgba(147,197,253,0.28)", background: "#000", flex: "0 0 auto" },
  generatedImageList: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px" },
  generatedImageItem: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 },
  generatedImageThumb: { width: "100%", aspectRatio: "16 / 10", objectFit: "cover", borderRadius: "6px", border: "1px solid " + BORDER, background: "#000" },
  generatedImagePath: { color: MUTED, fontSize: "10px", lineHeight: 1.4, overflowWrap: "anywhere" },
  assetStrip: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", border: "1px solid rgba(74,222,128,0.2)", background: "rgba(74,222,128,0.06)", borderRadius: "8px", padding: "10px" },
  assetChip: { display: "inline-flex", alignItems: "center", gap: "6px", border: "1px solid rgba(239,68,68,0.28)", color: "#fca5a5", borderRadius: "999px", padding: "5px 9px", fontSize: "11px", background: "rgba(239,68,68,0.06)" },
  assetChipReady: { borderColor: "rgba(74,222,128,0.35)", color: "#86efac", background: "rgba(74,222,128,0.08)" },
  assetChipThumb: { width: "22px", height: "22px", borderRadius: "999px", objectFit: "cover", border: "1px solid rgba(255,255,255,0.18)" },
  assetChipStatus: { color: MUTED, fontSize: "10px" },
  assetProgress: { color: "#86efac", border: "1px solid rgba(74,222,128,0.28)", background: "rgba(74,222,128,0.07)", borderRadius: "6px", padding: "9px 12px", fontSize: "12px" },
  assetHelp: { color: TEXT, background: "rgba(255,255,255,0.03)", border: "1px solid " + BORDER, borderRadius: "8px", padding: "12px", fontSize: "13px", lineHeight: 1.7, marginBottom: "16px" },
  assetGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "12px" },
  assetCard: { border: "1px solid " + BORDER, borderRadius: "8px", background: "rgba(0,0,0,0.22)", padding: "12px", display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 },
  assetCardTop: { display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "flex-start" },
  assetTitle: { color: "#FFF", fontWeight: "bold", fontSize: "14px" },
  assetMeta: { color: MUTED, fontSize: "11px", lineHeight: 1.5, overflowWrap: "anywhere" },
  assetPreview: { width: "100%", aspectRatio: "16 / 10", objectFit: "cover", borderRadius: "6px", border: "1px solid " + BORDER, background: "#000" },
  assetEmpty: { width: "100%", aspectRatio: "16 / 10", borderRadius: "6px", border: "1px dashed " + BORDER, color: MUTED, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", background: "rgba(255,255,255,0.02)" },
  assetUploadBtn: { textAlign: "center", background: "rgba(74,222,128,0.12)", color: "#86efac", border: "1px solid rgba(74,222,128,0.35)", padding: "8px 10px", borderRadius: "6px", fontSize: "12px", cursor: "pointer", fontWeight: "bold" },
  assetDeleteBtn: { background: "rgba(239,68,68,0.08)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "5px", padding: "5px 8px", cursor: "pointer", fontSize: "11px" },
  empty: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: BORDER, fontSize: "15px", fontWeight: "bold", letterSpacing: "1px" },

  modalOverlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.85)", zIndex: 999, display: "flex", justifyContent: "center", alignItems: "center", backdropFilter: "blur(8px)" },
  modalContent: { background: SURFACE, border: "1px solid " + BORDER, borderRadius: "12px", width: "850px", maxWidth: "95%", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 50px rgba(0,0,0,0.7)" },
  modalHeader: { padding: "20px 32px", borderBottom: "1px solid " + BORDER, display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(255,255,255,0.02)" },
  closeBtn: { background: "none", border: "none", color: MUTED, fontSize: "28px", cursor: "pointer", outline: "none", transition: "color 0.2s ease" },
  modalBody: { padding: "32px", overflowY: "auto", flex: 1 },
  modalH3: { fontSize: "15px", color: AMBER, marginTop: "0", marginBottom: "20px", borderBottom: "1px solid " + BORDER, paddingBottom: "10px", fontWeight: "bold" },
  configCard: { background: "rgba(0,0,0,0.3)", border: "1px solid " + BORDER, padding: "20px", borderRadius: "8px", marginBottom: "24px" },
  inputGroup: { display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" },
  row: { display: "flex", gap: "20px" },
  promptTabs: { background: "rgba(0,0,0,0.2)", padding: "20px", borderRadius: "8px", border: "1px solid " + BORDER },
  promptInput: { background: "#000", border: "1px solid " + BORDER, color: TEXT, padding: "16px", borderRadius: "6px", width: "100%", resize: "vertical", fontSize: "13px", outline: "none", boxSizing: "border-box", fontFamily: "inherit", lineHeight: 1.6 },
  resetBtn: { background: "transparent", border: "none", color: "#ef4444", fontSize: "13px", cursor: "pointer", outline: "none", opacity: 0.8 },
  modalFooter: { padding: "20px 32px", borderTop: "1px solid " + BORDER, display: "flex", justifyContent: "flex-end", gap: "16px", background: "rgba(0,0,0,0.2)" }
};

if (typeof document !== "undefined") {
  const existingTag = document.getElementById("micro-epic-styles");
  if (existingTag) existingTag.remove();

  const styleTag = document.createElement("style");
  styleTag.id = "micro-epic-styles";
  styleTag.textContent = "" +
    "::-webkit-scrollbar { width: 8px; height: 8px; }\n" +
    "::-webkit-scrollbar-track { background: transparent; }\n" +
    "::-webkit-scrollbar-thumb { background: " + BORDER + "; border-radius: 4px; }\n" +
    "::-webkit-scrollbar-thumb:hover { background: " + MUTED + "; }\n" +
    "button { transition: all 0.2s ease-in-out !important; }\n" +
    "button:not([disabled]):hover { transform: translateY(-1px); }\n" +
    "button[style*='background: " + AMBER + "']:not([disabled]):hover { background: " + AMBER_HOVER + " !important; box-shadow: 0 4px 15px rgba(232,160,32,0.3); }\n" +
    "button[style*='border: 1px solid rgba(232,160,32,0.3)']:not([disabled]):hover { background: rgba(232,160,32,0.15) !important; }\n" +
    ".closeBtn:hover { color: #FFF !important; transform: none !important; }\n" +
    "textarea:focus { border-color: " + AMBER + " !important; box-shadow: inset 0 0 0 1px rgba(232,160,32,0.2); }\n" +
    ".markdown-body { color: " + TEXT + "; }\n" +
    ".markdown-body h1, .markdown-body h2, .markdown-body h3 { color: #FFF; margin-top: 0; padding-bottom: 8px; border-bottom: 1px solid " + BORDER + "; }\n" +
    ".markdown-body h4 { color: " + AMBER + "; }\n" +
    ".markdown-body strong { color: " + AMBER + "; }\n" +
    ".markdown-body table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px; border-radius: 8px; overflow: hidden; }\n" +
    ".markdown-body th, .markdown-body td { border: 1px solid " + BORDER + "; padding: 12px 16px; text-align: left; }\n" +
    ".markdown-body th { background: rgba(232,160,32,0.1); color: " + AMBER + "; font-weight: bold; }\n" +
    ".markdown-body tr:nth-child(even) { background: rgba(255,255,255,0.02); }\n" +
    ".markdown-body pre { background: #000 !important; padding: 16px; border-radius: 8px; overflow-x: auto; border: 1px solid " + BORDER + "; box-shadow: inset 0 2px 10px rgba(0,0,0,0.5); }\n" +
    ".markdown-body code { font-family: 'Fira Code', monospace; color: " + AMBER_HOVER + "; white-space: pre-wrap; font-size: 12px; }\n" +
    ".markdown-body p code { background: rgba(232,160,32,0.1); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(232,160,32,0.2); }\n" +
    ".markdown-body blockquote { border-left: 4px solid " + AMBER + "; padding-left: 16px; color: " + MUTED + "; background: rgba(232,160,32,0.05); margin: 0 0 16px 0; padding: 12px 16px; border-radius: 0 6px 6px 0; }\n";
  document.head.appendChild(styleTag);
}
