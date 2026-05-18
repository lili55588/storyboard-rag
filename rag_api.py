import os
import glob
import json
import random
import asyncio
import re
import time
import traceback
import httpx
import base64
from datetime import datetime
from collections import deque
from difflib import SequenceMatcher
from openai import AsyncOpenAI
from anthropic import AsyncAnthropic
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Dict, Optional
import uvicorn

def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default

# ---------- 1. 核心系统初始化 ----------
app = FastAPI(title="Micro Epic Engine API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

HTTP_CLIENT_LIMITS = httpx.Limits(max_keepalive_connections=100, max_connections=200)
HTTP_CLIENT_TIMEOUT = httpx.Timeout(300.0)

direct_http_client = httpx.AsyncClient(
    limits=HTTP_CLIENT_LIMITS,
    timeout=HTTP_CLIENT_TIMEOUT,
    trust_env=False,
)
env_proxy_http_client = httpx.AsyncClient(
    limits=HTTP_CLIENT_LIMITS,
    timeout=HTTP_CLIENT_TIMEOUT,
    trust_env=True,
)
proxy_http_clients: dict[str, httpx.AsyncClient] = {}


def get_http_client(use_proxy: bool = False, proxy_url: str = "") -> httpx.AsyncClient:
    if not use_proxy:
        return direct_http_client

    proxy = (proxy_url or "").strip()
    if not proxy:
        return env_proxy_http_client

    if proxy not in proxy_http_clients:
        proxy_http_clients[proxy] = httpx.AsyncClient(
            limits=HTTP_CLIENT_LIMITS,
            timeout=HTTP_CLIENT_TIMEOUT,
            proxy=proxy,
            trust_env=False,
        )
    return proxy_http_clients[proxy]


@app.on_event("shutdown")
async def close_http_clients():
    await direct_http_client.aclose()
    await env_proxy_http_client.aclose()
    for client in proxy_http_clients.values():
        await client.aclose()

# ---------- 2. 目录物理隔离 (核心层 vs IP专属层 vs 动态蒸馏层) ----------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

KB_CORE_DIR = os.path.join(BASE_DIR, "knowledge", "core")         # 【绝对只读】人类专家打磨的V5黄金法则
KB_IP_DIR = os.path.join(BASE_DIR, "knowledge", "ip")             # IP专属圣经
KB_DISTILLED_DIR = os.path.join(BASE_DIR, "knowledge", "distilled") # 【新增】AI自动蒸馏的动态草稿区
EX_CORE_DIR = os.path.join(BASE_DIR, "examples", "core")
EX_IP_DIR = os.path.join(BASE_DIR, "examples", "ip")

# 确保目录存在
for d in [KB_CORE_DIR, KB_IP_DIR, KB_DISTILLED_DIR, EX_CORE_DIR, EX_IP_DIR]:
    os.makedirs(d, exist_ok=True)
OUTPUTS_DIR = os.path.join(BASE_DIR, "outputs")
os.makedirs(OUTPUTS_DIR, exist_ok=True)
app.mount("/outputs", StaticFiles(directory=OUTPUTS_DIR), name="outputs")

PROMPTS_PATH = os.path.join(BASE_DIR, "prompts.json")  # 前后端提示词解耦
IMAGE_API_LOG_PATH = os.path.join(BASE_DIR, "image_api.log")
IMAGE_READ_TIMEOUT_SECONDS = 240.0
STREAM_START_TIMEOUT_SECONDS = _int_env("STREAM_START_TIMEOUT_SECONDS", 90)

run_folders: dict[str, str] = {}
_production_bible_cache: dict[str, dict] = {}


def log_image_event(message: str):
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    print(line)
    try:
        with open(IMAGE_API_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

STAGE_FILE_MAP = {
    "script": "剧本.md",
    "visual": "固定要素库包.md",
    "shot": "分镜提示词包.md",
    "image": "场景图生图清单.md",
    # ---- compat ----
    "prompt": "固定要素库包.md",
    "jimeng": "即梦提示词_完整版.md",
    "jimeng_direct": "即梦提示词_直投版.md",
    "render": "即梦提示词_豆包精炼版.md",
}


def _safe_run_id(run_id: str = "") -> str:
    return re.sub(r"[^0-9A-Za-z_\-]", "_", run_id).strip("_") if run_id else ""


def _safe_name_segment(name: str = "", default: str = "item", max_len: int = 80) -> str:
    safe = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_\-]+", "_", name or "").strip("_")
    return (safe[:max_len] or default)


def _safe_join_under(base_dir: str, *parts: str) -> str:
    base_abs = os.path.abspath(base_dir)
    target = os.path.abspath(os.path.join(base_abs, *parts))
    try:
        if os.path.commonpath([base_abs, target]) != base_abs:
            raise HTTPException(status_code=400, detail="路径超出允许目录。")
    except ValueError:
        raise HTTPException(status_code=400, detail="路径无效。")
    return target


def _stage_filename(stage: str = "") -> str:
    stage_key = (stage or "").strip()
    if stage_key in STAGE_FILE_MAP:
        filename = STAGE_FILE_MAP[stage_key]
    else:
        if not re.fullmatch(r"[0-9A-Za-z_\-]{1,64}", stage_key):
            raise HTTPException(status_code=400, detail=f"不支持的阶段名称：{stage_key or '空'}")
        filename = f"{stage_key}.txt"

    if not filename or os.path.basename(filename) != filename:
        raise HTTPException(status_code=400, detail="阶段输出文件名无效。")
    return filename


def get_or_create_run_folder(run_id: str = "") -> str:
    if len(run_folders) > 1000:
        run_folders.pop(next(iter(run_folders)))

    now = datetime.now()
    if run_id and run_id in run_folders:
        return run_folders[run_id]

    safe_run_id = _safe_run_id(run_id)
    folder_name = safe_run_id or now.strftime("%Y-%m-%d_%H%M%S")
    folder_path = os.path.join(OUTPUTS_DIR, folder_name)
    os.makedirs(folder_path, exist_ok=True)
    if run_id:
        run_folders[run_id] = folder_path
    return folder_path


def save_generated_content(stage: str, content: str, run_id: str = "") -> str:
    """自动存档：将生成内容按 总文件夹/日期时间/ 结构保存"""
    folder_path = get_or_create_run_folder(run_id)

    filename = _stage_filename(stage)
    filepath = _safe_join_under(folder_path, filename)

    # 全局清洗：剔除防断连心跳产生的零宽空格
    clean_content = content.replace('​', '')

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(clean_content)

    print(f"[自动存档] {stage} → {filepath}")
    return folder_path


conversation_histories: dict[str, deque] = {}
MAX_TURNS = 20

# 🌟 Prompt Cache 优化：会话级 system prompt 缓存
# 结构: {session_id: {"hash": str, "system_blocks": list, "full_text": str}}
# Claude 使用 system_blocks (含 cache_control)，OpenAI 兼容使用 full_text
_system_prompt_cache: dict[str, dict] = {}
_prompt_cache_stats = {
    "hits": 0,
    "misses": 0,
}


def _record_prompt_cache(hit: bool):
    if hit:
        _prompt_cache_stats["hits"] += 1
    else:
        _prompt_cache_stats["misses"] += 1
    total = _prompt_cache_stats["hits"] + _prompt_cache_stats["misses"]
    rate = (_prompt_cache_stats["hits"] / total * 100) if total else 0
    return total, rate


def _build_system_blocks(context: str, example_block: str, sys_prompt: str, stage: str = "") -> list[dict]:
    """
    为 Claude API 构建带 cache_control 的 system blocks。
    知识库部分标记为 ephemeral，让后续相同前缀请求命中 prompt cache。
    """
    parts = []
    if stage == "script":
        kb_text = (
            "【创作参考与角色底色】\n"
            "下面内容不是铁律，也不是制作清单；它只提供角色识别、性格底色和创作方向。"
            "请调用你作为编剧/导演的叙事、场面、人物关系和节奏判断，自由完成剧本初稿。\n"
            f"<creative_reference>\n{context}\n</creative_reference>"
        )
    else:
        kb_text = (
            "【后台制作手册与连续性约束】\n"
            "下面内容只用于保持世界观、角色一致性、技术边界和制作规范；"
            "创作时请自然吸收，不要复述规则口吻。\n"
            f"<knowledge_base>\n{context}\n</knowledge_base>"
        )
    if example_block:
        kb_text += f"\n{example_block}"

    parts.append({
        "type": "text",
        "text": kb_text,
        "cache_control": {"type": "ephemeral"}
    })

    task_text = (
        "======================================\n"
        f"【导演任务层】\n{sys_prompt}\n"
        "【交付方式】：直接输出本阶段成品，不解释思考过程，不复述后台规则，不写前言后语。"
    )
    parts.append({
        "type": "text",
        "text": task_text,
        "cache_control": {"type": "ephemeral"}
    })
    return parts


def _get_system_prompt_cache_key(context: str, example_block: str, sys_prompt: str) -> str:
    """生成 system prompt 的哈希键，用于判断是否可以复用缓存。"""
    import hashlib
    raw = f"{context}||{example_block}||{sys_prompt}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()

STAGE_TEMPERATURES = {
    "script": 0.75,
    "visual": 0.40,
    "shot": 0.45,
    "image": 0.35,
    # ---- compat ----
    "prompt": 0.40,
    "jimeng": 0.30,
    "render": 0.30,
}

SCRIPT_DRAMA_GUARD = """【剧本质量护栏】
1. 每个场号都必须包含一个温柔但明确的“小戏剧动作”：角色想做什么、遇到什么阻力、做出什么选择、造成什么结果。治愈片也不能只写一路看风景。
2. 全片至少要有一条关系变化弧：例如一开始谁跟随谁、谁误判了环境、谁拖慢了节奏；中段通过一次小麻烦改变相处方式；结尾用一个可看见的动作证明关系已经变化。
3. 环境奇观必须由角色行动触发、阻碍或奖励角色行动；不要把场景写成“到达新地点后欣赏风景”的陈列。
4. 如果用户目标或项目气质是治愈、童话、软萌、轻冒险，阻力必须低危险、可触摸、可玩耍，例如花丛遮挡、树根小坡、浅溪石头、蘑菇弹性、叶片桥、阳光/水纹方向错误。不要把浓雾、黑暗、深水、断崖、暗区、惊吓或悬疑作为核心机制。
5. 治愈童话场景要优先设计“一眼可记住的童话地标物 + 中景可表演的小舞台”，例如向日葵花田、雏菊坡、树根拱门、粉色蘑菇地、藤蔓秋千、浅溪边、柔软苔藓木桥；雾只能是轻透明空气感，不能成为主角。
6. 同一种剧情公式最多连续使用两次；第三次必须迫使角色主动做出新选择，或让道具/关系/空间状态发生不可逆变化。不要把90秒写成“遇险-救援-愣住-继续走”的循环。
7. 每个场号结束时，观众必须看见至少一个已经改变的事实：角色站位、道具归属、路径开闭、误会程度、信任程度、危险来源或目标方向。没有变化就重写该场。
8. 编剧诊断概念只用于内部判断和修稿，不要在成品剧本中输出“激励事件、人物弧线、转折点、冲突、节拍”等术语解释。"""

SOFT_PET_SUCCESS_GUARD = """【香蕉猫/刀盾狗成功样片叙事护栏】
1. 这类片子的“味道”来自一串可见微事件，而不是一个大危机拉满全片。70-110秒通常需要8-14个可读小节拍，合并成4-6个场号。
2. 每个场号都要像一个小玩法：新奇物/地形出现 → 角色靠近或试探 → 发生轻微物理反馈 → 其中一方笨拙反应 → 位置、道具、路径或关系状态发生变化。
3. 香蕉猫和刀盾狗的核心搭配是“好奇发起 + 笨拙跟随/本能护卫/被动承接”。不要把它们写成会计划、会解释、会说话、会精密战斗的人类小队。
4. 圆盾、叶片、蘑菇、水面、花粉、藤蔓、石头坡这类元素必须参与动作：能挡、滑、弹、遮、反射、溅起或打开新路。不要只当背景装饰。
5. 成功片会交替使用三种节拍：安静奇观、笨拙物理笑点、温柔关系确认。连续两个“走路/凝视/停住/看风景”之后必须出现新的物理事件或选择。
6. 阻力要低危险、可触摸、可玩耍；避免深水断崖、黑暗惊吓、追杀对抗、打怪升级成为核心。危险可以短暂出现，但要迅速转化成玩法、发现或关系变化。
7. 原片尺度更接近“童话微缩花园”，不是普通正常比例森林：花朵、叶片、蘑菇、草坡、飞船或其他道具常常明显大过角色，形成“小生命面对大世界”的包围感和玩法。但不要写成显微镜素材、只拍局部苔藓或背景完全虚化。
8. 结尾必须用一个可见动作落在关系上：并肩停下、盾牌放低、共享遮蔽、一起看见新景象、轻碰同伴等。不要只用远景美图或空泛“继续前行”收束。"""

SOFT_PET_DIRECTOR_MATRIX_GUARD = """【香蕉猫/刀盾狗导演总控矩阵】
1. 导演总意图：不是普通萌宠流水账，而是“小生命在大世界里认真探索”的无对白童话观察喜剧。所有剧本、场景、分镜和提示词都要服务“认真、迟钝、轻麻烦、温柔回响”。
2. 观众情绪路径：好奇进入 → 小玩法触发 → 笨拙反应/轻笑点 → 安静奇观停顿 → 关系确认。不要长期停在同一种情绪。
3. 角色调度：香蕉猫偏好奇触发、靠近未知、慢半拍受反馈；刀盾狗偏跟随、误判、本能举盾、被动承接或笨拙补位。角色不解释、不计划、不说话。
4. 空间美术：空间必须是可游走的童话微缩花园，不是背景贴图。每场要有一个可记住的地标物和一个可表演的小舞台，且地标/路径/道具能参与动作。
5. 道具机制：圆盾、叶片、蘑菇、水面、花粉、藤蔓、石头坡、飞船舱门等不是装饰，必须能遮挡、弹起、反射、滑行、打开路径、制造误会或确认关系。
6. 摄影原则：镜头像耐心观察者，而不是炫技摄影师。用静止锁定、角色高度、斜俯拍/俯拍、慢推/慢拉、横向跟随和前景遮挡组织观看，不要全片单一机位。
7. 剪辑原则：以硬切为主，切在状态变化上。每次切换都要让观众更清楚动作、空间、关系或笑点，不用无意义快切填节奏。
8. 声音想象：默认无对白；节奏主要靠环境声和触感音支撑，如草叶摩擦、轻脚步、盾牌轻响、花粉喷散、水面涟漪、蘑菇回弹。音乐只托住情绪，不抢戏。
9. AI执行原则：每个生成单元必须同时写清“看哪里、角色怎么动、道具/环境怎么反馈、结束时局面变成什么”。不能只堆风格词、材质词或空泛治愈氛围。"""

SOFT_PET_CAMERA_GUARD = """【香蕉猫/刀盾狗原片运镜与镜头语言护栏】
1. 总体摄影风格是“安静观察 + 角色高度亲近 + 适时斜俯拍/俯拍交代空间 + 少量柔和推轨”，不是炫技运动镜头。优先让角色、植物、道具自己动，镜头只轻微陪伴。
2. 可用运镜优先级：静止锁定、极缓慢推近/拉远、横向跟随、前景叶片/树干遮挡转场、角色向镜头Z轴靠近造成景别变化。少用手持晃动；禁止把每个生成单元都写成“手持轻微晃动”。
3. 每个场景至少包含一种关系镜头和一种环境尺度镜头：中景/中近景双人关系镜头负责看互动；低机位全景、大全景、斜俯拍或俯拍负责看路径、花田/森林尺度和“小生命面对大世界”。不要全片只用中景跟拍，也不要全片只用低机位。
4. 细节镜头要服务触感和物理反应：花粉、叶片、盾牌、水面、蘑菇、爪子轻碰、角色眼神可用近景/特写/插入镜头。特写不是空泛卖萌，必须承接一个动作或反应。
5. 剪辑以硬切为主，但切点要落在状态变化上：停下、触碰、被弹、举盾、看见新物、关系距离变近。可以用前景遮挡擦过镜头做柔和换景。
6. 节奏参考：安静奇观或关系确认只有包含空间变化、关系变化或环境反馈时才允许3-6秒；物理笑点和反应通常1-3秒。眨眼、耳抖、眼神、凝视等微反应默认不进入动作时间轴，只作为主动作同一时间发生的表演层；只有大特写/插入镜头专门表现微反应时，才可单列0.3-0.8秒。轻碰、点水、回头这类短动作必须和它触发的涟漪、道具反馈或关系反馈写在同一时间段里，不拆成独立停顿。只有喜剧包袱可短暂快速推近或加快剪辑。不要用动作片式快速摇移、绕拍、甩镜、频繁升格。
7. 景深策略是“前景柔化 + 主体清楚 + 后景可读”，不是背景完全虚化。前景花草可以形成窥视感和画框，但不能挡住角色核心动作。"""

SHOT_NARRATIVE_GUARD = """【阶段三分镜叙事与场景锁定护栏】
1. 分镜阶段只能拆解 Stage 1 剧本和 Stage 2 场景卡，禁止新增、删除、改名、重排场景；如果 Stage 2 有“场景卡 · | S3 | 风化陡坡”，输出标题必须仍是“## | S3 | 风化陡坡”，不能改成“竹林追击”等新场景。
2. 每个场景必须覆盖剧本中该场的核心事件链：目标、阻力、角色选择、可见结果。不得只保留移动、凝视、对峙、怒吼、站立、转身离开等姿态镜头。
3. 每个生成单元必须写“注意力调度”，格式是“观众视线从A转到B，再落到C”，禁止写成心理评论（如“建立好奇”“制造紧张”“体现温柔”）。导演分镜要调度观众看哪里，不要解释角色想什么。
4. “主动作与表演层”必须分开写：主动作=位移、触碰、抓取、脱手、摔落、举盾、滑行、后撤、停住后造成局面变化；表演层=眼睛、耳朵、呼吸、僵住、屏息、重心预备，只能括号附在同一主动作后，不得单独计时。
5. 每个生成单元的“主动作与表演层”和“衔接状态”必须写清本镜头导致了什么变化：道具状态、角色位置、关系认知、路径开闭、危险解除或新危险出现。没有局面变化的镜头必须合并或删除。
6. 同类动作不能连续堆叠超过两个生成单元；如果连续出现追逐、回头、停步、凝视、对峙，必须在第二个之后加入新的物理事件或角色选择。
7. 阶段三的 4 个时长字段（动作有效时长 / 成片时长 / 视频提交时长 / 生成时长）必须全部相等，等于角色真实戏剧动作所需时长。冗余加时（例如即梦提交时常额外加 2 秒防截断）由用户在即梦平台自己决定，阶段三不要预判，更不要在分镜包里给视频提交时长或生成时长写不同数值。全案分镜图按这一统一时长切格。
8. 动作时间轴只列核心动作 beat。眨眼、眼睛睁大、耳朵后压/抖动、眼神反应、凝视、微僵、身体僵住、屏息、呼吸变浅、歪头等微反应禁止独立占一行时间轴；底盘微沉、重心下沉/前移、肩膀松弛、身体前倾等体态预备也禁止独立占一行，只能写成“带重心下沉的后撤半步”这类主动作修饰语。
9. 短动作时长硬表：轻碰/点水/回头0.6-1.0秒，必须和触发的涟漪、道具反馈或关系反馈写在同一时间段；后撤半步/缩脖/本能后仰0.3-0.6秒；入画/试探移动1.2-2秒；打滑/碰撞/盾牌飞出1-2秒。单一微反应或体态预备不得独立占时。
10. 3秒以上的生成单元必须在动作时间轴里写出至少3个可见状态变化；如果只是凝视、静止、微僵、睁大眼、耳朵微动、看向远方，必须压缩并并入相邻主动作。
11. 有角色原图时，阶段三所有字段都禁止复制角色卡外形锚定语，例如“玻璃球眼睛、短爪、香蕉躯干、橙白幼猫脸、小短腿”等；统一改写为“眼睛、爪子、身体、面部”。角色一致性交给 @图片1-9，阶段三只写当下动作与镜头任务。
12. 动作词要可执行，少用“慢慢/缓缓/轻轻/微微/极轻/骤然/极速”等形容词堆叠；同一生成单元最多出现2个这类副词，超出时必须改成秒数、距离、方向、接触点或触发结果。
13. “总体导演策略”里的生成单元数量、总时长、节奏支点必须与下方实际生成单元一致；不能先写18个，正文又生成24个。
14. 全片连续性检查不是装饰项，只有确实逐项满足时才能写通过；如果发现缺场景、加场景、时长不符、动作时长拖沓、微反应独立计时、角色锚定语污染或场景名不符，必须在检查表中明确写“未通过”。
15. 机位戏剧动机：每个生成单元的“镜头类型/运镜”后面必须用括号写出一句不超过 20 字的“为什么必须这个机位”——例如“(贴地仰拍：让小生命压在巨型蒲公英下方)”、“(过肩反打：让观众第一次看见跟随者的视角)”、“(极远固定大全景：用 90% 静止反衬一个微小依靠)”。禁止只写景别+机位却不答“为什么不选其他”。
16. 全片节奏曲线：在“总体导演策略”里必须用一行隐藏字段写出全片节奏曲线，格式为“（节奏曲线：S1 [tempo] / S2 [tempo] / S3 [tempo] / S4 [tempo]，仅供制作团队参考）”，tempo 词从 build/fast/medium/slow/static 中选；同时全片必须至少出现 1 次 ≥5 秒的长镜（节奏锚点：呼吸/凝视/收束）和 1 次 ≤0.8 秒的短切（节奏锚点：闪切/惊喜/冲击），缺其中任一项视为“节奏支点缺失”。
17. 声音设计曲线：在“总体导演策略”里增加“声音曲线”一行，写清全片声音的 macro 设计（例：静默 → 单点脆响 → 风声起 → 喘息 → 完全静默 → 一记湿润闷响 → 收束环境音），不要每个生成单元独立堆音效词；生成单元的音效字段只写偏离曲线的差异。
18. 视觉差异锚点表：每个场景在场景头部写一行“与上一场视觉差异锚点”，从光线方向变化/主导色变化/景深差异/前景元素更替/远景结构更替五项中至少选两项，写成可被美术看见的具体差异；不允许写成“整体氛围转冷”这类抽象描述。"""

VISUAL_COMPACT_CHARACTER_GUARD = """【视觉开发角色卡节省规则】
如果项目已有角色原图或已指定 @图片1、@图片2，角色一致性交给原图，不要重新长篇描写角色外貌。
角色卡只输出：角色原图引用写法、20-40字短识别兜底、永久附属物、少量允许变化状态、3-6条禁止跑偏、参考图登记。
完整锁定描述只在无角色原图、首次建模或跑偏修正时使用。不要主动规划大量角色状态图；把篇幅留给场景卡、道具、空间层次和@图片编号。
【短识别兜底防污染说明】
"短识别兜底"和"完整锁定描述"是阶段二专用的角色卡内部锚定字段，用于"无原图/跑偏修正/首次建模"。这两段必须明令禁止在阶段三的任何字段复制使用——例如"玻璃球眼睛、短爪、香蕉躯干、橙白幼猫脸、小短腿"等锚定语只能留在角色卡里，绝不能出现在阶段三的镜头类型、注意力调度、主动作与表演层、灯光氛围、衔接状态或完整提示词里。请在角色卡末尾用一行隐藏字段提醒："（短识别兜底仅供阶段二建模/跑偏修正使用，阶段三只用 @图片X+动作，禁止复制锚定语）"。"""

VISUAL_SCENE_IMAGE_PROMPT_GUARD = """【场景图提示词边界】
每个场景卡必须包含一个可手动复制去生图的场景生图提示词字段。
该字段一次只输出一种版本：即梦中文场景生图提示词 或 MJ英文场景生图提示词，不要双语并列。
场景生图提示词不是视频分镜提示词：不要写运镜、镜头运动、生成时长、首尾帧、提交策略。
重点写场景空间、主体留白、前景/中景/后景、关键道具、光线、材质、色彩、风格、画幅比例。

【空场景美术与尺度硬约束】
1. 场景图是空场景资产，不出现角色、动物、人物、拟人角色或额外生物；后续会用角色原图单独合成。
2. 参考观感不是显微镜视角、微距素材或苔藓局部素材，而是角色高度、斜俯拍或俯拍都能成立的可读动画电影场景。若剧本/IP是香蕉猫、刀盾狗或明确“小生命面对大世界”，允许童话微缩花园尺度：花朵、叶片、蘑菇、草坡或道具可明显大过角色，但必须保留中景表演留白和可读后景空间。
3. 可以使用中低机位、斜俯拍、俯拍、少量前景草叶/雨滴/叶片自然虚化遮挡，但后景森林、山谷、水道、树根结构或光束必须可读，不能把背景写成完全虚化。
4. 每条场景生图提示词必须保留中景可入画的表演留白，同时给出可辨认的远景风景和空间纵深。
5. 草地、苔藓或森林地面必须是真实自然材质：草叶长短不一、疏密不均，有泥土、落叶、小石子、湿润暗部、局部踩压痕迹和自然杂草；不要写成统一草皮贴图、塑料网、人工草坪或重复编织纹理。
6. 治愈童话空场景优先使用“童话地标物 + 柔软自然地表舞台 + 前景叶片/花草包围 + 可读森林纵深 + 少量透明空气感 + 暖光斑”的构成；童话地标物可以是向日葵、雏菊、粉色蘑菇、树根拱门、浅溪石头、藤蔓秋千、苔藓木桥等，每场选择1-2个即可。
7. 每张场景图都要有明确空间任务：入口/过渡/阻碍/转折/开阔收束之一；同时写清构图引导线、空气透明度/极薄水汽、冷暖光变化和中景空白区域，避免四张图只是同一种森林皮肤。
8. 雾只能作为极轻透明水汽或远景空气透视，不得成为主视觉。除非用户明确要求悬疑/惊悚，不要使用浓雾、厚雾、冷青绿浓雾、暗水区、深色水面、昏暗断崖、黑暗峡谷、神秘恐怖、惊悚、悬疑等词。
9. 场景提示词生成后必须内部自检：无角色，中景有可合成空区，远景可读，关键地形清楚，材质不塑料，和上一场有明确视觉差异。
10. 禁止默认使用：显微镜视角、微距摄影、小人国、露珠湖泊、极浅景深、背景完全虚化、只拍一小块苔藓/叶片/水滴、塑料草皮、网格草地、人工草坪、重复纹理、写真摄影感、阴冷写实峡谷。童话微缩、巨型叶片等尺度词只在剧本/IP明确需要"小生命面对大世界"时使用。
11. 反同质化（场景图提示词层面）：所有场景图 prompt 不得共用相同的"风格头"或"风格尾"。每场必须用本场最强的视觉特征作为开篇关键词——例如 S1 用"阳光斑驳穿草冠"、S2 用"水膜反光与跳跃光斑"、S3 用"明暗交界线分割画面"——而不是固定写"3D半写实梦幻动物动画，正常尺度动画电影空间..."。风格词、画幅、质量约束可以放在中后段，但不要 4 张图都是同一个 30 字开头模板。
12. 同空间复用规则：如果两场（如 S3/S4）共用同一个空间且复用同一张 @图片，第二张场景卡必须给出"图像层面的明确差异锚点"（光源方向变化、新增前景元素、远景透出新景深、地面状态改变之一），不能只在 prompt 里靠"光线状态改变"这种文字叙述蒙混过去——要让美术看到这条 prompt 时知道"我必须画出哪一处可见的差异"。"""


# 改造：阶段二美术指导画像（与阶段一导演画像配对）
ART_DIRECTOR_PROFILES: dict[str, dict[str, str]] = {
    "default": {
        "label": "默认（按导演画像或自行判断）",
        "prompt": (
            "由你判断最适合本片气质的美术方向。如果用户在阶段一选过导演画像（宫崎骏/皮克斯/韦斯·安德森/A24/米林宏昌），"
            "美术应当与导演审美保持同一调性。但请同时考虑：是否可以让美术与导演形成温柔的互补——例如皮克斯式导演 + 米林宏昌式美术，"
            "可以让翻转故事获得更细腻的质感。请在视觉意图总览开头用一两句话写明你的美术选择。"
        ),
    },
    "miyazaki_art": {
        "label": "宫崎骏组美术（自然万物自有生命）",
        "prompt": (
            "宫崎骏组美术（《龙猫》《幽灵公主》《千与千寻》气质）：自然万物有重量、有呼吸、有不被人物注意的自我；"
            "色彩温暖饱和但不卡通；光线偏柔和漫反射，少用锐利侧逆光；"
            "前景元素（草尖、叶背、水滴）必须有真实质感；后景永远可读，常给一个让人想走进去的远景出口。"
            "禁忌：忌过度对比、忌冷硬几何感、忌把自然当装饰板——自然要参与剧情。"
        ),
    },
    "pixar_art": {
        "label": "皮克斯组美术（情感物理化）",
        "prompt": (
            "皮克斯组美术（《飞屋》《Wall-E》《心灵奇旅》气质）：每个材质都为情感服务——绒毛要让人想抱、金属要让人感到孤独、水珠要让人想到泪；"
            "色彩规则强烈（一场一个主导色，色彩本身就是叙事）；光影对比明确，用光区位置直接告诉观众情绪重心；"
            "前中后景层次清晰，绝不让背景模糊到丢失阅读价值。"
            "禁忌：忌平淡漫反射、忌'看起来像'的材质、忌没有色彩主导的画面。"
        ),
    },
    "wes_anderson_art": {
        "label": "韦斯·安德森组美术（对称色板）",
        "prompt": (
            "韦斯·安德森组美术（《布达佩斯大饭店》《了不起的狐狸爸爸》气质）：对称构图意识贯穿每一张图；"
            "用 3-5 色严格色板（高饱和但克制），所有道具必须落在色板内；"
            "灯光偏中性平直，少用动态光影；前中后景层次像舞台剧一样清晰分层。"
            "禁忌：忌自由摄影感、忌色彩混乱、忌真实主义自然光、忌情绪靠光影暗示。"
        ),
    },
    "a24_indie_art": {
        "label": "A24 独立片美术（沉默与材质）",
        "prompt": (
            "A24 独立片美术（《瞬息全宇宙》《阳光小美女》《佛罗里达乐园》气质）：用材质而非剧情说话——一面墙的剥落、一张椅子的褪色、一片草的方向；"
            "色彩偏自然主义，不强调饱和；光源常常单一（一扇窗、一盏灯），其余区域允许暗下来；"
            "构图允许不对称甚至轻微违和，留白比饱满更重要。"
            "禁忌：忌完美布光、忌中性平衡、忌为美而美的合成感。"
        ),
    },
    "ghibli_yonebayashi_art": {
        "label": "米林宏昌组美术（细腻日常质感）",
        "prompt": (
            "米林宏昌组美术（《借物少女艾莉缇》《记忆中的玛妮》气质）：把日常微观的质感放大到值得屏息——叶脉粗细、布纹经纬、水的反光层次；"
            "色彩柔和但每一处都有变化，绝不让大面积同色出现；光线讲究'光的物理重量'：阳光斜过桌面会有真实的尘埃浮动；"
            "前景元素往往比背景更值得细看；尺度感强烈但不卡通。"
            "禁忌：忌奇观堆积、忌大面积纯色填充、忌简化成卡通色块。"
        ),
    },
}


def _resolve_art_director_profile(key: str) -> dict[str, str]:
    """归一化美术指导画像 key，返回 {label, prompt}。"""
    profile = ART_DIRECTOR_PROFILES.get((key or "default").strip().lower())
    return profile or ART_DIRECTOR_PROFILES["default"]


# 阶段三摄影指导画像（与阶段一/二画像配对）
CINEMATOGRAPHER_PROFILES: dict[str, dict[str, str]] = {
    "default": {
        "label": "默认（按导演/美术画像或自行判断）",
        "prompt": (
            "由你判断最适合本片的摄影方向。如果用户在阶段一选了导演画像或阶段二选了美术画像，摄影应当与之保持同一调性。"
            "但请同时考虑：能否让摄影成为'第三只眼'——一个独立的观察者，而不是亦步亦趋的服务者。"
            "请在'总体导演策略'开头用一两句话写明你的摄影选择理由。"
        ),
    },
    "still_observer": {
        "label": "静止观察者（吉卜力/侯孝贤组）",
        "prompt": (
            "静止观察者式：固定机位为主，让世界自己动；时长可以长，机器不要动；"
            "用景别变化（角色靠近镜头）替代摄像机运动；只在情绪转折点用一次极缓慢的推镜或拉镜，其他全部固定；"
            "前景遮挡可以制造画框感。禁忌：忌追踪运镜、忌手持晃动、忌为了'动'而动。"
        ),
    },
    "deakins_minimal": {
        "label": "罗杰·迪金斯式（极简精确）",
        "prompt": (
            "罗杰·迪金斯式（《1917》《银翼杀手 2049》气质）：每个机位都有明确戏剧意图；"
            "用极少的镜头讲清楚一件事，时长可以拉长但不允许多余镜头；"
            "对称构图、大景别留白、光源位置严格控制；"
            "强调'在一个镜头里完成两个戏剧动作'。禁忌：忌花哨运镜、忌镜头数量大于戏剧需要。"
        ),
    },
    "lubezki_natural": {
        "label": "卢贝兹基式（长镜头自然光）",
        "prompt": (
            "卢贝兹基式（《荒野猎人》《地心引力》气质）：长镜头跟随，自然光为主，呼吸感重；"
            "镜头随角色走，但不主动加戏；用一个镜头完成一段情绪流转；"
            "光线随时间变化，画面有'当下感'。禁忌：忌切换密度过高、忌人造光过强、忌镜头静止超过 5 秒。"
        ),
    },
    "wong_kar_wai": {
        "label": "王家卫式（浅景深+情绪手持）",
        "prompt": (
            "王家卫式（《花样年华》《重庆森林》气质）：浅景深突出主体，背景虚化但保留色彩；"
            "微手持节奏（不是晃动，是呼吸）；用过肩反打、镜面反射、霓虹光斑制造情绪；"
            "时长偏短，节奏快但安静；色彩饱和高，光源明确。禁忌：忌全景大景深、忌冷调白光、忌长镜头超过 6 秒。"
        ),
    },
    "miyazaki_yoneda": {
        "label": "宫崎骏组米田仁式（治愈跟随）",
        "prompt": (
            "宫崎骏组米田仁（《龙猫》《千与千寻》摄影组）式：以静止为主，关键情绪用一次极缓慢推镜（5-7秒）；"
            "用前景叶片/草尖/水面遮挡形成自然画框；"
            "景别多样但不密集变化，每场只用 2-3 种景别；"
            "光线柔和，少用强对比。禁忌：忌密集切换、忌强烈运动、忌冷调高对比。"
        ),
    },
    "kar_wai_anderson_hybrid": {
        "label": "韦斯·安德森式（对称固定）",
        "prompt": (
            "韦斯·安德森式（《布达佩斯大饭店》《狗之岛》气质）：严格对称构图，固定机位，正面/侧面/俯视三角度；"
            "人物在画面正中或严格三分位；只用 90 度水平摇移和垂直推拉，不用斜向；"
            "色彩高饱和但克制，光线平直。禁忌：忌斜构图、忌跟拍、忌手持感、忌随机机位。"
        ),
    },
}


def _resolve_cinematographer_profile(key: str) -> dict[str, str]:
    """归一化摄影画像 key，返回 {label, prompt}。"""
    profile = CINEMATOGRAPHER_PROFILES.get((key or "default").strip().lower())
    return profile or CINEMATOGRAPHER_PROFILES["default"]


def _is_banana_cat_dog_project(ip_names: list[str] | None, prompt_text: str = "") -> bool:
    haystack = " ".join(ip_names or []) + "\n" + (prompt_text or "")
    return any(keyword in haystack for keyword in ("香蕉猫", "刀盾狗"))


# 知识库单文件体积上限（超出时自动裁剪，保留后2/3内容）
MAX_KB_FILE_BYTES = 60000

# ---------- 3. 动态按需读取知识库 ----------
async def load_knowledge_for_stage(stage: str, ip_names: list[str], run_id: str = "") -> str:
    # 每个阶段只加载真正需要的库，避免注意力稀释
    # 阶段设计原则：剧本阶段先按真实影视剧作成立，不预加载生图/视频/分镜约束
    # 🌟 KB 2026-05 重构：四阶段架构 (剧本 / 视觉开发 / 分镜提示词 / 场景图生图清单)
    #   script  → 剧本：轻量剧作参考 + IP 剧本设定
    #   visual  → 视觉开发：固定要素库模板 + 锁定语法（+ IP）
    #   shot    → 分镜提示词：锁定/运镜/镜头语言/剪辑/风格/即梦手册（+ IP 角色卡）
    #   image   → 场景图生图清单：只整理 @图片10-49 空场景图 + 静态画面电影感 + 风格词
    # （旧的 prompt/jimeng/render 保持兼容，但映射到新的知识库组合）
    stage_kb_map = {
        "script":  ["KB-03_叙事结构规范.md", "KB-13_编剧诊断概念库.md"],
        "visual":  ["KB-04_固定要素库模板.md", "KB-05_角色场景锁定语法.md", "KB-12_目标视频元素风格.md", "KB-16_AI画面电影感与空间构图.md"],
        "shot":    [
            "KB-06_运镜语法库.md",
            "KB-07_镜头语言库.md",
            "KB-08_剪辑逻辑库.md",
            "KB-11_终极_分镜导演执行手册.md",
            "KB-09_风格词组库.md",
            "KB-12_目标视频元素风格.md",
            "KB-14_AI视频状态流与多角色控制.md",
            "KB-15_镜头情绪匹配与情绪蒙太奇.md",
            "KB-16_AI画面电影感与空间构图.md",
        ],
        "image":   ["KB-05_角色场景锁定语法.md", "KB-09_风格词组库.md", "KB-12_目标视频元素风格.md", "KB-16_AI画面电影感与空间构图.md"],
        # ----- 兼容旧接口 -----
        "prompt":  ["KB-04_固定要素库模板.md", "KB-05_角色场景锁定语法.md", "KB-12_目标视频元素风格.md", "KB-16_AI画面电影感与空间构图.md"],  # 旧 prompt → 视觉开发
        "jimeng":  [
            "KB-06_运镜语法库.md",
            "KB-07_镜头语言库.md",
            "KB-08_剪辑逻辑库.md",
            "KB-11_终极_分镜导演执行手册.md",
            "KB-09_风格词组库.md",
            "KB-12_目标视频元素风格.md",
            "KB-14_AI视频状态流与多角色控制.md",
            "KB-15_镜头情绪匹配与情绪蒙太奇.md",
            "KB-16_AI画面电影感与空间构图.md",
        ],
        "render":  [],
    }

    target_filenames = stage_kb_map.get(stage, [])

    # ━━━ 第一层级：核心铁律（按阶段选择性加载）━━━
    core_text = ""
    for filename in target_filenames:
        core_path = os.path.join(KB_CORE_DIR, filename)
        if os.path.exists(core_path):
            try:
                with open(core_path, "r", encoding="utf-8") as f:
                    core_text += f.read() + "\n\n"
            except Exception:
                pass

    # ━━━ 第二层级：蒸馏草稿（按需过滤加载）━━━
    distilled_text = ""
    if stage != "script" and os.path.exists(KB_DISTILLED_DIR):
        for filename in os.listdir(KB_DISTILLED_DIR):
            if not filename.endswith(".md"):
                continue

            # 🛡️ 核心补丁：剧本阶段绝对屏蔽视觉、美学、执行类蒸馏法则！
            if stage == "script" and any(kw in filename for kw in ["视觉", "美学", "执行", "即梦", "案例"]):
                continue
            # 分镜阶段屏蔽纯美学法则
            if stage == "shot" and "美学" in filename:
                continue

            try:
                with open(os.path.join(KB_DISTILLED_DIR, filename), "r", encoding="utf-8") as f:
                    distilled_text += f.read() + "\n\n"
            except Exception:
                pass

    # ━━━ IP 专属资产（按阶段过滤文件名）━━━
    # 新架构下 IP 目录里分三类文件：
    #   剧本设定_*.md      → 阶段 script 加载（基础外貌与性格底色）
    #   角色性格_*.md      → 阶段 script 加载（行为模式、关系合奏、叙事触发）
    #   世界观.md          → 阶段 visual + image 加载（空间尺度与场景气质）
    #   角色卡_*.md        → 阶段 visual + shot + image 加载（视觉锚定）
    #   角色性格_*.md      → 阶段 script + shot 加载（行为节奏与关系调度）
    stage_ip_filter = {
        "script": ["剧本设定", "角色性格"],
        "visual": ["世界观", "角色卡"],
        "shot":   ["角色卡", "角色性格"],
        "image":  ["世界观", "角色卡"],
        "prompt": ["角色卡", "角色性格"],     # 兼容旧路由
        "jimeng": [],
        "render": [],
    }
    filename_keywords = stage_ip_filter.get(stage, None)

    ip_text = ""
    for ip_name in ip_names:
        if not ip_name or ip_name == "通用新IP项目":
            continue
        try:
            ip_path = _safe_join_under(KB_IP_DIR, ip_name)
        except HTTPException:
            print(f"[IP资产加载跳过] 非法IP目录名: {ip_name}")
            continue
        if not os.path.exists(ip_path):
            continue
        for md_file in glob.glob(os.path.join(ip_path, "*.md")):
            basename = os.path.basename(md_file)
            # 未定义过滤器 → 加载全部；定义了 → 只加载匹配关键词的文件
            if filename_keywords is not None and not any(kw in basename for kw in filename_keywords):
                continue
            try:
                with open(md_file, "r", encoding="utf-8") as f:
                    ip_text += f"\n<!-- ========== {ip_name}/{basename} ========== -->\n"
                    ip_text += f.read() + "\n\n"
            except Exception as e:
                print(f"[IP资产加载失败] {basename}: {e}")

    registry_text = ""
    if stage in ("visual", "shot", "image", "prompt", "jimeng"):
        try:
            reg = _load_image_registry()
            rows = []
            for sid, entry in _iter_registry_entries(reg, run_id):
                label = f"@图片{entry.get('id', sid)}"
                desc = entry.get("description", "")
                category = entry.get("category", "")
                status = entry.get("status", "")
                path = entry.get("path", "")
                exists = "已上传" if path and os.path.exists(path) else status or "已登记"
                rows.append(f"- {label}｜{category}｜{exists}｜{desc}")
            if rows:
                registry_text = "\n".join(rows)
        except Exception:
            registry_text = ""

    if not core_text and not distilled_text and not ip_text and not registry_text:
        return "（当前无知识库文件）"

    # ━━━ 结构化组合（确立权重优先级）━━━
    parts = []
    if core_text:
        if stage == "script":
            parts.append(f"""━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【剧本阶段创作参考】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
以下内容只提供创作方向，不是硬性清单。请优先像真实编剧/导演一样判断故事、人物和场面：
{core_text}""")
        else:
            parts.append(f"""━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【第一层级：绝对核心铁律 (必须100%遵守)】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
以下法则为导演人工校准的底层逻辑，拥有最高优先级，任何情况下不得违背：
{core_text}""")
    if ip_text:
        if stage == "script":
            parts.append(f"""━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【IP创作参考】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
以下只用于保留角色的基础识别和性格底色。具体行为、情绪和关系变化由剧情自然决定：
{ip_text}""")
        else:
            parts.append(f"""━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【IP专属设定 (硬约束)】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{ip_text}""")
    if registry_text:
        parts.append(f"""━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【已绑定参考图资产（硬约束）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
以下 @图片编号已绑定真实图片文件。生成视觉开发、分镜和场景图请求包时必须沿用这些编号，不要把它们重新编号或当作待生成占位：
{registry_text}""")
    if distilled_text:
        parts.append(f"""━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【第二层级：最新动态参考 (仅供灵感补充)】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
以下为近期拉片提取的补充灵感。当且仅当其不违背上述【核心铁律】时，可选择性采纳：
{distilled_text}""")

    return "\n".join(parts)


def get_random_few_shot_example(ip_names: list[str], shot_type: str = "") -> str:
    # 按类型子目录查找 JSON 范例
    example_files = []
    for subdir in ["action_peak", "static_hold", "transition_bridge", "soft_reaction"]:
        type_dir = os.path.join(EX_CORE_DIR, subdir)
        if os.path.exists(type_dir):
            example_files.extend(glob.glob(os.path.join(type_dir, "*.json")))

    # 也检查根目录下的 JSON 文件（兼容旧格式）
    example_files.extend(glob.glob(os.path.join(EX_CORE_DIR, "*.json")))

    for ip_name in ip_names:
        if ip_name and ip_name != "通用新IP项目":
            ip_path = os.path.join(EX_IP_DIR, ip_name)
            if os.path.exists(ip_path):
                example_files.extend(glob.glob(os.path.join(ip_path, "**", "*.json"), recursive=True))

    if not example_files:
        return "（当前无缓存范例）"

    # 优先匹配 shot_type
    if shot_type:
        matched = [f for f in example_files if shot_type in f]
        if matched:
            example_files = matched

    chosen_file = random.choice(example_files)
    try:
        with open(chosen_file, "r", encoding="utf-8") as f:
            return f.read()
    except:
        return "（范例读取失败）"


def trim_kb_file_if_needed(filepath: str):
    """
    知识库体积守卫：当文件超过 MAX_KB_FILE_BYTES 时，
    自动丢弃前 1/3 的旧内容，只保留后 2/3 的最新法则。
    避免随洗稿次数增多导致 token 爆炸和法则互相干扰。
    """
    try:
        if not os.path.exists(filepath):
            return
        size = os.path.getsize(filepath)
        if size > MAX_KB_FILE_BYTES:
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
            keep_from = len(content) // 3
            trimmed = (
                f"<!-- 旧内容已自动归档，以下为最新法则"
                f"（自动裁剪于 {datetime.now().strftime('%Y-%m-%d %H:%M')}） -->\n\n"
                + content[keep_from:]
            )
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(trimmed)
            print(f"[体积守卫] 已自动裁剪知识库: {os.path.basename(filepath)} "
                  f"({size} → {len(trimmed.encode())} bytes)")
    except Exception as e:
        print(f"[体积守卫] 裁剪失败 {filepath}: {e}")


# ---------- 4. 接口模型与智能并发引擎 ----------
class RouteConfig(BaseModel):
    name: str = ""
    url: str = ""
    key: str = ""
    model: str = ""
    is_thinking: bool = False
    use_proxy: bool = False
    proxy_url: str = ""

class GenerateRequest(BaseModel):
    stage: str
    input: str
    session_id: str = "default_session"
    system_prompt: str
    ip_names: list[str] = []
    run_id: str = ""
    routes: Dict[str, RouteConfig] = {}
    execution_mode: str = "sequential"  # 'sequential' = 逐段推演 / 'batch' = 全量出片
    segments: list[str] = []
    art_director_profile: str = "default"  # 改造：阶段二美术指导审美画像
    cinematographer_profile: str = "default"  # 改造：阶段三摄影指导审美画像

class ClearMemoryRequest(BaseModel):
    session_id: str

class SaveOutputRequest(BaseModel):
    stage: str
    content: str
    run_id: str = ""

class ImageGenerationRequest(BaseModel):
    prompt: str
    frame_id: str = "frame"
    run_id: str = ""
    route: RouteConfig
    size: str = "1536x1024"
    response_format: str = "b64_json"
    n: int = 1
    reference_image_ids: list[int] = []
    bind_to_image_id: Optional[int] = None
    bind_category: str = ""
    bind_description: str = ""

class CodexStoryboardJobRequest(BaseModel):
    run_id: str = ""
    segment_index: int = 0
    segment_title: str = ""
    segment_range: str = ""
    board_prompt: str = ""
    jimeng_prompt: str = ""
    character_refs: str = ""
    character_reference_mode: str = "uploaded"
    style_text: str = ""
    reference_image_ids: list[int] = []
    image_size: str = "1536x1024"
    stage_outputs: Dict[str, str] = {}

class InspirationRequest(BaseModel):
    input: str = ""
    style_hint: str = ""
    style_avoid: str = ""
    ip_names: list[str] = []
    routes: Dict[str, RouteConfig] = {}
    previous_ideas: list[dict] = []


class PackVisualJobRequest(BaseModel):
    """打包阶段二视觉开发任务包：生成一条自包含 prompt，可粘贴到任何高级模型窗口执行。"""
    script: str  # 阶段一剧本全文
    ip_names: list[str] = []
    art_director_profile: str = "default"
    run_id: str = ""


class PackShotJobRequest(BaseModel):
    """打包阶段三分镜提示词任务包：生成一条自包含 prompt，可粘贴到任何高级模型窗口执行。"""
    script: str  # 阶段一剧本全文
    visual: str  # 阶段二固定要素库包全文
    ip_names: list[str] = []
    cinematographer_profile: str = "default"
    run_id: str = ""


class PackArtCutJobRequest(BaseModel):
    """打包阶段二美术二稿任务包：把一稿+知识库+二稿规则打包成可粘贴的 prompt。"""
    visual: str  # 第一稿固定要素库包全文
    script: str = ""  # 阶段一剧本
    ip_names: list[str] = []
    art_director_profile: str = "default"
    revision_focus: str = ""  # 用户修订重点（可选）
    force_scene: str = "auto"  # "auto" / "first" / "last"
    run_id: str = ""


class PackCineCutJobRequest(BaseModel):
    """打包阶段三摄影二稿任务包：把一稿+知识库+二稿规则打包成可粘贴的 prompt。"""
    shot: str  # 第一稿分镜提示词包全文
    visual: str = ""  # 阶段二固定要素库包
    script: str = ""  # 阶段一剧本
    ip_names: list[str] = []
    cinematographer_profile: str = "default"
    revision_focus: str = ""  # 用户修订重点（可选）
    force_unit: str = "auto"  # "auto" / "first" / "last"
    run_id: str = ""


class DirectorCutRequest(BaseModel):
    """Request model for the Stage 1 director's cut (second draft) endpoint."""
    script: str
    original_input: str = ""
    ip_names: list[str] = []
    routes: Dict[str, RouteConfig] = {}
    style_hint: str = ""
    # 用户可填的指令，比如"重写中段两场，让刀盾狗主动一次"。空则由模型自行判断。
    revision_focus: str = ""
    # 改造 4：导演画像（None / "miyazaki" / "pixar" / "wes_anderson" / "a24_indie" / "default"）
    director_profile: str = "default"
    # 改造 6：强制重写场号（"auto" / "first" / "last"）
    force_scene: str = "auto"


class ArtDirectorCutRequest(BaseModel):
    """阶段二美术二稿端点的请求模型。"""
    visual: str  # 第一稿固定要素库包全文
    script: str = ""  # 阶段一剧本（可选，提供后让美术二稿能引用主题命题）
    original_input: str = ""  # 用户原始要求
    ip_names: list[str] = []
    routes: Dict[str, RouteConfig] = {}
    art_director_profile: str = "default"
    revision_focus: str = ""  # 用户可填指令，例如"S2 色彩太顺，重写"
    force_scene: str = "auto"  # "auto" / "first" / "last"


class CinematographerCutRequest(BaseModel):
    """阶段三分镜二稿端点的请求模型。"""
    shot: str  # 第一稿分镜提示词包全文
    visual: str = ""  # 阶段二固定要素库包（可选，用于场景/角色一致性参考）
    script: str = ""  # 阶段一剧本（可选）
    original_input: str = ""
    ip_names: list[str] = []
    routes: Dict[str, RouteConfig] = {}
    cinematographer_profile: str = "default"
    revision_focus: str = ""  # 用户可填指令，例如"S2-U2 节奏太顺，重写"
    force_unit: str = "auto"  # "auto" / "first" / "last" — 强制重写第一/最后一个单元


# 改造 4：5 个真实导演风格画像，作为二稿审美对冲选项。
DIRECTOR_PROFILES: dict[str, dict[str, str]] = {
    "default": {
        "label": "默认（自行判断）",
        "prompt": (
            "由你判断最适合本片气质的审美方向。但请同时考虑：\n"
            "（1）你的第一直觉画像是什么；\n"
            "（2）能否选一个'次优但能逼出新东西'的画像——例如吉卜力气质的项目可以试一次韦斯·安德森的对称克制；皮克斯气质的项目可以试一次 A24 的留白。\n"
            "专业导演的二稿往往不是按第一直觉走，而是有意打破舒适区。\n"
            "请在笔记里明确说明：你的第一直觉是哪个方向、最终选择的是哪个方向、为什么这次选择'打破直觉'或'尊重直觉'。"
        ),
    },
    "miyazaki": {
        "label": "宫崎骏式",
        "prompt": (
            "宫崎骏式审美：环境呼吸感重于情节推进；让一场戏可以只有风、光、声音和角色的微小动作；"
            "高潮往往是安静的，不是激烈的；强调自然万物自有生命；"
            "禁忌：忌讽刺、忌玩梗、忌大反派、忌密集对白填充。"
        ),
    },
    "pixar": {
        "label": "皮克斯式",
        "prompt": (
            "皮克斯式审美：每场戏必须有一个'你以为是这样，其实是那样'的小翻转；"
            "情感必须通过可见物理动作传递，不依赖表情或台词；"
            "中段一定有一次明确的失败/误判，结尾让物件或动作回收前文；"
            "禁忌：忌冗长氛围、忌静止凝视超过一拍、忌情绪靠脸说。"
        ),
    },
    "wes_anderson": {
        "label": "韦斯·安德森式",
        "prompt": (
            "韦斯·安德森式审美：构图意识强（对称、横向、明确取景）；"
            "颜色规则统一；情绪用克制对白与机械式动作表达；"
            "荒诞与温柔并存；让平凡动作显得郑重；"
            "禁忌：忌即兴自由摇晃、忌自然主义、忌'感受一下'式情绪发挥。"
        ),
    },
    "a24_indie": {
        "label": "A24 独立片式",
        "prompt": (
            "A24 独立片式审美：重视沉默与留白；不解释情绪；"
            "场景之间允许跳跃，让观众自己拼凑；"
            "用细节而非剧情推进情绪：一只手停了一拍、一片光斜过桌面；"
            "禁忌：忌按部就班的起承转合、忌把动机写明白、忌完美收束。"
        ),
    },
    "ghibli_yonebayashi": {
        "label": "吉卜力·米林宏昌式（细腻日常）",
        "prompt": (
            "米林宏昌（《借物少女艾莉缇》）式审美：把日常微观放大到值得屏息的程度；"
            "强调质感（叶脉、布纹、水的反光）；角色第一次接触新物时身体会先于情绪反应；"
            "情节缓而满，每场都有一个'值得收藏的小动作'；"
            "禁忌：忌奇观堆积、忌为奇而奇、忌让角色直接说出感受。"
        ),
    },
}


def _resolve_director_profile(key: str) -> dict[str, str]:
    """归一化导演画像 key，返回 {label, prompt}。"""
    profile = DIRECTOR_PROFILES.get((key or "default").strip().lower())
    return profile or DIRECTOR_PROFILES["default"]


def _resolve_force_scene_instruction(force_scene: str) -> str:
    """改造 6：强制重写场号指令。"""
    key = (force_scene or "auto").strip().lower()
    if key == "first":
        return (
            "【强制重写指令】本次二稿必须重写第一场（S1）。"
            "理由：第一场决定钩子，对全片观看动力影响最大。"
            "其它场号原则上保留，除非第一场重写后造成衔接问题再做最小修正。"
        )
    if key == "last":
        return (
            "【强制重写指令】本次二稿必须重写最后一场（全片最末场号）。"
            "理由：最后一场决定余味与主题命题的回收。"
            "其它场号原则上保留，除非最后一场重写后造成衔接问题再做最小修正。"
        )
    return ""

class ScriptAppealReviewRequest(BaseModel):
    script: str
    original_input: str = ""
    ip_names: list[str] = []
    routes: Dict[str, RouteConfig] = {}
    review_routes: Dict[str, RouteConfig] = {}
    review_mode: str = "quick"

class StageReviewRequest(BaseModel):
    stage: str
    content: str
    previous_content: str = ""
    original_input: str = ""
    ip_names: list[str] = []
    routes: Dict[str, RouteConfig] = {}
    review_routes: Dict[str, RouteConfig] = {}
    review_mode: str = "quick"

class ImageReviewRequest(BaseModel):
    image_path: str
    shot_id: str = ""
    scene_id: str = ""
    run_id: str = ""
    review_routes: Dict[str, RouteConfig] = {}

class WashExampleRequest(BaseModel):
    raw_text: str
    ip_name: str = "core"
    routes: Dict[str, RouteConfig] = {}


# 🌟 核心算法升级：节点矩阵自动对齐
def get_api_nodes(
    api_key_str: str,
    base_url_str: str,
    model_str: str,
    use_proxy: bool = False,
    proxy_url_str: str = "",
):
    clean_keys = api_key_str.replace('\n', ',')
    clean_urls = base_url_str.replace('\n', ',')
    clean_models = model_str.replace('\n', ',')
    clean_proxies = (proxy_url_str or "").replace('\n', ',')

    keys = [k.strip() for k in clean_keys.split(",") if k.strip()]
    urls = [u.strip() for u in clean_urls.split(",") if u.strip()]
    models = [m.strip() for m in clean_models.split(",") if m.strip()]
    proxies = [p.strip() for p in clean_proxies.split(",") if p.strip()]

    if not keys:
        return []

    if not urls: urls = [None]
    if not models: models = ["gpt-3.5-turbo"]

    nodes = []
    max_len = max(len(keys), len(urls), len(models))
    for i in range(max_len):
        k = keys[i] if i < len(keys) else keys[-1]
        u = urls[i] if i < len(urls) else urls[-1]
        m = models[i] if i < len(models) else models[-1]
        p = proxies[i] if i < len(proxies) else (proxies[-1] if proxies else "")
        nodes.append({"key": k, "url": u, "model": m, "use_proxy": bool(use_proxy), "proxy_url": p})

    return nodes


def get_api_nodes_for_route(route: RouteConfig | None, default_model: str = ""):
    if not route:
        return []
    return get_api_nodes(
        route.key,
        route.url,
        route.model or default_model,
        getattr(route, "use_proxy", False),
        getattr(route, "proxy_url", ""),
    )


CLAUDE_OPUS_47_MAX_OUTPUT_TOKENS = _int_env("CLAUDE_OPUS_47_MAX_OUTPUT_TOKENS", 128000)
CLAUDE_DEFAULT_4X_MAX_OUTPUT_TOKENS = _int_env("CLAUDE_DEFAULT_4X_MAX_OUTPUT_TOKENS", 64000)
CLAUDE_OPUS_4_LEGACY_MAX_OUTPUT_TOKENS = _int_env("CLAUDE_OPUS_4_LEGACY_MAX_OUTPUT_TOKENS", 32000)
CLAUDE_LEGACY_MAX_OUTPUT_TOKENS = _int_env("CLAUDE_LEGACY_MAX_OUTPUT_TOKENS", 8192)


def _claude_max_output_tokens(model_name: str = "") -> int:
    """Return the sync Messages API max output cap for common Claude models."""
    model = (model_name or "").lower()
    if "opus-4-7" in model or "opus-4.7" in model:
        return CLAUDE_OPUS_47_MAX_OUTPUT_TOKENS
    if "sonnet-4" in model or "haiku-4-5" in model or "haiku-4.5" in model:
        return CLAUDE_DEFAULT_4X_MAX_OUTPUT_TOKENS
    if "opus-4-1" in model or "opus-4.1" in model or "opus-4-2025" in model:
        return CLAUDE_OPUS_4_LEGACY_MAX_OUTPUT_TOKENS
    if "claude-3" in model or "sonnet-3" in model or "opus-3" in model or "haiku-3" in model:
        return CLAUDE_LEGACY_MAX_OUTPUT_TOKENS
    if "claude" in model:
        return CLAUDE_DEFAULT_4X_MAX_OUTPUT_TOKENS
    return CLAUDE_DEFAULT_4X_MAX_OUTPUT_TOKENS


def _thinking_extra_body_for_model(model_name: str = "", base_url: str = "") -> dict | None:
    model = (model_name or "").lower()
    url = (base_url or "").lower()
    if "deepseek" in model:
        return {
            "thinking": {"type": "enabled"},
            "reasoning_effort": "high",
        }
    if any(token in model for token in ("qwen", "qwq")) or any(token in url for token in ("dashscope", "aliyuncs")):
        return {"enable_thinking": True}
    return None


class ApiQuotaError(RuntimeError):
    """Raised when an API node reports that account/key quota is exhausted."""


def _api_error_status_code(exc: Exception) -> int | None:
    for attr in ("status_code", "code"):
        raw = getattr(exc, attr, None)
        try:
            if raw is not None:
                return int(raw)
        except Exception:
            pass

    response = getattr(exc, "response", None)
    raw = getattr(response, "status_code", None)
    try:
        return int(raw) if raw is not None else None
    except Exception:
        return None


def _is_quota_exceeded_error(exc: Exception) -> bool:
    text = str(exc).lower()
    status_code = _api_error_status_code(exc)
    quota_markers = (
        "exceeded your current quota",
        "quota exceeded",
        "insufficient_quota",
        "resource_exhausted",
        "check your plan and billing",
        "billing details",
        "free_tier",
    )
    return any(marker in text for marker in quota_markers) or (
        status_code == 429 and "quota" in text
    )


def _node_public_label(node: dict | None) -> str:
    if not node:
        return "未知节点"
    model = node.get("model") or "未填写模型"
    url = node.get("url") or "默认 OpenAI 兼容地址"
    return f"model={model}, url={url}"


def _format_quota_exceeded_message(
    exc: Exception,
    node: dict | None = None,
    attempted_nodes: list[dict] | None = None,
) -> str:
    tried = []
    for item in attempted_nodes or []:
        label = _node_public_label(item)
        if label not in tried:
            tried.append(label)

    node_text = "；".join(tried) if tried else _node_public_label(node)
    raw_detail = sanitize_error_msg(str(exc)).replace("\n", " ")
    return (
        "Gemini/API 节点返回 429：当前 Key 或账号额度已用完/被限流。"
        f"已尝试节点：{node_text}。"
        "请更换可用 API Key、在同一设置页按行或逗号添加备用 Key/模型，"
        "或等待配额重置/检查 Google AI Studio 计费与用量。"
        f"原始错误：{raw_detail}"
    )


# 🌟 核心算法升级：节点矩阵自动对齐、Token 锁阀与双轨智能路由
async def safe_api_call(
    nodes: list[dict],
    messages: list,
    temperature: float,
    max_tokens: int = 2048,
    max_retries: int = 3,
    *,
    system_blocks: list[dict] | None = None,
) -> str:
    """
    双轨智能 API 调用，支持 Claude 原生 prompt caching。

    Args:
        system_blocks: 仅用于 Claude 模型。当提供时，使用 Anthropic 的 block 格式
                       传递 system prompt，并在知识库部分注入 cache_control。
                       此时 messages 中不应包含 role=system 的消息。
    """
    if not nodes:
        raise ValueError("没有可用的 API 节点，请先在系统设置里填写 API Key。")

    start_index = random.randint(0, len(nodes) - 1)
    attempts = max(max_retries, len(nodes))
    quota_failed_indexes: set[int] = set()
    quota_failed_nodes: list[dict] = []
    last_error: Exception | None = None

    for attempt in range(attempts):
        node_index = (start_index + attempt) % len(nodes)
        if node_index in quota_failed_indexes:
            continue

        node = nodes[node_index]
        model_name_lower = node["model"].lower()
        print(f"[引擎路由] 非流式节点: [{node['model']}] (尝试 {attempt + 1}/{attempts})")

        try:
            if attempt > 0:
                await asyncio.sleep(random.uniform(0.5, 1.5))

            # 🛡️ 双轨识别：Claude 原生 vs OpenAI 兼容
            if "claude" in model_name_lower:
                user_msgs = [m for m in messages if m["role"] != "system"]

                client = AsyncAnthropic(
                    api_key=node["key"],
                    base_url=node["url"] if node.get("url") else None,
                    http_client=get_http_client(node.get("use_proxy"), node.get("proxy_url", "")),
                )

                call_kwargs = {
                    "model": node["model"],
                    "messages": user_msgs,
                    "temperature": temperature,
                    "max_tokens": _claude_max_output_tokens(node["model"]),
                }

                # 🌟 Prompt Caching：使用 block 格式传递 system，知识库部分标记缓存断点
                if system_blocks is not None:
                    call_kwargs["system"] = system_blocks
                else:
                    # 兼容旧调用：从 messages 中提取 system
                    sys_prompt = "\n".join([m["content"] for m in messages if m["role"] == "system"]).strip()
                    call_kwargs["system"] = sys_prompt

                response = await client.messages.create(**call_kwargs)
                content = response.content[0].text if response.content else ""

            else:
                client = AsyncOpenAI(
                    api_key=node["key"],
                    base_url=node["url"] if node.get("url") else None,
                    http_client=get_http_client(node.get("use_proxy"), node.get("proxy_url", "")),
                )
                response = await client.chat.completions.create(
                    model=node["model"],
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens
                )
                # 防御：某些代理网关返回非标准格式
                try:
                    if isinstance(response, str):
                        content = response
                    elif isinstance(response, dict):
                        content = response["choices"][0]["message"]["content"]
                    else:
                        content = response.choices[0].message.content
                except (AttributeError, KeyError, IndexError, TypeError) as parse_err:
                    # 打印完整调试信息帮助定位
                    print(f"[引擎路由] ⚠️ 响应解析失败: {node['model']}")
                    print(f"[引擎路由]   response type = {type(response).__name__}")
                    print(f"[引擎路由]   response repr = {repr(response)[:500]}")
                    raise parse_err

            if not content or not content.strip():
                # 调试：打印完整响应结构，帮助定位空数据问题
                if not isinstance(response, str):
                    print(f"[引擎路由] ⚠️ content 为空: {node['model']}")
                    print(f"[引擎路由]   response type = {type(response).__name__}")
                    print(f"[引擎路由]   response repr = {repr(response)[:800]}")
                raise ValueError("API 返回了空数据")
            return content

        except Exception as e:
            last_error = e
            if _is_quota_exceeded_error(e):
                quota_failed_indexes.add(node_index)
                quota_failed_nodes.append(node)
                print(f"API 节点额度已耗尽，切换备用节点: [{node['model']}], 错误:{sanitize_error_msg(str(e))[:80]}")
                if len(quota_failed_indexes) >= len(nodes):
                    raise ApiQuotaError(_format_quota_exceeded_message(e, node, quota_failed_nodes)) from e
                continue

            if attempt == attempts - 1:
                raise e
            print(f"节点受限，触发异构灾备秒切... 失败节点:[{node['model']}], 错误:{str(e)[:40]}")
            await asyncio.sleep(1)

    if quota_failed_nodes and (last_error is None or _is_quota_exceeded_error(last_error)):
        raise ApiQuotaError(_format_quota_exceeded_message(last_error or Exception("quota exceeded"), None, quota_failed_nodes))
    if last_error:
        raise last_error
    raise ValueError("所有 API 节点均不可用。")


async def stream_api_call(
    nodes: list[dict],
    messages: list,
    temperature: float,
    max_tokens: int = 4096,
    max_retries: int = 3,
    *,
    system_blocks: list[dict] | None = None,
):
    """Stream a single model call and yield text chunks."""
    if not nodes:
        raise ValueError("没有可用的 API 节点")

    start_index = random.randint(0, len(nodes) - 1)
    attempts = max(max_retries, len(nodes))
    last_error = None
    quota_failed_indexes: set[int] = set()
    quota_failed_nodes: list[dict] = []

    for attempt in range(attempts):
        node_index = (start_index + attempt) % len(nodes)
        if node_index in quota_failed_indexes:
            continue

        node = nodes[node_index]
        model_name_lower = node["model"].lower()
        yielded = False
        try:
            if attempt > 0:
                await asyncio.sleep(random.uniform(0.5, 1.5))
            print(f"[引擎路由] 流式节点: [{node['model']}] (尝试 {attempt + 1}/{attempts})")

            if "claude" in model_name_lower:
                user_msgs = [m for m in messages if m["role"] != "system"]
                client = AsyncAnthropic(
                    api_key=node["key"],
                    base_url=node["url"] if node.get("url") else None,
                    http_client=get_http_client(node.get("use_proxy"), node.get("proxy_url", "")),
                )
                call_kwargs = {
                    "model": node["model"],
                    "messages": user_msgs,
                    "temperature": temperature,
                    "max_tokens": _claude_max_output_tokens(node["model"]),
                }
                if system_blocks is not None:
                    call_kwargs["system"] = system_blocks
                else:
                    call_kwargs["system"] = "\n".join(
                        [m["content"] for m in messages if m["role"] == "system"]
                    ).strip()

                async with client.messages.stream(**call_kwargs) as stream:
                    async for text in stream.text_stream:
                        if text:
                            yielded = True
                            yield text
            else:
                client = AsyncOpenAI(
                    api_key=node["key"],
                    base_url=node["url"] if node.get("url") else None,
                    http_client=get_http_client(node.get("use_proxy"), node.get("proxy_url", "")),
                )
                response = await asyncio.wait_for(
                    client.chat.completions.create(
                        model=node["model"],
                        messages=messages,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        stream=True
                    ),
                    timeout=STREAM_START_TIMEOUT_SECONDS,
                )
                # 防御：某些代理返回原始字符串而非流式迭代器
                if isinstance(response, str):
                    print(f"[引擎路由] ⚠️ 流式返回 str: {node['model']}, 长度={len(response)}")
                    if response.strip():
                        yielded = True
                        yield response
                else:
                    chunk_count = 0
                    async for chunk in response:
                        chunk_count += 1
                        if not chunk.choices:
                            continue
                        delta = chunk.choices[0].delta
                        text = getattr(delta, "content", None)
                        if text:
                            yielded = True
                            yield text

                    # 🔄 流式返回 0 chunk 时，自动回退到非流式调用
                    if not yielded and chunk_count == 0:
                        print(f"[引擎路由] 🔄 流式返回 0 chunk，回退非流式: {node['model']}")
                        fallback_resp = await asyncio.wait_for(
                            client.chat.completions.create(
                                model=node["model"],
                                messages=messages,
                                temperature=temperature,
                                max_tokens=max_tokens,
                            ),
                            timeout=STREAM_START_TIMEOUT_SECONDS,
                        )
                        try:
                            if isinstance(fallback_resp, str):
                                fallback_text = fallback_resp
                            elif isinstance(fallback_resp, dict):
                                fallback_text = fallback_resp["choices"][0]["message"]["content"]
                            else:
                                fallback_text = fallback_resp.choices[0].message.content
                        except (AttributeError, KeyError, IndexError, TypeError):
                            print(f"[引擎路由] ⚠️ 非流式回退也失败: {node['model']}, type={type(fallback_resp).__name__}, repr={repr(fallback_resp)[:500]}")
                            fallback_text = None

                        if fallback_text and fallback_text.strip():
                            yielded = True
                            yield fallback_text
                            print(f"[引擎路由] ✅ 非流式回退成功: {node['model']}, 长度={len(fallback_text)}")

            if yielded:
                return
            last_error = ValueError("API 返回了空数据")
        except Exception as e:
            last_error = e
            if yielded:
                raise
            if _is_quota_exceeded_error(e):
                quota_failed_indexes.add(node_index)
                quota_failed_nodes.append(node)
                print(f"API 节点额度已耗尽，切换备用节点: [{node['model']}], 错误: {sanitize_error_msg(str(e))[:80]}")
                if len(quota_failed_indexes) >= len(nodes):
                    raise ApiQuotaError(_format_quota_exceeded_message(e, node, quota_failed_nodes)) from e
                continue
            print(f"流式节点失败，准备切换备用节点: [{node['model']}], 错误: {str(e)[:80]}")

    if quota_failed_nodes and (last_error is None or _is_quota_exceeded_error(last_error)):
        raise ApiQuotaError(_format_quota_exceeded_message(last_error or Exception("quota exceeded"), None, quota_failed_nodes))
    raise last_error or ValueError("所有流式节点均调用失败")


async def check_and_deduplicate_kb(filepath: str, new_content: str, nodes: list[dict]) -> str:
    """
    在写入新法则前，检查是否与现有内容高度重复
    如果重复度过高，返回去重后的内容或跳过写入

    使用字符级 N-gram 比对，对中文/英文混合文本均有效。
    """
    if not os.path.exists(filepath):
        return new_content

    with open(filepath, "r", encoding="utf-8") as f:
        existing = f.read()

    def char_ngrams(s: str, n: int = 2) -> set[str]:
        """提取字符 N-gram，对中文和英文混合文本均适用"""
        cleaned = re.sub(r'\s+', '', s)  # 去掉空白，避免空格 n-gram 噪音
        if len(cleaned) < n:
            return {cleaned}
        return {cleaned[i:i + n] for i in range(len(cleaned) - n + 1)}

    # 新内容取头部采样，现有内容取尾部采样
    new_sample = new_content[:500]
    existing_tail = existing[-5000:]

    if len(new_sample) < 10:
        return new_content  # 太短不检测

    new_ngrams = char_ngrams(new_sample)
    existing_ngrams = char_ngrams(existing_tail)

    if not new_ngrams:
        return new_content

    # Jaccard 相似度
    overlap = len(new_ngrams & existing_ngrams) / len(new_ngrams)

    if overlap > 0.5:  # 50%以上字符 n-gram 重叠，认为是重复内容
        print(f"[去重守卫] 检测到高度重复内容（n-gram重叠率{overlap:.0%}），跳过写入: {os.path.basename(filepath)}")
        return None  # 返回None表示跳过

    return new_content


def sanitize_error_msg(msg: str) -> str:
    """清洗异常消息，防止 API Key 等敏感信息泄露到前端"""
    # 用正则匹配 sk- 开头的 key 并替换
    msg = re.sub(r'sk-[A-Za-z0-9_-]{20,}', '[API_KEY_REDACTED]', msg)
    # Google AI Studio / Gemini API keys often start with AIza.
    msg = re.sub(r'AIza[0-9A-Za-z_-]{20,}', '[GOOGLE_API_KEY_REDACTED]', msg)
    # 匹配可能出现的 Authorization header
    msg = re.sub(r'Bearer\s+[A-Za-z0-9_-]{20,}', 'Bearer [REDACTED]', msg)
    # 截断过长的错误消息（可能是 API 返回的完整 HTML/JSON）
    if len(msg) > 300:
        msg = msg[:300] + "..."
    return msg


def _authorized_scenes_from_chunk_input(text: str) -> set[str]:
    """Extract the scene ids explicitly authorized by the frontend chunk prompt."""
    if "自动化分段" not in (text or ""):
        return set()
    match = re.search(r"场景编号\s*[：:]\s*([^\n\r]+)", text or "")
    if not match:
        return set()
    return set(re.findall(r"S\d+", match.group(1)))


def _sanitize_chunked_shot_response(response: str, request_input: str) -> str:
    """Trim accidental cross-scene content before saving chunked storyboard output."""
    authorized = _authorized_scenes_from_chunk_input(request_input)
    if not authorized or not response:
        return response or ""

    clean = re.sub(r"```(?:markdown)?\n?", "", response or "")

    marker_patterns = [
        re.compile(r"^#{1,4}\s*\|\s*(S\d+)\s*\|[^\n\r]*$", re.MULTILINE),
        re.compile(r"^(?:#{1,4}\s*)?生成单元\s+(S\d+)-U\d+[^\n\r]*$", re.MULTILINE),
        re.compile(r"^\|\s*\d+\s*\|\s*(S\d+)-U\d+\s*\|[^\n\r]*$", re.MULTILINE),
    ]

    first_allowed: int | None = None
    first_bad: int | None = None
    for pattern in marker_patterns:
        for match in pattern.finditer(clean):
            scene_id = match.group(1)
            if scene_id in authorized:
                first_allowed = match.start() if first_allowed is None else min(first_allowed, match.start())
            else:
                first_bad = match.start() if first_bad is None else min(first_bad, match.start())

    if first_allowed and first_allowed > 0:
        prefix = clean[:first_allowed]
        if re.search(r"总体导演策略|目录|总览|场景顺序|提交顺序|全片|参考图使用策略", prefix):
            clean = clean[first_allowed:].lstrip()

    first_bad = None
    for pattern in marker_patterns:
        for match in pattern.finditer(clean):
            scene_id = match.group(1)
            if scene_id not in authorized:
                first_bad = match.start() if first_bad is None else min(first_bad, match.start())

    if first_bad is not None:
        print(f"[场景隔离] 截断未授权场景输出 | authorized={sorted(authorized)}")
        clean = clean[:first_bad].rstrip()

    return clean


def _compact_scene_name(name: str) -> str:
    """Normalize scene names for loose comparison."""
    clean = re.sub(r"[*_`#|：:·\-—（）()\[\]【】\s]", "", name or "")
    clean = re.sub(r"第[一二三四五六七八九十\d]+[集场段]", "", clean)
    return clean.strip()


def _extract_script_scene_map(text: str) -> dict[str, str]:
    """Extract scene ids and best available scene names from a Stage 1 script."""
    aliases = _extract_script_scene_aliases(text)
    return {
        scene_id: next(iter(names)) if names else scene_id
        for scene_id, names in aliases.items()
    }


def _extract_script_scene_aliases(text: str) -> dict[str, list[str]]:
    """Extract acceptable script-side names for each scene: title and location."""
    scene_map: dict[str, list[str]] = {}
    matches = list(re.finditer(r"①\s*场号[^\n\r|]*\|\s*(S\d+)\s*\|[^\n\r]*", text or ""))
    for idx, match in enumerate(matches):
        scene_id = match.group(1)
        block_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text or "")
        block = (text or "")[match.start():block_end]
        prefix = (text or "")[max(0, match.start() - 260):match.start()]

        location = _extract_match(r"④\s*地点\s*([^\n\r]+)", block)
        title = ""
        title_matches = list(re.finditer(r"(?:第\d+集|场景[一二三四五六七八九十\d]+)[：:]\s*([^\n\r（(]+)", prefix))
        if title_matches:
            title = title_matches[-1].group(1).strip()

        names: list[str] = []
        for name in [title, location]:
            if name and name not in names:
                names.append(name)
        scene_map[scene_id] = names or [scene_id]
    return scene_map


