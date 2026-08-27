# ChessMind

<div align="center">

**AI Chess Coach** — Stockfish 18 NNUE engine + LLM commentary, runs entirely in your browser. No games leave your device.

[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-beta-orange.svg)]()

[中文](README.md) · English

</div>

---

## ✨ Features

- **Stockfish 18 NNUE Engine** — Neural network evaluation aligned with Lichess analysis, running as WebAssembly in the browser
- **Smart Move Classification** — Best / Excellent / Good / Inaccuracy / Mistake / Blunder, color-coded for instant reading
- **Multi-Line Analysis** — Multiple candidate moves with evaluation scores; green arrow = best, blue = second-best
- **6-Dimensional Player Profile** — Opening / Middlegame / Endgame / Tactics / Quality / Stability, visualized via radar chart
- **AI Commentary** — LLM-powered move-by-move explanations and training suggestions in Chinese
- **Privacy First** — 100% local execution; games never leave your device; data stored only in browser localStorage
- **Lichess Integration** — One-click account binding, automatic game import, batch analysis

## 🏗️ Architecture

```
Data Layer    → Lichess Studies API / PGN Import / Sample Games
Engine Layer  → Stockfish 18 NNUE WASM (local Worker, automatic fallback)
Quant Layer   → Win-rate Model (ΔWin% classification + Lichess accuracy formula)
Profile Layer → Multi-game aggregation + weakness diagnosis
Delivery Layer→ LLM Chinese commentary
```

## 🚀 Quick Start

### Local Run

```bash
# Python 3
python3 -m http.server 8000

# or Node.js
npx serve .

# then visit
# http://localhost:8000
```

> ⚠️ An HTTP server is required. Opening via `file://` will not load the WASM engine.

### Workflow

1. **Import Games** — Bind Lichess account / Import studies / Paste PGN / Load samples
2. **Engine Analysis** — Select a game, click "Analyze", engine runs at depth 16
3. **View Profile** — Switch to "Profile" tab for the 6-dimension radar chart
4. **AI Commentary** — Configure LLM API in Settings, generate Chinese narration with one click

## 📁 Project Structure

```
chess-ai-coach-app/
├── index.html                    # Entry point
├── assets/
│   ├── style.css                 # Morandi color design system
│   ├── app.js                    # Main application logic
│   ├── engine.js                 # UCI engine wrapper (handshake / params / Worker)
│   ├── board.js                  # Board rendering & interaction
│   ├── lichess.js               # Lichess API integration
│   ├── logo-144.png              # 144px icon
│   ├── logo-512.png              # 512px icon
│   ├── vendor/
│   │   ├── chess.min.js          # chess.js rules library
│   │   ├── stockfish-18-lite-single.js   # SF18 NNUE engine JS
│   │   └── stockfish-18-lite-single.wasm # SF18 NNUE WASM binary (7.1MB)
│   └── piece/cburnett/           # cburnett piece SVGs (12 pieces)
├── vercel.json                   # Vercel deployment config
├── netlify.toml                  # Netlify deployment config
├── .gitignore
└── README.md
```

## 🛠️ Tech Stack

| Category | Technology |
|---|---|
| Engine | Stockfish 18 Lite NNUE (WebAssembly) |
| Rules | chess.js |
| Pieces | cburnett SVG pieces |
| Protocol | UCI (async Worker communication) |
| Storage | localStorage (local persistence) |
| LLM | OpenAI / DeepSeek / DashScope / SiliconFlow / Custom |

## 🌐 Deployment

### Vercel (Recommended)

1. Push the project to GitHub
2. Import the repo at [vercel.com](https://vercel.com)
3. Framework Preset: **Other**
4. Build Command: *(leave empty)*
5. Output Directory: **`.`**
6. Click Deploy

### Netlify

1. Visit [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag the project folder onto the upload area
3. Or connect your GitHub repo for automatic deploys

### Custom Domain

1. Add a domain in Vercel/Netlify Dashboard → Settings → Domains
2. Configure DNS records at your domain registrar (Vercel provides automatic guidance)
3. Wait for DNS propagation; HTTPS certificate auto-issued

## 🔒 Privacy

- All analysis runs locally in your browser; games are never sent to any server
- Lichess API token stored only in browser localStorage
- LLM API Key stored only in browser localStorage, connecting directly to your configured endpoint
- Data can be exported or cleared at any time (Settings → Data Management)

## 📜 License

This project incorporates the following third-party open-source components:

| Component | License | Description |
|---|---|---|
| [Stockfish](https://github.com/official-stockfish/Stockfish) | GPL-3.0 | Chess engine |
| [stockfish.js](https://github.com/nmrugg/stockfish.js) | GPL-3.0 | Stockfish WebAssembly wrapper |
| [chess.js](https://github.com/jhlywa/chess.js) | BSD-3-Clause | Chess rules library |
| [cburnett chess pieces](https://github.com/cburnett/chess-pieces) | GPL-3.0 | Piece SVGs |
| [chessground](https://github.com/lichess-org/chessground) | GPL-3.0 | Board visual design reference |

This project is released under the **GPL-3.0** license, consistent with Stockfish.

---

<div align="center">

**ChessMind · Every Move, Visible**

</div>
