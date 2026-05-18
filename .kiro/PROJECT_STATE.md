# storyboard-rag · 项目状态档案

> **用途**：新窗口/新会话开机档案。读完这一份就能恢复完整上下文，无需翻历史对话。
> **更新原则**：每次关键改造或重要决策后更新本文件。最后修改：2026-05-18。

---

## 一、项目本质

四阶段 AI 短片导演工作站。一句话流水线：

```
用户一句创意 → [一·剧本] → [二·视觉开发] → [三·分镜提示词] → [四·场景图生图清单]
                  Qwen        Gemini          Claude（推荐）       GPT/FLUX
```

每个阶段产出可被下一阶段直接消费，最终交付即梦/MJ 等 AI 视频/图片生成平台。

### 技术栈

| 层 | 技术 | 文件 | 行数 |
|---|---|---|---|
| 后端 | FastAPI + httpx + 多 LLM SDK | `rag_api.py` | ~4500 |
| 前端 | React + Vite | `frontend/storyboard-ui/src/App.jsx` | ~3900 |
| 任务级 prompt | JSON | `prompts.json` | 4 阶段 |
| 知识库 | Markdown KB | `knowledge/core/KB-03..KB-16` | 14 份 |
| IP 资产 | Markdown | `knowledge/ip/<IP>/` | 角色卡/性格/世界观/剧本设定 |
| 向量库 | ChromaDB | `chroma_db/` | text-embedding-3-large |

### 运行

```bash
# 后端
python rag_api.py              # http://0.0.0.0:8001

# 前端
cd frontend/storyboard-ui
npm run dev                    # http://localhost:5173

# 一键启动（Windows）
.\start.bat
.\start_local_direct.bat
```

---

## 二、四阶段架构

```
┌────────────────────────────────────────────────────────────────────┐
│  /generate (流式)  —— 主四阶段引擎，stage 字段切换路由             │
│    ├─ stage="script"  → 剧本.md                                    │
│    ├─ stage="visual"  → 固定要素库包.md                            │
│    ├─ stage="shot"    → 分镜提示词包.md                            │
│    └─ stage="image"   → 场景图生图清单.md                          │
└────────────────────────────────────────────────────────────────────┘

3 个二稿端点（独立的"剪辑"循环）：
  /director_cut_script       ← 阶段一二稿（导演剪辑）
  /art_director_cut_visual   ← 阶段二二稿（美术剪辑）
  /cinematographer_cut_shot  ← 阶段三二稿（摄影剪辑）

辅助端点：
  /generate_inspirations      灵感雷达（5 个故事火花）
  /review_*_stream            多方会审（流式）
  /distill_knowledge          蒸馏雷达（拉片提炼）
  /extract_ip_bible           IP 圣经提取
  /image_library/*            @图片库 CRUD
  /generate_image             图片生成（GPT/FLUX/FLUX-Kontext）
  /codex_storyboard_job       Codex 全案分镜图任务包
```

---

## 三、已完成的"激发改造"（核心成就）

激发改造 = 让模型从"按格式填空的助手"升级为"有立场、会判断、能自我否定"的专业角色（编剧/美术指导/摄影指导）。

### 阶段一·剧本（9 项激发改造完成）

| 改造 | 实现 | 文件位置 |
|---|---|---|
| 主题命题（动笔前） | 5-15 字可辩论命题，写进剧本摘要末尾隐藏字段 | `prompts.json["script"]` 顶部 |
| 反类型挑战（结构合规后） | 三问：意外感/角色互换/主题反触 | `prompts.json["script"]` 5c 条 + `KB-13` 末尾 |
| 导演剪辑端点 | `/director_cut_script` 二稿，温度 0.55 | `rag_api.py` |
| 6 个导演画像 | default/miyazaki/pixar/wes_anderson/a24_indie/ghibli_yonebayashi | `DIRECTOR_PROFILES` |
| 强制重写场号 | force_scene = "first" / "last" / "auto" | `_resolve_force_scene_instruction` |
| 默认画像反惯性 | 让模型说出第一直觉，再考虑次优画像（"打破舒适区"） | `DIRECTOR_PROFILES["default"]` |
| 用户生活观察输入框 | `directorIntent` 前置注入剧本 prompt | App.jsx |
| 自动质量闸门（建议级） | 禁用奇观词/未设定身体部位/镜头术语/节奏/卡点 | `_build_script_quality_gate_report` |
| 历史回退栈 | scriptDraftHistory（5 份） | App.jsx |