def _extract_visual_scene_map(text: str) -> dict[str, dict[str, str]]:
    """Extract scene ids, names and scene refs from a Stage 2 visual bible."""
    result: dict[str, dict[str, str]] = {}
    matches = list(re.finditer(r"^###\s+场景卡\s+·\s*\|\s*(S\d+)\s*\|\s*([^\n\r]+)", text or "", re.MULTILINE))
    for idx, match in enumerate(matches):
        scene_id = match.group(1)
        name = (match.group(2) or "").strip()
        block_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text or "")
        block = (text or "")[match.start():block_end]
        # 取场景参考图字段中"第一个"出现的 @图片（即主图，而非备选图）
        # 注意：正则 [^\n\r]* 是贪婪的，会回溯到行尾的最后一个 @图片，所以必须用 [^\n\r]*?
        ref_match = re.search(r"场景参考图[^\n\r]*?@图片([1-4]\d)", block)
        if not ref_match:
            table_match = re.search(rf"\|\s*@图片([1-4]\d)\s*\|[^\n\r]*\|\s*{scene_id}\s*\|", text or "")
            ref_match = table_match
        if not ref_match:
            ref_match = re.search(r"@图片([1-4]\d)", block)
        # 抽取该场景登记的"全部"合法 @图片（主图 + 备选图）
        all_scene_refs = sorted({
            f"@图片{m}" for m in re.findall(r"@图片([1-4]\d)", block)
        })
        result[scene_id] = {
            "name": name,
            "ref": f"@图片{ref_match.group(1)}" if ref_match else "",
            "all_refs": all_scene_refs,
        }
    return result


