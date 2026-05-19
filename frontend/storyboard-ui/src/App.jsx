import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const PIPELINE_RUN_ID_KEY = "storyboard_pipeline_run_id";
const API_BASE = "http://127.0.0.1:8001";
const IMAGE_MODEL_PRESETS = [
  {
    label: "GPT Image",
    model: "gpt-image-2",
    url: "https://yibuapi.com/v1",
    note: "保留原有 GPT 生图流程，支持当前 reference_images 兼容重试。"
  },
  {
    label: "FLUX 2 Pro",
    model: "flux-2-pro",
    url: "https://yibuapi.com/v1",
    note: "走 /v1/images/generations + aspect_ratio；当前通道若报 endpoint not supported，需要换 FLUX 生图渠道。"
  },
  {
    label: "FLUX Kontext",
    model: "flux-kontext-pro",
    url: "https://yibuapi.com/v1",
    note: "有参考图时走 /v1/images/edits，更适合角色或上一帧一致性。"
  }
];

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

const normalizeSceneAssetPrompt = (prompt = "", description = "") => {
  const base = (prompt || description || "")
    .replaceAll("3D半写实梦幻动物动画风格", "3D半写实梦幻动画电影场景风格")
    .replaceAll("3D半写实梦幻动物动画", "3D半写实梦幻动画电影场景")
    .replaceAll("3D semi-realistic dreamy animal animation style", "3D semi-realistic dreamy animated film environment style")
    .replaceAll("dreamy animal animation style", "dreamy animated film environment style")
    .trim();
  const fallback = description || "森林场景参考图，电影级CG质感，16:9";
  return `${base || fallback}

【场景参考图硬约束】
这是一张空场景资产/环境定场图，用于后续角色合成。画面中不要出现香蕉猫、刀盾狗或任何其他动物、人物、拟人角色；不要出现兔子、狐狸、鹿、熊、水獭、小狗、小猫等生物；不要出现文字、标注、水印、设计图排版。
可读动画电影场景空间，不是显微镜视角、微距摄影或苔藓局部素材。若项目是香蕉猫/刀盾狗或剧本明确“小生命面对大世界”，允许童话微缩花园尺度：花朵、叶片、蘑菇、草坡或道具可明显大过角色。可以靠近角色高度、中低机位、斜俯拍或俯拍观察，有少量前景草叶/雨滴/叶片自然虚化遮挡，但远景森林、山谷、水道、树根结构或光束必须可读，不要背景完全虚化。
治愈童话场景优先采用“童话地标物 + 柔软自然地表舞台 + 前景叶片/花草包围 + 可读森林纵深 + 少量透明空气感 + 暖光斑”的构成；童话地标物可以是向日葵、雏菊、粉色蘑菇、树根拱门、浅溪石头、藤蔓秋千、苔藓木桥等，每场选择1-2个即可。
雾只能作为极轻透明水汽或远景空气透视，不得成为主视觉。除非用户明确要求悬疑/惊悚，不要使用浓雾、厚雾、冷青绿浓雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、神秘恐怖、惊悚、悬疑、写真摄影感。
草地、苔藓和森林地面必须是真实自然材质：草叶长短不一、疏密不均，混有裸露泥土、落叶、小石子、湿润暗部、自然杂草和局部踩压痕迹；禁止塑料草皮、人工草坪、网格草地、重复编织纹理或像一张塑料网。
保留中景角色活动留白，只允许出现提示词明确要求的环境道具，例如树根、石坡、水珠、光斑、水面、浮叶。`;
};

