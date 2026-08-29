/* ============ app.js · 应用状态与界面 ============ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt1 = (v) => (v == null ? '—' : v.toFixed(1));
  const fmt0 = (v) => (v == null ? '—' : Math.round(v));

  function toast(msg, type) {
    const box = $('toast');
    const t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.textContent = msg;
    box.appendChild(t);
    // 错误提示显示更久，便于用户读完原因
    setTimeout(() => t.remove(), type === 'err' ? 8000 : 4800);
  }

  /* 胜率模型与分类来自 engine.js */
  const wp = CLEngine.wp, CLS = CLEngine.CLS;
  const PHASE_LABEL = { opening: '开局', middlegame: '中局', endgame: '残局' };
  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

  function uciToSan(fen, uci) {
    if (!uci) return null;
    try {
      const c = new Chess(fen);
      const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
      return m ? m.san : uci;
    } catch (e) { return uci; }
  }
  function pvToSanStr(fen, pv) {
    try {
      const c = new Chess(fen);
      const out = [];
      for (const u of (pv || []).slice(0, 6)) {
        const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
        if (!m) break;
        out.push(m.san);
      }
      return out.join(' ') || '—';
    } catch (e) { return '—'; }
  }

  function mdInline(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function mdToHtml(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const out = []; let inList = false, para = [];
    const flushP = () => { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
    const flushL = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { flushP(); flushL(); continue; }
      if (/^#{1,2}\s+/.test(line)) { flushP(); flushL(); out.push('<h2>' + mdInline(line.replace(/^#+\s+/, '')) + '</h2>'); continue; }
      if (/^#{3,}\s+/.test(line)) { flushP(); flushL(); out.push('<h3>' + mdInline(line.replace(/^#+\s+/, '')) + '</h3>'); continue; }
      if (/^[•\-*]\s+/.test(line) || /^\d+[.、)]\s+/.test(line)) {
        flushP();
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + mdInline(line.replace(/^([•\-*]|\d+[.、)])\s+/, '')) + '</li>');
        continue;
      }
      para.push(mdInline(line));
    }
    flushP(); flushL();
    return out.join('');
  }

  const KEY = 'chessmind-v1';
  const PRESETS = {
    deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-flash' },
    siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    custom: { baseUrl: '', model: '' }
  };
  const S = {
    lichess: null,
    games: [],
    cur: -1,
    ply: 0,
    flip: false,
    sel: null,              // 分析棋盘选中格
    var: null,              // 当前变着 {from, moves:[...]}
    promo: null,            // 升变选择 {from,to,fen}
    live: null,             // LiveEngine 实例（分析面板）
    liveOn: true,           // 默认开启（lichess 打开分析页即出引擎），可关闭并记住
    liveArrowOn: true,
    engine: null,
    enginePromise: null,
    cancelAnalysis: false,
    busy: false,            // 批量分析进行中：实时面板暂停、棋盘不显示其箭头/评估
    libFilter: 'all',       // 棋谱库结果筛选
    theme: 'morandi',       // 当前主题：morandi（默认莫兰迪）/ pink（粉色主题）
    settings: {
      depth: 13,
      liveMultipv: 3,
      liveDepth: 18,
      llm: { preset: 'deepseek', baseUrl: PRESETS.deepseek.baseUrl, model: PRESETS.deepseek.model, apiKey: '' }
    }
  };

  function persist() {
    const snap = (games) => localStorage.setItem(KEY, JSON.stringify({
      lichess: S.lichess,
      liveOn: S.liveOn,
      theme: S.theme,          // 保存当前主题偏好（morandi / pink）
      settings: S.settings,
      games: games.map((g) => ({
        id: g.id, source: g.source, sourceLabel: g.sourceLabel, headers: g.headers,
        startFen: g.startFen, moves: g.moves, mine: g.mine,
        analyzed: g.analyzed, analysis: g.analysis, narration: g.narration,
        moveComments: g.moveComments || null
      }))
    }));
    try {
      snap(S.games);
    } catch (e) {
      /* 配额溢出：从库尾（最早导入的一批）逐步裁剪重试，避免整体保存失败 */
      let kept = S.games.length, ok = false;
      while (kept > 100) {
        kept = Math.max(100, Math.floor(kept * 0.8));
        try { snap(S.games.slice(0, kept)); ok = true; break; } catch (e2) { /* 继续裁剪 */ }
      }
      if (ok) {
        S.games = S.games.slice(0, kept);          // 内存态与存储保持一致
        renderLibrary(); renderCounts();
        toast('本地存储空间不足，已保留最近导入的 ' + kept + ' 局（更早的对局未保存）。可用「拉取范围」缩小数量后重试。', 'err');
      } else {
        toast('本地存储失败：' + e.message, 'err');
      }
    }
  }
  /** 历史数据修复：旧版本记录过 fenAfter:undefined（chess.js 无 mv.after），
      从起始局面重放主线着法补齐；重放失败则保持原样 */
  function repairFenAfter(g) {
    if (!g.moves || !g.moves.length) return;
    if (g.moves.every((m) => m && m.fenAfter)) return;
    try {
      const c = new Chess(g.startFen);
      for (const m of g.moves) {
        const mv = c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] || undefined });
        if (!mv) return;
        m.fenAfter = c.fen();
      }
    } catch (e) { /* 保持原样 */ }
  }
  /** 旧数据补判结果：重放主线着法，终局为将杀/逼和/子力不足时推导 Result（与导入口径一致） */
  function deriveResult(g) {
    const res = g.headers && g.headers.Result;
    if (res && res !== '*') return;
    if (!g.moves || !g.moves.length) return;
    try {
      const c = new Chess(g.startFen);
      for (const m of g.moves) {
        if (!c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] || undefined })) return;
      }
      if (c.in_checkmate()) g.headers.Result = c.turn() === 'w' ? '0-1' : '1-0';
      else if (c.in_stalemate() || c.insufficient_material() || c.in_draw()) g.headers.Result = '1/2-1/2';
    } catch (e) { /* 忽略 */ }
  }
  function loadState() {
    let stale = 0;
    try {
      const j = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!j) return 0;
      if (j.lichess) S.lichess = j.lichess;
      if (typeof j.liveOn === 'boolean') S.liveOn = j.liveOn;   // 记住引擎开关（lichess 同款体验）
      if (typeof j.theme === 'string' && (j.theme === 'morandi' || j.theme === 'pink')) S.theme = j.theme;   // 恢复主题偏好
      if (j.settings) S.settings = Object.assign(S.settings, j.settings);
      if (j.games) S.games = j.games.map((g) => {
        /* 局面（fenAfter）不再启动时全量修复：批量导入的对局为省存储未带 FEN，
           改为查看 / 分析该局时按需重放补齐（curGame / analyzeGames 中处理） */
        deriveResult(g);
        if (g.analysis && g.analysis.version !== 2) {
          /* v2 评分口径（同搜索 MultiPV 对比）上线：旧版分析受引擎跨搜索噪声污染，
             着法分类不可信，作废等待重新分析；基于旧数据的解说与点评一并作废 */
          g.analysis = null; g.evalResult = null; g.analyzed = false;
          g.narration = null; g.moveComments = null;
          stale++;
          return g;
        }
        if (g.analysis && !g.analysis.positions) g.analysis.positions = [g.startFen].concat(g.moves.map((m) => m.fenAfter));
        if (g.analysis) { try { g.evalResult = CLEngine.evalGame(g, g.analysis, g.mine); } catch (e) { g.analysis = null; g.analyzed = false; } }
        return g;
      });
    } catch (e) { /* 损坏的存储忽略 */ }
    return stale;
  }

  /* 当前对局：按需补齐局面数据（瘦身导入的对局不含每步 FEN，首次访问时重放主线生成） */
  const curGame = () => {
    const g = (S.cur >= 0 && S.cur < S.games.length) ? S.games[S.cur] : null;
    if (g && !g._fenOk) { repairFenAfter(g); g._fenOk = true; }
    return g;
  };
  const positionsOf = (g) => [g.startFen].concat(g.moves.map((m) => m.fenAfter));
  const sideToMove = (fen) => fen.split(' ')[1];

  const SAMPLE_PGN = [
`[Event "巴黎歌剧院之局（示例）"]
[White "Morphy, Paul"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]
[ECO "C41"]
[Opening "Philidor Defence"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`,
`[Event "勒加尔弃后杀（示例）"]
[White "Sire de Legal"]
[Black "Saint Brie"]
[Result "1-0"]
[ECO "C40"]
[Opening "King's Pawn Game"]

1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5# 1-0`,
`[Event "学者将死（示例）"]
[White "白方（示例）"]
[Black "黑方（示例）"]
[Result "1-0"]
[Opening "Scholar's Mate"]

1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0`
  ];

  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'analyze') renderAnalyzeView();
    if (name === 'profile') renderProfileView();
    /* 离开分析页时暂停实时引擎，省 CPU */
    if (name !== 'analyze' && S.live && S.live.running) {
      S.live.stop(true).then(() => updateLiveBadge());
    }
  }

  function renderUserChip() {
    const chip = $('user-chip');
    if (S.lichess) {
      chip.innerHTML = '<span class="dot on"></span>' + esc(S.lichess.username);
    } else {
      chip.innerHTML = '<span class="dot off"></span>未绑定 Lichess';
    }
  }

  function renderBind() {
    const form = $('bind-form'), ok = $('bind-ok');
    if (S.lichess) {
      form.classList.add('hidden'); ok.classList.remove('hidden');
      $('bound-name').innerHTML = '已绑定：<a href="https://lichess.org/@/' + esc(S.lichess.username) + '" target="_blank" rel="noopener">' + esc(S.lichess.username) + '</a>';
      const perfs = S.lichess.perfs || {};
      const rows = ['bullet', 'blitz', 'rapid', 'classical'].filter((k) => perfs[k] && perfs[k].games > 0)
        .map((k) => '<span class="rating-pill">' + { bullet: '超快棋', blitz: '快棋', rapid: '快棋+', classical: '慢棋' }[k] + '<b>' + perfs[k].rating + '</b></span>');
      $('bound-ratings').innerHTML = rows.join('') || '<span class="hint dim">暂无对局等级分</span>';
    } else {
      form.classList.remove('hidden'); ok.classList.add('hidden');
    }
  }

  async function doBind() {
    const token = $('token-input').value.trim();
    if (!token) return toast('请先粘贴令牌', 'err');
    toast('正在验证令牌…');
    try {
      const u = await CLLichess.validateToken(token);
      S.lichess = { token, username: u.username, perfs: u.perfs, url: u.url };
      persist();
      autoDetectMine();
      renderBind(); renderUserChip(); renderLibrary();
      toast('已绑定 ' + u.username, 'ok');
    } catch (e) {
      toast('绑定失败：' + e.message, 'err');
    }
  }

  function autoDetectMine() {
    if (!S.lichess) return;
    const un = S.lichess.username.toLowerCase();
    S.games.forEach((g) => {
      const w = (g.headers.White || '').toLowerCase(), b = (g.headers.Black || '').toLowerCase();
      if (w === un) g.mine = 'w';
      else if (b === un) g.mine = 'b';
    });
  }

  async function listStudies() {
    const username = $('study-user-input').value.trim();
    if (!username) return toast('请输入用户名', 'err');
    if (S.lichess && !username) $('study-user-input').value = S.lichess.username;
    const box = $('study-list');
    box.innerHTML = '<p class="hint dim">加载中…</p>';
    try {
      const list = await CLLichess.listStudies(username);
      if (!list.length) { box.innerHTML = '<p class="hint dim">该用户没有公开研讨。</p>'; return; }
      box.innerHTML = list.slice(0, 30).map((st) =>
        '<div class="study-item"><span class="sname">' + esc(st.name || '(未命名)') + '</span><span class="sid">' + esc(st.id) + '</span><button class="btn" data-study="' + esc(st.id) + '">导入</button></div>'
      ).join('');
    } catch (e) {
      box.innerHTML = '<p class="hint dim">获取失败：' + esc(e.message) + '</p>';
    }
  }

  async function importStudy(idOrUrl) {
    const id = CLLichess.extractStudyId(idOrUrl || '');
    if (!id) return toast('无法识别研讨链接或 ID', 'err');
    toast('正在导出研讨 ' + id + ' …');
    try {
      const pgn = await CLLichess.fetchStudyPgn(id);
      addGames(CLLichess.importPgnText(pgn, 'study'));
    } catch (e) { toast('导入失败：' + e.message, 'err'); }
  }

  function addGames(result, opts) {
    opts = opts || {};
    const { games, skipped } = result;
    if (!games.length) {
      if (!opts.silent) toast('未导入任何对局' + (skipped ? '（' + skipped + ' 个章节无着法）' : ''), 'err');
      return { added: 0, dup: 0, skipped: skipped || 0 };
    }
    // 内容去重：Lichess 对局用 GameId / Site 精确判重；其余用「双方 + 日期 + 着法序列」
    const keyOf = (g) => [g.headers.GameId || g.headers.Site || '', g.headers.White || '?', g.headers.Black || '?', g.headers.Date || '', g.moves.map((m) => m.san).join(' ')].join('|');
    const seen = new Set(S.games.map(keyOf));
    const fresh = [];
    let dup = 0;
    for (const g of games) {
      const k = keyOf(g);
      if (seen.has(k)) { dup++; continue; }
      seen.add(k);
      fresh.push(g);
    }
    if (fresh.length) {
      S.games = S.games.concat(fresh);
      autoDetectMine();
      persist();
      renderLibrary(); renderCounts();
    }
    const summary = { added: fresh.length, dup, skipped: skipped || 0 };
    if (opts.silent) return summary;
    let msg = fresh.length ? ('已导入 ' + fresh.length + ' 局') : '没有新对局';
    if (dup) msg += '（' + dup + ' 局与库中重复，已跳过）';
    if (skipped) msg += '，跳过 ' + skipped + ' 个空章节';
    const autoRes = fresh.filter((g) => g.resultDerived).length;
    if (autoRes) msg += '，' + autoRes + ' 局已按终局将杀/和棋自动判定结果';
    toast(msg, fresh.length ? 'ok' : 'err');
    return summary;
  }

  let myGamesAbort = null;
  async function importMyGames() {
    if (!S.lichess) return toast('请先绑定 Lichess 账号', 'err');
    if (myGamesAbort) return toast('正在拉取中，可点击「取消」中止', 'err');
    const limit = parseInt($('mygames-range').value, 10) || 0;
    const btn = $('btn-import-mygames'), cancel = $('btn-cancel-mygames');
    const wrap = $('mygames-progress'), fill = $('mygames-progress-fill'), stat = $('mygames-status');
    const ctrl = new AbortController();
    myGamesAbort = ctrl;
    btn.disabled = true;
    cancel.classList.remove('hidden');
    wrap.classList.remove('hidden');
    fill.style.width = '0%';
    fill.classList.add('indeterminate');
    stat.textContent = '正在连接 Lichess …';

    const BATCH = 400;
    let blocks = [], received = 0, lastPaint = 0;
    const total = { added: 0, dup: 0, skipped: 0 };
    const flush = () => {
      if (!blocks.length) return;
      const games = []; let skipped = 0;
      for (const b of blocks) {
        const pr = CLLichess.parsePgnGame(b);
        if (!pr.ok) { skipped++; continue; }
        const rec = CLLichess._makeGame(pr, 'account');
        /* 瘦身入库：批量导入不保存每步 FEN（查看 / 分析该局时按需重放补齐），大幅降低本地存储占用 */
        rec.moves = pr.moves.map((m) => ({ san: m.san, uci: m.uci, color: m.color }));
        games.push(rec);
      }
      const r = addGames({ games, skipped }, { silent: true });
      total.added += r.added; total.dup += r.dup; total.skipped += r.skipped;
      blocks = [];
    };

    try {
      const res = await CLLichess.fetchUserGames(S.lichess.username, {
        token: S.lichess.token, limit,
        signal: ctrl.signal,
        onGame: (block, n) => {
          blocks.push(block);
          received = n;
          if (blocks.length >= BATCH) flush();
          if (Date.now() - lastPaint > 300) {
            lastPaint = Date.now();
            stat.textContent = '正在接收对局…已收到 ' + n + ' 局' + (limit ? ' / 目标 ' + limit : '') + '，已入库 ' + total.added + ' 局';
          }
        },
        onProgress: (p) => {
          stat.textContent = '已收到 ' + p.got + ' 局 · 第 ' + p.pages + ' 页，继续向更早的对局翻页…已入库 ' + total.added + ' 局';
        }
      });
      flush();
      fill.classList.remove('indeterminate');
      fill.style.width = '100%';
      let msg = (res.aborted ? '已取消拉取。' : '拉取完成。') + '共接收 ' + received + ' 局：新增 ' + total.added + ' 局';
      if (total.dup) msg += '，与库中重复跳过 ' + total.dup + ' 局';
      if (total.skipped) msg += '，无法解析 ' + total.skipped + ' 局';
      if (res.anonFallback) msg += '（令牌未含对局读取权限，已按匿名公开对局拉取）';
      stat.textContent = msg;
      toast(msg, total.added ? 'ok' : '');
    } catch (e) {
      flush();
      fill.classList.remove('indeterminate');
      stat.textContent = '拉取失败：' + e.message + '（已接收 ' + received + ' 局，其中新增 ' + total.added + ' 局已入库）';
      toast('拉取失败：' + e.message, 'err');
    } finally {
      myGamesAbort = null;
      btn.disabled = false;
      cancel.classList.add('hidden');
      fill.classList.remove('indeterminate');
    }
  }

  function gameLabel(g, i) {
    const w = g.headers.White || '?', b = g.headers.Black || '?';
    const o = g.headers.Opening || g.headers.ECO || (g.moves.length + ' 着');
    return (i + 1) + '. ' + w + ' vs ' + b + ' · ' + o;
  }
  function resultClass(res, mine) {
    const won = (mine === 'w' && res === '1-0') || (mine === 'b' && res === '0-1');
    if (res === '1/2-1/2') return 'style="color:#8A8371"';
    if (res === '*') return 'style="color:#6F685A"';
    return won ? 'style="color:#6E8A57;font-weight:700"' : 'style="color:#A65951;font-weight:700"';
  }
  /** 结果分类（我方视角）：win / loss / draw / ongoing */
  function resultCat(g) {
    const res = g.headers.Result || '*';
    if (res === '1/2-1/2') return 'draw';
    if (res === '*' || !res) return 'ongoing';
    const won = (g.mine === 'w' && res === '1-0') || (g.mine === 'b' && res === '0-1');
    return won ? 'win' : 'loss';
  }
  function renderLibrary() {
    const body = $('lib-body');
    const f = S.libFilter || 'all';
    const shown = S.games.map((g, i) => ({ g, i })).filter((x) => f === 'all' || resultCat(x.g) === f);
    $('lib-count').textContent = S.games.length + ' 局' +
      (f !== 'all' ? ' · 筛出 ' + shown.length : '');
    const emptyMsg = $('lib-empty');
    emptyMsg.style.display = shown.length ? 'none' : '';
    if (!shown.length && S.games.length) emptyMsg.textContent = '没有符合当前筛选的棋谱（' + { win: '我胜', loss: '我负', draw: '和棋', ongoing: '进行中 / 未知' }[f] + '）。';
    else emptyMsg.textContent = '尚无棋谱。从上方任一入口导入，或载入示例。';
    body.innerHTML = shown.map(({ g, i }) => {
      const res = g.headers.Result || '*';
      const opening = (g.headers.Opening || '') + (g.headers.ECO ? ' [' + g.headers.ECO + ']' : '');
      /* 结果列：下拉可改（导入自动判定 / PGN 头之外的来源都可手动设置输赢） */
      const won = (g.mine === 'w' && res === '1-0') || (g.mine === 'b' && res === '0-1');
      const rCls = res === '1/2-1/2' ? 'r-draw' : (res === '*' ? 'r-ongoing' : (won ? 'r-win' : 'r-loss'));
      const resOpts = [
        { v: '*', t: '进行中' },
        { v: '1-0', t: '1-0 白胜' },
        { v: '0-1', t: '0-1 黑胜' },
        { v: '1/2-1/2', t: '和棋' }
      ].map((o) => '<option value="' + o.v + '"' + (o.v === res ? ' selected' : '') + '>' + o.t + '</option>').join('');
      return '<tr>' +
        '<td class="mono">' + (i + 1) + '</td>' +
        '<td><div class="lib-players" title="' + esc(g.headers.White) + ' vs ' + esc(g.headers.Black) + '">' + esc(g.headers.White || '?') + ' <span class="mono">vs</span> ' + esc(g.headers.Black || '?') + '</div></td>' +
        '<td><select class="result-sel ' + rCls + '" data-res="' + g.id + '" title="手动设置对局结果">' + resOpts + '</select></td>' +
        '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(opening) + '">' + esc(opening || '—') + '</td>' +
        '<td class="mono" style="max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(g.sourceLabel) + '">' + esc(g.sourceLabel) + '</td>' +
        '<td><select class="mine-sel" data-mine="' + g.id + '"><option value="w"' + (g.mine === 'w' ? ' selected' : '') + '>执白</option><option value="b"' + (g.mine === 'b' ? ' selected' : '') + '>执黑</option></select></td>' +
        '<td>' + (g.analyzed ? '<span class="badge ok">✓ 深度' + g.analysis.depth + '</span>' : '<span class="badge">未分析</span>') + '</td>' +
        '<td><div class="lib-status"><button class="btn ghost" data-open="' + g.id + '">打开</button><button class="btn ghost" data-del="' + g.id + '" title="删除">✕</button></div></td>' +
        '</tr>';
    }).join('');
  }
  function renderCounts() {
    $('cnt-games').textContent = S.games.length || '';
    $('cnt-analyzed').textContent = S.games.filter((g) => g.analyzed).length || '';
  }

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const FILES = 'abcdefgh'.split('');

  /** 有效着法序列 = 主线前缀 + 当前变着 */
  function effMoves() {
    const g = curGame();
    if (!g) return [];
    if (S.var) return g.moves.slice(0, S.var.from).concat(S.var.moves);
    return g.moves;
  }
  const effLen = () => effMoves().length;

  function fenAtCursor() {
    const g = curGame();
    if (!g) return START_FEN;
    const p = Math.min(S.ply, effLen());
    if (S.var && p > S.var.from) return S.var.moves[p - S.var.from - 1].fenAfter;
    const pos = positionsOf(g);
    return pos[Math.min(p, pos.length - 1)];
  }
  function moveAtCursor() {
    const p = Math.min(S.ply, effLen());
    return p > 0 ? (effMoves()[p - 1] || null) : null;
  }
  /** 被将军的王所在格（lichess 红色径向渐变） */
  function checkSqOf(fen) {
    try {
      const c = new Chess(fen);
      if (!c.in_check()) return null;
      const turn = c.turn();
      const rows = fen.split(' ')[0].split('/');
      for (let ri = 0; ri < 8; ri++) {
        let fi = 0;
        for (const ch of rows[ri]) {
          if (/\d/.test(ch)) { fi += +ch; continue; }
          if (ch.toLowerCase() === 'k' && (ch === 'K' ? 'w' : 'b') === turn) return FILES[fi] + (8 - ri);
          fi++;
        }
      }
    } catch (e) { /* 非法局面忽略 */ }
    return null;
  }
  /** 某格棋子的可走目标（lichess 绿点 / 吃子圆环） */
  function destsOf(fen, sq) {
    const map = {};
    try {
      const c = new Chess(fen);
      c.moves({ square: sq, verbose: true }).forEach((m) => { map[m.to] = m.captured ? 'capture' : 'move'; });
    } catch (e) { /* 非法局面忽略 */ }
    return map;
  }
  /** 分析面板最佳着法箭头（lichess：绿 = 第 1 线，蓝 = 第 2 线）。
      批量分析期间强制关闭：箭头只属于实时面板，不得串到正在查看的棋盘上 */
  function bestArrows() {
    if (!S.liveOn || !S.liveArrowOn || !S.live || S.busy) return null;
    return (S.live.lines || []).filter((l) => l.pv && l.pv[0]).slice(0, 2).map((l, i) => ({
      from: l.pv[0].slice(0, 2), to: l.pv[0].slice(2, 4),
      color: i === 0 ? 'rgba(110,138,87,.9)' : 'rgba(106,122,138,.8)'
    }));
  }

  function renderBoard() {
    const board = $('board');
    const g = curGame();
    if (!g) { CLBoard.clear(board); return; }
    const fen = fenAtCursor();
    const last = moveAtCursor();
    let ring = null;
    if (last && g.evalResult && last.color === g.mine && (!S.var || S.ply <= S.var.from)) {
      const ev = g.evalResult.moveEvals[S.ply - 1];
      if (ev && ['blunder', 'mistake', 'inaccuracy', 'best'].includes(ev.cls)) ring = { sq: last.uci.slice(2, 4), cls: ev.cls };
    }
    /* chessground 式交互：行棋方棋子可拖拽（grab 光标），拖拽目标即点选目标，
       松手落子与点击走子走同一条路（playMove → 变着/前进逻辑不变） */
    const turn = sideToMove(fen);
    CLBoard.render(board, {
      fen: fen, flip: S.flip,
      lastMove: last ? [last.uci.slice(0, 2), last.uci.slice(2, 4)] : null,
      checkSq: checkSqOf(fen),
      selSq: S.sel,
      dests: S.sel ? destsOf(fen, S.sel) : null,
      ring: ring, arrows: bestArrows(),
      turnColor: turn,
      movableSq: (sq) => { const m = CLBoard.parseFenBoard(fen); return !!m[sq] && m[sq][0] === turn; },
      destsOf: (sq) => destsOf(fen, sq),
      onDrop: (from, to) => tryPlayMove(from, to),
      onSquareClick: onBoardSquare,
      onSquareRightClick: () => { S.sel = null; renderBoard(); }
    });
    renderEvalBar(fen);
    // 棋盘重渲染会重建 DOM（board.js innerHTML），若升变待选则重新挂载选择器
    if (S.promo) renderPromoPicker();
  }

  function whiteCpAt(g, p) {
    const pos = positionsOf(g);
    const sc = g.analysis.plies[p].score;
    const cp = CLEngine.scoreToCp(sc);
    return sideToMove(pos[p]) === 'w' ? cp : -cp;
  }
  /** 引擎评分 → 白方视角显示文本（+1.2 / -M3） */
  function evalTextFromScore(score, mover) {
    if (!score) return '—';
    if (score.mate !== undefined) {
      const whiteMates = (mover === 'w') === (score.mate > 0);
      return (whiteMates ? '+' : '−') + 'M' + Math.abs(score.mate);
    }
    const cpWhite = mover === 'w' ? (score.cp || 0) : -(score.cp || 0);
    return (cpWhite > 0 ? '+' : '') + (cpWhite / 100).toFixed(2).replace(/0$/, '');
  }
  function renderEvalBar(fen) {
    const g = curGame();
    let wPct = 50, num = '—', color = 'var(--muted)';
    if (g && g.analysis && (!S.var || S.ply <= S.var.from)) {
      const p = Math.min(S.ply, g.analysis.plies.length - 1);
      const cpW = whiteCpAt(g, p);
      wPct = wp(cpW);
      num = evalTextFromScore(g.analysis.plies[p].score, sideToMove(positionsOf(g)[p]));
      color = cpW >= 0 ? 'var(--ink)' : 'var(--c-blunder)';
    } else if (S.liveOn && !S.busy && S.live && S.live.lines.length && S.live.curFen === fen) {
      const l = S.live.lines[0];
      const cpM = CLEngine.scoreToCp(l.score);
      const cpW = sideToMove(fen) === 'w' ? cpM : -cpM;
      wPct = wp(cpW);
      num = evalTextFromScore(l.score, sideToMove(fen));
      color = cpW >= 0 ? 'var(--ink)' : 'var(--c-blunder)';
    }
    $('eval-fill').style.height = wPct.toFixed(1) + '%';
    const el = $('eval-num');
    el.textContent = num === '—' ? '—（白方）' : num + '（白方）';
    el.style.color = color;
  }

  function onBoardSquare(sq) {
    const g = curGame();
    if (!g) return;
    const fen = fenAtCursor();
    const map = CLBoard.parseFenBoard(fen);
    if (S.sel) {
      if (sq === S.sel) { S.sel = null; renderBoard(); return; }
      if (destsOf(fen, S.sel)[sq]) { tryPlayMove(S.sel, sq); return; }
    }
    S.sel = (map[sq] && map[sq][0] === sideToMove(fen)) ? sq : null;
    renderBoard();
  }
  function tryPlayMove(from, to) {
    const g = curGame();
    if (!g) return;
    const fen = fenAtCursor();
    let piece = null;
    try { const c = new Chess(fen); piece = c.get(from); } catch (e) { /* 非法局面 */ }
    const lastRank = piece && piece.color === 'w' ? '8' : '1';
    if (piece && piece.type === 'p' && to[1] === lastRank) {
      S.promo = { from: from, to: to, fen: fen };
      renderPromoPicker();
      return;
    }
    playMove(from, to, 'q', fen);
  }
  /** 棋盘走子（分析界面直接点选行棋，lichess 同款）。
      规则：走子只写入变着（S.var），主线 g.moves 永不被改写——
      与主线一致的着法仅是“前进”，其余一律进入变着；
      自定义局面开局（研究章节 FEN 起始 / 0 着局面）的探索着法也因此全部记录为变着 */
  function playMove(from, to, promo, fenBefore) {
    let mv = null, fenAfter = null;
    try {
      const c = new Chess(fenBefore);
      mv = c.move({ from: from, to: to, promotion: promo || undefined });
      if (mv) fenAfter = c.fen();   // 本版 chess.js 无 mv.after，走子后取实例 FEN
    } catch (e) { mv = null; }
    if (!mv) { S.sel = null; renderBoard(); return; }
    const rec = { san: mv.san, uci: mv.from + mv.to + (mv.promotion || ''), color: mv.color, fenAfter: fenAfter };
    const eff = effMoves();
    const p = Math.min(S.ply, eff.length);
    if (p < eff.length && eff[p].uci === rec.uci) {
      S.ply = p + 1;                                 // 与当前线路一致 → 前进
    } else if (S.var && p > S.var.from) {
      S.var.moves = S.var.moves.slice(0, p - S.var.from).concat([rec]);   // 变着延长/改写
      S.ply = p + 1;
    } else {
      S.var = { from: p, moves: [rec] };             // 脱离主线 → 新变着
      S.ply = p + 1;
    }
    S.sel = null; S.promo = null;
    hidePromoPicker();
    renderBoard(); renderPlyLabel(); renderMovelist(true); renderMoveDetail();
    liveSync();
  }
  function setPly(p) {
    const g = curGame();
    if (!g) return;
    S.ply = Math.max(0, Math.min(p, effLen()));
    S.sel = null; S.promo = null;
    hidePromoPicker();
    renderBoard(); renderPlyLabel(); renderMovelist(true); renderMoveDetail();
    liveSync();
  }
  /** 点击主线着法：若点在变着分叉之后则退出变着 */
  function setPlyMain(p) {
    if (S.var && p > S.var.from) S.var = null;
    setPly(p);
  }
  /** 升变选择器：Lichess 风格，紧贴目标格纵向弹出
      白方升变（目标 rank 8）→ 目标格上方，顺序 q,n,r,b（后在最上，象紧贴格子）
      黑方升变（目标 rank 1）→ 目标格下方，顺序 b,r,n,q（象紧贴格子，后在最下）
      每个选项是灰色圆形棋子，整体位于棋盘容器内 */
  function renderPromoPicker() {
    hidePromoPicker();
    if (!S.promo) return;
    // 找到棋盘容器（board.js 创建时设置了 position: relative）
    const board = document.querySelector('#board');
    if (!board) return;
    // 找到升变目标格元素（data-sq="e8" 这样的属性）
    const targetCell = board.querySelector('[data-sq="' + S.promo.to + '"]');
    if (!targetCell) return;
    const color = sideToMove(S.promo.fen);
    const rank = S.promo.to[1];           // 目标格的行号（'8' 或 '1'）
    const upward = rank === '8';          // true=向上弹（白方），false=向下弹（黑方）
    // 升变顺序：白方 q→n→r→b（后在上象贴格）；黑方倒序 b→r→n→q（象贴格后在下）
    const order = upward ? ['q', 'n', 'r', 'b'] : ['b', 'r', 'n', 'q'];
    const rankNames = { q: '后', n: '马', r: '车', b: '象' };
    const div = document.createElement('div');
    div.id = 'promo-picker';
    div.className = upward ? 'promo-picker upward' : 'promo-picker downward';
    div.innerHTML = order.map((p) =>
      '<button class="promo-btn" data-promo="' + p + '" title="升变为 ' + rankNames[p] + '"><div class="piece ' + color + p + '"></div></button>'
    ).join('');
    board.appendChild(div);
    // 把 picker 覆盖到目标格所在列上（棋盘内部，Lichess 同款）：
    // .board 有 overflow:hidden，绝不能定位到棋盘外，否则会被裁剪不可见。
    // 白方升变（rank 8）→ 顶部对齐目标格，向下覆盖 4 格（q,n,r,b）
    // 黑方升变（rank 1）→ 底部对齐目标格，向上覆盖 4 格（b,r,n,q，后贴目标格）
    requestAnimationFrame(() => {
      const cRect = targetCell.getBoundingClientRect();
      const bRect = board.getBoundingClientRect();
      const cell = cRect.width;              // 格子边长（按钮同尺寸，精确覆盖整列）
      // 按钮尺寸 = 格子尺寸，棋子内边距按比例
      div.querySelectorAll('.promo-btn').forEach((b) => {
        b.style.width = cell + 'px';
        b.style.height = cell + 'px';
      });
      const totalH = cell * 4;
      // 水平：与目标格整列对齐
      const left = cRect.left - bRect.left;
      // 垂直：白方→picker 顶边贴目标格顶边（向下延伸）；
      //       黑方→picker 底边贴目标格底边（向上延伸）
      const top = upward
        ? cRect.top - bRect.top
        : cRect.bottom - bRect.top - totalH;
      div.style.left = left + 'px';
      div.style.top = top + 'px';
    });
    // 点击任意棋子选项 → 完成升变
    div.addEventListener('click', (e) => {
      const b = e.target.closest('[data-promo]');
      if (!b) return;
      const { from, to, fen } = S.promo;
      S.promo = null;
      playMove(from, to, b.dataset.promo, fen);
    });
    // 点击 picker 外部 / 棋盘上其他位置 → 关闭选择器
    setTimeout(() => {   // 下一帧绑定，避免触发本次点击的冒泡
      document.addEventListener('click', onPromoOutsideClose, { once: true });
      document.addEventListener('keydown', onPromoEscClose, { once: true });
    }, 0);
  }
  /** 点击升变选择器外部时关闭（棋盘本身、空白区等） */
  function onPromoOutsideClose(e) {
    const p = document.getElementById('promo-picker');
    if (p && !p.contains(e.target)) {
      S.promo = null;
      hidePromoPicker(); renderBoard();
    } else if (p && p.contains(e.target)) {
      // 点击了 picker 内部但没点到按钮（概率低），不拦截
      document.addEventListener('click', onPromoOutsideClose, { once: true });
      return;
    } else {
      // picker 已不存在，不处理
    }
  }
  /** 按 ESC 关闭升变选择器 */
  function onPromoEscClose(e) {
    if (e.key === 'Escape') {
      S.promo = null;
      hidePromoPicker(); renderBoard();
    } else {
      document.addEventListener('keydown', onPromoEscClose, { once: true });
    }
  }
  function hidePromoPicker() {
    const p = document.getElementById('promo-picker');
    if (p) p.remove();
    // 清除可能残留的外部点击监听
    document.removeEventListener('click', onPromoOutsideClose);
    document.removeEventListener('keydown', onPromoEscClose);
  }

  function renderPlyLabel() {
    const g = curGame();
    if (!g) { $('ply-label').textContent = '—'; $('cur-san').textContent = ''; return; }
    const mv = Math.floor(S.ply / 2) + 1;
    $('ply-label').textContent = S.ply === 0 ? '起始局面' : '第 ' + mv + ' 回合 · 第 ' + S.ply + ' 着' + (S.var && S.ply > S.var.from ? '（变着）' : '');
    /* 当前着法条（lichess 式：棋盘正下方显示当前 SAN） */
    const cur = moveAtCursor();
    const sanEl = $('cur-san');
    sanEl.textContent = cur ? cur.san : '';
    sanEl.classList.toggle('var', !!(S.var && S.ply > S.var.from));
  }

  function renderMovelist(scroll) {
    const box = $('movelist');
    const g = curGame();
    if (!g) { box.innerHTML = ''; return; }
    $('movelist-badge').textContent = g.analyzed
      ? ('已分析 · 深度' + g.analysis.depth + (g.moveComments ? ' · AI 已点评' : ''))
      : '未分析';
    $('movelist-badge').className = 'badge' + (g.analyzed ? ' ok' : '');
    let html = '';
    for (let i = 0; i < g.moves.length; i += 2) {
      html += '<span class="mv-no">' + (i / 2 + 1) + '.</span>';
      html += mvCell(g, i);
      html += mvCell(g, i + 1);
    }
    if (!g.moves.length) html = '<span class="hint dim">此局从自定义局面开始（主线无着法）。在棋盘上直接走子，着法将自动记录为变着进行探索。</span>';
    box.innerHTML = html;
    /* 变着区（lichess 式：主线之下显示探索线路） */
    const varWrap = document.getElementById('var-list');
    if (varWrap) varWrap.remove();
    if (S.var && S.var.moves.length) {
      const el = document.createElement('div');
      el.id = 'var-list';
      el.className = 'var-list';
      let vh = '<div class="var-head">变着探索 <button class="btn ghost mini" id="btn-drop-var" title="放弃变着，回到主线">✕ 退出变着</button></div><div class="var-moves">';
      S.var.moves.forEach((m, j) => {
        const mainPly = S.var.from + j;
        const no = Math.floor(mainPly / 2) + 1;
        const isWhite = mainPly % 2 === 0;
        const showNo = j === 0 || isWhite;
        vh += (showNo ? '<span class="mv-no">' + no + (isWhite ? '.' : '…') + '</span>' : '') +
          '<span class="mv var' + (S.ply === mainPly + 1 ? ' cur' : '') + '" data-vply="' + (mainPly + 1) + '">' + esc(m.san) + '</span>';
      });
      vh += '</div>';
      el.innerHTML = vh;
      box.appendChild(el);
      const drop = el.querySelector('#btn-drop-var');
      if (drop) drop.addEventListener('click', () => {
        S.var = null;
        S.ply = Math.min(S.ply, curGame().moves.length);
        renderBoard(); renderPlyLabel(); renderMovelist(true); renderMoveDetail(); liveSync();
      });
    }
    if (scroll) {
      const cur = box.querySelector('.mv.cur');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    }
  }
  /* lichess 式着法标注符号（NAG）：最佳/优秀 ! · 失当 ?! · 失误 ? · 大错 ?? */
  const NAG = { best: '!', excellent: '!', good: '', book: '', inaccuracy: '?!', mistake: '?', blunder: '??' };
  /** 第 i 着走完后的白方视角评估文本（用于着法列表，lichess 同款）。
      v2：优先用同一次 MultiPV 搜索里实际着法那条线的评分，与胜率变化口径一致 */
  function mvEvalText(g, i) {
    if (!g.analysis || !g.analysis.plies) return '';
    const pl = g.analysis.plies[i];
    const mv = g.moves[i];
    if (pl && pl.alts) {
      const hit = (pl.bestmove && mv.uci === pl.bestmove) ? { score: pl.score } : pl.alts.find((a) => a.uci === mv.uci);
      if (hit) return evalTextFromScore(hit.score, mv.color);
    }
    if (!g.analysis.plies[i + 1]) return '';
    return evalTextFromScore(g.analysis.plies[i + 1].score, mv.color === 'w' ? 'b' : 'w');
  }
  function mvCell(g, i) {
    if (i >= g.moves.length) return '<span></span>';
    const mv = g.moves[i];
    let dot = '', dwp = '', glyph = '', evTxt = '', cmt = '';
    if (g.evalResult) {
      const ev = g.evalResult.moveEvals[i];
      dot = '<span class="cd" style="background:' + CLS[ev.cls].color + '"></span>';
      if (NAG[ev.cls]) glyph = '<span class="glyph g-' + ev.cls + '">' + NAG[ev.cls] + '</span>';
      if (ev.dwp >= 0.5) dwp = '<span class="dwp">-' + ev.dwp.toFixed(1) + '%</span>';
      evTxt = '<span class="ev">' + esc(mvEvalText(g, i) || '') + '</span>';
      const cm = g.moveComments && g.moveComments[i + 1];
      if (cm) cmt = '<span class="mvc">💬 ' + esc(cm) + '</span>';
    }
    // 变着激活时，分叉点之后的主线着法淡化显示
    const beyondVar = S.var && (i + 1) > S.var.from;
    const inVarZone = S.var && S.ply > S.var.from;
    const cur = (S.ply === i + 1 && !inVarZone) ? ' cur' : '';
    const dimmed = beyondVar ? ' dim' : '';
    const title = g.evalResult
      ? CLS[g.evalResult.moveEvals[i].cls].label + '，胜率变化 -' + g.evalResult.moveEvals[i].dwp.toFixed(1) + '%' +
        (g.moveComments && g.moveComments[i + 1] ? '\n' + g.moveComments[i + 1] : '')
      : mv.san;
    return '<span class="mv' + cur + dimmed + '" data-ply="' + (i + 1) + '" title="' + esc(title) + '">' + dot + '<span class="san">' + esc(mv.san) + '</span>' + glyph + evTxt + dwp + cmt + '</span>';
  }

  function renderMoveDetail() {
    const box = $('move-detail');
    const g = curGame();
    if (!g) { box.innerHTML = '<p class="hint dim">点击左侧着法查看引擎评估、推荐着法与胜率变化。</p>'; return; }
    const pos = positionsOf(g);
    /* 变着区：主线引擎统计不适用，显示变着信息 */
    if (S.var && S.ply > S.var.from) {
      const j = S.ply - S.var.from - 1;
      const mv = S.var.moves[j];
      if (!mv) { box.innerHTML = '<p class="hint dim">—</p>'; return; }
      const fenBefore = j === 0 ? pos[Math.min(S.var.from, pos.length - 1)] : S.var.moves[j - 1].fenAfter;
      const best = S.liveOn && S.live && S.live.lines[0] ? uciToSan(fenBefore, S.live.lines[0].pv[0]) : null;
      box.innerHTML = '<dl>' +
        '<dt>着法</dt><dd><b>' + esc(mv.san) + '</b> <span class="cls-tag" style="background:#7C9084">变着</span> <span style="color:var(--muted)">（你在主线之外的探索）</span></dd>' +
        '<dt>走子方</dt><dd>' + (mv.color === 'w' ? '白方' : '黑方') + '</dd>' +
        (best ? '<dt>引擎推荐</dt><dd>' + esc(best) + '</dd>' : '<dt>引擎推荐</dt><dd><span style="color:var(--muted)">打开「分析面板」开关即可实时评估变着</span></dd>') +
        '</dl><p class="fen-line">' + esc(mv.fenAfter) + '</p>';
      return;
    }
    if (!g.analysis) { box.innerHTML = '<p class="hint dim">点击左侧着法查看引擎评估、推荐着法与胜率变化。</p>'; return; }
    if (S.ply === 0) {
      const pl = g.analysis.plies[0];
      const best = uciToSan(pos[0], pl.bestmove);
      box.innerHTML = '<dl>' +
        '<dt>局面</dt><dd>起始局面 · ' + (sideToMove(pos[0]) === 'w' ? '白方行棋' : '黑方行棋') + '</dd>' +
        '<dt>初始评估</dt><dd>' + fmtCpMover(CLEngine.scoreToCp(pl.score)) + '（行棋方视角）</dd>' +
        '<dt>引擎推荐</dt><dd>' + esc(best || '—') + (pl.pv && pl.pv.length ? '（' + esc(pvToSanStr(pos[0], pl.pv)) + '）' : '') + '</dd>' +
        '</dl><p class="fen-line">' + esc(pos[0]) + '</p>';
      return;
    }
    const i = S.ply - 1;
    const mv = g.moves[i], ev = g.evalResult.moveEvals[i];
    const pl = g.analysis.plies[i];
    const bestSan = uciToSan(pos[i], pl.bestmove);
    const clsTag = '<span class="cls-tag" style="background:' + CLS[ev.cls].color + '">' + CLS[ev.cls].label + '</span>';
    const cm = g.moveComments && g.moveComments[S.ply];
    /* 修正错误：我方的失当/失误/大错着法，且有引擎推荐时可一键替换 */
    const fixable = !S.var && mv.color === g.mine && pl.bestmove &&
      ['inaccuracy', 'mistake', 'blunder'].includes(ev.cls);
    const fixBtn = fixable
      ? '<div class="fix-row"><button class="btn mini warn" id="btn-fix-move" title="用引擎推荐着法替换这一着（后续着法将截断，并自动重新分析）">✎ 改为最佳着法 ' + esc(bestSan || '') + '（修正错误）</button></div>'
      : '';
    box.innerHTML = '<dl>' +
      '<dt>着法</dt><dd><b>' + esc(mv.san) + '</b> ' + clsTag + ' <span style="color:var(--muted)">（' + (mv.color === 'w' ? '白' : '黑') + ' · ' + PHASE_LABEL[ev.phase] + (ev.isBest ? ' · 与引擎一致' : '') + '）</span></dd>' +
      '<dt>走前评估</dt><dd>' + fmtCpMover(ev.cpB) + '</dd>' +
      '<dt>走后评估</dt><dd>' + fmtCpMover(ev.cpA) + '</dd>' +
      '<dt>胜率变化</dt><dd>' + fmt1(ev.wpB) + '% → ' + fmt1(ev.wpA) + '% <span style="color:' + (ev.dwp >= 20 ? 'var(--c-blunder)' : ev.dwp >= 10 ? 'var(--c-mistake)' : ev.dwp >= 5 ? 'var(--c-inaccuracy)' : 'var(--c-best)') + '">（-' + fmt1(ev.dwp) + '%）</span></dd>' +
      '<dt>引擎推荐</dt><dd>' + esc(bestSan || '—') + (pl.pv && pl.pv.length ? ' <span style="color:var(--muted)">主线：' + esc(pvToSanStr(pos[i], pl.pv)) + '</span>' : '') + '</dd>' +
      (cm ? '<dt>教练点评</dt><dd class="coach-cmt">' + esc(cm) + '</dd>' : '') +
      '</dl>' + fixBtn + '<p class="fen-line">' + esc(pos[i]) + '</p>';
  }
  function fmtCpMover(cp) {
    if (cp >= 1100) return '必胜（杀王）';
    if (cp <= -1100) return '必败（被杀）';
    return (cp > 0 ? '+' : '') + (cp / 100).toFixed(2);
  }

  function fixMove() {
    const g = curGame();
    if (!g || !g.analysis || S.ply === 0 || S.var) return;
    const i = S.ply - 1;
    const mv = g.moves[i], pl = g.analysis.plies[i];
    if (!pl || !pl.bestmove) return toast('该局面没有引擎推荐着法', 'err');
    const pos = positionsOf(g);
    let rec = null;
    try {
      const c = new Chess(pos[i]);
      const m = c.move({ from: pl.bestmove.slice(0, 2), to: pl.bestmove.slice(2, 4), promotion: pl.bestmove[4] || undefined });
      rec = { san: m.san, uci: m.from + m.to + (m.promotion || ''), color: m.color, fenAfter: c.fen() };   // 走子后取实例 FEN
    } catch (e) { return toast('引擎推荐着法无法应用到该局面', 'err'); }
    if (!rec) return;
    const oldSan = mv.san;
    g.moves = g.moves.slice(0, i).concat([rec]);      // 替换错误着，后续截断
    g.analyzed = false; g.analysis = null; g.evalResult = null;
    g.narration = null; g.moveComments = null;         // 旧解说/点评随线路变化作废
    persist();
    S.ply = i + 1; S.var = null; S.sel = null;
    renderAnalyzeView();
    toast('已修正：' + oldSan + ' → ' + rec.san + '，后续着法已截断，正在重新分析…', 'ok');
    analyzeGames([g], S.settings.depth);               // 修正后自动重新分析 + AI 点评
  }

  function renderGameStats() {
    const box = $('game-stats');
    const g = curGame();
    if (!g || !g.evalResult) {
      $('stats-badge').textContent = '未分析'; $('stats-badge').className = 'badge';
      box.innerHTML = '<p class="hint dim">分析后显示准确率、ACPL 与失误分布。</p>';
      $('eval-graph-wrap').style.display = 'none';
      return;
    }
    $('stats-badge').textContent = '我方视角 · ' + (g.mine === 'w' ? '执白' : '执黑');
    $('stats-badge').className = 'badge ok';
    const st = g.evalResult.stats;
    const cards = [
      ['准确率', fmt1(st.accuracy) + '<small>%</small>', 'Lichess 同款公式'],
      ['ACPL', fmt0(st.acpl) + '<small>cp</small>', '平均每着损失'],
      ['最佳/优秀', (st.counts.best + st.counts.excellent) + '<small>着</small>', '与引擎一致或近似'],
      ['失当', st.counts.inaccuracy + '<small>着</small>', '胜率降 5–10%'],
      ['失误', st.counts.mistake + '<small>着</small>', '胜率降 10–20%'],
      ['大错', st.counts.blunder + '<small>着</small>', '胜率降 ≥20%'],
      ['开局 ACPL', fmt0(st.phaseStats.opening.acpl) + '<small>cp</small>', st.phaseStats.opening.n + ' 着'],
      ['中局 ACPL', fmt0(st.phaseStats.middlegame.acpl) + '<small>cp</small>', st.phaseStats.middlegame.n + ' 着'],
      ['残局 ACPL', fmt0(st.phaseStats.endgame.acpl) + '<small>cp</small>', st.phaseStats.endgame.n + ' 着']
    ];
    box.innerHTML = cards.map((c) => '<div class="stat"><div class="num">' + c[1] + '</div><div class="label">' + c[0] + ' · ' + c[2] + '</div></div>').join('');
    renderEvalGraph(g);
  }
  function renderEvalGraph(g) {
    const wrap = $('eval-graph-wrap'), svg = $('eval-graph');
    if (!g.analysis) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const pos = positionsOf(g);
    const n = g.analysis.plies.length;
    const pts = [];
    for (let p = 0; p < n; p++) {
      const x = 600 * (n > 1 ? p / (n - 1) : 0);
      const y = 120 - wp(whiteCpAt(g, p)) * 1.2;
      pts.push([x, y]);
    }
    const line = pts.map((pt, i) => (i ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
    let dots = '';
    for (let p = 1; p < g.moves.length + 1; p++) {
      if (g.moves[p - 1].color !== g.mine) continue;
      const ev = g.evalResult.moveEvals[p - 1];
      if (ev.cls !== 'blunder' && ev.cls !== 'mistake') continue;
      const x = 600 * (n > 1 ? p / (n - 1) : 0);
      const y = 120 - wp(whiteCpAt(g, p)) * 1.2;
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.4" fill="' + (ev.cls === 'blunder' ? '#A65951' : '#A56B42') + '"/>';
    }
    svg.innerHTML =
      '<line x1="0" y1="60" x2="600" y2="60" stroke="#B3AC9C" stroke-dasharray="4 4"/>' +
      '<path d="' + line + ' L600 120 L0 120 Z" fill="rgba(168,123,92,.14)"/>' +
      '<path d="' + line + '" fill="none" stroke="#A87B5C" stroke-width="1.8"/>' + dots;
    svg.onclick = (e) => {
      const r = svg.getBoundingClientRect();
      const ratio = (e.clientX - r.left) / r.width;
      setPly(Math.round(ratio * (n - 1)));
    };
  }

  function renderAnalyzeView() {
    const empty = $('analyze-empty'), main = $('analyze-main');
    if (!S.games.length) { empty.style.display = ''; main.style.display = 'none'; return; }
    empty.style.display = 'none'; main.style.display = '';
    if (S.cur < 0 || S.cur >= S.games.length) S.cur = 0;
    const sel = $('game-select');
    sel.innerHTML = S.games.map((g, i) => '<option value="' + i + '"' + (i === S.cur ? ' selected' : '') + '>' + esc(gameLabel(g, i)) + '</option>').join('');
    const g = curGame();
    const meta = [];
    meta.push('<b>' + esc(g.headers.White || '白方') + '</b> vs <b>' + esc(g.headers.Black || '黑方') + '</b> · 结果 <b>' + esc(g.headers.Result || '*') + '</b>');
    if (g.headers.Opening) meta.push('开局 <span class="open-line">' + esc(g.headers.Opening) + (g.headers.ECO ? ' [' + esc(g.headers.ECO) + ']' : '') + '</span>');
    if (g.headers.Date) meta.push(esc(g.headers.Date));
    meta.push('视角：<b>' + (g.mine === 'w' ? '执白' : '执黑') + '</b>');
    $('game-meta').innerHTML = meta.join(' · ');
    S.ply = Math.min(S.ply, effLen());
    renderBoard(); renderPlyLabel(); renderMovelist(); renderMoveDetail(); renderGameStats();
    /* 分析面板控件状态 */
    $('live-toggle').checked = S.liveOn;
    $('live-multipv').value = String(S.settings.liveMultipv);
    $('live-depth').value = String(S.settings.liveDepth);
    $('live-arrow').checked = S.liveArrowOn;
    updateLiveBadge();
    renderLiveLines();
    liveSync();
    if (g.narration) { $('narration').innerHTML = mdToHtml(g.narration); $('llm-badge').textContent = '已生成'; $('llm-badge').className = 'badge ok'; }
    else { $('narration').innerHTML = '<p class="hint dim">在「设置」中配置大模型 API（DeepSeek / 通义 / OpenAI 兼容端点）。无 API 时可用「复制提示词」手动获取解说。</p>'; $('llm-badge').textContent = '未生成'; $('llm-badge').className = 'badge'; }
  }

  async function ensureLive() {
    const eng = await ensureEngine();
    if (!S.live) {
      S.live = new CLEngine.LiveEngine(eng);
      S.live.onUpdate = onLiveUpdate;
    }
    return S.live;
  }
  function liveSync() {
    /* 批量分析独占引擎：期间不启动实时面板（其评估与箭头也不上棋盘） */
    if (!S.liveOn || S.busy) return;
    ensureLive().then((live) => {
      live.start(fenAtCursor(), { multipv: S.settings.liveMultipv, depth: S.settings.liveDepth });
    }).catch((e) => {
      $('live-state').textContent = '引擎启动失败'; $('live-state').className = 'badge';
    });
  }
  function onLiveUpdate(state) {
    renderLiveLines();
    renderBoard();   // 刷新箭头与评估条
  }
  function updateLiveBadge() {
    const b = $('live-state');
    if (S.busy && S.liveOn) { b.textContent = '已暂停 · 批量分析中'; b.className = 'badge'; updateLiveEval(); return; }
    if (!S.liveOn) { b.textContent = '已关闭'; b.className = 'badge'; updateLiveEval(); return; }
    if (!S.live) { b.textContent = '启动中…'; b.className = 'badge busy'; updateLiveEval(); return; }
    if (S.live.running) { b.textContent = '分析中 · d' + (S.live.lines[0] ? S.live.lines[0].depth : 0); b.className = 'badge busy'; }
    else { b.textContent = S.live.lines.length ? '就绪 · d' + (S.live.lines[0] ? S.live.lines[0].depth : 0) : '计算中…'; b.className = 'badge ok'; }
    updateLiveEval();
  }
  /** 引擎头部大评估（lichess 式 +0.2）：取第 1 线评分，白方视角 */
  function updateLiveEval() {
    const el = $('live-eval');
    let txt = '—', cls = 'live-eval';
    if (S.liveOn && !S.busy && S.live && S.live.lines.length && S.live.curFen) {
      const l = S.live.lines[0];
      const mover = sideToMove(S.live.curFen);
      txt = evalTextFromScore(l.score, mover);
      const cpW = mover === 'w' ? CLEngine.scoreToCp(l.score) : -CLEngine.scoreToCp(l.score);
      cls += cpW >= 50 ? ' good' : (cpW <= -50 ? ' bad' : '');
    }
    el.textContent = txt;
    el.className = cls;
  }
  function renderLiveLines() {
    updateLiveBadge();
    const box = $('live-lines');
    if (S.busy) {
      box.innerHTML = '<p class="hint dim">批量分析进行中，实时面板已暂停——评估与箭头不会显示到当前棋盘上，分析结束后自动恢复。</p>';
      return;
    }
    if (!S.liveOn) {
      box.innerHTML = '<p class="hint dim">引擎已关闭——打开左上角开关即可评估当前局面（实时评分、候选线路、最佳着法箭头）。</p>';
      return;
    }
    if (!S.live || !S.live.lines.length) {
      box.innerHTML = '<p class="hint dim">' + (S.live && S.live.curFen ? '引擎计算中…' : '等待局面…') + '</p>';
      return;
    }
    const fen = S.live.curFen || fenAtCursor();
    const mover = sideToMove(fen);
    box.innerHTML = S.live.lines.map((l) => {
      const evalStr = evalTextFromScore(l.score, mover);
      const cpM = CLEngine.scoreToCp(l.score);
      const cpW = mover === 'w' ? cpM : -cpM;
      const cls = cpW >= 50 ? 'good' : (cpW <= -50 ? 'bad' : '');
      const sanPv = pvToSanStr(fen, l.pv);
      const first = l.pv[0] || '';
      return '<div class="lline" data-pv0="' + esc(first) + '" title="点击走这步棋">' +
        '<span class="leval ' + cls + '">' + esc(evalStr) + '</span>' +
        '<span class="lpv">' + esc(sanPv) + '</span>' +
        '<span class="ld">d' + l.depth + '</span>' +
        '</div>';
    }).join('') + '<p class="hint dim" style="margin-top:8px">点击任一线路即走该着；绿箭头 = 第 1 线，蓝箭头 = 第 2 线。评分白方视角。</p>';
  }

  async function ensureEngine() {
    if (S.engine) return S.engine;
    if (S.enginePromise) return S.enginePromise;
    const badge = $('engine-state');
    badge.textContent = '引擎启动中…';
    /* 候选引擎按优先级排列：优先 NNUE 新引擎（评估口径对齐 lichess 网站分析），
       加载失败（如浏览器过旧、文件缺失）时自动回退旧版 classical 构建 */
    const CANDIDATES = ['assets/vendor/stockfish-18-lite-single.js', 'assets/vendor/stockfish.js'];
    S.enginePromise = (async () => {
      let lastErr = null;
      for (const path of CANDIDATES) {
        const eng = new CLEngine.UciEngine(path);
        try {
          await eng.init();
          S.engine = eng;
          badge.textContent = '引擎就绪' + (eng.isNNUE ? ' · NNUE' : '');
          return eng;
        } catch (e) {
          lastErr = e;
          eng.destroy();
        }
      }
      badge.textContent = '引擎启动失败';
      S.enginePromise = null;
      throw lastErr;
    })();
    return S.enginePromise;
  }

  function setProgress(done, total, note) {
    const wrap = $('progress-wrap');
    if (done == null) { wrap.classList.add('hidden'); $('analysis-status').textContent = note || ''; return; }
    wrap.classList.remove('hidden');
    $('progress-fill').style.width = (100 * done / total).toFixed(1) + '%';
    $('analysis-status').textContent = note;
  }

  async function analyzeGames(targets, depth) {
    if (S.busy) return;
    if (!targets.length) { toast('没有需要分析的对局'); return; }
    S.busy = true; S.cancelAnalysis = false;
    /* 批量分析独占引擎：暂停实时分析面板并清空其残留线路，
       避免旧箭头 / 旧评估继续出现在用户正在查看的棋盘上 */
    if (S.live) {
      await S.live.stop(true);
      S.live.lines = []; S.live.curFen = null;
    }
    updateLiveBadge(); renderLiveLines();
    renderBoard();   // 清掉棋盘上的旧箭头（busy 期间 bestArrows 返回 null）
    $('btn-analyze').disabled = true; $('btn-analyze-all').disabled = true;
    $('btn-cancel').classList.remove('hidden');
    let done = 0;
    try {
      const eng = await ensureEngine();
      /* MultiPV 由 analyzeMulti 在每个局面自行设置（v2：同搜索对比最佳着与实际着法） */
      for (const g of targets) {
        if (S.cancelAnalysis) break;
        const label = (g.headers.White || '?') + ' vs ' + (g.headers.Black || '?');
        try {
          repairFenAfter(g); g._fenOk = true;          // 瘦身导入的对局：分析前重放补齐局面
          const result = await CLEngine.analyzeGame(eng, g, depth,
            (i, total, ms) => setProgress(done + i, totalAll(targets), '分析中：' + label + ' · 局面 ' + i + '/' + total + ' · ' + (ms / 1000).toFixed(0) + 's'),
            () => S.cancelAnalysis);
          g.analysis = result;
          g.evalResult = CLEngine.evalGame(g, result, g.mine);
          g.analyzed = true;
          persist();
          /* 分析完成 → 自动生成大语言模型着法点评（已配置 API 时），失败不阻塞 */
          if (S.settings.llm.apiKey && !S.cancelAnalysis) {
            try {
              setProgress(done + g.moves.length + 1, totalAll(targets), 'AI 教练正在生成着法点评：' + label);
              await narrateMoves(g);
            } catch (e) {
              toast('AI 着法点评失败（不影响引擎分析结果）：' + e.message, 'err');
            }
          }
        } catch (e) {
          if (e.message === 'cancelled') break;
          throw e;
        }
        done++;
      }
      const cmtNote = S.settings.llm.apiKey ? '，AI 点评已写入着法列表' : '';
      setProgress(null, 0, S.cancelAnalysis ? '已停止。已完成的分析已保存。' : '分析完成（深度 ' + depth + '）' + cmtNote + '。');
      renderLibrary(); renderCounts(); renderAnalyzeView();
      toast(S.cancelAnalysis ? '分析已停止' : '分析完成', 'ok');
    } catch (e) {
      setProgress(null, 0, '分析失败：' + e.message);
      toast('分析失败：' + e.message, 'err');
    } finally {
      S.busy = false;
      $('btn-analyze').disabled = false; $('btn-analyze-all').disabled = false;
      $('btn-cancel').classList.add('hidden');
      /* 批量分析结束：若实时面板原本开启，自动恢复对当前局面的评估 */
      updateLiveBadge(); renderLiveLines();
      liveSync();
    }
  }
  function totalAll(targets) { return targets.reduce((s, g) => s + g.moves.length + 1, 0); }

  async function llmChat(system, user) {
    const cfg = S.settings.llm;
    if (!cfg.apiKey) throw new Error('未配置 API Key');
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.4,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + '：' + (await res.text()).slice(0, 160));
    const j = await res.json();
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) throw new Error('响应中无内容');
    return content;
  }

  const SYS_COACH = '你是一位资深国际象棋教练，为「引擎 + 大模型」复盘工具生成中文解说。规则：严格依据提供的引擎数据（评估、胜率、分类、推荐着法、FEN），禁止编造数据中不存在的着法或评估；着法用标准代数记法(SAN)；面向业余棋手，解释要具体到局面要素（子力、王安全、开放线、兵形）；用简体中文 Markdown 输出，一级章节用 ##。';

  function buildNarrationPrompt(game) {
    const ev = game.evalResult, st = ev.stats, mine = st.mine;
    const h = game.headers;
    const movesJson = game.moves.map((m, i) => {
      if (m.color !== mine) return null;
      const e = ev.moveEvals[i];
      return { ply: i + 1, san: m.san, 分类: CLS[e.cls].label, 胜率损失: +e.dwp.toFixed(1), 与引擎一致: e.isBest };
    }).filter(Boolean);
    const critical = st.critical.map((c) => ({
      ply: c.ply + 1, 阶段: PHASE_LABEL[c.phase], fen: c.fenBefore,
      实走: c.san, 引擎推荐: c.bestmove ? (uciToSan(c.fenBefore, c.bestmove) || c.bestmove) : null,
      胜率: c.wpB.toFixed(1) + '% → ' + c.wpA.toFixed(1) + '%'
    }));
    const data = {
      对局: { 白方: h.White, 黑方: h.Black, 结果: h.Result, 开局: h.Opening, ECO: h.ECO, 分析对象执: mine === 'w' ? '白' : '黑' },
      总体: {
        准确率: +st.accuracy.toFixed(1), ACPL: Math.round(st.acpl),
        失当: st.counts.inaccuracy, 失误: st.counts.mistake, 大错: st.counts.blunder, 我方着数: st.nMoves
      },
      阶段ACPL: {
        开局: st.phaseStats.opening.acpl == null ? null : Math.round(st.phaseStats.opening.acpl),
        中局: st.phaseStats.middlegame.acpl == null ? null : Math.round(st.phaseStats.middlegame.acpl),
        残局: st.phaseStats.endgame.acpl == null ? null : Math.round(st.phaseStats.endgame.acpl)
      },
      我方逐着: movesJson,
      关键局面_按严重排序: critical
    };
    return '请基于以下引擎分析数据，为这局棋生成复盘解说。\n\n```json\n' + JSON.stringify(data, null, 1) + '\n```\n\n输出章节：\n## 总评\n（3-5 句，概括这局的质量、风格与胜负手）\n## 关键局面复盘\n（从「关键局面」中挑最重要的 3 个：局面背景、实走了什么、应走什么、为什么——讲清楚局面要素，让棋手下次能识别同类模式）\n## 阶段点评\n（开局/中局/残局各 1-2 句，引用阶段 ACPL 数据）\n## 训练建议\n（3-5 条具体可执行的练习，针对本局暴露的问题）';
  }

  function buildProfilePrompt(profile, games) {
    const ph = profile.phase;
    const phJ = {};
    for (const k of Object.keys(ph)) {
      phJ[PHASE_LABEL[k]] = {
        着数: ph[k].n, ACPL: ph[k].acpl == null ? null : Math.round(ph[k].acpl),
        准确率: ph[k].accuracy == null ? null : +ph[k].accuracy.toFixed(1),
        失当: ph[k].cnt.inaccuracy, 失误: ph[k].cnt.mistake, 大错: ph[k].cnt.blunder
      };
    }
    const data = {
      样本: { 局数: profile.nGames, 我方总着数: profile.totalMoves },
      总体: {
        /* 准确率可为 null（如仅含 0 着棋局时无我方着法样本），判空避免 toFixed 崩溃 */
        准确率: profile.accuracy == null ? null : +profile.accuracy.toFixed(1), ACPL: profile.acpl == null ? null : Math.round(profile.acpl),
        失当: profile.counts.inaccuracy, 失误: profile.counts.mistake, 大错: profile.counts.blunder,
        大错率: profile.totalMoves ? +(profile.counts.blunder / profile.totalMoves * 100).toFixed(1) + '%' : null
      },
      雷达维度_0到100: Object.fromEntries(profile.ranked.map((d) => [d.label, d.score])),
      阶段明细: phJ,
      开局战绩: Object.entries(profile.openings).sort((a, b) => b[1].games - a[1].games).slice(0, 10)
        .map(([k, v]) => ({ 开局: k, 局数: v.games, 胜: v.w, 和: v.d, 负: v.l, ACPL: v.cplN ? Math.round(v.cpl / v.cplN) : null, 大错: v.blunders })),
      对局列表: games.map((g) => ({ 白方: g.headers.White, 黑方: g.headers.Black, 结果: g.headers.Result, 开局: g.headers.Opening, 我方: g.mine === 'w' ? '白' : '黑', 准确率: g.evalResult.stats.accuracy == null ? null : +(g.evalResult.stats.accuracy).toFixed(1), 大错: g.evalResult.stats.counts.blunder }))
    };
    return '以下是同一名棋手多局对局的引擎聚合数据，请生成个性化诊断报告。\n\n```json\n' + JSON.stringify(data, null, 1) + '\n```\n\n输出章节：\n## 画像总评\n（概括棋手风格、水平定位与最突出的特征）\n## 短板归因\n（按数据指出最欠缺的 1-2 个方面，给出数据证据，并解释可能的原因）\n## 四周训练计划\n（每周一个主题，含具体练习内容与自检标准）\n## 建议补充\n（推荐的对局类型、开局方向或学习材料类型）';
  }

  const SYS_CMT = '你是资深国际象棋教练，为复盘工具生成简短的着法点评。严格依据引擎数据，禁止编造不存在的着法。只输出 JSON 对象，不要 Markdown 代码块或其他文字。';

  function buildMoveCommentsPrompt(game) {
    const ev = game.evalResult;
    /* 挑值得点评的着法：双方失当/失误/大错 + 我方前 2 步最佳着（示范），上限 16 条控制 token */
    const notable = [];
    game.moves.forEach((m, i) => {
      const e = ev.moveEvals[i];
      if (['inaccuracy', 'mistake', 'blunder'].includes(e.cls)) notable.push({ i, e, m });
    });
    const bests = game.moves
      .map((m, i) => ({ m, i, e: ev.moveEvals[i] }))
      .filter((x) => x.m.color === ev.stats.mine && (x.e.cls === 'best' || x.e.cls === 'excellent') && x.e.dwp < 2)
      .slice(0, 2);
    const items = []
      .concat(notable.sort((a, b) => b.e.dwp - a.e.dwp).slice(0, 14))
      .concat(bests)
      .sort((a, b) => a.i - b.i)
      .slice(0, 16);
    const pos = positionsOf(game);
    const data = items.map((x) => {
      const pl = game.analysis.plies[x.i];
      return {
        ply: x.i + 1,
        行棋方: x.m.color === 'w' ? '白' : '黑',
        着法: x.m.san,
        分类: CLS[x.e.cls].label,
        胜率变化: '-' + x.e.dwp.toFixed(1) + '%',
        引擎推荐: pl && pl.bestmove ? (uciToSan(pos[x.i], pl.bestmove) || pl.bestmove) : null,
        fen: pos[x.i]
      };
    });
    return '以下是一局棋中值得点评的着法（ply 为着法序号，从 1 开始）。为每一着写一句不超过 40 个汉字的中文点评：失当/失误/大错要指出问题与应走思路；最佳着简要肯定其作用。\n\n```json\n' + JSON.stringify(data, null, 1) + '\n```\n\n输出格式（ply 为键的字符串）：{"comments":{"1":"点评…","7":"点评…"}}，必须覆盖输入中的每一个 ply，不要新增。';
  }

  function parseCommentsJson(raw) {
    const txt = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s < 0 || e <= s) throw new Error('响应中没有 JSON 对象');
    const j = JSON.parse(txt.slice(s, e + 1));
    if (!j || typeof j.comments !== 'object') throw new Error('JSON 结构不符合要求');
    return j.comments;
  }

  async function narrateMoves(game) {
    if (!game.evalResult) return;
    const raw = await llmChat(SYS_CMT, buildMoveCommentsPrompt(game));
    const comments = parseCommentsJson(raw);
    /* 只保留输入范围内的 ply，防止幻觉 */
    const ok = {};
    Object.keys(comments).forEach((k) => {
      const p = +k;
      if (p >= 1 && p <= game.moves.length && typeof comments[k] === 'string' && comments[k].trim()) ok[p] = comments[k].trim().slice(0, 120);
    });
    if (!Object.keys(ok).length) throw new Error('未解析到有效点评');
    game.moveComments = ok;
    persist();
  }

  async function doNarrate() {
    const g = curGame();
    if (!g || !g.evalResult) return toast('请先完成本局引擎分析', 'err');
    const out = $('narration'), badge = $('llm-badge');
    const prompt = buildNarrationPrompt(g);
    if (!S.settings.llm.apiKey) {
      out.innerHTML = '<p class="hint">未配置 API Key。请到「设置」填写大模型端点；或点击「复制提示词」，把内容粘贴给任意大模型获取解说。</p>';
      return toast('未配置大模型 API Key', 'err');
    }
    out.innerHTML = '<p class="loading">AI 教练正在生成解说…</p>';
    badge.textContent = '生成中'; badge.className = 'badge busy';
    try {
      const md = await llmChat(SYS_COACH, prompt);
      g.narration = md; persist();
      out.innerHTML = mdToHtml(md);
      badge.textContent = '已生成'; badge.className = 'badge ok';
      toast('解说已生成', 'ok');
    } catch (e) {
      out.innerHTML = '<p class="hint">调用失败：' + esc(e.message) + '</p><p class="hint dim">可能是 CORS 或网络限制——点击「复制提示词」可手动粘贴给任意大模型。</p>';
      badge.textContent = '失败'; badge.className = 'badge';
      toast('LLM 调用失败', 'err');
    }
  }

  async function doDiagnose() {
    const games = S.games.filter((g) => g.analyzed && g.evalResult);
    if (!games.length) return toast('请先完成至少一局分析', 'err');
    const profile = CLEngine.aggregateProfile(games);
    const out = $('diagnosis'), badge = $('llm-badge-p');
    const prompt = buildProfilePrompt(profile, games);
    if (!S.settings.llm.apiKey) {
      out.innerHTML = '<p class="hint">未配置 API Key。请到「设置」填写；或点击「复制提示词」手动生成。</p>';
      return toast('未配置大模型 API Key', 'err');
    }
    out.innerHTML = '<p class="loading">AI 教练正在生成画像诊断…</p>';
    badge.textContent = '生成中'; badge.className = 'badge busy';
    try {
      const md = await llmChat(SYS_COACH, prompt);
      out.innerHTML = mdToHtml(md);
      badge.textContent = '已生成'; badge.className = 'badge ok';
      toast('诊断已生成', 'ok');
    } catch (e) {
      out.innerHTML = '<p class="hint">调用失败：' + esc(e.message) + '</p><p class="hint dim">可改用「复制提示词」手动生成。</p>';
      badge.textContent = '失败'; badge.className = 'badge';
      toast('LLM 调用失败', 'err');
    }
  }

  async function copyPrompt(kind) {
    let text;
    if (kind === 'game') {
      const g = curGame();
      if (!g || !g.evalResult) return toast('请先完成本局引擎分析', 'err');
      text = '[系统指令]\n' + SYS_COACH + '\n\n[用户指令]\n' + buildNarrationPrompt(g);
    } else {
      const games = S.games.filter((g) => g.analyzed && g.evalResult);
      if (!games.length) return toast('请先完成至少一局分析', 'err');
      text = '[系统指令]\n' + SYS_COACH + '\n\n[用户指令]\n' + buildProfilePrompt(CLEngine.aggregateProfile(games), games);
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('提示词已复制，粘贴给任意大模型即可', 'ok');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('提示词已复制', 'ok');
    }
  }

  function renderProfileView() {
    const games = S.games.filter((g) => g.analyzed && g.evalResult);
    const empty = $('profile-empty'), main = $('profile-main');
    if (!games.length) { empty.style.display = ''; main.classList.add('hidden'); return; }
    empty.style.display = 'none'; main.classList.remove('hidden');
    const profile = CLEngine.aggregateProfile(games);
    const c = profile.counts;
    const cards = [
      ['分析局数', profile.nGames + '<small>局</small>', '我方视角'],
      ['我方着数', profile.totalMoves + '<small>着</small>', '统计样本'],
      ['综合准确率', fmt1(profile.accuracy) + '<small>%</small>', '加权平均'],
      ['综合 ACPL', fmt0(profile.acpl) + '<small>cp</small>', '平均每着损失'],
      ['失当+失误+大错', (c.inaccuracy + c.mistake + c.blunder) + '<small>着</small>', '全部可改进着法'],
      ['大错率', (profile.totalMoves ? (c.blunder / profile.totalMoves * 100).toFixed(1) : '0') + '<small>%</small>', '每 ' + Math.max(1, Math.round(profile.totalMoves / Math.max(1, c.blunder))) + ' 着一次']
    ];
    $('profile-stats').innerHTML = cards.map((x) => '<div class="stat"><div class="num">' + x[1] + '</div><div class="label">' + x[0] + ' · ' + x[2] + '</div></div>').join('');
    renderRadar(profile);
    renderPhaseTable(profile);
    renderOpenings(profile);
    renderWeakness(profile);
  }

  function renderRadar(profile) {
    const wrap = $('radar-wrap');
    const order = ['opening', 'middlegame', 'endgame', 'tactics', 'quality', 'stability'];
    const labels = { opening: '开局处理', middlegame: '中局计算', endgame: '残局技术', tactics: '战术敏锐', quality: '着法质量', stability: '稳定性' };
    const axes = order.filter((k) => profile.dims[k] !== null).map((k) => ({ key: k, label: labels[k], score: profile.dims[k] }));
    if (axes.length < 3) { wrap.innerHTML = '<p class="hint dim">维度数据不足（至少需要覆盖 3 个维度）。</p>'; return; }
    const cx = 170, cy = 160, R = 108;
    const pt = (i, r) => {
      const a = -Math.PI / 2 + 2 * Math.PI * i / axes.length;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };
    let svg = '<svg viewBox="0 0 340 330" style="max-width:340px;width:100%">';
    [0.25, 0.5, 0.75, 1].forEach((f) => {
      const pts = axes.map((_, i) => pt(i, R * f).map((v) => v.toFixed(1)).join(',')).join(' ');
      svg += '<polygon points="' + pts + '" fill="none" stroke="#CFC9BA" stroke-width="1"/>';
    });
    axes.forEach((ax, i) => {
      const [x, y] = pt(i, R);
      const [lx, ly] = pt(i, R + 26);
      svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="#CFC9BA"/>';
      svg += '<text x="' + lx.toFixed(1) + '" y="' + (ly + 4).toFixed(1) + '" text-anchor="middle" font-size="12" fill="#6F685A">' + ax.label + '</text>';
      svg += '<text x="' + lx.toFixed(1) + '" y="' + (ly + 18).toFixed(1) + '" text-anchor="middle" font-size="11" fill="#8F6244" font-weight="700">' + ax.score + '</text>';
    });
    const dataPts = axes.map((ax, i) => pt(i, R * ax.score / 100).map((v) => v.toFixed(1)).join(',')).join(' ');
    svg += '<polygon points="' + dataPts + '" fill="rgba(168,123,92,.20)" stroke="#A87B5C" stroke-width="2" stroke-linejoin="round"/>';
    axes.forEach((ax, i) => {
      const [x, y] = pt(i, R * ax.score / 100);
      svg += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3" fill="#A87B5C"/>';
    });
    svg += '</svg>';
    wrap.innerHTML = svg;
  }

  function renderPhaseTable(profile) {
    const ph = profile.phase;
    const rows = ['opening', 'middlegame', 'endgame'].map((k) => {
      const p = ph[k];
      if (!p.n) return '<tr><td>' + PHASE_LABEL[k] + '</td><td colspan="6" style="color:#6F685A">无样本</td></tr>';
      return '<tr><td><b>' + PHASE_LABEL[k] + '</b></td><td class="mono">' + p.n + '</td><td class="mono">' + fmt0(p.acpl) + ' cp</td><td class="mono">' + fmt1(p.accuracy) + '%</td><td class="mono" style="color:var(--c-inaccuracy)">' + p.cnt.inaccuracy + '</td><td class="mono" style="color:var(--c-mistake)">' + p.cnt.mistake + '</td><td class="mono" style="color:var(--c-blunder)">' + p.cnt.blunder + '</td></tr>';
    }).join('');
    $('phase-table').innerHTML = '<thead><tr><th>阶段</th><th>着数</th><th>ACPL</th><th>准确率</th><th>失当</th><th>失误</th><th>大错</th></tr></thead><tbody>' + rows + '</tbody>';
  }

  function renderOpenings(profile) {
    const entries = Object.entries(profile.openings).sort((a, b) => b[1].games - a[1].games).slice(0, 10);
    $('opening-table').innerHTML = '<thead><tr><th>开局</th><th>局数</th><th>胜-和-负</th><th>平均 ACPL</th><th>大错</th></tr></thead><tbody>' +
      entries.map(([k, v]) =>
        '<tr><td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(k) + '">' + esc(k) + '</td><td class="mono">' + v.games + '</td><td class="mono">' + v.w + '-' + v.d + '-' + v.l + '</td><td class="mono">' + (v.cplN ? Math.round(v.cpl / v.cplN) + ' cp' : '—') + '</td><td class="mono" style="color:' + (v.blunders ? 'var(--c-blunder)' : 'var(--c-best)') + '">' + v.blunders + '</td></tr>'
      ).join('') + '</tbody>';
  }

  function weaknessEvidence(profile, key) {
    const ph = profile.phase, c = profile.counts;
    const t = profile.totalMoves || 1;
    switch (key) {
      case 'opening': return '开局阶段 ' + ph.opening.n + ' 着，平均每着损失 ' + fmt0(ph.opening.acpl) + 'cp；失当 ' + ph.opening.cnt.inaccuracy + ' / 失误 ' + ph.opening.cnt.mistake + ' / 大错 ' + ph.opening.cnt.blunder + (ph.opening.n < 10 ? '（样本较少，仅供参考）' : '');
      case 'middlegame': return '中局阶段 ' + ph.middlegame.n + ' 着，平均每着损失 ' + fmt0(ph.middlegame.acpl) + 'cp；失当 ' + ph.middlegame.cnt.inaccuracy + ' / 失误 ' + ph.middlegame.cnt.mistake + ' / 大错 ' + ph.middlegame.cnt.blunder;
      case 'endgame': return '残局阶段 ' + ph.endgame.n + ' 着，平均每着损失 ' + fmt0(ph.endgame.acpl) + 'cp' + (ph.endgame.n < 10 ? '（样本较少，仅供参考）' : '');
      case 'tactics': return '大错率 ' + (c.blunder / t * 100).toFixed(1) + '%（' + c.blunders_display || (c.blunder + '/' + t) + '），平均每 ' + Math.round(t / Math.max(1, c.blunder)) + ' 着出现一次胜率骤降 ≥20% 的着法';
      case 'quality': return '综合准确率 ' + fmt1(profile.accuracy) + '%，ACPL ' + fmt0(profile.acpl) + 'cp（样本 ' + profile.nGames + ' 局）';
      case 'stability': return '失当+失误合计占我方着法的 ' + ((c.inaccuracy + c.mistake) / t * 100).toFixed(1) + '%——大量小失误持续消耗胜率';
      default: return '';
    }
  }
  function renderWeakness(profile) {
    const box = $('weakness-list');
    const weak = profile.ranked.filter((d) => d.score < 85).slice(0, 3);
    if (!weak.length) { box.innerHTML = '<p class="hint">各项维度得分均衡且良好，暂无明显短板。继续保持，并增加对局样本以获得更细的诊断。</p>'; return; }
    box.innerHTML = weak.map((d, i) =>
      '<div class="weak-item' + (i === 0 ? ' sev1' : '') + '"><div class="weak-rank">' + (i + 1) + '</div><div class="weak-body"><b>' + esc(d.label) + ' · ' + d.score + '/100</b><p>' + esc(weaknessEvidence(profile, d.key)) + '</p></div></div>'
    ).join('') +
    '<p class="hint dim">相对优势：<b style="color:var(--c-best)">' + esc(profile.ranked[profile.ranked.length - 1].label) + '</b>（' + profile.ranked[profile.ranked.length - 1].score + '/100）。短板排序由本地规则生成；点击「生成画像诊断」可获得 AI 的深度归因与训练计划。</p>';
  }

  function renderSettingsForm() {
    const cfg = S.settings.llm;
    $('llm-preset').value = cfg.preset;
    $('llm-baseurl').value = cfg.baseUrl;
    $('llm-model').value = cfg.model;
    $('llm-key').value = cfg.apiKey;
  }

  /** 应用当前主题到 DOM：设置 documentElement 的 data-theme 属性，
      并更新切换按钮上显示的标签文字。CSS 通过 [data-theme="xxx"] 选择器切换变量 */
  function applyTheme() {
    // 设置根元素 data-theme 属性，CSS 选择器据此生效
    document.documentElement.setAttribute('data-theme', S.theme);
    // 更新切换按钮显示的文字（显示当前主题名称）
    const btn = $('theme-toggle');
    if (btn) btn.dataset.label = S.theme === 'pink' ? '粉色' : '莫兰迪';
  }

  /** 切换主题：在 morandi 和 pink 之间轮换，保存偏好 */
  function toggleTheme() {
    S.theme = S.theme === 'morandi' ? 'pink' : 'morandi';
    applyTheme();
    persist();
    toast('已切换到「' + (S.theme === 'pink' ? '粉色' : '莫兰迪') + '」主题', 'ok');
  }

  function wire() {
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

    $('btn-bind').addEventListener('click', doBind);
    $('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doBind(); });
    $('btn-unbind').addEventListener('click', () => {
      if (myGamesAbort) myGamesAbort.abort();
      S.lichess = null; persist(); renderBind(); renderUserChip(); toast('已解绑');
    });
    $('btn-import-mygames').addEventListener('click', importMyGames);
    $('btn-cancel-mygames').addEventListener('click', () => { if (myGamesAbort) myGamesAbort.abort(); });

    $('btn-list-studies').addEventListener('click', listStudies);
    $('study-user-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') listStudies(); });
    $('study-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-study]');
      if (b) importStudy(b.dataset.study);
    });
    $('btn-import-study').addEventListener('click', () => importStudy($('study-url-input').value));
    $('study-url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') importStudy($('study-url-input').value); });

    $('btn-import-pgn').addEventListener('click', () => {
      const text = $('pgn-input').value;
      if (!text.trim()) return toast('请先粘贴 PGN', 'err');
      addGames(CLLichess.importPgnText(text, 'paste'));
      $('pgn-input').value = '';
    });
    $('pgn-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { addGames(CLLichess.importPgnText(String(reader.result), 'file')); };
      reader.readAsText(f);
    });
    const loadSamples = () => { addGames(CLLichess.importPgnText(SAMPLE_PGN.join('\n\n'), 'sample')); showTab('analyze'); };
    $('btn-load-samples').addEventListener('click', loadSamples);
    $('btn-sample-2').addEventListener('click', loadSamples);

    $('lib-body').addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]');
      if (open) {
        S.cur = S.games.findIndex((g) => g.id === open.dataset.open);
        S.ply = 0; S.var = null; S.sel = null;
        showTab('analyze');
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        S.games = S.games.filter((g) => g.id !== del.dataset.del);
        if (S.cur >= S.games.length) S.cur = S.games.length - 1;
        persist(); renderLibrary(); renderCounts(); renderAnalyzeView();
      }
    });
    /* 棋谱库结果筛选（导入时将杀已自动判定结果；「我胜/我负」随「我执」联动） */
    $('lib-result-filter').addEventListener('change', (e) => {
      S.libFilter = e.target.value;
      renderLibrary();
    });
    $('lib-body').addEventListener('change', (e) => {
      /* 手动设置对局结果（输赢/和棋/进行中）：写回 headers.Result 并持久化 */
      const resSel = e.target.closest('[data-res]');
      if (resSel) {
        const g = S.games.find((x) => x.id === resSel.dataset.res);
        if (!g) return;
        g.headers.Result = resSel.value;
        g.resultManual = true;
        persist(); renderLibrary(); renderCounts();
        if (curGame() === g) renderAnalyzeView();
        toast('结果已设为 ' + (resSel.value === '*' ? '进行中' : resSel.value) + '（已保存）', 'ok');
        return;
      }
      const sel = e.target.closest('[data-mine]');
      if (!sel) return;
      const g = S.games.find((x) => x.id === sel.dataset.mine);
      if (!g) return;
      g.mine = sel.value;
      if (g.analysis) g.evalResult = CLEngine.evalGame(g, g.analysis, g.mine);
      if (g.narration) g.narration = null;
      persist(); renderCounts(); renderLibrary();
      if (curGame() === g) renderAnalyzeView();
      toast('视角已切换为' + (g.mine === 'w' ? '执白' : '执黑') + (g.analysis ? '，统计已重算' : ''), 'ok');
    });

    $('game-select').addEventListener('change', (e) => {
      S.cur = +e.target.value;
      S.ply = 0; S.var = null; S.sel = null;
      renderAnalyzeView();
    });
    /* 着法列表卡片的「AI 点评」按钮（手动重新生成着法点评） */
    $('btn-cmt').addEventListener('click', async () => {
      const g = curGame();
      if (!g || !g.evalResult) return toast('请先完成本局引擎分析', 'err');
      if (!S.settings.llm.apiKey) return toast('未配置大模型 API Key，请到「设置」填写', 'err');
      const b = $('btn-cmt'); b.disabled = true; b.textContent = '点评生成中…';
      try {
        await narrateMoves(g);
        renderMovelist(); renderMoveDetail();
        toast('着法点评已写入着法列表', 'ok');
      } catch (e) {
        toast('点评失败：' + e.message, 'err');
      } finally {
        b.disabled = false; b.textContent = 'AI 点评';
      }
    });
    /* 着法解读面板内的「修正错误」按钮（innerHTML 重绘，用委托） */
    $('move-detail').addEventListener('click', (e) => {
      if (e.target.closest('#btn-fix-move')) fixMove();
    });
    $('btn-flip').addEventListener('click', () => { S.flip = !S.flip; renderBoard(); });
    document.querySelectorAll('.btn.nav').forEach((b) => b.addEventListener('click', () => {
      const g = curGame(); if (!g) return;
      if (b.dataset.nav === 'first') { S.var = null; setPly(0); }
      if (b.dataset.nav === 'prev') setPly(S.ply - 1);
      if (b.dataset.nav === 'next') setPly(S.ply + 1);
      if (b.dataset.nav === 'last') { S.var = null; setPly(g.moves.length); }
    }));
    document.addEventListener('keydown', (e) => {
      if (!document.getElementById('view-analyze').classList.contains('active')) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowLeft') { setPly(S.ply - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { setPly(S.ply + 1); e.preventDefault(); }
      if (e.key === 'f' || e.key === 'F') { S.flip = !S.flip; renderBoard(); }
    });
    $('movelist').addEventListener('click', (e) => {
      const mv = e.target.closest('[data-ply]');
      if (mv) { setPlyMain(+mv.dataset.ply); return; }
      const vv = e.target.closest('[data-vply]');
      if (vv) setPly(+vv.dataset.vply);
    });

    $('live-toggle').addEventListener('change', (e) => {
      S.liveOn = e.target.checked;
      persist();
      if (S.liveOn) {
        liveSync();
      } else if (S.live) {
        S.live.stop(true).then(() => { renderLiveLines(); renderBoard(); });
      } else {
        renderLiveLines();
      }
    });
    $('live-multipv').addEventListener('change', (e) => {
      S.settings.liveMultipv = +e.target.value; persist();
      if (S.liveOn) liveSync();
    });
    $('live-depth').addEventListener('change', (e) => {
      S.settings.liveDepth = +e.target.value; persist();
      if (S.liveOn) liveSync();
    });
    $('live-arrow').addEventListener('change', (e) => {
      S.liveArrowOn = e.target.checked;
      renderBoard();
    });
    $('live-lines').addEventListener('click', (e) => {
      const ln = e.target.closest('.lline');
      if (!ln || !ln.dataset.pv0 || ln.dataset.pv0.length < 4) return;
      tryPlayMove(ln.dataset.pv0.slice(0, 2), ln.dataset.pv0.slice(2, 4));
    });

    $('btn-analyze').addEventListener('click', () => {
      const g = curGame();
      if (!g) return toast('请先导入对局', 'err');
      analyzeGames([g], 16);
    });
    $('btn-analyze-all').addEventListener('click', () => {
      const targets = S.games.filter((g) => !g.analyzed);
      analyzeGames(targets.length ? targets : S.games, 16);
    });
    $('btn-cancel').addEventListener('click', () => { S.cancelAnalysis = true; $('analysis-status').textContent = '正在停止…'; });

    $('btn-narrate').addEventListener('click', doNarrate);
    $('btn-copy-prompt').addEventListener('click', () => copyPrompt('game'));
    $('btn-diagnose').addEventListener('click', doDiagnose);

    $('llm-preset').addEventListener('change', (e) => {
      const p = PRESETS[e.target.value];
      if (p.baseUrl !== undefined) { $('llm-baseurl').value = p.baseUrl; $('llm-model').value = p.model; }
    });
    $('btn-save-llm').addEventListener('click', () => {
      S.settings.llm = {
        preset: $('llm-preset').value,
        baseUrl: $('llm-baseurl').value.trim(),
        model: $('llm-model').value.trim(),
        apiKey: $('llm-key').value.trim()
      };
      persist();
      toast('LLM 设置已保存', 'ok');
    });

    $('btn-export').addEventListener('click', () => {
      const blob = new Blob([localStorage.getItem(KEY) || '{}'], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'chessmind-data.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $('btn-reset').addEventListener('click', () => {
      if (!confirm('确定清空全部本地数据（棋谱、分析、令牌、设置）？')) return;
      localStorage.removeItem(KEY);
      location.reload();
    });

    // 主题切换按钮：点击在莫兰迪 / 粉色之间轮换
    $('theme-toggle').addEventListener('click', toggleTheme);

    window.addEventListener('resize', () => {
      const b = $('board');
      if (b && b.clientWidth) b.style.fontSize = Math.max(18, b.clientWidth / 8 * 0.85) + 'px';
    });
  }

  function init() {
    const stale = loadState();
    applyTheme();   // 先应用主题（需要在 DOM 渲染前设置 data-theme）
    wire();
    renderUserChip(); renderBind(); renderLibrary(); renderCounts(); renderSettingsForm();
    if (S.games.length) { S.cur = 0; renderAnalyzeView(); }
    if (stale) { persist(); toast('引擎评分口径已升级（同搜索 MultiPV 对比）：' + stale + ' 局旧分析已作废，请重新点击「分析」以获得准确的着法评价', 'err'); }
    if (location.protocol === 'file:') {
      toast('检测到以 file:// 打开：WASM 引擎需要 HTTP 服务。请在项目目录运行 python3 serve.py 后访问 http://localhost:8899', 'err');
    }
  }
  document.addEventListener('DOMContentLoaded', init);
})();