def _extract_shot_scene_headers(text: str) -> dict[str, str]:
    return {
        match.group(1): (match.group(2) or "").strip()
        for match in re.finditer(r"^##\s*\|\s*(S\d+)\s*\|\s*([^\n\r]*)", text or "", re.MULTILINE)
    }


def _extract_shot_unit_stats(text: str) -> dict:
    source = text or ""
    matches = list(re.finditer(r"^###\s+生成单元\s+(S\d+-U\d+)[^\n\r]*", source, re.MULTILINE))
    durations_by_unit: dict[str, float] = {}
    duplicate_units: list[str] = []
    scenes_from_units: set[str] = set()
    units: list[dict] = []

    for idx, match in enumerate(matches):
        unit_id = match.group(1)
        scene_id = unit_id.split("-U", 1)[0]
        scenes_from_units.add(scene_id)
        if unit_id in durations_by_unit:
            duplicate_units.append(unit_id)
            continue

        block_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(source)
        block = source[match.start():block_end]
        # 兼容 markdown 加粗格式：- 成片时长：/ **成片时长**：/ - **成片时长**：
        dur_match = re.search(r"(?:^|[\s-])(?:\*\*)?(?:成片时长|动作有效时长|视频提交时长)(?:\*\*)?\s*[：:]\s*([0-9.]+)\s*秒", block, re.MULTILINE)
        if not dur_match:
            dur_match = re.search(r"(?:^|[\s-])(?:\*\*)?生成时长(?:\*\*)?\s*[：:]\s*([0-9.]+)\s*秒", block, re.MULTILINE)
        duration = float(dur_match.group(1)) if dur_match else 0.0
        durations_by_unit[unit_id] = duration
        # 双时钟分别抽取（改造 8）
        action_dur_match = re.search(r"(?:^|[\s-])(?:\*\*)?动作有效时长(?:\*\*)?\s*[：:]\s*([0-9.]+)\s*秒", block, re.MULTILINE)
        submit_dur_match = re.search(r"(?:^|[\s-])(?:\*\*)?视频提交时长(?:\*\*)?\s*[：:]\s*([0-9.]+)\s*秒", block, re.MULTILINE)
        action_duration = float(action_dur_match.group(1)) if action_dur_match else 0.0
        submit_duration = float(submit_dur_match.group(1)) if submit_dur_match else 0.0
        # 镜头类型/运镜抽取（改造 7）
        shot_type_match = re.search(r"(?:^|[\s-])(?:\*\*)?镜头类型/运镜(?:\*\*)?\s*[：:]\s*([^\n\r]+)", block, re.MULTILINE)
        shot_type = shot_type_match.group(1).strip() if shot_type_match else ""
        refs_match = re.search(r"(?:^|[\s-])(?:\*\*)?使用参考图(?:\*\*)?\s*[：:]\s*([^\n\r]+)", block, re.MULTILINE)
        action_match = re.search(
            r"(?:^|[\s-])(?:\*\*)?(?:主动作与表演层|动作&情绪|动作与情绪|主动作推进)(?:\*\*)?\s*[：:]\s*([^\n\r]+)",
            block,
            re.MULTILINE,
        )
        attention_match = re.search(r"(?:^|[\s-])(?:\*\*)?注意力调度(?:\*\*)?\s*[：:]\s*([^\n\r]+)", block, re.MULTILINE)
        timeline_match = re.search(
            r"(?:^|[\s-])(?:\*\*)?(?:动作时间轴|核心动作节拍表)(?:\*\*)?[^：:\n\r]*[：:]\s*([\s\S]*?)(?=\n-\s*(?:\*\*)?(?:提交策略|使用参考图|分镜执行字段|完整提示词|给下一个生成单元)|\n###|\n##|\Z)",
            block,
            re.MULTILINE,
        )
        units.append({
            "unit_id": unit_id,
            "scene_id": scene_id,
            "duration": duration,
            "action_duration": action_duration,
            "submit_duration": submit_duration,
            "shot_type": shot_type,
            # 兼容三种 markdown 写法：- 动作有效时长：/ **动作有效时长**：/ ## 动作有效时长：
            "has_action_duration": bool(re.search(r"(?:^|[\s-])(?:\*\*)?动作有效时长(?:\*\*)?\s*[：:]", block)),
            "has_attention": bool(attention_match),
            "has_action_timeline": bool(re.search(r"(?:^|[\s-])(?:\*\*)?(?:动作时间轴|核心动作节拍表)(?:\*\*)?[^：:\n\r]*[：:]", block)),
            "refs": refs_match.group(1).strip() if refs_match else "",
            "scene_refs": sorted(set(re.findall(r"@图片(?:1[0-9]|2[0-9]|3[0-9]|4[0-9])", block))),
            "has_scene_placeholder": "@场景生图提示词" in block or "场景图参考场景卡描述" in block,
            "action": action_match.group(1).strip() if action_match else "",
            "attention": attention_match.group(1).strip() if attention_match else "",
            "timeline": timeline_match.group(1).strip() if timeline_match else "",
            "block": block,
        })

    declared_total_match = re.search(r"总成片时长\s*[：:]\s*约?\s*([0-9.]+)\s*秒", source)
    declared_count_match = re.search(r"生成单元数量\s*[：:]\s*约?\s*([0-9]+)\s*个", source)

    return {
        "unit_count": len(durations_by_unit),
        "unit_sum": round(sum(durations_by_unit.values()), 2),
        "declared_total": float(declared_total_match.group(1)) if declared_total_match else None,
        "declared_count": int(declared_count_match.group(1)) if declared_count_match else None,
        "duplicate_units": sorted(set(duplicate_units)),
        "scenes_from_units": scenes_from_units,
        "units": units,
    }


def _dedupe_shot_units(text: str) -> str:
    """阶段三接续生成残留去重：同一 Sx-Uy 编号若出现两次，保留更完整的那份。

    判断依据：每份单元从 `### 生成单元 Sx-Uy` 起到下一个 `###` 或 `## ` 标题为止；
    "更完整"= 字数更长（通常完整版有"完整提示词""动作时间轴（核心动作 beat）"/"主动作与表演层"等字段，简版只有概要）。
    """
    if not text:
        return text
    pattern = re.compile(r"(###\s+生成单元\s+(S\d+-U\d+)[^\n\r]*\n[\s\S]*?)(?=\n###\s|\n##\s|\Z)", re.MULTILINE)
    matches = list(pattern.finditer(text))
    if not matches:
        return text

    # 收集每个 unit_id 的所有出现位置和块内容
    unit_blocks: dict[str, list[tuple[int, int, str]]] = {}
    for m in matches:
        unit_id = m.group(2)
        unit_blocks.setdefault(unit_id, []).append((m.start(), m.end(), m.group(1)))

    # 找出有重复的 unit_id；对每组重复，保留字数最多的那份
    spans_to_remove: list[tuple[int, int]] = []
    for unit_id, occurrences in unit_blocks.items():
        if len(occurrences) <= 1:
            continue
        # 按块字数从大到小排，保留第一个，删掉其余
        occurrences_sorted = sorted(occurrences, key=lambda x: -len(x[2]))
        for start, end, _ in occurrences_sorted[1:]:
            spans_to_remove.append((start, end))

    if not spans_to_remove:
        return text

    # 倒序删除避免位置偏移
    spans_to_remove.sort(key=lambda x: -x[0])
    out = text
    for start, end in spans_to_remove:
        # 拼接时保留前后空白结构
        prefix = out[:start].rstrip("\n") + "\n\n"
        suffix = out[end:].lstrip("\n")
        out = prefix + suffix

    print(f"[接续去重] 阶段三移除了 {len(spans_to_remove)} 个重复生成单元")
    return out


def _scene_title_matches(expected: str, actual: str) -> bool:
    exp = _compact_scene_name(expected)
    act = _compact_scene_name(actual)
    if not exp or not act:
        return True
    if exp in act or act in exp:
        return True
    return SequenceMatcher(None, exp, act).ratio() >= 0.72


def _build_script_quality_gate_report(
    script_text: str,
    request_input: str,
    ip_names: list[str] | None = None,
) -> str:
    """剧本阶段建议级质量闸门。

    扫描三类硬伤，命中则返回追加报告字符串；空字符串表示通过：
    1. 禁用奇观词（浓雾/断崖/深水/漆黑/惊悚/悬疑），但排除用户输入里已经主动给出的词
    2. 未设定身体部位（按挂载 IP 决定哪些词违规，例如香蕉猫/刀盾狗 → 尾巴/翅膀/长手指）
    3. 剧本里混入的镜头术语（俯视镜头/拉远/广角/平移/横移/景别等）

    报告语气是"建议级"而非"阻断级"——剧本阶段允许人工放行。
    """
    text = (script_text or "").strip()
    if not text:
        return ""

    user_lower = (request_input or "").lower()

    # —— 1. 禁用奇观词 —— 用户主动给的词不算违规
    forbidden_atmos = [
        "浓雾", "厚雾", "断崖", "深水", "漆黑", "暗水", "惊悚",
        "悬疑", "尸", "血腥", "黑暗峡谷", "昏暗", "恐怖",
    ]
    atmos_hits: dict[str, list[str]] = {}
    for word in forbidden_atmos:
        if word in user_lower:
            continue
        for line in text.splitlines():
            if word in line:
                atmos_hits.setdefault(word, []).append(line.strip())

    # —— 2. 未设定身体部位 —— 仅在挂载了已知 IP 时触发，避免误伤通用项目
    body_part_pool: list[str] = []
    haystack = " ".join(ip_names or [])
    if any(k in haystack for k in ("香蕉猫", "刀盾狗")):
        body_part_pool = ["尾巴", "翅膀", "长手指", "舌头哈气", "吐舌"]
    body_hits: dict[str, list[str]] = {}
    for word in body_part_pool:
        for line in text.splitlines():
            if word in line:
                body_hits.setdefault(word, []).append(line.strip())

    # —— 3. 剧本里混入的镜头术语 —— 注意需排除"故事背景/故事设定"段里的合法描述
    #     （那里允许出现"广角""俯视"作为环境描写）。这里按行检测，但把"剧本摘要"段去掉。
    script_body = text
    body_match = re.search(r"剧本内容\s*[:：]?", script_body)
    if body_match:
        script_body = script_body[body_match.end():]

    camera_terms = [
        "俯视镜头", "镜头拉远", "镜头推近", "推镜头", "拉镜头",
        "广角镜头", "长焦镜头", "平移镜头", "横移镜头", "升格镜头",
        "焦点", "景别", "运镜", "机位",
    ]
    camera_hits: dict[str, list[str]] = {}
    for word in camera_terms:
        for line in script_body.splitlines():
            if word in line:
                camera_hits.setdefault(word, []).append(line.strip())

    if not (atmos_hits or body_hits or camera_hits):
        # 没有硬伤时，仍需要跑节奏/卡点审计；下面统一收尾
        pass

    # —— 4. 动作行节奏审计（改造 5）——
    rhythm_hits: list[str] = []
    # 拆出每一场，按 △ 行扫
    scene_blocks = re.split(r"\n(?=①\s*场号\s*\|\s*S\d+\s*\|)", script_body)
    for block in scene_blocks:
        scene_match = re.search(r"\|\s*(S\d+)\s*\|", block)
        if not scene_match:
            continue
        scene_id = scene_match.group(1)
        action_lines = [
            line.strip() for line in block.splitlines()
            if line.strip().startswith("△")
        ]
        if not action_lines:
            continue

        # 节奏过满：连续 4 行字数都 > 60（中文动作行 25-60 字算自然，> 60 偏长）
        long_streak = 0
        long_max_streak = 0
        # 节奏太碎：连续 3 行字数都 < 8（"看见/停下/凝视"这种纯动词行）
        short_streak = 0
        short_max_streak = 0
        for line in action_lines:
            text_len = len(re.sub(r"^△\s*", "", line).strip())
            if text_len > 60:
                long_streak += 1
                long_max_streak = max(long_max_streak, long_streak)
                short_streak = 0
            elif text_len < 8:
                short_streak += 1
                short_max_streak = max(short_max_streak, short_streak)
                long_streak = 0
            else:
                long_streak = 0
                short_streak = 0

        if long_max_streak >= 4:
            rhythm_hits.append(f"{scene_id} 连续 {long_max_streak} 行 △ 行字数都超过 60 字（节奏过满，建议拆分长动作行或加入短停顿）")
        if short_max_streak >= 3:
            rhythm_hits.append(f"{scene_id} 连续 {short_max_streak} 行 △ 行字数都低于 8 字（节奏过碎，建议合并短动作或加入实质内容）")

    # —— 5. 定格卡点画面密度审计（改造 5）——
    cards_hits: list[str] = []
    card_pattern = re.compile(r"【定格卡点[：:]\s*([^】]+)】")
    for block in scene_blocks:
        scene_match = re.search(r"\|\s*(S\d+)\s*\|", block)
        if not scene_match:
            continue
        scene_id = scene_match.group(1)
        card = card_pattern.search(block)
        if not card:
            cards_hits.append(f"{scene_id} 缺少【定格卡点】")
            continue

        card_text = card.group(1).strip()
        # 三要素：角色位置（动作动词）、道具状态（具名物件）、环境变化（光/雾/水/色）
        has_character = bool(re.search(r"(站|坐|走|停|靠|凑|举|握|抱|挡|跳|摔|蹭|碰|歪|睁|闭|靠拢|并肩)", card_text))
        has_props = bool(re.search(r"(盾|剑|花|叶|蘑菇|水晶|藤|苔藓|石|果|花瓣|藤蔓|绳|碗|篮|铃|钟|羽毛|羽|球|杖|枝)", card_text))
        has_environment = bool(re.search(r"(光|影|雾|水|风|阳|月|霞|波|纹|涟漪|尘|落|雨|雪|烟|尘埃|微光|暖色|冷色|金|银|蓝|粉|紫|绿|橙)", card_text))

        missing = []
        if not has_character:
            missing.append("角色位置/动作")
        if not has_props:
            missing.append("具名道具状态")
        if not has_environment:
            missing.append("环境/光线变化")

        if len(missing) >= 2 and len(card_text) < 60:
            cards_hits.append(f"{scene_id} 卡点画面要素不足，缺少：{'、'.join(missing)}（卡点描述应含角色+道具+环境三要素，现仅 {len(card_text)} 字）")

    if not (atmos_hits or body_hits or camera_hits or rhythm_hits or cards_hits):
        return ""

    def _format_section(title: str, hits: dict[str, list[str]], remedy: str) -> str:
        if not hits:
            return ""
        lines = [f"### {title}"]
        for word, samples in hits.items():
            preview = samples[0][:80] + ("..." if len(samples[0]) > 80 else "")
            count = len(samples)
            extra = f"（共 {count} 处，首次出现：）" if count > 1 else ""
            lines.append(f"- 命中“{word}”{extra}：{preview}")
        lines.append(f"  修正方向：{remedy}")
        return "\n".join(lines)

    sections = []
    s = _format_section(
        "禁用奇观词（治愈/童话项目）",
        atmos_hits,
        "把浓雾/断崖/深水/漆黑等改写成可触摸、可玩耍的低危险阻力，例如花丛遮挡、树根小坡、浅溪石头、蘑菇弹性、叶片桥、阳光/水纹方向错误。"
    )
    if s:
        sections.append(s)
    s = _format_section(
        "未设定身体部位",
        body_hits,
        "改用角色已知部位或道具完成动作。注意：这条规则同时适用于故事梗概/故事背景/故事设定段，不只是动作行。"
    )
    if s:
        sections.append(s)
    s = _format_section(
        "剧本中混入的镜头术语",
        camera_hits,
        "改成画面可见的自然描述，例如“从高处望去”“视野逐渐展开”“远处整片森林被阳光照亮”。镜头术语在阶段三再处理。"
    )
    if s:
        sections.append(s)

    if rhythm_hits:
        rhythm_lines = ["### 动作行节奏（改造 5）"]
        for hit in rhythm_hits:
            rhythm_lines.append(f"- {hit}")
        rhythm_lines.append("  修正方向：好剧本要像念出来一样有节奏。中文动作行 25-60 字属于自然区间，避免连续 4 行都超过 60 字（说明叙事密度过高），也避免连续 3 行都低于 8 字（说明全是纯动词排比）。")
        sections.append("\n".join(rhythm_lines))

    if cards_hits:
        cards_lines = ["### 定格卡点画面密度（改造 5）"]
        for hit in cards_hits:
            cards_lines.append(f"- {hit}")
        cards_lines.append("  修正方向：每个定格卡点应同时包含角色位置/动作 + 具名道具状态 + 环境/光线变化三要素，方便后续视觉开发和分镜阶段直接拆解。")
        sections.append("\n".join(cards_lines))

    return (
        "## 自动质量闸门（建议级）\n"
        "下面是剧本阶段自动扫描出的疑似硬伤；如果与用户原始要求一致，可以人工放行。\n\n"
        + "\n\n".join(sections)
    )


def _build_visual_quality_gate_report(
    visual_text: str,
    request_input: str,
    ip_names: list[str] | None = None,
) -> str:
    """阶段二（视觉开发）建议级质量闸门。

    扫描的硬伤类别：
    1. 场景卡数量与剧本场号不一致（漏场或合并）
    2. @图片编号分段错误（角色应在 1-9，场景应在 10-49，禁止 50+）
    3. 场景生图提示词命中禁用奇观词
    4. 场景生图提示词混入运镜/时长/首尾帧/@图片（属于阶段三/四的字段）
    5. 角色卡仍在重写完整外貌（VISUAL_COMPACT_CHARACTER_GUARD 失效）
    6. 同空间复用却没标差异锚点（场景图易同质化）
    7. 所有场景图 prompt 共用相同"风格头"（反同质化要求）
    """
    text = (visual_text or "").strip()
    if not text:
        return ""

    issues: list[tuple[str, list[str], str]] = []  # (title, hits, remedy)

    # —— 1. 场景卡数量校验 ——
    # 从剧本输入里提取场号
    script_scenes = sorted(set(re.findall(r"\|\s*(S\d+)\s*\|", request_input or "")), key=lambda s: int(s[1:]))
    # 阶段二输出里提取场景卡标题
    visual_scene_pattern = re.compile(r"^###\s+场景卡\s*·\s*\|\s*(S\d+)\s*\|", re.MULTILINE)
    visual_scenes = sorted(set(m.group(1) for m in visual_scene_pattern.finditer(text)), key=lambda s: int(s[1:]))

    if script_scenes and visual_scenes:
        missing = [s for s in script_scenes if s not in visual_scenes]
        extra = [s for s in visual_scenes if s not in script_scenes]
        miss_extra: list[str] = []
        if missing:
            miss_extra.append(f"剧本里有但场景卡里没有：{', '.join(missing)}")
        if extra:
            miss_extra.append(f"场景卡里多出剧本里没有的场号：{', '.join(extra)}")
        if miss_extra:
            issues.append((
                "场景卡数量与剧本场号不一致",
                miss_extra,
                "每个剧本场号都应该有对应的场景卡。如果合并空间（例如 S3/S4 共用一个空间），仍要分别给出场景卡；不要把两场塞进一张场景卡里。",
            ))

    # —— 2. @图片编号分段校验 ——
    img_id_pattern = re.compile(r"@图片\s*(\d+)")
    all_ids = sorted({int(m.group(1)) for m in img_id_pattern.finditer(text)})
    illegal_ids = [i for i in all_ids if i >= 50]
    if illegal_ids:
        issues.append((
            "@图片编号超出阶段二允许段",
            [f"出现 @图片{i}（≥50 段是阶段三的姿势/首尾帧图，阶段二不应规划）" for i in illegal_ids],
            "@图片1-9 = 角色，@图片10-49 = 场景。阶段二不要主动规划姿势图、首尾帧图或 @图片50+。",
        ))

    # —— 3. 场景生图提示词命中禁用奇观词 ——
    user_lower = (request_input or "").lower()
    forbidden = ["浓雾", "厚雾", "断崖", "深水", "漆黑", "暗水", "惊悚", "悬疑", "黑暗峡谷", "昏暗", "神秘恐怖"]
    # 只扫场景生图提示词字段（即梦中文 / MJ英文）。允许字段名前后包裹 ** 加粗。
    prompt_field_pattern = re.compile(
        r"(?:\*\*)?(?:即梦中文场景生图提示词|MJ英文场景生图提示词|场景生图提示词)(?:\*\*)?\s*[:：]\s*"
        r"([\s\S]+?)(?=\n\*\*|\n###|\n##|\n---|\Z)"
    )
    prompt_fields = prompt_field_pattern.findall(text)
    bad_atmos: list[str] = []
    for field in prompt_fields:
        for word in forbidden:
            if word in user_lower:
                continue
            if word in field:
                snippet = field.strip().splitlines()[0][:80]
                bad_atmos.append(f"出现“{word}”：{snippet}...")
                break
    if bad_atmos:
        issues.append((
            "场景生图提示词命中禁用奇观词",
            bad_atmos,
            "把浓雾/断崖/深水/漆黑等改成可读温暖的童话元素，例如花丛遮挡、浅溪石头、藤蔓秋千、苔藓木桥。",
        ))

    # —— 4. 场景生图提示词混入阶段三/四字段 ——
    forbidden_in_prompt = [
        ("运镜", "运镜词"), ("镜头运动", "镜头运动词"), ("推镜", "推镜词"), ("拉镜", "拉镜词"),
        ("生成时长", "生成时长字段"), ("成片时长", "成片时长字段"),
        ("首帧", "首尾帧字段"), ("尾帧", "首尾帧字段"),
    ]
    field_pollution: list[str] = []
    for field in prompt_fields:
        for word, label in forbidden_in_prompt:
            if word in field:
                snippet = field.strip().splitlines()[0][:80]
                field_pollution.append(f"出现「{word}」（{label}）：{snippet}...")
                break  # 一个字段只报一次
    if field_pollution:
        issues.append((
            "场景生图提示词混入阶段三/四字段",
            field_pollution,
            "场景生图提示词只描述静态空场景资产：空间、光线、材质、构图。不要写运镜、生成时长、首尾帧、@图片——这些是分镜阶段的事。",
        ))

    # —— 5. 角色卡极简校验 ——
    # 角色卡如果在"完整锁定描述"段写超过 100 字 → 视为重写外貌
    char_section_pattern = re.compile(
        r"###\s+角色卡\s*·\s*([^\n\r]+)([\s\S]*?)(?=\n###\s+角色卡|\n###\s+场景卡|\n##\s+|\Z)"
    )
    overwrite_chars: list[str] = []
    for m in char_section_pattern.finditer(text):
        char_name = m.group(1).strip()
        section = m.group(2)
        full_lock = re.search(
            r"完整锁定描述[^：:]*[：:]\s*([\s\S]+?)(?=\n\*\*|\n###|\n---|\Z)", section
        )
        if full_lock and len(full_lock.group(1).strip()) > 100:
            overwrite_chars.append(f"{char_name}（完整锁定描述 {len(full_lock.group(1).strip())} 字，超过 100 字阈值）")
    if overwrite_chars:
        issues.append((
            "角色卡仍在重写外貌（违反极简规则）",
            overwrite_chars,
            "已有角色原图时，角色卡应只写：原图引用 + 20-40字短识别 + 永久附属物 + 允许变化状态 + 3-6条禁止跑偏。完整锁定描述只在无原图、首次建模或跑偏修正时使用。",
        ))

    # —— 6. 同空间复用差异锚点校验 ——
    # 找出多次使用同一 @图片 编号的场景卡
    scene_card_pattern = re.compile(
        r"###\s+场景卡\s*·\s*\|\s*(S\d+)\s*\|[^\n\r]*([\s\S]*?)(?=\n###\s+场景卡|\n##\s+|\Z)"
    )
    scene_to_imgs: dict[str, list[int]] = {}
    img_to_scenes: dict[int, list[str]] = {}
    for m in scene_card_pattern.finditer(text):
        scene_id = m.group(1)
        body = m.group(2)
        # 只看场景参考图字段，不扫整段（防止把光线/动作里的 @图片 误算）
        ref_field = re.search(r"场景参考图[^：:]*[：:]\s*([^\n\r]+)", body)
        if not ref_field:
            continue
        ids = [int(x) for x in re.findall(r"@图片\s*(\d+)", ref_field.group(1)) if 10 <= int(x) <= 49]
        scene_to_imgs[scene_id] = ids
        for i in ids:
            img_to_scenes.setdefault(i, []).append(scene_id)
    shared_imgs = {i: scenes for i, scenes in img_to_scenes.items() if len(scenes) >= 2}
    missing_anchor: list[str] = []
    diff_keywords = ["光线", "光源", "差异", "不同", "新增", "改变", "转为", "变化"]
    for img_id, scenes in shared_imgs.items():
        # 第二个及以后的场景卡是否有差异锚点关键词
        for sid in scenes[1:]:
            sec_match = re.search(
                rf"###\s+场景卡\s*·\s*\|\s*{sid}\s*\|[^\n\r]*([\s\S]*?)(?=\n###\s+场景卡|\n##\s+|\Z)",
                text,
            )
            if not sec_match:
                continue
            section = sec_match.group(1)
            if not any(k in section for k in diff_keywords):
                missing_anchor.append(f"{sid} 复用 @图片{img_id} 但未给出与上一场的可见差异锚点")
    if missing_anchor:
        issues.append((
            "同空间复用没有差异锚点",
            missing_anchor,
            "如果两场共用同一 @图片，第二场必须明确写出图像层面的可见差异：光源方向、新增前景元素、远景透出新景深、地面状态改变之一。",
        ))

    # —— 7. 反同质化：场景图 prompt 风格头雷同 ——
    if len(prompt_fields) >= 3:
        heads = []
        for field in prompt_fields:
            head = re.sub(r"\s+", "", field.strip())[:24]  # 取归一化后前 24 字
            if head:
                heads.append(head)
        # 如果至少 3 个 head 完全相同 → 报雷同
        from collections import Counter
        head_counts = Counter(heads)
        most_common_head, count = head_counts.most_common(1)[0] if heads else ("", 0)
        if count >= 3:
            issues.append((
                "场景图 prompt 风格头雷同",
                [f"{count} 张场景图都以相同的开头开始（前24字归一化后相同）"],
                "每场必须用本场最强视觉特征做开篇关键词（例如 S1 用'阳光斑驳穿草冠'、S2 用'水膜反光跳跃光斑'、S3 用'明暗交界线分割画面'），不要让 4 张图共用同一个 30 字风格头。",
            ))

    if not issues:
        return ""

    sections_md = []
    for title, hits, remedy in issues:
        lines = [f"### {title}"]
        for h in hits:
            lines.append(f"- {h}")
        lines.append(f"  修正方向：{remedy}")
        sections_md.append("\n".join(lines))

    return (
        "## 自动质量闸门（建议级）\n"
        "下面是视觉开发阶段自动扫描出的疑似硬伤；如果与用户原始要求一致，可以人工放行。\n\n"
        + "\n\n".join(sections_md)
    )


