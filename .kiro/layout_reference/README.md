# 旧版排版资产参考库

> **用途**：保存 2026-05-06 那版工作站的"排版资产"（颜色、styles 对象、JSX 骨架），作为以后任何 UI 重构时的视觉基准。
>
> **存档时间**：2026-05-18 晚
> **来源文件**：`frontend/storyboard-ui/src/App.jsx`（5/6 23:05 时间戳，1349 行，78994 bytes）

---

## 一、文件清单

| 文件 | 大小 | 用途 |
|---|---|---|
| `App.jsx.OLD_FULL.txt` | 78994 bytes | 旧版 App.jsx 完整快照（最权威） |
| `App.css.OLD_FULL.txt` | 24952 bytes | 旧版 App.css 完整快照 |
| `rag_api.py.OLD_FULL.txt` | 77899 bytes | 旧版 rag_api.py 完整快照 |
| `STYLES_AND_COLORS.txt` | 6012 chars | 颜色常量 + `const styles = {}` 对象（**最常用**） |
| `JSX_SKELETON.txt` | 35564 chars | 整个 `return ( ... )` 区块（含全部 JSX 排版结构） |

---

## 二、视觉风格特征

### 颜色系统
```
AMBER       = "#E8A020"   主色（琥珀金）
AMBER_HOVER = "#FBBF24"   高亮琥珀
BG          = "#09090B"   背景
SURFACE     = "#141417"   卡片/面板
BORDER      = "#27272A"   边框
TEXT        = "#E4E4E7"   主文字
MUTED       = "#A1A1AA"   次文字
```

### 排版手法
- **inline `style={{...}}`** 为主（84 处）
- 用统一的 `const styles = {}` 对象集中定义
- `className=` 只用了 2 处（极少依赖外部 CSS）
- 字体：`'Noto Serif SC', serif`（中文衬线）
- 背景：深色 + grain 噪点纹理（SVG inline data URL）

### 整体布局
```
┌──────────────────── header（topbar，琥珀金 logo + 按钮组）──────────┐
├─────── nav（4 阶段 tab，中间用琥珀金底色高亮当前 tab）────────────┤
├──────────── main（grid: 1fr | 1.3fr，左右双栏）───────────────────┤
│                              │                                    │
│  panel（输入区/侧边）         │  panel（输出区）                    │
│  - panelHeader               │  - output（textarea 主区）          │
│  - textarea                  │  - outputActions                    │
│  - 按钮组                     │                                    │
│                              │                                    │
└─────────── modalOverlay（系统设置弹窗） ──────────────────────────┘
```

### Modal 设计
- 居中弹窗，`width: 850px`，最大 95%
- `backdropFilter: blur(8px)` 玻璃感
- 头部 / 主体 / 底部三段式，深色 + 琥珀金分割线

---

## 三、未来如何使用这套资产

### 场景 1：UI 被改坏了想还原
直接对照 `App.jsx.OLD_FULL.txt` + `STYLES_AND_COLORS.txt`，把 `styles` 对象搬回当前 App.jsx，把 inline `style={styles.xxx}` 用法回填。

### 场景 2：新功能要加按钮但保持视觉一致
查 `STYLES_AND_COLORS.txt` 里有没有现成的 `btn / btnGhost / settingsBtn` 等可复用项，直接 `style={styles.btnGhost}` 调用即可。

### 场景 3：重构时不想丢视觉风格
把 `STYLES_AND_COLORS.txt` 的内容粘到任何新版 App.jsx 顶部，保留 `style={styles.xxx}` 的调用，新功能就自动套用旧版视觉。

### 场景 4：完全推倒重做
全文复制 `App.jsx.OLD_FULL.txt` 作为视觉基准，**只**改业务逻辑（state、handler、effect），不动 styles 对象和 JSX 排版。

---

## 四、注意事项

1. **rag_api.py 旧版（77899 bytes）功能比新版少**——它只是和 App.jsx 同时间的快照，作为"完整一致体"参考。如果要恢复**功能**，应该用最新的 `rag_api.py` 而不是这个旧版。
2. **App.css 旧版几乎没用**——旧 App.jsx 只用了 2 处 className，CSS 文件价值低。
3. **存档时间锁定**：以后任何时候如果发现这些文件被覆盖了，可以从 git 历史或备份恢复。建议用户给项目打个 git tag 或定期备份这个目录。
