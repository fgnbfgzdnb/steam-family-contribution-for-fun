/*!
 * Steam 接入层单测（完全离线，不联网）
 * 用实测到的真实响应结构做 fixture，把下面这些边界锁住，避免以后被改回去：
 *   - 捆绑包价格不能当游戏本体价（全面战争：三国）
 *   - 免费游戏的付费附加项不算本体价（CS2 的优先状态升级）
 *   - 分类 62 = 支持家庭共享
 *   - 打折时要用 original_price_in_cents 而不是现价
 *   - steamid 各种形态的换算
 *
 * 运行：node tests/steam.test.js
 */
'use strict';

const assert = require('assert');
const S = require('../src/steam.js');

var passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('  \u2713 ' + name);
}

/* ---------- fixture：实测响应片段 ---------- */

// 艾尔登法环：本体 298 + 豪华版 398 + 终极版 498
var ELDEN_RING = {
  appid: 1245620, name: '艾尔登法环', type: 0,
  categories: { feature_categoryids: [22, 29, 67, 68, 69, 70, 74, 79, 23, 62] },
  best_purchase_option: { packageid: 440408, purchase_option_name: '艾尔登法环', final_price_in_cents: '29800' },
  purchase_options: [
    { packageid: 440408, purchase_option_name: '艾尔登法环', final_price_in_cents: '29800', included_game_count: 1 },
    { packageid: 1010505, purchase_option_name: '艾尔登法环 豪华版', final_price_in_cents: '39800', included_game_count: 1 },
    { packageid: 1010506, purchase_option_name: '艾尔登法环 终极版', final_price_in_cents: '49800', included_game_count: 1 }
  ]
};

// 全面战争：三国 —— best_purchase_option 指向捆绑包，本体其实是 198
var THREE_KINGDOMS = {
  appid: 779340, name: '全面战争：三国', type: 0,
  categories: { feature_categoryids: [22, 62] },
  best_purchase_option: {
    bundleid: 22528, purchase_option_name: 'Total War: THREE KINGDOMS - Warlord Edition',
    final_price_in_cents: '10948', bundle_discount_pct: 66, price_before_bundle_discount: '32200'
  },
  purchase_options: [
    { bundleid: 22528, purchase_option_name: 'Total War: THREE KINGDOMS - Warlord Edition', final_price_in_cents: '10948', included_game_count: 1 },
    { packageid: 300010, purchase_option_name: '全面战争：三国', final_price_in_cents: '19800', included_game_count: 1 },
    { bundleid: 22529, purchase_option_name: 'Total War: THREE KINGDOMS COLLECTION', final_price_in_cents: '20400', included_game_count: 1 }
  ]
};

// CS2：免费游戏，但挂着可购买的「优先状态升级」¥103
var CS2 = {
  appid: 730, name: 'Counter-Strike 2', type: 0, is_free: true,
  categories: { feature_categoryids: [29, 30, 51, 35, 64, 66, 67, 68, 69, 70, 74, 8, 15, 41, 42, 43, 63] },
  best_purchase_option: null,
  purchase_options: [
    { packageid: 54029, purchase_option_name: '优先状态升级', final_price_in_cents: '10300', included_game_count: 1 }
  ]
};

// 博德之门 3：打折中，30% off
var BG3_SALE = {
  appid: 1086940, name: '博德之门3', type: 0,
  categories: { feature_categoryids: [22, 29, 64, 65, 66, 67, 68, 69, 70, 74, 78, 79, 23, 43, 44, 62] },
  best_purchase_option: {
    packageid: 907539, purchase_option_name: "Baldur's Gate 3",
    final_price_in_cents: '20860', original_price_in_cents: '29800', discount_pct: 30
  },
  purchase_options: [
    { packageid: 907539, purchase_option_name: "Baldur's Gate 3", final_price_in_cents: '20860', original_price_in_cents: '29800', discount_pct: 30, included_game_count: 1 }
  ]
};

// GTA V：国区不可售，一个购买选项都没有
var GTA5 = {
  appid: 271590, name: 'Grand Theft Auto V', type: 0, unlisted: true,
  categories: { feature_categoryids: [22, 41, 42, 43] },
  best_purchase_option: null,
  purchase_options: []
};

// 荒野大镖客 2：有价格，含分类 62
var RDR2_SHARE = {
  appid: 1174180, name: 'Red Dead Redemption 2', type: 0,
  categories: { feature_categoryids: [22, 29, 62, 23] },
  best_purchase_option: { packageid: 308805, purchase_option_name: 'Red Dead Redemption 2', final_price_in_cents: '27900' },
  purchase_options: [{ packageid: 308805, purchase_option_name: 'Red Dead Redemption 2', final_price_in_cents: '27900', included_game_count: 1 }]
};

