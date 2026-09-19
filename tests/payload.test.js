/*!
 * 载荷组装测试（纯离线、零依赖）
 *
 * 守的是家庭组 payload 那个数据形状 —— 两条入口与静态报告都吃它，形状一变全崩。
 *
 * ★ 这里最容易出的事故是「漏字段」：漏掉 playedBy 不会报错、不会崩，
 *   只会让整张贡献榜静默变成 0 分。而且离线夹具全绿也没用 ——
 *   因为它可能走的是另一条路（restore / --from）。
 *   所以关键字段必须有断言钉住，并且断言喂到引擎那一步为止。
 */
'use strict';

const assert = require('assert');
const { buildFamilyPayload, toEngineInput, toGamePriceFields } = require('../src/payload.js');
const ENGINE = require('../src/engine.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  \u2713 ' + name);
}

const S1 = '76561190000000001';
const S2 = '76561190000000002';

/** steam.resolveFamily() 的结果形状 */
function makeFam() {
  return {
    familyGroupId: 'G1',
    members: [
      { steamid: S1, name: '甲', avatar: 'a.png' },
      { steamid: S2, name: '乙', avatar: '' }
    ],
    apps: [
      {
        appid: 111, name: 'Shared Game', ownerSteamIds: [S1], playtimeForever: 100,
        playedBy: [S2], playtime: { [S2]: 3600 }
      },
      {
        appid: 222, name: 'Nobody Played', ownerSteamIds: [S2], playtimeForever: 0,
        playedBy: [], playtime: {}
      }
    ],
    playtimeAvailable: true
  };
}

/** steam.getPrices().prices 的形状 */
const PRICES = {
  111: {
    appid: 111, name: '共享游戏（中文名）', priceState: 'priced', shareable: true,
    originalCents: 10000, finalCents: 5000, discountPct: 50, currency: 'CNY',
    region: 'cn', regionLabel: '国区', packageName: 'pkg',
    cnyOriginal: 100, cnyFinal: 50
  },
  222: {
    appid: 222, name: '没人玩的游戏', priceState: 'priced', shareable: true,
    cnyOriginal: 20, cnyFinal: 20, currency: 'CNY', region: 'cn', regionLabel: '国区'
  }
};

function gameOf(payload, appid) {
  return payload.games.filter((x) => x.appid === appid)[0];
}

console.log('\n[载荷] buildFamilyPayload —— 组装出前端认的形状');

test('★ playedBy 必须原样带出来（漏了它整张表变 0 分，且不报任何错）', () => {
  const out = buildFamilyPayload(makeFam(), PRICES, null);
  assert.deepStrictEqual(gameOf(out, 111).playedBy, [S2], 'playedBy 丢了或映射错了');
});

test('★ 没人玩过的游戏给空数组，而不是 undefined', () => {
  const g = gameOf(buildFamilyPayload(makeFam(), PRICES, null), 222);
  assert.ok(Array.isArray(g.playedBy), 'playedBy 必须是数组（undefined 会让下游要处处判空）');
  assert.strictEqual(g.playedBy.length, 0);
});

test('★ 双口径价格都要给（price = 折扣价，originalPrice = 无折扣标价）', () => {
  const g = gameOf(buildFamilyPayload(makeFam(), PRICES, null), 111);
  assert.strictEqual(g.price, 50, 'price 应是折扣价 cnyFinal');
  assert.strictEqual(g.originalPrice, 100, 'originalPrice 应是标价 cnyOriginal');
  assert.notStrictEqual(g.price, g.originalPrice,
    '两个值相等的话，页面上的「计分方式」切换就完全测不出来了');
});

test('ownerSteamIds / ownerCount / playtime 原样带出', () => {
  const g = gameOf(buildFamilyPayload(makeFam(), PRICES, null), 111);
  assert.deepStrictEqual(g.ownerSteamIds, [S1]);
  assert.strictEqual(g.ownerCount, 1);
  assert.strictEqual(g.playtime[S2], 3600, '游玩时长要按 steamid 带出来（明细表要用）');
  assert.strictEqual(g.playtimeForever, 100);
});

test('主名用价格接口的（带中文），nameEn 保留家庭组接口的英文名', () => {
  const g = gameOf(buildFamilyPayload(makeFam(), PRICES, null), 111);
  assert.strictEqual(g.name, '共享游戏（中文名）');
  assert.strictEqual(g.nameEn, 'Shared Game');
});

test('拿不到价格记录时不炸，「没有价格」也不等于「免费」', () => {
  const g = gameOf(buildFamilyPayload(makeFam(), {}, null), 111);
  assert.strictEqual(g.priceState, 'unknown');
  assert.strictEqual(g.price, 0);
  assert.strictEqual(g.isFree, false, '拿不到价格 ≠ 免费');
});