def _build_shot_quality_gate_report(shot_text: str, request_input: str) -> str:
    """Build a blocking-quality report for Stage 3 outputs. Empty string means pass."""
    visual_map = _extract_visual_scene_map(request_input or "")
    script_map = _extract_script_scene_map(request_input or "")
    script_aliases = _extract_script_scene_aliases(request_input or "")
    expected_map: dict[str, str] = {
        scene_id: info.get("name") or script_map.get(scene_id, scene_id)
        for scene_id, info in visual_map.items()
    } or script_map

    if not expected_map:
        return ""

    headers = _extract_shot_scene_headers(shot_text or "")
    stats = _extract_shot_unit_stats(shot_text or "")
    actual_scenes = set(headers) | stats["scenes_from_units"]
    expected_scenes = set(expected_map)

    issues: list[str] = []
    missing = sorted(expected_scenes - actual_scenes)
    extra = sorted(actual_scenes - expected_scenes)
    if missing:
        issues.append(f"缺少阶段一/二已有场景：{', '.join(missing)}。")
    if extra:
        issues.append(f"新增了未授权场景：{', '.join(extra)}。分镜阶段不得新增 S 编号。")

    for scene_id in sorted(expected_scenes & set(headers)):
        expected_name = expected_map.get(scene_id, "")
        actual_name = headers.get(scene_id, "")
        aliases = [expected_name] + script_aliases.get(scene_id, [])
        aliases = [alias for idx, alias in enumerate(aliases) if alias and alias not in aliases[:idx]]
        if actual_name and aliases and not any(_scene_title_matches(alias, actual_name) for alias in aliases):
            expected_label = " / ".join(aliases)
            issues.append(f"{scene_id} 场景名不一致：阶段一/二允许“{expected_label}”，分镜输出为“{actual_name}”。")

    declared_count = stats["declared_count"]
    if declared_count is not None and declared_count != stats["unit_count"]:
        issues.append(f"生成单元数量不一致：总览写 {declared_count} 个，实际解析到 {stats['unit_count']} 个。")

    declared_total = stats["declared_total"]
    if declared_total is not None:
        delta = abs(declared_total - stats["unit_sum"])
        tolerance = max(3.0, declared_total * 0.05)
        if delta > tolerance:
            issues.append(f"总时长不一致：总览写 {declared_total:g} 秒，实际生成单元合计 {stats['unit_sum']:g} 秒。")

    if stats["duplicate_units"]:
        issues.append(f"存在重复生成单元编号：{', '.join(stats['duplicate_units'])}。")

    units = stats.get("units") or []
    missing_action_duration = [unit["unit_id"] for unit in units if not unit.get("has_action_duration")]
    if missing_action_duration:
        preview = ", ".join(missing_action_duration[:8])
        suffix = "..." if len(missing_action_duration) > 8 else ""
        issues.append(f"缺少“动作有效时长”字段：{preview}{suffix}。阶段三必须先按真实动作节拍设计，再写视频提交时长。")

    missing_action_timeline = [unit["unit_id"] for unit in units if not unit.get("has_action_timeline")]
    if missing_action_timeline:
        preview = ", ".join(missing_action_timeline[:8])
        suffix = "..." if len(missing_action_timeline) > 8 else ""
        issues.append(f"缺少“动作时间轴（核心动作 beat）”字段：{preview}{suffix}。时间轴必须只列核心动作和状态变化。")

    placeholder_units = [unit["unit_id"] for unit in units if unit.get("has_scene_placeholder")]
    if placeholder_units:
        preview = ", ".join(placeholder_units[:8])
        suffix = "..." if len(placeholder_units) > 8 else ""
        issues.append(f"仍在使用场景图占位写法而非真实编号：{preview}{suffix}。必须继承阶段二场景卡里的 @图片10-49。")

    ref_mismatch: list[str] = []
    for unit in units:
        scene_info = visual_map.get(unit["scene_id"]) or {}
        # 合法 @图片集合 = 该场景登记的所有 @图片（主图 + 备选）
        legal_refs = set(scene_info.get("all_refs") or [])
        expected_ref = scene_info.get("ref", "")
        if expected_ref:
            legal_refs.add(expected_ref)
        actual_refs = set(unit.get("scene_refs") or [])
        if legal_refs and actual_refs:
            illegal = actual_refs - legal_refs
            if illegal:
                ref_mismatch.append(
                    f"{unit['unit_id']} 出现了未登记的 @图片：{', '.join(sorted(illegal))}（"
                    f"该场合法集合：{', '.join(sorted(legal_refs))}）"
                )
    if ref_mismatch:
        issues.append("场景参考图编号错位：" + "；".join(ref_mismatch[:6]) + ("..." if len(ref_mismatch) > 6 else "。"))

    missing_attention = [unit["unit_id"] for unit in units if not unit.get("has_attention")]
    if missing_attention:
        preview = ", ".join(missing_attention[:8])
        suffix = "..." if len(missing_attention) > 8 else ""
        issues.append(
            f"缺少“注意力调度”字段：{preview}{suffix}。阶段三不要写心理评论式“情绪功能”，"
            "必须写清观众视线从哪里转到哪里。"
        )

    anchor_pattern = re.compile(r"玻璃球眼睛|短爪|香蕉躯干|橙白幼猫脸|小短腿")
    anchor_hits = []
    for unit in units:
        hits = sorted(set(anchor_pattern.findall(unit.get("block") or "")))
        if hits:
            anchor_hits.append(f"{unit['unit_id']}（{', '.join(hits)}）")
    if anchor_hits:
        preview = "；".join(anchor_hits[:8])
        suffix = "..." if len(anchor_hits) > 8 else ""
        issues.append(
            f"角色外形锚定语污染阶段三：{preview}{suffix}。有 @图片1-9 时，阶段三只写角色名+动作，"
            "把“玻璃球眼睛/短爪”等角色卡词改成“眼睛/爪子/身体/面部”。"
        )

    def _extract_timeline_entries(timeline: str) -> list[tuple[float, float, str]]:
        entries: list[tuple[float, float, str]] = []
        for m in re.finditer(
            r"([0-9]+(?:\.[0-9]+)?)\s*[-—–]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:s|秒)?\s*[：:]\s*([^\n\r]+)",
            timeline or "",
        ):
            start, end = float(m.group(1)), float(m.group(2))
            if end >= start:
                entries.append((start, end, m.group(3).strip()))
        return entries

    low_change_pattern = re.compile(r"凝视|静止|微僵|睁大眼|眼睛睁大|耳朵|抖动|闭眼|看向远方|保持静止|停住|歪头|身体僵住|屏息|呼吸变浅")
    prep_pattern = re.compile(r"底盘微沉|底盘下沉|重心下沉|重心压低|重心前移|身体前倾|肩膀松弛|深吸气|呼吸变浅")
    change_pattern = re.compile(r"打滑|脱手|入画|入水|浮起|倾斜|回弹|碰撞|轻撞|坠落|砸|举盾|借力|登上|翻身|滑行|后退|后撤|前扑|拉紧|破碎|显露|站稳|靠拢|凑近|靠近|远离|伸出|伸向|收回|抓|抱住|握|触|碰|踩|举|放下|推|拉|挪|移动|移|转|倒下|倒去|漂移|撑|拉拽|弹起|飞出|落在|滚落|停在|偏离|飘离|脱离|转向|凝结|沉降|显现|出现|消失|滑脱|脱落|折返|压低|绷紧|松动|抽离")
    micro_only_beats = []
    overlong_short_actions = []
    for unit in units:
        for start, end, text in _extract_timeline_entries(unit.get("timeline") or ""):
            duration = round(end - start, 2)
            has_low_or_prep = low_change_pattern.search(text) or prep_pattern.search(text)
            has_core_action = change_pattern.search(text)
            if has_low_or_prep and not has_core_action:
                micro_only_beats.append(f"{unit['unit_id']} {start:g}-{end:g}s「{text[:24]}」")
            if re.search(r"后退半步|后撤半步|缩脖|本能后仰", text) and duration > 0.8:
                overlong_short_actions.append(f"{unit['unit_id']} {start:g}-{end:g}s「{text[:24]}」")
    if micro_only_beats:
        preview = "；".join(micro_only_beats[:8])
        suffix = "..." if len(micro_only_beats) > 8 else ""
        issues.append(
            f"微反应/体态预备独立占动作时间轴：{preview}{suffix}。眼睛、耳朵、僵住、屏息、底盘微沉等只能作为同段主动作的表演层，不能独立成 beat。"
        )
    if overlong_short_actions:
        preview = "；".join(overlong_short_actions[:8])
        suffix = "..." if len(overlong_short_actions) > 8 else ""
        issues.append(
            f"短反应动作被拉长：{preview}{suffix}。后撤半步/缩脖/本能后仰通常 0.3-0.6 秒，超过需明确慢动作或合并为“后撤后停住”。"
        )

    vague_adverb_pattern = re.compile(r"慢慢|缓缓|轻轻|微微|极轻|骤然|极速|瞬间|轻微")
    adverb_overuse = []
    for unit in units:
        count = len(vague_adverb_pattern.findall(unit.get("block") or ""))
        if count > 4:
            adverb_overuse.append(f"{unit['unit_id']}（{count}次）")
    if adverb_overuse:
        preview = "；".join(adverb_overuse[:8])
        suffix = "..." if len(adverb_overuse) > 8 else ""
        issues.append(
            f"动作副词通胀：{preview}{suffix}。把“慢慢/微微/极轻”等改成秒数、距离、方向、接触点或触发结果。"
        )

    # 反类型长镜头允许标记：单元里若显式写了"反类型长镜头"或"静止动态反触"，视为有意设计，不报警
    reverse_long_shot_pattern = re.compile(r"反类型长镜头|静止动态反触|反类型镜头|景别反常|节奏惊喜")
    slow_low_change = [
        unit["unit_id"]
        for unit in units
        if unit.get("duration", 0) >= 3
        and low_change_pattern.search((unit.get("action") or "") + "\n" + (unit.get("timeline") or ""))
        and len(change_pattern.findall((unit.get("action") or "") + "\n" + (unit.get("timeline") or ""))) <= 1
        and not reverse_long_shot_pattern.search((unit.get("action") or "") + "\n" + (unit.get("timeline") or ""))
    ]
    if slow_low_change:
        preview = ", ".join(slow_low_change[:8])
        suffix = "..." if len(slow_low_change) > 8 else ""
        issues.append(f"存在低变化动作被拉长到3秒以上：{preview}{suffix}。微反应应并入主动作，3秒以上必须有至少3个可见状态变化。")

    # —— 改造 7：剪辑节奏曲线审计（连续 3 个单元时长差 < 1 秒 → 节奏平）——
    if len(units) >= 3:
        flat_streaks = []
        for i in range(len(units) - 2):
            durs = [u.get("duration", 0) for u in units[i:i+3]]
            if all(d > 0 for d in durs) and max(durs) - min(durs) < 1.0:
                flat_streaks.append(f"{units[i]['unit_id']}-{units[i+2]['unit_id']}（时长 {durs}）")
        if flat_streaks:
            preview = "；".join(flat_streaks[:5])
            suffix = "..." if len(flat_streaks) > 5 else ""
            issues.append(
                f"剪辑节奏过平：{preview}{suffix}。连续 3 个生成单元时长极差 < 1 秒，"
                "缺乏'长短交替'的节奏感。建议在中间插入一个明显短（≤2秒）或明显长（≥6秒）的镜头制造节奏对比。"
            )

        mid_band = [u for u in units if 1.5 <= float(u.get("duration", 0) or 0) <= 2.5]
        if len(mid_band) / len(units) >= 0.7:
            preview = ", ".join(u["unit_id"] for u in mid_band[:10])
            suffix = "..." if len(mid_band) > 10 else ""
            issues.append(
                f"时长扎堆在 1.5-2.5 秒：{preview}{suffix}。{len(mid_band)}/{len(units)} 个生成单元落在中段，"
                "这会把整条分镜剪成同一口气。应加入明显短镜头或明显长镜头形成节奏支点。"
            )

    # —— 改造 7：景别多样性审计（连续 3 个同景别报警）——
    def _detect_shot_size(text: str) -> str:
        """从镜头类型/运镜里识别景别。"""
        text = text or ""
        if re.search(r"大特写|极特写|微距特写", text):
            return "extreme_close"
        if re.search(r"特写", text):
            return "close"
        if re.search(r"中近景", text):
            return "medium_close"
        if re.search(r"中景", text):
            return "medium"
        if re.search(r"中全景|大半景", text):
            return "medium_full"
        if re.search(r"全景|大全景", text):
            return "full"
        return ""

    if len(units) >= 3:
        shot_sizes = [_detect_shot_size(u.get("shot_type", "") or u.get("action", "")) for u in units]
        same_streaks = []
        for i in range(len(shot_sizes) - 2):
            window = shot_sizes[i:i+3]
            if window[0] and len(set(window)) == 1:
                same_streaks.append(f"{units[i]['unit_id']}-{units[i+2]['unit_id']}（连续3镜都是 {window[0]}）")
        if same_streaks:
            preview = "；".join(same_streaks[:5])
            issues.append(
                f"景别多样性不足：{preview}。连续 3 镜同景别会让画面节奏死掉。"
                "建议在中间插入一次景别跳跃（如中景→大特写→中景，或全景→中近景→全景）。"
            )

        # 全片景别覆盖率
        valid_sizes = [s for s in shot_sizes if s]
        if valid_sizes:
            unique_sizes = set(valid_sizes)
            if len(unique_sizes) <= 2 and len(valid_sizes) >= 5:
                size_label_map = {
                    "extreme_close": "大特写", "close": "特写", "medium_close": "中近景",
                    "medium": "中景", "medium_full": "中全景", "full": "全景",
                }
                used = "、".join(size_label_map.get(s, s) for s in unique_sizes)
                issues.append(
                    f"全片景别覆盖率过低：{len(valid_sizes)} 个生成单元只用了 {len(unique_sizes)} 种景别（{used}）。"
                    "建议增加至少 1 次极端景别（大特写或大全景）制造视觉峰值。"
                )

    # —— 时长字段一致性检测：4 个时长字段必须全部相等（不允许预判加冗余）——
    # 动作有效时长 = 成片时长 = 视频提交时长 = 生成时长，差异 ≥ 0.3 秒就报警
    units_with_dual = [
        u for u in units
        if u.get("action_duration", 0) > 0 and u.get("submit_duration", 0) > 0
    ]
    if len(units_with_dual) >= 3:
        differing = [
            u for u in units_with_dual
            if abs(u["action_duration"] - u["submit_duration"]) >= 0.3
        ]
        if differing:
            preview = ", ".join(u["unit_id"] for u in differing[:6])
            issues.append(
                f"时长字段擅自分开：{preview}{'...' if len(differing)>6 else ''}。"
                "阶段三的'动作有效时长'与'视频提交时长'必须相等（都等于真实戏剧动作所需时长）。"
                "冗余加时（例如即梦提交时加 2 秒防截断）由用户在即梦平台自己决定，阶段三不要预判。"
            )

    if not issues:
        return ""

    bullet_lines = "\n".join(f"- {issue}" for issue in issues)
    return (
        "## 自动质量闸门（阻断级）\n"
        "当前分镜包存在会直接影响后续全案图/视频生成的问题，建议先重写阶段三，不要直接进入阶段四。\n\n"
        f"{bullet_lines}\n\n"
        "修正指令：重新生成阶段三时，严格以阶段一剧本正文和阶段二“场景卡 · | S? |”为唯一场景来源；"
        "逐场覆盖目标、阻力、选择、结果，继承阶段二 @图片10-49 场景编号；"
        "先输出导演剪辑表和动作有效时长，再写视频提交时长，修正总览里的单元数量和总时长。"
    )


def _extract_match(pattern: str, text: str, flags: int = 0) -> str:
    match = re.search(pattern, text or "", flags)
    return match.group(1).strip() if match else ""


def _extract_block(pattern: str, text: str) -> str:
    return re.sub(r"\s+", " ", _extract_match(pattern, text or "", re.DOTALL)).strip()


