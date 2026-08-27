# 弈心 ChessMind

<div align="center">

**AI 国际象棋教练** — Stockfish 18 NNUE 引擎 + 大语言模型，在浏览器本地运行，棋谱不出本机。

[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-beta-orange.svg)]()

[English](README.en.md) · 中文

</div>

---

## ✨ 核心特性

- **Stockfish 18 NNUE 引擎** — 神经网络评估，对齐 Lichess 分析口径，浏览器 WebAssembly 本地运行
- **智能着法分类** — 最佳 / 优秀 / 良好 / 失误 / 错误 / 大错，彩色标注一目了然
- **多线候选分析** — 同时展示多条候选着法及评估分数，绿箭头=最佳，蓝箭头=次选
- **六维能力画像** — 开局 / 中局 / 残局 / 战术 / 质量 / 稳定性，雷达图可视化
- **AI 中文解说** — 大语言模型驱动，关键着法深度解读与训练建议
- **隐私保护** — 100% 本地运行，棋谱不上传服务器，数据仅存于浏览器 localStorage
- **Lichess 集成** — 一键绑定账号，自动拉取历史对局，批量分析

## 🏗️ 架构

```
数据接入层    → Lichess研讨 API / PGN导入 / 示例棋局
引擎分析层    → Stockfish 18 NNUE WASM（本地Worker，失败自动回退）
量化层       → 胜率模型（ΔWin%着法分类 + Lichess同款准确率公式）
个性化层     → 多局聚合画像与短板诊断
交付层       → LLM中文解说
```

## 🚀 快速开始

### 本地运行

```bash
# Python 3
python3 -m http.server 8000

# 或 Node.js
npx serve .

# 然后访问
# http://localhost:8000
```

> ⚠️ 必须通过 HTTP 服务器访问，直接 `file://` 打开无法加载 WASM 引擎。

### 使用流程

1. **导入棋谱** — 绑定 Lichess 账号 / 导入研讨 / 粘贴 PGN / 载入示例
2. **引擎分析** — 选择对局，点击"分析此局"，引擎自动深度 16 分析
3. **查看画像** — 切换到"画像诊断"页，查看六维能力雷达图
4. **AI 解说** — 在设置页配置 LLM API，一键生成中文解说

## 📁 目录结构

```
chess-ai-coach-app/
├── index.html                    # 入口页面
├── assets/
│   ├── style.css                 # 莫兰迪色系设计系统
│   ├── app.js                    # 应用主逻辑（状态/渲染/交互）
│   ├── engine.js                 # UCI 引擎封装（握手/参数/Worker）
│   ├── board.js                  # 棋盘渲染与交互（点击/拖拽/变着）
│   ├── lichess.js               # Lichess API 数据接入
│   ├── logo-144.png              # 144px 图标
│   ├── logo-512.png              # 512px 图标
│   ├── vendor/
│   │   ├── chess.min.js          # chess.js 棋规库
│   │   ├── stockfish-18-lite-single.js   # SF18 NNUE 引擎 JS
│   │   └── stockfish-18-lite-single.wasm # SF18 NNUE WASM 二进制（7.1MB）
│   └── piece/cburnett/           # cburnett 棋子 SVG（12枚）
├── vercel.json                   # Vercel 部署配置
├── netlify.toml                  # Netlify 部署配置
├── .gitignore
└── README.md
```

## 🛠️ 技术栈

| 类别 | 技术 |
|---|---|
| 引擎 | Stockfish 18 Lite NNUE (WebAssembly) |
| 棋规 | chess.js |
| 棋子 | cburnett SVG 棋子集 |
| 引擎协议 | UCI（异步 Worker 通信） |
| 存储 | localStorage（本地持久化） |
| LLM | 支持 OpenAI / DeepSeek / 通义 / SiliconFlow / 自定义 |

## 🌐 部署

### Vercel（推荐）

1. 推送项目到 GitHub
2. 访问 [vercel.com](https://vercel.com) 导入仓库
3. Framework Preset: **Other**
4. Build Command: **（留空）**
5. Output Directory: **`.`**
6. 点击 Deploy → 部署完成

### Netlify

1. 访问 [app.netlify.com/drop](https://app.netlify.com/drop)
2. 拖拽项目文件夹到上传区
3. 或连接 GitHub 仓库自动部署

### 绑定自定义域名

1. 在 Vercel/Netlify Dashboard → Settings → Domains 添加域名
2. 在域名注册商配置 DNS 记录（Vercel 会自动给出指引）
3. 等待 DNS 生效，HTTPS 证书自动签发

## 🔒 隐私说明

- 所有分析在浏览器本地完成，棋谱不会上传到任何服务器
- Lichess API 令牌仅存于浏览器 localStorage
- LLM API Key 仅存于浏览器 localStorage，直连你配置的端点
- 数据可随时导出或清空（设置页 → 数据管理）

## 📜 开源许可

本项目包含以下第三方开源组件：

| 组件 | 许可证 | 说明 |
|---|---|---|
| [Stockfish](https://github.com/official-stockfish/Stockfish) | GPL-3.0 | 国际象棋引擎 |
| [stockfish.js](https://github.com/nmrugg/stockfish.js) | GPL-3.0 | Stockfish WebAssembly 封装 |
| [chess.js](https://github.com/jhlywa/chess.js) | BSD-3-Clause | 棋规校验库 |
| [cburnett chess pieces](https://github.com/cburnett/chess-pieces) | GPL-3.0 | 棋子 SVG |
| [chessground](https://github.com/lichess-org/chessground) | GPL-3.0 | 棋盘视觉设计参考 |

本项目代码以 **GPL-3.0** 许可证发布，与 Stockfish 保持一致。

---

<div align="center">

**弈心 ChessMind · 每一步，都看得见**

</div>