**实测路由**：Qwen 3.6 Max Preview，**评分 9.3**（5/17 露珠引路）。

### 阶段二·视觉开发（6 项激发改造完成）

| 改造 | 实现 |
|---|---|
| 视觉总命题（动笔前） | 5-15 字视觉命题，与剧本主题命题呼应不重复 |
| 色彩剧本（色彩演进表） | 每场主导色+辅助色+情绪温度+与上一场差异 |
| 道具情感学 | 每件关键道具写"物件名 \| 物理功能 \| 情感重量" |
| 多通道感官锚定 | 视觉/听觉/触觉/嗅觉/温度 4 通道 |
| 反类型视觉挑战 | 视觉惊喜/色彩反触/道具反用 |
| 美术剪辑端点 | `/art_director_cut_visual` 温度 0.5 |
| 6 个美术画像 | default/miyazaki_art/pixar_art/wes_anderson_art/a24_indie_art/ghibli_yonebayashi_art |
| 反同质化 GUARD | 场景图 prompt 风格头/尾去重 + 同空间复用差异锚点 |
| 自动质量闸门（建议级） | 7 类硬伤（场景卡数/编号段/禁用词/字段污染/极简卡/差异锚点/风格头雷同） |
| 历史回退栈 | visualDraftHistory（5 份） |

**实测路由**：Gemini 3.1 Pro Preview，**评分 9.7**（5/17 露珠引路一稿；后续二稿质量高度稳定）。

### 阶段三·分镜提示词（18 条护栏 + 7 类闸门 + 思维结构重构，完成）

| 改造 | 实现 |
|---|---|
| 镜头命题（动笔前） | 5-15 字镜头命题，是主题命题+视觉命题的"摄影翻译" |
| 反类型镜头挑战 | 节奏惊喜/景别反常/静止动态反触 |
| 摄影剪辑端点 | `/cinematographer_cut_shot` 温度 0.5 |
| 7 个摄影画像 | default/still_observer/deakins_minimal/lubezki_natural/wong_kar_wai/miyazaki_yoneda/kar_wai_anderson_hybrid |
| 强制重写单元 | force_unit = "first"/"last"/"auto" |
| 风格头/尾反同质化 | 每单元用本镜头最强特征做开篇 24 字，风格词放中后段 |
| 闭环约束 3-补B | 时长/编号一致性/单元唯一性 → 必须实修不算配额 |
| 反类型长镜头允许说明 3-补C | 故意设计的静止≥4 秒长镜头必须显式标记 |
| 接续残留去重 | `_dedupe_shot_units` 同 Sx-Uy 出现两次自动保留完整版 |
| 节奏曲线审计 | 连续 3 镜时长极差 < 1 秒报警 + 时长扎堆 1.5-2.5s 报警 |
| 景别多样性审计 | 连续 3 镜同景别报警；全片景别覆盖率检测 |
| 时长字段一致性 | 4 字段（动作有效/成片/视频提交/生成）必须全部相等 |
| 历史回退栈 | shotDraftHistory（5 份） |
| **[5/18 新增] 字段重构** | "情绪功能"→"注意力调度"（观众视线从A到B）；"动作&情绪"→"主动作与表演层"；"动作时间轴"→"核心动作 beat" |
| **[5/18 新增] 微反应/体态预备硬禁** | R4+R8：眼睛睁大/僵住/耳朵后压/底盘微沉等禁止独立成 beat，只能括号附在主动作后 |
| **[5/18 新增] 角色锚定语全字段禁** | R11：玻璃球眼睛/短爪/香蕉躯干等在阶段三任何字段都不出现 |
| **[5/18 新增] 形容词通胀控制** | R12：同一单元"慢慢/微微/极轻"等副词最多 2 个，超出改成秒数/距离/接触点 |
| **[5/18 新增] 机位戏剧动机** | R15：每个镜头类型/运镜后必须括号写"为什么必须这个机位" |
| **[5/18 新增] 全片节奏曲线** | R16：总体导演策略隐藏字段写 tempo 曲线 + 全片必须有 ≥5s 长镜 + ≤0.8s 短切 |
| **[5/18 新增] 声音设计曲线** | R17：总体导演策略写 macro 声音曲线，生成单元只写偏离差异 |
| **[5/18 新增] 视觉差异锚点表** | R18：每场头部写"与上一场视觉差异锚点"，至少两项具体差异 |
| **[5/18 新增] 闸门新增 4 类** | 角色锚定语污染 / 微反应独立 beat / 短反应被拉长 / 副词通胀 / 时长扎堆 |