def _parse_model_json(text: str) -> dict:
    raw = (text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {"raw": raw}
    except Exception:
        match = re.search(r"\{[\s\S]*\}", raw)
        if match:
            try:
                parsed = json.loads(match.group(0))
                return parsed if isinstance(parsed, dict) else {"raw": raw}
            except Exception:
                pass
    return {
        "pass": False,
        "score": 0,
        "issues": [{"dimension": "解析", "severity": "warning", "description": "审片报告不是可解析 JSON", "raw": raw[:500]}],
        "suggestion": "请人工检查该图片，或更换支持稳定 JSON 输出的评审模型。",
    }


def parse_json_array_lenient(content: str) -> list:
    """Parse a JSON array, salvaging complete objects if the model truncates mid-string."""
    cleaned = content.strip()
    if "```json" in cleaned:
        cleaned = cleaned.split("```json", 1)[1].split("```", 1)[0].strip()
    elif "```" in cleaned:
        cleaned = cleaned.split("```", 1)[1].split("```", 1)[0].strip()

    match = re.search(r'\[\s*\{.*', cleaned, re.DOTALL)
    if match:
        cleaned = match.group(0)

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass

    # Salvage complete top-level objects inside the array. This avoids losing
    # all inspirations when the final object is cut off by token limits.
    objects = []
    start = cleaned.find("[")
    i = start + 1 if start >= 0 else 0
    decoder = json.JSONDecoder()
    while i < len(cleaned):
        while i < len(cleaned) and cleaned[i] in " \r\n\t,":
            i += 1
        if i >= len(cleaned) or cleaned[i] == "]":
            break
        if cleaned[i] != "{":
            i += 1
            continue
        try:
            obj, end = decoder.raw_decode(cleaned[i:])
            if isinstance(obj, dict):
                objects.append(obj)
            i += end
        except json.JSONDecodeError:
            break

    if objects:
        return objects
    raise ValueError("AI返回的JSON无法解析，且没有可抢救的完整灵感对象")
@app.get("/get_available_ips")
def get_available_ips():
    try:
        ips = []
        if os.path.exists(KB_IP_DIR):
            for name in os.listdir(KB_IP_DIR):
                if os.path.isdir(os.path.join(KB_IP_DIR, name)):
                    ips.append(name)
        return {"status": "success", "ips": ips}
    except Exception as e:
        return {"status": "error", "detail": str(e)}


@app.get("/get_prompts")
def get_prompts():
    if os.path.exists(PROMPTS_PATH):
        with open(PROMPTS_PATH, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    return {}


# ---------- 5. 四段式生产引擎 ----------
@app.post("/generate")
async def generate_endpoint(req: GenerateRequest):
    route = req.routes.get(req.stage)
    if not route or not route.key:
        raise HTTPException(status_code=400, detail=f"请先在系统设置中配置 [{req.stage}] 阶段的模型路由 API Key！")
    nodes = get_api_nodes_for_route(route)
    if not nodes:
        raise HTTPException(status_code=400, detail="解析 API 节点失败，请检查配置。")

    print(f"\n收到生成请求: [{req.stage}] | 挂载IP: {req.ip_names}")

    async def generate_stream():
        full_response = ""
        try:
            # ==========================================
            # 第一阶段：预处理与上下文构建（只执行一次，避免重复消耗 Token）
            # ==========================================
            context = await load_knowledge_for_stage(req.stage, req.ip_names, req.run_id)

            example_block = ""  # V4架构已采用极简3字段，无需复杂的Few-Shot范例注入

            enhanced_input = req.input
            is_sequential_shot = req.stage == "shot" and req.execution_mode == "sequential" and req.segments

            if req.stage == "shot":
                # 🌟 切片模式下跳过预推演；接续模式下跳过
                if "自动化分段" not in req.input and "系统最高防断裂指令" not in req.input:
                    pass  # 新架构：固定要素库包已包含所有决策信息，无需前置推演

            # 🌟【全量出片模式】：强制注入防截断指令
            if req.stage == "shot" and req.execution_mode == "batch":
                enhanced_input += "\n\n【特别指令】：当前为全量模式！请无视输出长度限制，必须一次性输出所有生成单元的完整提示词包，严禁在中间停止或省略！"
            # 接续生成：非JSON阶段从历史中提取尾部上下文，作为续写锚点
            if "系统最高防断裂指令" in req.input and req.stage != "prompt":
                    # 没有上下文锚点时模型会迷路，导致"接不上前面的内容"
                    tail_context = ""
                    if req.session_id in conversation_histories:
                        for msg in reversed(conversation_histories[req.session_id]):
                            if msg["role"] == "assistant":
                                clean = msg["content"].replace('​', '').replace('‌', '').replace('‍', '').replace('﻿', '').strip()
                                # 按段落倒序选取，总长 ≤ 1000 字，保证断点锚定在完整意群上
                                paragraphs = [p for p in clean.split('\n') if p.strip()]
                                selected = []
                                total = 0
                                for p in reversed(paragraphs):
                                    if total + len(p) < 1000:
                                        selected.insert(0, p)
                                        total += len(p)
                                    else:
                                        break
                                tail_context = "\n\n".join(selected)
                                break

                    if tail_context:
                        enhanced_input = req.input + f"""

【系统底层强制覆写·断点续写模式】：
当前为断点续写！以下是之前输出的最后部分内容（上下文锚点，不是让你重复的）：
<已生成内容的结尾片段>
...{tail_context}
</已生成内容的结尾片段>

请直接、无缝地接着以上内容的最后一个字符继续输出！
铁律：
1. 绝对禁止进行任何前置剧情回忆、禁止逻辑推演、禁止输出思考过程！
2. 绝对禁止重复上面<已生成内容的结尾片段>中已经写过的任何内容！
3. 你输出的第一个字符必须能完美拼接到上一段输出的最后一个字符后面！
4. 如果上段在生成某个片段/镜头的中间截断，请从该片段/镜头的断裂点继续写，不要重头开始！
5. 如果上段以分隔符（如"---"）结尾，请直接开始下一个片段的完整内容！"""
                    else:
                        enhanced_input = req.input + """

【系统底层强制覆写】：当前为断点续写！绝对禁止进行任何前置剧情回忆、禁止逻辑推演、禁止输出思考过程！请直接、立刻输出断点后的下一个字符！"""

            sys_prompt = req.system_prompt.strip() or "请严格按照要求完成当前阶段的生成任务。"
            if req.stage in ("script", "visual", "shot", "image", "prompt") and _is_banana_cat_dog_project(req.ip_names, req.input) and SOFT_PET_DIRECTOR_MATRIX_GUARD not in sys_prompt:
                sys_prompt = f"{sys_prompt}\n\n{SOFT_PET_DIRECTOR_MATRIX_GUARD}"
            if req.stage == "script" and SCRIPT_DRAMA_GUARD not in sys_prompt:
                sys_prompt = f"{sys_prompt}\n\n{SCRIPT_DRAMA_GUARD}"
            if req.stage == "script" and _is_banana_cat_dog_project(req.ip_names, req.input) and SOFT_PET_SUCCESS_GUARD not in sys_prompt:
                sys_prompt = f"{sys_prompt}\n\n{SOFT_PET_SUCCESS_GUARD}"
            if req.stage == "shot" and SHOT_NARRATIVE_GUARD not in sys_prompt:
                sys_prompt = f"{sys_prompt}\n\n{SHOT_NARRATIVE_GUARD}"
            if req.stage == "shot" and _is_banana_cat_dog_project(req.ip_names, req.input) and SOFT_PET_CAMERA_GUARD not in sys_prompt:
                sys_prompt = f"{sys_prompt}\n\n{SOFT_PET_CAMERA_GUARD}"
            if req.stage in ("visual", "prompt") and VISUAL_COMPACT_CHARACTER_GUARD not in sys_prompt:
                sys_prompt = f"{sys_prompt}\n\n{VISUAL_COMPACT_CHARACTER_GUARD}"
            if req.stage in ("visual", "image", "prompt") and VISUAL_SCENE_IMAGE_PROMPT_GUARD not in sys_prompt:
                sys_prompt = f"{sys_prompt}\n\n{VISUAL_SCENE_IMAGE_PROMPT_GUARD}"

            # 改造：阶段二美术指导画像注入
            if req.stage == "visual":
                art_profile = _resolve_art_director_profile(req.art_director_profile)
                art_block = (
                    f"【本次视觉开发的美术方向：{art_profile['label']}】\n{art_profile['prompt']}"
                )
                if art_block not in sys_prompt:
                    sys_prompt = f"{sys_prompt}\n\n{art_block}"

            # 改造：阶段三摄影指导画像注入
            if req.stage == "shot":
                cine_profile = _resolve_cinematographer_profile(req.cinematographer_profile)
                cine_block = (
                    f"【本次分镜的摄影方向：{cine_profile['label']}】\n{cine_profile['prompt']}"
                )
                if cine_block not in sys_prompt:
                    sys_prompt = f"{sys_prompt}\n\n{cine_block}"

            # 🌟 Prompt Cache 优化：构建 system prompt，Claude 用 blocks，OpenAI 兼容用文本
            # 计算缓存键，判断是否可以复用
            cache_key = _get_system_prompt_cache_key(context, example_block, sys_prompt)
            cached = _system_prompt_cache.get(req.session_id)

            # 判断当前请求是否走 Claude（检查路由配置的节点）
            is_claude_stage = any("claude" in n["model"].lower() for n in nodes)

            cache_hit = bool(cached and cached["hash"] == cache_key)
            total, rate = _record_prompt_cache(cache_hit)
            print(f"[PromptCache] 命中率统计 | hit={cache_hit} | stage={req.stage} | claude={is_claude_stage} | hit_rate={rate:.1f}% ({_prompt_cache_stats['hits']}/{total})")

            if cache_hit:
                # 命中缓存：复用已构建的 system prompt
                system_blocks = cached.get("system_blocks")  # Claude 格式
                full_system_instruction = cached["full_text"]   # OpenAI 兼容格式
                print(f"[PromptCache] 命中会话级 system prompt 缓存 | stage={req.stage} | claude={is_claude_stage}")
            else:
                # 未命中：重新构建
                if req.stage == "script":
                    full_system_instruction = f"""【创作参考与角色底色】
下面内容不是铁律，也不是制作清单；它只提供角色识别、性格底色和创作方向。请调用你作为编剧/导演的叙事、场面、人物关系和节奏判断，自由完成剧本初稿。
<creative_reference>\n{context}\n</creative_reference>\n{example_block}
======================================
【导演任务层】\n{sys_prompt}
【交付方式】：直接输出剧本初稿，不解释思考过程，不复述参考资料，不写前言后语。"""
                else:
                    full_system_instruction = f"""【后台制作手册与连续性约束】
下面内容只用于保持世界观、角色一致性、技术边界和制作规范；创作时请自然吸收，不要复述规则口吻。
<knowledge_base>\n{context}\n</knowledge_base>\n{example_block}
======================================
【导演任务层】\n{sys_prompt}
【交付方式】：直接输出本阶段成品，不解释思考过程，不复述后台规则，不写前言后语。"""
                system_blocks = _build_system_blocks(context, example_block, sys_prompt, req.stage)
                _system_prompt_cache[req.session_id] = {
                    "hash": cache_key,
                    "system_blocks": system_blocks,
                    "full_text": full_system_instruction,
                }
                # 缓存上限守卫，防止内存泄漏
                if len(_system_prompt_cache) > 50:
                    _system_prompt_cache.pop(next(iter(_system_prompt_cache)))
                print(f"[PromptCache] 新建 system prompt 缓存 | stage={req.stage} | claude={is_claude_stage}")

            if req.session_id not in conversation_histories:
                conversation_histories[req.session_id] = deque(maxlen=MAX_TURNS * 2)
            history = list(conversation_histories[req.session_id])

            # 构建基础 messages（不含最后的 user）
            base_messages = []
            if not is_claude_stage:
                base_messages.append({"role": "system", "content": full_system_instruction})

            # 🌟 自动化切片推演时跳过冗长历史，防止 Token 爆炸和注意力稀释
            is_chunking_process = "自动化分段" in enhanced_input
            is_continue = "系统最高防断裂指令" in req.input

            if is_continue and not is_chunking_process:
                # 只有断点续写需要读取历史。普通生成必须保持“单次任务”干净，
                # 避免同一阶段反复生成时被上一版剧本/视觉包/分镜包污染。
                if req.stage == "prompt" and history:
                    # prompt 阶段 JSON 上下文已内联到 user 接续指令中，不加载 assistant 历史
                    for msg in history:
                        if msg["role"] != "assistant":
                            base_messages.append(msg)
                else:
                    for msg in history:
                        base_messages.append(msg)

            messages = base_messages + [{"role": "user", "content": enhanced_input}]

            # ==========================================
            # 第二阶段：双轨智能切换与异构灾备轮询（核心修复区）
            # ==========================================
            start_index = random.randint(0, len(nodes) - 1)
            has_yielded = False # 状态锁：判断是否已经开始输出内容
            quota_failed_nodes: list[dict] = []

            if req.stage == "shot" and req.execution_mode == "sequential" and req.segments:
                # 🌟 轨道 A：逐段推演 (Claude 模式) —— 循环 segments，每一段生成后 yield 分隔符触发前端弹窗
                # 🌟 Prompt Cache 核心优化：system_blocks 保持不变，只替换最后一条 user 消息
                for seg_idx, segment_content in enumerate(req.segments):
                    yield f"\n\n> 🎬 正在生成第 {seg_idx + 1}/{len(req.segments)} 段分镜...\n\n"

                    seg_user_content = f"【场景卡片段 {seg_idx + 1}/{len(req.segments)}】\n{segment_content}\n\n请严格根据此片段生成对应的分镜单。"

                    if is_claude_stage and system_blocks is not None:
                        # Claude：复用 base_messages（不含 user），只替换最后的 user
                        seg_messages = list(base_messages)
                        seg_messages.append({"role": "user", "content": seg_user_content})
                        seg_response = await safe_api_call(
                            nodes, seg_messages,
                            STAGE_TEMPERATURES.get(req.stage, 0.6),
                            max_tokens=16384,
                            system_blocks=system_blocks,
                        )
                    else:
                        # OpenAI 兼容：复用 system + history，只替换 user
                        seg_messages = [{"role": "system", "content": full_system_instruction}]
                        if is_continue and not is_chunking_process:
                            for msg in history:
                                seg_messages.append(msg)
                        seg_messages.append({"role": "user", "content": seg_user_content})
                        seg_response = await safe_api_call(
                            nodes, seg_messages,
                            STAGE_TEMPERATURES.get(req.stage, 0.6),
                            max_tokens=16384,
                        )

                    full_response += seg_response
                    yield seg_response

                    # 每一段生成后 yield 结束符，触发前端弹窗确认
                    if seg_idx < len(req.segments) - 1:
                        yield "\n\n[SEGMENT_COMPLETE]\n\n"

                has_yielded = True


            else:
                # ====== 非 prompt 阶段：双轨流式输出 (Claude 原生 / OpenAI 兼容) ======
                for attempt in range(len(nodes)):
                    current_node = nodes[(start_index + attempt) % len(nodes)]
                    model_name_lower = current_node["model"].lower()
                    print(f"[引擎路由] 流式节点: [{current_node['model']}] (尝试 {attempt + 1}/{len(nodes)})")

                    try:
                        if "claude" in model_name_lower:
                            # ====== 轨道 A：Claude 原生普通流式通道 ======
                            anthropic_client = AsyncAnthropic(
                                api_key=current_node["key"],
                                base_url=current_node["url"] if current_node.get("url") else None,
                                http_client=get_http_client(current_node.get("use_proxy"), current_node.get("proxy_url", "")),
                            )

                            stream_kwargs = {
                                "model": current_node["model"],
                                "max_tokens": _claude_max_output_tokens(current_node["model"]),
                                "temperature": STAGE_TEMPERATURES.get(req.stage, 0.6),
                            }

                            # 🌟 Prompt Caching：使用 block 格式传递 system，知识库部分标记缓存断点
                            if is_claude_stage and system_blocks is not None:
                                stream_kwargs["system"] = system_blocks
                                # base_messages 不含 system 也不含最后一条 user，需补齐
                                stream_kwargs["messages"] = base_messages + [{"role": "user", "content": enhanced_input}]
                            else:
                                system_text = "\n".join([m["content"] for m in messages if m["role"] == "system"]).strip()
                                stream_kwargs["system"] = system_text
                                stream_kwargs["messages"] = [m for m in messages if m["role"] != "system"]

                            async with anthropic_client.messages.stream(**stream_kwargs) as stream:
                                async for text in stream.text_stream:
                                    if text:
                                        has_yielded = True
                                        full_response += text
                                        yield text

                            if not full_response.strip():
                                print(f"[Claude空数据诊断] 模型={current_node['model']}, full_response长度={len(full_response)}, repr={repr(full_response[:500])}")
                                raise ValueError("Claude 返回了空数据")
                            break

                        else:
                            # ====== 轨道 B：OpenAI 兼容普通流式通道 ======
                            stream_client = AsyncOpenAI(
                                api_key=current_node["key"],
                                base_url=current_node["url"] if current_node.get("url") else None,
                                http_client=get_http_client(current_node.get("use_proxy"), current_node.get("proxy_url", "")),
                            )

                            current_temp = 0.01 if "系统最高防断裂指令" in req.input else STAGE_TEMPERATURES.get(req.stage, 0.6)
                            current_route = req.routes.get(req.stage)
                            is_thinking_mode = getattr(current_route, 'is_thinking', False)

                            call_params = {
                                "model": current_node["model"],
                                "messages": messages,
                                "temperature": 0.1 if is_thinking_mode else current_temp,
                                "max_tokens": 32768,
                                "stream": True
                            }

                            if is_thinking_mode:
                                thinking_extra_body = _thinking_extra_body_for_model(current_node["model"], current_node.get("url") or "")
                                if thinking_extra_body:
                                    call_params["extra_body"] = thinking_extra_body
                                else:
                                    print(f"[深度思考] 模型 {current_node['model']} 不支持通用 thinking 参数，已跳过 extra_body 注入。")

                            response = await asyncio.wait_for(
                                stream_client.chat.completions.create(**call_params),
                                timeout=STREAM_START_TIMEOUT_SECONDS,
                            )

                            last_yield_time = time.time()
                            reasoning_buffer = ""  # 收集 reasoning，作为 content 为空时的回退

                            # 防御：某些 Gemini 代理返回原始字符串而非流式迭代器
                            if isinstance(response, str):
                                if response.strip():
                                    has_yielded = True
                                    full_response += response
                                    yield response
                            else:
                                chunk_count = 0
                                async for chunk in response:
                                    chunk_count += 1
                                    if chunk.choices and len(chunk.choices) > 0:
                                        delta = chunk.choices[0].delta
                                        content = getattr(delta, 'content', None) or ""
                                        reasoning = getattr(delta, 'reasoning_content', None) or ""

                                        if content:
                                            has_yielded = True
                                            full_response += content
                                            yield content
                                            last_yield_time = time.time()
                                        elif reasoning:
                                            reasoning_buffer += reasoning
                                            # 推理阶段发送心跳保持连接
                                            current_time = time.time()
                                            if current_time - last_yield_time > 2.0:
                                                yield "​"
                                                last_yield_time = current_time

                                # 🔄 流式返回 0 chunk 时，自动回退到非流式调用
                                if not has_yielded and chunk_count == 0:
                                    print(f"[引擎路由] 🔄 流式返回 0 chunk，回退非流式: {current_node['model']}")
                                    call_params_sync = {k: v for k, v in call_params.items() if k != "stream"}
                                    fallback_resp = await asyncio.wait_for(
                                        stream_client.chat.completions.create(**call_params_sync),
                                        timeout=STREAM_START_TIMEOUT_SECONDS,
                                    )
                                    try:
                                        if isinstance(fallback_resp, str):
                                            fallback_text = fallback_resp
                                        elif isinstance(fallback_resp, dict):
                                            fallback_text = fallback_resp["choices"][0]["message"]["content"]
                                        else:
                                            fallback_text = fallback_resp.choices[0].message.content
                                    except (AttributeError, KeyError, IndexError, TypeError):
                                        print(f"[引擎路由] ⚠️ 非流式回退也失败: {current_node['model']}, type={type(fallback_resp).__name__}, repr={repr(fallback_resp)[:500]}")
                                        fallback_text = None

                                    if fallback_text and fallback_text.strip():
                                        has_yielded = True
                                        full_response += fallback_text
                                        yield fallback_text
                                        print(f"[引擎路由] ✅ 非流式回退成功: {current_node['model']}, 长度={len(fallback_text)}")

                            # DeepSeek 思考模式可能将全部输出放在 reasoning_content 中，content 始终为空
                            if not full_response.strip() and reasoning_buffer.strip():
                                print(f"[流式回退] content 为空，使用 reasoning_content 作为输出 (长度={len(reasoning_buffer)})")
                                full_response = reasoning_buffer
                                has_yielded = True
                                yield full_response

                            if not full_response.strip():
                                raise ValueError(
                                    f"API 返回了空流式正文，节点 {current_node['model']} 没有输出可保存内容"
                                )

                            break

                    except Exception as e:
                        if has_yielded:
                            print(f"[流式截断] 节点 {current_node['model']} 传输中断。")
                            raise e
                        else:
                            if _is_quota_exceeded_error(e):
                                quota_failed_nodes.append(current_node)
                                print(f"API 节点额度已耗尽，切换备用节点: [{current_node['model']}], 错误:{sanitize_error_msg(str(e))[:80]}")
                                if attempt == len(nodes) - 1:
                                    raise ApiQuotaError(_format_quota_exceeded_message(e, current_node, quota_failed_nodes)) from e
                                continue

                            if attempt == len(nodes) - 1:
                                raise e
                            print(f"节点受限，触发秒切... 失败节点:[{current_node['model']}], 错误:{str(e)[:40]}")
                            await asyncio.sleep(1)

            # ==========================================
            # 第三阶段：后处理与持久化存档
            # ==========================================

            # 【存盘修复补丁】：识别接续状态与自动化切片，将文本碎片完美拼接！
            safe_response = full_response.replace('​', '').replace('‌', '').replace('‍', '').replace('﻿', '')
            if req.stage == "shot" and "自动化分段" in req.input:
                safe_response = _sanitize_chunked_shot_response(safe_response, req.input)
                full_response = safe_response
            content_to_save = safe_response
            is_continue = "系统最高防断裂指令" in req.input
            # 🌟 修复暗号对齐：识别前端发送的 "自动化分段执行指令"
            is_chunking = "自动化分段" in req.input

            if is_continue or is_chunking:
                blocks = []
                # 倒序遍历历史记录
                for msg in reversed(conversation_histories[req.session_id]):
                    if msg["role"] == "assistant":
                        blocks.append(msg["content"])
                    elif msg["role"] == "user":
                        # 🌟 修复暗号对齐
                        if "系统最高防断裂指令" in msg["content"] or "自动化分段" in msg["content"]:
                            continue
                        else:
                            break
                blocks.reverse()

                if is_chunking:
                    # 切片模式：保留第一段的表头，剥离所有后续段的Markdown表头和代码块
                    final_blocks = []
                    for i, blk in enumerate(blocks):
                        c = re.sub(r'```markdown\n?', '', blk)
                        c = re.sub(r'```\n?', '', c)
                        if i > 0:
                            c = re.sub(r'^\|.*镜头编号.*\|\n', '', c, flags=re.MULTILINE)
                            c = re.sub(r'^\|[\s:|-]+\|\n', '', c, flags=re.MULTILINE)
                        final_blocks.append(c.strip())

                    clean_resp = re.sub(r'```markdown\n?', '', full_response)
                    clean_resp = re.sub(r'```\n?', '', clean_resp)
                    clean_resp = re.sub(r'^\|.*镜头编号.*\|\n', '', clean_resp, flags=re.MULTILINE)
                    clean_resp = re.sub(r'^\|[\s:|-]+\|\n', '', clean_resp, flags=re.MULTILINE)

                    content_to_save = "\n".join(final_blocks) + "\n" + clean_resp.strip()
                else:
                    # 断点接续模式：直接硬拼接，然后去重接续残留
                    accumulated = "".join(blocks)
                    content_to_save = accumulated + safe_response
                    # 阶段三接续残留去重：相邻拼接处可能因模型在断点写出半截 Sx-Uy，
                    # 续写时又重写了完整 Sx-Uy，导致同一编号出现两次。检测并保留更完整的那一份。
                    if req.stage == "shot":
                        content_to_save = _dedupe_shot_units(content_to_save)

            if req.stage == "shot":
                quality_report = _build_shot_quality_gate_report(content_to_save, req.input)
                if quality_report:
                    content_to_save = content_to_save.rstrip() + "\n\n---\n\n" + quality_report
                    yield "\n\n---\n\n" + quality_report

            if req.stage == "visual":
                visual_report = _build_visual_quality_gate_report(
                    content_to_save, req.input, req.ip_names
                )
                if visual_report:
                    content_to_save = content_to_save.rstrip() + "\n\n---\n\n" + visual_report
                    yield "\n\n---\n\n" + visual_report

            if req.stage == "script":
                script_report = _build_script_quality_gate_report(
                    content_to_save, req.input, req.ip_names
                )
                if script_report:
                    content_to_save = content_to_save.rstrip() + "\n\n---\n\n" + script_report
                    yield "\n\n---\n\n" + script_report

            # 保存进内存历史（过滤零宽字符，防止污染后续接续生成的上下文）
            if is_continue or is_chunking:
                old_history = conversation_histories[req.session_id]
                # 倒序移除：接续user消息 + 之前的assistant碎片，直到遇到非接续的user消息为止
                while old_history:
                    last = old_history[-1]
                    if last["role"] == "assistant":
                        old_history.pop()
                    # 🌟 修复暗号对齐
                    elif last["role"] == "user" and ("系统最高防断裂指令" in last["content"] or "自动化分段" in last["content"]):
                        old_history.pop()
                    else:
                        break

            conversation_histories[req.session_id].append({"role": "user", "content": enhanced_input})
            # 接续/切片时存入拼接后的完整全文，而非本次碎片，确保后续接续能获取完整上下文
            history_entry = content_to_save if (is_continue or is_chunking) and content_to_save.strip() else safe_response
            conversation_histories[req.session_id].append({"role": "assistant", "content": history_entry})

            # 使用拼接后的【完整全文 (content_to_save)】去执行 JSON 解析和本地存盘！
            if content_to_save.strip():
                save_generated_content(req.stage, content_to_save, req.run_id)

        except Exception as e:
            error_msg = sanitize_error_msg(str(e))
            yield f"\n\n\n> [异常] {error_msg}"
            if full_response.strip():
                save_generated_content(req.stage, full_response, req.run_id)

    return StreamingResponse(generate_stream(), media_type="text/plain")


@app.post("/clear_memory")
def clear_memory(req: ClearMemoryRequest):
    if req.session_id in conversation_histories:
        conversation_histories[req.session_id].clear()
    return {"status": "success"}

@app.post("/save_output")
def save_output(req: SaveOutputRequest):
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="保存内容为空")
    folder_path = save_generated_content(req.stage, req.content, req.run_id)
    return {"status": "success", "folder": folder_path}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 任务包打包端点：把完整上下文打包成一条可粘贴到高级模型的自包含 prompt
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.post("/pack_visual_job")
async def pack_visual_job(req: PackVisualJobRequest):
    """打包阶段二视觉开发任务包：返回一条自包含 prompt，可粘贴到 Kiro/Codex/Antigravity 等高级模型窗口直接执行。"""
    script_text = (req.script or "").strip()
    if not script_text:
        raise HTTPException(status_code=400, detail="剧本为空，无法打包阶段二任务。")

    # 加载知识库
    context = await load_knowledge_for_stage("visual", req.ip_names, req.run_id)

    # 加载 system prompt
    try:
        with open(PROMPTS_PATH, "r", encoding="utf-8") as f:
            prompts = json.load(f)
        sys_prompt = prompts.get("visual", "")
    except Exception:
        sys_prompt = ""

    # 美术画像
    profile = _resolve_art_director_profile(req.art_director_profile)
    profile_block = f"【本次美术画像：{profile['label']}】\n{profile['prompt']}\n" if profile["label"] != "默认（按导演画像或自行判断）" else ""

    # 护栏
    guards = f"\n\n{VISUAL_COMPACT_CHARACTER_GUARD}\n\n{VISUAL_SCENE_IMAGE_PROMPT_GUARD}"

    # 组装完整 prompt
    packed = f"""【角色与任务】
{sys_prompt}

{profile_block}
{guards}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【知识库参考】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{context}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【阶段一剧本（你的输入材料）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{script_text}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【执行指令】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
请直接输出完整的固定要素库包（# [项目名] · 固定要素库包），不要解释创作过程，不要写前言后语。"""

    return {"prompt": packed, "char_count": len(packed), "token_estimate": len(packed) // 2}


@app.post("/pack_shot_job")
async def pack_shot_job(req: PackShotJobRequest):
    """打包阶段三分镜提示词任务包：返回一条自包含 prompt，可粘贴到 Kiro/Codex/Antigravity 等高级模型窗口直接执行。"""
    script_text = (req.script or "").strip()
    visual_text = (req.visual or "").strip()
    if not script_text:
        raise HTTPException(status_code=400, detail="剧本为空，无法打包阶段三任务。")
    if not visual_text:
        raise HTTPException(status_code=400, detail="固定要素库包为空，无法打包阶段三任务。")

    # 加载知识库
    context = await load_knowledge_for_stage("shot", req.ip_names, req.run_id)

    # 加载 system prompt
    try:
        with open(PROMPTS_PATH, "r", encoding="utf-8") as f:
            prompts = json.load(f)
        sys_prompt = prompts.get("shot", "")
    except Exception:
        sys_prompt = ""

    # 摄影画像
    profile = _resolve_cinematographer_profile(req.cinematographer_profile)
    profile_block = f"【本次摄影画像：{profile['label']}】\n{profile['prompt']}\n" if profile["label"] != "默认（按导演/美术画像或自行判断）" else ""

    # 护栏
    guards = SHOT_NARRATIVE_GUARD
    if _is_banana_cat_dog_project(req.ip_names, script_text):
        guards += f"\n\n{SOFT_PET_CAMERA_GUARD}"

    # 组装完整 prompt
    packed = f"""【角色与任务】
{sys_prompt}

{profile_block}
{guards}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【知识库参考】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{context}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【阶段一剧本（叙事参考）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{script_text}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【阶段二固定要素库包（视觉资产参考）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{visual_text}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【执行指令】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
请直接输出完整的即梦分镜提示词包（# [项目名] · 即梦分镜提示词包），不要解释创作过程，不要写前言后语。"""

    return {"prompt": packed, "char_count": len(packed), "token_estimate": len(packed) // 2}


@app.post("/pack_art_cut_job")
async def pack_art_cut_job(req: PackArtCutJobRequest):
    """打包阶段二美术二稿任务包：返回一条自包含 prompt，可粘贴到高级模型窗口执行美术剪辑。"""
    visual_text = (req.visual or "").strip()
    if not visual_text:
        raise HTTPException(status_code=400, detail="第一稿固定要素库包为空，无法打包美术二稿任务。")

    context = await load_knowledge_for_stage("visual", req.ip_names, req.run_id)
    profile = _resolve_art_director_profile(req.art_director_profile)
    profile_block = f"【本次美术二稿的审美方向：{profile['label']}】\n{profile['prompt']}"

    force_block = ""
    if req.force_scene == "first":
        force_block = "【强制重写指令】本次必须重写 S1（第一张场景卡），无论它是否最弱。其他场景保留原样。"
    elif req.force_scene == "last":
        force_block = "【强制重写指令】本次必须重写最后一张场景卡，无论它是否最弱。其他场景保留原样。"

    user_focus = (req.revision_focus or "").strip() or "由你判断哪一张场景卡最弱，只重写最弱的一到两张。"

    script_block = f"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n【阶段一剧本（叙事参考）】\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n{req.script.strip()}\n" if (req.script or "").strip() else ""

    packed = f"""你现在不再是一稿视觉开发，而是看完第一稿之后做"美术剪辑"的资深美术指导。

{profile_block}

{force_block}

【你的任务】
不是从头重写，而是做一次有意识的"美术二稿"。请按以下原则操作：
1. 先在内部诊断第一稿最弱的视觉决策（色彩雷同/道具无情感重量/场景图 prompt 模板化/差异锚点缺失）。
2. 保留所有已经成立的部分（场景编号、@图片编号、角色卡、已经写得好的场景卡）。
3. 只重写最弱的一到两张场景卡，重写时必须加入至少两个反类型视觉元素。
4. 第一稿原文保留至少 60% 字数。

【用户对本次剪辑的修订重点】
{user_focus}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【知识库参考】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{context}

{VISUAL_COMPACT_CHARACTER_GUARD}

{VISUAL_SCENE_IMAGE_PROMPT_GUARD}
{script_block}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【第一稿固定要素库包】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{visual_text}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【执行指令】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
请先输出一段简短的"美术剪辑笔记"（200-400字），再输出完整的美术剪辑版固定要素库包。不要解释 prompt 本身。"""

    return {"prompt": packed, "char_count": len(packed), "token_estimate": len(packed) // 2}


@app.post("/pack_cine_cut_job")
async def pack_cine_cut_job(req: PackCineCutJobRequest):
    """打包阶段三摄影二稿任务包：返回一条自包含 prompt，可粘贴到高级模型窗口执行摄影剪辑。"""
    shot_text = (req.shot or "").strip()
    if not shot_text:
        raise HTTPException(status_code=400, detail="第一稿分镜提示词包为空，无法打包摄影二稿任务。")

    context = await load_knowledge_for_stage("shot", req.ip_names, req.run_id)
    profile = _resolve_cinematographer_profile(req.cinematographer_profile)
    profile_block = f"【本次摄影二稿的审美方向：{profile['label']}】\n{profile['prompt']}"

    force_block = _resolve_force_unit_instruction(req.force_unit)

    user_focus = (req.revision_focus or "").strip() or "由你判断哪一个生成单元最弱（通常是节奏拖、景别雷同、运镜机械、风格头雷同的那一个），只重写最弱的一到两个。"

    visual_block = f"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n【阶段二固定要素库包（场景/角色一致性参考）】\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n{req.visual.strip()}\n" if (req.visual or "").strip() else ""
    script_block = f"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n【阶段一剧本（叙事参考）】\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n{req.script.strip()}\n" if (req.script or "").strip() else ""

    # 护栏
    guards = SHOT_NARRATIVE_GUARD
    if _is_banana_cat_dog_project(req.ip_names, req.script or ""):
        guards += f"\n\n{SOFT_PET_CAMERA_GUARD}"

    packed = f"""你现在不再是一稿分镜，而是看完第一稿之后做"摄影剪辑"的资深摄影指导。

{profile_block}

{force_block}

【你的任务】
不是从头重写，而是做一次有意识的"摄影二稿"。请按以下原则操作：

1. **先在内部诊断**第一稿最弱的镜头决策。优先检查：
   - 镜头命题是否清楚、是否被反向触碰过
   - 同一场内连续 3-4 个生成单元是否使用了相同景别 → 景别雷同
   - 完整提示词开头是否共用相同的 24 字模板 → 风格头雷同
   - 完整提示词结尾是否逐字复制 100 字风格尾 → 风格尾雷同
   - 动作时间轴是否把微反应独立成 beat → 导演逻辑错误
   - 是否出现角色卡锚定语（玻璃球眼睛、短爪等）污染阶段三
   - 是否有节奏惊喜（特别短或特别长的镜头）
   - 是否缺剪辑节奏对比

2. **保留所有已经成立的部分**（场号、编号、@图片、好的单元原样保留，至少 60% 字数）。

3. **只重写最弱的部分**：加入至少两个反类型镜头元素（节奏惊喜/景别反常/静止动态反触）。

3-补. 风格头/尾雷同必须全片修复（不算配额）。
3-补B. 时长字段一致性、@图片编号一致性、编号唯一性必须全片回填。
3-补C. 反类型长镜头（静止≥4秒）必须显式标记。

【用户对本次剪辑的修订重点】
{user_focus}

{guards}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【知识库参考】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{context}
{script_block}{visual_block}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【第一稿分镜提示词包】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{shot_text}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【执行指令】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
请先输出"## 摄影剪辑笔记"（200-400字），再输出完整的摄影剪辑版分镜提示词包。不要解释 prompt 本身。"""

    return {"prompt": packed, "char_count": len(packed), "token_estimate": len(packed) // 2}


def _resolve_run_folder_for_read(run_id: str = "") -> tuple[str, str] | tuple[None, None]:
    safe_run_id = re.sub(r"[^0-9A-Za-z_\-]", "_", run_id).strip("_") if run_id else ""
    if safe_run_id:
        folder_path = _safe_join_under(OUTPUTS_DIR, safe_run_id)
        if os.path.isdir(folder_path):
            return safe_run_id, folder_path
        return None, None

    candidates = [
        p for p in glob.glob(os.path.join(OUTPUTS_DIR, "*"))
        if os.path.isdir(p)
    ]
    if not candidates:
        return None, None
    latest = max(candidates, key=os.path.getmtime)
    return os.path.basename(latest), latest


@app.get("/run_folders")
def list_run_folders():
    runs = []
    stage_order = ["script", "visual", "shot", "image"]
    for folder_path in glob.glob(os.path.join(OUTPUTS_DIR, "*")):
        if not os.path.isdir(folder_path):
            continue
        run_id = os.path.basename(folder_path)
        files = {}
        present = []
        for stage in stage_order:
            filepath = _safe_join_under(folder_path, STAGE_FILE_MAP[stage])
            exists = os.path.exists(filepath)
            files[stage] = exists
            if exists:
                present.append(stage)
        try:
            updated_ts = os.path.getmtime(folder_path)
        except OSError:
            updated_ts = 0.0
        try:
            created_ts = os.path.getctime(folder_path)
        except OSError:
            created_ts = updated_ts
        runs.append({
            "run_id": run_id,
            "created_at": datetime.fromtimestamp(created_ts).isoformat() if created_ts else "",
            "created_ts": created_ts,
            "updated_at": datetime.fromtimestamp(updated_ts).isoformat() if updated_ts else "",
            "updated_ts": updated_ts,
            "files": files,
            "stage_count": len(present),
            "stages": present,
        })

    runs.sort(key=lambda item: item.get("created_ts", item.get("updated_ts", 0)), reverse=True)
    return {"status": "success", "runs": runs}


@app.get("/run_outputs")
def get_run_outputs(run_id: str = ""):
    resolved_run_id, folder_path = _resolve_run_folder_for_read(run_id)
    if not folder_path:
        raise HTTPException(status_code=404, detail="没有找到可载入的项目输出目录。")

    stage_order = ["script", "visual", "shot", "image"]
    outputs = {}
    files = {}
    for stage in stage_order:
        filepath = os.path.join(folder_path, STAGE_FILE_MAP[stage])
        content = ""
        if os.path.exists(filepath):
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
        outputs[stage] = content
        files[stage] = filepath if content else ""

    generated_images = {}
    images_dir = os.path.join(folder_path, "images")
    if os.path.isdir(images_dir):
        for meta_file in sorted(glob.glob(os.path.join(images_dir, "*.json")), key=os.path.getmtime):
            try:
                with open(meta_file, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                frame_id = meta.get("frame_id") or ""
                saved = meta.get("saved") or []
                if frame_id and saved:
                    generated_images.setdefault(frame_id, []).extend(saved)
            except Exception:
                continue

    return {
        "status": "success",
        "run_id": resolved_run_id,
        "folder": folder_path,
        "outputs": outputs,
        "files": files,
        "generated_images": generated_images,
    }

def _build_image_generation_url(base_url: str | None) -> str:
    base = (base_url or "https://api.openai.com/v1").strip().rstrip("/")
    if base.endswith("/images/generations"):
        return base
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    if base.endswith("/v1"):
        return f"{base}/images/generations"
    return f"{base}/v1/images/generations"


def _build_image_edit_url(base_url: str | None) -> str:
    base = (base_url or "https://api.openai.com/v1").strip().rstrip("/")
    if base.endswith("/images/edits"):
        return base
    if base.endswith("/images/generations"):
        base = base[: -len("/images/generations")]
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    if base.endswith("/v1"):
        return f"{base}/images/edits"
    return f"{base}/v1/images/edits"


def _is_flux_model(model: str) -> bool:
    return "flux" in (model or "").lower()


def _is_flux_kontext_model(model: str) -> bool:
    lowered = (model or "").lower()
    return "flux" in lowered and "kontext" in lowered


def _aspect_ratio_from_size(size: str) -> str:
    clean = (size or "").lower().strip()
    if clean in {"21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "9:21"}:
        return clean
    match = re.match(r"^\s*(\d+)\s*x\s*(\d+)\s*$", clean)
    if not match:
        return "16:9"
    width, height = int(match.group(1)), int(match.group(2))
    if width == height:
        return "1:1"
    return "16:9" if width > height else "9:16"


def _limit_flux_prompt(prompt: str, limit: int = 1000) -> tuple[str, bool]:
    text = re.sub(r"\s+", " ", (prompt or "").strip())
    if len(text) <= limit:
        return text, False

    hard_guard = ""
    marker = "【场景参考图硬约束】"
    if marker in text:
        hard_guard = marker + text.split(marker, 1)[1]

    if hard_guard:
        hard_guard = hard_guard[-min(len(hard_guard), 360):]
        prefix_limit = max(200, limit - len(hard_guard) - 12)
        return (text[:prefix_limit].rstrip() + " ... " + hard_guard).strip()[:limit], True

    head_limit = max(700, limit - 140)
    return (text[:head_limit].rstrip() + " ... " + text[-120:].lstrip()).strip()[:limit], True


def _image_ext_from_bytes(raw: bytes, content_type: str = "") -> str:
    ctype = (content_type or "").lower()
    if "jpeg" in ctype or "jpg" in ctype:
        return ".jpg"
    if "webp" in ctype:
        return ".webp"
    if raw.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return ".webp"
    return ".png"


def _extract_image_items(data: dict) -> list[dict]:
    items = data.get("data") or []
    if isinstance(items, list) and items:
        return items

    output = data.get("output")
    if isinstance(output, str) and output:
        return [{"url": output}]
    if isinstance(output, list):
        return [{"url": item} if isinstance(item, str) else item for item in output if item]

    extracted = []
    for choice in data.get("choices") or []:
        content = (((choice or {}).get("message") or {}).get("content") or "").strip()
        if not content:
            continue
        try:
            parsed = json.loads(content)
            extracted.extend(_extract_image_items(parsed))
            continue
        except Exception:
            pass
        for url in re.findall(r"https?://[^\s)>\"]+", content):
            extracted.append({"url": url})
    return extracted


def _is_transient_image_error(status_code: int, detail: str = "") -> bool:
    text = (detail or "").lower()
    if _is_permanent_image_error(status_code, detail):
        return False
    return (
        status_code in {408, 409, 425, 429, 500, 502, 503, 504}
        or "overloaded" in text
        or "rate limit" in text
        or "timeout" in text
        or "temporarily unavailable" in text
    )


def _is_permanent_image_error(status_code: int, detail: str = "") -> bool:
    text = (detail or "").lower()
    return (
        "endpoint not supported" in text
        or "unsupported endpoint" in text
        or ("convert_request_failed" in text and "endpoint" in text)
        or "model_not_found" in text
        or "model not found" in text
        or "no available channel for model" in text
    )


def _format_image_error(status_code: int, detail: str, model: str, endpoint: str) -> str:
    text = (detail or "").lower()
    if (
        "endpoint not supported" in text
        or "unsupported endpoint" in text
        or ("convert_request_failed" in text and "endpoint" in text)
    ):
        return (
            f"模型 {model} 当前通道不支持图片接口 {endpoint}。"
            "请换一个支持该模型图片端点的渠道，或切回 gpt-image-2。"
            f"原始错误：{detail}"
        )
    if (
        "model_not_found" in text
        or "model not found" in text
        or "no available channel for model" in text
    ):
        return (
            f"模型 {model} 当前通道不可用或未开通。"
            "请检查模型名、分组权限，或切换到已验证可用的生图模型。"
            f"原始错误：{detail}"
        )
    return detail or f"图片接口返回 HTTP {status_code}"


def _should_strip_image_param(status_code: int, detail: str, param_name: str) -> bool:
    if status_code not in {400, 404, 415, 422}:
        return False
    text = (detail or "").lower()
    compact_param = param_name.lower()
    readable_param = compact_param.replace("_", " ")
    return (
        compact_param in text
        or readable_param in text
        or "unknown parameter" in text
        or "unrecognized" in text
        or "unsupported" in text
        or "not supported" in text
        or "unexpected" in text
    )


def _public_output_url(filepath: str) -> str:
    rel = os.path.relpath(filepath, OUTPUTS_DIR).replace(os.sep, "/")
    return f"/outputs/{rel}"


def _safe_image_frame_id(frame_id: str) -> str:
    safe = re.sub(r"[^0-9A-Za-z_\-]+", "_", frame_id or "frame").strip("_")
    return safe or "frame"


def _read_stage_content_for_job(folder_path: str, stage: str, provided_outputs: dict) -> str:
    provided = (provided_outputs or {}).get(stage, "")
    if isinstance(provided, str) and provided.strip():
        return provided.replace('​', '').strip()

    filepath = os.path.join(folder_path, STAGE_FILE_MAP.get(stage, f"{stage}.txt"))
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return f.read().replace('​', '').strip()
        except Exception:
            return ""
    return ""


def _asset_for_codex_job(entry: dict) -> dict:
    return {
        "id": entry.get("id"),
        "label": f"@图片{entry.get('id')}",
        "description": entry.get("description", ""),
        "category": entry.get("category", ""),
        "status": entry.get("status", ""),
        "path": entry.get("path", ""),
        "public_url": entry.get("public_url", ""),
        "filename": entry.get("filename", ""),
        "run_id": entry.get("run_id", ""),
        "frame_id": entry.get("frame_id", ""),
        "created_at": entry.get("created_at", ""),
    }


def _find_previous_full_board_images(images_dir: str, previous_segment_no: int) -> list[dict]:
    if previous_segment_no < 1 or not os.path.isdir(images_dir):
        return []

    patterns = [
        f"CODEX-BUILTIN-FULL-BOARD-{previous_segment_no}-*.png",
        f"CODEX-FULL-BOARD-{previous_segment_no}-*.png",
        f"FULL-BOARD-{previous_segment_no}-*.png",
    ]
    seen = set()
    candidates = []
    for pattern in patterns:
        for filepath in glob.glob(os.path.join(images_dir, pattern)):
            if filepath in seen or not os.path.isfile(filepath):
                continue
            seen.add(filepath)
            try:
                candidates.append({
                    "path": filepath,
                    "public_url": _public_output_url(filepath),
                    "filename": os.path.basename(filepath),
                    "created_at": datetime.fromtimestamp(os.path.getmtime(filepath)).isoformat(),
                    "size_bytes": os.path.getsize(filepath),
                })
            except Exception:
                continue

    return sorted(candidates, key=lambda item: item.get("created_at", ""), reverse=True)


@app.post("/codex_storyboard_job")
def create_codex_storyboard_job(req: CodexStoryboardJobRequest):
    prompt = (req.board_prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="全案分镜图 prompt 为空，无法创建 Codex 任务包。")

    folder_path = get_or_create_run_folder(req.run_id)
    safe_run_id = os.path.basename(folder_path)
    jobs_dir = os.path.join(folder_path, "codex_jobs")
    images_dir = os.path.join(folder_path, "images")
    os.makedirs(jobs_dir, exist_ok=True)
    os.makedirs(images_dir, exist_ok=True)

    segment_no = max(1, int(req.segment_index or 0) + 1)
    safe_range = _safe_image_frame_id(req.segment_range or f"segment-{segment_no}")
    target_frame_id = _safe_image_frame_id(f"CODEX-FULL-BOARD-{segment_no}-{safe_range}")
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    job_id = _safe_image_frame_id(f"{stamp}-{target_frame_id}")

    stage_context = {
        stage: _read_stage_content_for_job(folder_path, stage, req.stage_outputs)
        for stage in ["script", "visual", "shot", "image"]
    }

    reg = _load_image_registry()
    requested_ids = req.reference_image_ids if req.reference_image_ids is not None else [1, 2]
    scoped_entries = _scoped_registry_images(reg, safe_run_id)
    requested_assets = []
    for img_id in requested_ids:
        entry = _get_registry_entry(reg, img_id, safe_run_id)
        if entry:
            requested_assets.append(_asset_for_codex_job(entry))
    all_assets = [
        _asset_for_codex_job(entry)
        for _, entry in sorted(scoped_entries.items(), key=lambda kv: int(kv[0]) if str(kv[0]).isdigit() else 9999)
    ]

    target_meta_path = os.path.join(images_dir, f"{target_frame_id}.codex.json")
    target_image_pattern = os.path.join(images_dir, f"{target_frame_id}_*.png")
    job_json_path = os.path.join(jobs_dir, f"{job_id}.json")
    job_md_path = os.path.join(jobs_dir, f"{job_id}.md")
    previous_segment_no = segment_no - 1
    previous_board_images = _find_previous_full_board_images(images_dir, previous_segment_no)
    previous_board_reference = {
        "required": segment_no > 1,
        "previous_segment_no": previous_segment_no if segment_no > 1 else None,
        "images": previous_board_images[:3],
        "primary_image": previous_board_images[0] if previous_board_images else None,
        "instruction": (
            "Before generating this board, inspect the previous full storyboard board for visual continuity: "
            "character proportions, costume/prop details, board layout, palette, lighting, scene geography, and the previous ending state. "
            "Use it only as continuity reference; do not repeat previous segment story beats."
            if segment_no > 1
            else "This is the first storyboard board segment, so no previous board continuity reference is required."
        ),
    }
    compact_board_prompt_policy = {
        "must_create_before_image_generation": True,
        "must_use_for_builtin_imagegen": True,
        "source_priority": [
            "board_prompt",
            "previous_board_reference",
            "requested_assets",
            "character_refs",
            "style_text",
            "stage_outputs as background only",
        ],
        "target_length": "1800-2600 Chinese characters; hard max 3500 Chinese characters",
        "must_include": [
            "target format: one 16:9 high-density full storyboard planning board",
            "segment title, segment range, total duration, exact storyboard frame count",
            "character reference rules and role consistency constraints",
            "previous board continuity constraints when applicable",
            "per-frame visual plan with shot number, action-beat duration, source unit, camera/motion, action/emotion, lighting/atmosphere, handoff state",
            "action rhythm constraints: use action effective duration, never stretch blink/gaze/ear twitch/light touch into 2+ seconds",
            "layout constraints: reference area <=20%, environment area <=20%, storyboard grid >=60%",
            "style and quality constraints",
            "hard negative constraints: no extra plot, no extra main character, no later segment content, no text blocking actions",
        ],
        "must_drop": [
            "full script excerpts",
            "full visual development package",
            "full shot package",
            "full scene-image plan",
            "duplicated style adjectives",
            "long background lore not visible in the current segment",
        ],
    }

    job_payload = {
        "job_id": job_id,
        "created_at": datetime.now().isoformat(),
        "type": "codex_full_storyboard_board",
        "execution_policy": {
            "mode": "builtin_imagegen_only",
            "required_tool": "image_gen",
            "must_not_call_project_image_api": True,
            "forbidden_endpoints": ["/generate_image"],
            "must_create_compact_board_prompt": True,
            "image_prompt_source": "compact_board_prompt_only",
            "compact_board_prompt_target_chars": "1800-2600",
            "save_hint": "Use the system built-in image generation tool first. If the generated PNG is available under C:/Users/Administrator/.codex/generated_images, copy it into target.images_dir and write metadata. Do not consume the user's configured image API for this Codex task.",
        },
        "run_id": safe_run_id,
        "folder": folder_path,
        "segment_index": req.segment_index,
        "segment_no": segment_no,
        "segment_title": req.segment_title,
        "segment_range": req.segment_range,
        "image_size": req.image_size,
        "target": {
            "frame_id": target_frame_id,
            "images_dir": images_dir,
            "image_pattern": target_image_pattern,
            "metadata_path": target_meta_path,
        },
        "reference_image_ids": requested_ids,
        "requested_assets": requested_assets,
        "all_assets": all_assets,
        "previous_board_reference": previous_board_reference,
        "compact_board_prompt": "",
        "compact_board_prompt_policy": compact_board_prompt_policy,
        "character_reference_mode": req.character_reference_mode,
        "character_refs": req.character_refs,
        "style_text": req.style_text,
        "board_prompt": prompt,
        "jimeng_prompt": req.jimeng_prompt,
        "stage_outputs": stage_context,
    }

    with open(job_json_path, "w", encoding="utf-8") as f:
        json.dump(job_payload, f, ensure_ascii=False, indent=2)

    stage_titles = {
        "script": "阶段一 剧本",
        "visual": "阶段二 视觉开发/固定要素库",
        "shot": "阶段三 分镜提示词包",
        "image": "阶段四 场景图生图清单",
    }
    assets_md = "\n".join(
        f"- {asset['label']} | {asset.get('category') or '-'} | {asset.get('description') or '-'} | {asset.get('path') or '未绑定本地文件'}"
        for asset in requested_assets
    ) or "- 未找到指定参考图，请先检查 @图片1/@图片2 是否已上传到当前 run_id。"
    all_assets_md = "\n".join(
        f"- {asset['label']} | {asset.get('category') or '-'} | {asset.get('description') or '-'} | {asset.get('path') or '未绑定本地文件'}"
        for asset in all_assets
    ) or "- 当前项目图片库为空。"
    if segment_no <= 1:
        previous_board_md = "第 1 段不需要上一张全案分镜图参考。"
    elif previous_board_reference["primary_image"]:
        previous_board_md = "\n".join(
            f"- {idx + 1}. {image['path']}"
            for idx, image in enumerate(previous_board_reference["images"])
        )
    else:
        previous_board_md = (
            f"未在 images 目录找到第 {previous_segment_no} 段的全案分镜图。"
            "执行时请继续生成，但需更依赖角色图与当前任务文本保持一致。"
        )
    stages_md = "\n\n".join(
        f"## {stage_titles[stage]}\n\n{content or '（未提供）'}"
        for stage, content in stage_context.items()
    )

    job_md = f"""# Codex 全案分镜图生图任务

## 执行方式

当用户在 Codex 聊天里说“执行最新全案分镜图任务”时，请读取本任务包，理解上下文后生成全案分镜图片。

**硬性执行策略**：
- 必须使用当前 ChatGPT/Codex 系统内置生图工具（image_gen / imagegen）。
- 禁止调用本项目的 `/generate_image` 接口。
- 禁止使用用户在前端配置的图片 API Key、图片模型通道或中转站。
- 调用内置生图前，必须先基于下方原始“全案分镜图 Prompt”整理一个 `compact_board_prompt`。
- 内置生图工具的 prompt 只能使用 `compact_board_prompt`；原始长 prompt、剧本、视觉包、分镜包只作为理解材料，不要整段塞进生图工具。
- 内置生图完成后，如图片文件出现在 `C:\\Users\\Administrator\\.codex\\generated_images`，再复制到下方目标目录并写入元数据。
- 如果内置生图工具不可用，请直接说明不可用，不要自动降级到项目图片 API。
- 第 2 段及以后必须先查看“上一张全案分镜图连续性参考”；第 1 段不需要。
- 上一张全案分镜图只用于角色比例、道具细节、版式、光色、场景地理和上段结尾状态的连续性，不得把上一段剧情重复画进当前段。

## compact_board_prompt 生成规则

执行本任务时，请先生成一个紧凑执行稿 `compact_board_prompt`，再用它进行内置生图。

- 目标长度：约 1800-2600 个中文字符，硬上限 3500 个中文字符。
- 信息优先级：当前片段边界、总时长、分镜格数量、逐格画面计划、角色参考规则、上一张全案图连续性、版式约束、风格和禁止项。
- 必须删除：完整剧本原文、完整视觉开发包、完整阶段三分镜包、完整阶段四场景清单、重复风格词、不可见的世界观背景。
- 必须保留：每格的镜头编号、动作节拍时长、来源单元、镜头/运镜、注意力调度、主动作与表演层、灯光/氛围、衔接状态。
- 动作节奏规则：只按动作有效时长切格，不按视频提交冗余时长切格；眨眼、耳抖、眼神、凝视等微反应不单独列为时间轴，只写进主动作同一时间段；只有大特写/插入镜头专门表现微反应时，才可单列 0.3-0.8 秒；轻碰、点水等短动作必须和触发结果同格呈现；3 秒以上格子必须包含至少 3 个可见状态变化。
- 推荐结构：`总目标` → `角色/参考图规则` → `连续性要求` → `版式` → `逐格计划` → `风格质量` → `禁止项`。
- 如果原始 prompt 与 compact 规则冲突，以 compact 规则为准；如果 compact 遗漏关键剧情，以原始 prompt 补齐后再生图。

## 任务信息

- job_id: {job_id}
- run_id: {safe_run_id}
- 段落: 第 {segment_no} 段
- 标题: {req.segment_title or '未命名'}
- 来源范围: {req.segment_range or '未提供'}
- 目标尺寸: {req.image_size}

## 目标保存位置

- 图片目录: {images_dir}
- 建议文件名前缀: {target_frame_id}
- 图片文件建议: {target_image_pattern}
- 元数据文件建议: {target_meta_path}

## 参考图（优先使用）

{assets_md}

## 上一张全案分镜图连续性参考

{previous_board_md}

## 当前项目全部图片库

{all_assets_md}

## 角色参考说明

角色参考模式: {req.character_reference_mode or 'uploaded'}

{req.character_refs or '（未提供）'}

## 风格说明

{req.style_text or '（未提供）'}

## 全案分镜图 Prompt

{prompt}

## 即梦直投指令

{req.jimeng_prompt or '（未提供）'}

{stages_md}
"""

    with open(job_md_path, "w", encoding="utf-8") as f:
        f.write(job_md)

    return {
        "status": "success",
        "job_id": job_id,
        "run_id": safe_run_id,
        "job_path": job_md_path,
        "job_json_path": job_json_path,
        "job_url": _public_output_url(job_md_path),
        "target": job_payload["target"],
        "requested_assets": requested_assets,
    }


@app.post("/generate_image")
async def generate_image(req: ImageGenerationRequest):
    prompt = (req.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="生图 prompt 为空。")
    if not req.route or not req.route.key:
        raise HTTPException(status_code=400, detail="请先在系统设置的 [4. 图片生图 API] 中配置图片 API Key。")

    nodes = get_api_nodes_for_route(req.route, "gpt-image-2-pro")
    if not nodes:
        raise HTTPException(status_code=400, detail="解析图片 API 节点失败，请检查第4阶段配置。")

    folder_path = get_or_create_run_folder(req.run_id)
    images_dir = os.path.join(folder_path, "images")
    os.makedirs(images_dir, exist_ok=True)

    frame_id = _safe_image_frame_id(req.frame_id)
    stamp = datetime.now().strftime("%H%M%S")
    last_error = ""
    image_timeout = httpx.Timeout(
        IMAGE_READ_TIMEOUT_SECONDS,
        connect=30.0,
        read=IMAGE_READ_TIMEOUT_SECONDS,
        write=60.0,
        pool=10.0,
    )
    reference_assets = _load_reference_assets(req.reference_image_ids, req.run_id)
    reference_asset_meta = [
        {k: v for k, v in asset.items() if k != "image"}
        for asset in reference_assets
    ]

    for node in nodes:
        image_http_client = get_http_client(node.get("use_proxy"), node.get("proxy_url", ""))
        model = node.get("model") or "gpt-image-2-pro"
        is_flux = _is_flux_model(model)
        is_flux_edit = _is_flux_kontext_model(model) and bool(reference_assets)
        request_prompt, prompt_truncated = _limit_flux_prompt(prompt) if is_flux else (prompt, False)
        generation_url = _build_image_generation_url(node.get("url"))
        edit_url = _build_image_edit_url(node.get("url"))
        aspect_ratio = _aspect_ratio_from_size(req.size)
        json_reference_assets = [
            {k: v for k, v in asset.items() if k not in {"filepath", "filename", "mime"}}
            for asset in reference_assets
        ]
        reference_data_urls = [asset.get("image") for asset in reference_assets if asset.get("image")]

        payload = {
            "model": model,
            "prompt": request_prompt,
            "n": max(1, min(int(req.n or 1), 10)),
        }
        if is_flux:
            payload["aspect_ratio"] = aspect_ratio
            # FLUX 的一步创建接口不接受 1536x1024 这类 GPT size；
            # 文档要求 aspect_ratio，返回 URL 最稳定。
            payload["response_format"] = "url"
            if reference_data_urls and not is_flux_edit:
                # 一步 API 文档描述支持「提示和/或输入图像」，但 schema 未写明字段。
                # 先按中转常见兼容字段尝试；若接口明确不支持，下面会自动降级重试。
                payload["reference_images"] = reference_data_urls
        else:
            payload["size"] = req.size or "1536x1024"
            if req.response_format:
                payload["response_format"] = req.response_format
            if json_reference_assets:
                payload["reference_images"] = json_reference_assets

        edit_files = []
        if is_flux_edit:
            for asset in reference_assets:
                filepath = asset.get("filepath") or ""
                if not filepath or not os.path.exists(filepath):
                    continue
                with open(filepath, "rb") as f:
                    edit_files.append((
                        "image",
                        (asset.get("filename") or os.path.basename(filepath), f.read(), asset.get("mime") or "image/png"),
                    ))

        headers = {"Authorization": f"Bearer {node['key']}"}
        json_headers = {**headers, "Content-Type": "application/json"}

        def strip_reference_params(source_payload: dict) -> dict:
            clean_payload = dict(source_payload)
            for ref_param in ["reference_images", "image", "input_image"]:
                clean_payload.pop(ref_param, None)
            return clean_payload

        def build_reference_strategies() -> list[dict]:
            if not reference_assets:
                return [{
                    "name": "no_refs",
                    "payload": dict(payload),
                    "files": [],
                    "use_edit": False,
                    "assets": [],
                    "transport": "text_only",
                }]

            strategies = [{
                "name": "full_refs",
                "payload": dict(payload),
                "files": list(edit_files),
                "use_edit": is_flux_edit,
                "assets": list(reference_assets),
                "transport": "native",
            }]

            if len(reference_assets) > 1:
                single_payload = dict(payload)
                if "reference_images" in single_payload:
                    single_payload["reference_images"] = (
                        [reference_data_urls[0]]
                        if is_flux and reference_data_urls
                        else json_reference_assets[:1]
                    )
                strategies.append({
                    "name": "single_ref",
                    "payload": single_payload,
                    "files": edit_files[:1],
                    "use_edit": is_flux_edit,
                    "assets": reference_assets[:1],
                    "transport": "native_single",
                })

            if is_flux and not is_flux_edit and reference_data_urls:
                for alt_param in ["image", "input_image"]:
                    alt_payload = strip_reference_params(payload)
                    alt_payload[alt_param] = reference_data_urls[0]
                    strategies.append({
                        "name": "single_ref",
                        "payload": alt_payload,
                        "files": [],
                        "use_edit": False,
                        "assets": reference_assets[:1],
                        "transport": alt_param,
                    })

            strategies.append({
                "name": "no_refs",
                "payload": strip_reference_params(payload),
                "files": [],
                "use_edit": False,
                "assets": [],
                "transport": "text_only",
            })
            return strategies

        async def post_image_request(active_payload: dict, active_files: list, use_edit: bool):
            request_url = edit_url if use_edit else generation_url
            if use_edit:
                form_data = {
                    "model": active_payload["model"],
                    "prompt": active_payload["prompt"],
                    "n": str(active_payload["n"]),
                    "aspect_ratio": active_payload.get("aspect_ratio", aspect_ratio),
                }
                if active_payload.get("response_format"):
                    form_data["response_format"] = active_payload["response_format"]
                return await image_http_client.post(
                    request_url,
                    headers=headers,
                    data=form_data,
                    files=active_files,
                    timeout=image_timeout,
                )
            return await image_http_client.post(request_url, headers=json_headers, json=active_payload, timeout=image_timeout)

        try:
            if prompt_truncated:
                log_image_event(f"FLUX提示词已压缩 | frame={frame_id} | original_len={len(prompt)} | sent_len={len(request_prompt)} | limit=1000")

            response = None
            strategy_used = "no_refs"
            strategy_assets = []
            strategy_transport = "text_only"
            image_url = generation_url

            for strategy in build_reference_strategies():
                active_payload = dict(strategy["payload"])
                active_files = list(strategy.get("files") or [])
                use_edit = bool(strategy.get("use_edit"))
                request_url = edit_url if use_edit else generation_url
                strategy_refs = ",".join("@图片" + str(a["id"]) for a in strategy.get("assets") or []) or "none"
                log_image_event(
                    f"开始生图 | frame={frame_id} | endpoint={request_url} | model={model} | "
                    f"mode={'flux-edit' if use_edit else 'flux-create' if is_flux else 'gpt-create'} | "
                    f"strategy={strategy['name']}:{strategy.get('transport')} | "
                    f"size={active_payload.get('size') or active_payload.get('aspect_ratio')} | prompt_len={len(request_prompt)}"
                    f"{'/' + str(len(prompt)) if prompt_truncated else ''} | refs={strategy_refs}"
                )

                response = await post_image_request(active_payload, active_files, use_edit)
                log_image_event(f"图片接口返回 | frame={frame_id} | strategy={strategy['name']} | status={response.status_code} | response_format={active_payload.get('response_format', 'default')}")

                for retry_idx, delay in enumerate([5, 12], start=1):
                    if response.status_code < 400:
                        break
                    detail = sanitize_error_msg(response.text[:1000])
                    if not _is_transient_image_error(response.status_code, detail):
                        break
                    last_error = detail
                    log_image_event(f"图片接口临时错误重试 | frame={frame_id} | strategy={strategy['name']} | retry={retry_idx}/2 | wait={delay}s | status={response.status_code} | detail={detail}")
                    await asyncio.sleep(delay)
                    response = await post_image_request(active_payload, active_files, use_edit)
                    log_image_event(f"图片接口临时错误重试返回 | frame={frame_id} | strategy={strategy['name']} | status={response.status_code}")

                response_detail = sanitize_error_msg(response.text[:1000]) if response.status_code >= 400 else ""
                if response.status_code >= 400 and "response_format" in active_payload and _should_strip_image_param(response.status_code, response_detail, "response_format"):
                    retry_payload = dict(active_payload)
                    retry_payload.pop("response_format", None)
                    log_image_event(f"图片接口参数兼容重试 | frame={frame_id} | strategy={strategy['name']} | 去掉 response_format")
                    response = await post_image_request(retry_payload, active_files, use_edit)
                    active_payload = retry_payload
                    log_image_event(f"图片接口参数兼容重试返回 | frame={frame_id} | strategy={strategy['name']} | status={response.status_code}")

                if response.status_code < 400:
                    payload = active_payload
                    image_url = request_url
                    strategy_used = strategy["name"]
                    strategy_assets = list(strategy.get("assets") or [])
                    strategy_transport = strategy.get("transport", "")
                    log_image_event(
                        f"参考图策略生效 | frame={frame_id} | strategy={strategy_used} | "
                        f"transport={strategy_transport} | refs={','.join('@图片'+str(a['id']) for a in strategy_assets) or 'none'}"
                    )
                    break

                raw_error = sanitize_error_msg(response.text[:1000])
                last_error = _format_image_error(response.status_code, raw_error, model, request_url)
                log_image_event(f"参考图策略失败 | frame={frame_id} | strategy={strategy['name']} | status={response.status_code} | detail={last_error}")

            if response is None or response.status_code >= 400:
                continue

            data = response.json()
            image_items = _extract_image_items(data)
            if not image_items:
                raise ValueError("图片接口返回为空。")

            saved = []
            bound_asset = None
            for idx, item in enumerate(image_items, start=1):
                if isinstance(item, str):
                    item = {"url": item}
                image_bytes = None
                content_type = ""
                public_url = ""
                local_path = ""
                remote_url = item.get("url") or ""

                if item.get("b64_json"):
                    raw_b64 = item["b64_json"].split(",", 1)[-1]
                    image_bytes = base64.b64decode(raw_b64)
                elif remote_url:
                    try:
                        img_resp = await image_http_client.get(remote_url, timeout=image_timeout)
                        if img_resp.status_code < 400:
                            image_bytes = img_resp.content
                            content_type = img_resp.headers.get("content-type", "")
                    except Exception:
                        image_bytes = None

                if image_bytes:
                    filename = f"{frame_id}_{stamp}_{idx}{_image_ext_from_bytes(image_bytes, content_type)}"
                    filepath = os.path.join(images_dir, filename)
                    with open(filepath, "wb") as f:
                        f.write(image_bytes)
                    local_path = filepath
                    public_url = _public_output_url(filepath)
                    if idx == 1 and req.bind_to_image_id:
                        bound_asset = _register_generated_asset(
                            int(req.bind_to_image_id),
                            filepath,
                            public_url,
                            req.bind_description,
                            req.bind_category,
                            req.run_id,
                            frame_id,
                        )

                saved.append({
                    "frame_id": frame_id,
                    "path": local_path,
                    "public_url": public_url,
                    "url": remote_url,
                    "revised_prompt": item.get("revised_prompt", ""),
                })

            meta_path = os.path.join(images_dir, f"{frame_id}_{stamp}.json")
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump({
                    "frame_id": frame_id,
                    "created_at": datetime.now().isoformat(),
                    "endpoint": image_url,
                    "model": payload["model"],
                    "size": payload.get("size") or payload.get("aspect_ratio"),
                    "prompt": prompt,
                    "reference_image_ids": req.reference_image_ids,
                    "reference_assets": reference_asset_meta,
                    "reference_strategy": strategy_used,
                    "reference_transport": strategy_transport,
                    "reference_assets_used": [
                        {k: v for k, v in asset.items() if k not in {"image", "filepath", "filename", "mime"}}
                        for asset in strategy_assets
                    ],
                    "bound_asset": bound_asset,
                    "response": data,
                    "saved": saved,
                }, f, ensure_ascii=False, indent=2)

            log_image_event(f"图片保存成功 | frame={frame_id} | count={len(saved)} | dir={images_dir}")
            return {
                "status": "success",
                "folder": folder_path,
                "images_dir": images_dir,
                "images": saved,
                "bound_asset": bound_asset,
                "reference_strategy": strategy_used,
                "reference_transport": strategy_transport,
                "reference_assets_used": [
                    {k: v for k, v in asset.items() if k not in {"image", "filepath", "filename", "mime"}}
                    for asset in strategy_assets
                ],
                "usage": data.get("usage"),
            }
        except httpx.ReadTimeout:
            last_error = (
                f"图片接口读取超时：{model} 在 {int(IMAGE_READ_TIMEOUT_SECONDS)} 秒内没有返回完整结果。"
                "这通常是中转通道排队、模型出图较慢，或 b64_json 响应体过大导致；"
                "可以重试、换更快的图片通道，或降低尺寸后再生成。"
            )
            log_image_event(f"图片生成超时 | frame={frame_id} | detail={last_error}")
        except httpx.TimeoutException as e:
            timeout_name = e.__class__.__name__
            last_error = (
                f"图片接口超时（{timeout_name}）：{model} 未在限定时间内完成连接/写入/读取。"
                "请稍后重试，或切换图片模型/中转通道。"
            )
            log_image_event(f"图片生成超时 | frame={frame_id} | detail={last_error}")
        except Exception as e:
            traceback.print_exc()
            raw_detail = sanitize_error_msg(str(e))
            last_error = raw_detail or f"{e.__class__.__name__}: 图片生成请求异常，但接口没有返回可读错误详情。"
            log_image_event(f"图片生成异常 | frame={frame_id} | detail={last_error}")

    raise HTTPException(status_code=502, detail=f"图片生成失败：{last_error or '所有图片节点均未成功返回。'}")


def _production_file_signature(folder_path: str) -> tuple[float, float]:
    visual_path = os.path.join(folder_path, STAGE_FILE_MAP["visual"])
    shot_path = os.path.join(folder_path, STAGE_FILE_MAP["shot"])
    return (
        os.path.getmtime(visual_path) if os.path.exists(visual_path) else 0.0,
        os.path.getmtime(shot_path) if os.path.exists(shot_path) else 0.0,
    )


def _load_production_bible(run_id: str) -> dict:
    safe_run = _safe_run_id(run_id)
    if not safe_run:
        return {"characters": {}, "scenes": {}, "shots": {}, "image_scene_map": {}}
    folder_path = get_or_create_run_folder(safe_run)
    signature = _production_file_signature(folder_path)
    cached = _production_bible_cache.get(safe_run)
    if cached and cached.get("signature") == signature:
        return cached.get("bible", {})

    bible = {"characters": {}, "scenes": {}, "shots": {}, "image_scene_map": {}}
    visual_path = os.path.join(folder_path, STAGE_FILE_MAP["visual"])
    shot_path = os.path.join(folder_path, STAGE_FILE_MAP["shot"])

    if os.path.exists(visual_path):
        with open(visual_path, "r", encoding="utf-8") as f:
            visual_content = f.read()

        char_sections = re.findall(
            r"###\s+角色卡\s*·\s*([^\n\r]+)([\s\S]*?)(?=\n###\s+角色卡|\n###\s+场景卡|\n##\s+|$)",
            visual_content,
        )
        for name, section in char_sections:
            clean_name = name.strip()
            bible["characters"][clean_name] = {
                "short_desc": _extract_block(r"短识别兜底[^：:]*[:：]\s*(?:\n)?([\s\S]*?)(?=\n\*\*|\n###|\n---|$)", section),
                "forbidden": _extract_block(r"禁止跑偏[^：:]*[:：]\s*(?:\n)?([\s\S]*?)(?=\n\*\*|\n###|\n---|$)", section),
                "ref_images": re.findall(r"@图片\s*(\d+)", section),
            }

        scene_sections = re.findall(
            r"###\s+场景卡\s*·\s*\|\s*(S\d+)\s*\|\s*([^\n\r]*)([\s\S]*?)(?=\n###\s+场景卡|\n###\s+角色卡|\n##\s+|$)",
            visual_content,
        )
        for scene_id, title, section in scene_sections:
            ref_images = re.findall(r"@图片\s*(\d+)", section)
            bible["scenes"][scene_id] = {
                "title": title.strip(),
                "lighting": _extract_block(r"时间光线[^：:]*[:：]\s*(?:\n)?([^\n\r]+)", section),
                "space": _extract_block(r"完整场景锁定描述[^：:]*[:：]\s*(?:\n)?([\s\S]*?)(?=\n\*\*|\n###|\n---|$)", section),
                "short_anchor": _extract_block(r"镜头短场景锚定[^：:]*[:：]\s*(?:\n)?([^\n\r]+)", section),
                "props": _extract_block(r"关键道具[^：:]*[:：]\s*(?:\n)?([\s\S]*?)(?=\n\*\*|\n###|\n---|$)", section),
                "ref_images": ref_images,
            }
            for img_id in ref_images:
                n = int(img_id)
                if 10 <= n <= 49:
                    bible["image_scene_map"][str(n)] = scene_id

    if os.path.exists(shot_path):
        with open(shot_path, "r", encoding="utf-8") as f:
            shot_content = f.read()
        shot_sections = re.findall(
            r"^###\s+生成单元\s+(S\d+-U\d+)[^\n\r]*([\s\S]*?)(?=^###\s+生成单元\s+S\d+-U\d+|^##\s+\|\s*S\d+\s*\||\Z)",
            shot_content,
            flags=re.MULTILINE,
        )
        for shot_id, section in shot_sections:
            scene_id = shot_id.split("-U", 1)[0]
            bible["shots"][shot_id] = {
                "scene_id": scene_id,
                "attention": _extract_block(r"注意力调度[^：:]*[:：]\s*([^\n\r]+)", section) or _extract_block(r"情绪功能[^：:]*[:：]\s*([^\n\r]+)", section),
                "emotion": _extract_block(r"情绪功能[^：:]*[:：]\s*([^\n\r]+)", section),
                "main_action": _extract_block(r"主动作与表演层[^：:]*[:：]\s*([^\n\r]+)", section) or _extract_block(r"动作&情绪[^：:]*[:：]\s*([^\n\r]+)", section),
                "refs": re.findall(r"@图片\s*(\d+)", section),
                "prompt": _extract_block(r"完整提示词[^：:]*[:：]\s*(?:\n)?([\s\S]*?)(?=\n-\s*给下一个生成单元|\n###|\n---|$)", section),
                "handoff": _extract_block(r"给下一个生成单元的接口[^：:]*[:：]\s*([^\n\r]+)", section),
            }

    _production_bible_cache[safe_run] = {"signature": signature, "bible": bible}
    if len(_production_bible_cache) > 50:
        _production_bible_cache.pop(next(iter(_production_bible_cache)))
    return bible


def _content_type_for_image(path: str, header_content_type: str = "") -> str:
    ctype = (header_content_type or "").split(";", 1)[0].strip().lower()
    if ctype.startswith("image/"):
        return ctype
    ext = os.path.splitext(path or "")[1].lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".png": "image/png",
    }.get(ext, "image/png")


async def _load_review_image_data_url(image_path: str, use_proxy: bool = False, proxy_url: str = "") -> str:
    source = (image_path or "").strip()
    if not source:
        raise HTTPException(status_code=400, detail="审片图片路径为空。")

    if source.startswith("http://") or source.startswith("https://"):
        img_resp = await get_http_client(use_proxy, proxy_url).get(source, timeout=30)
        if img_resp.status_code >= 400 or not img_resp.content:
            raise HTTPException(status_code=400, detail="无法读取远程图片。")
        mime = _content_type_for_image(source, img_resp.headers.get("content-type", ""))
        return f"data:{mime};base64,{base64.b64encode(img_resp.content).decode('ascii')}"

    if source.startswith("/outputs/"):
        rel = source[len("/outputs/"):].replace("/", os.sep)
        local_path = os.path.abspath(os.path.join(OUTPUTS_DIR, rel))
    else:
        local_path = os.path.abspath(source)

    try:
        if os.path.commonpath([os.path.abspath(OUTPUTS_DIR), local_path]) != os.path.abspath(OUTPUTS_DIR):
            raise HTTPException(status_code=400, detail="审片图片必须位于 outputs 目录内。")
    except ValueError:
        raise HTTPException(status_code=400, detail="审片图片路径无效。")

    if not os.path.exists(local_path):
        raise HTTPException(status_code=400, detail="审片图片文件不存在。")
    with open(local_path, "rb") as f:
        raw = f.read()
    if not raw:
        raise HTTPException(status_code=400, detail="审片图片文件为空。")
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="审片图片超过 25MB。")
    mime = _content_type_for_image(local_path)
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


@app.post("/review_image")
async def review_image(req: ImageReviewRequest):
    vision_route = req.review_routes.get("visual")
    if not vision_route or not vision_route.key:
        raise HTTPException(status_code=400, detail="请先配置视觉评审模型。")

    vision_nodes = get_api_nodes_for_route(vision_route)
    if not vision_nodes:
        raise HTTPException(status_code=400, detail="解析视觉评审模型节点失败。")
    if any("claude" in (node.get("model") or "").lower() for node in vision_nodes):
        raise HTTPException(status_code=400, detail="视觉审片当前需要 OpenAI-compatible 图像理解接口，请改用 Qwen-VL、Gemini 或 GLM-4V 兼容通道。")

    image_data_url = await _load_review_image_data_url(
        req.image_path,
        getattr(vision_route, "use_proxy", False),
        getattr(vision_route, "proxy_url", ""),
    )
    bible = _load_production_bible(req.run_id)
    scene_id = req.scene_id.strip()
    if not scene_id:
        asset_match = re.search(r"ASSET-SCENE-(\d+)", req.shot_id or req.image_path)
        if asset_match:
            scene_id = bible.get("image_scene_map", {}).get(asset_match.group(1), "")

    scene_info = bible.get("scenes", {}).get(scene_id, {})
    shot_info = bible.get("shots", {}).get(req.shot_id, {})

    vision_prompt = """请客观描述这张图片的所有视觉元素。按以下清单输出，不要评价，只描述：
1. 【主体】：画面中是否有角色、动物、人物或拟人角色；外貌、服装、配饰、姿态。
2. 【场景】：环境类型、地形、空间层次、时间感、光线来源、色温。
3. 【道具】：画面中出现的所有重要物体。
4. 【构图】：景别、镜头角度、主体位置、前中后景。
5. 【材质与风格】：画风、纹理质感、是否有塑料感、网格感、重复纹理。
6. 【异常检测】：是否出现文字、水印、畸形物体、额外生物或与场景不符的现代元素。"""
    vision_messages = [{
        "role": "user",
        "content": [
            {"type": "text", "text": vision_prompt},
            {"type": "image_url", "image_url": {"url": image_data_url}},
        ],
    }]
    vision_desc = await safe_api_call(vision_nodes, vision_messages, 0.2, max_tokens=2048)

    director_route = req.review_routes.get("story") or req.review_routes.get("summary") or vision_route
    director_nodes = get_api_nodes_for_route(director_route)
    if not director_nodes:
        director_nodes = vision_nodes

    character_requirements = []
    for char_name, char_info in bible.get("characters", {}).items():
        character_requirements.append(
            f"- {char_name}：{char_info.get('short_desc') or '未指定'}；禁止项：{char_info.get('forbidden') or '未指定'}"
        )

    is_empty_scene_asset = (req.shot_id or "").startswith("ASSET-SCENE")
    review_prompt = f"""你是严格的动画短片导演和美术质检。请根据视觉模型描述，对单张图片做一致性审片。

【审片对象】
图片/镜头编号：{req.shot_id or '未指定'}
所属场景：{scene_id or '未识别'}
是否空场景资产：{str(is_empty_scene_asset).lower()}

【视觉模型客观描述】
{vision_desc}

【角色圣经】
{chr(10).join(character_requirements) or '未读取到角色卡'}

【场景要求】
场景名：{scene_info.get('title') or '未指定'}
空间锁定：{scene_info.get('space') or scene_info.get('short_anchor') or '未指定'}
光线要求：{scene_info.get('lighting') or '未指定'}
关键道具：{scene_info.get('props') or '未指定'}

【分镜要求】
注意力调度：{shot_info.get('attention') or shot_info.get('emotion') or '未指定'}
分镜提示词：{shot_info.get('prompt') or '未指定'}

请只输出 JSON，不要 Markdown：
{{
  "pass": true,
  "score": 0,
  "issues": [
    {{"dimension": "角色一致性/场景一致性/光线/道具/构图/违禁/空场景", "severity": "critical/warning/info", "description": "具体问题", "expected": "应该是什么", "actual": "实际是什么"}}
  ],
  "suggestion": "如果未通过，给出修改后的生图 prompt 建议"
}}

判定标准：
- 空场景资产中出现任何角色、动物、人物、拟人角色，必须 critical 且 pass=false。
- 与场景地点、光线方向、关键道具明显不符，必须降分。
- 如果只有轻微风格差异，可 warning，不要过度否决。"""
    review_text = await safe_api_call(director_nodes, [{"role": "user", "content": review_prompt}], 0.2, max_tokens=2048)
    review_json = _parse_model_json(review_text)

    return {
        "status": "success",
        "shot_id": req.shot_id,
        "scene_id": scene_id,
        "vision_description": vision_desc,
        "review": review_json,
    }

@app.post("/generate_inspirations")
async def generate_inspirations(req: InspirationRequest):
    route = req.routes.get("script")
    if not route or not route.key:
        raise HTTPException(status_code=400, detail="请先在系统设置中配置 [1. 剧本生成] 的模型路由 API Key！")
    nodes = get_api_nodes_for_route(route)
    if not nodes:
        raise HTTPException(status_code=400, detail="解析 API 节点失败，请检查配置。")
    print(f"\n收到灵感生成请求 | 使用剧本路由 | 挂载IP: {req.ip_names} | 已避开历史灵感: {len(req.previous_ideas or [])}")

    try:
        context = await load_knowledge_for_stage("script", req.ip_names)
        user_need = req.input.strip() or "用户暂时没有额外限制，请自由发散适合90秒左右短片/动画的故事灵感。"
        style_hint = req.style_hint.strip() or "按当前项目气质自由判断。"
        style_avoid = req.style_avoid.strip()
        mounted_characters = []
        for ip_name in req.ip_names:
            if not ip_name or ip_name == "通用新IP项目":
                continue
            ip_path = os.path.join(KB_IP_DIR, ip_name)
            for md_file in glob.glob(os.path.join(ip_path, "剧本设定_*.md")):
                char_name = os.path.splitext(os.path.basename(md_file))[0].replace("剧本设定_", "").strip()
                if char_name and char_name not in mounted_characters:
                    mounted_characters.append(char_name)
        if not mounted_characters:
            mounted_characters = [
                re.sub(r"(宇宙|IP|角色)$", "", name).strip()
                for name in req.ip_names
                if name and name != "通用新IP项目"
            ]
        mounted_rule = (
            f"【挂载角色硬规则】\n当前用户已挂载角色/IP：{'、'.join(mounted_characters)}。\n"
            f"所有5个灵感必须以这些挂载角色为主角或核心搭档；story_input 字段必须明确写出这些角色名。"
            f"禁止用琉璃蛙、小狐狸、小鸟、陌生机器人等新主角替代它们。可以出现新生物/道具/环境生命，但只能作为障碍、被帮助对象、线索或场景机制。"
            if mounted_characters else
            "【挂载角色硬规则】\n当前未挂载专属角色，可按用户要求自由设计主角。"
        )
        sample_guard = SOFT_PET_SUCCESS_GUARD if _is_banana_cat_dog_project(req.ip_names, req.input) else ""

        # 🌟 风格反例段（让 styleMode 不只是“一句话描述”，再附一段明确避开方向）
        style_avoid_block = (
            f"【风格反例（这些方向请避开）】\n{style_avoid}"
            if style_avoid else ""
        )

        # 🌟 上一轮灵感避免段：把已生成的方向写进 prompt，强制 5 个新灵感与之明显不同
        avoid_block = ""
        prev_ideas = [idea for idea in (req.previous_ideas or []) if isinstance(idea, dict)]
        if prev_ideas:
            avoid_lines = []
            for idx, idea in enumerate(prev_ideas[-15:], start=1):
                title = (idea.get("title") or "").strip()
                spark = (idea.get("spark") or idea.get("logline") or "").strip()
                visual_hook = (idea.get("visual_hook") or "").strip()
                bullet_text = " / ".join([part for part in [title, spark, visual_hook] if part])
                if bullet_text:
                    avoid_lines.append(f"{idx}. {bullet_text}")
            if avoid_lines:
                avoid_block = (
                    "【已经发散过的方向（请明显避开，不要换皮重写）】\n"
                    + "\n".join(avoid_lines)
                    + "\n\n本轮5个灵感必须在主线动作、画面记忆点、空间机制、关系结构、情绪基调中至少有3点和上面任一条明显不同；"
                    "禁止只换道具名、场景名或角色站位就当作新灵感。"
                )

        prompt = f"""你是短片故事开发顾问，不是剧本作者。请基于用户要求生成5个可直接进入“生成剧本阶段”的故事灵感。

【用户要求】
{user_need}

【当前美学预设】
{style_hint}

{style_avoid_block}

{mounted_rule}

{sample_guard}

{avoid_block}

【可轻量参考的角色/IP/编剧法则】
{context}

【工作方式】
你可以吸收知识库中的角色底色、类型经验、编剧诊断概念和IP限制，但它们只是审美与结构底色，不是让你输出制作清单。灵感阶段只负责提出“故事火花/故事种子”，不是完整剧情梗概。请抓住一个奇妙机制、一个关系张力、一个画面钩子，但不要把完整解决方案、每一步行动和主题分析都写死，给剧本阶段留下创作空间。

要求：
1. 只输出纯JSON数组，不要Markdown，不要解释。
2. 必须正好5个对象，id从1到5。
3. 每个灵感都必须包含清晰的小戏剧动作雏形：主角想做什么、遇到什么具体阻碍、可能面对什么选择、关系或状态可能发生什么变化。
4. 每个灵感都要有一个“画面记忆点”：可视化奇观、道具机制、环境反应或声音/光线/物理变化。
5. 灵感之间要明显不同，不要只是换道具名、换场景名。
6. 默认适合发展成90秒左右短片：4-6个可变化的小场景或一段小旅程，而不是单一事件拉长。
7. 如果挂载了专属IP或角色库，必须使用挂载角色作为故事主体，不要违背其中的基础角色设定；但也不要复述角色卡。
8. story_input 字段要能直接粘贴到剧本阶段作为用户要求，长度控制在90-160个中文字符。写成自然的创作委托，不要像剧本大纲，不要把结尾解决动作完全写死。
9. 必须给出面向短视频内容选择的评分。分数为1-10整数，overall_score不是平均值，而是综合推荐程度。

禁止：
- 只写氛围、只写主题词、只写“发现神奇物品”。
- 在已挂载角色时发明新主角替代挂载角色。
- 输出完整剧本、场号、分镜、镜头、运镜、生成时长、@图片编号或AI提示词。
- 把知识库术语写进成品灵感，例如“激励事件、人物弧线、转折点”等诊断词。
- 使用“通过……呈现……”“制造连续小麻烦”“微型弧线”“护卫者学会……”这类分析总结腔。请写故事可能性，不要写论文式主题说明。
- 生成完全无法拍摄的抽象寓言。
- 重复或换皮上方“已经发散过的方向”里出现过的故事。

JSON格式：
[
  {{
    "id": 1,
    "title": "灵感标题",
    "genre": "类型/气质",
    "spark": "一句最像灵感火花的话，带画面感但不剧透完整解决方案",
    "logline": "一句话故事钩子",
    "visual_hook": "最有画面记忆点的视觉奇观",
    "conflict": "具体阻碍或误会",
    "emotional_turn": "关系或状态可能发生的变化",
    "hook_score": 8,
    "visual_score": 8,
    "emotion_score": 7,
    "ai_feasibility_score": 8,
    "overall_score": 8,
    "best_for": "最适合：爆款短视频/精致动画短片/角色关系小品/视觉奇观测试",
    "risk": "最大的内容或生成风险",
    "story_input": "可直接传入剧本阶段的完整用户要求"
  }}
]"""

        print(f"[灵感生成] 上下文长度: {len(context)} 字符 | 候选节点: {', '.join(n['model'] for n in nodes)}")
        raw = await safe_api_call(nodes, [{"role": "user", "content": prompt}], 0.85, max_tokens=8192)
        print(f"[灵感生成] 模型返回完成 | 原始长度: {len(raw)} 字符")
        ideas = parse_json_array_lenient(raw)
        if not isinstance(ideas, list):
            raise ValueError("AI返回的灵感不是数组")
        ideas = ideas[:5]
        for idx, idea in enumerate(ideas, start=1):
            if isinstance(idea, dict):
                idea["id"] = idx
        print(f"[灵感生成] JSON解析完成 | 灵感数量: {len(ideas)}")

        # 🌟 灵感归档：写到 outputs/_inspirations/，方便回看错过的好灵感
        archive_path = ""
        try:
            archive_dir = os.path.join(OUTPUTS_DIR, "_inspirations")
            os.makedirs(archive_dir, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            archive_path = os.path.join(archive_dir, f"inspiration_{stamp}.json")
            archive_payload = {
                "created_at": datetime.now().isoformat(),
                "ip_names": req.ip_names,
                "mounted_characters": mounted_characters,
                "user_input": req.input,
                "style_hint": req.style_hint,
                "style_avoid": req.style_avoid,
                "previous_ideas_count": len(prev_ideas),
                "ideas": ideas,
            }
            with open(archive_path, "w", encoding="utf-8") as f:
                json.dump(archive_payload, f, ensure_ascii=False, indent=2)
            print(f"[灵感生成] 已归档 → {archive_path}")
        except Exception as e:
            print(f"[灵感生成] 归档失败（不影响主流程）: {e}")

        return {
            "status": "success",
            "ideas": ideas,
            "archive_path": archive_path,
        }
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=sanitize_error_msg(str(e)))


@app.post("/director_cut_script")
async def director_cut_script(req: DirectorCutRequest):
    """剧本阶段二稿：导演剪辑。

    工作方式：
    - 复用阶段一的剧本路由（与第一稿同一个模型，确保风格一致）
    - 加载阶段一同款知识库（KB-03 + KB-13 + IP 剧本设定/角色性格）
    - 提示词聚焦在三件事：诊断第一稿最弱的地方、保留所有已成立的部分、只重写需要重写的场号
    - 流式输出，前端可直接替换 outputs[0]
    """
    script_text = (req.script or "").strip()
    if not script_text:
        raise HTTPException(status_code=400, detail="第一稿剧本为空，无法做导演剪辑。")

    route = req.routes.get("script")
    if not route or not route.key:
        raise HTTPException(status_code=400, detail="请先在系统设置中配置 [1. 剧本生成] 的模型路由 API Key。")
    nodes = get_api_nodes_for_route(route)
    if not nodes:
        raise HTTPException(status_code=400, detail="解析 API 节点失败，请检查配置。")

    print(f"\n收到导演剪辑请求 | 挂载IP: {req.ip_names} | 第一稿长度: {len(script_text)} 字符")

    # 加载阶段一知识库（与第一稿一致），确保剪辑稿不会脱离 IP 设定
    context = await load_knowledge_for_stage("script", req.ip_names)

    user_focus = (req.revision_focus or "").strip() or "由你判断哪一处最弱（通常是中段两场），只重写最弱的一到两场。"
    style_hint = (req.style_hint or "").strip()

    # 改造 4：导演画像
    profile = _resolve_director_profile(req.director_profile)
    profile_block = (
        f"【本次二稿的审美方向：{profile['label']}】\n{profile['prompt']}"
    )

    # 改造 6：强制重写场号
    force_block = _resolve_force_scene_instruction(req.force_scene)

    director_cut_prompt = f"""你现在不再是初稿编剧，而是看完第一稿之后做"导演剪辑"的资深导演。

{profile_block}

{force_block}

【你的任务】
不是从头重写，而是做一次有意识的"导演二稿"。请按以下原则操作：

1. **先在内部诊断**第一稿最弱的地方。优先检查：
   - 主题是否已被一个反向触碰过（如果第一稿没有反向触碰，必须在二稿加入）
   - 双主角中是否有过短暂角色互换（跟随者主动一次或发起者迟疑一次）
   - 中段是否存在"第二次失败/调整"的转折，还是直接顺利通向高潮（如果是后者，说明节奏太顺）
   - 是否有任何一刻让观众发出"咦？"的意外感
   - 结尾收束是否过早把所有问题都解决了

2. **保留所有已经成立的部分**：
   - 角色设定、视频风格、画面比例、IP 一致性 → 完全不动
   - 故事整体结构、场号编号 → 不动
   - 已经写得好的场号 → 完全照抄，不要为了证明自己重写过而修改
   - 道具、地标物、动作机制 → 一致
   - 第一稿原文保留至少 60% 字数（除非有强制重写指令明确要求）

3. **只重写最弱的部分**：通常是中段一到两场。重写时必须做到：
   - 至少加入两个反类型元素（意外感 / 角色互换 / 主题反触选其二）
   - 与前一场的衔接和后一场的衔接都仍然顺畅
   - 不引入新角色、新永久道具、新机制
   - 总体长度与第一稿同场号大致相当（不要刻意加长或砍短）
   - 重写部分必须明显带上方标明的"审美方向"色彩（如果是宫崎骏式就不要写得像皮克斯，反之亦然）

4. **输出导演判断（必须输出）**：在剧本正文前加一段简短的"导演剪辑笔记"，说清楚：
   - 你诊断出的最弱处是哪里、为什么最弱
   - 你重写了哪些场号、为什么重写、加了哪些反类型元素
   - 哪些部分有意保留、为什么保留
   - 本次二稿如何体现"{profile['label']}"的审美方向
   笔记控制在 200-400 字，不要写成论文。

5. **再输出完整的导演剪辑剧本**：保留第一稿的全部制式（视频风格、画面比例、剧本摘要、剧本内容、场号、道具、△、定格卡点）。不要省略未改动的场号。

【用户原始要求】
{req.original_input.strip() or "（无）"}

【风格预设】
{style_hint or "（按第一稿气质判断）"}

【用户对本次剪辑的修订重点】
{user_focus}

【可参考的角色/IP/编剧法则】
{context}

【第一稿剧本】
{script_text}

请直接输出"## 导演剪辑笔记"开头的笔记 + 完整的导演剪辑版剧本。不要解释 prompt 本身，不要写"好的我来帮你修改"这种废话。"""

    async def stream_response():
        try:
            yield "## 导演剪辑笔记\n\n> 正在做导演二稿，这一稿会先诊断第一稿最弱处，再只重写最弱的一到两场，其它部分原样保留...\n\n"
            async for chunk in stream_api_call(
                nodes,
                [{"role": "user", "content": director_cut_prompt}],
                temperature=0.55,  # 比第一稿的 0.75 低一点，避免发散过远
                max_tokens=16384,
            ):
                yield chunk
        except Exception as e:
            traceback.print_exc()
            yield f"\n\n> 导演剪辑流式输出错误：{sanitize_error_msg(str(e))}\n"

    return StreamingResponse(stream_response(), media_type="text/plain; charset=utf-8")


@app.post("/art_director_cut_visual")
async def art_director_cut_visual(req: ArtDirectorCutRequest):
    """阶段二二稿：美术指导剪辑。

    工作方式：
    - 复用阶段二的视觉路由（与第一稿同一个模型）
    - 加载阶段二同款知识库（KB-04/05/12/16 + IP 世界观/角色卡）
    - prompt 聚焦在三件事：诊断第一稿最弱的视觉决策、保留所有已成立的部分、只重写 1-2 张最弱场景卡
    - 强制带上当前美术画像 + 反类型视觉挑战
    - 流式输出，前端可直接替换 outputs[1]
    """
    visual_text = (req.visual or "").strip()
    if not visual_text:
        raise HTTPException(status_code=400, detail="第一稿固定要素库包为空，无法做美术剪辑。")

    route = req.routes.get("visual")
    if not route or not route.key:
        raise HTTPException(status_code=400, detail="请先在系统设置中配置 [2. 视觉开发] 的模型路由 API Key。")
    nodes = get_api_nodes_for_route(route)
    if not nodes:
        raise HTTPException(status_code=400, detail="解析 API 节点失败，请检查配置。")

    print(f"\n收到美术剪辑请求 | 挂载IP: {req.ip_names} | 第一稿长度: {len(visual_text)} 字符")

    # 加载阶段二同款知识库
    context = await load_knowledge_for_stage("visual", req.ip_names)

    user_focus = (req.revision_focus or "").strip() or "由你判断哪一张场景卡视觉最弱（通常是中段，或两场共用空间但缺差异锚点的那一张），只重写最弱的一到两张。"

    # 美术指导画像
    profile = _resolve_art_director_profile(req.art_director_profile)
    profile_block = (
        f"【本次美术二稿的审美方向：{profile['label']}】\n{profile['prompt']}"
    )

    # 强制重写场号
    force_block = _resolve_force_scene_instruction(req.force_scene)

    script_block = (
        f"【阶段一剧本（叙事参考）】\n{req.script.strip()}\n"
        if (req.script or "").strip()
        else "【阶段一剧本（叙事参考）】\n（用户未提供，请只依据视觉一稿做判断）\n"
    )

    cut_prompt = f"""你现在不再是一稿美术，而是看完第一稿之后做"美术剪辑"的资深美术指导。

{profile_block}

{force_block}

【你的任务】
不是从头重写，而是做一次有意识的"美术二稿"。请按以下原则操作：

1. **先在内部诊断**第一稿最弱的视觉决策。优先检查：
   - 视觉命题是否清楚、是否被反向触碰过（如果第一稿没有视觉命题或没有反向触碰，必须在二稿加入）
   - 色彩剧本是否真的有推进——连续两场的主导色是否雷同
   - 道具的情感重量是否扁平（每件道具只有"物理功能"没有"情绪角色"）
   - 同空间复用（如 S3/S4 共用 @图片）的第二张是否给了图像层面的可见差异锚点
   - 多场场景图 prompt 是否共用相同"风格头/风格尾"模板，导致最终生成图同质化
   - 多通道感官锚定（视觉/听觉/触觉/嗅觉）是否流于装饰，是否真的服务情绪
   - 是否有任何一张场景图让人发出"咦？这怎么会美？"

2. **保留所有已经成立的部分**：
   - 角色卡的极简结构、@图片1/@图片2 角色原图引用 → 完全不动
   - 场景卡数量、场号编号、@图片10-49 编号分配 → 不动
   - 已经写得好的场景卡 → 完全照抄，不要为了证明自己重写过而修改
   - 第一稿原文保留至少 60% 字数（除非有强制重写指令明确要求）

3. **只重写最弱的部分**：通常是中段一到两张场景卡或道具说明。重写时必须做到：
   - 至少加入两个反类型视觉元素（视觉惊喜 / 色彩反触 / 道具反用 选其二）
   - 与前一场和后一场的视觉/色彩衔接都仍然顺畅
   - 不引入新角色、新永久道具、新机制
   - 重写部分必须明显带上方标明的"美术方向"色彩

3-补. **诊断到必须动手修（闭环约束）**：上方第 1 步内部诊断中如果发现以下两类问题，无论是否在"最弱场景"内，都必须在二稿里实际修复，不能只在笔记里诊断却不动：
   - **风格头雷同**：如果第一稿多张场景图 prompt 共用相同的"3D 半写实梦幻动物动画，正常尺度动画电影空间，童话微缩花园视角"等 24 字开头模板，二稿必须重写全部场景图 prompt 的开篇关键词，让每场用本场最强视觉特征做开头（例如 S1 用"阳光斑驳穿草冠的光针崩解瞬间"、S2 用"水膜反光跳跃光斑的浅洼"、S3 用"明暗交界线分割画面的死灰蓝"），风格词、画幅参数、质量约束放到中后段。这条不算"重写最弱场景"配额，是质量底线。
   - **同空间复用缺差异锚点**：如果两场（如 S3/S4）共用同一张 @图片，第二张场景卡必须明确写出图像层面的可见差异锚点（光源方向、新增前景元素、远景透出新景深、地面状态改变之一），而不能只用"光线状态改变"这种文字蒙混。

4. **输出美术剪辑笔记（必须输出）**：在固定要素库正文前加一段简短的"美术剪辑笔记"，说清楚：
   - 你诊断出的最弱视觉决策是哪里、为什么最弱
   - 你重写了哪些场景卡、为什么重写、加了哪些反类型视觉元素
   - 哪些部分有意保留、为什么保留
   - 本次二稿如何体现"{profile['label']}"的审美方向
   笔记控制在 200-400 字，不要写成论文。

5. **再输出完整的美术剪辑版固定要素库包**：保留第一稿的全部制式（视觉意图总览、色彩演进表、视觉兼容性检查、角色卡、场景卡、@图片编号表、下阶段交接包）。不要省略未改动的场景卡。

【用户原始要求】
{req.original_input.strip() or "（无）"}

【用户对本次剪辑的修订重点】
{user_focus}

{script_block}

【可参考的角色/IP/视觉法则】
{context}

【第一稿固定要素库包】
{visual_text}

请直接输出"## 美术剪辑笔记"开头的笔记 + 完整的美术剪辑版固定要素库包。不要解释 prompt 本身，不要写"好的我来帮你修改"这种废话。"""

    async def stream_response():
        try:
            yield "## 美术剪辑笔记\n\n> 正在做美术二稿，这一稿会先诊断第一稿最弱视觉决策，再只重写最弱的一到两张场景卡，其它部分原样保留...\n\n"
            async for chunk in stream_api_call(
                nodes,
                [{"role": "user", "content": cut_prompt}],
                temperature=0.5,  # 比一稿低，避免发散过远
                max_tokens=16384,
            ):
                yield chunk
        except Exception as e:
            traceback.print_exc()
            yield f"\n\n> 美术剪辑流式输出错误：{sanitize_error_msg(str(e))}\n"

    return StreamingResponse(stream_response(), media_type="text/plain; charset=utf-8")


def _resolve_force_unit_instruction(force_unit: str) -> str:
    """阶段三：强制重写生成单元的指令。"""
    key = (force_unit or "auto").strip().lower()
    if key == "first":
        return (
            "【强制重写指令】本次二稿必须重写第一个生成单元（通常是 S1-U1）。"
            "理由：第一个镜头决定全片节奏锚点，对观众进入感影响最大。"
            "其它单元原则上保留，除非第一单元重写后造成衔接问题再做最小修正。"
        )
    if key == "last":
        return (
            "【强制重写指令】本次二稿必须重写最后一个生成单元（全片末镜）。"
            "理由：最后一个镜头决定情绪余味与主题落地。"
            "其它单元原则上保留，除非末单元重写后造成衔接问题再做最小修正。"
        )
    return ""


@app.post("/cinematographer_cut_shot")
async def cinematographer_cut_shot(req: CinematographerCutRequest):
    """阶段三二稿：摄影指导剪辑。

    工作方式：
    - 复用阶段三的分镜路由（与第一稿同一个模型）
    - 加载阶段三同款知识库（KB-06/07/08/11/09/12/14/15/16 + IP 角色卡/角色性格）
    - prompt 聚焦在三件事：诊断第一稿最弱的镜头决策、保留所有已成立的部分、只重写 1-2 个最弱单元
    - 强制带上当前摄影画像 + 反类型镜头挑战
    - 流式输出，前端可直接替换 outputs[2]
    """
    shot_text = (req.shot or "").strip()
    if not shot_text:
        raise HTTPException(status_code=400, detail="第一稿分镜提示词包为空，无法做摄影剪辑。")

    route = req.routes.get("shot")
    if not route or not route.key:
        raise HTTPException(status_code=400, detail="请先在系统设置中配置 [3. 分镜提示词] 的模型路由 API Key。")
    nodes = get_api_nodes_for_route(route)
    if not nodes:
        raise HTTPException(status_code=400, detail="解析 API 节点失败，请检查配置。")

    print(f"\n收到摄影剪辑请求 | 挂载IP: {req.ip_names} | 第一稿长度: {len(shot_text)} 字符")

    # 加载阶段三同款知识库
    context = await load_knowledge_for_stage("shot", req.ip_names)

    user_focus = (req.revision_focus or "").strip() or "由你判断哪一个生成单元最弱（通常是节奏拖、景别雷同、运镜机械、风格头雷同的那一个），只重写最弱的一到两个。"

    # 摄影画像
    profile = _resolve_cinematographer_profile(req.cinematographer_profile)
    profile_block = (
        f"【本次摄影二稿的审美方向：{profile['label']}】\n{profile['prompt']}"
    )

    # 强制重写单元
    force_block = _resolve_force_unit_instruction(req.force_unit)

    visual_block = (
        f"【阶段二固定要素库包（场景/角色一致性参考）】\n{req.visual.strip()}\n"
        if (req.visual or "").strip()
        else ""
    )
    script_block = (
        f"【阶段一剧本（叙事参考）】\n{req.script.strip()}\n"
        if (req.script or "").strip()
        else ""
    )

    cut_prompt = f"""你现在不再是一稿分镜，而是看完第一稿之后做"摄影剪辑"的资深摄影指导。

{profile_block}

{force_block}

【你的任务】
不是从头重写，而是做一次有意识的"摄影二稿"。请按以下原则操作：

1. **先在内部诊断**第一稿最弱的镜头决策。优先检查：
   - 镜头命题是否清楚、是否被反向触碰过（如果第一稿没有镜头命题或没有反向触碰，必须在二稿加入）
   - 同一场内连续 3-4 个生成单元是否使用了相同景别（连续中景/连续特写）→ 景别雷同
   - 7 个生成单元的完整提示词开头是否共用相同的 24 字模板（"固定中景，微仰拍，前景XX遮挡"重复出现）→ 风格头雷同
   - 7 个生成单元的完整提示词结尾是否每个都复制相同的 100 字风格尾（"3D半写实...16:9"逐字复制）→ 风格尾雷同
   - 动作时间轴是否把眼睛睁大、耳朵后压、底盘微沉、身体僵住这类微反应独立成 beat → 导演逻辑错误
   - 是否出现角色卡锚定语（玻璃球眼睛、短爪、香蕉躯干、橙白幼猫脸）污染阶段三 → 需要改写为眼睛/爪子/身体/面部
   - 是否有任何一个单元的时长（特别短或特别长）让观众发出"咦？"的节奏惊喜
   - 同一场内多个单元是否没有真正的"剪辑节奏对比"（缺长短交替/动静交替/景别跳跃）
   - 衔接状态是否真的让下一单元能接住，还是只是机械描述本单元结束姿态

2. **保留所有已经成立的部分**：
   - 场号编号、生成单元编号（S1-U1 等）→ 完全不动
   - @图片1/@图片2 角色原图引用、@图片10-49 场景图编号 → 不动
   - 已经写得好的生成单元 → 完全照抄，不要为了证明自己重写过而修改
   - 第一稿原文保留至少 60% 字数（除非有强制重写指令明确要求）

3. **只重写最弱的部分**：通常是中段一到两个生成单元。重写时必须做到：
   - 至少加入两个反类型镜头元素（节奏惊喜 / 景别反常 / 静止动态反触 选其二）
   - 与前一单元和后一单元的动作衔接都仍然顺畅
   - 不引入新角色、新永久道具、新机制
   - 重写部分必须明显带上方标明的"摄影方向"色彩

3-补. **诊断到必须动手修（闭环约束）**：上方第 1 步内部诊断中如果发现以下两类问题，无论是否在"最弱单元"内，都必须在二稿里实际修复：
   - **风格头雷同**：如果第一稿多个生成单元的完整提示词共用相同的 24 字开篇模板，二稿必须重写全部生成单元的开篇关键词，让每个单元用本单元最强的镜头特征做开头。这条不算"重写最弱单元"配额。
   - **风格尾雷同**：如果每个生成单元都逐字复制了 100 字的风格尾（"3D半写实...16:9"），二稿应在"总体导演策略"声明全片风格基线，生成单元 prompt 只写偏离基线的差异，不允许逐字重复。

3-补B. **格式回填要求（不算重写配额）**：以下两类格式问题，无论是否在"最弱单元"内，都必须在二稿里全片回填修复：
   - **时长字段一致性回填**：阶段三的 4 个时长字段（动作有效时长 / 成片时长 / 视频提交时长 / 生成时长）必须全部相等，都等于角色真实戏剧动作所需时长。如果第一稿任何单元的"动作有效时长 / 视频提交时长"字段缺失，二稿必须给全片所有单元补齐 4 个时长字段并保持相等。**禁止给视频提交时长或生成时长预先加冗余**——冗余加时（例如即梦提交时加 2 秒防截断）由用户在即梦平台自己决定，阶段三不要预判。这是格式合规底线，不算"重写最弱单元"配额。
   - **@图片编号一致性**：每个生成单元只允许使用阶段二场景卡里登记过的 @图片（主图或备选图都行），不要写阶段二没出现过的编号。如果一稿里有错位编号，二稿必须修正。
   - **生成单元编号唯一性**：每个 Sx-Uy 编号在全片只能出现一次。如果你在前面的"S4 导演剪辑总表"里简写了一个 S4-U1 的概要，正文里再写完整版的 S4-U1 时不要保留前面那个简写——简写直接删掉，避免编号重复。

3-补C. **反类型长镜头允许说明**：如果你按改造 3 的"反类型镜头挑战"主动设计了一个静止≥4 秒的反类型长镜头（例如收束场极远固定大全景、刻意凝视、安静奇观），必须在该单元的"动作时间轴"或"主动作与表演层"字段里显式写"【反类型长镜头：静止动态反触】+ 一句理由"，让后续阶段或闸门知道这是有意设计而非无意义拖沓。

4. **输出摄影剪辑笔记（必须输出）**：在分镜包正文前加一段简短的"摄影剪辑笔记"，说清楚：
   - 你诊断出的最弱镜头决策是哪里、为什么最弱
   - 你重写了哪些生成单元、为什么重写、加了哪些反类型镜头元素
   - 哪些部分有意保留、为什么保留
   - 本次二稿如何体现"{profile['label']}"的摄影方向
   笔记控制在 200-400 字，不要写成论文。

5. **再输出完整的摄影剪辑版分镜提示词包**：保留第一稿的全部制式（总体导演策略、导演剪辑总表、场景信息、生成单元字段、全片连续性检查）。不要省略未改动的生成单元。

【用户原始要求】
{req.original_input.strip() or "（无）"}

【用户对本次剪辑的修订重点】
{user_focus}

{script_block}{visual_block}

【可参考的运镜/镜头/剪辑/IP 法则】
{context}

【第一稿分镜提示词包】
{shot_text}

请直接输出"## 摄影剪辑笔记"开头的笔记 + 完整的摄影剪辑版分镜提示词包。不要解释 prompt 本身，不要写"好的我来帮你修改"这种废话。"""

    async def stream_response():
        try:
            yield "## 摄影剪辑笔记\n\n> 正在做摄影二稿，这一稿会先诊断第一稿最弱镜头决策，再只重写最弱的一到两个生成单元，其它部分原样保留...\n\n"
            async for chunk in stream_api_call(
                nodes,
                [{"role": "user", "content": cut_prompt}],
                temperature=0.5,
                max_tokens=16384,
            ):
                yield chunk
        except Exception as e:
            traceback.print_exc()
            yield f"\n\n> 摄影剪辑流式输出错误：{sanitize_error_msg(str(e))}\n"

    return StreamingResponse(stream_response(), media_type="text/plain; charset=utf-8")


@app.post("/review_script_appeal")
async def review_script_appeal(req: ScriptAppealReviewRequest):
    script_text = req.script.strip()
    if not script_text:
        raise HTTPException(status_code=400, detail="剧本文档为空，无法复盘。")

    try:
        context = await load_knowledge_for_stage("script", req.ip_names)

        def build_review_prompt(role_name: str, focus: str) -> str:
            return f"""你是{role_name}。请只从你的专业视角复盘下面的剧本，不要试图面面俱到。

【你的关注重点】
{focus}

【原始用户要求】
{req.original_input.strip() or "（无）"}

【剧本】
{script_text}

【轻量参考】
{context}

请输出中文Markdown，结构如下：
## 评分
- 本视角评分：?/10
- 建议：继续 / 小修 / 大修

## 最强看点
1-3条，必须具体到画面、动作或情绪。

## 最大风险
1-3条，必须具体指出哪里会拖慢、看不懂、不可生成或不吸引。

## 修改建议
3-5条短指令，能直接用于重写剧本。"""

        quick_prompt = f"""你是短视频内容总监、动画导演和执行制片顾问。请从“观众是否愿意看下去”和“这部短片是否能被真实项目团队稳定执行”两个角度，复盘下面的剧本。

【原始用户要求】
{req.original_input.strip() or "（无）"}

【剧本】
{script_text}

【轻量参考】
{context}

请输出中文Markdown，不要重写完整剧本。要求：

## 总分
- 观众吸引力：?/10
- 视觉记忆点：?/10
- 情绪弧线：?/10
- 制作执行可行性：?/10
- 综合建议：继续 / 小修 / 大修

## 最强看点
列出1-3条，必须具体到画面或动作。

## 最大风险
列出1-3条，优先指出会让观众滑走、看不懂、节奏变慢、生成失败的风险。

## 前3秒判断
判断第一场是否足够抓人；如果不够，给出一个更强的开场动作建议。

## 节奏与场景
指出哪一场可以压缩、哪一场需要更明确的新鲜变化。

## 情绪峰值
判断情绪峰值是否清楚、是否来得太晚、是否有可截图传播的卡点。

## 修稿指令
给出3-6条可以直接用于重新生成剧本的短指令。"""

        mode = (req.review_mode or "quick").lower()
        main_route = req.routes.get("script")

        if mode == "final":
            if not main_route or not main_route.key:
                raise HTTPException(status_code=400, detail="请先在系统设置中配置 [1. 剧本生成] 的模型路由 API Key。")
            nodes = get_api_nodes_for_route(main_route)
            if not nodes:
                raise HTTPException(status_code=400, detail="解析 API 节点失败，请检查配置。")
            final_prompt = f"""你是短视频动画项目的终稿把关人。请对下面剧本做【定稿检查】，不是常规挑刺。

你的任务：
1. 只判断它是否已经足够进入视觉开发阶段。
2. 只拦截硬伤：前3秒完全没钩子、核心规则看不懂、角色设定跑偏、情绪转折缺失、90秒节奏明显拖沓、制作执行复杂度明显失控。
3. 不要提出可有可无的审美优化，不要为了显得专业而继续找小问题。
4. 如果没有硬伤，请明确给出“通过，可进入视觉开发”，并列出最多3条后续视觉开发注意事项。
5. 如果有硬伤，请最多列出3条必须修改的问题，并给出一段可直接用于重写的短指令。

【原始用户要求】
{req.original_input.strip() or "（无）"}

【挂载IP】
{", ".join(req.ip_names) if req.ip_names else "（无）"}

【待检查剧本】
{script_text}

请用中文 Markdown 输出，结构如下：
## 定稿结论
- 结论：通过，可进入视觉开发 / 暂缓，需再修一轮
- 评分：?/10
- 是否存在硬伤：有 / 无

## 硬伤检查
只列真正会影响进入下一阶段的问题；没有就写“未发现阻断级硬伤”。

## 下一步
如果通过，给出视觉开发阶段的注意事项；如果暂缓，给出一段可直接用于重写的修稿指令。"""
            print(f"\n收到剧本定稿检查请求 | 挂载IP: {req.ip_names} | 剧本长度: {len(script_text)}")
            review = await safe_api_call(nodes, [{"role": "user", "content": final_prompt}], 0.2, max_tokens=3072)
            print(f"[剧本定稿检查] 完成 | 返回长度: {len(review)} 字符")
            return {"status": "success", "review": review}

        if mode == "quick":
            if not main_route or not main_route.key:
                raise HTTPException(status_code=400, detail="请先在系统设置中配置 [1. 剧本生成] 的模型路由 API Key！")
            nodes = get_api_nodes_for_route(main_route)
            if not nodes:
                raise HTTPException(status_code=400, detail="解析 API 节点失败，请检查配置。")
            print(f"\n收到剧本快速复盘请求 | 挂载IP: {req.ip_names} | 剧本长度: {len(script_text)}")
            review = await safe_api_call(nodes, [{"role": "user", "content": quick_prompt}], 0.35, max_tokens=4096)
            print(f"[剧本快速复盘] 完成 | 返回长度: {len(review)} 字符")
            return {"status": "success", "review": review}

        review_specs = {
            "audience": {
                "label": "中文短视频观众留存评审",
                "focus": "前3秒是否抓人；观众是否会继续看；哪里会滑走；是否有可传播的一眼画面；节奏是否拖。"
            },
            "visual": {
                "label": "视觉奇观与画面吸引力评审",
                "focus": "画面钩子是否强；奇观机制是否新鲜；场景差异是否清楚；是否有可截图传播的视觉卡点。"
            },
            "story": {
                "label": "导演编剧与情绪弧线评审",
                "focus": "主角目标、阻碍、选择、关系变化是否清楚；情绪峰值是否动人；结尾是否有余味。"
            },
            "execution": {
                "label": "执行制片与制作可行性评审",
                "focus": "以真实动画短片执行制片/现场统筹视角判断：场景数量、角色动作、道具交互、连续性、调度复杂度和制作成本是否可控；指出会让拍摄或制作断裂的地方。"
            },
        }
        mode_slots = ["audience", "story", "execution"] if mode == "three" else ["audience", "visual", "story", "execution"]

        async def run_one_review(slot: str):
            route = req.review_routes.get(slot)
            if not route or not route.key:
                return {"slot": slot, "label": review_specs[slot]["label"], "skipped": True, "text": "未配置 API Key，已跳过。"}
            nodes = get_api_nodes_for_route(route)
            if not nodes:
                return {"slot": slot, "label": review_specs[slot]["label"], "skipped": True, "text": "模型路由解析失败，已跳过。"}
            prompt = build_review_prompt(review_specs[slot]["label"], review_specs[slot]["focus"])
            print(f"[会审] 启动 {review_specs[slot]['label']} | 模型: {route.model}")
            text = await safe_api_call(nodes, [{"role": "user", "content": prompt}], 0.35, max_tokens=3072)
            return {"slot": slot, "label": review_specs[slot]["label"], "skipped": False, "text": text}

        print(f"\n收到剧本{mode}会审请求 | 挂载IP: {req.ip_names} | 剧本长度: {len(script_text)}")
        review_results = await asyncio.gather(*(run_one_review(slot) for slot in mode_slots), return_exceptions=True)

        normalized = []
        for slot, result in zip(mode_slots, review_results):
            if isinstance(result, Exception):
                normalized.append({"slot": slot, "label": review_specs[slot]["label"], "skipped": True, "text": f"评审失败：{sanitize_error_msg(str(result))}"})
            else:
                normalized.append(result)

        completed_reviews = [r for r in normalized if not r.get("skipped")]
        if not completed_reviews:
            raise HTTPException(status_code=400, detail="会审模型均未配置或调用失败，请至少配置一个评审槽位。")

        summary_route = req.review_routes.get("summary") or main_route
        if not summary_route or not summary_route.key:
            raise HTTPException(status_code=400, detail="请配置 [仲裁总结模型]，或配置 [1. 剧本生成] 作为总结回退。")
        summary_nodes = get_api_nodes_for_route(summary_route)
        if not summary_nodes:
            raise HTTPException(status_code=400, detail="仲裁总结模型路由解析失败。")

        reviews_block = "\n\n".join(
            f"## {r['label']}\n{r['text']}" for r in normalized
        )
        summary_prompt = f"""你是创作会审主持人。下面是多个模型对同一剧本的独立复盘。请综合它们，输出一份最终决策报告。

【原始用户要求】
{req.original_input.strip() or "（无）"}

【各方评审意见】
{reviews_block}

请输出中文Markdown，结构如下：
## 会审结论
- 综合建议：继续 / 小修 / 大修
- 综合评分：?/10
- 最值得保留的看点：
- 最需要立刻修的风险：

## 共识问题
列出多位评审都提到的问题。

## 分歧点
列出评审之间意见不同的地方，并说明该听谁的。

## 进入下一阶段判断
明确说明是否建议进入视觉开发；如果不建议，差哪一步。

## 可直接复制的修稿指令
给出5-8条短指令，用于重新生成或修订剧本。"""

        print(f"[会审] 启动仲裁总结 | 模型: {summary_route.model}")
        summary = await safe_api_call(summary_nodes, [{"role": "user", "content": summary_prompt}], 0.25, max_tokens=4096)
        review = f"# 剧本{('三方' if mode == 'three' else '五方')}会审报告\n\n{summary}\n\n---\n\n# 各方原始意见\n\n{reviews_block}"
        print(f"[剧本会审] 完成 | 返回长度: {len(review)} 字符")
        return {"status": "success", "review": review}
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=sanitize_error_msg(str(e)))


# ---------- 6A. 蒸馏雷达：独立 JSON 范例提取 (防截断) ----------
@app.post("/review_script_appeal_stream")
async def review_script_appeal_stream(req: ScriptAppealReviewRequest):
    script_text = (req.script or "").strip()
    if not script_text:
        raise HTTPException(status_code=400, detail="没有可复盘的剧本内容。")

    def get_route_nodes(route: RouteConfig | None, label: str):
        if not route or not route.key:
            raise HTTPException(status_code=400, detail=f"请先配置 [{label}] 的 API Key。")
        nodes = get_api_nodes_for_route(route)
        if not nodes:
            raise HTTPException(status_code=400, detail=f"[{label}] 模型路由解析失败。")
        return nodes

    review_specs = {
        "audience": {
            "label": "中文短视频观众留存评审",
            "focus": "判断前3秒是否抓人、哪里会滑走、节奏是否拖、是否有可传播的一眼画面。"
        },
        "visual": {
            "label": "视觉奇观与画面吸引力评审",
            "focus": "判断奇观机制是否新鲜清晰、画面钩子是否强、场景差异是否明确、是否有截图传播卡点。"
        },
        "story": {
            "label": "导演编剧与情绪弧线评审",
            "focus": "判断目标、阻碍、选择、关系变化、情绪峰值和结尾余味是否成立。"
        },
        "execution": {
            "label": "执行制片与制作可行性评审",
            "focus": "以真实动画短片执行制片/现场统筹视角判断：场景数量、角色动作、道具交互、连续性、调度复杂度和制作成本是否可控；指出会让拍摄或制作断裂的地方。"
        },
    }

    def build_review_prompt(label: str, focus: str) -> str:
        return f"""你是【{label}】。请从你的专业视角复盘下面剧本。

复盘重点：{focus}

请不要泛泛而谈，所有意见必须具体到画面、动作、场次或观众理解风险。

【原始用户要求】
{req.original_input.strip() or "（无）"}

【挂载IP】
{", ".join(req.ip_names) if req.ip_names else "（无）"}

【待复盘剧本】
{script_text}

请用中文 Markdown 输出：
## 评分
- 本视角评分：?/10
- 建议：继续 / 小修 / 大修

## 最强看点
列出1-3条。

## 最大风险
列出1-3条。

## 修改建议
列出3-6条可执行建议。"""

    mode = (req.review_mode or "quick").lower()
    main_route = req.routes.get("script")

    async def stream_response():
        try:
            if mode in ("quick", "final"):
                nodes = get_route_nodes(main_route, "1. 剧本生成")
                if mode == "final":
                    prompt = f"""你是短视频动画项目的终稿把关人。请对下面剧本做【定稿检查】，不是常规挑刺。

只拦截硬伤：前3秒完全没钩子、核心规则看不懂、角色设定跑偏、情绪转折缺失、90秒节奏明显拖沓、制作执行复杂度明显失控。
如果没有硬伤，请明确给出“通过，可进入视觉开发”。不要为了显得专业而继续找小问题。

【原始用户要求】
{req.original_input.strip() or "（无）"}

【挂载IP】
{", ".join(req.ip_names) if req.ip_names else "（无）"}

【待检查剧本】
{script_text}

请用中文 Markdown 输出：
## 定稿结论
- 结论：通过，可进入视觉开发 / 暂缓，需再修一轮
- 评分：?/10
- 是否存在硬伤：有 / 无

## 硬伤检查
只列真正会影响进入下一阶段的问题；没有就写“未发现阻断级硬伤”。

## 下一步
如果通过，给出视觉开发阶段注意事项；如果暂缓，给出一段可直接用于重写的修稿指令。"""
                    yield "> 正在启动定稿检查模型...\n\n"
                    async for chunk in stream_api_call(nodes, [{"role": "user", "content": prompt}], 0.2, max_tokens=3072):
                        yield chunk
                else:
                    prompt = build_review_prompt(
                        "剧本快速复盘评审",
                        "用一个综合视角快速判断吸引力、节奏、情绪弧线和制作执行风险；以真正要完成一部短片的项目总监视角判断，不要只围绕AI工具限制。"
                    )
                    yield "> 正在启动快速复盘模型...\n\n"
                    async for chunk in stream_api_call(nodes, [{"role": "user", "content": prompt}], 0.35, max_tokens=4096):
                        yield chunk
                return

            mode_slots = ["audience", "story", "execution"] if mode == "three" else ["audience", "visual", "story", "execution"]
            title = "三方" if mode == "three" else "五方"
            yield f"# 剧本{title}会审报告\n\n> 会审已启动，评审模型会并行工作；哪个先完成就先显示哪个。\n\n"

            async def run_one_review(slot: str):
                spec = review_specs[slot]
                route = req.review_routes.get(slot)
                if not route or not route.key:
                    return {"slot": slot, "label": spec["label"], "skipped": True, "text": "未配置 API Key，已跳过。"}
                nodes = get_api_nodes_for_route(route)
                if not nodes:
                    return {"slot": slot, "label": spec["label"], "skipped": True, "text": "模型路由解析失败，已跳过。"}
                text = await safe_api_call(nodes, [{"role": "user", "content": build_review_prompt(spec["label"], spec["focus"])}], 0.35, max_tokens=3072)
                return {"slot": slot, "label": spec["label"], "skipped": False, "text": text}

            tasks = [asyncio.create_task(run_one_review(slot)) for slot in mode_slots]
            normalized = []
            for task in asyncio.as_completed(tasks):
                try:
                    result = await task
                except Exception as e:
                    result = {"slot": "unknown", "label": "评审模型", "skipped": True, "text": f"评审失败：{sanitize_error_msg(str(e))}"}
                normalized.append(result)
                yield f"\n\n---\n\n## {result['label']}\n\n{result['text']}\n\n"

            completed_reviews = [r for r in normalized if not r.get("skipped")]
            if not completed_reviews:
                yield "\n\n> 会审模型均未成功返回，请检查会审模型配置。\n"
                return

            summary_route = req.review_routes.get("summary") or main_route
            summary_nodes = get_route_nodes(summary_route, "仲裁总结模型")
            reviews_block = "\n\n".join(f"## {r['label']}\n{r['text']}" for r in normalized)
            summary_prompt = f"""你是创作会审主持人。下面是多个模型对同一剧本的独立复盘，请综合它们，输出最终决策报告。

【原始用户要求】
{req.original_input.strip() or "（无）"}

【各方评审意见】
{reviews_block}

请用中文 Markdown 输出：
## 会审结论
- 综合建议：继续 / 小修 / 大修
- 综合评分：?/10
- 最值得保留的看点：
- 最需要立刻修的风险：

## 共识问题
列出多位评审都提到的问题。

## 分歧点
列出评审之间意见不同的地方，并说明该听谁的。

## 进入下一阶段判断
明确说明是否建议进入视觉开发；如果不建议，差哪一步。

## 可直接复制的修稿指令
给出5-8条短指令，用于重新生成或修订剧本。"""

            yield "\n\n---\n\n# 仲裁总结\n\n> 正在启动仲裁总结模型，下面会流式输出最终结论...\n\n"
            async for chunk in stream_api_call(summary_nodes, [{"role": "user", "content": summary_prompt}], 0.25, max_tokens=4096):
                yield chunk
        except Exception as e:
            traceback.print_exc()
            yield f"\n\n> 会审流式输出错误：{sanitize_error_msg(str(e))}\n"

    return StreamingResponse(stream_response(), media_type="text/plain; charset=utf-8")


@app.post("/review_stage_stream")
async def review_stage_stream(req: StageReviewRequest):
    stage = (req.stage or "script").strip()
    content = (req.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="没有可会审的当前阶段内容。")

    stage_names = {
        "script": "剧本",
        "visual": "视觉开发",
        "shot": "分镜提示词",
        "image": "场景图生图清单",
        "prompt": "视觉开发",
    }
    stage_name = stage_names.get(stage, stage)

    def get_route_nodes(route: RouteConfig | None, label: str):
        if not route or not route.key:
            raise HTTPException(status_code=400, detail=f"请先配置 [{label}] 的 API Key。")
        nodes = get_api_nodes_for_route(route)
        if not nodes:
            raise HTTPException(status_code=400, detail=f"[{label}] 模型路由解析失败。")
        return nodes

    def stage_review_specs(current_stage: str):
        if current_stage == "visual":
            return {
                "audience": {
                    "label": "观众识别与传播图像评审",
                    "focus": "以真实短片观众和宣发视角判断：角色、场景、关键道具是否一眼能记住；是否有清晰截图传播点；视觉锚点是否服务故事情绪。"
                },
                "visual": {
                    "label": "美术指导评审",
                    "focus": "以动画美术指导视角判断：角色、场景、道具、色彩、材质、光线、主体背景分离和视觉风格是否统一成体系。"
                },
                "story": {
                    "label": "角色与世界观连续性评审",
                    "focus": "以导演和设定统筹视角判断：视觉开发是否忠于剧本；角色是否发明多余身体细节；道具状态、场景关系和情绪峰值是否连续。"
                },
                "execution": {
                    "label": "场景设计与制作可行性评审",
                    "focus": "以执行制片和场景设计统筹视角判断：场景卡是否能指导后续分镜；场景图提示词是否可复制可执行；中文/英文平台要求是否清楚；参考图编号是否合理。"
                },
            }
        if current_stage == "shot":
            return {
                "audience": {
                    "label": "短视频节奏评审",
                    "focus": "以短视频内容总监视角判断：前3秒、10秒、30秒是否有留存点；中段是否重复；结尾是否有可记忆余味。"
                },
                "visual": {
                    "label": "摄影画面评审",
                    "focus": "以摄影指导视角判断：景别、构图、机位、光影、空间方向和画面变化是否清楚；是否存在过度运镜或画面重复。"
                },
                "story": {
                    "label": "导演分镜评审",
                    "focus": "以导演视角判断：镜头是否服务故事和情绪；每个生成单元是否有动作推进、因果承接和角色状态变化。"
                },
                "execution": {
                    "label": "制作连续性评审",
                    "focus": "以场记和执行制片视角判断：场景顺序、角色位置、道具状态、光线、水面/盾牌/种子等关键连续性是否断裂。"
                },
            }
        if current_stage == "image":
            return {
                "audience": {
                    "label": "场景图传播力评审",
                    "focus": "以短视频封面和截图传播视角判断：场景图是否一眼能建立地点记忆、空间奇观和情绪底色，是否适合作为即梦视频参考。"
                },
                "visual": {
                    "label": "生图美术指导评审",
                    "focus": "以美术指导视角判断：每条静态图 prompt 是否能稳定锁定角色、场景、材质、光线、构图和画幅，是否避免画风漂移。"
                },
                "story": {
                    "label": "场景连续性评审",
                    "focus": "以导演和分镜统筹视角判断：场景图是否覆盖所有真实场景，@图片10-49 编号是否与阶段二场景卡一致，是否没有混入角色或额外生物。"
                },
                "execution": {
                    "label": "图片 API 执行评审",
                    "focus": "以执行制片和生成管线视角判断：每条空场景请求是否适合无状态按次图片 API；尺寸、画幅、负面约束是否清楚；是否避免关键帧、首尾帧和 @图片50+。"
                },
            }
        return {
            "audience": {
                "label": "中文短视频观众留存评审",
                "focus": "判断前3秒是否抓人、哪里会滑走、节奏是否拖、是否有可传播的一眼画面。"
            },
            "visual": {
                "label": "视觉奇观与画面吸引力评审",
                "focus": "判断奇观机制是否新鲜清晰、画面钩子是否强、场景差异是否明确、是否有截图传播卡点。"
            },
            "story": {
                "label": "导演编剧与情绪弧线评审",
                "focus": "判断目标、阻碍、选择、关系变化、情绪峰值和结尾余味是否成立。"
            },
            "execution": {
                "label": "执行制片与制作可行性评审",
                "focus": "以真实动画短片执行制片/现场统筹视角判断：场景数量、角色动作、道具交互、连续性、调度复杂度和制作成本是否可控。"
            },
        }

    specs = stage_review_specs(stage)

    def build_prompt(label: str, focus: str, final: bool = False) -> str:
        final_rule = (
            "这是定稿检查，不是常规挑刺。只拦截会阻止进入下一阶段的硬伤；没有硬伤就明确写“通过”。"
            if final else
            "请不要泛泛而谈，所有意见必须具体到文本中的段落、场景、角色、道具、镜头或提示词字段。"
        )
        return f"""你是【{label}】。请以真实动画短片项目岗位身份，对当前【{stage_name}】阶段产出做专业会审。

【评审原则】
{final_rule}
优先按真实导演、美术、摄影、剪辑、制片工作流判断，不要被 AI 工具限制牵引。只有当某个设计会明显导致后续制作或生成失败时，才提出技术风险。

【你的关注重点】
{focus}

【原始用户要求】
{req.original_input.strip() or "（无）"}

【前置阶段内容】
{req.previous_content.strip() or "（无）"}

【当前阶段产出】
{content}

请用中文 Markdown 输出：
## 结论
- 本视角评分：?/10
- 建议：通过 / 小修 / 大修

## 最值得保留
列出1-3条，必须具体到可见画面、设计字段、动作或镜头。

## 阻断风险
只列真实会影响进入下一阶段的问题；如果没有，写“未发现阻断级问题”。

## 修改建议
给出3-6条可执行短指令。"""

    mode = (req.review_mode or "quick").lower()
    main_route = req.routes.get(stage)
    if stage == "prompt":
        main_route = req.routes.get("visual")

    async def stream_response():
        try:
            if mode in ("quick", "final"):
                nodes = get_route_nodes(main_route, f"{stage_name}主线模型")
                label = f"{stage_name}快速检查" if mode == "quick" else f"{stage_name}定稿检查"
                focus = (
                    "快速判断当前阶段是否能进入下一步：价值是否清楚、结构是否完整、制作是否可执行、最需要修的硬伤是什么。"
                    if mode == "quick" else
                    "只判断是否已经足够进入下一阶段；不继续做可有可无的审美优化。"
                )
                yield f"> 正在启动{label}模型...\n\n"
                async for chunk in stream_api_call(
                    nodes,
                    [{"role": "user", "content": build_prompt(label, focus, final=(mode == "final"))}],
                    0.25 if mode == "final" else 0.35,
                    max_tokens=4096,
                ):
                    yield chunk
                return

            slots = ["audience", "visual", "story", "execution"]
            yield f"# {stage_name}多方会审报告\n\n> 会审已启动：同一套会审 API 槽位会根据当前阶段切换岗位身份；评审模型并行工作，哪个先完成就先显示哪个。\n\n"

            async def run_one(slot: str):
                spec = specs[slot]
                route = req.review_routes.get(slot)
                if not route or not route.key:
                    return {"slot": slot, "label": spec["label"], "skipped": True, "text": "未配置 API Key，已跳过。"}
                nodes = get_api_nodes_for_route(route)
                if not nodes:
                    return {"slot": slot, "label": spec["label"], "skipped": True, "text": "模型路由解析失败，已跳过。"}
                text = await safe_api_call(nodes, [{"role": "user", "content": build_prompt(spec["label"], spec["focus"])}], 0.35, max_tokens=3072)
                return {"slot": slot, "label": spec["label"], "skipped": False, "text": text}

            tasks = [asyncio.create_task(run_one(slot)) for slot in slots]
            normalized = []
            for task in asyncio.as_completed(tasks):
                try:
                    result = await task
                except Exception as e:
                    result = {"slot": "unknown", "label": "评审模型", "skipped": True, "text": f"评审失败：{sanitize_error_msg(str(e))}"}
                normalized.append(result)
                yield f"\n\n---\n\n## {result['label']}\n\n{result['text']}\n\n"

            completed = [r for r in normalized if not r.get("skipped")]
            if not completed:
                yield "\n\n> 会审模型均未成功返回，请检查会审模型配置。\n"
                return

            summary_route = req.review_routes.get("summary") or main_route
            summary_nodes = get_route_nodes(summary_route, "仲裁总结模型")
            reviews_block = "\n\n".join(f"## {r['label']}\n{r['text']}" for r in normalized)
            summary_prompt = f"""你是【{stage_name}会审主持人】。下面是多个真实项目岗位对同一阶段产出的独立意见。请综合它们，输出最终决策。

【原始用户要求】
{req.original_input.strip() or "（无）"}

【前置阶段内容】
{req.previous_content.strip() or "（无）"}

【各方意见】
{reviews_block}

请用中文 Markdown 输出：
## 会审结论
- 综合建议：通过 / 小修 / 大修
- 综合评分：?/10
- 最值得保留：
- 最需要立刻修：

## 共识问题
列出多方都提到的问题。

## 分歧点
列出意见不同之处，并明确该听谁的。

## 进入下一阶段判断
明确说明是否建议进入下一阶段，以及差哪一步。

## 可直接复制的修稿指令
给出5-8条短指令，用于重写或修订当前阶段产出。"""

            yield "\n\n---\n\n# 仲裁总结\n\n> 正在启动仲裁总结模型，下面会流式输出最终结论...\n\n"
            async for chunk in stream_api_call(summary_nodes, [{"role": "user", "content": summary_prompt}], 0.25, max_tokens=4096):
                yield chunk
        except Exception as e:
            traceback.print_exc()
            yield f"\n\n> 阶段会审流式输出错误：{sanitize_error_msg(str(e))}\n"

    return StreamingResponse(stream_response(), media_type="text/plain; charset=utf-8")


@app.post("/extract_json_example")
async def extract_json_example_endpoint(req: WashExampleRequest):
    try:
        route = req.routes.get("jimeng")
        if not route or not route.key:
            raise ValueError("请先在系统设置中配置 [数据提炼] 引擎的 API 选项！")
        nodes = get_api_nodes_for_route(route)
        if not nodes:
            raise ValueError("未提供有效的 API Key")

        wash_prompt = f"""你是一个高级的「影视数据结构化工程师」。
请阅读以下【视频详细拉片描述】，逆向还原为标准的 5 字段场景空镜（Clean Plate）JSON 格式！

【视频拉片描述】：
{req.raw_text}

要求：
1. 必须输出纯JSON数组格式 [ {{...}} ]，绝不解释！
2. 提炼时【绝对屏蔽】拉片描述中的角色动作与生物，只提炼环境、光影、遮挡物与舞台空间！
3. image_strategy 必须从 ["generate_new_image", "use_tail_frame"] 选一。
4. image_prompt 必须按照空场景框架白描（可读动画电影场景空间 + 角色高度观察点或斜俯拍/俯拍空间交代视角 + 少量前景遮挡 + 中景表演留白 + 可读远景风景 + 光影材质；香蕉猫/刀盾狗可使用童话微缩花园尺度）。
5. negative_prompt 必须包含排除角色的词汇。
6. 不要把参考视频误读成显微镜/微距局部素材；如果原文或IP是香蕉猫/刀盾狗、小生命面对大世界、巨物比例，则保留童话微缩花园尺度，但背景风景必须可读。

======================================
【最高系统防漏指令：强制 JSON 骨架】
你输出的 JSON 数组中的每一个对象，都必须完全包含以下 5 个 Key！
{{
  "fragment_id": "如：生成单元一",
  "image_strategy": "generate_new_image",
  "source_fragment_id": "",
  "image_prompt": "可读3D动画电影空场景，角色高度观察或斜俯拍空间交代，前景少量草叶自然虚化，中景留白，远景森林和光束可读...",
  "negative_prompt": "any characters, animals, humans, cats, dogs, macro photography, miniature world, extreme shallow depth of field..."
}}
"""
        print(f"\n正在独立执行 JSON 镜头范例提取...")
        raw_json_str = await safe_api_call(nodes, [{"role": "user", "content": wash_prompt}], 0.2, max_tokens=8192)

        # 清洗 JSON
        json_content = raw_json_str.strip()
        if "```json" in json_content:
            json_content = json_content.split("```json")[1].split("```")[0].strip()
        elif "```" in json_content:
            json_content = json_content.split("```")[1].split("```")[0].strip()

        json_match = re.search(r'\[\s*\{.*\}\s*\]', json_content, re.DOTALL)
        if json_match:
            json_content = json_match.group(0)

        try:
            parsed_json = json.loads(json_content)
        except json.JSONDecodeError:
            # 使用末端抢救机制修复半截JSON
            last_complete = json_content.rfind('},')
            if last_complete > 0:
                truncated = json_content[:last_complete + 1] + ']'
                try:
                    parsed_json = json.loads(truncated)
                    print("[JSON修复] 已成功抢救截断的JSON。")
                except:
                    parsed_json = [{"error": "无法修复的JSON截断", "raw": json_content[:200]}]
            else:
                parsed_json = [{"error": "AI返回非标准JSON", "raw": json_content[:200]}]

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # 按 image_strategy 分目录存盘
        try:
            strategies_found = set(s.get("image_strategy", "unknown") for s in parsed_json)
            for strategy in strategies_found:
                strategy_name = _safe_name_segment(str(strategy), "unknown")
                strategy_dir = _safe_join_under(EX_CORE_DIR, strategy_name)
                os.makedirs(strategy_dir, exist_ok=True)
                filtered = [s for s in parsed_json if s.get("image_strategy") == strategy]
                if filtered:
                    filepath = _safe_join_under(strategy_dir, f"example_{timestamp}.json")
                    with open(filepath, "w", encoding="utf-8") as f:
                        json.dump(filtered, f, ensure_ascii=False, indent=2)
        except Exception as e:
            with open(_safe_join_under(EX_CORE_DIR, f"example_washed_{timestamp}.json"), "w", encoding="utf-8") as f:
                f.write(json_content)

        return {
            "status": "success",
            "message": "JSON 范例提取并存档成功！",
            "json_content": parsed_json
        }
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

# ---------- 6B. 蒸馏雷达：独立知识库法则提炼 (三轨并发) ----------
@app.post("/distill_knowledge")
async def distill_knowledge_endpoint(req: WashExampleRequest):
    try:
        route = req.routes.get("jimeng")
        if not route or not route.key:
            raise ValueError("请先在系统设置中配置 [数据提炼] 引擎的 API 选项！")
        nodes = get_api_nodes_for_route(route)
        if not nodes:
            raise ValueError("未提供有效的 API Key")

        # Track 2: 视觉执行法则
        distill_prompt = f"""你是一位顶级的电影学院导演系教授与后期剪辑指导。请阅读以下【视频详细拉片描述】，忽略具体的角色名称和剧情细节，提炼出底层的【视觉执行层】影视创作规律，包含四维度：1.动势衔接与转场法则 2.Q弹近景物理与触感法则 3.治愈系拟音与听觉法则 4.景别节奏法则。\n\n【视频描述】：\n{req.raw_text}"""

        # Track 3: 美学风格
        style_prompt = f"""你是一位负责影视知识库整理的内容工程师。请阅读以下【视频详细拉片描述】，从中提炼出至少2条核心的美学法则。格式要求：\n#### 法则：[法则名称]\n[核心描述]\n正向参数：[英文提示词]\n视频模型光影描述参考：「[中文光影描述]」\n\n【视频描述】：\n{req.raw_text}"""

        # Track 4: 叙事法则
        narrative_prompt = f"""你是一位电影编剧教授。阅读以下【视频详细拉片描述】，提炼【叙事层】创作规律。包含四条法则：1.四幕情绪节拍分布规律 2.场景间因果连接模式 3.软冲突与角色合奏逻辑 4.尺度环境驱动规律。每条法则必须带「Stage 1编剧应用示例」。\n\n【视频描述】：\n{req.raw_text}"""

        print(f"\n正在并发提炼三大导演知识库 (视觉|美学|叙事)...")

        tasks = [
            safe_api_call(nodes, [{"role": "user", "content": distill_prompt}], 0.5, max_tokens=4096),
            safe_api_call(nodes, [{"role": "user", "content": style_prompt}], 0.3, max_tokens=4096),
            safe_api_call(nodes, [{"role": "user", "content": narrative_prompt}], 0.5, max_tokens=4096),
        ]

        results = await asyncio.gather(*tasks, return_exceptions=True)

        distill_content   = results[0] if not isinstance(results[0], Exception) else None
        style_content     = results[1] if not isinstance(results[1], Exception) else None
        narrative_content = results[2] if not isinstance(results[2], Exception) else None

        friendly_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        success_tracks = []

        if distill_content:
            kb_distill_path = os.path.join(KB_DISTILLED_DIR, "auto_视觉执行法则.md")
            valid = await check_and_deduplicate_kb(kb_distill_path, distill_content, nodes)
            if valid:
                with open(kb_distill_path, "a", encoding="utf-8") as kf:
                    kf.write(f"\n\n### 自动提取 ({friendly_time})\n{valid.strip()}\n")
                trim_kb_file_if_needed(kb_distill_path)
            success_tracks.append("视觉执行")

        if style_content:
            kb_style_path = os.path.join(KB_DISTILLED_DIR, "auto_视觉美学法则.md")
            valid = await check_and_deduplicate_kb(kb_style_path, style_content, nodes)
            if valid:
                with open(kb_style_path, "a", encoding="utf-8") as sf:
                    sf.write(f"\n\n### 自动提取 ({friendly_time})\n{valid.strip()}\n")
                trim_kb_file_if_needed(kb_style_path)
            success_tracks.append("视觉美学")

        if narrative_content:
            kb_narrative_path = os.path.join(KB_DISTILLED_DIR, "auto_叙事节拍法则.md")
            valid = await check_and_deduplicate_kb(kb_narrative_path, narrative_content, nodes)
            if valid:
                with open(kb_narrative_path, "a", encoding="utf-8") as nf:
                    nf.write(f"\n\n### 自动提取 ({friendly_time})\n{valid.strip()}\n")
                trim_kb_file_if_needed(kb_narrative_path)
            success_tracks.append("叙事节拍")

        if not success_tracks:
            raise HTTPException(status_code=500, detail="所有提炼任务均失败，请检查模型节点。")

        return {
            "status": "success",
            "message": f"提炼部分完成！已成功更新：{', '.join(success_tracks)}",
            "tracks": {"visual": distill_content, "aesthetic": style_content, "narrative": narrative_content},
        }
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ---------- 7. 专属 IP 圣经提取引擎 ----------
@app.post("/extract_ip_bible")
async def extract_ip_bible_endpoint(req: WashExampleRequest):
    try:
        route = req.routes.get("jimeng")
        if not route or not route.key:
            raise ValueError("请先在系统设置中配置 [数据提炼] 引擎的 API 选项！")
        nodes = get_api_nodes_for_route(route)
        if not nodes:
            raise ValueError("未提供有效的 API Key")

        print(f"\n正在为 [{req.ip_name}] 极速并发提取 IP 圣经 V3.0...")

        p1 = f"""你是一位3D角色建模师。请逐帧分析以下视频中的角色，严格按模板填空，禁止使用任何形容词或情绪描述词：\n【身体比例】- 头身比(数字)：- 四肢长度与躯干比例(数字)：- 躯干形状(几何体)：- 与环境物体的尺度对比：\n【材质规格】- 皮肤材质：- SSS次表面散射：- 表面纹理特征：\n【颜色数据】- 主体色：- 次要色：- 高光表现：\n【固定附属物】- 携带配件及材质：- 全片是否主动使用过：\n【尺度世界观】- 环境物体类型：- 角色体型所属量级：- 是否有人造室内场景：\n【视频描述】\n{req.raw_text}"""

        p2 = f"""你是一位影视动作指导。请分析视频中角色的运动规律，严格使用大白话回答：\n【基础步态】- 走路的样子（如：摇摇晃晃/高频小碎步）：- 跌倒后的第一反应：- 倒下时的姿态：\n【情绪动作规律】- 惊吓时的动作：- 试探时的动作：\n【禁止动作清单】(逐一回答是否出现过)- 四肢着地爬行：- 像武林高手一样精准跳跃：- 发出攻击性踢打：- 拟人化手势：\n【视频描述】\n{req.raw_text}"""

        p3 = f"""你是一位叙事结构分析师。建立角色决策树与定位：\n【第一部分：行为决策树】(用遇到X→做Y格式)\n1.遇到未知新奇：2.遇到危险惊吓(身体反应)：3.与同伴主动物理行为：4.独处默认状态：5.目标丢失时：6.遇到柔软物体时：\n【第二部分：叙事功能定位】\n- 谁第一个接触未知区域：- 谁的行为导致他人被迫反应：- 该角色空间位置：- 他人是否因其改变行动：\n【第三部分：角色合奏动态】\n- 角色间行为触发关系：- 是否主动保护过他人：- 沟通方式：- 危机中扮演角色：\n【视频描述】\n{req.raw_text}"""

        print("物理规格、运动物理、叙事逻辑任务已同步触发，跨节点加速推理中...")
        t1 = safe_api_call(nodes, [{"role": "user", "content": p1}], 0.1, max_tokens=4096)
        t2 = safe_api_call(nodes, [{"role": "user", "content": p2}], 0.1, max_tokens=4096)
        t3 = safe_api_call(nodes, [{"role": "user", "content": p3}], 0.2, max_tokens=4096)

        results = await asyncio.gather(t1, t2, t3)
        d1, d2, d3 = results[0], results[1], results[2]

        p4 = f"""以下是对同一角色从三个角度进行的分析原始数据：\n【物理规格数据】\n{d1}\n【运动物理数据】\n{d2}\n【叙事功能与角色关系数据】\n{d3}\n\n请将以上三份数据整合为一份【{req.ip_name}角色圣经 V3.0】，严格按以下三层结构输出：\n---\n【第一层：叙事与关系编排（供Stage 1调用）】\n- 戏剧功能定义（一句话：这个角色是___，它在故事中负责___）：\n- 叙事触发规则（永远是___的发起者，而非___）：\n- 多角色合奏动态（做X → 他人被迫做Y）：\n- 空间位置规则：\n- 绝对禁止项（叙事）：\n\n【第二层：物理硬约束（供Stage 2/3调用，OOC判定标准）】
请严格按以下编号格式输出每一条约束，编号格式为 HC-01, HC-02...（HC = Hard Constraint）：

HC-01 · 几何比例：[正向提示词，直接适用MJ/Kling]
HC-02 · 材质规格：[正向提示词，直接适用MJ/Kling]
HC-03 · 永久附属物：[正向提示词]
HC-04 · 尺度世界观合法场景：[合法场景池描述]
HC-05 · 尺度世界观禁止场景：[禁止场景描述]
HC-06 · 绝对禁止动作（--no参数）：[除拉片提取项外，必须强制包含：anthropomorphic exaggerated expressions, cartoonish morphing]

【第三层：物理软性倾向（供Stage 4调用）】
请严格按以下编号格式输出，编号格式为 ST-01, ST-02...（ST = Soft Tendency）：

ST-01 · 基础移动逻辑：[动态提示词]
ST-02 · 腾空与弹跳逻辑：[明确区分笨拙驱动vs精准跳跃]
ST-03 · 环境交互模式：[前肢使用规则]
ST-04 · 受击与失衡反应：[倒下形态的物理描述]
ST-05 · 情绪面部联动：[触发条件+动物口腔结构约束]---\n【一致性检查清单（Stage 4质检专用，10个是/否问题）】\n前7题检查物理，8题尺度，9题运动，10题叙事。(每题必须是通过观察画面直接回答的是/否题)\n---\n要求：删除含糊形容词(可爱/治愈)，用物理描述替代；正负向规则必须能直接拷贝进AI工具。"""

        print("正在拼装完整版 IP 圣经...")
        bible_content = await safe_api_call(nodes, [{"role": "user", "content": p4}], 0.3, max_tokens=8192)

        safe_ip_name = _safe_name_segment(req.ip_name, "ip")
        ip_dir = _safe_join_under(KB_IP_DIR, safe_ip_name)
        os.makedirs(ip_dir, exist_ok=True)

        bible_filename = f"{safe_ip_name}角色圣经.md"
        with open(_safe_join_under(ip_dir, bible_filename), "w", encoding="utf-8") as f:
            f.write(f"# {req.ip_name} 角色圣经 V3.0\n\n" + bible_content)

        return {
            "status": "success",
            "message": f"角色圣经提炼完成！已自动建立宇宙档案：knowledge/ip/{safe_ip_name}/{bible_filename}",
            "bible_content": bible_content
        }

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ---------- 8. @图片库管理系统 (image_registry) ----------
IMAGE_REGISTRY_PATH = os.path.join(BASE_DIR, "image_registry.json")

def _load_image_registry() -> dict:
    if os.path.exists(IMAGE_REGISTRY_PATH):
        try:
            with open(IMAGE_REGISTRY_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    # 默认结构: 按 V2 规范预留分段
    return {"images": {}, "next_id": 1}

def _save_image_registry(reg: dict):
    os.makedirs(os.path.dirname(IMAGE_REGISTRY_PATH), exist_ok=True)
    with open(IMAGE_REGISTRY_PATH, "w", encoding="utf-8") as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)


class ImageEntry(BaseModel):
    id: int
    description: str = ""
    category: str = "character"  # character / scene / pose
    ip_name: str = ""
    status: str = "registered"  # registered / generated

class RegisterImageRequest(BaseModel):
    description: str
    category: str = "character"  # character / scene / pose
    ip_name: str = ""
    img_id: Optional[int] = None
    run_id: str = ""


def _image_id_segment(category: str) -> tuple[int, int]:
    return {
        "character": (1, 9),
        "scene": (10, 49),
        "pose": (50, 99),
    }.get(category, (100, 999))


def _registry_entry_id(key: str, entry: dict) -> int:
    raw = entry.get("id")
    if isinstance(raw, int):
        return raw
    text = str(raw or key).split("::")[-1]
    return int(text) if text.isdigit() else 9999


def _registry_key_for(img_id: int, run_id: str = "") -> str:
    safe = _safe_run_id(run_id)
    return f"{safe}::{img_id}" if safe else str(img_id)


def _registry_entry_matches_run(entry: dict, run_id: str = "") -> bool:
    safe = _safe_run_id(run_id)
    if not safe:
        return True
    return _safe_run_id(entry.get("run_id", "")) == safe


def _iter_registry_entries(reg: dict, run_id: str = ""):
    entries = [
        (key, entry)
        for key, entry in reg.get("images", {}).items()
        if _registry_entry_matches_run(entry, run_id)
    ]
    return sorted(
        entries,
        key=lambda kv: (_safe_run_id(kv[1].get("run_id", "")), _registry_entry_id(kv[0], kv[1]), kv[0])
    )


def _get_registry_entry(reg: dict, img_id: int, run_id: str = "") -> dict | None:
    scoped_key = _registry_key_for(img_id, run_id)
    entry = reg.get("images", {}).get(scoped_key)
    if entry and _registry_entry_matches_run(entry, run_id):
        return entry
    for _, candidate in _iter_registry_entries(reg, run_id):
        if _registry_entry_id(str(img_id), candidate) == img_id:
            return candidate
    if not run_id:
        return reg.get("images", {}).get(str(img_id))
    return None


def _scoped_registry_images(reg: dict, run_id: str = "") -> dict:
    return {
        str(_registry_entry_id(key, entry)): entry
        for key, entry in _iter_registry_entries(reg, run_id)
    }


def _allocate_image_id(reg: dict, category: str, desired_id: int | None = None, run_id: str = "") -> int:
    seg_start, seg_end = _image_id_segment(category)
    if desired_id is not None:
        if desired_id < seg_start or desired_id > seg_end:
            raise HTTPException(status_code=400, detail=f"@图片{desired_id} 不在 {category} 编号段 {seg_start}-{seg_end} 内。")
        return desired_id

    existing = {_registry_entry_id(key, entry) for key, entry in _iter_registry_entries(reg, run_id)}
    usable = [n for n in range(seg_start, seg_end + 1) if n not in existing]
    if usable:
        return usable[0]
    return int(reg.get("next_id", seg_end + 1))


def _safe_asset_filename(name: str) -> str:
    stem, ext = os.path.splitext(name or "")
    ext = ext.lower() if ext.lower() in [".png", ".jpg", ".jpeg", ".webp"] else ".png"
    safe_stem = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_\-]+", "_", stem).strip("_")[:40] or "asset"
    return f"{safe_stem}{ext}"


def _load_reference_assets(image_ids: list[int], run_id: str = "") -> list[dict]:
    reg = _load_image_registry()
    assets = []
    for img_id in image_ids or []:
        entry = _get_registry_entry(reg, img_id, run_id)
        if not entry:
            continue
        filepath = entry.get("path") or ""
        if not filepath or not os.path.exists(filepath):
            continue
        try:
            with open(filepath, "rb") as f:
                raw = f.read()
            if len(raw) > 15 * 1024 * 1024:
                continue
            ext = os.path.splitext(filepath)[1].lower()
            mime = {
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".webp": "image/webp",
                ".png": "image/png",
            }.get(ext, "image/png")
            assets.append({
                "id": img_id,
                "label": f"@图片{img_id}",
                "description": entry.get("description", ""),
                "category": entry.get("category", ""),
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "mime": mime,
                "image": f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}",
            })
        except Exception:
            continue
    return assets


def _category_for_image_id(img_id: int) -> str:
    if 1 <= img_id <= 9:
        return "character"
    if 10 <= img_id <= 49:
        return "scene"
    if 50 <= img_id <= 99:
        return "pose"
    return "other"


def _register_generated_asset(
    img_id: int,
    filepath: str,
    public_url: str,
    description: str = "",
    category: str = "",
    run_id: str = "",
    frame_id: str = "",
):
    reg = _load_image_registry()
    resolved_category = category or _category_for_image_id(img_id)
    safe_run = _safe_run_id(run_id)
    _allocate_image_id(reg, resolved_category, img_id, safe_run)
    registry_key = _registry_key_for(img_id, safe_run)
    reg["images"][registry_key] = {
        "id": img_id,
        "description": description or frame_id or f"@图片{img_id}",
        "category": resolved_category,
        "ip_name": "",
        "status": "generated",
        "path": filepath,
        "public_url": public_url,
        "filename": os.path.basename(filepath),
        "run_id": safe_run,
        "frame_id": frame_id,
        "created_at": datetime.now().isoformat(),
    }
    if img_id >= int(reg.get("next_id", 1)):
        reg["next_id"] = img_id + 1
    _save_image_registry(reg)
    return reg["images"][registry_key]

@app.get("/image_library")
def list_images(run_id: str = ""):
    reg = _load_image_registry()
    return {
        "status": "success",
        "images": _scoped_registry_images(reg, run_id),
        "next_id": reg.get("next_id", 1),
        "run_id": _safe_run_id(run_id),
    }

@app.post("/image_library/register")
def register_image(req: RegisterImageRequest):
    reg = _load_image_registry()
    safe_run = _safe_run_id(req.run_id)
    img_id = _allocate_image_id(reg, req.category, req.img_id, safe_run)
    registry_key = _registry_key_for(img_id, safe_run)

    reg["images"][registry_key] = {
        "id": img_id,
        "description": req.description,
        "category": req.category,
        "ip_name": req.ip_name,
        "status": "registered",
        "run_id": safe_run,
        "created_at": datetime.now().isoformat(),
    }
    if img_id >= reg["next_id"]:
        reg["next_id"] = img_id + 1
    _save_image_registry(reg)
    return {"status": "success", "id": img_id}


@app.post("/image_library/upload")
async def upload_image_asset(
    file: UploadFile = File(...),
    img_id: Optional[int] = Form(None),
    category: str = Form("character"),
    description: str = Form(""),
    ip_name: str = Form(""),
    run_id: str = Form(""),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="没有收到图片文件。")
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in [".png", ".jpg", ".jpeg", ".webp"]:
        raise HTTPException(status_code=400, detail="只支持 png / jpg / jpeg / webp 图片。")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="图片文件为空。")
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="图片超过 25MB，请压缩后再上传。")

    reg = _load_image_registry()
    safe_run = _safe_run_id(run_id)
    asset_id = _allocate_image_id(reg, category, img_id, safe_run)
    folder_path = get_or_create_run_folder(safe_run)
    refs_dir = os.path.join(folder_path, "references")
    os.makedirs(refs_dir, exist_ok=True)

    filename = f"@图片{asset_id}_{_safe_asset_filename(file.filename)}"
    filepath = os.path.join(refs_dir, filename)
    with open(filepath, "wb") as f:
        f.write(raw)

    public_url = _public_output_url(filepath)
    registry_key = _registry_key_for(asset_id, safe_run)
    reg["images"][registry_key] = {
        "id": asset_id,
        "description": description or os.path.splitext(file.filename)[0],
        "category": category,
        "ip_name": ip_name,
        "status": "uploaded",
        "path": filepath,
        "public_url": public_url,
        "filename": filename,
        "run_id": safe_run,
        "created_at": datetime.now().isoformat(),
    }
    if asset_id >= int(reg.get("next_id", 1)):
        reg["next_id"] = asset_id + 1
    _save_image_registry(reg)
    return {"status": "success", "asset": reg["images"][registry_key]}

