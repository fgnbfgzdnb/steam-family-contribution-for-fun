/*!
 * Steam 家庭组贡献度 · 界面逻辑
 * 只负责：状态管理 / 渲染 / 事件。
 * 所有算法都在 src/engine.js，界面上不复制任何计算规则。
 *
 * 关键设计：游戏归属来自 Steam 家庭组接口，自动填好，用户不需要勾选。
 * 顺手改价格/修正归属走单卡片弹层，不回到「勾选矩阵」那种交互。
 */
(function () {
  'use strict';

  var SC = window.SCContribution;
  if (!SC) { console.error('engine.js 未加载'); return; }

  var STORAGE_KEY = 'steam_family_contribution_v3';
  var PRICE_MODE_STORAGE = 'steam_family_price_mode';
  var MAX = SC.MAX_MEMBERS;
  var PALETTE = ['#1a9fff', '#2fa85f', '#e8a13a', '#9b6ce0', '#e2624a', '#2fa8b8'];
  /** 头像只允许这个前缀（与 src/steam.js 的 AVATAR_CDN 一致）。见 avatarHTML()。 */
  var AVATAR_PREFIX = 'https://avatars.steamstatic.com/';

  var state = { familyGroupId: '', members: [], games: [] };
  /**
   * 游戏网格：首批只渲染这么多张，之后每次「显示更多」再追加一批。
   * 为什么分批而不是一次全展开：很多人的库存上千款，一次性建几千个 DOM 节点
   * 再加几千个封面图请求，浏览器会直接卡死。分批的话每次只多做几十张。
   */
  var ui = {
    sortMode: 'contribution',
    // ★ 计分方式：'final' = 当前国区折扣价（默认），'original' = 无折扣标价。
    //   两种口径的结果**每次都会一起算好**（见 ensureResults），这里只决定展示哪一种。
    priceMode: 'final',
    // 默认只看有价值的：一个家庭几百上千款游戏，绝大多数没人玩过、不产生任何价值
    onlyValuable: true,
    onlyShared: false,
    hideFree: false,
    // ★ 明细的两个成员筛选（'' = 全部）：提供者 = 拥有者，使用者 = 玩过的非拥有者
    filterOwner: '',
    filterPlayer: '',
    // ★ 明细默认渲染多少行：0 = 未初始化，会回到「和贡献榜一样长」（= 成员数）。
    //   之后每点一次「展开更多」加 DETAIL_PAGE 行。
    detailLimit: 0,
  };
  var seq = 0;


  /**
   * ★ 静态快照模式：生成报告时（src/static-report.js）会把一份数据内联成
   *   window.__FAMILY_DATA__（形状见 tests/fixtures/family-api-sample.json）。
   *   有它就不读写 localStorage、不走 restore() ——
   *   报告是用 file:// 直接双击打开的，本来就连不上 Steam。
   */
  var SNAPSHOT = (typeof window !== 'undefined' && window.__FAMILY_DATA__) || null;

  // ------------------------------ 小工具 ------------------------------

  function $(s, r) { return (r || document).querySelector(s); }
  function uid(p) { seq += 1; return p + Date.now().toString(36) + '_' + seq; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(n) { return SC.formatYuan(n); }
  function color(i) { return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]; }
  function firstChar(name) { var s = String(name || '').trim(); return s ? Array.from(s)[0] : '?'; }

  function memberIndex(id) {
    for (var i = 0; i < state.members.length; i++) if (state.members[i].id === id) return i;
    return -1;
  }
  function memberById(id) { var i = memberIndex(id); return i < 0 ? null : state.members[i]; }
  function gameById(id) {
    for (var i = 0; i < state.games.length; i++) if (state.games[i].id === id) return state.games[i];
    return null;
  }
  function ownerCount(g) { return (g.ownerIds || []).length; }

  // ------------------------------ 持久化 ------------------------------

  function save() {
    if (SNAPSHOT) return;   // 静态报告：别往访客自己的浏览器里写数据（不污染、不留痕）
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 忽略 */ }
  }
  function restore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var d = JSON.parse(raw);
      if (d && Array.isArray(d.members) && Array.isArray(d.games)) {
        state = { familyGroupId: d.familyGroupId || '', members: d.members, games: d.games };
        return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }
  function loadStored(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function saveStored(k, v) { try { localStorage.setItem(k, v || ''); } catch (e) { /* 忽略 */ } }

  // ------------------------------ 计算与排序 ------------------------------

  /**
   * ★★ 价格来源解析的**唯一**实现处 —— 别在别的地方再判一次。
   *
   * 数据来源：src/payload.js 的 toGamePriceFields() 同时给 `price`（= cnyFinal 当前折扣价）
   * 与 `originalPrice`（= cnyOriginal 无折扣标价），两者都是折算后的人民币。
   * 前端把它们存成两个来源字段 priceFinal / priceOriginal。
   *
   * 缺一个来源时（老数据 / 离线夹具只给了一个价）就认为两者相等 =「没有折扣信息」，
   * 而不是当成 0，免得把分数打成负值。
   */
  function priceSourceOf(g) {
    var final = (g.priceFinal != null) ? g.priceFinal : (g.price || 0);
    var original = (g.priceOriginal != null) ? g.priceOriginal : final;
    return { final: final, original: original };
  }

  /**
   * 按 ui.priceMode 把每个游戏的 `g.price` 重写成当前口径的价。
   * ★ 注意：引擎**不再**读 `g.price`（它读的是 computeFor() 现拼的那份）。
   *   这里维护 `g.price` 只是为了「排序 / 隐藏免费」这些**展示侧**的判断也跟着口径走。
   */
  function applyPriceMode() {
    var useOriginal = ui.priceMode === 'original';
    state.games.forEach(function (g) {
      var p = priceSourceOf(g);
      g.priceFinal = p.final;
      g.priceOriginal = p.original;
      g.price = useOriginal ? p.original : p.final;
    });
  }

  /**
   * 切换计分方式：不重算 —— 两份结果早在导入/刷新时就一起算好了（见 ensureResults），
   * 这里只换展示哪一份。
   */
  function setPriceMode(mode) {
    ui.priceMode = (mode === 'original') ? 'original' : 'final';
    applyPriceMode();      // 让排序/筛选跟着走
    syncPriceModeUI();
    refreshResults();
    saveStored(PRICE_MODE_STORAGE, ui.priceMode);
  }

  /** 把选择同步回控件（页面上的文案不跟着口径变，只有控件本身） */
  function syncPriceModeUI() {
    var sel = $('#priceMode');
    if (sel && sel.value !== ui.priceMode) sel.value = ui.priceMode;
  }

  /**
   * ★ 明细的两个成员筛选下拉：选项跟着成员列表重建（成员是接口给的，不是写死的）。
   * 重建时保住当前选择；如果那个人已经不在这批成员里了（换了家庭组），就退回「全部」。
   */
  function syncDetailFilters() {
    [['#filterOwner', '提供者', 'filterOwner'], ['#filterPlayer', '使用者', 'filterPlayer']]
      .forEach(function (row) {
        var sel = $(row[0]);
        if (!sel) return;
        var keep = sel.value || ui[row[2]] || '';
        var html = '<option value="">' + row[1] + '：全部</option>';
        state.members.forEach(function (m) {
          html += '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>';
        });
        sel.innerHTML = html;
        var valid = state.members.some(function (m) { return m.id === keep; });
        sel.value = valid ? keep : '';
        ui[row[2]] = sel.value;
      });
  }

  // ------------------------------ 明细的分批展示 ------------------------------

  /** 每次「展开更多」追加的行数 */
  var DETAIL_PAGE = 50;

  function resetDetailLimit() {
    ui.detailLimit = Math.max(state.members.length, 1);
  }
  function detailShown(total) {
    var limit = ui.detailLimit || Math.max(state.members.length, 1);
    return Math.min(limit, total);
  }

  /**
   * ★★ 两种计分方式的结果都先算好，切换只换展示哪一份 —— 不重算。
   *
   * 做法：引擎只认 `games[].price`，所以这里按口径各拼一份 games（来源字段 priceFinal /
   * priceOriginal 不变），各算一次；结果缓存在 results 里。
   * 任何数据变更（导入家庭组、刷新价格）都要 invalidateResults()，下次取用时两份一起重算。
   * 这样「切换计分方式」是一次纯渲染，用户点下去立刻出结果。
   */
  var results = { final: null, original: null };

  function computeFor(mode) {
    var useOriginal = mode === 'original';
    var games = state.games.map(function (g) {
      var p = priceSourceOf(g);
      // 浅拷贝：引擎不该看到也别想改到 state 里的对象
      return Object.assign({}, g, { price: useOriginal ? p.original : p.final });
    });
    return SC.calculate({ familyGroupId: state.familyGroupId, members: state.members, games: games });
  }

  function ensureResults() {
    if (!results.final || !results.original) {
      results.final = computeFor('final');
      results.original = computeFor('original');
    }
    return results;
  }
  function invalidateResults() { results = { final: null, original: null }; }

  /** 当前展示的那一份 */
  function compute() { return ensureResults()[ui.priceMode] || results.final; }

  /** 排序：默认「拥有者少 → 多，同人数内价格高 → 低」 */
  function visibleGames(res) {
    var byId = {};
    (res.games || []).forEach(function (g) { byId[g.gameId] = g; });

    var list = state.games.slice();
    // 默认只看有价值的：这款游戏确实被别人玩过、产生了共享价值
    if (ui.onlyValuable) {
      list = list.filter(function (g) {
        var r = byId[g.id];
        return r && r.totalContributionCents > 0;
      });
    }
    if (ui.onlyShared) list = list.filter(function (g) { return ownerCount(g) >= 2; });
    if (ui.hideFree) list = list.filter(function (g) { return g.price > 0; });
    // ★ 两个成员筛选，和明细里显示的「拥有者 / 使用者」两列严格对应：
    //   提供者 = 拥有者；使用者 = 玩过它、且不是拥有者的人（拥有者玩自己的不算，跟那列一致）。
    if (ui.filterOwner) {
      list = list.filter(function (g) { return (g.ownerIds || []).indexOf(ui.filterOwner) >= 0; });
    }
    if (ui.filterPlayer) {
      list = list.filter(function (g) {
        return (g.playedBy || []).indexOf(ui.filterPlayer) >= 0 &&
          (g.ownerIds || []).indexOf(ui.filterPlayer) < 0;
      });
    }

    var mode = ui.sortMode;
    list.sort(function (a, b) {
      if (mode === 'price') return (b.price - a.price) || String(a.name).localeCompare(String(b.name), 'zh');
      if (mode === 'name') return String(a.name).localeCompare(String(b.name), 'zh');
      if (mode === 'contribution') {
        var ca = (byId[a.id] && byId[a.id].totalContributionCents) || 0;
        var cb = (byId[b.id] && byId[b.id].totalContributionCents) || 0;
        return (cb - ca) || (b.price - a.price);
      }
      var oa = ownerCount(a), ob = ownerCount(b);
      if (oa !== ob) return oa - ob;
      return (b.price - a.price) || String(a.name).localeCompare(String(b.name), 'zh');
    });
    return list;
  }

  // ------------------------------ 渲染 ------------------------------

  function renderAll() {
    var res = compute();
    renderKPI(res);
    renderMembers();
    renderDetail(res);
    renderRank(res);
    renderDetail(res);
    renderIssues();
    save();
  }

  function refreshResults() {
    var res = compute();
    renderKPI(res);
    renderDetail(res);
    renderRank(res);
    renderDetail(res);
    renderIssues();
    save();
  }

  function renderKPI(res) {
    var m = res.meta;
    var items = [
      ['家庭组人数', m.memberCount + ' / ' + MAX],
      ['库内游戏', m.gameCount + ' 款'],
      ['共享池现价', money(m.groupValue)],
      ['参与分配', m.activeGameCount + ' 款'],
      ['贡献总池', money(res.totals.score)],
      ['人均', m.memberCount ? money(m.avgScore) : '—']
    ];
    var html = items.map(function (it) {
      return '<div class="kpi-item"><span class="kpi-k">' + it[0] + '</span><b class="kpi-v">' + it[1] + '</b></div>';
    }).join('');

    if (m.notShareableCount > 0) {
      html += '<p class="kpi-note">已排除 ' + m.notShareableCount + ' 款不支持家庭共享的游戏（现价合计 ' +
        money(m.notShareableValue) + '）—— 别人根本玩不到，不计分。</p>';
    }
    $('#kpi').innerHTML = html;
  }

  function avatarHTML(m, i, size) {
    var ini = esc(firstChar(m && m.name));
    var cls = 'avatar' + (size ? ' ' + size : '');
    // ★ 只认 Steam CDN 的 https 前缀：esc() 只管 HTML 转义、**不管协议**，
    //   而 avatar 在离线链路（--from 吃的那份 JSON）里可以是任意字符串 ——
    //   javascript: / data: 之类一律不当头像，退回文字头像。
    var url = (m && typeof m.avatar === 'string' && m.avatar.indexOf(AVATAR_PREFIX) === 0)
      ? m.avatar : '';
    if (!url) return '<span class="' + cls + '" style="--c:' + color(i) + '">' + ini + '</span>';
    // 头像来自 Steam CDN，加载失败就退回文字头像
    return '<span class="' + cls + '" style="--c:' + color(i) + '"><i>' + ini + '</i>' +
      '<img src="' + esc(url) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()"></span>';
  }

  function renderMembers() {
    var box = $('#memberList');
    if (!state.members.length) {
      box.innerHTML = '<p class="empty">这份报告里没有成员数据。</p>';
    } else {
      box.innerHTML = state.members.map(function (m, i) {
        var sid = m.steamid
          ? '<span class="sid" title="SteamID ' + esc(m.steamid) + '">' + esc(String(m.steamid).slice(-6)) + '</span>'
          : '';
        return '<div class="member" style="--c:' + color(i) + '">' +
          avatarHTML(m, i) +
          '<span class="mname">' + esc(m.name) + '</span>' +
          sid +
          '</div>';
      }).join('');
    }
    $('#memberCount').textContent = state.members.length + ' / ' + MAX;
  }

  function renderRank(res) {
    var host = $('#rankList');
    if (!state.members.length) {
      host.innerHTML = '<p class="empty">读取家庭组后，这里会算出每个人「贡献了多少」和「白玩了多少」。</p>';
      return;
    }
    if (!res.rows.length) {
      host.innerHTML = '<p class="empty">当前没有数据。</p>';
      return;
    }

    // ★ 按净贡献（贡献 − 使用）从高到低排，而不是按贡献分
    var rows = res.rows.slice().sort(function (a, b) {
      return (b.netCents - a.netCents) || (a.order - b.order);
    });

    // 柱状图以「绝对值最大」为满格；中线左边画负值（净白玩），右边画正值（净贡献）
    var maxAbs = 0;
    rows.forEach(function (r) { maxAbs = Math.max(maxAbs, Math.abs(r.netCents)); });

    host.innerHTML = rows.map(function (r, i) {
      var netCents = r.netCents;      // 分，用于算柱状图长度
      var net = r.net;                // 元，用于展示
      var pct = maxAbs > 0 ? (Math.abs(netCents) / maxAbs) * 100 : 0;
      var idx = memberIndex(r.memberId);
      var m = idx < 0 ? { name: r.name } : state.members[idx];
      var bar = netCents >= 0
        ? '<i class="netfill pos" style="width:' + pct.toFixed(2) + '%;background:' + color(idx < 0 ? 0 : idx) + '"></i>'
        : '<i class="netfill neg" style="width:' + pct.toFixed(2) + '%"></i>';

      return '<div class="rank-item">' +
        '<div class="rank-head">' +
          '<span class="rank-no">' + (i + 1) + '</span>' +
          avatarHTML(m, idx < 0 ? 0 : idx) +
          '<span class="rank-name">' + esc(r.name) + '</span>' +
          '<span class="rank-net' + (net < 0 ? ' neg' : '') + '">' +
            (net < 0 ? '\u2212' : '+') + money(Math.abs(net)) +
          '</span>' +
        '</div>' +
        '<div class="netbar"><span class="netbar-mid"></span>' + bar + '</div>' +
        '<div class="rank-meta">' +
          '贡献 <b>' + money(r.score) + '</b>' +
          ' · 使用 <b>' + money(r.receivedValue) + '</b>' +
          ' · 拥有 ' + r.ownedCount + ' 款' +
        '</div>' +
        '</div>';
    }).join('');
  }

  /** 秒 -> 「3.2 小时」/「45 分钟」 */
  function fmtDuration(secs) {
    var s = Math.max(0, Number(secs) || 0);
    if (s < 60) return '不到 1 分钟';
    var mins = s / 60;
    if (mins < 60) return Math.round(mins) + ' 分钟';
    var hours = mins / 60;
    if (hours < 100) return hours.toFixed(1) + ' 小时';
    return Math.round(hours) + ' 小时';
  }

  /**
   * 游戏名单元格：中文名为主，英文名作为小字注在下面。
   * 有些游戏 Steam 本身就只提供英文名（老游戏居多），那时主名即英文，不再重复显示小字。
   */
  function gameNameCell(g) {
    var main = String(g.name || '');
    var en = String(g.nameEn || '').trim();
    var sub = (en && en !== main.trim())
      ? '<span class="name-en">' + esc(en) + '</span>'
      : '';
    return '<span class="name-cn">' + esc(main) + '</span>' + sub +
      // ★ appid 也要过 esc()：在线链路它是 Number（安全），但 --from 吃的那份 JSON
      //   里可以是任意字符串 —— 报告是要发给别人双击打开的，这里不能靠「上游会过滤」。
      (g.appid ? '<span class="appid">' + esc(g.appid) + '</span>' : '');
  }

  /** 「展开更多」那一行：还能展开多少 / 是否已全部展示 */
  function updateMoreRow(total, shown) {
    var btn = $('#detailMore');
    var hint = $('#detailMoreHint');
    var rest = total - shown;
    if (btn) btn.hidden = rest <= 0;
    if (hint) {
      hint.textContent = rest > 0
        ? '还有 ' + rest + ' 款未显示（每次展开 ' + DETAIL_PAGE + ' 款）'
        : (total > 0 ? '已全部展示' : '');
    }
  }

  function renderDetail(res) {
    var host = $('#valueBody');
    // 标题旁的计数：游戏总数（和 KPI 里的「库内游戏」口径一致）
    var counter = $('#gameCount');
    if (counter) counter.textContent = state.games.length;

    if (!state.games.length) {
      host.innerHTML = '<tr><td colspan="5" class="empty">暂无数据</td></tr>';
      updateMoreRow(0, 0);
      return;
    }

    var byId = {};
    (res.games || []).forEach(function (g) { byId[g.gameId] = g; });

    // 和上方筛选控件共用同一套口径（只看有价值的 / 只看多人共有 / 隐藏免费 + 排序方式）
    var list = visibleGames(res);
    var total = list.length;
    var shown = detailShown(total);
    var hint = $('#gridHint');
    if (hint) {
      var txt = '所有权、使用者与游玩时长均来自 Steam 接口。';
      if (total !== state.games.length) txt += '（筛选后 ' + total + ' / ' + state.games.length + ' 款）';
      if (shown < total) txt += ' 已展示前 ' + shown + ' 款。';
      hint.textContent = txt;
    }
    updateMoreRow(total, shown);
    if (!total) {
      host.innerHTML = '<tr><td colspan="5" class="empty">当前筛选下没有游戏，试试关掉上面的筛选条件。</td></tr>';
      return;
    }
    list = list.slice(0, shown);

    host.innerHTML = list.map(function (g) {
      var r = byId[g.id] || {};
      var owners = (g.ownerIds || []).map(function (id) {
        var m = memberById(id);
        return m ? esc(m.name) : '';
      }).filter(Boolean).join('、') || '<span class="muted">—</span>';

      // ★ 使用者：谁玩了这款游戏、各玩了多久（拥有者玩自己的不算）
      var players = (g.playedBy || []).filter(function (id) {
        return (g.ownerIds || []).indexOf(id) < 0;
      }).map(function (id) {
        var m = memberById(id);
        var secs = (g.playtime || {})[id] || 0;
        // ★ 兜底那个 id 也要 esc()：正常链路里 playedBy 已经映射成内部成员 id
        //   （映射不到的会被 applyFamily 过滤掉），但这里不该留一个「原样插进 innerHTML」的出口 ——
        //   旧数据里没有 appid 的游戏对象是原样保留的，它的 playedBy 可能是任意字符串。
        return '<span class="player">' + (m ? esc(m.name) : esc(id)) +
          '<em>' + fmtDuration(secs) + '</em></span>';
      }).join('');

      return '<tr>' +
        '<td>' + gameNameCell(g) + '</td>' +
        '<td>' + owners + '</td>' +
        '<td class="players">' + (players || '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + (r.unitContribution ? money(r.unitContribution) : '—') + '</td>' +
        '<td class="num"><b>' + (r.totalContribution ? money(r.totalContribution) : '—') + '</b></td>' +
        '</tr>';
    }).join('');
  }

  function renderIssues() {
    var issues = SC.validate(state);
    var box = $('#issues');
    if (!issues.length) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = issues.map(function (i) {
      return '<div class="issue ' + i.level + '">' + esc(i.message) + '</div>';
    }).join('');
  }

  /**
   * 直接双击 index.html 时给个明确的提示。
   * ★ index.html 是**报告的模板**，本身不含数据，
   *   数据是 steam-family.js 生成报告时内联进去的。
   */
  function checkServedLocally() {
    if (SNAPSHOT) return false;   // 报告模式下数据就在页面里，不需要提示
    if (location.protocol === 'file:') {
      var bar = $('#snapshotBar');
      if (bar) {
        bar.hidden = false;
        bar.innerHTML = '<b>这是报告的模板，本身没有数据。</b>' +
          '跑 <code>node steam-family.js</code>（Windows 上双击 <code>run.bat</code>）' +
          '生成一份带数据的报告，再打开那个文件。';
      }
      return false;
    }
    return true;
  }

  // ------------------------------ 静态报告模式 ------------------------------

  /**
   * 静态报告的启动路径：把内联数据走**和在线导入完全一样的那条路**（applyFamily），
   * 两种模式共用同一套渲染与计分代码，不会各自漂移。
   *
   * 刻意不走 restore()：报告要展示的是快照那一刻的数据，
   * 不能被访客浏览器里残留的 localStorage 顶掉。
   */
  function applySnapshot() {
    var d = SNAPSHOT;
    if (!d || !d.family || !Array.isArray(d.family.games)) return false;
    // 计分口径要在 applyFamily 之前定好 —— 它内部会调 applyPriceMode()
    if (d.priceMode === 'original' || d.priceMode === 'final') ui.priceMode = d.priceMode;
    applyFamily(d.family);
    syncPriceModeUI();
    renderAll();
    markSnapshotChrome();
    return true;
  }

  /** 报告的外观：顶部说清这是一份快照 */
  function markSnapshotChrome() {
    var bar = $('#snapshotBar');
    if (!bar) return;
    bar.hidden = false;
    bar.innerHTML = '<b>这是一份静态快照</b>' +
      (SNAPSHOT.generatedAt ? '，生成于 ' + esc(fmtStamp(new Date(SNAPSHOT.generatedAt))) : '') +
      '，数据不会自动更新。筛选、排序、切换计分方式、展开更多都还能用。';
  }

  /** 快照时间戳（本地时区，精确到分钟） */
  function fmtStamp(d) {
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ------------------------------ 家庭组数据落进 state ------------------------------

  /**
   * 把一份家庭组数据（成员 + 共享库 + 归属）落进 state。
   * 这是「自动归属」的核心：ownerSteamIds 直接映射成成员 id，不需要用户勾选。
   */
  function applyFamily(data) {
    var stats = { members: 0, createdMembers: 0, games: 0, linked: 0 };

    // --- 成员 ---
    var bySteam = {};
    state.members.forEach(function (m) { if (m.steamid) bySteam[m.steamid] = m; });

    var next = [];
    (data.members || []).slice(0, MAX).forEach(function (m) {
      var existing = bySteam[m.steamid];
      if (existing) {
        existing.name = m.name || existing.name;
        existing.avatar = m.avatar || existing.avatar;
        next.push(existing);
      } else {
        next.push({
          id: uid('m'), name: m.name || ('玩家' + String(m.steamid).slice(-6)),
          avatar: m.avatar || '', steamid: m.steamid, accountId: m.accountId
        });
        stats.createdMembers += 1;
      }
    });
    // 老数据里没有 steamid 的成员（旧数据里手动加的）保留在后面，避免导入时静默丢人
    state.members.filter(function (m) { return !m.steamid; }).forEach(function (m) {
      if (next.length < MAX) next.push(m);
    });
    state.members = next;
    stats.members = next.length;

    var memberIdOf = {};
    state.members.forEach(function (m) { if (m.steamid) memberIdOf[m.steamid] = m.id; });

    // --- 游戏：以 appid 为键整体重建（价格一律来自 Steam 接口）---
    var oldByApp = {};
    state.games.forEach(function (g) { if (g.appid) oldByApp[g.appid] = g; });

    var games = (data.games || []).map(function (g) {
      var old = oldByApp[g.appid];   // 上次导入的同款游戏，用来沿用内部 id
      // 接口同时给折扣价（price / currentPrice = cnyFinal）与标价（originalPrice = cnyOriginal）。
      // 这里只登记两个来源；真正的 g.price 由 applyPriceMode() 按当前口径统一决定。
      var priceFinal = (g.price != null) ? g.price : ((g.currentPrice != null) ? g.currentPrice : 0);
      var priceOriginal = (g.originalPrice != null) ? g.originalPrice : priceFinal;
      var price = priceFinal;
      var priceSource = 'steam';      var ownerIds = (g.ownerSteamIds || []).map(function (s) { return memberIdOf[s]; })
        .filter(Boolean);
      // ★ 谁玩过这款游戏。这里带上全部（含拥有者），引擎会自己剔除拥有者与无效成员。
      var playedBy = (g.playedBy || []).map(function (s) { return memberIdOf[s]; })
        .filter(Boolean);
      // 每个人玩了多久（内部成员 id -> 秒），只用于明细表展示
      var playtime = {};
      Object.keys(g.playtime || {}).forEach(function (sid) {
        var mid = memberIdOf[sid];
        if (mid) playtime[mid] = g.playtime[sid];
      });
      stats.linked += ownerIds.length;
      return {
        id: old ? old.id : uid('g'),
        appid: g.appid,
        name: g.name || (old && old.name) || ('appid ' + g.appid),
        nameEn: g.nameEn || (old && old.nameEn) || '',   // 英文名，中文名下面做小字
        price: price,
        priceFinal: priceFinal,
        priceOriginal: priceOriginal,
        ownerIds: ownerIds,
        playedBy: playedBy,
        playtime: playtime,
        shareable: g.shareable,
        priceState: g.priceState,
        region: g.region || 'cn',
        regionLabel: g.regionLabel || '国区',
        currency: g.currency || 'CNY',
        rawOriginal: g.rawOriginal,
        currentPrice: g.currentPrice,
        discountPct: g.discountPct || 0,
        packageName: g.packageName || '',
        priceSource: priceSource
      };
    });

    // 老数据里没有 appid 的游戏（旧数据里手动加的）保留，避免导入时静默丢数据
    state.games.filter(function (g) { return !g.appid; }).forEach(function (g) { games.push(g); });

    state.games = games;
    // 新导入的游戏要立刻按当前口径（标价 / 折扣价）定好 g.price
    applyPriceMode();
    // 成员数变了 → 「和贡献榜一样长」的长度也跟着变；筛选项也要按新成员重建
    resetDetailLimit();
    syncDetailFilters();
    invalidateResults();   // 数据换了，两个口径的结果都要重算
    state.familyGroupId = data.familyGroupId || '';
    stats.games = games.length;
    return stats;
  }

  // ------------------------------ 普通操作 ------------------------------

  function exportJSON() {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'steam-family-contribution.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // ------------------------------ 事件 ------------------------------

  function bind() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!t) return;
      var act = t.getAttribute('data-act');
      var id = t.getAttribute('data-id');

      switch (act) {
        // 明细「展开更多」：每次追加 DETAIL_PAGE 行，直到全部展示（按钮会被隐藏）
        case 'detail-more':
          ui.detailLimit = (ui.detailLimit || 0) + DETAIL_PAGE;
          renderDetail(compute());
          break;
        case 'export': exportJSON(); break;
      }
    });

    // 弹层只读，没有可编辑控件；点遮罩关闭

    // ★ 计分口径切换：改了要重算**所有**数值（不只是明细），所以走 refreshResults()
    $('#priceMode').addEventListener('change', function (e) {
      setPriceMode(e.target.value);
    });

    // 筛选/排序改了 = 换了一批要看的数据，展开进度跟着回到默认长度
    $('#sortMode').addEventListener('change', function (e) {
      ui.sortMode = e.target.value;
      resetDetailLimit();
      renderDetail(compute());
    });
    // ★ 提供者 / 使用者筛选：只看「谁提供的」或「谁玩的」
    ['#filterOwner', '#filterPlayer'].forEach(function (sel) {
      var el = $(sel);
      if (!el) return;
      el.addEventListener('change', function (e) {
        ui[sel === '#filterOwner' ? 'filterOwner' : 'filterPlayer'] = e.target.value;
        resetDetailLimit();
        renderDetail(compute());
      });
    });
    $('#onlyValuable').addEventListener('change', function (e) {
      ui.onlyValuable = !!e.target.checked;
      resetDetailLimit();
      renderDetail(compute());
    });
    $('#onlyShared').addEventListener('change', function (e) {
      ui.onlyShared = !!e.target.checked;
      resetDetailLimit();
      renderDetail(compute());
    });
    $('#hideFree').addEventListener('change', function (e) {
      ui.hideFree = !!e.target.checked;
      resetDetailLimit();
      renderDetail(compute());
    });

  }

  // ------------------------------ 启动 ------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    bind();

    // ★ 静态报告：数据已经内联在页面里，渲染完就结束 —— 不探活、不读 localStorage
    if (SNAPSHOT) {
      if (!applySnapshot()) {
        var errBar = $('#snapshotBar');
        if (errBar) {
          errBar.hidden = false;
          errBar.innerHTML = '<b>这份报告里没有可用的数据</b>（<code>__FAMILY_DATA__</code> 为空）—— '
            + '生成时就没读到家庭组。重新跑一次 <code>node steam-family.js</code>。';
        }
      }
      return;
    }

    // 口径选择要在 restore() 之前读出来，applyPriceMode() 才知道按哪个口径定 g.price
    var pm = loadStored(PRICE_MODE_STORAGE);
    if (pm === 'original' || pm === 'final') ui.priceMode = pm;

    restore();   // 只恢复上次从接口读到的数据；没有就显示空状态
    applyPriceMode();
    syncPriceModeUI();
    syncDetailFilters();
    resetDetailLimit();
    renderAll();
    checkServedLocally();
  });
})();
