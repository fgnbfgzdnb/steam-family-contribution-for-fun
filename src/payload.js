/*!
 * 前端载荷组装 —— 「Steam 数据 → 浏览器认的字段」的**唯一**实现处。
 *
 * 为什么单独抽一个文件：
 *   同一个形状有两个消费者 ——
 *     ① steam-family.js（交互式一条命令出报告）
 *     ② tools/family-report.js（终端报表 / --html 静态报告 / --json）
 *   两处各写一份就是口径漂移的温床：
 *     · 改「折扣价」口径时容易只改一处，另一处仍是原价；
 *     · playedBy（按「被别人实际玩过」计分）一旦漏给，算出来的贡献分全是 0 ——
 *       因为「不给 playedBy」的语义是「没人玩过 = 不计分」，而且不会报任何错。
 *   所以组装逻辑只留这一份，两个消费者都调它。
 *
 * 纯函数：不发请求、不读文件、不认识 priceCache。
 */
'use strict';

/**
 * 把一条价格记录摊平成前端要的字段。
 *
 * ★ 双口径：`price` = 当前国区折扣价（cnyFinal），`originalPrice` = 无折扣标价（cnyOriginal）。
 *   两个都发出去，由前端按用户选的计分方式决定用哪个（见 app.js 的 priceSourceOf）。
 *   绝不要在这里二选一 —— 那会让页面上的口径切换失效。
 */
function toGamePriceFields(p) {
  p = p || {};
  const priced = p.priceState === 'priced';
  return {
    price: priced ? p.cnyFinal : 0,
    originalPrice: priced ? p.cnyOriginal : 0,   // 无折扣标价，展示对比 + 切换口径用
    currentPrice: priced ? p.cnyFinal : 0,
    rawOriginal: (p.originalCents || 0) / 100,   // 原区域货币的原价，展示用
    currency: p.currency || 'CNY',
    region: p.region || 'cn',
    regionLabel: p.regionLabel || '国区',
    discountPct: p.discountPct || 0,
    shareable: p.shareable !== false,
    priceState: p.priceState || 'unknown',
    isFree: !!p.isFree,
    packageName: p.packageName || '',
    storeUrlPath: p.storeUrlPath || ''
  };
}

/**
 * 组装成前端 applyFamily() 吃的对象（= 报告的离线数据形状，夹具见 tests/fixtures/family-api-sample.json）。
 *
 * @param {object} fam       steam.resolveFamily() 的结果
 * @param {object} [priceMap] steam.getPrices() 的 prices（appid -> 记录）；缺省 = 全部无价
 * @param {object} [priceMeta] 价格来源元信息，原样透传 —— ★但 warnings 例外，见 priceMetaForReport()
 */
function buildFamilyPayload(fam, priceMap, priceMeta) {
  const prices = priceMap || {};
  const byApp = {};

  fam.apps.forEach((a) => {
    byApp[a.appid] = Object.assign({
      appid: a.appid,
      // 主名字：优先用价格接口给的（请求带了 schinese，多数游戏会返回中文名）
      name: (prices[a.appid] && prices[a.appid].name) || a.name || '',
      // 家庭组接口自带的英文名 —— 页面上作为小字注在主名下面。
      // 有些游戏 Steam 本身就只提供英文名（老游戏居多），那时两者相同，页面不重复显示。
      nameEn: a.name || '',
      // ★ 归属用「原始 steamid」，由前端 applyFamily() 映射成内部成员 id
      ownerSteamIds: a.ownerSteamIds,
      ownerCount: a.ownerSteamIds.length,
      playtimeForever: a.playtimeForever,
      // ★★ 谁玩过这款游戏 —— 计分口径的依据（引擎会自行剔除拥有者）。
      //     漏掉这个字段的后果不是「退回按拥有计分」，而是**这款游戏直接 0 分**。
      playedBy: a.playedBy || [],
      // 每个人玩了多久（steamid -> 秒），只用于明细表展示
      playtime: a.playtime || {}
    }, toGamePriceFields(prices[a.appid]));
  });

  return {
    familyGroupId: fam.familyGroupId,
    members: fam.members,
    games: Object.values(byApp),
    playtimeAvailable: !!fam.playtimeAvailable,
    priceMeta: priceMetaForReport(priceMeta)
  };
}

/**
 * 价格元信息进报告前剔掉 warnings。
 *
 * ★ 为什么要把 warnings 单独拎出来：
 *   warnings 里会拼「远端返回的原话」（中间层回的错误页、代理的报错、Steam 的兜底文案），
 *   而这份报告是要**转发给别人双击打开**的 —— 把远端可控文本内联进产物，等于自己开一条
 *   外带通道（对端若在错误页里回显请求 URL，那串 URL 上就带着 access_token）。
 *   src/steam.js 的 redactText() 已经在源头洗过一遍，这里再按字段剔一次，是第二道。
 *   （跑脚本的人在终端已经逐条看过这些告警；报告里本来也没有任何地方渲染它。
 *     哪天要在报告里显示告警，请改这里而不是直接透传。）
 */
function priceMetaForReport(priceMeta) {
  if (!priceMeta) return null;
  const out = {};
  Object.keys(priceMeta).forEach(function (k) {
    if (k === 'warnings') return;
    out[k] = priceMeta[k];
  });
  return out;
}

/**
 * 前端形状 -> 引擎输入。
 * 成员映射成本地短 id（m0/m1…），只在这个进程里有意义 ——
 * 引擎只要求 ownerIds / playedBy 里的 id 能在 members 里找到。
 *
 * ★ 网页那边走的是 app.js 的 applyFamily()，做的是同一件事，
 *   但它在浏览器里跑、没法 require 这个模块。改动时两边要对齐，
 *   tests/payload.test.js 守着这一份。
 */
function toEngineInput(payload) {
  const members = payload.members.map((m, i) => ({
    id: 'm' + i, name: m.name, avatar: m.avatar, steamid: m.steamid
  }));
  const memberIdOf = {};
  members.forEach((m) => { memberIdOf[m.steamid] = m.id; });

  const games = payload.games.map((g) => {
    const playtime = {};
    Object.keys(g.playtime || {}).forEach((sid) => {
      const mid = memberIdOf[sid];
      if (mid) playtime[mid] = g.playtime[sid];
    });
    return {
      id: 'g' + g.appid,
      appid: g.appid,
      name: g.name || String(g.appid),
      // ★ 计分口径与网页一致：当前国区折扣价（payload 的 price = cnyFinal）。
      //   要换标价口径就改用 g.originalPrice —— 但网页与报表的口径必须一致。
      price: g.priceState === 'priced' ? (g.price || 0) : 0,
      ownerIds: (g.ownerSteamIds || []).map((s) => memberIdOf[s]).filter(Boolean),
      // ★★ 必须带 —— 引擎按「被别人实际玩过」计分。漏掉这个字段不是退回按拥有计分，
      //     而是这些游戏全部 0 分，且不会报任何错。
      playedBy: (g.playedBy || []).map((s) => memberIdOf[s]).filter(Boolean),
      playtime: playtime,
      shareable: g.shareable !== false,
      priceState: g.priceState || 'unknown',
      region: g.region || 'cn',
      regionLabel: g.regionLabel || '国区'
    };
  });

  return { familyGroupId: payload.familyGroupId, members: members, games: games };
}

module.exports = { toGamePriceFields, buildFamilyPayload, toEngineInput };