**实测路由**：未明确（5/17 那份用了改造完整端点，二稿成功执行 S4 反类型重写）。**评分 9.0-9.2**（待新规则下重跑验证，预期 9.5+）。

### 阶段四·场景图生图清单（**未做激发改造**）

只有基础的：
- KB 加载（KB-05/09/12/16 + IP 世界观/角色卡）
- 场景模式开关（即梦中文 / MJ 英文）
- 角色参考模式（uploaded / text）
- 反同质化 GUARD（与阶段二共用 `VISUAL_SCENE_IMAGE_PROMPT_GUARD`）

**待做**：场景图二稿端点、生图 prompt 反模板化、负面约束系统化、空间任务/构图引导线显式审计。

---

## 四、关键设计决策（不可忘）

### 4.1 时长字段必须 4 字段全相等（用户偏好）

阶段三**禁止预加冗余**。模型不能写"动作 2.5 / 视频提交 4.5 / 生成 4.5"——必须 4 字段都是 2.5。

冗余加时（即梦提交时加 2 秒防截断）由用户在即梦平台手动加，**阶段三不预判**。

约束位置：
- `SHOT_NARRATIVE_GUARD` 第 5 条
- `prompts.json["shot"]` 时长字段一致性硬约束
- `_build_shot_quality_gate_report` "时长字段擅自分开"检测
- 摄影二稿端点 `3-补B` 时长字段一致性回填

### 4.2 @图片编号分段铁律

- `@图片1-9` = 角色原图（默认 @图片1=主角A，@图片2=主角B）
- `@图片10-49` = 场景图（每场至少 1 张）
- `@图片50+` = **已废弃**（旧姿势图/首尾帧图，新流程不再使用）

### 4.3 角色一致性的"原图优先"原则

有角色原图时：
- 角色卡极简（20-40 字短识别 + 永久附属物 + 禁止跑偏）
- 阶段三主体写法只用 `角色名（@图片X）+ 当前动作/状态`，**不复制完整外形描述**
- **[5/18 新增] 源头防污染**：阶段二角色卡末尾加隐藏字段"（短识别兜底仅供阶段二建模/跑偏修正使用，阶段三只用 @图片X+动作，禁止复制锚定语）"；阶段三闸门检测"玻璃球眼睛/短爪/香蕉躯干/橙白幼猫脸/小短腿"出现即报警

无角色原图时（characterReferenceMode = "text"）：
- 完整角色锁定描述（80-140 字）+ 短锚定（40-70 字）
- 否定约束（中文禁令 + 英文 --no 参数）

### 4.4 知识库分阶段加载（注意力守恒）

每阶段只加载相关 KB，避免污染：
- 剧本：KB-03 + KB-13 + IP 剧本设定/角色性格
- 视觉：KB-04/05/12/16 + IP 世界观/角色卡
- 分镜：KB-06/07/08/09/11/12/14/15/16 + IP 角色卡/角色性格（9 个 KB，注意力最密集）
- 场景图：KB-05/09/12/16 + IP 世界观/角色卡

剧本阶段**屏蔽**视觉/美学/执行类蒸馏法则；分镜阶段屏蔽纯美学法则。

### 4.5 IP 资产文件命名约定

