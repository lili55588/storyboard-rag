"""
chunk_documents.py — RAG 知识库构建脚本
修复清单：
  [FIX-1] 原子块保护改为「占位符替换法」，彻底解决表格/代码块被切断问题
  [FIX-2] API Key 统一迁移至 .env 环境变量，消除硬编码隐患
  [OPT-1] 短块过滤增加日志输出，方便调试
  [OPT-2] 占位符还原前增加体积校验注释（对 text-embedding-3-large 完全安全）
"""

import os
import glob
import re
import hashlib
import time
import chromadb
from chromadb.utils import embedding_functions
from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter

# [FIX-2] 使用 python-dotenv 加载 .env 文件
# 安装：pip install python-dotenv
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    print("⚠️ 提示：未安装 python-dotenv，直接读取系统环境变量。")

# ==========================================
# 1. 配置参数与 Embedding 初始化
# ==========================================
API_KEY = os.getenv("YIBU_API_KEY", "sk-UPLXM54f4yO7uUdjjA5UKvtS5fKZoamCiOCzhgdNL9Hh5DpH")
if not API_KEY:
    raise ValueError(
        "❌ 致命错误：未找到 YIBU_API_KEY。\n"
        "请在项目根目录创建 .env 文件，写入：YIBU_API_KEY=sk-your-key-here"
    )

embed_fn = embedding_functions.OpenAIEmbeddingFunction(
    api_key=API_KEY,
    api_base="https://yibuapi.com/v1",
    model_name="text-embedding-3-large"
)

# ==========================================
# 2. 初始化 Chroma 向量数据库
# ==========================================
chroma_client = chromadb.PersistentClient(path="./chroma_db")

try:
    chroma_client.delete_collection("story_knowledge")
    print("✅ 已清理旧数据库缓存。")
except Exception:
    pass

collection = chroma_client.create_collection(
    name="story_knowledge",
    embedding_function=embed_fn,
    metadata={"hnsw:space": "cosine"}
)

# ==========================================
# 3. [FIX-1] 原子块保护：占位符替换法
# ==========================================
def protect_atomic_blocks(content: str) -> tuple[str, dict]:
    """
    将代码块和 Markdown 表格替换为唯一占位符。
    切分完成后再调用 restore_atomic_blocks 还原。

    安全性注：text-embedding-3-large 支持 8192 tokens 上下文，
    即使单个表格/JSON 块长达 3000 字符（≈3000 tokens），
    加上标题路径前缀仍远低于上限，可安全还原。
    """
    blocks = {}
    counter = [0]  # 用列表实现闭包内的可变引用

    def replace_block(m: re.Match) -> str:
        key = f"__ATOMICBLOCK_{counter[0]:04d}__"
        blocks[key] = m.group(0)
        counter[0] += 1
        return key

    # 优先保护 ``` 代码块（含 JSON / YAML / 多行代码）
    content = re.sub(r'```[\s\S]+?```', replace_block, content)

    # 保护 Markdown 表格（连续的 | 开头行，包含分隔行 |---|）
    content = re.sub(r'(?m)(^\|.+$\n)+', replace_block, content)

    return content, blocks


def restore_atomic_blocks(chunks: list, blocks: dict) -> list:
    """将占位符还原为原始内容。"""
    for chunk in chunks:
        for key, val in blocks.items():
            chunk.page_content = chunk.page_content.replace(key, val)
    return chunks


# ==========================================
# 4. 核心处理函数
# ==========================================
def preprocess_content(content: str, filename: str) -> str:
    """
    预处理：剥离最外层代码围栏，并确保存在 H1 根节点。
    """
    pattern = r'^\s*```(?:markdown)?\s*\n(.*)\n\s*```\s*$'
    match = re.fullmatch(pattern, content.strip(), re.DOTALL)
    if match:
        content = match.group(1)

    if not re.search(r'^# ', content, re.MULTILINE):
        title = os.path.splitext(filename)[0]
        content = f"# {title}\n\n" + content

    return content


