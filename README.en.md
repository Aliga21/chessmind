# ChessMind

<div align="center">

**AI Chess Coach** — Stockfish 18 NNUE engine + LLM commentary, runs entirely in your browser. No games leave your device.

**Live Demo**: [https://chessmind-mocha.vercel.app/](https://chessmind-mocha.vercel.app/)

</div>

---

## Features

- **Stockfish 18 NNUE Engine** — Neural network evaluation, running as WebAssembly in the browser
- **Smart Move Classification** — Best / Excellent / Good / Inaccuracy / Mistake / Blunder, color-coded
- **Multi-Line Analysis** — Multiple candidate moves with evaluation scores
- **6-Dimensional Player Profile** — Opening / Middlegame / Endgame / Tactics / Quality / Stability, visualized via radar chart
- **AI Commentary** — LLM-powered move-by-move explanations in Chinese
- **Privacy First** — 100% local execution; games never leave your device
- **Lichess Integration** — One-click account binding, automatic game import, batch analysis

## Architecture

```
Data Layer    → Lichess Studies API / PGN Import / Sample Games
Engine Layer  → Stockfish 18 NNUE WASM (local Worker, automatic fallback)
Quant Layer   → Win-rate Model (ΔWin% classification + accuracy formula)
Profile Layer → Multi-game aggregation + weakness diagnosis
Delivery Layer→ LLM Chinese commentary
```

## Local Run

```bash
# Python 3
python3 -m http.server 8000

# or Node.js
npx serve .

# then visit
# http://localhost:8000
```

> ⚠️ An HTTP server is required. Opening via `file://` will not load the WASM engine.

## Workflow

1. **Import Games** — Bind Lichess account / Import studies / Paste PGN / Load samples
2. **Engine Analysis** — Select a game, click "Analyze", engine runs at depth 16
3. **View Profile** — Switch to "Profile" tab for the 6-dimension radar chart
4. **AI Commentary** — Configure LLM API in Settings, generate Chinese narration with one click

## Project Structure

```
chess-ai-coach-app/
├── index.html                    # Entry point
├── assets/
│   ├── style.css                 # Main styles
│   ├── app.js                    # Application logic
│   ├── engine.js                 # UCI engine wrapper
│   ├── board.js                  # Board rendering & interaction
│   ├── lichess.js               # Lichess API integration
│   ├── vendor/
│   │   ├── chess.min.js          # chess.js rules library
│   │   ├── stockfish-18-lite-single.js   # SF18 NNUE engine JS
│   │   └── stockfish-18-lite-single.wasm # SF18 NNUE WASM binary
│   └── piece/cburnett/           # cburnett piece SVGs
├── vercel.json                   # Vercel deployment config
├── netlify.toml                  # Netlify deployment config
└── .gitignore
```

## Tech Stack

| Category | Technology |
|---|---|
| Engine | Stockfish 18 Lite NNUE (WebAssembly) |
| Rules | chess.js |
| Pieces | cburnett SVG pieces |
| Protocol | UCI (async Worker communication) |
| Storage | localStorage (local persistence) |
| LLM | OpenAI / DeepSeek / DashScope / SiliconFlow / Custom |

## Privacy

- All analysis runs locally in your browser; games are never sent to any server
- Lichess API token stored only in browser localStorage
- LLM API Key stored only in browser localStorage, connecting directly to your configured endpoint
- Data can be exported or cleared at any time (Settings → Data Management)

## License

This project incorporates the following third-party open-source components:

| Component | License | Description |
|---|---|---|
| [Stockfish](https://github.com/official-stockfish/Stockfish) | GPL-3.0 | Chess engine |
| [stockfish.js](https://github.com/nmrugg/stockfish.js) | GPL-3.0 | Stockfish WebAssembly wrapper |
| [chess.js](https://github.com/jhlywa/chess.js) | BSD-3-Clause | Chess rules library |
| [cburnett chess pieces](https://github.com/cburnett/chess-pieces) | GPL-3.0 | Piece SVGs |

This project is released under the **GPL-3.0** license, consistent with Stockfish.

---

<div align="center">

**ChessMind · Every Move, Visible**

</div>