```
knowledge/ip/<IP名>/
  ├─ 剧本设定_<角色名>.md  ← 仅阶段一加载（叙事底色）
  ├─ 角色性格_<角色名>.md  ← 仅阶段一+三加载（行为模式）
  ├─ 世界观.md             ← 仅阶段二+四加载（空间气质）
  └─ 角色卡_<角色名>.md    ← 阶段二+三+四加载（视觉锚定）
```

---

## 五、模型适配性（实测+推测）

```
阶段一·剧本:        Qwen 3.6 Max ✅ 9.3 实测（中文叙事密度+治愈语感最强）
阶段二·视觉开发:    Gemini 3.1 Pro ✅ 9.7 实测（长结构+视觉术语+多模态训练）
阶段三·分镜提示词:  Claude Opus 4.7（推测，未实测；严格规则追踪+时长换算）
阶段四·场景图生图:  GPT-5 / Claude Sonnet（推测）
导演/美术/摄影剪辑: 建议用与一稿不同的模型路由（已在前端 title 提示）
会审多槽位:         不同模型 = 不同审美视角
```

**已发现的模型特性**：
- **Qwen 3.6 Max**：中文成语精准（"慢半拍""极轻偏半度"）、治愈/童话语感强、可能在非治愈题材上稳定性下降
- **Gemini 3.1 Pro**：训练含 ArtStation/Behance 视觉描述、能主动给剧本加视觉骨架（如"猩红藤叶""淡粉孢子雾""发光蓝色脉络"）
- **同模型自评效果差**：剧本/视觉/分镜二稿都建议换模型做（让两个不同审美独立判断）

---

## 六、闸门体系（4 阶段质量护栏）

| 阶段 | 闸门函数 | 级别 | 检测项 |
|---|---|---|---|
| 一 | `_build_script_quality_gate_report` | 建议级 | 5 类（禁用奇观词/未设定身体部位/镜头术语/节奏/卡点） |
| 二 | `_build_visual_quality_gate_report` | 建议级 | 7 类（场景卡数/编号段/禁用词/字段污染/极简卡/差异锚点/风格头雷同） |
| 三 | `_build_shot_quality_gate_report` | 阻断级 | **12+ 类**（漏场/编号错位/时长字段擅自分开/节奏过平/景别多样性/注意力调度缺失/角色锚定语污染/微反应独立beat/短反应被拉长/副词通胀/时长扎堆1.5-2.5s/节奏支点缺失） |
| 四 | **无** | — | 待加 |

**闸门挂载点**：`/generate` 后处理 → 写盘前追加到 `content_to_save` + yield 给前端流式显示。

---

## 七、当前已知遗留问题

按优先级：

### 🟡 中等：分镜阶段两个真问题（要重新跑模型修）
1. **@图片错位（5/17_225347）**：S1-U5 用了 @图片11、S2-U6 用了 @图片12、S3-U7 用了 @图片13。每个都是位移到下一场景的图。下次摄影二稿按 `3-补B` 第 2 条会自动修。
2. **节奏过平（5/17_225347）**：S2-U5/U6/S3-U1 三镜全 1-1.5 秒；S3-U7/S4-U1/U2 三镜全 1.8-2.5 秒。需要按改造 3 反类型挑战手动重写。

### 🟢 低：阶段四（场景图生图清单）尚未做激发改造
预期改造 4-5 项，工作量约 2-3 小时。

---

## 八、文件地图（关键位置）