// 实测中 荒野大镖客2 其实是不可共享的（需要 Rockstar 启动器），这里用作反例
var RDR2_NO_SHARE = {
  appid: 1174180, name: 'Red Dead Redemption 2', type: 0,
  categories: { feature_categoryids: [22, 29, 23] },
  best_purchase_option: { packageid: 308805, purchase_option_name: 'Red Dead Redemption 2', final_price_in_cents: '27900' },
  purchase_options: [{ packageid: 308805, purchase_option_name: 'Red Dead Redemption 2', final_price_in_cents: '27900', included_game_count: 1 }]
};

(async function main() {

  console.log('\n[1] steamid 解析');

  await test('steamid64 直接识别', function () {
    assert.deepStrictEqual(S.parseSteamId('76561197960435530'), { type: 'steamid64', steamid64: '76561197960435530' });
  });

  await test('个人资料链接 -> steamid64', function () {
    assert.strictEqual(S.parseSteamId('https://steamcommunity.com/profiles/76561197960435530/abc').steamid64, '76561197960435530');
  });

  await test('自定义链接 -> vanity（需要联网解析）', function () {
    assert.deepStrictEqual(S.parseSteamId('https://steamcommunity.com/id/gabelogannewell/'), { type: 'vanity', vanity: 'gabelogannewell' });
    assert.deepStrictEqual(S.parseSteamId('gabelogannewell'), { type: 'vanity', vanity: 'gabelogannewell' });
  });

  await test('STEAM_x:y:z 与 [U:1:id] 本地换算成 steamid64', function () {
    assert.strictEqual(S.parseSteamId('STEAM_0:0:1234').steamid64, '76561197960268196');
    assert.strictEqual(S.parseSteamId('STEAM_1:1:1234').steamid64, '76561197960268197');
    assert.strictEqual(S.parseSteamId('[U:1:2468]').steamid64, '76561197960268196');
  });

  await test('垃圾输入返回 null 而不是抛异常', function () {
    assert.strictEqual(S.parseSteamId('bad@@@'), null);
    assert.strictEqual(S.parseSteamId(''), null);
    assert.strictEqual(S.parseSteamId(null), null);
  });

  await test('steamid64 <-> 账号 id 互转（超出 JS 安全整数，必须走 BigInt）', function () {
    assert.strictEqual(S.steamId64ToAccountId('76561197960435530'), '169802');
    assert.strictEqual(S.accountIdToSteamId64('169802'), '76561197960435530');
  });

  console.log('\n[2] 价格归一化');

  await test('本体与多个版本并存时取最便宜的本体（艾尔登法环 298，不是 398/498）', function () {
    var m = S.mapStoreItem(ELDEN_RING);
    assert.strictEqual(m.originalCents, 29800);
    assert.strictEqual(m.priceState, 'priced');
    assert.strictEqual(m.packageName, '艾尔登法环');
  });

  await test('★ 不能把捆绑包价当本体价（全面战争三国 = 198，而非捆绑包的 109.48）', function () {
    var m = S.mapStoreItem(THREE_KINGDOMS);
    assert.strictEqual(m.originalCents, 19800);
    assert.strictEqual(m.packageName, '全面战争：三国');
  });

  await test('捆绑包的原价按打折前算（322 而不是 109.48）', function () {
    // 注意：真实响应里只有 best_purchase_option 带 price_before_bundle_discount，
    // purchase_options 里的 bundle 条目是不带的，所以这里断言的是 best 那个对象。
    assert.strictEqual(S.optionOriginalCents(THREE_KINGDOMS.best_purchase_option), 32200);
  });

  await test('免费游戏的付费附加项不算本体价（CS2 = 0，不是 103）', function () {
    var m = S.mapStoreItem(CS2);
    assert.strictEqual(m.priceState, 'free');
    assert.strictEqual(m.originalCents, 0);
    assert.strictEqual(m.finalCents, 0);
    assert.strictEqual(m.isFree, true);
  });

  await test('打折时用无折扣原价（博德之门3 = 298，而不是现价 208.60）', function () {
    var m = S.mapStoreItem(BG3_SALE);
    assert.strictEqual(m.originalCents, 29800);
    assert.strictEqual(m.finalCents, 20860);
    assert.strictEqual(m.discountPct, 30);
  });

  await test('打折但缺 original 字段时按折扣率反推，不把折扣价当原价', function () {
    var m = S.mapStoreItem({
      appid: 1, name: 'X', categories: {},
      purchase_options: [{ packageid: 1, final_price_in_cents: '5000', discount_pct: 50, included_game_count: 1 }]
    });
    assert.strictEqual(m.originalCents, 10000);
  });

  await test('国区不可售 -> priceState = unavailable 且价格为 0（GTA V）', function () {
    var m = S.mapStoreItem(GTA5);
    assert.strictEqual(m.priceState, 'unavailable');
    assert.strictEqual(m.originalCents, 0);
  });

  await test('其它版本列表会一并带出，供界面切换', function () {
    var m = S.mapStoreItem(ELDEN_RING);
    assert.strictEqual(m.alternatives.length, 3);
    assert.deepStrictEqual(m.alternatives.map(function (a) { return a.originalCents; }), [29800, 39800, 49800]);
  });

  await test('并列版本里捆绑包不会混进 alternatives（只收真正的 app 包）', function () {
    var m = S.mapStoreItem(THREE_KINGDOMS);
    assert.strictEqual(m.alternatives.length, 1);
    assert.strictEqual(m.alternatives[0].packageId, 300010);
  });

  console.log('\n[3] 家庭共享判定（Steam 商店分类 62）');

  await test('含分类 62 -> 可共享', function () {
    assert.strictEqual(S.mapStoreItem(ELDEN_RING).shareable, true);
    assert.strictEqual(S.mapStoreItem(RDR2_SHARE).shareable, true);
  });

  await test('不含分类 62 -> 不可共享（第三方启动器游戏）', function () {
    assert.strictEqual(S.mapStoreItem(RDR2_NO_SHARE).shareable, false);
    assert.strictEqual(S.mapStoreItem(GTA5).shareable, false);
    assert.strictEqual(S.mapStoreItem(CS2).shareable, false);
  });

  await test('分类字段缺失时不报错，按不可共享处理（保守策略）', function () {
    assert.strictEqual(S.mapStoreItem({ appid: 9, name: 'X', purchase_options: [] }).shareable, false);
  });

  console.log('\n[4] 无效输入');

  await test('null / 空 item 返回 null', function () {
    assert.strictEqual(S.mapStoreItem(null), null);
    assert.strictEqual(S.mapStoreItem(undefined), null);
  });

  await test('appid 为 0 的无效条目会被识别出来（据此过滤无效项）', function () {
    assert.strictEqual(S.mapStoreItem({ id: 0, appid: 0, name: '', success: 15, visible: false }).appid, 0);
  });

  console.log('\n[5] 缓存');

  await test('createCache 读写与 TTL 过期（不落盘）', async function () {
    var c = S.createCache(null, 40);
    c.set('a', { v: 1 });
    assert.deepStrictEqual(c.get('a'), { v: 1 });
    await new Promise(function (r) { setTimeout(r, 60); });
    assert.strictEqual(c.get('a'), undefined);
  });

  await test('createCache 文件损坏时不崩，退化为空缓存', function () {
    var c = S.createCache('Z:/definitely/not/here/cache.json', 1000);
    assert.strictEqual(c.get('x'), undefined);
    c.set('x', 1);   // 写失败也不应抛错
    assert.strictEqual(c.get('x'), 1);
  });

  await test('createCache 超过上限会淘汰最旧的条目（多人共用时缓存不会无限涨）', function () {
    var c = S.createCache(null, 1000, 3);
    ['a', 'b', 'c', 'd', 'e'].forEach(function (k, i) { c.set(k, { n: i }); });
    assert.strictEqual(c.size, 3, '应被压到上限');
    assert.strictEqual(c.get('a'), undefined, '最旧的 a 应被淘汰');
    assert.strictEqual(c.get('b'), undefined, '次旧的 b 应被淘汰');
    assert.ok(c.get('e'), '最新的 e 必须还在');
    assert.strictEqual(c.get('e').n, 4);
  });

  await test('maxEntries 传 0 或省略表示不限量（保持旧行为）', function () {
    var c = S.createCache(null, 1000, 0);
    for (var i = 0; i < 50; i += 1) c.set('k' + i, i);
    assert.strictEqual(c.size, 50, '不设上限时不该淘汰任何条目');
  });

  await test('getStoreItems 会报告「服务器已有多少 / 需要实时拉多少」（全部命中时不该发请求）', async function () {
    var c = S.createCache(null, 1000);
    c.set('app_cn_111', { appid: 111, priceState: 'priced', name: 'A' });
    c.set('app_cn_222', { appid: 222, priceState: 'priced', name: 'B' });
    var stats = {};
    var r = await S.getStoreItems([111, 222], { cache: c, stats: stats });
    assert.strictEqual(stats.asked, 2);
    assert.strictEqual(stats.hits, 2, '两条都该命中缓存');
    assert.strictEqual(stats.fetched, 0, '全部命中时不该有实时拉取');
    assert.strictEqual(r[111].name, 'A');
    assert.strictEqual(r[222].name, 'B');
  });

  await test('stats.asked 按去重后的数量计（重复 appid 不会重复统计）', async function () {
    var c = S.createCache(null, 1000);
    c.set('app_cn_333', { appid: 333, priceState: 'priced', name: 'C' });
    var stats = {};
    await S.getStoreItems([333, 333, 333], { cache: c, stats: stats });
    assert.strictEqual(stats.asked, 1, '应先去重再统计');
    assert.strictEqual(stats.hits, 1);
  });

  console.log('\n[6] 昵称/头像：免密钥路径（ajaxresolveusers）');

  await test('★ Key 链路已整体移除：这些函数不该再存在', function () {
    ['getPlayerSummaries', 'getOwnedGames', 'resolveProfile', 'resolveVanityUrl'].forEach(function (name) {
      assert.strictEqual(S[name], undefined, name + ' 应该已经删掉了（本项目不再用 Web API Key）');
    });
  });

  await test('avatarUrlFromHash 拼出 medium / full 两种尺寸，空 hash 返回空串', function () {
    assert.strictEqual(S.avatarUrlFromHash('abc123', 'medium'), S.AVATAR_CDN + '/abc123_medium.jpg');
    assert.strictEqual(S.avatarUrlFromHash('abc123', 'full'), S.AVATAR_CDN + '/abc123_full.jpg');
    assert.strictEqual(S.avatarUrlFromHash('', 'full'), '');
    assert.strictEqual(S.avatarUrlFromHash(null), '');
  });

  await test('★ avatarUrlFromHash 只认十六进制（别让 hash 变成一个能改 URL 的怪串）', function () {
    // 这个值会变成报告里的 <img src>，而报告是要发给别人的 —— URL 这一层也不留缝隙。
    ['../../etc/passwd', 'abc/../x', 'x?y=1', 'evil.com/a', 'abc def', 'a'.repeat(65), 'zzz123']
      .forEach(function (bad) {
        assert.strictEqual(S.avatarUrlFromHash(bad), '', '不该接受：' + bad);
      });
    assert.strictEqual(S.avatarUrlFromHash('a'.repeat(40)),
      S.AVATAR_CDN + '/' + 'a'.repeat(40) + '_medium.jpg', '正常的 40 位 sha1 要照旧拼得出来');
  });

  await test('profileUrlOf：有自定义名走 /id/，没有就退回 /profiles/<steamid>', function () {
    assert.strictEqual(S.profileUrlOf('76561190000000005', 'somevanity'), 'https://steamcommunity.com/id/somevanity');
    assert.strictEqual(S.profileUrlOf('76561190000000005', ''), 'https://steamcommunity.com/profiles/76561190000000005');
    // 纯数字不是自定义链接名（实测有人就填数字），当「没有」处理
    assert.strictEqual(S.profileUrlOf('76561190000000005', '12345'), 'https://steamcommunity.com/profiles/76561190000000005');
  });

  await test('★ mapResolvedUser 只留报告要用的字段，隐私字段一律丢掉', function () {
    var m = S.mapResolvedUser({
      steamid: '76561190000000005', accountid: 100005, persona_name: '某人',
      avatar_url: 'abc123', profile_url: 'somevanity', persona_state: 0,
      real_name: '李小某', city: '上海', state: 'Shanghai', country: 'CN',
      is_friend: false, friends_in_common: 0
    });
    assert.deepStrictEqual(Object.keys(m).sort(), ['avatar', 'avatarFull', 'name', 'profileUrl', 'state', 'steamid']);
    assert.strictEqual(m.name, '某人');
    var dump = JSON.stringify(m);
    assert.ok(dump.indexOf('李小某') < 0, '★ real_name 绝不能进报告（这份 HTML 会被到处转发）');
    assert.ok(dump.indexOf('上海') < 0, '★ city 绝不能进报告');
    assert.ok(dump.indexOf('"CN"') < 0, '★ country 绝不能进报告');
  });

  await test('mapResolvedUser 对非法/空输入返回 null', function () {
    assert.strictEqual(S.mapResolvedUser(null), null);
    assert.strictEqual(S.mapResolvedUser({}), null);
    assert.strictEqual(S.mapResolvedUser({ steamid: '123' }), null);
  });

  await test('★ resolveUserProfiles 一次只请求一个 id（实测多 id 批量一律 429）', async function () {
    var urls = [];
    var got = await S.resolveUserProfiles(['76561190000000005', '76561190000000006'], {
      injectHttp: async function (url) {
        urls.push(url);
        var id = url.split('steamids=')[1];
        return [{ steamid: id, persona_name: '玩家' + id.slice(-4), avatar_url: 'h' + id.slice(-4) }];
      }
    });
    assert.strictEqual(urls.length, 2, '应该发 2 次请求（一人一次），而不是 1 次批量');
    urls.forEach(function (u) {
      assert.ok(u.indexOf(',') < 0, '★ 单次请求绝不能带逗号（chunk=2/3/6 实测全 429）：' + u);
      assert.ok(u.indexOf('ajaxresolveusers') > 0, '应走免密钥的 community 接口：' + u);
      assert.ok(u.indexOf('key=') < 0, '★ 不该带任何 API Key：' + u);
      assert.ok(u.indexOf('access_token') < 0, '这一步连 access_token 都不需要：' + u);
    });
    assert.strictEqual(got.length, 2);
  });

  await test('resolveUserProfiles 去重、丢弃非法 id，空输入不发请求', async function () {
    var n = 0;
    var got = await S.resolveUserProfiles(['76561190000000005', '76561190000000005', '123', ''], {
      injectHttp: async function () { n += 1; return [{ steamid: '76561190000000005', persona_name: 'X' }]; }
    });
    assert.strictEqual(n, 1, '重复 id 只请求一次，非法 id 直接丢弃');
    assert.strictEqual(got.length, 1);
    var empty = await S.resolveUserProfiles([], { injectHttp: async function () { throw new Error('不该发请求'); } });
    assert.deepStrictEqual(empty, []);
  });

  await test('★ 429 要退避重试；重试仍失败就跳过这个人，绝不抛错', async function () {
    var calls = 0;
    var waits = [];
    var got = await S.resolveUserProfiles(['76561190000000005', '76561190000000006'], {
      retries: 2,
      injectHttp: async function (url) {
        calls += 1;
        if (url.indexOf('76561190000000005') > 0) { var e = new Error('限流'); e.status = 429; throw e; }
        return [{ steamid: '76561190000000006', persona_name: 'OK' }];
      },
      injectSleep: async function (ms) { waits.push(ms); }
    });
    assert.strictEqual(calls, 4, '第一个人 1 次 + 2 次重试，第二个人 1 次');
    assert.deepStrictEqual(waits, [1000, 4000], '退避要递增（1s → 4s）');
    assert.strictEqual(got.length, 1, '失败的那个人被跳过，不抛错');
    assert.strictEqual(got[0].name, 'OK');
  });

  await test('非限流错误不重试（404 之类重试无意义）', async function () {
    var calls = 0;
    var got = await S.resolveUserProfiles(['76561190000000005'], {
      injectHttp: async function () { calls += 1; var e = new Error('没有这个人'); e.status = 404; throw e; }
    });
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(got, []);
  });

  await test('缓存命中就不再发请求（限流接口要省着用）', async function () {
    var c = S.createCache(null, 60000);
    var n = 0;
    var inject = async function (url) {
      n += 1;
      var id = url.split('steamids=')[1];
      return [{ steamid: id, persona_name: 'N' + id.slice(-3) }];
    };
    await S.resolveUserProfiles(['76561190000000005'], { cache: c, injectHttp: inject });
    await S.resolveUserProfiles(['76561190000000005'], { cache: c, injectHttp: inject });
    assert.strictEqual(n, 1, '第二次应命中缓存，不再打接口');
  });

  await test('getStoreItems 对空列表不报错、不发请求', async function () {
    var r = await S.getStoreItems([], {});
    assert.deepStrictEqual(r, {});
  });

  console.log('\n[7] 区域级联与汇率');

  await test('区域顺序必须是 国区 → 港区 → 新加坡 → 美区', function () {
    assert.deepStrictEqual(S.REGIONS.map(function (r) { return r.cc; }), ['cn', 'hk', 'sg', 'us']);
    assert.deepStrictEqual(S.REGIONS.map(function (r) { return r.currency; }), ['CNY', 'HKD', 'SGD', 'USD']);
  });

  await test('汇率换算：港币/新币/美元 -> 人民币', function () {
    var rates = { CNY: 1, HKD: 0.85, SGD: 5.3, USD: 7.1 };
    assert.strictEqual(S.toCnyYuan(29800, 'CNY', rates), 298);          // 国区不动
    assert.strictEqual(S.toCnyYuan(47900, 'HKD', rates), 407.15);       // HK$479
    assert.strictEqual(S.toCnyYuan(7990, 'SGD', rates), 423.47);        // S$79.9
    assert.strictEqual(S.toCnyYuan(5999, 'USD', rates), 425.93);        // $59.99
  });

  await test('汇率缺失时退回兜底汇率而不是算成 0', function () {
    var v = S.toCnyYuan(10000, 'HKD', null);
    assert.ok(v > 0, '不应为 0');
    assert.strictEqual(v, 90);   // 兜底 0.9
  });

  console.log('\n[8] store 域兜底数据源（appdetails）');

  var AD_ELDEN = {
    success: true,
    data: {
      name: '艾尔登法环', steam_appid: 1245620, is_free: false,
      price_overview: { currency: 'HKD', initial: 47900, final: 47900, discount_percent: 0 },
      categories: [{ id: 2, description: '单人' }, { id: 62, description: '家庭共享' }]
    }
  };
  var AD_FREE = {
    success: true,
    data: { name: 'CS2', is_free: true, categories: [{ id: 2 }] }
  };
  var AD_NOPRICE = {
    success: true,
    data: { name: 'GTA V', is_free: false, categories: [{ id: 2 }] }
  };

  await test('appdetails -> 统一结构：区域、币种、原价、可共享（靠 categories 里的 62）', function () {
    var m = S.mapAppDetails(AD_ELDEN, 1245620, S.REGIONS[1]);   // 港区
    assert.strictEqual(m.name, '艾尔登法环');
    assert.strictEqual(m.priceState, 'priced');
    assert.strictEqual(m.originalCents, 47900);
    assert.strictEqual(m.currency, 'HKD');
    assert.strictEqual(m.region, 'hk');
    assert.strictEqual(m.regionLabel, '港区');
    assert.strictEqual(m.shareable, true);
    assert.strictEqual(m.source, 'store');
  });

  await test('appdetails 免费游戏 -> free 且价格归零', function () {
    var m = S.mapAppDetails(AD_FREE, 730, S.REGIONS[0]);
    assert.strictEqual(m.priceState, 'free');
    assert.strictEqual(m.originalCents, 0);
    assert.strictEqual(m.shareable, false);
  });

  await test('appdetails 无 price_overview -> unavailable（不是免费）', function () {
    var m = S.mapAppDetails(AD_NOPRICE, 271590, S.REGIONS[0]);
    assert.strictEqual(m.priceState, 'unavailable');
    assert.strictEqual(m.isFree, false);
  });

  await test('appdetails 拉取失败也要返回 appid，不能让调用方拿到 undefined', function () {
    var m = S.mapAppDetails(null, 999, S.REGIONS[0]);
    assert.strictEqual(m.appid, 999);
    assert.strictEqual(m.priceState, 'unavailable');
  });

  await test('appdetails 无价格时也保留 categories 判定出的可共享状态', function () {
    // 死亡搁浅：所有区域都无价，但含分类 62
    var m = S.mapAppDetails({
      success: true,
      data: { name: 'DEATH STRANDING', is_free: false, categories: [{ id: 62 }] }
    }, 1190460, S.REGIONS[0]);
    assert.strictEqual(m.priceState, 'unavailable');
    assert.strictEqual(m.shareable, true);
  });

  console.log('\n[9] 家庭组');

  await test('REGIONS 里的每个区域都能作为 context 传给接口（结构检查）', function () {
    S.REGIONS.forEach(function (r) {
      assert.ok(r.cc && r.currency && r.label);
    });
  });

  await test('extractFamilyMembers：去重、过滤非法 id、保留 role', function () {
    var members = S.extractFamilyMembers({
      members: [
        { steamid: '76561197960435530', role: 0 },
        { steamid: '76561197960435530', role: 0 },        // 重复
        { steamid: '123', role: 1 },                       // 非法
        { steam_id: '76561197960268196', role: 1 }         // 兼容另一种字段名
      ]
    });
    assert.strictEqual(members.length, 2);
    assert.strictEqual(members[0].steamid, '76561197960435530');
    assert.strictEqual(members[1].steamid, '76561197960268196');
  });

  await test('extractFamilyMembers 对空/异常输入不报错', function () {
    assert.deepStrictEqual(S.extractFamilyMembers(null), []);
    assert.deepStrictEqual(S.extractFamilyMembers({}), []);
    assert.deepStrictEqual(S.extractFamilyMembers({ members: [] }), []);
  });

  await test('★ 用 API Key 调家庭组是拿不到的，必须 access_token（无 token 时报错要可操作）', async function () {
    try {
      await S.getFamilyGroupForUser('');
      throw new Error('本应抛错');
    } catch (e) {
      assert.strictEqual(e.code, 'NO_ACCESS_TOKEN');
      assert.ok(e.message.indexOf('loyalty_webapi_token') > 0, '错误信息里应给出取 token 的方法');
      assert.ok(e.message.indexOf('不是') > 0, '应说明不是 API Key');
    }
  });

  await test('getSharedLibraryApps 无 token 也不发请求，直接抛错', async function () {
    try {
      await S.getSharedLibraryApps('', '123');
      throw new Error('本应抛错');
    } catch (e) {
      assert.strictEqual(e.code, 'NO_ACCESS_TOKEN');
    }
  });

  await test('★ familyUnreachableMessage 必须说清「api 域 vs store 域」（这是用户最困惑的点）', function () {
    var msg = S.familyUnreachableMessage('直连 read ECONNRESET');
    // 必须点明卡的是 api 域，而不是笼统的「Steam」
    assert.ok(msg.indexOf('api.steampowered.com') >= 0, '要点明 api 域');
    // 必须解释为什么价格能查、家庭组却不行 —— 这是现场最常见的困惑
    assert.ok(msg.indexOf('store 域降级') >= 0, '要说清 store 域降级只覆盖价格');
    // 必须给出可操作的方向
    assert.ok(msg.indexOf('HTTPS_PROXY') >= 0, '要提示设 HTTPS_PROXY');
    assert.ok(msg.indexOf('加速器') >= 0, '要提示检查加速器覆盖范围');
    // 必须带上原始失败原因，便于排查
    assert.ok(msg.indexOf('ECONNRESET') >= 0, '要带上原始失败原因');
  });

  await test('★ tokenRejectedMessage 必须把「token 被轮换作废」排在「过期」前面', function () {
    var msg = S.tokenRejectedMessage('原始原因XYZ');
    assert.ok(msg.indexOf('401') >= 0, '要说明是 401');
    assert.ok(msg.indexOf('刷新') >= 0, '要指出「取完 token 又刷新过 Steam 页面」这个最常见原因');
    assert.ok(msg.indexOf('换发新 token') >= 0, '要说清页面每次加载都会换发新 token');
    assert.ok(msg.indexOf('作废') >= 0, '要说清旧 token 会立即作废');
    assert.ok(msg.indexOf('loyalty_webapi_token') >= 0, '要给出重新取 token 的命令');
    // ★ 文案顺序就是排查顺序：先怀疑「被轮换作废」，再怀疑「过期」。
    //   实测同一分钟、同一网络下旧 token 401 / 新 token 200，两枚都没到期。
    assert.ok(msg.indexOf('换发新 token') < msg.indexOf('24 小时'), '先讲轮换作废，再讲过期');
    assert.ok(msg.indexOf('原始原因XYZ') >= 0, '要带上原始失败原因，便于排查');
  });

  console.log('\n[10] 远端文本洗白（redactText）');

  await test('★ 抹掉 URL 上的 access_token（远端错误页可能把请求 URL 回显出来）', function () {
    var s = S.redactText('GET https://api.steampowered.com/IFamilyGroupsService/X?access_token=eyJhbGciOi.eyJzdWIiOiIx&family_groupid=99');
    assert.ok(s.indexOf('eyJhbGciOi') < 0, 'token 值没被抹掉：' + s);
    assert.ok(s.indexOf('access_token=***') >= 0, '应保留字段名、抹掉值（便于排查是哪个参数）');
    assert.ok(s.indexOf('family_groupid=99') >= 0, '不带凭据的参数不该被动到');
  });

  await test('★ 抹掉 JWT 形态与 32 位 hex（Steam WebAPI Key 的形态）', function () {
    assert.ok(S.redactText('token 是 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0').indexOf('eyJzdWIi') < 0);
    assert.ok(S.redactText('key=' + 'a'.repeat(32)).indexOf('a'.repeat(32)) < 0);
  });

  await test('★ 剥掉 ANSI 转义与其它控制字符（远端文本会把终端刷花、也会污染产物）', function () {
    var s = S.redactText('\u001b[31m红色\u001b[0m\u0007响铃\u0000空字节');
    assert.strictEqual(s.indexOf('\u001b'), -1, 'ANSI 转义没剥干净：' + JSON.stringify(s));
    assert.strictEqual(s.indexOf('\u0007'), -1, '控制字符没剥干净');
    assert.strictEqual(s.indexOf('\u0000'), -1, 'NUL 没剥干净');
    assert.ok(s.indexOf('红色') >= 0 && s.indexOf('响铃') >= 0, '正常文字要保留（洗白 ≠ 清空）');
  });

  await test('★ 截断，且有默认上限（别把整页 HTML 带进错误消息）', function () {
    assert.strictEqual(S.redactText('x'.repeat(1000)).length, 160, '默认上限应是 160');
    assert.strictEqual(S.redactText('x'.repeat(1000), 20).length, 20, '上限可传参');
  });

  await test('★ 两条可选文案带上原始原因时，也要先洗一遍', function () {
    assert.ok(S.familyUnreachableMessage('read access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIi').indexOf('eyJzdWIi') < 0,
      'familyUnreachableMessage 的 detail 没洗白');
    assert.ok(S.tokenRejectedMessage('x access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIi').indexOf('eyJzdWIi') < 0,
      'tokenRejectedMessage 的 detail 没洗白');
  });

  await test('★ 打印代理 URL 前必须抹掉用户名口令（这行会被滚屏、被截图）', function () {
    // ★ 这个 URL 故意拼出来写：发布闸门会扫「文件里出现的外链域名」，
    //   写成字面量就会多出一个 whitelist 里没有的 host（user/alice），自己把自己扫红。
    var withCred = 'http://' + 'alice:s3cr3t' + '@127.0.0.1:7890';
    var s = S.redactProxyUrl(withCred);
    assert.strictEqual(s, 'http://' + '***@127.0.0.1:7890', '实际：' + s);
    assert.ok(s.indexOf('s3cr3t') < 0, '口令还在：' + s);
    assert.strictEqual(S.redactProxyUrl('http://' + '127.0.0.1:7890'), 'http://127.0.0.1:7890',
      '没有凭据的代理 URL 不该被动到');
  });

  console.log('\n[11] 响应体的硬上限与总时限（慢速滴流 / 塞一大坨都不能吊住进程）');

  await test('★ readBody 正常读完（多个 chunk 拼起来）', async function () {
    var { EventEmitter } = require('events');
    var res = new EventEmitter();
    res.destroy = function () {};
    res.statusCode = 200;
    var p = S.readBody(res);
    res.emit('data', Buffer.from('{"a":'));
    res.emit('data', Buffer.from('1}'));
    res.emit('end');
    assert.strictEqual(await p, '{"a":1}');
  });

  await test('★ readBody 超上限就中止，并且报错必须说明「是超限」而不是随便一个网络错', async function () {
    var { EventEmitter } = require('events');
    var res = new EventEmitter();
    var destroyed = false;
    res.destroy = function () { destroyed = true; };
    var p = S.readBody(res, 1000);
    var err = null;
    try { res.emit('data', Buffer.alloc(1200)); await p; } catch (e) { err = e; }
    assert.ok(err, '超上限必须 reject，不能把一大坨读进来');
    assert.strictEqual(err.tooLarge, true, '要带上 tooLarge 标记，调用方才能区分「超限」和「网络挂」');
    assert.ok(/上限/.test(err.message), '错误消息要说清是超限：' + err.message);
    assert.ok(destroyed, '超限时要主动 destroy 掉响应流，否则对端还在灌');
  });

  await test('★ readBody 恰好等于上限要放行（别把边界判成超限）', async function () {
    var { EventEmitter } = require('events');
    var res = new EventEmitter();
    res.destroy = function () {};
    var p = S.readBody(res, 1000);
    res.emit('data', Buffer.alloc(1000));
    res.emit('end');
    assert.strictEqual((await p).length, 1000);
  });

  await test('★ 连不上要 reject，不能挂住（请求本身的错误路径）', async function () {
    // 连本机一个必定没人监听的端口。没有网络依赖，但真的走了一遍 https.request。
    var started = Date.now();
    var err = null;
    try {
      await S.getJSON('https://127.0.0.1:1/definitely-nothing-here', { timeout: 1500, proxy: 'direct' });
    } catch (e) { err = e; }
    assert.ok(err, '连不上必须抛错');
    assert.ok(Date.now() - started < 10000, '要在超时范围内结束，不能挂住');
  });

  await test('★ 总时限到点必须中止（滴流式响应不能把进程吊住）', async function () {
    // ★ 「总时限」和「静默多久算死」是两件事：对端只要每隔几秒滴一点数据，
    //   每次请求自己的 timeout 就永远不会触发，进程被无限期吊住。
    //   这里不监听端口（会破坏「全离线」这条被测试钉着的承诺），改成把 https.request 换掉，
    //   模拟「对端收下请求、然后永不回应」。
    var https = require('https');
    var { EventEmitter } = require('events');
    var orig = https.request;
    var destroyed = null;
    var fake = new EventEmitter();
    fake.destroy = function (e) { destroyed = e || new Error('destroyed'); };
    fake.end = function () { /* 收了请求就不说话 */ };
    https.request = function () { return fake; };
    var err = null;
    var t0 = Date.now();
    // ★ 两条守卫，缺一不可：
    //   ① 总时限那个定时器是 unref() 的（刻意的：真跑起来时别让它吊住进程易）；
    //      只靠它的话，事件循环会空掉、进程**静默以 0 退出**，这条测试就成了哑弹。
    //   ② 所以再压一个**引用中的**守卫定时器：既撑住事件循环，又把「总时限没生效」
    //      这件事变成一条明确的失败（而不是静默退出）。
    var guard = null;
    var outcome = await Promise.race([
      S.httpRaw('https://api.steampowered.com/definitely-nothing-here', { timeout: 40 })
        .then(function () { return 'resolved'; }, function (e) { err = e; return 'rejected'; }),
      new Promise(function (r) { guard = setTimeout(function () { r('guard-timeout'); }, 2000); })
    ]);
    clearTimeout(guard);
    var dt = Date.now() - t0;
    https.request = orig;

    assert.strictEqual(outcome, 'rejected',
      '总时限到点必须 reject；拿到 `' + outcome + '` 说明总时限没生效（这条守卫就是为了让这种情况转红，' +
      '否则进程会静默退出、测试假装通过）');
    assert.strictEqual(err.timeout, true,
      '要带 timeout 标记（调用方据此区分「超时」和「网络挂」）：' + (err && err.message));
    assert.ok(/总时限/.test(err.message), '消息要说清是总时限：' + (err && err.message));
    assert.ok(destroyed, '到点要 destroy 掉请求，不能放着它继续跑');
    assert.ok(dt >= 100 && dt < 1800, '应在 4×40=160ms 附近中止，实际 ' + dt + 'ms');
  });

  console.log('\n\u2705 全部 ' + passed + ' 项断言通过\n');

})().catch(function (e) {
  console.error('\n\u274c 失败：' + e.message);
  console.error(e.stack);
  process.exit(1);
});
