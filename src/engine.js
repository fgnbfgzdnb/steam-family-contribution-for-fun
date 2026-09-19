/*!
 * Steam 家庭组贡献度 · 计算内核 (Contribution Engine)
 * ------------------------------------------------------------------
 * 纯函数、零依赖、无 DOM。浏览器（window.SCContribution）与 Node（module.exports）双端可用，
 * 因此可以：报告端实时算 + 脚本离线算，共用同一套规则。
 *
 * 计分规则（与 README「计分规则」一节是同一套口径）：
 *   设某款游戏的价格为 P，家庭组共 N 人，其中 O 人拥有、
 *   M = 「非拥有者里真的玩过它」的人数（来自 playedBy；拥有者自己玩自己的不算）。
 *   该游戏产生的共享价值 = M * P，
 *   由 O 位拥有者均分 -> 每位拥有者记 (M * P) / O 分。
 *
 *   ★ 这里 N / O / M / P 是本规则的记号，与 README 一致；代码里的变量用全名
 *     （nMembers / nOwners / nNonOwners / nPlayed），别把两套记号混起来。
 *
 *   以下情况记 0 分（语义都是「没有向家庭组输出共享价值」）：
 *   - O = 0（无人拥有）：根本不进家庭组游戏库。
 *   - P = 0（免费游戏）：免费游戏本身也被排除在家庭共享之外。
 *   - shareable = false（该游戏不支持 Steam 家庭共享）：别人根本玩不到，共享价值为 0。
 *     ← 关键：这是「拥有便宜游戏就吃亏」之外的另一类不公平来源，必须排除。
 *   - O = N（全员拥有）：无人因此受益。
 *   - ★ M = 0（无人玩过）：有人拥有、也能共享，但没有任何非拥有者玩过它。
 *     这是本口径最核心的一条 —— 漏掉它，整张贡献榜会静默变成 0 分且不报错。
 *
 * 单位约定：对外入参 price 为「元」，内部一律用「分」的整数做累加，避免浮点误差，
 *          输出同时给出 Cents 字段与转换好的元值。
 *
 * 不变量：sum(每人贡献分) === sum(每人从他人游戏获得的价值)
 *        —— 单元测试用它当正确性护栏，新增规则时不可破坏。
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.SCContribution = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  /** Steam 家庭组上限 */
  var MAX_MEMBERS = 6;

  var STATUS = {
    ACTIVE: 'active',              // 计入分配
    UNIVERSAL: 'universal',        // 全员拥有，0 分
    FREE: 'free',                  // 免费游戏，0 分
    UNOWNED: 'unowned',            // 无人拥有，0 分
    NOT_SHAREABLE: 'not-shareable', // 不支持家庭共享，0 分
    UNPLAYED: 'unplayed'           // ★ 可共享但没有任何「非拥有者」玩过，0 分
  };

  var STATUS_TEXT = {
    active: '计入分配',
    universal: '全员拥有',
    free: '免费游戏',
    unowned: '无人拥有',
    'not-shareable': '不支持共享',
    unplayed: '无人玩过'
  };

  // ------------------------------ 金额工具 ------------------------------

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  /** 元 -> 分（整数） */
  function toCents(yuan) {
    var n = Number(yuan);
    if (!isFinite(n) || n < 0) return 0;
    return Math.round(n * 100);
  }

  /** 分 -> 元（保留 2 位） */
  function toYuan(cents) {
    return round2(Number(cents || 0) / 100);
  }

  /** 元 -> "¥1,234.00" */
  function formatYuan(yuan) {
    var n = Number(yuan || 0);
    return '¥' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** 分 -> "¥1,234.00" */
  function formatCents(cents) {
    return formatYuan(toYuan(cents));
  }

  /** 是否参与家庭共享。缺省视为「可共享」（拿不准时不误伤，少算价值总比多算好）。 */
  function isShareable(game) {
    return !(game && game.shareable === false);
  }

  // ------------------------------ 校验 ------------------------------

  /**
   * 校验输入数据，返回问题列表（空数组 = 无问题）。
   * @returns {Array<{level:string, code:string, message:string}>}
   */
  function validate(state) {
    var issues = [];
    var members = (state && state.members) || [];
    var games = (state && state.games) || [];

    if (members.length > MAX_MEMBERS) {
      issues.push({
        level: 'error',
        code: 'TOO_MANY_MEMBERS',
        message: '家庭组最多 ' + MAX_MEMBERS + ' 人，当前 ' + members.length + ' 人。'
      });
    }

    var seenMember = {};
    members.forEach(function (m) {
      if (!m.id) {
        issues.push({ level: 'error', code: 'MEMBER_NO_ID', message: '存在没有 id 的成员。' });
      } else if (seenMember[m.id]) {
        issues.push({ level: 'error', code: 'DUP_MEMBER_ID', message: '成员 id 重复：' + m.id });
      }
      seenMember[m.id] = true;
      if (!m.name || !String(m.name).trim()) {
        issues.push({ level: 'warn', code: 'MEMBER_NO_NAME', message: '成员 ' + m.id + ' 没有昵称。' });
      }
    });

    var memberIds = {};
    members.forEach(function (m) { memberIds[m.id] = true; });

    var seenGame = {};
    games.forEach(function (g) {
      if (!g.id) {
        issues.push({ level: 'error', code: 'GAME_NO_ID', message: '存在没有 id 的游戏。' });
      } else if (seenGame[g.id]) {
        issues.push({ level: 'error', code: 'DUP_GAME_ID', message: '游戏 id 重复：' + g.id });
      }
      seenGame[g.id] = true;

      if (Number(g.price) < 0 || !isFinite(Number(g.price))) {
        issues.push({ level: 'error', code: 'BAD_PRICE', message: '游戏《' + g.name + '》价格非法。' });
      }
      (g.ownerIds || []).forEach(function (id) {
        if (!memberIds[id]) {
          issues.push({
            level: 'warn',
            code: 'ORPHAN_OWNER',
            message: '游戏《' + g.name + '》标记了不存在的成员 ' + id + '，已忽略。'
          });
        }
      });
    });

    return issues;
  }

  // ------------------------------ 核心计算 ------------------------------

  /**
   * 计算贡献度。
   * @param {{
   *   members: Array<{id:string,name:string,avatar?:string}>,
   *   games: Array<{id:string,name:string,price:number,ownerIds:string[],shareable?:boolean,appid?:number}>
   * }} state
   * @returns {{meta:object, rows:Array<object>, games:Array<object>, totals:object}}
   */
  function calculate(state) {
    var members = (state && state.members) || [];
    var games = (state && state.games) || [];
    var nMembers = members.length;

    var index = {};
    var acc = members.map(function (m, i) {
      var rec = {
        memberId: m.id,
        name: m.name,
        order: i,
        scoreCents: 0,
        ownedCount: 0,
        ownedValueCents: 0,        // 名下全部游戏原价（含不可共享的，仅作展示）
        ownedShareableCount: 0,    // 其中可参与共享的数量
        receivedValueCents: 0,
        details: []
      };
      index[m.id] = rec;
      return rec;
    });

    var gameRows = [];
    var libraryValueCents = 0;     // 家庭组去重后「全部」游戏的原价合计
    var groupValueCents = 0;       // 其中「可共享」部分的原价合计（真正的共享池）
    var activeGameCount = 0;       // 真正产生分配的游戏数
    var notShareableCount = 0;
    var notShareableValueCents = 0;
    var unplayedCount = 0;         // 可共享、有价，但没有任何非拥有者玩过
    var unplayedValueCents = 0;    // 这些游戏的原价合计 —— 「闲置的共享池」

    games.forEach(function (g) {
      var priceCents = toCents(g.price);
      var shareable = isShareable(g);

      // 拥有者去重 + 过滤掉不存在的成员
      var seen = {};
      var owners = [];
      (g.ownerIds || []).forEach(function (id) {
        if (index[id] && !seen[id]) {
          seen[id] = true;
          owners.push(id);
        }
      });

      var nOwners = owners.length;
      var nNonOwners = Math.max(0, nMembers - nOwners);

      if (nOwners > 0) {
        libraryValueCents += priceCents;
        if (shareable) groupValueCents += priceCents;
        // 只统计「因为不支持共享而损失了价值」的付费游戏：
        // 免费游戏本来就不产生价值，混进来只会让这个数字虚高、误导人。
        else if (priceCents > 0) { notShareableCount += 1; notShareableValueCents += priceCents; }
      }

      var totalContributionCents = 0;
      var unitContributionCents = 0;
      var status;

      // ★ 实际玩过这款游戏的「非拥有者」—— 只有他们真正从共享里获益。
      // playedBy 由上游（Steam GetPlaytimeSummary）给出；缺省即「没人玩过」。
      // 注意：拥有者自己玩自己的游戏不算 —— 那没有给别人带来价值。
      var played = [];
      var playedSeen = {};
      (g.playedBy || []).forEach(function (id) {
        if (index[id] && !seen[id] && !playedSeen[id]) {
          playedSeen[id] = true;
          played.push(id);
        }
      });
      var nPlayed = played.length;

      // 判定顺序 = 「为什么不计分」的原因，从最本质的往外排：
      // 没人拥有 -> 免费 -> 不能共享 -> 全员都有 -> 没人玩过 -> 才轮到真正计分
      if (nOwners === 0) {
        status = STATUS.UNOWNED;
      } else if (priceCents === 0) {
        status = STATUS.FREE;
      } else if (!shareable) {
        status = STATUS.NOT_SHAREABLE;
      } else if (nNonOwners === 0) {
        status = STATUS.UNIVERSAL;
      } else if (nPlayed === 0) {
        status = STATUS.UNPLAYED;
        unplayedCount += 1;
        unplayedValueCents += priceCents;
      } else {
        status = STATUS.ACTIVE;
        totalContributionCents = priceCents * nPlayed;
        activeGameCount += 1;
      }

      // ★ 平摊给拥有者时用「分」整数：除不尽就把余数依次补给前几位，
      // 保证 nOwners 个人拿到的总和精确等于 totalContributionCents。
      // （浮点除法会让守恒不变量差出 1e-8 分，展示看不出来但断言会飘。）
      var baseUnitCents = nOwners > 0 ? Math.floor(totalContributionCents / nOwners) : 0;
      var remainderCents = nOwners > 0 ? totalContributionCents - baseUnitCents * nOwners : 0;
      unitContributionCents = baseUnitCents;

      // 记入拥有者
      owners.forEach(function (id, ownerIndex) {
        var rec = index[id];
        var myUnitCents = baseUnitCents + (ownerIndex < remainderCents ? 1 : 0);
        rec.ownedCount += 1;
        rec.ownedValueCents += priceCents;
        if (shareable) rec.ownedShareableCount += 1;
        if (myUnitCents > 0) {
          rec.scoreCents += myUnitCents;
          rec.details.push({
            gameId: g.id,
            name: g.name,
            priceCents: priceCents,
            price: toYuan(priceCents),
            ownerCount: nOwners,
            beneficiaryCount: nPlayed,
            potentialCount: nNonOwners,
            contributionCents: myUnitCents,
            contribution: toYuan(myUnitCents)
          });
        }
      });

      // 记入受益方：★ 只有「实际玩过」的非拥有者才算白玩到。
      // 没人玩过的游戏不产生任何受益 —— 这正是新口径的核心。
      if (nOwners > 0 && shareable && priceCents > 0 && nPlayed > 0) {
        played.forEach(function (id) {
          index[id].receivedValueCents += priceCents;
        });
      }

      gameRows.push({
        gameId: g.id,
        appid: g.appid || null,
        name: g.name,
        priceCents: priceCents,
        price: toYuan(priceCents),
        shareable: shareable,
        ownerIds: owners,
        ownerCount: nOwners,
        beneficiaryCount: nPlayed,
        potentialCount: nNonOwners,
        playedByIds: played,
        unitContributionCents: unitContributionCents,
        unitContribution: toYuan(unitContributionCents),
        totalContributionCents: totalContributionCents,
        totalContribution: toYuan(totalContributionCents),
        status: status,
        statusText: STATUS_TEXT[status]
      });
    });

    var totalsScoreCents = 0;
    var totalsReceivedCents = 0;
    acc.forEach(function (r) {
      totalsScoreCents += r.scoreCents;
      totalsReceivedCents += r.receivedValueCents;
    });

    var rows = acc.map(function (r) {
      return {
        memberId: r.memberId,
        name: r.name,
        order: r.order,
        scoreCents: r.scoreCents,
        score: toYuan(r.scoreCents),
        share: totalsScoreCents > 0 ? r.scoreCents / totalsScoreCents : 0,
        ownedCount: r.ownedCount,
        ownedShareableCount: r.ownedShareableCount,
        ownedValueCents: r.ownedValueCents,
        ownedValue: toYuan(r.ownedValueCents),
        receivedValueCents: r.receivedValueCents,
        receivedValue: toYuan(r.receivedValueCents),
        // ★ 净贡献 = 贡献 − 使用。>0 净输出价值给家庭组，<0 净白玩了别人的
        netCents: r.scoreCents - r.receivedValueCents,
        net: toYuan(r.scoreCents - r.receivedValueCents),
        // 受益/贡献比：>1 表示从别人那里获得的价值高于自己贡献出去的。
        // ★ 自己贡献为 0 又确实白玩到了别人的：比值是「无穷」—— 用 null 表示「算不出来」，
        //   别塞 Infinity 进去：JSON.stringify(Infinity) 会静默变成 null，
        //   于是「JSON 链路」和「内存链路」拿到的值会不一样，看着正常、其实不是一个东西。
        ratio: r.scoreCents > 0
          ? r.receivedValueCents / r.scoreCents
          : (r.receivedValueCents > 0 ? null : 0),
        details: r.details.slice().sort(function (a, b) {
          return b.contributionCents - a.contributionCents;
        })
      };
    });

    rows.sort(function (a, b) {
      return b.scoreCents - a.scoreCents || a.order - b.order;
    });
    rows.forEach(function (r, i) { r.rank = i + 1; });

    return {
      meta: {
        memberCount: nMembers,
        gameCount: games.length,
        activeGameCount: activeGameCount,
        shareableGameCount: games.filter(isShareable).length,
        notShareableCount: notShareableCount,
        notShareableValueCents: notShareableValueCents,
        notShareableValue: toYuan(notShareableValueCents),
        libraryValueCents: libraryValueCents,
        libraryValue: toYuan(libraryValueCents),   // 全部游戏原价（含不可共享）
        groupValueCents: groupValueCents,
        groupValue: toYuan(groupValueCents),       // 家庭组共享池原价（仅可共享）
        unplayedCount: unplayedCount,
        unplayedValueCents: unplayedValueCents,
        unplayedValue: toYuan(unplayedValueCents), // 闲置的共享池：可共享却没人玩过
        avgScoreCents: nMembers > 0 ? totalsScoreCents / nMembers : 0,
        avgScore: toYuan(nMembers > 0 ? totalsScoreCents / nMembers : 0)
      },
      rows: rows,
      games: gameRows,
      totals: {
        scoreCents: totalsScoreCents,
        score: toYuan(totalsScoreCents),
        receivedValueCents: totalsReceivedCents,
        receivedValue: toYuan(totalsReceivedCents)
      }
    };
  }

  return {
    MAX_MEMBERS: MAX_MEMBERS,
    STATUS: STATUS,
    STATUS_TEXT: STATUS_TEXT,
    isShareable: isShareable,
    toCents: toCents,
    toYuan: toYuan,
    round2: round2,
    formatYuan: formatYuan,
    formatCents: formatCents,
    validate: validate,
    calculate: calculate
  };
});