```
storyboard-rag/
├── rag_api.py                          # 后端主文件
│   ├─ load_knowledge_for_stage         # KB 分阶段加载
│   ├─ _build_*_quality_gate_report     # 4 个阶段闸门
│   ├─ DIRECTOR_PROFILES                # 6 个导演画像
│   ├─ ART_DIRECTOR_PROFILES            # 6 个美术画像
│   ├─ CINEMATOGRAPHER_PROFILES         # 7 个摄影画像
│   ├─ SHOT_NARRATIVE_GUARD             # 阶段三 14 条护栏
│   ├─ VISUAL_SCENE_IMAGE_PROMPT_GUARD  # 阶段二/四 12 条护栏
│   ├─ SOFT_PET_*_GUARD                 # 香蕉猫/刀盾狗专属护栏（IP 命中触发）
│   ├─ /director_cut_script             # 阶段一二稿
│   ├─ /art_director_cut_visual         # 阶段二二稿
│   ├─ /cinematographer_cut_shot        # 阶段三二稿
│   └─ _dedupe_shot_units               # 接续残留去重
│
├── prompts.json                        # 4 阶段任务级 prompt（含全套激发改造）
│
├── knowledge/
│   ├── core/
│   │   ├─ KB-03 叙事结构规范.md
│   │   ├─ KB-13 编剧诊断概念库.md（含反类型挑战 + 主题命题段）
│   │   ├─ KB-04 固定要素库模板.md
│   │   ├─ KB-05 角色场景锁定语法.md
│   │   ├─ KB-06..KB-08 运镜/镜头/剪辑库
│   │   ├─ KB-09 风格词组库.md
│   │   ├─ KB-11 终极分镜导演执行手册.md
│   │   ├─ KB-12 目标视频元素风格.md
│   │   ├─ KB-14 AI视频状态流与多角色控制.md
│   │   ├─ KB-15 镜头情绪匹配与情绪蒙太奇.md
│   │   └─ KB-16 AI画面电影感与空间构图.md
│   │
│   ├── ip/<IP名>/
│   │   ├─ 剧本设定_*.md       # 阶段一
│   │   ├─ 角色性格_*.md       # 阶段一+三
│   │   ├─ 世界观.md           # 阶段二+四
│   │   └─ 角色卡_*.md         # 阶段二+三+四
│   │
│   └── distilled/             # 蒸馏雷达自动追加（带体积守卫和去重）
│
├── frontend/storyboard-ui/src/App.jsx
│   ├─ DEFAULT_PROMPTS         # 4 阶段默认 prompt（与 prompts.json 同步）
│   ├─ DIRECTOR_PROFILE_OPTIONS
│   ├─ ART_DIRECTOR_PROFILE_OPTIONS
│   ├─ CINEMATOGRAPHER_PROFILE_OPTIONS
│   ├─ STYLE_PRESETS           # 4 种类型预设（cute_3d/action/literary/none）
│   ├─ INSPIRATION_STYLE_HINTS # 4 种灵感风格描述
│   ├─ handleGenerate          # 主生成
│   ├─ handleDirectorCut       # 阶段一二稿
│   ├─ handleArtDirectorCut    # 阶段二二稿
│   ├─ handleCinematographerCut # 阶段三二稿
│   └─ handleRollback*Draft    # 3 阶段历史回退
│
└── outputs/<run_id>/          # 每个项目独立目录
    ├─ 剧本.md
    ├─ 固定要素库包.md
    ├─ 分镜提示词包.md
    ├─ 场景图生图清单.md
    ├─ images/                 # 生图 API 落盘
    ├─ references/             # 用户上传的参考图
    └─ codex_jobs/             # Codex 全案分镜图任务包
```

---

## 九、近期会话索引（按时间倒序）