test('members / familyGroupId / priceMeta 透传（warnings 例外，见下一条）', () => {
  const meta = { source: 'api', degraded: false };
  const out = buildFamilyPayload(makeFam(), PRICES, meta);
  assert.strictEqual(out.familyGroupId, 'G1');
  assert.strictEqual(out.members.length, 2);
  assert.deepStrictEqual(out.priceMeta, { source: 'api', degraded: false });
  assert.strictEqual(out.playtimeAvailable, true);
});

test('★ 报告载荷里不带 warnings（远端可控文本不能进「转发给别人」的产物）', () => {
  // warnings 里会拼「远端返回的原话」（中间层错误页、代理报错…），
  // 对端若回显请求 URL，那串 URL 上就带着 access_token。
  // 报告是要发给别人双击打开的，所以这个字段一律不进载荷。
  const meta = {
    source: 'store',
    degraded: true,
    rates: { HKD: 0.91 },
    warnings: ['Steam 返回了非 JSON 内容（可能被网络中间层拦截）：<html>…access_token=xxx…</html>']
  };
  const out = buildFamilyPayload(makeFam(), PRICES, meta);
  assert.ok(!('warnings' in out.priceMeta), 'warnings 不许进报告载荷');
  assert.deepStrictEqual(out.priceMeta, { source: 'store', degraded: true, rates: { HKD: 0.91 } },
    '除 warnings 外其余元信息仍应透传');
  assert.ok(JSON.stringify(out).indexOf('access_token') < 0, '产物 JSON 里不该出现凭据字样');
});

console.log('\n[载荷] toEngineInput + 引擎 —— 端到端：组装 -> 计分');

test('★ 组装结果喂进引擎能算出非 0 分（守住「漏 playedBy = 全表 0 分」这个坑）', () => {
  const input = toEngineInput(buildFamilyPayload(makeFam(), PRICES, null));
  const res = ENGINE.calculate(input);
  // 甲拥有 111、被乙玩过 -> 甲 +50；222 没人玩 -> 0
  assert.strictEqual(res.totals.scoreCents, 5000,
    '贡献总池应是 50 元。若是 0，八成是 playedBy 或 ownerIds 在组装/映射时丢了');
  assert.strictEqual(res.totals.receivedValueCents, 5000, '不变量：sum(贡献) === sum(白玩到)');
  assert.strictEqual(res.rows.filter((r) => r.name === '甲')[0].scoreCents, 5000);
});

test('★ 归属与使用者按 steamid 正确映射（两边都不能是空的）', () => {
  const g = toEngineInput(buildFamilyPayload(makeFam(), PRICES, null)).games
    .filter((x) => x.appid === 111)[0];
  assert.strictEqual(g.ownerIds.length, 1, 'ownerIds 为空说明 steamid 没映射上');
  assert.strictEqual(g.playedBy.length, 1, 'playedBy 为空说明 steamid 没映射上');
  assert.notStrictEqual(g.ownerIds[0], g.playedBy[0], '拥有者和使用者应是不同的人');
});

test('游玩时长也映射成本地成员 id（键不再是 steamid）', () => {
  const g = toEngineInput(buildFamilyPayload(makeFam(), PRICES, null)).games
    .filter((x) => x.appid === 111)[0];
  assert.strictEqual(Object.keys(g.playtime).length, 1);
  assert.strictEqual(Object.keys(g.playtime)[0].indexOf('7656119'), -1, '键应已换成内部短 id');
  assert.strictEqual(g.playtime[g.playedBy[0]], 3600);
});

test('只有真正被玩过才计分：没人玩的那款换算后仍是 0', () => {
  const res = ENGINE.calculate(toEngineInput(buildFamilyPayload(makeFam(), PRICES, null)));
  const g = res.games.filter((x) => x.appid === 222)[0];
  assert.strictEqual(g.totalContributionCents, 0, '没人玩过就该是 0 分');
});

console.log('\n[载荷] toGamePriceFields');

test('priced -> 原价/折扣价都折算好；free -> 两个都是 0', () => {
  const p = toGamePriceFields({ priceState: 'priced', cnyFinal: 50, cnyOriginal: 100, originalCents: 10000 });
  assert.strictEqual(p.price, 50);
  assert.strictEqual(p.originalPrice, 100);
  assert.strictEqual(p.rawOriginal, 100, 'rawOriginal 应保留原区域货币的原价');

  const f = toGamePriceFields({ priceState: 'free' });
  assert.strictEqual(f.price, 0);
  assert.strictEqual(f.originalPrice, 0);
  assert.strictEqual(f.isFree, false, 'isFree 只认接口给的标记，不靠价格推断');
});

test('shareable 缺省视为可共享（只有明确的 false 才排除）', () => {
  assert.strictEqual(toGamePriceFields({ shareable: undefined }).shareable, true);
  assert.strictEqual(toGamePriceFields({ shareable: false }).shareable, false);
});

console.log('\n\u2705 载荷测试全部 ' + passed + ' 项通过\n');
