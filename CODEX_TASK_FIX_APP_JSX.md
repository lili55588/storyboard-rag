# Codex 任务：修复 App.jsx 编码损坏 + 加入打包按钮功能

## 问题描述

`frontend/storyboard-ui/src/App.jsx` 文件编码被损坏（全是 UTF-8 replacement characters），无法构建。需要从最近一次正常构建的 dist 产物反推恢复，或从项目上下文重建。

## 项目背景

这是一个 FastAPI + React (Vite) 的 4 阶段 AI 短片导演工作站。完整项目状态见 `.kiro/PROJECT_STATE.md`。

## 恢复策略

### 方案 A（推荐）：从 dist 反编译

`frontend/storyboard-ui/dist/assets/index-Bj_RXTyM.js` 是 2026-05-18 16:59 构建的，包含了打包按钮代码（`pack_visual_job`、`pack_shot_job` 等）。可以用 source map 或手动反编译恢复。

### 方案 B：从 prompts.json + rag_api.py 重建

后端 `rag_api.py` 和 `prompts.json` 都完好。App.jsx 的核心逻辑可以从这两个文件推断：
- `DEFAULT_PROMPTS` 对象的 4 个字段内容 = `prompts.json` 的 4 个 key
- API 调用的端点和参数 = `rag_api.py` 里的 `@app.post` 路由和 Request model

## 需要包含的功能（如果重建）

### 已有功能（必须保留）
1. 4 阶段生成（script/visual/shot/image）+ 流式输出
2. 3 个二稿端点调用（handleDirectorCut / handleArtDirectorCut / handleCinematographerCut）
3. 3 个历史回退栈（scriptDraftHistory / visualDraftHistory / shotDraftHistory）
4. 灵感生成器
5. 多方会审（4 槽位）
6. 项目目录管理（run_folders / run_outputs / save_output）
7. @图片资产库 CRUD
8. Codex 全案分镜图任务包
9. 导演/美术/摄影画像选择下拉
10. 风格预设（cute_3d/action/literary/none）
11. 接续生成

### 新增功能（这次要加的打包按钮）

在阶段二（visual，stage index 1）面板加：
- `📋 打包阶段二` 按钮：调用 `POST /pack_visual_job`，把返回的 prompt 复制到剪贴板
- `📥 导入视觉结果` 按钮：从剪贴板读取内容，写入 outputs[1]，调用 persistOutput 保存
- `📋 美术二稿` / `📋 二稿S1` / `📋 二稿末场` 按钮：调用 `POST /pack_art_cut_job`（force_scene: auto/first/last）

在阶段三（shot，stage index 2）面板加：
- `📋 打包阶段三` 按钮：调用 `POST /pack_shot_job`
- `📥 导入分镜结果` 按钮：从剪贴板读取，写入 outputs[2]，persistOutput 保存
- `📋 摄影二稿` / `📋 二稿首镜` / `📋 二稿末镜` 按钮：调用 `POST /pack_cine_cut_job`（force_unit: auto/first/last）

### 后端端点参数参考

```
POST /pack_visual_job
Body: { script, ip_names, art_director_profile, run_id }
Returns: { prompt, char_count, token_estimate }

POST /pack_shot_job  
Body: { script, visual, ip_names, cinematographer_profile, run_id }
Returns: { prompt, char_count, token_estimate }

POST /pack_art_cut_job
Body: { visual, script, ip_names, art_director_profile, revision_focus, force_scene, run_id }
Returns: { prompt, char_count, token_estimate }

POST /pack_cine_cut_job
Body: { shot, visual, script, ip_names, cinematographer_profile, revision_focus, force_unit, run_id }
Returns: { prompt, char_count, token_estimate }
```

## 关键约束

1. `DEFAULT_PROMPTS` 的内容必须与 `prompts.json` 完全同步（直接读 prompts.json 复制过来）
2. 阶段三的字段名已改为：注意力调度（替代情绪功能）、主动作与表演层（替代动作&情绪）、动作时间轴（核心动作 beat）
3. 前端解析分镜时要兼容新旧字段名（fallback 链：注意力调度 → 情绪功能；主动作与表演层 → 动作&情绪）
4. 文件必须是 UTF-8 编码（无 BOM）

## 验证方式

```bash
cd frontend/storyboard-ui
npx vite build
# 应该成功，无 error
```
