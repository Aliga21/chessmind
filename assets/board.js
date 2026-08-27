/* ============ board.js · Lichess 同款棋盘渲染（chessground 式拖拽与动画） ============ */
/* 视觉与交互规格取自 lichess 开源项目 chessground（GPL-3.0）：
   - 主题 brown：浅格 #f0d9b5 · 深格 #b58863 · 最后一步 rgba(155,199,0,.41)
     选中 rgba(20,85,30,.5) · 将军红色径向渐变 · 着法目标绿色圆点
   - 走子动画：chessground computePlan —— 新子与「最近的同名消失子」配对滑动，
     被吃子淡出（piece.fading），时长 200ms，缓动 easeInOutCubic
   - 拖拽：最小拖拽距离 3px、棋子指针居中（centralisation）、
     起点幽灵子（piece.ghost · opacity .3）、松手非法落点回弹（drop-off revert） */

(function () {
  'use strict';
  const FILES = 'abcdefgh'.split('');
  const SQUARES = [];
  for (let ri = 8; ri >= 1; ri--) FILES.forEach((f) => SQUARES.push(f + ri));
  const ANIM_MS = 200;                        // chessground 默认动画时长
  const EASE = 'cubic-bezier(.65,0,.35,1)';   // easeInOutCubic（chessground anim.ts 的 easing）
  const DRAG_MIN = 3;                         // 最小拖拽距离（px），小于此仍按点击处理

  function parseFenBoard(fen) {
    const map = {};
    const rows = String(fen).split(' ')[0].split('/');
    rows.forEach((row, ri) => {
      let fi = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) { fi += +ch; continue; }
        map[FILES[fi] + (8 - ri)] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toLowerCase();
        fi++;
      }
    });
    return map;
  }

  /** 箭头覆盖层（lichess 式最佳着法箭头），viewBox 0 0 8 8 */
  function arrowSvg(arrows, flip) {
    if (!arrows || !arrows.length) return '';
    const pos = (sq) => {
      const f = FILES.indexOf(sq[0]);
      const r = +sq[1] - 1;
      const col = flip ? 7 - f : f;
      const row = flip ? r : 7 - r;
      return [col + 0.5, row + 0.5];
    };
    let body = '';
    arrows.forEach((a) => {
      const [x1, y1] = pos(a.from);
      const [x2, y2] = pos(a.to);
      const color = a.color || 'rgba(110,138,87,.85)';   /* 莫兰迪灰绿（--c-best） */
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / len, uy = dy / len;
      const px = -uy, py = ux;
      const tipInset = 0.06;                       // 箭头尖端离目标格中心稍近边缘
      const tx = x2 - ux * tipInset, ty = y2 - uy * tipInset;
      const headBase = 0.34;                       // 箭头三角底边位置
      const bx = x2 - ux * headBase, by = y2 - uy * headBase;
      const hw = 0.19;                             // 三角半宽
      body += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + bx + '" y2="' + by +
        '" stroke="' + color + '" stroke-width="0.17" stroke-linecap="round"/>';
      body += '<polygon points="' + tx + ',' + ty + ' ' + (bx + px * hw) + ',' + (by + py * hw) + ' ' + (bx - px * hw) + ',' + (by - py * hw) +
        '" fill="' + color + '"/>';
    });
    return '<svg class="arrows" viewBox="0 0 8 8" preserveAspectRatio="none">' + body + '</svg>';
  }

  const boards = new WeakMap();      // container -> { fen, flip, sig }
  const currentOpts = new WeakMap(); // container -> 最近一次 render 的 opts（事件回调用，避免闭包过期）
  const boundContainers = new WeakSet();
  const suppressClick = new WeakMap();  // container -> 时间戳（拖拽结束后吞掉随之而来的 click）

  /* 格 → [列, 行]（自左上角，考虑翻转） */
  function sqPos(sq, flip) {
    const f = FILES.indexOf(sq[0]);
    const r = +sq[1] - 1;
    return [flip ? 7 - f : f, flip ? r : 7 - r];
  }
  function distSq(a, b) {
    const dx = a.charCodeAt(0) - b.charCodeAt(0);
    const dy = +a[1] - +b[1];
    return dx * dx + dy * dy;
  }

  /** 与 chessground computePlan 同口径：prev→cur 的动画计划。
      新子找「最近的同名消失子」配对滑动；未配对的消失子淡出（被吃 / 旧位置）。 */
  function computePlan(prevFen, curFen, lastMove) {
    const prev = parseFenBoard(prevFen), cur = parseFenBoard(curFen);
    const missings = [], news = [];
    for (const sq of SQUARES) {
      const a = prev[sq], b = cur[sq];
      if (a && b) { if (a !== b) { missings.push({ sq: sq, pc: a }); news.push({ sq: sq, pc: b }); } }
      else if (a) missings.push({ sq: sq, pc: a });
      else if (b) news.push({ sq: sq, pc: b });
    }
    const anims = [], used = new Set();
    for (const n of news) {
      let best = null, bestD = Infinity;
      for (const m of missings) {
        if (m.pc !== n.pc || used.has(m.sq)) continue;
        const d = distSq(n.sq, m.sq);
        if (d < bestD) { best = m; bestD = d; }
      }
      if (best) { used.add(best.sq); anims.push({ from: best.sq, to: n.sq }); }
    }
    /* 升变兜底：兵→后这类「消失子与出现子不同名」的 lastMove 也配对滑动，
       呈现为「兵滑到目标格并变为新子」（chessground 对升变走 fading，这里取更顺滑的观感） */
    if (lastMove) {
      const toP = news.find((n) => n.sq === lastMove[1] && !anims.some((a) => a.to === n.sq));
      const fromM = missings.find((m) => m.sq === lastMove[0] && !used.has(m.sq));
      if (toP && fromM) { used.add(fromM.sq); anims.push({ from: fromM.sq, to: toP.sq }); }
    }
    const fadings = missings.filter((m) => !used.has(m.sq));
    return { anims: anims, fadings: fadings, changed: missings.length + news.length };
  }

  /** FLIP：移动子先摆到起点、强制回流后过渡回原位；被吃子原地淡出 */
  function applyAnimation(container, plan, flip) {
    const size = container.clientWidth / 8;
    if (!size) return;
    plan.anims.forEach((a) => {
      const el = container.querySelector('[data-sq="' + a.to + '"] > .piece');
      if (!el) return;
      const [fx, fy] = sqPos(a.from, flip), [tx, ty] = sqPos(a.to, flip);
      el.classList.add('anim');
      el.style.transition = 'none';
      el.style.transform = 'translate(' + ((fx - tx) * size) + 'px,' + ((fy - ty) * size) + 'px)';
      void el.offsetWidth;                        // 强制回流：起始帧生效
      el.style.transition = 'transform ' + ANIM_MS + 'ms ' + EASE;
      el.style.transform = 'translate(0, 0)';
      setTimeout(() => {
        el.classList.remove('anim');
        el.style.transition = ''; el.style.transform = '';
      }, ANIM_MS + 40);
    });
    plan.fadings.forEach((f) => {                  // 被吃子淡出（chessground piece.fading）
      const host = container.querySelector('[data-sq="' + f.sq + '"]');
      if (!host) return;
      const el = document.createElement('div');
      el.className = 'pc piece ' + f.pc + ' fading';
      host.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = '0'; });
      setTimeout(() => el.remove(), ANIM_MS + 40);
    });
  }

  let drag = null;   // { container, from, pcEl, startX, startY, moved, float, size, flip, dests, hover }

  function sqFromPoint(container, x, y, flip) {
    const r = container.getBoundingClientRect();
    const size = r.width / 8;
    let col = Math.floor((x - r.left) / size), row = Math.floor((y - r.top) / size);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    if (flip) { col = 7 - col; row = 7 - row; }
    return FILES[col] + (8 - row);
  }

  function beginDragVisual() {
    const { container, pcEl, size, dests } = drag;
    const fl = document.createElement('div');
    fl.className = pcEl.className.replace('pc ', '') + ' drag-float';
    fl.style.width = fl.style.height = size + 'px';
    document.body.appendChild(fl);
    drag.float = fl;
    pcEl.classList.add('drag-ghost');               // 起点幽灵子（chessground ghost · opacity .3）
    document.body.classList.add('is-dragging');
    /* 直接给目标格加 dest 类（不重渲染，避免销毁拖拽中的元素） */
    Object.keys(dests).forEach((sq) => {
      const c = container.querySelector('[data-sq="' + sq + '"]');
      if (c) { c.classList.add('dest'); if (dests[sq] === 'capture') c.classList.add('capture'); }
    });
  }

  function endDrag(e, cancelled) {
    if (!drag) return;                              // 无进行中的拖拽（如点击空格/对方棋子被拒绝）直接忽略
    const d = drag; drag = null;
    if (!d.moved) return;                            // 未真正拖动 → 交给原生 click（选择逻辑）
    const opts = currentOpts.get(d.container) || {};
    const target = (!cancelled && e) ? sqFromPoint(d.container, e.clientX, e.clientY, d.flip) : null;
    const legal = target && d.dests[target];
    const finish = () => {
      if (d.float) d.float.remove();
      d.pcEl.classList.remove('drag-ghost');
      Object.keys(d.dests).forEach((sq) => {
        const c = d.container.querySelector('[data-sq="' + sq + '"]');
        if (c) c.classList.remove('dest', 'capture', 'drag-over');
      });
      document.body.classList.remove('is-dragging');
    };
    suppressClick.set(d.container, performance.now());
    if (legal) {
      finish();
      if (opts.onDrop) opts.onDrop(d.from, target);  // 走子（与点选走子同一条路，含变着逻辑）
    } else if (d.float) {
      /* 非法落点 → 回弹到起点（chessground drop-off revert） */
      const cell = d.container.querySelector('[data-sq="' + d.from + '"]');
      if (cell) {
        const r = cell.getBoundingClientRect();
        d.float.style.transition = 'left .15s ease, top .15s ease';
        d.float.style.left = r.left + 'px';
        d.float.style.top = r.top + 'px';
      }
      setTimeout(finish, 160);
    } else finish();
  }

  /** 事件只绑定一次，始终读取 currentOpts 的最新配置（避免闭包过期） */
  function bindEvents(container) {
    if (boundContainers.has(container)) return;
    boundContainers.add(container);

    container.addEventListener('pointerdown', (e) => {
      if (drag) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const opts = currentOpts.get(container) || {};
      const pcEl = e.target.closest('.pc');
      if (!pcEl || !pcEl.dataset.sq) return;
      if (opts.movableSq && !opts.movableSq(pcEl.dataset.sq)) return;   // 只能拖行棋方的棋子
      drag = {
        container: container, from: pcEl.dataset.sq, pcEl: pcEl,
        startX: e.clientX, startY: e.clientY, moved: false,
        float: null, size: container.clientWidth / 8, flip: !!opts.flip,
        dests: (opts.destsOf ? opts.destsOf(pcEl.dataset.sq) : null) || {}
      };
      try { container.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      e.preventDefault();
    });
    container.addEventListener('pointermove', (e) => {
      if (!drag || drag.container !== container) return;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_MIN) return;
        drag.moved = true;
        beginDragVisual();
      }
      drag.float.style.left = (e.clientX - drag.size / 2) + 'px';     // 指针居中
      drag.float.style.top = (e.clientY - drag.size / 2) + 'px';
      const sq = sqFromPoint(container, e.clientX, e.clientY, drag.flip);
      if (drag.hover && drag.hover !== sq) {
        const c = container.querySelector('[data-sq="' + drag.hover + '"]');
        if (c) c.classList.remove('drag-over');
        drag.hover = null;
      }
      if (sq && drag.dests[sq]) {
        drag.hover = sq;
        const c = container.querySelector('[data-sq="' + sq + '"]');
        if (c) c.classList.add('drag-over');
      }
      e.preventDefault();
    });
    container.addEventListener('pointerup', (e) => endDrag(e, false));
    container.addEventListener('pointercancel', (e) => endDrag(e, true));

    container.addEventListener('click', (e) => {
      const t = suppressClick.get(container);
      if (t && performance.now() - t < 400) { suppressClick.delete(container); return; }
      const opts = currentOpts.get(container) || {};
      const cell = e.target.closest('[data-sq]');
      if (cell && opts.onSquareClick) opts.onSquareClick(cell.dataset.sq);
    });
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const opts = currentOpts.get(container) || {};
      const cell = e.target.closest('[data-sq]');
      if (cell && opts.onSquareRightClick) opts.onSquareRightClick(cell.dataset.sq);
    });
  }

  /** 仅更新箭头层（引擎线路刷新频繁，不动棋子 DOM 以免打断动画/拖拽） */
  function updateArrowLayer(container, arrows, flip) {
    const layer = container.querySelector('.arrow-layer');
    if (layer) layer.innerHTML = arrowSvg(arrows, flip);
  }

  /**
   * 将局面渲染进容器（diff 动画 + 事件委托）
   * opts: {
   *   fen, flip,
   *   lastMove: [from,to] | null,
   *   checkSq: sq | null,          被将军的王所在格
   *   selSq:   sq | null,          选中格（lichess 绿色高亮）
   *   dests:   {sq:'move'|'capture'}, 可走目标（lichess 圆点/圆环）
   *   ring:    {sq, cls} | null,   着法质量圆环（应用自有功能）
   *   arrows:  [{from,to,color}],  覆盖箭头
   *   turnColor: 'w'|'b',          行棋方（其棋子显示 grab 光标）
   *   movableSq(sq): bool,         该格棋子可否拖拽（分析界面=行棋方）
   *   destsOf(sq): {sq:'move'|'capture'}, 拖拽起始时的可走目标
   *   onDrop(from, to),            拖拽落子
   *   onSquareClick(sq), onSquareRightClick(sq),
   *   animate: bool                置 false 可关闭走子动画
   * }
   */
  function render(container, opts) {
    opts = opts || {};
    currentOpts.set(container, opts);
    const fen = opts.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const map = parseFenBoard(fen);
    const flip = !!opts.flip;
    const fOrd = flip ? [...FILES].reverse() : FILES;
    const rOrd = flip ? ['1', '2', '3', '4', '5', '6', '7', '8'] : ['8', '7', '6', '5', '4', '3', '2', '1'];

    /* 核心视觉签名（不含箭头——引擎刷新频繁，箭头独立更新） */
    const destKey = opts.dests ? Object.keys(opts.dests).map((k) => k + opts.dests[k]).sort().join('') : '';
    const ringKey = opts.ring ? opts.ring.sq + opts.ring.cls : '';
    const arrowKey = opts.arrows ? opts.arrows.map((a) => a.from + a.to).join('') : '';
    const sig = [fen, flip ? 1 : 0, (opts.lastMove || []).join(''), opts.checkSq || '',
                 opts.selSq || '', destKey, ringKey, opts.turnColor || ''].join('|');
    const prev = boards.get(container);

    if (prev && prev.sig === sig) {
      if (prev.arrowKey !== arrowKey) updateArrowLayer(container, opts.arrows, flip);
      boards.set(container, { fen: fen, flip: flip, sig: sig, arrowKey: arrowKey });
      bindEvents(container);
      return;                                       // 棋子 DOM 不变：不打断进行中的动画/拖拽
    }

    let html = '';
    rOrd.forEach((rk, ri) => {
      fOrd.forEach((fl, ci) => {
        const sq = fl + rk;
        const light = (FILES.indexOf(fl) + +rk) % 2 === 0;
        let cls = 'sq ' + (light ? 'l' : 'd');
        if (opts.lastMove && (opts.lastMove[0] === sq || opts.lastMove[1] === sq)) cls += ' hl';
        if (opts.checkSq === sq) cls += ' check';
        if (opts.selSq === sq) cls += ' sel';
        const dest = opts.dests && opts.dests[sq];
        if (dest) cls += ' dest' + (dest === 'capture' ? ' capture' : '');
        html += '<div class="' + cls + '" data-sq="' + sq + '">';
        if (ri === 7) html += '<span class="coord file">' + fl + '</span>';
        if (ci === 0) html += '<span class="coord rank">' + rk + '</span>';
        const pc = map[sq];
        if (pc) {
          const turnCls = opts.turnColor && pc[0] === opts.turnColor ? ' t' : '';
          html += '<div class="pc piece ' + pc + turnCls + '" data-sq="' + sq + '"></div>';
        }
        if (opts.ring && opts.ring.sq === sq) html += '<span class="ring ' + opts.ring.cls + '"></span>';
        html += '</div>';
      });
    });
    html += '<div class="arrow-layer">' + arrowSvg(opts.arrows, flip) + '</div>';
    container.innerHTML = html;

    /* 局面变化 → chessground 式移动动画（换局 / 大跳变 diff 过大，直接跳变） */
    if (prev && prev.fen !== fen && prev.flip === flip && opts.animate !== false) {
      const plan = computePlan(prev.fen, fen, opts.lastMove || null);
      if (plan.changed > 0 && plan.changed <= 8) applyAnimation(container, plan, flip);
    }
    boards.set(container, { fen: fen, flip: flip, sig: sig, arrowKey: arrowKey });
    bindEvents(container);
  }

  /** 清空棋盘（无对局时） */
  function clear(container) {
    container.innerHTML = '';
    boards.delete(container);
    suppressClick.delete(container);
  }

  window.CLBoard = { render: render, clear: clear, parseFenBoard: parseFenBoard };
})();