@app.delete("/image_library/{img_id}")
def delete_image(img_id: int, run_id: str = ""):
    reg = _load_image_registry()
    sid = _registry_key_for(img_id, run_id)
    if sid not in reg["images"]:
        sid = ""
        for key, entry in _iter_registry_entries(reg, run_id):
            if _registry_entry_id(key, entry) == img_id:
                sid = key
                break
    if not sid or sid not in reg["images"]:
        raise HTTPException(status_code=404, detail=f"@图片{img_id} 不存在")
    filepath = reg["images"][sid].get("path", "")
    del reg["images"][sid]
    _save_image_registry(reg)
    if filepath and os.path.exists(filepath):
        try:
            os.remove(filepath)
        except Exception:
            pass
    return {"status": "success", "deleted": img_id}


# ━━━ 前端静态文件挂载（必须放在所有 API 路由之后）━━━
_FRONTEND_DIST = os.path.join(BASE_DIR, "frontend", "storyboard-ui", "dist")
if os.path.isdir(_FRONTEND_DIST):
    from fastapi.responses import FileResponse

    @app.get("/")
    async def serve_frontend_index():
        return FileResponse(os.path.join(_FRONTEND_DIST, "index.html"))

    app.mount("/assets", StaticFiles(directory=os.path.join(_FRONTEND_DIST, "assets")), name="frontend_assets")
    # Serve other static files (favicon, icons)
    app.mount("/", StaticFiles(directory=_FRONTEND_DIST, html=True), name="frontend_root")
    print(f"[前端] 已挂载 dist 静态文件：{_FRONTEND_DIST}")
    print(f"[前端] 可通过 http://localhost:8001 直接访问前端（无需 npm run dev）")


if __name__ == "__main__":
    uvicorn.run("rag_api:app", host="0.0.0.0", port=8001, reload=False)