| 节点 | 主要动作 |
|---|---|
| 2026-05-18 深夜 | 按用户要求切换回旧黑金 UI 主线：先备份当时最新 `src/App.jsx` 为 `src/App.latest.jsx` 和带时间戳副本，备份 `rag_api.py` 为 `rag_api.latest.py` 和带时间戳副本；随后用共享文档旧 `App.jsx` 恢复主前端 UI，再把后端恢复为最新版 `rag_api.latest.py`（后端为兼容超集，不影响 UI）；在旧 UI 上补回最新关键入口：阶段二/三一稿打包、视觉/分镜结果导入、美术/摄影二稿打包（auto/首/末）、导演/美术/摄影 API 二稿直连流式按钮，并修复 localStorage 不再保存完整 prompts 防黑屏；`python -m py_compile rag_api.py`、`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 新增外部参考备份：`C:\Users\Administrator\Documents\局域网共享文档\App.jsx`（约 3607 行、227KB）和 `...\rag_api.py`（约 3471 行、198KB），中文基本可读，`??` 仅为 JS 空值合并运算符；但共享版后端缺当前新增的 `/pack_visual_job`、`/pack_shot_job`、`/pack_art_cut_job`、`/pack_cine_cut_job`、`/director_cut_script`、`/art_director_cut_visual`、`/cinematographer_cut_shot` 等端点，当前工作区版本更新，不可覆盖，只作为中文/旧逻辑参考 |
| 2026-05-18 晚 | Claude Code 对旧 `App.jsx.mojibake.bak` 做编码反解修复：确认损坏链路为 GBK 旧版源码被误按 UTF-16LE/UTF-8 保存导致 CJK 膨胀和换行丢失；当前 `frontend/storyboard-ui/src/App.jsx.mojibake.bak` 可读约 5194 行，仍有 1067 个 `??` 永久缺失标记，可作为旧版中文语义/功能参考；不要直接覆盖当前 `src/App.jsx`，当前 3690 行版本功能更新、结构更干净 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 18 步：补回手动 Codex 任务包的独立结果卡，手动创建 `/codex_storyboard_job` 后 now 直接显示 md/json 路径与目标 frame_id；手动任务也默认带上角色参考兜底，新建/载入项目时清空旧任务结果，避免跨项目混淆；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 17 步：恢复旧版项目加载器体验，项目下拉 now 只负责选择，点击“载入项目”才会读取 `/run_outputs` 覆盖当前工作区；补回独立刷新中/载入中状态、项目加载错误条、选中项目持久化和新项目同步选中；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 16 步：恢复风格预设的“按阶段执行补丁”能力，`STYLE_PRESETS` now 不只是短 hint/avoid，而是为剧本、视觉开发、分镜、场景图分别注入表达/美术/摄影/场景策略；阶段一生成、阶段三切片、导演/美术/摄影二稿、全案分镜图和灵感生成均使用对应风格补丁；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 15 步：补回全案分镜图 Prompt 的高密度 frame plan，按片段生成 0.5s 精度分镜格时长、逐镜执行表、动作节拍/微反应合并规则，并精确摘录相关剧本、角色规则、场景卡和阶段四场景图；同时补回“已有角色原图”模式的 @图片1/@图片2 默认角色参考兜底，Codex 任务包 now 不再空传角色参考；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 14 步：升级“结构化洗稿雷达/知识库提炼”工具，知识页 now 有 JSON 范例、通用法则、IP 圣经三模式；支持长 JSON 输入警告、数据提炼路由自动回退阶段三、专用结果区、JSON 预览/复制，并继续调用 `/extract_json_example`、`/distill_knowledge`、`/extract_ip_bible` 写入知识库；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 13 步：迁回“阶段二场景图提示词模式”，阶段二主面板 now 可切换“即梦中文 / MJ 英文”；该选择会持久化，并注入阶段二一稿、按会审建议重写、阶段二美术二稿，强制场景卡只输出一种场景图 prompt 字段，避免中英混写和双格式并列；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 12 步：迁回“输出折叠/长文预览控制”，输出区 now 显示正文 token 估算，支持折叠/展开正文；折叠只隐藏渲染视图，不影响复制输出、会审、按建议重写和断点续写；滚动跟随在折叠时暂停；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 11 步：迁回“导演观察/生活细节”输入层，阶段一主面板 now 可展开填写真实观察；生成剧本时会把该内容作为【导演观察 / 生活细节】前置注入，允许仅凭观察启动剧本生成；新建项目会清空该字段；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 10 步：补回“Codex 全案分镜图任务包结果记录/多段任务状态”，每段 Prompt 卡片 now 显示复制状态、Codex 打包状态、任务 md/json 路径和目标 frame_id；新增“批量创建 Codex 任务包”，可一次性为所有分段生成 codex_jobs；仍保留项目图片 API 直接生图；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 9 步：迁回“灵感生成器/历史避重/一键送入剧本阶段”能力，侧栏灵感生成 now 支持选择复用任一文本路由、首次生成/再来 5 个避开历史方向、保留最近历史反例、显示综合/钩子/视觉/生成评分和风险字段，并可一键填入阶段一输入；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 8 步：迁回“阶段三自动切片/接续生成”能力，阶段三主按钮 now 按阶段二场景卡逐场生成分镜；全量模式自动跑完并拼接保存，逐场确认模式每场后弹窗继续/从此自动跑完；保留“普通整包生成”兜底，并新增任意阶段“断点续写”；切片输出会清理跨场景污染和全片目录噪音；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 7 步：迁回“会审报告折叠 + 按建议重写”能力，会审工具页 now 持有独立会审报告面板、实时保存流式报告、支持折叠/复制；“按会审建议重写”会提炼报告重点并调用 `/generate` 重写当前阶段，保留前置阶段上下文并对阶段三/四追加连续性硬约束；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 6 步：迁回“场景图生成后自动审片”能力，@图片10-49 单张生成和自动补齐后会调用 `/review_image`，审片结果写回对应场景图卡片；未通过/审片失败只提示复查，不阻断图片绑定；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 5 步：迁回“全案分镜图用项目图片 API 生成”能力，全案分镜 Prompt 卡片现在支持直接调用 `/generate_image`，使用当前图片路由、尺寸、返回格式和参考图编号，生成后在卡片内展示缩略图/路径；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 4 步：迁回路由复用配置，主阶段/工具路由可选择“使用本项配置”或复用其它阶段路由；会审槽位可选择“使用本槽位配置”、复用主阶段/工具路由或复用其它会审槽位；所有生成、二稿、会审、蒸馏、灵感、生图/审图请求已切到解析后的 effective routes；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 3 步：迁回完整图片资产库/绑定参考图弹窗，支持 @图片1-9 角色原图、@图片10-49 场景参考图的格子化查看、上传/替换、删除和占位登记；侧边栏和场景图生成面板均可打开完整资产库；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 2 步：迁回“场景图资产识别/批量生图”基础能力，图片工具页可从阶段四清单或阶段二场景卡识别 `@图片10-49`，展示场景图卡片，单张生成或自动补齐缺失场景图，并通过 `/generate_image` 绑定到当前 run 的图片库；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 旧 5000+ 行 App.jsx 功能分批恢复第 1 步：从恢复版迁回“全案分镜图 Prompt 批量生成”基础能力，当前 Codex 工具页可从阶段三分镜单元切分 15s 内段落，生成 GPT 全案分镜图 Prompt、即梦直投指令，并打包 `/codex_storyboard_job`；暂未迁回直接项目 API 生图，留到下一步；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 核查 App.jsx 行数差异：当前 `src/App.jsx` 为 1503 行的干净重建版；旧 5000+ 行源码从 `src/App.jsx.mojibake.bak` 反解到 `recovery/app_jsx/App.jsx.recovered-gb18030.jsx`，约 5194 行，但仍有大量 `??` 文案损坏；已修复其中一处正则解析错误并用 esbuild 做语法检查通过。暂不覆盖当前可运行前端 |
| 2026-05-18 晚 | 前端按 `rag_api.py` 端点与 Request model 做覆盖补齐：新增后端工具箱入口，接入 `/review_*`、`/extract_*`、`/distill_knowledge`、`/generate_image`、`/review_image`、`/codex_storyboard_job` 与图片删除；RouteConfig 设置补齐 `name/is_thinking/use_proxy/proxy_url`；生图表单补齐 `size/response_format/n/reference_image_ids/bind_*`，审图补齐 `scene_id`；同时确认 localStorage 只保存小配置、不写入完整 prompts，避免配额黑屏复发；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 一键启动黑屏修复：`/image_library` 返回的 `images` 可能是对象而不是数组，前端已在 `refreshImageLibrary` 中统一 `Object.values(...)` 后再渲染，避免 `imageAssets.slice is not a function` 首屏崩溃；确认 8001 后端和 5173 前端均已启动；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 修复黑屏根因：前端不再把完整 `prompts.json` 写入 `localStorage` 的 `micro_epic_config_v30`，避免浏览器配额爆掉导致 React 首屏崩溃；配置持久化只保留路由/IP/画像/预设等小字段，prompt 始终从 `prompts.json` 或 `/get_prompts` 读取；重启 Vite 到 `http://127.0.0.1:5173`；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 参考桌面备份 `C:\Users\Administrator\Desktop\App.jsx` 迁回旧版黑金工作台视觉骨架：顶部品牌区、IP 挂载快捷条、预设条、阶段导航质感、Markdown 输出样式；未回滚最新 4 阶段结构、`prompts.json` import、阶段二/三打包端点与导入逻辑；`npm run lint`、`npm run build` 通过 |
| 2026-05-18 晚 | 修复 `frontend/storyboard-ui/src/App.jsx` 编码损坏：不再从乱码源文件继承，按 `CODEX_TASK_FIX_APP_JSX.md` 从后端契约与 dist 功能边界重建前端；阶段二/三打包按钮固定显示在对应阶段输入区下方，支持一稿打包、导入结果、二稿 auto/首/末强制任务包；`DEFAULT_PROMPTS` 改为直接 import 根目录 `prompts.json`；`npm run lint`、`npm run build`、`python -m py_compile rag_api.py` 通过 |
| 2026-05-18 晚 | 完整方案 A+B+C+D 落地收尾：SHOT_NARRATIVE_GUARD 扩至 18 条（R15 机位戏剧动机 / R16 全片节奏曲线+长镜短切硬要求 / R17 声音设计曲线 / R18 视觉差异锚点表）；VISUAL_COMPACT_CHARACTER_GUARD 加短识别兜底防污染说明（C3 源头补丁）；prompts.json + App.jsx 三端同步 |
| 2026-05-18 傍晚 | 前端 stage 2/3 prompt 再同步：补齐场景视觉差异锚点、镜头机位戏剧动机、节奏/声音曲线、长短镜支点与短识别兜底防污染；`App.jsx` 与 `prompts.json` 重新对齐 |
| 2026-05-18 下午 | 阶段三分镜字段重构为“注意力调度 / 主动作与表演层 / 核心动作 beat”；后端护栏新增微反应、体态预备、角色锚定语和节奏扎堆检测；前端默认 prompt 与 prompts.json 同步 |
| 2026-05-18 凌晨 | 撤回阶段三"双时钟分开"约束，改回 4 字段全相等（用户偏好）；修复 5/17_225347 分镜包 24/24 单元的时长字段；S4-U5 加反类型长镜头标记 |
| 2026-05-17 晚 | 阶段三全套激发改造（改造 1-9 完成），加摄影画像/镜头命题/反类型挑战/二稿端点/风格去重/节奏审计；闸门修 markdown 加粗格式正则 bug |
| 2026-05-17 下午 | 阶段二全套激发改造（视觉总命题/色彩剧本/道具情感学/多通道感官/反类型挑战/美术二稿端点）；新一稿评分 9.7 |
| 2026-05-17 上午 | 阶段一收尾改造（默认画像反惯性引导）；评分 9.3 |
| 2026-05-16 | 阶段一三项激发改造（主题命题/反类型挑战/导演剪辑端点）+ 4-6（导演画像/强制场号）+ 用户观察输入框 |
| 2026-05-15 之前 | 灵感生成器三项优化（避开历史/风格反例/归档）+ 剧本质量闸门 |

---

## 十、新窗口开机指令模板

如果你在新窗口打开这个项目，给 AI 这一句：

> 项目在 `c:\Users\Administrator\Desktop\storyboard-rag`，是 FastAPI + React 的 4 阶段 AI 短片导演工作站。请先读 `.kiro/PROJECT_STATE.md` 恢复完整上下文，再继续工作。

AI 读完这份档案就能直接进入"已经熟悉项目"的状态，无需翻历史对话。

---

## 十一、下一步可做（候选清单）

按优先级（自上而下）：

1. **跑全新阶段三验证 9.5+**（用 Claude/Gemini 跑一稿，验证 18 条护栏 + 7 类闸门是否一次性拦住旧病灶：微反应 beat / 角色锚定语 / 节奏均匀化 / 机位无动机 / 形容词通胀）
2. **阶段四激发改造**（场景图生图清单）—— 整个流水线最后一块未改造的拼图
3. **路由实验日志**——建立"模型 × 阶段 × 题材 × 评分"的项目档案，沉淀经验
4. **路由预设下拉**（前端）——治愈片预设、动作片预设、英文片预设各一组路由组合
5. **多模型自动会审**——3 个不同模型分别跑同一阶段，自动 diff + 投票出最佳版
