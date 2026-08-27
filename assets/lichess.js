/* ============ lichess.js · 数据接入层 ============ */
/* Lichess 公开 API（账号校验 / 研讨列表 / 研讨 PGN 导出）+ 多局 PGN 解析清洗 */

(function () {
  'use strict';
  window.CLLichess = {};
  const API = 'https://lichess.org';

  CLLichess.validateToken = async function (token) {
    const res = await fetch(API + '/api/account', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) throw new Error('令牌无效或已过期（需要 preference:read 权限）');
    if (!res.ok) throw new Error('Lichess 返回 ' + res.status);
    const j = await res.json();
    if (!j.username) throw new Error('响应中无用户名');
    return { username: j.username, perfs: j.perfs || {}, url: j.url };
  };

  /* 该端点是 NDJSON 流式响应且长期保持打开，不能 await res.text()（会永久挂起）。
     增量读取：连续 2.5s 无新数据即认为列表已发完，主动中止连接。 */
  CLLichess.listStudies = async function (username, maxEntries) {
    maxEntries = maxEntries || 100;
    const ctrl = new AbortController();
    let res;
    try {
      res = await fetch(API + '/api/study/by/' + encodeURIComponent(username), { signal: ctrl.signal });
    } catch (e) {
      throw new Error('网络错误：无法连接 Lichess（' + (e.message || e) + '）');
    }
    if (res.status === 404) throw new Error('用户不存在');
    if (!res.ok) throw new Error('获取研讨列表失败（HTTP ' + res.status + '）');
    const out = [];
    let buf = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const IDLE_MS = 2500, HARD_MS = 20000;
    const hardDeadline = Date.now() + HARD_MS;
    let pending = reader.read();
    try {
      while (out.length < maxEntries && Date.now() < hardDeadline) {
        const timer = new Promise((r) => setTimeout(() => r('IDLE'), IDLE_MS));
        const r = await Promise.race([pending, timer]);
        if (r === 'IDLE') break;
        const { done, value } = r;
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) { try { out.push(JSON.parse(line)); } catch (e) { /* 忽略残行 */ } }
        }
        pending = reader.read();
      }
    } catch (e) {
      if (out.length) return out; // 中止连接造成的异常，已有数据则直接返回
      throw new Error('读取研讨列表失败：' + (e.message || e));
    } finally {
      // 吞掉中止时挂起的 read 产生的拒绝，避免 unhandled rejection
      if (pending && pending.catch) pending.catch(() => {});
      try { ctrl.abort(); } catch (e) { /* 已中止 */ }
    }
    return out;
  };

  CLLichess.fetchStudyPgn = async function (studyId) {
    // /study/:id.pgn 与 /api/study/:id.pgn 内容等价；后者更兼容受限网络（部分出口代理仅放行 /api/ 路径）
    const res = await fetch(API + '/api/study/' + encodeURIComponent(studyId) + '.pgn');
    if (res.status === 404) throw new Error('研讨不存在或非公开');
    if (!res.ok) throw new Error('研讨导出失败（HTTP ' + res.status + '）');
    return await res.text();
  };

  CLLichess.extractStudyId = function (input) {
    const m = String(input).match(/study\/([A-Za-z0-9]{6,12})/);
    if (m) return m[1];
    if (/^[A-Za-z0-9]{6,12}$/.test(String(input).trim())) return String(input).trim();
    return null;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** PGN 块 → Unix 毫秒时间戳（优先 UTCDate+UTCTime，退回 Date，仅日期精度） */
  function blockTs(block) {
    let m = block.match(/\[UTCDate "(\d{4})\.(\d{2})\.(\d{2})"\]/);
    const t = block.match(/\[UTCTime "(\d{1,2}):(\d{2}):(\d{2})"\]/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], t ? +t[1] : 0, t ? +t[2] : 0, t ? +t[3] : 0);
    m = block.match(/\[Date "(\d{4})\.(\d{2})\.(\d{2})"\]/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : 0;
  }

  /** 流式读取一页 PGN：以「\n[Event」为界逐局产出，支持取消与空闲超时 */
  async function readPgnStream(res, onGame, isAborted) {
    if (!res.body) {                       // 环境不支持流式：整体读
      const text = await res.text();
      CLLichess.splitMultiPgn(text).forEach(onGame);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let tail = '', pending = null;
    const IDLE_MS = 20000;                 // 服务器限速 ~20 局/秒，空闲 20s 视为流结束
    try {
      for (;;) {
        if (isAborted && isAborted()) { try { reader.cancel(); } catch (e) {} break; }
        pending = reader.read();
        let r;
        try {
          r = await Promise.race([pending, new Promise((res2) => setTimeout(() => res2('IDLE'), IDLE_MS))]);
        } catch (e) { throw e; }           // AbortError 等
        if (r === 'IDLE') { try { reader.cancel(); } catch (e) {} break; }
        const { done, value } = r;
        if (done) break;
        tail += dec.decode(value, { stream: true }).replace(/\r/g, '');
        let idx;
        while ((idx = tail.indexOf('\n[Event ')) > 0) {
          const block = tail.slice(0, idx).trim();
          tail = tail.slice(idx + 1);
          if (block) onGame(block);
        }
      }
      const last = tail.trim();
      if (last) onGame(last);
    } finally {
      if (pending && pending.catch) pending.catch(() => {});
      try { reader.cancel(); } catch (e) { /* 已关闭 */ }
    }
  }

  /**
   * 拉取用户对局。
   * opts = { token, limit(0=全部), pageSize, signal, onGame(block), onProgress({got,pages}) }
   * 返回 { count, pages, anonFallback, aborted }
   */
  CLLichess.fetchUserGames = async function (username, opts) {
    opts = opts || {};
    const pageSize = Math.max(1, opts.pageSize || 300);
    const limit = opts.limit || 0;
    const isAborted = () => !!(opts.signal && opts.signal.aborted);
    let token = opts.token || null, anonFallback = false;
    let got = 0, pages = 0, until = 0, lastBlock = '';
    const onGame = (block) => {
      got++;
      lastBlock = block;                                // 只留最新一块（取其时间戳做分页边界）
      if (opts.onGame) opts.onGame(block, got);
    };
    for (;;) {
      const n = limit ? Math.min(pageSize, limit - got) : pageSize;
      if (n <= 0) break;
      let url = API + '/api/games/user/' + encodeURIComponent(username) +
        '?max=' + n + '&sort=dateDesc&opening=true';
      if (until) url += '&until=' + until;
      const headers = { Accept: 'application/x-chess-pgn' };
      if (token) headers.Authorization = 'Bearer ' + token;
      let res = null;
      for (let attempt = 0; attempt < 5; attempt++) {    // 并发限制 → 退避重试（最多约 25s）
        try {
          res = await fetch(url, { headers, signal: opts.signal });
        } catch (e) {
          if (e && e.name === 'AbortError') return { count: got, pages, anonFallback, aborted: true };
          throw new Error('网络错误：无法连接 Lichess（' + (e.message || e) + '）');
        }
        if (res.status === 429) { res = null; await sleep(Math.min(2500 * (attempt + 1), 10000)); continue; }
        break;
      }
      if (!res) throw new Error('Lichess 导出繁忙（同一 IP 并发限制），请稍后再试');
      if ((res.status === 401 || res.status === 403) && token) {
        token = null; anonFallback = true; continue;     // 令牌权限不足 → 匿名重试（仅公开对局）
      }
      if (res.status === 401) throw new Error('令牌无效或已过期');
      if (res.status === 404) throw new Error('用户不存在或无法访问');
      if (!res.ok) throw new Error('Lichess 返回 ' + res.status + '（' + res.statusText + '）');

      const before = got;
      await readPgnStream(res, onGame, isAborted);
      pages++;
      if (opts.onProgress) opts.onProgress({ got, pages });
      if (isAborted()) return { count: got, pages, anonFallback, aborted: true };
      if (got - before < n) break;
      const oldest = blockTs(lastBlock);
      if (!oldest) break;
      /* lila 的 until 是排他边界（createdAt $lt until，dsl.dateBetween）；
         PGN 时间戳仅秒精度 → 取「该秒末」（+999ms）做下一页边界：同秒对局不漏，
         个别重复块由入库内容去重吸收 */
      const next = oldest + 999;
      if (until && next >= until) break;                 // 边界不再前进 → 已到尽头（防同秒死循环）
      until = next;
    }
    return { count: got, pages, anonFallback, aborted: false };
  };

  /** 拆分多局 PGN */
  CLLichess.splitMultiPgn = function (text) {
    const norm = String(text).replace(/\r\n/g, '\n').trim();
    if (!norm) return [];
    const blocks = norm.split(/\n+(?=\[Event )/g).map((b) => b.trim()).filter(Boolean);
    return blocks.length ? blocks : [norm];
  };

  function parseHeaders(block) {
    const headers = {};
    const re = /\[(\w+)\s+"([^"]*)"\]/g;
    let m;
    while ((m = re.exec(block)) !== null) headers[m[1]] = m[2];
    return headers;
  }

  /** 清洗着法文本：去注释/变着/NAG/评注符 */
  function sanitizeMovetext(block) {
    let t = block;
    // 去掉头部标签行
    t = t.replace(/^\[.*\]\s*$/gm, '');
    // 注释 {...}（含跨行）
    t = t.replace(/\{[\s\S]*?\}/g, ' ');
    // 行注释 ;...
    t = t.replace(/;[^\n]*/g, ' ');
    // 嵌套变着 (...) 从内往外删
    let prev = null;
    while (prev !== t) { prev = t; t = t.replace(/\([^()]*\)/g, ' '); }
    // NAG $n
    t = t.replace(/\$\d+/g, ' ');
    // 结果标记
    t = t.replace(/(1-0|0-1|1\/2-1\/2|\*)\s*$/g, ' ');
    return t;
  }

  /** 从清洗文本提取 SAN 序列 */
  function extractSanTokens(movetext) {
    let t = movetext.replace(/\d+\s*\.(?:\.\.)?/g, ' ');
    t = t.replace(/\d+\.(?!\d)/g, ' ');
    const tokens = t.split(/\s+/).filter(Boolean).map((tok) => tok.replace(/[?!]+$/, '').replace(/\.$/, '')).filter(Boolean);
    return tokens;
  }

  /**
   * 解析单局 PGN → {headers, startFen, moves:[{san,uci,color,fenAfter}], ok, error}
   */
  CLLichess.parsePgnGame = function (block) {
    const headers = parseHeaders(block);
    const movetext = sanitizeMovetext(block);
    const tokens = extractSanTokens(movetext);
    let chess;
    try {
      chess = (headers.FEN && /^[pnbrqkPNBRQK1-8/]+ [wb] /.test(headers.FEN)) ? new Chess(headers.FEN) : new Chess();
    } catch (e) {
      return { ok: false, error: '起始 FEN 无效' };
    }
    const startFen = chess.fen();
    const moves = [];
    for (const tok of tokens) {
      const mv = chess.move(tok);
      if (!mv) {
        // 容错：跳过无法识别的 token（如残留标记），但记录
        continue;
      }
      moves.push({
        san: mv.san,
        uci: mv.from + mv.to + (mv.promotion || ''),
        color: mv.color,
        fenAfter: chess.fen()
      });
    }
    if (!moves.length) return { ok: false, error: '未解析到着法（空章节或格式异常）' };
    /* 终局自动判定：以最后一着的局面为准推导结果。
       有将杀 → 必须覆写（PGN 头里的 Result 可能缺失或不一致）；
       逼和 / 子力不足 → 和棋；其余（50 步 / 三次重复等）仅在缺失时补 1/2-1/2 */
    let derived = null, auto = false;
    if (chess.in_checkmate()) {
      derived = chess.turn() === 'w' ? '0-1' : '1-0';   // 轮到谁走谁被将杀
      auto = true;
    } else if (chess.in_stalemate() || chess.insufficient_material()) {
      derived = '1/2-1/2';
      auto = true;
    } else if (chess.in_draw()) {
      derived = '1/2-1/2';
    }
    if (derived && (auto || !headers.Result || headers.Result === '*' || headers.Result === derived)) {
      headers.Result = derived;
    } else if (!headers.Result) {
      headers.Result = '*';
    }
    return { ok: true, headers, startFen, moves, resultDerived: auto && !!derived };
  };

  /** 解析多局文本，返回 {games:[GameRec], skipped:n} */
  CLLichess.importPgnText = function (text, source, defaults) {
    const blocks = CLLichess.splitMultiPgn(text);
    const games = []; let skipped = 0;
    for (const b of blocks) {
      const r = CLLichess.parsePgnGame(b);
      if (!r.ok) { skipped++; continue; }
      games.push(makeGame(r, source, defaults));
    }
    return { games, skipped };
  };

  function makeGame(parsed, source, defaults) {
    const h = parsed.headers || {};
    return {
      id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      source: source || 'paste',
      sourceLabel: sourceLabel(h, source),
      headers: h,
      startFen: parsed.startFen,
      moves: parsed.moves,
      mine: defaults && defaults.mine ? defaults.mine : 'w',
      resultDerived: !!parsed.resultDerived,   // 结果由终局将杀/和棋局面自动判定
      analyzed: false,
      analysis: null,
      evalResult: null,
      narration: null
    };
  }
  function sourceLabel(h, source) {
    if (source === 'study') return h.StudyName ? ('研讨: ' + h.StudyName + (h.ChapterName ? ' · ' + h.ChapterName : '')) : 'Lichess 研讨';
    if (source === 'account') return 'Lichess 对局' + (h.Date || h.UTCDate ? ' · ' + String(h.Date || h.UTCDate).replace(/\./g, '-') : '');
    if (source === 'sample') return '示例棋局';
    if (source === 'file') return '本地文件';
    return 'PGN 粘贴';
  }
  CLLichess._makeGame = makeGame;
})();