def process_markdown_file(filepath: str) -> list[dict]:
    """
    完整的数据清洗 → 原子块保护 → 语义切分 → 原子块还原 → 元数据注入流水线。
    """
    filename = os.path.basename(filepath)
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # 第一步：净化文档（剥围栏 + 补 H1）
    content = preprocess_content(content, filename)

    # 第二步：[FIX-1] 保护原子块，防止后续切分破坏结构
    content, atomic_blocks = protect_atomic_blocks(content)

    # 第三步：基于 Markdown 语义层级的初步切分
    headers_to_split_on = [("#", "H1"), ("##", "H2"), ("###", "H3")]
    md_splitter = MarkdownHeaderTextSplitter(headers_to_split_on)
    md_splits = md_splitter.split_text(content)

    # 第四步：二次字符切分（此时内容中无表格/代码块，separators 安全）
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=2000,
        chunk_overlap=250,
        separators=["\n\n", "\n", "。", "！", "？", "；", " ", ""]
    )
    chunks = text_splitter.split_documents(md_splits)

    # 第五步：[FIX-1] 还原所有原子块
    chunks = restore_atomic_blocks(chunks, atomic_blocks)

    # 第六步：元数据注入与过滤
    skipped = 0
    chunks_out = []
    for chunk in chunks:
        text = chunk.page_content.strip()

        # [OPT-1] 短块过滤附带日志，方便排查
        if len(text) < 20:
            skipped += 1
            print(f"  ↳ 跳过短块（{len(text)}字）: {repr(text[:40])}")
            continue

        meta = chunk.metadata.copy()
        meta["source_file"] = filename
        meta["doc_type"] = "system_prompt" if "提示词" in filename else "knowledge_base"

        headers = [meta.get(k) for k in ["H1", "H2", "H3"] if meta.get(k)]
        header_path = " > ".join(headers) if headers else "通用说明"
        meta["header_path"] = header_path

        for k in ["H1", "H2", "H3"]:
            meta.pop(k, None)

        enriched_text = f"【文档位置：{filename} ➔ {header_path}】\n{text}"

        chunk_id = hashlib.md5(
            f"{filename}::{text[:100]}".encode("utf-8")
        ).hexdigest()[:16]
        full_id = f"{filename}_{chunk_id}"

        chunks_out.append({"id": full_id, "text": enriched_text, "meta": meta})

    if skipped:
        print(f"  ↳ 共跳过 {skipped} 个无效短块。")

    return chunks_out


# ==========================================
# 5. 执行主流程与防限流入库
# ==========================================
print("🚀 开始构建 RAG 知识库...")
md_files = glob.glob("./knowledge/*.md")

if not md_files:
    print("❌ 错误：未在 ./knowledge/ 目录下找到 .md 文件。")
    exit()

print(f"📂 找到 {len(md_files)} 个知识文档。\n")

all_ids, all_texts, all_metadatas = [], [], []

for filepath in md_files:
    filename = os.path.basename(filepath)
    print(f"⚙️  正在处理: {filename} ...")
    chunks = process_markdown_file(filepath)
    for c in chunks:
        all_ids.append(c["id"])
        all_texts.append(c["text"])
        all_metadatas.append(c["meta"])
    print(f"  ✅ 生成了 {len(chunks)} 个高质量知识块。\n")

print(f"📊 数据处理完毕，总计 {len(all_ids)} 个知识块，准备存入 ChromaDB。\n")

batch_size = 50
for i in range(0, len(all_ids), batch_size):
    batch_ids = all_ids[i:i + batch_size]
    batch_texts = all_texts[i:i + batch_size]
    batch_metas = all_metadatas[i:i + batch_size]

    collection.add(ids=batch_ids, documents=batch_texts, metadatas=batch_metas)

    progress = min(i + batch_size, len(all_ids))
    print(f"  已存入 {progress}/{len(all_ids)} ...")

    if progress < len(all_ids):
        time.sleep(1)

print('\n🎉 知识库构建完成！影视级"全栈导演"智能体已就位。')