const _extractShotBindMap = (text = "") => {
  const map = {};
  const source = text || "";
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
  const sceneCards = source.split(/\n(?=###\s+场景卡)/g);
  const assets = {};
  sceneCards.forEach(section => {
    const sceneMatch = section.match(/###\s+场景卡\s*·\s*\|\s*(S\d+)\s*\|[^\r\n]*/);
    const promptMatch = section.match(/(?:\*\*)?(?:(?:即梦中文|MJ英文)\s*)?场景生图提示词(?:\*\*)?\s*[:：]?\s*(?:\r?\n)?```(?:[a-zA-Z]*)?\s*([\s\S]*?)```/);
    const lockMatch = section.match(/(?:\*\*)?完整场景锁定描述[^：:]*[:：](?:\*\*)?\s*(?:\r?\n)?([\s\S]*?)(?=\r?\n\*\*|\r?\n###|\r?\n---|$)/);
    const structuredPrompt = (promptMatch?.[1] || lockMatch?.[1] || "").trim();
    const idLines = [...section.matchAll(/@图片\s*(\d+)[^：:\r\n]*[：:]\s*([^\r\n]+)/g)];
    idLines.forEach(match => {
      const id = Number(match[1]);
      if (id >= 10 && id <= 49) {
        const description = (match[2] || "").replace(/\*\*/g, "").trim();
        const hasStructuredPrompt = Boolean(structuredPrompt);
        const candidate = {
          id,
          sceneId: sceneMatch?.[1] || (id >= 10 && id <= 49 ? `S${id - 9}` : ""),
          description,
          hasStructuredPrompt,
          prompt: normalizeSceneAssetPrompt(
            structuredPrompt || `${description}，3D半写实梦幻动画电影场景风格，电影级CG质感，16:9`,
            description
          ),
        };
        if (!assets[id] || (hasStructuredPrompt && !assets[id].hasStructuredPrompt)) {
          assets[id] = candidate;
        }
      }
    });
  });
  return assets;
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

const compactForBoardPrompt = (text = "", limit = 1800) => {
  const source = stripCompletionEndMarker(text || "").trim();
  if (source.length <= limit) return source;
  const head = source.slice(0, Math.floor(limit * 0.62)).trim();
  const tail = source.slice(-Math.floor(limit * 0.32)).trim();
  return `${head}\n\n...[中间内容已压缩，保留首尾关键上下文]...\n\n${tail}`;
};

const compactHeadForBoardPrompt = (text = "", limit = 1200) => {
  const source = stripCompletionEndMarker(text || "").trim();
  if (source.length <= limit) return source;
  return `${source.slice(0, limit).trim()}\n\n...[后续内容省略，避免污染当前15秒片段]`;
};

const extractBulletBlock = (section = "", label = "") => {
  const pattern = new RegExp(
    `-\\s*${label}\\s*[:：]\\s*(?:\\r?\\n)?([\\s\\S]*?)(?=\\r?\\n-\\s*[^\\r\\n：:]{1,32}\\s*[:：]|\\r?\\n###\\s+生成单元|\\r?\\n\\*\\*本场提交顺序表|\\r?\\n---|$)`
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
  return Math.min(8, Math.max(byDuration, Math.min(8, unitCount || 1)));
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
      emotion: compactBoardLine(unit.emotion || "按源分镜情绪推进", 42),
      handoff: compactBoardLine(unit.handoff || "保持角色位置、朝向和动作动势连续", 70),
      refs: compactBoardLine(unit.refs || "角色原图 + 当前场景图", 54),
    };
  });
};

const formatFramePlanForBoardPrompt = (frames = []) => (
  frames.map(frame => (
    `镜${frame.no}｜${formatDurationValue(frame.duration)}s｜源：${frame.sourceId}｜${frame.phaseLabel}
- 场景/参考：${frame.sceneLabel}；${frame.refs}
- 镜头类型/运镜：${frame.camera}
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

const buildSegmentJimengPrompt = ({
  projectTitle,
  segment,
  segmentIndex,
  totalSegments,
  boardDurationLabel,
  boardFrameCount,
  framePlan,
  styleText,
}) => {
  const sourceRange = `${segment.units[0]?.id || ""} 至 ${segment.units[segment.units.length - 1]?.id || ""}`;
  return `请根据我上传的“${projectTitle} 第 ${segmentIndex + 1}/${totalSegments} 段 ${boardDurationLabel}全案分镜图”生成连贯视频。

【总要求】
片段范围：${sourceRange}
总时长：${boardDurationLabel}
分镜数量：${boardFrameCount}格，严格按参考图从左到右、从上到下执行，不要打乱顺序，不要强行拉长到15秒。
参考图中的编号、网格线、中文说明只作为导演分镜参考，成片中不要出现字幕、文字、水印、分镜格线或乱码。
保持两个角色的外形、比例、道具、站位关系、场景方向、光线氛围和动作节奏连续；不要新增角色，不要新增无关道具，不要跳帧，不要风格漂移。

【逐镜执行表】
${formatFramePlanForJimeng(framePlan)}

【连贯性锁定】
上一格的角色位置、朝向、身体动势、视线方向、道具高低和环境光变化必须自然接到下一格。动作要轻微连续，避免每格都像重新摆拍。
角色脸部和道具不要变形；小动作优先用停步、靠近、回头、轻碰、放低武器/盾牌、共同看向同一处来表达。

【视觉风格】
${styleText || "3D半写实梦幻动物动画，电影级CG质感，柔和自然光，背景空间可读。"}

【负面约束】
不要出现字幕、解释文字、分镜板边框、网格线、水印、logo；不要新增剧情、提前表现后续片段、改变角色外观、改变场景方向、出现第三主角、动作断裂、镜头跳切、低清晰度、脸崩或道具消失。`;
};

const parseShotUnitsForBoard = (shotText = "", visualText = "") => {
  const source = stripCompletionEndMarker(shotText || "");
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
    const wouldOverflow = current.length > 0 && (total + duration > 15.5 || current.length >= 8);
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
请基于我上传的两张角色参考图，以及下方已经完成的剧本、视觉开发/场景设计、分镜生成单元，生成一张单张 16:9 宽高比的“即梦视频执行型高密度全案分镜规划板”。这不是单张插画，也不是只给人看的美术氛围板；它要让即梦同时读取画面和对应文字后能生成连贯视频。

项目：${projectTitle}
片段：第 ${segmentIndex + 1}/${totalSegments} 段
片段来源：${sourceRange}
源分镜估算时长：${Number(segment.duration || 15).toFixed(1)} 秒
本图目标成片时长：${boardDurationLabel}
当前片段场景：${involvedSceneIds.map(id => `| ${id} |`).join("、") || "未识别"}

必须是完整全案分镜图，不是单张插画。版面按从左到右、从上到下的阅读顺序组织，镜头顺序一眼可读。总时长严格保持为 ${boardDurationLabel}，不要强行拉伸或压缩成15秒；共 ${boardFrameCount} 个分镜格，每个镜头标注精确时长；建议时长分配：${frameTimingText}。可以把源分镜单元拆细或合并成 ${boardFrameCount} 个视觉节拍，但不得新增剧情、不得改变因果顺序。

核心目标：每一格都必须同时有“画面动作”和“可执行文字说明”。不要只写镜号和一句短标题；每格说明至少包含镜头/运镜、动作&情绪、灯光/氛围、衔接状态四类信息。

【本片段硬边界】
- 本图只表现当前片段 ${sourceRange}，不得画出其他生成单元、其他场景或全片后续结尾。
- ${boardFrameCount}个分镜格只是对当前源分镜单元的视觉节拍拆分，不允许新增剧情、提前剧透、改变因果顺序。
- 如果下方全片背景里提到后续地点、后续情绪峰值或结局，只作为理解世界观，绝对不要画进本段。
- @图片编号只是内部文本索引，本次实际上传给 GPTImage2 的参考图只有两张角色图；场景请按文字描述和当前片段场景卡自行还原。

【两张角色参考图使用规则】
${characterRefs || "角色A：使用我上传的第一张角色参考图。\n角色B：使用我上传的第二张角色参考图。"}
两张角色参考图是唯一角色锚点。必须保持角色外形、颜色、体型、服装/道具/标志性特征全程一致，只允许姿态、表情和动作随剧情变化。禁止新增第三个主角或改变角色身份。

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
- 标题放大加粗：${projectTitle} 第 ${segmentIndex + 1} 段 ${boardDurationLabel}全案分镜图。
- 统一规范：总镜头数${boardFrameCount}个，总时长${boardDurationLabel}，全片统一画幅16:9。
- 统一环境规则：严格继承阶段二场景卡和阶段四场景图设计，空间逻辑连贯，无重复相似镜头。
- 统一动作规则：${boardFrameCount}个镜头组成一个连续动作链，不能只是${boardFrameCount}张氛围图。
- 即梦执行规则：每个镜头的文字说明必须和画面动作一一对应，文字不能只写诗意短句。
- 片段边界规则：只画 ${sourceRange}，不要画后续片段内容。

【上半区左栏·角色与风格参考区】
展示两个角色的稳定形象参考：正面/侧面/表情特写/关键道具或身体特征。每个角色旁用短标签标注“角色锚点、允许变化、禁止跑偏”。角色必须与上传参考图高度一致，不要重新设计角色。该区域保持清晰，不超过整张图的20%。

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
禁止画出当前片段以外的后续剧情、禁止提前出现后续场景、禁止场景重复相似、禁止内容过度简单、禁止文字描述过少、禁止只有氛围图没有动作链、禁止模糊不清、禁止乱码伪文字、禁止长文本段落、禁止排版混乱、禁止画面元素溢出网格、禁止新增主角、禁止改变角色外观、禁止角色脸崩、禁止低分辨率、禁止卡通化过度、禁止二次元风格、禁止网红感、禁止多余装饰元素、禁止水印、禁止logo。`;
};

const STYLE_PRESETS = {
  cute_3d: {
    name: "🧸 3D半写实梦幻动物动画 (默认)",
    color: "#E8A020",
    script_patch: `【当前风格参考：3D半写实梦幻动物动画】
- 可参考的气质：真实毛发与细腻材质、柔和自然光、梦幻森林、软萌但不过度幼稚的动物童话感、轻喜剧或温暖冒险。
 - 尺度策略：不要写成显微镜式微距素材；如果主角是香蕉猫/刀盾狗，优先采用童话微缩花园尺度，让花朵、叶片、蘑菇、草坡或道具明显大过角色，形成“小生命面对大世界”的包围感。普通森林、花园、草地也要保留周围风景和空间美。
- 表达策略：香蕉猫、刀盾狗这类软萌非人角色默认不说话，不写对白、画外音自述或内心独白；用少量普通肢体语言交流，例如停步回头、轻碰同伴、递出盾、靠近一步、一起看向同一处。
- 请把它当成美术、类型和表达方向，不要当成剧情硬约束；具体表情、动作和场面由故事自然决定。`,
    shot_patch: `【当前风格约束：3D半写实梦幻动物动画】
- 运镜策略：原片更接近“安静观察 + 角色高度亲近 + 适时斜俯拍/俯拍交代空间 + 少量柔和推轨”。优先使用静止锁定、极缓慢推近/拉远、横向跟随、前景叶片/树干遮挡转场、角色向镜头靠近造成景别变化；少用手持晃动，禁止每个生成单元都写“手持轻微晃动”。
- 镜头组合：每个场景至少有一个中景/中近景双人关系镜头、一个环境尺度镜头、一个服务触感或物理反应的近景/特写/插入镜头。环境尺度镜头可以是低机位全景、大全景、斜俯拍或俯拍，用来交代路径、花田/森林尺度和“小生命面对大世界”；不要全片只用低机位。
- 剪辑节奏：硬切为主，切点落在状态变化上；安静奇观/关系确认4-8秒，物理笑点/反应2-4秒。升格仅用于关键治愈瞬间，不使用动作片式甩镜、绕拍、快摇。
- 风格词（必须出现在每个生成单元末尾）：3D半写实梦幻动物动画，真实毛发质感，柔和自然光，梦幻森林，电影级CG质感，角色软萌但不过度卡通，材质细腻，自然景深，背景空间可读。
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
  cute_3d: "3D半写实梦幻动物动画：软萌但不过度幼稚，奇幻自然环境，小生命面对大世界，默认少对白或无对白，主要靠动作、道具、环境变化表达情绪。",
  action: "动作格斗片：节奏更快，冲突更强，但动作必须服务角色目标和关系变化，不要为了打斗而打斗。",
  literary: "文艺情绪片：节奏舒展，重视沉默、关系细节和情绪余波，但每个灵感仍必须有清晰的可见行动变化。",
  none: "通用短片模式：根据用户要求判断类型和气质，优先保证故事目标、阻碍、转折和可拍性。"
};

const BOARD_STYLE_HINTS = {
  cute_3d: "3D半写实梦幻动物动画电影质感，真实毛发与细腻材质，柔和自然光，治愈童话森林，电影级CG渲染，软萌但不过度卡通，背景空间清楚可读。",
  action: "电影级动作片质感，手持摄影呼吸感，高对比光影，真实材质，动作节奏清晰，冲突强但镜头逻辑可读。",
  literary: "文艺电影质感，柔和自然光，克制构图，细腻情绪，真实空间层次，安静但有明确动作推进。",
  none: "电影级短片视觉质感，风格完全服从剧情设定，角色一致，场景连贯，镜头顺序清楚。"
};

const DEFAULT_PROMPTS = {
  /* ========== 阶段一：剧本（导演模式创作） ========== */
  script: `你是这部片子的编剧兼导演，按真实短剧/动画项目的剧本制式工作。你的任务不是写设定说明，也不是写 AI 视频提示词，而是交付一份可阅读、可拍摄、可继续交给美术和分镜部门拆解的正式剧本。

后台参考只提供角色基本设定和创作方向。你要调用自己的类型片经验、场面调度经验、人物关系判断、节奏判断和对白能力来创作，不要复述资料，不要执行清单。

【创作方式】
1. 先确定故事摘要：主角、故事类型、故事梗概、故事背景、故事设定、一句话故事。
2. 再写剧本正文：按集或段落推进，每集有标题、要素表、道具、动作行、对白和卡点。
3. 动作行用“△”开头，写画面中实际发生的事、人物动作、环境变化和节奏停顿。
4. 对白按“角色名（状态/语气）：对白”书写；需要画外音时用“角色名（vo）：”，需要内心/旁白时用“角色名（os）：”。但如果主角是香蕉猫、刀盾狗这类不会讲话的角色，它们不能出现对白、vo 或 os，只能通过少量普通肢体语言交流。
5. 每一集/每一场要有明确戏剧推进：有人物目标、阻力、转折或余味。不要只堆氛围。
5a. 每个场号都必须包含一个温柔但明确的“小戏剧动作”：角色想做什么、遇到什么阻力、做出什么选择、造成什么结果。治愈片也不能只写一路看风景。
5b. 全片至少要有一条关系变化弧：例如一开始谁跟随谁、谁误判了环境、谁拖慢了节奏；中段通过一次小麻烦改变相处方式；结尾用一个可看见的动作证明关系已经变化。
6. 如果用户明确要求连续短剧，可以按第1集、第2集、第3集展开；如果用户只要求一条短片或没有指定集数，可以只写“第1集”或“第一段”，并在其中用多个场号承载完整故事，不要为了格式强行凑集数。
7. 90 秒左右的短片不能只围绕一个事件、一个道具或一次追逐拉长。请把它写成一段小旅程：通常需要 4-6 个场号，每个场号带来新的地点、新的有趣事件、新的角色关系变化或新的宏观视觉奖励。单一锚点道具可以串联全片，但不能替代全部剧情。
8. 每个场号都要回答一个“新鲜感问题”：这里和上一场有什么不同？角色遇到了什么新的小麻烦/小发现？观众看到了什么新的空间、景象或关系变化？如果答案只是“继续追同一个东西”，就必须改写。
8a. 环境奇观必须由角色行动触发、阻碍或奖励角色行动；不要把场景写成“到达新地点后欣赏风景”的陈列。
9. 每个场号的“道具”必须列出本场会参与动作的关键物件，也包括角色永久附属物；例如刀盾狗用到圆盾时，道具栏必须写“小圆盾”，不要写“无”。
10. 不要发明角色设定未提供的身体部位或永久特征。若角色设定没有明确尾巴、翅膀、长手指等，就不要写这类动作；改用已知部位或道具完成交流。
11. 剧本阶段不要提前写镜头术语，例如“俯视镜头”“镜头拉远”“广角远景”。请改成画面可见的自然描述，例如“从高处望去”“视野逐渐展开”“远处整片森林被阳光照亮”。
12. 肢体交流只写观众能看见的动作，不要把动作翻译成说明书。少写“示意、表示、说明自己担心”，多写“停步回头、把盾挪到同伴脚边、靠近半步、一起看向同一处”。
13. 如果用户目标或项目气质是治愈、童话、软萌、轻冒险，阻力必须低危险、可触摸、可玩耍，例如花丛遮挡、树根小坡、浅溪石头、蘑菇弹性、叶片桥、阳光/水纹方向错误。不要把浓雾、黑暗、深水、断崖、暗区、惊吓或悬疑作为核心机制。
14. 治愈童话场景要优先设计“一眼可记住的童话地标物 + 中景可表演的小舞台”，例如向日葵花田、雏菊坡、树根拱门、粉色蘑菇地、藤蔓秋千、浅溪边、柔软苔藓木桥；雾只能是轻透明空气感，不能成为主角。

【格式要求】
请严格使用以下制式输出。示例里的剧情内容不要模仿，模仿的是格式。
所有方括号内容都必须根据用户需求实际填写，禁止保留 [主角名]、[本集标题]、[...] 这类模板占位符。

视频风格:
[例如：2D, 日漫, 半厚涂 / 3D, 治愈童话 / 写实电影感。按用户需求和项目气质判断]
画面比例:
[默认 16:9，除非用户指定其他比例]

剧本摘要
主角
[主角名]
故事类型
[男频/女频/治愈/奇幻/冒险/喜剧/悬疑等，按项目判断]
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
- 香蕉猫、刀盾狗说话、画外音自述或内心独白；它们的交流应是少量、普通、清楚的肢体动作，例如停步回头、轻碰同伴、递出盾、靠近一步、一起看向同一处。不要写得油腻、夸张或像人类手势表演。
- 漏写本场参与动作的道具；发明未设定身体部位；在剧本阶段写“镜头、俯视、拉远、广角”等分镜术语；用解释性文字翻译角色肢体语言。

输出前请在内部确认：包含视频风格、画面比例、剧本摘要、剧本内容、至少一个“① 场号”、动作行“△”、以及“【定格卡点】”。不要把检查过程写出来。

请直接输出完整剧本，不要解释创作过程。`,

  /* ========== 阶段二：视觉开发（在光里思考） ========== */
  visual: `你是这部短片的视觉开发导演。你刚拿到剧本，现在要把它转化成“固定要素库包”：角色如何始终长得一样，场景如何始终认得出来，哪些参考图必须先生成，后续分镜应该如何直接引用角色原图。

后台知识库会提供角色卡、场景卡、@图片编号和锁定语法的标准。你只需要把标准落实成清楚、可复用、可复制的视觉资产。

【工作方法】
先读完整剧本，找到三个观众会屏住呼吸的瞬间。所有视觉设计都服务这三个瞬间：颜色分离、光线方向、前中后景层次、关键道具的材质，都要让这些瞬间更容易被看见。

不要改剧情，不写运镜，不写视频提示词。你负责“看见并固定”：角色外形、场景空间、道具、材质、颜色、光线、参考图编号。

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

【场景参考图审美新规则】
1. 场景图是空场景资产，不出现角色、动物、人物、拟人角色或额外生物。
2. 默认尺度是可读动画电影场景里的近角色观察，不是显微镜视角、微距摄影或苔藓局部素材。若剧本/IP是香蕉猫、刀盾狗或明确“小生命面对大世界”，允许童话微缩花园尺度：花朵、叶片、蘑菇、草坡或道具可明显大过角色。
3. 场景卡可以设计“角色高度附近的观察点”和少量前景草叶/雨滴/叶片自然虚化，但必须保留中景表演留白和后景可读风景。
4. 空场景图要让人看见周围风景的美丽：森林、山谷、水道、树根结构、光束、远处空间出口至少有一个明确可读；雾只能作为极轻透明水汽或远景空气透视，不能成为主视觉。
4a. 治愈童话场景优先采用“童话地标物 + 柔软自然地表舞台 + 前景叶片/花草包围 + 可读森林纵深 + 少量透明空气感 + 暖光斑”的构成；童话地标物可以是向日葵、雏菊、粉色蘑菇、树根拱门、浅溪石头、藤蔓秋千、苔藓木桥等。
4b. 除非用户明确要求悬疑/惊悚，不要使用浓雾、厚雾、冷青绿浓雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、神秘恐怖、惊悚、悬疑、写真摄影感。
5. 禁止默认使用“显微镜视角、微距摄影、露珠湖泊、极浅景深、背景完全虚化、只拍一小块苔藓/叶片/水滴”等旧素材化风格词。童话微缩、巨型叶片等尺度词只在剧本/IP明确需要“小生命面对大世界”时使用。
6. 草地/苔藓/森林地面必须避免塑料感：写成长短不一的草簇、裸露泥土、落叶、小石子、湿润暗部、自然杂草和踩压痕迹；禁止人工草坪、网格草地、重复编织纹理。

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
**角色原图引用写法（Stage 3 常规使用）**：[角色名]（@图片X）
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
**场景参考图**：@图片10 ...；@图片11 ...
**场景生图提示词**：[按当前选择的模式输出：即梦中文场景生图提示词 或 MJ英文场景生图提示词。一次只输出一种，不要双语并列。]
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

【边界提醒】
你可以写得有审美，但每个审美判断都要落到颜色、材质、光线、空间层次或参考图编号上。不要把同一个审美判断拆成多句重复描述。`,

  /* ========== 阶段三：分镜提示词（用光说话） ========== */
  shot: `你是这部短片的分镜导演兼即梦提示词总装师。你手里有 Stage 1 剧本和 Stage 2 固定要素库包。现在要把它们拍成可提交的生成单元，而不是机械翻译成提示词。

后台知识库会提供运镜、镜头语言、时长和即梦写法。你只需要把这些规则变成自然、精确、有导演意图的分镜包。

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
  image: `你是这部短片的场景资产制片和生图提示词总装师。你手里有 Stage 1 剧本、Stage 2 固定要素库包、Stage 3 即梦分镜提示词包。现在只整理“空场景图”生图清单，用于后续把场景图和角色原图一起交给即梦作为视频参考。

核心目标：不再生成关键帧、首帧、尾帧、姿势图或角色状态图。角色一致性交给 @图片1-9 的角色原图；你只为每个真实场景生成 @图片10-49 的空场景资产。

【工作原则】
1. 以 Stage 2 的“场景卡 · | S? |”为唯一场景来源；不要新增、合并、改名或重排场景。
2. 每个场景只保留 1 张核心场景图，必要时最多 2 张变体；编号只能使用 @图片10-49。
3. 场景图必须是空场景或道具场景：不要出现主角、动物、人物、拟人角色、额外生物、文字、水印。
4. 场景图要给即梦视频提供稳定背景：可读电影场景空间、少量前景遮挡、中景表演留白、后景地标、光线方向、关键道具位置必须清楚；香蕉猫/刀盾狗可使用童话微缩花园尺度。
5. 生图 prompt 不写视频时长、音效、运镜、镜头运动、首尾帧、动作瞬间；只写静态环境资产。
6. 如果 Stage 2 已有“场景生图提示词”，优先压缩和强化它；如果缺失，就根据场景锁定描述补齐。
7. 负面约束短而硬，重点防止角色入画、额外生物、文字水印、错误场景、画风漂移。
8. 场景图不是显微镜/微距局部素材。每条 prompt 必须写明：可读动画电影场景空间、角色高度/中低机位/斜俯拍/俯拍按空间任务选择，中景留白、后景风景可读、自然景深不过度虚化；若是香蕉猫/刀盾狗，可写童话微缩花园尺度。
9. 禁止把一小块苔藓、几片叶子、一滴水珠当成完整场景；即使有水珠/叶片细节，也必须同时看见可用的周围风景和空间纵深。
10. 草地、苔藓或森林地面必须写成非均匀自然材质：草簇长短不齐、疏密变化、混有泥土、落叶、小石子、湿润暗部和局部踩压痕迹；禁止塑料草皮、人工草坪、网格草地、重复纹理。
11. 每张场景图必须先判断“空间任务”：入口、过渡、阻碍、转折、开阔收束之一。prompt 要体现该任务，而不是只堆梦幻森林元素。
12. 四张或多张连续场景必须有明确视觉递进：童话地标物、冷暖光线、视野开阔度、地形结构、地标大小或水面/石阶/树根路径至少变化两项。不要把“雾气浓淡”作为主要递进手段；雾只能是极轻透明水汽或远景空气透视。
12a. 治愈童话场景优先采用“童话地标物 + 柔软自然地表舞台 + 前景叶片/花草包围 + 可读森林纵深 + 少量透明空气感 + 暖光斑”的构成；每场至少有一个一眼可记住的地标物，例如向日葵、雏菊、粉色蘑菇、树根拱门、浅溪石头、藤蔓秋千、苔藓木桥。
12b. 除非用户明确要求悬疑/惊悚，不要使用浓雾、厚雾、冷青绿浓雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、神秘恐怖、惊悚、悬疑、写真摄影感。
13. 每条 prompt 生成前在内部自检：无角色；中景有可合成空白区；远景可读；构图有引导线；材质不塑料；与上一场有视觉差异。不要把自检过程写进最终输出。

【输出格式】
# [项目名] · 场景图生图清单

## 一、执行策略
- 目标：只生成空场景图，供即梦与角色原图组合参考
- 图片编号范围：@图片10-49
- 不生成内容：关键帧、首帧、尾帧、姿势图、角色状态图、@图片50+
- 默认尺寸建议：GPT 使用 1536x1024；FLUX 使用 aspect_ratio: 16:9
- 使用方式：每个视频生成单元提交角色图 @图片1-9 + 对应场景图 @图片10-49

## 二、场景图总表
| @编号 | 场景编号 | 场景名 | 用途 | 是否生成 |
|---|---|---|---|---|
| @图片10 | \\| S1 \\| | [场景名] | 即梦场景参考 | 是 |

## 三、逐场景生图请求

### @图片10 · | S1 | [场景名]
- 类型：空场景图
- 归属场景：| S1 |
- 用途：作为该场所有即梦视频生成单元的场景参考图
- 空间任务：[入口/过渡/阻碍/转折/开阔收束，选择其一并用一句话说明]
- 构图策略：[说明引导线、前景遮挡、中景空白区、远景地标或空间出口]
- 场景描述：用 2-4 句说明空间、光线、材质、关键道具和表演留白。
- 中文生图 Prompt：
[一段完整、可直接提交给图片 API 的中文场景 prompt。必须是空场景，不出现角色。包含 16:9、可读动画电影场景空间、角色高度/中低机位/斜俯拍/俯拍按空间任务选择、空间任务、构图引导线、童话地标物、少量前景自然遮挡、中景表演留白、可读后景风景、极轻透明空气感、冷暖光线、真实自然地表材质、关键道具、3D梦幻动画电影场景质感。若是香蕉猫/刀盾狗或剧本明确“小生命面对大世界”，可加入童话微缩花园尺度、花朵/叶片/蘑菇/草坡明显大过角色。若有草地/苔藓，必须写草簇长短不齐、疏密变化、混有泥土落叶小石子和湿润暗部。]
- Negative Prompt：
不要出现角色、动物、人物、拟人角色、额外生物、文字、水印、logo、畸形物体、错误地点、画风漂移、微距摄影、显微镜视角、极浅景深、背景完全虚化、只拍一小块苔藓或水滴、塑料草皮、人工草坪、网格草地、重复编织纹理、地面像塑料网、浓雾、厚雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、神秘恐怖、惊悚、悬疑、写真摄影感。
- 生成前内部自检：无角色；中景空白区足够；远景风景可读；地形/路径/水面/石阶/树根等关键结构清楚；材质不塑料；与前一场有明确视觉变化。
- 即梦使用备注：本场视频生成时建议搭配角色图 @图片... 和本场景图 @图片10。

### @图片11 · | S2 | ...
...

## 四、人工检查清单
| 检查项 | 结果 |
|---|---|
| 只使用 @图片10-49 场景图编号 | ... |
| 没有规划关键帧/首帧/尾帧/@图片50+ | ... |
| 场景图均为空场景，不含角色或额外生物 | ... |
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

const DEFAULT_ROUTE_SOURCES = Object.fromEntries(STAGES.map(stage => [stage.id, "self"]));
const DEFAULT_REVIEW_ROUTE_SOURCES = Object.fromEntries(REVIEW_ROUTES.map(route => [route.id, "self"]));

const normalizeRouteConfig = (route = {}, fallback = {}) => ({
  ...EMPTY_ROUTE_CONFIG,
  ...fallback,
  ...(route || {}),
  is_thinking: Boolean(route?.is_thinking),
  use_proxy: Boolean(route?.use_proxy),
  proxy_url: route?.proxy_url || "",
});

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
  const [styleMode, setStyleMode] = useState('cute_3d'); // 默认为3D半写实梦幻动物动画

  const [config, setConfig] = useState({
    prompts: { ...DEFAULT_PROMPTS },
    routes: {
      script: { ...EMPTY_ROUTE_CONFIG, name: "1. 剧本生成" },
      visual: { ...EMPTY_ROUTE_CONFIG, name: "2. 视觉开发" },
      shot: { ...EMPTY_ROUTE_CONFIG, name: "3. 分镜提示词 (兼数据提炼)" },
      image: { ...EMPTY_ROUTE_CONFIG, name: "4. 场景图生图清单" }
    },
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
  const [sceneImagePromptMode, setSceneImagePromptMode] = useState('jimeng'); // 'jimeng' = 中文即梦 / 'mj' = 英文 Midjourney
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
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);
    return currentRunId;
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
      await navigator.clipboard.writeText(data.prompt);
      alert(`✅ ${successLabel} 已复制到剪贴板（${data.char_count || data.prompt.length} 字 ≈ ${data.token_estimate || Math.ceil(data.prompt.length / 2)} tokens）\n\n粘贴到 Kiro/Codex/Gemini/Claude 等高级模型执行；拿到结果后点击对应“导入结果”。`);
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
      art_director_profile: "default",
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
      cinematographer_profile: "default",
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
      art_director_profile: "default",
      force_scene: forceScene,
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
      cinematographer_profile: "default",
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
        director_profile: "default",
        force_scene: "auto",
      },
      visual: {
        visual: currentText,
        script: stripCompletionEndMarker(outputs[0] || ""),
        original_input: inputs[1] || inputs[0] || "",
        ip_names: selectedIPs,
        routes: getEffectiveRoutes("visual"),
        art_director_profile: "default",
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
        cinematographer_profile: "default",
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

  const generateAndBindAsset = async ({ assetId, category, prompt, description, frameId, referenceIds = [], assetMap }) => {
    const imageRoute = getEffectiveRoutes().image || {};
    if (!imageRoute.key) {
      throw new Error("请先在系统设置的 [4. 场景图生图清单] 里配置图片 API Key。");
    }
    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId();
    setRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);

    const boundReferenceIds = referenceIds
      .filter(id => id !== assetId)
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
        bind_to_image_id: assetId,
        bind_category: category,
        bind_description: description || `@图片${assetId}`
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `@图片${assetId} 生成失败`);
    return data;
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
    setAssetAutoProgress("正在分析缺失场景图...");

    try {
      let assetMap = {...imageAssets};
      const sceneAssets = extractSceneAssetPrompts(outputs[1] || outputs[3] || "");
      const sceneIds = Object.keys(sceneAssets).map(Number).filter(Boolean).sort((a, b) => a - b);
      if (!sceneIds.length) {
        throw new Error("没有识别到 @图片10-49 场景图。请先生成第二阶段固定要素库包，并确保每个场景卡包含场景参考图和场景生图提示词。");
      }

      const missingSceneIds = sceneIds.filter(id => id >= 10 && id <= 49 && !assetMap[String(id)]?.path);
      if (!missingSceneIds.length) {
        setAssetAutoProgress("场景图已经补齐。");
        return;
      }

      for (const assetId of missingSceneIds) {
        const scene = sceneAssets[assetId] || {
          description: `@图片${assetId} 场景参考图`,
          prompt: `@图片${assetId} 可读动画电影空场景参考图，无角色、无动物、无人物，按空间任务选择角色高度、中低机位、斜俯拍或俯拍，少量前景自然虚化，中景保留表演留白，远景森林、水道、树根或光束清楚可读；若是香蕉猫/刀盾狗，可采用童话微缩花园尺度；草地和苔藓为真实自然地表，草簇长短不齐、疏密变化、混有泥土落叶小石子和湿润暗部，禁止塑料草皮、人工草坪、网格草地；3D半写实梦幻动画电影风格，电影级CG质感，自然景深，16:9`
        };
        setAssetAutoProgress(`正在生成场景参考 @图片${assetId}...`);
        const data = await generateAndBindAsset({
          assetId,
          category: "scene",
          prompt: scene.prompt,
          description: scene.description || `@图片${assetId} 场景参考图`,
          frameId: `ASSET-SCENE-${assetId}`,
          referenceIds: [],
          assetMap,
        });
        if (data.bound_asset) assetMap[String(assetId)] = data.bound_asset;
        await fetchImageAssets(runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || "");
      }

      setImageAssets(assetMap);
      setAssetAutoProgress("场景图已补齐。");
    } catch (e) {
      const msg = e.message || "自动补齐场景图失败";
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
      const data = await generateAndBindAsset({
        assetId: scene.id,
        category: "scene",
        prompt: scene.prompt,
        description: scene.description || `@图片${scene.id} 场景参考图`,
        frameId: `ASSET-SCENE-${scene.id}`,
        referenceIds: [],
        assetMap: imageAssets,
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
      const res = await fetch(`${API_BASE}/generate_inspirations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: inputs[0],
          style_hint: INSPIRATION_STYLE_HINTS[styleMode] || activePreset?.name || "",
          ip_names: selectedIPs,
          routes: getEffectiveRoutes()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "灵感生成失败");
      setInspirationIdeas(Array.isArray(data.ideas) ? data.ideas : []);
    } catch (e) {
      setInspirationError(e.message || "灵感生成失败");
    } finally {
      setInspirationLoading(false);
    }
  };

  const applyInspiration = (idea) => {
    const picked = idea.story_input || [
      idea.title ? `标题：${idea.title}` : "",
      idea.genre ? `类型：${idea.genre}` : "",
      idea.logline ? `故事钩子：${idea.logline}` : "",
      idea.visual_hook ? `视觉记忆点：${idea.visual_hook}` : ""
    ].filter(Boolean).join("\n");

    setInputs(prev => {
      const next = [...prev];
      next[0] = picked;
      return next;
    });
    setStage(0);
  };

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
    const segments = splitUnitsIntoBoardSegments(units);
    const builtSegments = segments.map((segment, segmentIndex) => {
      const boardDuration = Math.max(1, Math.round((Number(segment.duration) || 15) * 2) / 2);
      const boardDurationLabel = formatBoardSeconds(boardDuration);
      const boardFrameCount = getBoardFrameCount(boardDuration, segment.units.length);
      const framePlan = buildBoardFramePlan(segment, boardFrameCount);
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
      });
      const jimeng = buildSegmentJimengPrompt({
        projectTitle,
        segment,
        segmentIndex,
        totalSegments: segments.length,
        boardDurationLabel,
        boardFrameCount,
        framePlan,
        styleText,
      });
      return {
        id: `第${segmentIndex + 1}段`,
        title: `${projectTitle} · 第 ${segmentIndex + 1}/${segments.length} 段 · ${boardDurationLabel}`,
        range: `${segment.units[0]?.id || ""} - ${segment.units[segment.units.length - 1]?.id || ""}`,
        duration: boardDuration,
        frameCount: boardFrameCount,
        unitCount: segment.units.length,
        gpt,
        jimeng,
      };
    });
    setBoardPrompts({ segments: builtSegments });
    setExpandedBoardPrompt(0);
    setBoardCopied("");
    setBoardPromptError("");
  };

  const copyBoardPrompt = async (kind, index = 0) => {
    const segment = boardPrompts.segments?.[index];
    const text = kind === "gpt" ? segment?.gpt : segment?.jimeng;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setBoardCopied(`${kind}-${index}`);
    setTimeout(() => setBoardCopied(""), 1800);
  };

  const handleGenerateBoardImage = async (index = 0) => {
    const segment = boardPrompts.segments?.[index];
    if (!segment?.gpt) return;
    if (!hasEffectiveRouteKey("image")) {
      setBoardPromptError("请先在系统设置的 [4. 场景图生图清单] 中配置 GPTImage2/图片模型 API Key。");
      return;
    }
    const missingRefs = [1, 2].filter(id => !imageAssets[String(id)]?.path);
    if (missingRefs.length) {
      setBoardPromptError(`请先在“参考图资产库”上传并绑定 ${missingRefs.map(id => `@图片${id}`).join("、")}，全案图生图会自动作为角色参考图传入。`);
      return;
    }

    const currentRunId = runId || localStorage.getItem(PIPELINE_RUN_ID_KEY) || createPipelineRunId();
    setRunId(currentRunId);
    localStorage.setItem(PIPELINE_RUN_ID_KEY, currentRunId);
    setBoardImageGenerating(`board-${index}`);
    setBoardPromptError("");

    try {
      const imageRoute = getEffectiveRoutes().image || {};
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
          reference_image_ids: [1, 2],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "全案分镜图生成失败");
      setBoardImageResults(prev => ({...prev, [index]: data}));
    } catch (error) {
      setBoardPromptError(error.message || "全案分镜图生成失败");
    } finally {
      setBoardImageGenerating("");
    }
  };

  const handleCreateCodexBoardJob = async (index = 0) => {
    const segment = boardPrompts.segments?.[index];
    if (!segment?.gpt) return;

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
          reference_image_ids: [1, 2],
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
      if (stageId === "visual") {
        const modeInstruction = sceneImagePromptMode === "mj"
          ? `【场景图提示词模式：MJ英文生图】\n每个场景卡必须输出且只输出一种场景生图提示词字段：**MJ英文场景生图提示词**。\n场景图必须是空场景、可读动画电影场景空间，保留中景表演留白和可读远景；香蕉猫/刀盾狗可使用童话微缩花园尺度；草地/苔藓必须是非均匀自然地表，避免 artificial turf, plastic grass, mesh grass, repeated woven texture；禁止默认写 microscopic macro close-up, extreme shallow depth of field, fully blurred background。`
          : `【场景图提示词模式：即梦中文生图】\n每个场景卡必须输出且只输出一种场景生图提示词字段：**即梦中文场景生图提示词**。\n场景图必须是空场景、可读动画电影场景空间，保留中景表演留白和可读远景；香蕉猫/刀盾狗可使用童话微缩花园尺度；草地/苔藓必须是非均匀自然地表，禁止塑料草皮、人工草坪、网格草地、重复编织纹理；禁止默认写显微镜视角、微距局部素材、极浅景深、背景完全虚化。`;
        sysPrompt += "\n\n" + modeInstruction;
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
1. 阶段二“场景卡 · | S? |”里的 @图片10-49 对应关系是最高场景裁判；如果阶段三分镜中出现与阶段二冲突的场景名、参考图编号或地点，第四阶段必须修正为阶段二场景卡。
2. 只输出 @图片10-49 空场景图请求，不要输出关键帧清单、逐帧生图请求、首帧、尾帧、姿势图或 @图片50+。
3. 所有场景图必须是空场景或明确要求的道具场景，不要把角色、小动物、额外生物混进 @图片10-49 场景资产。
4. 后续即梦视频使用方式是“角色原图 + 场景图”，所以本阶段不解决角色姿态一致性，只负责场景稳定。
5. 场景图必须是可读动画电影场景空间：可接近角色高度、中低机位、斜俯拍或俯拍观察，香蕉猫/刀盾狗可使用童话微缩花园尺度，但后景风景和空间结构必须可读；禁止退回显微镜视角、微距局部素材、极浅景深、背景完全虚化或只拍局部苔藓/水滴。
6. 草地/苔藓/森林地面必须是真实自然材质：草簇长短不齐、疏密变化、混有泥土、落叶、小石子、湿润暗部和踩压痕迹；禁止塑料草皮、人工草坪、网格草地、重复编织纹理。
7. 每个场景图提示词必须有明确空间任务和构图策略：入口/过渡/阻碍/转折/开阔收束之一；写清引导线、中景空白区、远景地标、童话地标物、极轻透明空气感和冷暖光变化。
8. 治愈童话场景优先采用“童话地标物 + 柔软自然地表舞台 + 前景叶片/花草包围 + 可读森林纵深 + 少量透明空气感 + 暖光斑”的构成；不要把雾气浓淡作为主要递进手段，不要使用浓雾、厚雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、惊悚、悬疑、写真摄影感。`;
        revisionInput = [
          script ? "【完整剧本文档（阶段一产出）】\n" + script : "",
          visual ? "【固定要素库包（阶段二产出）】\n" + visual : "",
          shot ? "【分镜提示词包（阶段三产出）】\n" + shot : "",
          "【场景图生图清单重写任务】\n" + revisionInput + "\n\n" + imageContinuityGuard
        ].filter(Boolean).join("\n\n---\n\n");
      }

      const res = await fetch(`${API_BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: stageId,
          input: revisionInput,
          session_id: "session_" + stageId,
          system_prompt: sysPrompt,
          ip_names: selectedIPs,
          run_id: currentRunId,
          routes: getEffectiveRoutes(stageId)
        }),
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
    if (stageId === "visual") {
      const modeInstruction = sceneImagePromptMode === "mj"
        ? "【场景图提示词模式：MJ英文生图】每个场景卡必须输出且只输出一种场景生图提示词字段：MJ英文场景生图提示词。"
        : "【场景图提示词模式：即梦中文生图】每个场景卡必须输出且只输出一种场景生图提示词字段：即梦中文场景生图提示词。";
      systemRules += "\n\n" + modeInstruction;
    }

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
【会审后重写任务包】
==============================
${revisionInput}`;
  };

  const handlePackReviewRewrite = async () => {
    const packed = buildReviewRewritePackPrompt();
    if (!packed) {
      return alert("需要先有当前阶段输出，并完成一次会审，才能打包会审重写任务。");
    }
    await navigator.clipboard.writeText(packed);
    alert(`✅ 会审重写任务包已复制到剪贴板（${packed.length} 字 ≈ ${Math.ceil(packed.length / 2)} tokens）\n\n粘贴到 CLI 执行；拿到完整新版后，点击本阶段的“导入结果”按钮覆盖。`);
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

      if (stageId === "visual") {
        const modeInstruction = sceneImagePromptMode === "mj"
          ? `【场景图提示词模式：MJ英文生图】\n每个场景卡必须输出且只输出一种场景生图提示词字段：**MJ英文场景生图提示词**。\n要求：使用英文，适合 Midjourney 生图；不要输出中文生图提示词；不要写运镜、生成时长、首尾帧；重点写可读动画电影场景空间、主体留白、前景/中景/后景、光线、材质、色彩、风格与画幅参数。必须是空场景，保留可读远景；banana cat / shield dog stories may use fairy miniature garden scale; grass/moss ground must be uneven natural ground with varied grass clumps, soil, leaves, pebbles and damp dark patches；禁止默认写 microscopic macro close-up、extreme shallow depth of field、fully blurred background、artificial turf、plastic grass、mesh grass。`
          : `【场景图提示词模式：即梦中文生图】\n每个场景卡必须输出且只输出一种场景生图提示词字段：**即梦中文场景生图提示词**。\n要求：使用全中文，适合即梦生图；不要输出英文 MJ 提示词；不要写运镜、生成时长、首尾帧；重点写可读动画电影场景空间、主体留白、前景/中景/后景、光线、材质、色彩、风格与画幅比例。必须是空场景，保留可读远景；香蕉猫/刀盾狗故事可使用童话微缩花园尺度；草地/苔藓必须是非均匀自然地表，禁止塑料草皮、人工草坪、网格草地、重复编织纹理；禁止默认写显微镜视角、微距局部素材、极浅景深、背景完全虚化。`;
        sysPrompt += "\n\n" + modeInstruction;
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
请基于以上完整上下文，生成适合无状态按次图片 API 的“场景图生图清单”。本阶段只生成空场景资产，用于后续和角色原图一起交给即梦做视频参考。

【阶段连续性硬约束】
1. 阶段二“场景卡 · | S? |”里的 @图片10-49 对应关系是最高场景裁判；如果阶段三分镜中出现与阶段二冲突的场景名、参考图编号或地点，第四阶段必须修正为阶段二场景卡。
2. 只输出 @图片10-49 空场景图请求，不要输出关键帧清单、逐帧生图请求、首帧、尾帧、姿势图或 @图片50+。
3. 所有场景图必须是空场景或明确要求的道具场景，不要把角色、小动物、额外生物混进 @图片10-49 场景资产。
4. 后续即梦视频使用方式是“角色原图 + 场景图”，所以本阶段不解决角色姿态一致性，只负责场景稳定。
5. 场景图必须是可读动画电影场景空间：可接近角色高度、中低机位、斜俯拍或俯拍观察，香蕉猫/刀盾狗可使用童话微缩花园尺度，但后景风景和空间结构必须可读；禁止退回显微镜视角、微距局部素材、极浅景深、背景完全虚化或只拍局部苔藓/水滴。
6. 草地/苔藓/森林地面必须是真实自然材质：草簇长短不齐、疏密变化、混有泥土、落叶、小石子、湿润暗部和踩压痕迹；禁止塑料草皮、人工草坪、网格草地、重复编织纹理。
7. 每个场景图提示词必须有明确空间任务和构图策略：入口/过渡/阻碍/转折/开阔收束之一；写清引导线、中景空白区、远景地标、童话地标物、极轻透明空气感和冷暖光变化。
8. 治愈童话场景优先采用“童话地标物 + 柔软自然地表舞台 + 前景叶片/花草包围 + 可读森林纵深 + 少量透明空气感 + 暖光斑”的构成；不要把雾气浓淡作为主要递进手段，不要使用浓雾、厚雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、惊悚、悬疑、写真摄影感。`
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
      sysPrompt = withEndMarkerInstruction(sysPrompt);

      const res = await fetch(`${API_BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: stageId,
          input: continueInstruction,
          session_id: "session_" + stageId,
          system_prompt: sysPrompt, // 🌟 修改这里
          ip_names: selectedIPs,
          run_id: currentRunId,
          routes: getEffectiveRoutes(stageId)
        }),
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
  const sceneAssetMap = stage === 3 ? extractSceneAssetPrompts(outputs[1] || outputs[3] || "") : {};
  const sceneAssetList = Object.values(sceneAssetMap).sort((a, b) => a.id - b.id);
  const neededAssetIds = stage === 3
    ? sceneAssetList.map(scene => scene.id)
    : [];
  const projectRunById = Object.fromEntries(projectRuns.map(item => [item.run_id, item]));
  const selectedProjectRun = projectRunById[selectedProjectRunId];
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
              title={selectedProjectRun ? formatProjectRunLabel(selectedProjectRun) : "选择要载入的项目目录"}
              style={styles.projectSelect}
            >
              {projectRuns.length === 0 && <option value="">暂无项目目录</option>}
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
              disabled={projectLoading || projectRunsLoading || projectRuns.length === 0}
              style={{...styles.settingsBtn, borderColor: '#86efac', color: '#86efac', opacity: (projectLoading || projectRunsLoading || projectRuns.length === 0) ? 0.6 : 1}}
            >
              {projectLoading ? "载入中..." : "载入项目"}
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
        borderBottom: '1px solid ' + BORDER, display: 'flex', gap: '15px', alignItems: 'center'
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

          {/* 阶段二：场景卡生图提示词语言/平台 */}
          {stage === 1 && (
            <div style={{ marginBottom: '15px', display: 'flex', gap: '10px' }}>
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
              <div style={{fontSize: '12px', color: '#67e8f9', fontWeight: 'bold'}}>高级模型任务包 · 阶段二</div>
              <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
                <button onClick={handlePackVisual} style={{...styles.btnGhost, color: '#67e8f9', borderColor: 'rgba(34,211,238,0.35)'}}>📋 打包阶段二</button>
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
              <div style={{fontSize: '12px', color: '#d8b4fe', fontWeight: 'bold'}}>高级模型任务包 · 阶段三</div>
              <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
                <button onClick={handlePackShot} style={{...styles.btnGhost, color: '#d8b4fe', borderColor: 'rgba(168,85,247,0.35)'}}>📋 打包阶段三</button>
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
                            onClick={() => setExpandedBoardPrompt(prev => prev === index ? -1 : index)}
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
                                        <div style={styles.generatedImagePath}>{img.path || img.public_url || img.url || "已生成"}</div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              <div style={styles.fullBoardResultTop}>
                                <span style={styles.fullBoardLabel}>给即梦的直投指令</span>
                                <button onClick={() => copyBoardPrompt("jimeng", index)} style={{...styles.btnGhost, padding: "6px 10px", fontSize: "12px"}}>
                                  {boardCopied === `jimeng-${index}` ? "已复制" : "复制"}
                                </button>
                              </div>
                              <textarea readOnly value={segment.jimeng} style={{...styles.fullBoardOutput, minHeight: "110px"}} />
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {stage === 3 && (
                <div style={styles.imageGenSection}>
                  <div style={styles.foldableHeader}>
                    <div>
                      <div style={styles.foldableTitle}>场景图生成</div>
                      <div style={styles.foldableMeta}>
                        识别到 {sceneAssetList.length} 张可生成场景图；图片会绑定为 @图片10-49 并保存到当前项目 outputs/images 目录
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
                            {src && <img src={src} alt={`@图片${id}`} style={styles.assetChipThumb} />}
                            <span>@图片{id}</span>
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
                        {assetAutoGenerating ? "补齐中..." : "自动补齐场景图"}
                      </button>
                    </div>
                  )}
                  {assetAutoProgress && <div style={styles.assetProgress}>{assetAutoProgress}</div>}
                  {sceneAssetList.length === 0 ? (
                    <div style={styles.collapsedBox}>还没有识别到 @图片10-49 场景图。请先生成第二阶段固定要素库包，确保每个场景卡包含场景参考图和场景生图提示词。</div>
                  ) : (
                    <div style={styles.imageFrameGrid}>
                      {sceneAssetList.map(scene => {
                        const asset = imageAssets[String(scene.id)];
                        const src = asset?.public_url ? `${API_BASE}${asset.public_url}` : "";
                        return (
                          <div key={scene.id} style={styles.imageFrameCard}>
                            <div style={styles.imageFrameTop}>
                              <div>
                                <div style={styles.imageFrameTitle}>@图片{scene.id} · {scene.description || "场景参考图"}</div>
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
                                {imageGeneratingId === `scene-${scene.id}` ? "生成中..." : asset?.path ? "重新生成" : "生成场景图"}
                              </button>
                            </div>
                            <div style={styles.imagePromptPreview}>{scene.prompt}</div>
                            {src && (
                              <div style={styles.generatedImageList}>
                                <div style={styles.generatedImageItem}>
                                  <img src={src} alt={`@图片${scene.id}`} style={styles.generatedImageThumb} />
                                  <div style={styles.generatedImagePath}>{asset.path || "已绑定"}</div>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
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
                上传时直接绑定编号：角色原图用 @图片1-@图片9，场景图用 @图片10-@图片49。当前流程不再生成姿势图、首尾帧或 @图片50+。
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
                          <div style={styles.assetTitle}>@图片{id}</div>
                          <div style={styles.assetMeta}>{category === "character" ? "角色原图" : category === "scene" ? "场景参考图" : "其他资产"}</div>
                        </div>
                        {asset && <button onClick={() => handleDeleteAsset(id)} style={styles.assetDeleteBtn}>删除</button>}
                      </div>
                      {src ? (
                        <img src={src} alt={`@图片${id}`} style={styles.assetPreview} />
                      ) : (
                        <div style={styles.assetEmpty}>未绑定图片</div>
                      )}
                      <div style={styles.assetMeta}>{asset?.description || "上传后会写入 image_registry.json"}</div>
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
                            handleUploadAsset(id, category, file, asset?.description || `@图片${id}`);
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
                        当前请求会使用被复用阶段的 URL / Key / Model / 代理；本页字段保留为备用配置。
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
                  {activeRouteTab === "image" && (
                    <div style={{ marginTop: "12px", border: `1px solid rgba(74,222,128,0.24)`, background: "rgba(74,222,128,0.06)", borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div style={{ color: "#86efac", fontSize: "12px", fontWeight: "bold" }}>图片生图模型快速选择</div>
                      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        {IMAGE_MODEL_PRESETS.map(preset => (
                          <button
                            key={preset.model}
                            type="button"
                            onClick={() => setConfig(prev => ({
                              ...prev,
                              routes: {
                                ...prev.routes,
                                image: {
                                  ...prev.routes.image,
                                  url: prev.routes.image.url || preset.url,
                                  model: preset.model
                                }
                              }
                            }))}
                            style={{
                              background: (config.routes.image.model || "").trim() === preset.model ? "#86efac" : "rgba(0,0,0,0.28)",
                              color: (config.routes.image.model || "").trim() === preset.model ? "#06130a" : "#86efac",
                              border: "1px solid rgba(74,222,128,0.35)",
                              borderRadius: "6px",
                              padding: "7px 10px",
                              fontSize: "12px",
                              cursor: "pointer",
                              fontWeight: "bold"
                            }}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                      <div style={{ color: MUTED, fontSize: "11px", lineHeight: 1.6 }}>
                        `flux-2-pro` 会先尝试携带参考图；如果通道返回 `endpoint not supported`，说明该中转不支持这个 FLUX 图片端点，请换渠道或切回 `gpt-image-2`。需要更强参考图一致性时，可试已开通的 Kontext 模型。
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
