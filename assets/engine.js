/* ============ engine.js · Stockfish WASM 引擎层与量化层 ============ */
/* 五层流水线中的「引擎分析层 + 量化层」：
   Stockfish(WASM, 本地 Worker) → 逐局面评估 → 胜率模型 → 着法分类/ACPL/准确率 */

(function () {
  'use strict';
  window.CLEngine = {};

  class UciEngine {
    constructor(path) {
      this.worker = new Worker(path);
      this.listeners = [];
      this.failed = false;
      this.worker.onmessage = (e) => {
        const line = String(e.data);
        this.listeners.forEach((fn) => fn(line));
      };
      this.worker.onerror = (e) => {
        this.failed = true;
        this.errorMsg = e.message || '引擎加载失败';
        this.listeners.forEach((fn) => fn('__engine_error__ ' + this.errorMsg));
      };
    }
    on(fn) { this.listeners.push(fn); }
    off(fn) { this.listeners = this.listeners.filter((f) => f !== fn); }
    send(cmd) { this.worker.postMessage(cmd); }
    /** 等待某类行出现（predicate），超时拒绝 */
    waitFor(predicate, timeoutMs) {
      return new Promise((resolve, reject) => {
        const h = (line) => {
          if (line.startsWith('__engine_error__')) { this.off(h); reject(new Error(line.replace('__engine_error__', '').trim())); return; }
          if (predicate(line)) { this.off(h); resolve(line); }
        };
        this.on(h);
        if (timeoutMs) setTimeout(() => { this.off(h); reject(new Error('引擎响应超时')); }, timeoutMs);
      });
    }
    /** 握手初始化：uci → 旁听 id/option 行建立能力表 → 按上报能力安全调参 → isready 校验存活。
        旧版单线程构建的 Hash 被锁定为 16MB（min=max=16），越界 setoption 可能使引擎停止响应，
        因此只在引擎自己上报的选项范围内设置参数；新版 NNUE 引擎则扩大置换表以稳定评估 */
    async init() {
      const opts = {};
      let name = '';
      const probe = (line) => {
        let m = line.match(/^id name (.+)$/);
        if (m) name = m[1].trim();
        m = line.match(/^option name (.+?) type (\w+)\b/);
        if (m) {
          const minM = line.match(/\bmin (-?\d+)/), maxM = line.match(/\bmax (-?\d+)/);
          opts[m[1]] = { type: m[2], min: minM ? +minM[1] : null, max: maxM ? +maxM[1] : null };
        }
      };
      this.on(probe);
      /* SF18 等 Emscripten/WASM 构建在 Worker 启动后还需数秒加载 WASM 与 NNUE 网络，
         初始化期间 postMessage 发来的命令会被丢弃（引擎尚未挂载消息监听）——
         首次握手必须带重试：每 4 秒重发一次 uci，最多 5 次，覆盖慢速初始化场景 */
      let uciok = false;
      for (let i = 0; i < 5 && !uciok && !this.failed; i++) {
        this.send('uci');
        try {
          await this.waitFor((l) => l.startsWith('uciok'), 4000);
          uciok = true;
        } catch (e) {
          if (this.failed) break;
          if (i === 4) throw e;
        }
      }
      if (!uciok) throw new Error(this.errorMsg || '引擎 UCI 握手失败');
      this.off(probe);
      this.options = opts;
      this.name = name;
      const ver = (name.match(/Stockfish\s+(\d+)/) || [])[1];
      this.isNNUE = ver ? +ver >= 12 : false;    // SF12+ 为 NNUE 评估引擎
      /* 调参（lichess 分析页同款思路）：默认 16MB 置换表偏小，搜索震荡会造成评估漂移；
         仅当上报能力允许（max>=64）时扩大，旧引擎跳过以保证不被越界参数挂死 */
      const hashTuned = this.isNNUE && opts.Hash && opts.Hash.max >= 64;
      if (hashTuned) this.send('setoption name Hash value 64');
      this.send('isready');
      await this.waitFor((l) => l.startsWith('readyok'), 10000);
      console.log('[CLEngine] 引擎就绪：' + (name || '未知版本') +
        (this.isNNUE ? ' · NNUE' : ' · classical') +
        (hashTuned ? ' · Hash 64MB' : ' · 默认参数'));
    }
    /** 终止底层 Worker：引擎加载失败 / 切换候选引擎时清理，避免残留进程占用 CPU */
    destroy() {
      try { this.worker.terminate(); } catch (e) { /* 已终止 */ }
      this.listeners = [];
      this.failed = true;
    }
    /** 多线路分析单个局面（MultiPV）：返回 {score(最佳线), bestmove, pv(最佳线), alts:[{uci,score}]}。
        同一次搜索内即可对比「最佳着 vs 实际着法」——两个独立搜索之间弱引擎的评估会漂移 ±60cp，
        那正是旧版把 1.e4 / 2.Bc4 等正常着法判成失误的根源 */
    analyzeMulti(fen, depth, lines, timeoutMs) {
      lines = lines || 4;
      timeoutMs = timeoutMs || 180000;
      return new Promise((resolve, reject) => {
        const rows = [];
        let done = false;
        const finish = () => {
          rows.sort((a, b) => a.mpv - b.mpv);
          const top = rows[0];
          /* 去重：该 WASM 引擎的 MultiPV 会在深度推进时偶发重发同首着线路（不同深度评分），
             挤占候选名额；alts 只保留首着互不相同的线路 */
          const seen = new Set();
          const alts = [];
          for (const r of rows.slice(1)) {
            const u = r.pv[0];
            if (!u || seen.has(u) || (top && u === top.pv[0])) continue;
            seen.add(u);
            alts.push({ uci: u, score: r.score });
          }
          resolve({
            score: top ? top.score : { cp: 0 },
            bestmove: top ? (top.pv[0] || null) : null,
            pv: top ? top.pv : [],
            alts
          });
        };
        const h = (line) => {
          if (done) return;
          if (line.startsWith('__engine_error__')) { done = true; this.off(h); clearTimeout(timer); reject(new Error(line.replace('__engine_error__', '').trim())); return; }
          if (line.startsWith('info ') && line.indexOf(' pv ') >= 0 && line.indexOf('bound') < 0) {
            // info depth 13 seldepth 18 multipv 2 score cp 37 ... pv f1c4 ...
            const m = line.match(/^info depth (\d+).*?(?:multipv (\d+))?\s+score (cp (-?\d+)|mate (-?\d+))(?:.*? pv (.+))?$/);
            if (m && m[6]) {
              const mpv = +(m[2] || 1);
              const score = (m[4] !== undefined) ? { cp: +m[4] } : { mate: +m[5] };
              const pv = m[6].trim().split(/\s+/).slice(0, 12);
              const slot = rows.find((r) => r.mpv === mpv);
              if (slot) { slot.depth = +m[1]; slot.score = score; slot.pv = pv; }
              else rows.push({ mpv, depth: +m[1], score, pv });
            }
          } else if (line.startsWith('bestmove')) {
            done = true; this.off(h); clearTimeout(timer); finish();
          }
        };
        const timer = setTimeout(() => { if (done) return; done = true; this.off(h); finish(); }, timeoutMs);
        this.on(h);
        // 每个局面独立开局（清空置换表）：保证评分可复现、不受上一局面搜索的残留影响
        this.send('setoption name MultiPV value ' + lines);
        this.send('ucinewgame');
        this.send('position fen ' + fen);
        this.send('go depth ' + depth);
      });
    }
    /** 分析单个局面，返回 {score:{cp|mate}, bestmove, pv:[uci...]}；带超时兜底防挂起 */
    analyze(fen, depth, timeoutMs) {
      timeoutMs = timeoutMs || 120000;
      return new Promise((resolve, reject) => {
        let info = { depth: 0, score: null, pv: [] };
        let done = false;
        const h = (line) => {
          if (done) return;
          if (line.startsWith('__engine_error__')) { done = true; this.off(h); clearTimeout(timer); reject(new Error(line.replace('__engine_error__', '').trim())); return; }
          if (line.startsWith('info ') && line.indexOf(' pv ') >= 0 && line.indexOf('bound') < 0) {
            const m = line.match(/^info depth (\d+).*score (cp (-?\d+)|mate (-?\d+)) .* pv (.+)$/);
            if (m && +m[1] >= info.depth) {
              info.depth = +m[1];
              info.score = (m[3] !== undefined) ? { cp: +m[3] } : { mate: +m[4] };
              info.pv = m[5].trim().split(/\s+/).slice(0, 10);
            }
          } else if (line.startsWith('bestmove')) {
            done = true;
            this.off(h); clearTimeout(timer);
            const best = line.split(/\s+/)[1];
            resolve({ score: info.score || { cp: 0 }, bestmove: (best && best !== '(none)') ? best : null, pv: info.pv });
          }
        };
        const timer = setTimeout(() => {
          if (done) return;
          done = true; this.off(h); clearTimeout(timer);
          resolve({ score: info.score || { cp: 0 }, bestmove: null, pv: info.pv });
        }, timeoutMs);
        this.on(h);
        this.send('position fen ' + fen);
        this.send('go depth ' + depth);
      });
    }
  }
  CLEngine.UciEngine = UciEngine;

  class LiveEngine {
    constructor(engine) {
      this.eng = engine;        // 底层 UciEngine
      this.running = false;
      this.handler = null;
      this.curFen = null;
      this.lines = [];          // [{mpv, depth, score, pv:[uci]}]
      this.onUpdate = null;     // 回调 (state)
      this.bestmoveCb = null;
    }
    setState(note) {
      if (this.onUpdate) this.onUpdate({ running: this.running, fen: this.curFen, lines: this.lines, note: note || '' });
    }
    parseInfo(line) {
      // info depth 12 seldepth 15 multipv 1 score cp 34 nodes ... pv e2e4 e7e5 ...
      // 捕获组：1=深度 2=multipv 3=完整分数串 4=cp 值 5=mate 值 6=pv
      const m = line.match(/^info depth (\d+).*?(?:multipv (\d+))?\s+score (cp (-?\d+)|mate (-?\d+))(?:.*? pv (.+))?$/);
      if (!m || !m[6]) return;
      const mpv = +(m[2] || 1);
      const score = (m[4] !== undefined) ? { cp: +m[4] } : { mate: +m[5] };
      const pv = m[6].trim().split(/\s+/).slice(0, 12);
      const slot = this.lines.find((l) => l.mpv === mpv);
      if (slot) { slot.depth = +m[1]; slot.score = score; slot.pv = pv; }
      else this.lines.push({ mpv, depth: +m[1], score, pv });
      this.lines.sort((a, b) => a.mpv - b.mpv);
    }
    start(fen, opts) {
      opts = opts || {};
      this.stop(true).then(() => {
        this.curFen = fen;
        this.lines = [];
        this.running = true;
        // MultiPV 合法范围 1–500（已实测该构建支持）
        this.eng.send('setoption name MultiPV value ' + (opts.multipv || 3));
        if (this.handler) this.eng.off(this.handler);
        this.handler = (line) => {
          if (line.startsWith('__engine_error__')) { this.running = false; this.setState('引擎错误'); return; }
          if (line.startsWith('info ') && line.indexOf(' pv ') >= 0 && line.indexOf('bound') < 0) {
            this.parseInfo(line);
            this.setState();
          } else if (line.startsWith('bestmove')) {
            this.running = false;
            this.setState('已算完（深度 ' + (this.lines[0] ? this.lines[0].depth : 0) + '）');
            const cb = this.bestmoveCb; this.bestmoveCb = null;
            if (cb) cb();
          }
        };
        this.eng.on(this.handler);
        this.eng.send('position fen ' + fen);
        this.eng.send('go depth ' + (opts.depth || 18));
        this.setState('计算中…');
      });
    }
    /** stop()：结束当前搜索。引擎串行处理命令，等待 bestmove 确认后再开新搜索，避免旧搜索的 bestmove 干扰新局面 */
    stop() {
      if (!this.handler && !this.running) return Promise.resolve();
      const wasRunning = this.running;
      return new Promise((resolve) => {
        this.running = false;
        if (this.handler && wasRunning) {
          this.bestmoveCb = resolve;
          this.eng.send('stop');
          setTimeout(resolve, 900);
        } else {
          resolve();
        }
      }).then(() => {
        if (this.handler) { this.eng.off(this.handler); this.handler = null; }
      });
    }
  }
  CLEngine.LiveEngine = LiveEngine;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  CLEngine.wp = function (cp) {           // cp → 白/当前视角胜率 0–100
    const c = clamp(cp, -1500, 1500);
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
  };
  CLEngine.scoreToCp = function (score) { // mate 折算为大数值 cp
    if (!score) return 0;
    if (score.mate !== undefined) return (score.mate > 0 ? 1 : -1) * (1200 + Math.max(0, 30 - Math.abs(score.mate)) * 30);
    return clamp(score.cp, -3000, 3000);
  };
  /** 单着准确率：Lichess 同款公式（deltaWP 为胜率百分点降幅） */
  CLEngine.moveAccuracy = function (deltaWP) {
    return clamp(103.1668 * Math.exp(-0.04354 * deltaWP) - 3.1669, 0, 100);
  };

  /* 莫兰迪低饱和：与 style.css --c-* 系列一一对应 */
  const CLS = {
    best:       { label: '最佳',   color: '#6E8A57' },
    excellent:  { label: '优秀',   color: '#75905D' },
    good:       { label: '良好',   color: '#7A7A55' },
    book:       { label: '开局库', color: '#8A7960' },
    inaccuracy: { label: '失当',   color: '#9C7B3A' },
    mistake:    { label: '失误',   color: '#A56B42' },
    blunder:    { label: '大错',   color: '#A65951' }
  };
  CLEngine.CLS = CLS;

  /* 阈值单位为「胜率百分点」（dwp 0–100，与 Lichess 官方一致）：
     失当 5–10 · 失误 10–20 · 大错 ≥20；2–5 为良好，<2 为优秀。
     注意不能写成 0.02/0.05 等小数——那等于 0.02 个百分点，会让每步棋都判成失误 */
  CLEngine.classify = function (deltaWP, playedIsBest) {
    if (playedIsBest) return 'best';
    if (deltaWP < 2) return 'excellent';
    if (deltaWP < 5) return 'good';
    if (deltaWP < 10) return 'inaccuracy';
    if (deltaWP < 20) return 'mistake';
    return 'blunder';
  };

  function npMaterial(fen) {  // 双方非兵子力总值（后9 车5 象3 马3）
    const board = fen.split(' ')[0];
    const val = { q: 9, r: 5, b: 3, n: 3 };
    let sum = 0;
    for (const ch of board) { const v = val[ch.toLowerCase()]; if (v) sum += v; }
    return sum;
  }
  CLEngine.npMaterial = npMaterial;
  CLEngine.phaseOf = function (plyIdx, fen) {
    const npm = npMaterial(fen);
    if (plyIdx < 20 && npm > 12) return 'opening';
    if (npm <= 12) return 'endgame';
    return 'middlegame';
  };

  /* 旧版 Stockfish WASM 在无合法着法的局面上不会返回 bestmove，会永久挂起；
     将杀/逼和等终局局面直接合成评分，跳过引擎调用 */
  function terminalEval(fen) {
    try {
      const c = new Chess(fen);
      if (c.in_checkmate()) return { score: { mate: 0 }, bestmove: null, pv: [] };
      if (c.in_stalemate() || c.in_draw() || c.insufficient_material()) return { score: { cp: 0 }, bestmove: null, pv: [] };
    } catch (e) { /* FEN 异常时交回引擎处理 */ }
    return null;
  }
  CLEngine.terminalEval = terminalEval;

  /**
   * game: {startFen, moves:[{san,uci,color,fenAfter}]}
   * 返回 {plies:[{score,bestmove,pv,alts:[{uci,score}]}], depth, ts, positions, version}
   * v2：每个局面用 MultiPV=5 分析，plies[i].alts 记录第 2–5 条候选线的首着与评分，
   *     供 evalGame 在同一搜索内对比实际着法与最佳着法
   */
  CLEngine.analyzeGame = async function (eng, game, depth, onProgress, isCancelled) {
    const positions = [game.startFen].concat(game.moves.map((m) => m.fenAfter));
    if (positions.some((p) => typeof p !== 'string' || !p.trim()))
      throw new Error('着法数据缺少局面（fenAfter），请删除该局重新导入');
    const plies = [];
    const t0 = Date.now();
    for (let i = 0; i < positions.length; i++) {
      if (isCancelled && isCancelled()) throw new Error('cancelled');
      const term = terminalEval(positions[i]);
      if (term) {
        plies.push({ score: term.score, bestmove: null, pv: [], alts: [] });
      } else {
        plies.push(await eng.analyzeMulti(positions[i], depth, 5));
      }
      if (onProgress) onProgress(i + 1, positions.length, Date.now() - t0);
    }
    return { plies, depth, ts: Date.now(), positions, version: 2 };
  };

  /**
   * 返回 {
   *   moveEvals:[{cpB,cpA,wpB,wpA,dwp,cls,isBest,phase}]  每半着（双方都算）
   *   stats: {accuracy, acpl, counts, phaseStats, critical, nMoves}  仅 mine 视角
   * }
   * v2 评分口径：在走子前的同一次 MultiPV 搜索里直接对比「最佳着 vs 实际着」，
   * 两个候选线出自同一棵搜索树，评估基准一致，不会产生跨搜索漂移。
   * v1（旧数据）为两个独立搜索的评估相减，已废弃，仅作兼容保底。
   */
  CLEngine.evalGame = function (game, analysis, mine) {
    const { plies } = analysis;
    const positions = analysis.positions;
    const moveEvals = [];
    for (let i = 0; i < game.moves.length; i++) {
      const mv = game.moves[i];
      const before = plies[i] || { score: { cp: 0 }, bestmove: null, alts: [] };
      const after = plies[i + 1] || { score: { cp: 0 } };
      let cpB, cpA, dwp, isBest;
      if (before.alts) {
        cpB = CLEngine.scoreToCp(before.score);          // 最佳线评分（行棋方视角）
        isBest = !!(before.bestmove && mv.uci === before.bestmove);
        const hit = isBest ? { score: before.score } : before.alts.find((a) => a.uci === mv.uci);
        if (hit) {
          /* 实际着在前 4 条候选线内：损失 = 最佳线胜率 − 该线胜率（同一次搜索，准确） */
          cpA = CLEngine.scoreToCp(hit.score);
          dwp = Math.max(0, CLEngine.wp(cpB) - CLEngine.wp(cpA));
        } else {
          /* 实际着不在前 5 条：至少比第 5 条更差（损失下界），
             再取下一局面独立评估的连续法结果，二者取大（真正的大漏着两者都会显著） */
          const worst = before.alts.length ? CLEngine.scoreToCp(before.alts[before.alts.length - 1].score) : cpB;
          const bound = Math.max(0, CLEngine.wp(cpB) - CLEngine.wp(worst));
          cpA = -CLEngine.scoreToCp(after.score);
          dwp = Math.max(Math.max(0, CLEngine.wp(cpB) - CLEngine.wp(cpA)), bound);
        }
      } else {
        /* v1 兼容（旧数据，加载时已作废；仅保底不被旧缓存崩坏） */
        cpB = CLEngine.scoreToCp(before.score);
        cpA = -CLEngine.scoreToCp(after.score);
        dwp = Math.max(0, CLEngine.wp(cpB) - CLEngine.wp(cpA));
        isBest = !!(before.bestmove && mv.uci === before.bestmove);
      }
      const phase = CLEngine.phaseOf(i, positions[i]);
      const hasOpening = !!(game.headers && (game.headers.Opening || game.headers.ECO));
      let cls;
      if (i < 8 && hasOpening && dwp < 5 && !isBest) cls = 'book';   // 开局前 8 着且未丢胜率（<5 个百分点）视为开局库
      else cls = CLEngine.classify(dwp, isBest);
      moveEvals.push({ cpB, cpA, wpB: CLEngine.wp(cpB), wpA: CLEngine.wp(cpA), dwp, cls, isBest, phase, color: mv.color });
    }
    const myIdx = [];
    for (let i = 0; i < game.moves.length; i++) if (game.moves[i].color === mine) myIdx.push(i);
    const counts = { best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    let accSum = 0, cpLossSum = 0;
    const phaseAcc = { opening: { n: 0, acc: 0, cpl: 0, cnt: zeroCnt() }, middlegame: { n: 0, acc: 0, cpl: 0, cnt: zeroCnt() }, endgame: { n: 0, acc: 0, cpl: 0, cnt: zeroCnt() } };
    for (const i of myIdx) {
      const ev = moveEvals[i];
      counts[ev.cls]++; (phaseAcc[ev.phase].cnt[ev.cls]++);
      phaseAcc[ev.phase].n++;
      phaseAcc[ev.phase].acc += CLEngine.moveAccuracy(ev.dwp);
      phaseAcc[ev.phase].cpl += Math.min(1000, Math.max(0, ev.cpB - ev.cpA));
      accSum += CLEngine.moveAccuracy(ev.dwp);
      cpLossSum += Math.min(1000, Math.max(0, ev.cpB - ev.cpA));
    }
    const n = myIdx.length;
    for (const ph of Object.keys(phaseAcc)) {
      const p = phaseAcc[ph];
      p.accuracy = p.n ? p.acc / p.n : null;
      p.acpl = p.n ? p.cpl / p.n : null;
    }
    const critical = myIdx
      .map((i) => ({ ply: i, ...moveEvals[i], san: game.moves[i].san, uci: game.moves[i].uci, fenBefore: positions[i], bestmove: plies[i].bestmove }))
      .sort((a, b) => b.dwp - a.dwp)
      .slice(0, 6);
    return {
      moveEvals,
      stats: {
        mine, nMoves: n,
        accuracy: n ? accSum / n : null,
        acpl: n ? cpLossSum / n : null,
        counts, phaseStats: phaseAcc, critical
      }
    };
  };
  function zeroCnt() { return { best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0 }; }

  CLEngine.aggregateProfile = function (games) {
    let totalMoves = 0, accW = 0, accN = 0, cplW = 0, cplN = 0;
    const cnt = { best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    const phase = {
      opening: { n: 0, cpl: 0, cnt: zeroCnt(), acc: 0 },
      middlegame: { n: 0, cpl: 0, cnt: zeroCnt(), acc: 0 },
      endgame: { n: 0, cpl: 0, cnt: zeroCnt(), acc: 0 }
    };
    const openings = {};
    const phaseLabel = { opening: '开局', middlegame: '中局', endgame: '残局' };
    for (const g of games) {
      const st = g.evalResult.stats;
      totalMoves += st.nMoves;
      accW += (st.accuracy || 0) * st.nMoves; accN += st.nMoves;
      cplW += (st.acpl || 0) * st.nMoves; cplN += st.nMoves;
      for (const k of Object.keys(cnt)) cnt[k] += st.counts[k];
      for (const ph of Object.keys(phase)) {
        const p = st.phaseStats[ph];
        phase[ph].n += p.n; phase[ph].cpl += (p.acpl || 0) * p.n; phase[ph].acc += (p.accuracy || 0) * p.n;
        for (const k of Object.keys(zeroCnt())) phase[ph].cnt[k] += p.cnt[k];
      }
      // 开局分组
      const okey = (g.headers && g.headers.Opening) ? (g.headers.Opening + (g.headers.ECO ? ' [' + g.headers.ECO + ']' : '')) : '未标注开局';
      if (!openings[okey]) openings[okey] = { games: 0, w: 0, d: 0, l: 0, cpl: 0, cplN: 0, blunders: 0 };
      const o = openings[okey];
      o.games++;
      const res = (g.headers && g.headers.Result) || '*';
      const won = (g.mine === 'w' && res === '1-0') || (g.mine === 'b' && res === '0-1');
      const draw = res === '1/2-1/2';
      if (won) o.w++; else if (draw) o.d++; else if (res !== '*') o.l++;
      o.cpl += (st.acpl || 0) * st.nMoves; o.cplN += st.nMoves;
      o.blunders += st.counts.blunder;
    }
    for (const ph of Object.keys(phase)) {
      const p = phase[ph];
      p.acpl = p.n ? p.cpl / p.n : null;
      p.accuracy = p.n ? p.acc / p.n : null;
    }
    const accuracy = accN ? accW / accN : null;
    const acpl = cplN ? cplW / cplN : null;
    const blunderRate = totalMoves ? cnt.blunder / totalMoves : 0;
    const unstableRate = totalMoves ? (cnt.mistake + cnt.inaccuracy) / totalMoves : 0;
    const dim = (v) => clamp(Math.round(v), 5, 99);
    const dims = {
      opening:    phase.opening.n    ? dim(100 - (phase.opening.acpl || 0) * 1.5) : null,
      middlegame: phase.middlegame.n ? dim(100 - (phase.middlegame.acpl || 0) * 1.5) : null,
      endgame:    phase.endgame.n    ? dim(100 - (phase.endgame.acpl || 0) * 1.5) : null,
      tactics:    dim(100 - blunderRate * 100 * 25),
      quality:    accuracy !== null ? dim(accuracy) : null,
      stability:  dim(100 - unstableRate * 100 * 8)
    };
    const dimLabels = { opening: '开局处理', middlegame: '中局计算', endgame: '残局技术', tactics: '战术敏锐', quality: '着法质量', stability: '稳定性' };
    const ranked = Object.keys(dims).filter((k) => dims[k] !== null).map((k) => ({ key: k, label: dimLabels[k], score: dims[k] })).sort((a, b) => a.score - b.score);
    return { nGames: games.length, totalMoves, accuracy, acpl, counts: cnt, phase, openings, dims, ranked };
  };
})();
