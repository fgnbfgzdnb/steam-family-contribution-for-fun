/*!
 * 计算内核自测（Node 直接运行：node tests/engine.test.js）
 * 覆盖用户给出的两个原始例子 + 边界情况 + 守恒不变量。
 *
 * ★ 计分口径：按「被别人实际玩过」计分（不是按库存拥有）。
 *   每款游戏产生 P × 原价 的共享价值（P = 实际玩过它的「非拥有者」人数），
 *   由 O 个拥有者平分。没人玩过 -> 0 分。
 */
'use strict';

const assert = require('assert');
const SC = require('../src/engine.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  \u2713 ' + name);
}

function members(keys) {
  return keys.map((k) => ({ id: k, name: k }));
}

function scoreOf(result, id) {
  const row = result.rows.find((r) => r.memberId === id);
  return row ? row.score : undefined;
}

const SIX = members(['A', 'B', 'C', 'D', 'E', 'F']);

console.log('\n[1] 用户给出的原始例子');

test('例1：328 元游戏，1 人拥有 / 5 人玩过 -> 拥有者 +5x328 = 1640', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 328, ownerIds: ['A'], playedBy: ['B', 'C', 'D', 'E', 'F'] }]
  });
  assert.strictEqual(scoreOf(r, 'A'), 1640);
  assert.strictEqual(scoreOf(r, 'B'), 0);
  assert.strictEqual(r.totals.score, 1640);
});

test('例2：328 元游戏，2 人拥有 / 4 人玩过 -> 每人 (4x328)/2 = 656', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 328, ownerIds: ['A', 'B'], playedBy: ['C', 'D', 'E', 'F'] }]
  });
  assert.strictEqual(scoreOf(r, 'A'), 656);
  assert.strictEqual(scoreOf(r, 'B'), 656);
  assert.strictEqual(scoreOf(r, 'C'), 0);
  assert.strictEqual(r.totals.score, 1312);
});

test('两例叠加：A 独有 328 + A/B 共有 328 -> A 2296, B 656', () => {
  const r = SC.calculate({
    members: SIX,
    games: [
      { id: 'g1', name: 'X', price: 328, ownerIds: ['A'], playedBy: ['B', 'C', 'D', 'E', 'F'] },
      { id: 'g2', name: 'Y', price: 328, ownerIds: ['A', 'B'], playedBy: ['C', 'D', 'E', 'F'] }
    ]
  });
  assert.strictEqual(scoreOf(r, 'A'), 2296);
  assert.strictEqual(scoreOf(r, 'B'), 656);
});

test('价格不是整数也能正确摊分：100 元 3 人拥有 / 3 人玩过 -> 每人 100', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 100, ownerIds: ['A', 'B', 'C'], playedBy: ['D', 'E', 'F'] }]
  });
  assert.strictEqual(scoreOf(r, 'A'), 100);
});

console.log('\n[2] 边界情况');

test('全员拥有 -> 0 分（无人因共享受益）', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 328, ownerIds: ['A', 'B', 'C', 'D', 'E', 'F'], playedBy: [] }]
  });
  assert.strictEqual(r.totals.score, 0);
  assert.strictEqual(r.games[0].status, 'universal');
});

test('无人拥有 -> 0 分，且不计入家庭组游戏库价值', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 328, ownerIds: [] }]
  });
  assert.strictEqual(r.totals.score, 0);
  assert.strictEqual(r.meta.groupValue, 0);
  assert.strictEqual(r.games[0].status, 'unowned');
});

test('免费游戏 -> 0 分', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'CS2', price: 0, ownerIds: ['A'], playedBy: ['B'] }]
  });
  assert.strictEqual(r.totals.score, 0);
  assert.strictEqual(r.games[0].status, 'free');
});

test('ownerIds 重复 / 引用不存在的成员 -> 自动去重与忽略', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 328, ownerIds: ['A', 'A', 'ZZZ'], playedBy: ['B', 'C', 'D', 'E', 'F'] }]
  });
  assert.strictEqual(r.games[0].ownerCount, 1);
  assert.strictEqual(scoreOf(r, 'A'), 1640);
});

test('非 6 人家庭组同样成立：3 人组，1 人拥有 300 / 另 2 人都玩过 -> 该人 +600', () => {
  const r = SC.calculate({
    members: members(['A', 'B', 'C']),
    games: [{ id: 'g1', name: 'X', price: 300, ownerIds: ['A'], playedBy: ['B', 'C'] }]
  });
  assert.strictEqual(scoreOf(r, 'A'), 600);
});

test('小数价格不产生精度漂移：29.99 元 1 人拥有 / 5 人都玩过', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 29.99, ownerIds: ['A'], playedBy: ['B', 'C', 'D', 'E', 'F'] }]
  });
  assert.strictEqual(scoreOf(r, 'A'), 149.95);
});

console.log('\n[3] 守恒不变量（关键正确性保证）');

test('所有成员的贡献分之和 == 所有成员从他人游戏获得的价值之和', () => {
  const r = SC.calculate({
    members: SIX,
    games: [
      { id: 'g1', name: 'X', price: 328, ownerIds: ['A'], playedBy: ['B', 'C'] },
      { id: 'g2', name: 'Y', price: 398, ownerIds: ['A', 'B'], playedBy: ['C', 'D', 'E'] },
      { id: 'g3', name: 'Z', price: 298, ownerIds: ['B', 'C', 'D'], playedBy: ['A', 'E'] },
      { id: 'g4', name: 'W', price: 199, ownerIds: ['A', 'B', 'C', 'D', 'E', 'F'], playedBy: [] },
      { id: 'g5', name: 'V', price: 48, ownerIds: ['F'], playedBy: ['A'] }
    ]
  });
  assert.strictEqual(r.totals.scoreCents, r.totals.receivedValueCents);
});

test('某游戏的贡献总额 == P x 原价（P = 实际玩过的非拥有者人数）', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 398, ownerIds: ['A', 'B', 'C'], playedBy: ['D', 'E'] }]
  });
  assert.strictEqual(r.games[0].totalContribution, 2 * 398);
  assert.strictEqual(r.games[0].beneficiaryCount, 2);
});

console.log('\n[4] 不可共享的游戏（Steam 家庭共享排除项）');

const NO_SHARE = (id, name, price, ownerIds) => ({ id, name, price, ownerIds, shareable: false });

test('不可共享的游戏记 0 分：1 人独有 328 也一样', () => {
  const r = SC.calculate({
    members: SIX,
    games: [NO_SHARE('g1', 'GTA V', 328, ['A'])]
  });
  assert.strictEqual(scoreOf(r, 'A'), 0);
  assert.strictEqual(r.games[0].status, 'not-shareable');
  assert.strictEqual(r.games[0].statusText, '不支持共享');
});

test('不可共享的游戏不计入受益价值：别人玩不到，就不能算白玩到', () => {
  const r = SC.calculate({
    members: SIX,
    games: [NO_SHARE('g1', 'GTA V', 328, ['A'])]
  });
  assert.strictEqual(scoreOf(r, 'B'), 0);
  assert.strictEqual(r.rows.find((x) => x.memberId === 'B').receivedValue, 0);
  assert.strictEqual(r.totals.receivedValueCents, 0);
});

test('同样的价格，可共享 vs 不可共享 差别就是全额 vs 0', () => {
  const share = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 328, ownerIds: ['A'], playedBy: ['B', 'C', 'D', 'E', 'F'] }]
  });
  const noShare = SC.calculate({ members: SIX, games: [NO_SHARE('g1', 'X', 328, ['A'])] });
  assert.strictEqual(scoreOf(share, 'A'), 1640);
  assert.strictEqual(scoreOf(noShare, 'A'), 0);
});

test('不可共享游戏仍计入「库总原价」，但不计入「共享池原价」', () => {
  const r = SC.calculate({
    members: SIX,
    games: [
      { id: 'g1', name: '可共享', price: 100, ownerIds: ['A'], playedBy: ['B'] },
      NO_SHARE('g2', '不可共享', 300, ['A'])
    ]
  });
  assert.strictEqual(r.meta.libraryValue, 400);
  assert.strictEqual(r.meta.groupValue, 100);
  assert.strictEqual(r.meta.notShareableCount, 1);
  assert.strictEqual(r.meta.notShareableValue, 300);
});

test('不可共享的游戏不推进「参与分配」的计数', () => {
  const r = SC.calculate({
    members: SIX,
    games: [
      NO_SHARE('g1', 'X', 328, ['A']),
      { id: 'g2', name: 'Y', price: 100, ownerIds: ['A'], playedBy: ['B'] }
    ]
  });
  assert.strictEqual(r.meta.activeGameCount, 1);
});

test('混合场景下守恒不变量依然成立（这是新增规则后的核心护栏）', () => {
  const r = SC.calculate({
    members: SIX,
    games: [
      { id: 'g1', name: '可共享A', price: 328, ownerIds: ['A'], playedBy: ['B', 'C', 'D', 'E', 'F'] },
      NO_SHARE('g2', '不可共享B', 500, ['A', 'B']),
      { id: 'g3', name: '免费C', price: 0, ownerIds: ['C'], playedBy: ['D'] },
      { id: 'g4', name: '全员D', price: 200, ownerIds: ['A', 'B', 'C', 'D', 'E', 'F'], playedBy: [] },
      { id: 'g5', name: '可共享E', price: 398, ownerIds: ['B', 'C', 'D'], playedBy: ['A', 'E'] }
    ]
  });
  assert.strictEqual(r.totals.scoreCents, r.totals.receivedValueCents);
  // 不可共享那份完全不该出现在任何人的收益里：328x5 + 398x2
  const total = r.rows.reduce((s, x) => s + x.receivedValueCents, 0);
  assert.strictEqual(total, (328 * 5 + 398 * 2) * 100);
});

test('shareable 缺省视为可共享（字段缺失时不误伤）', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 328, ownerIds: ['A'], playedBy: ['B', 'C', 'D', 'E', 'F'] }]
  });
  assert.strictEqual(r.games[0].shareable, true);
  assert.strictEqual(scoreOf(r, 'A'), 1640);
});

test('既免费又不可共享时，按「免费游戏」归类（那才是更本质的原因）', () => {
  const r = SC.calculate({
    members: SIX,
    games: [NO_SHARE('g1', '永劫无间', 0, ['A', 'B'])]
  });
  assert.strictEqual(r.games[0].status, 'free');
  assert.strictEqual(r.games[0].statusText, '免费游戏');
  // 免费游戏不该被算进「因不支持共享而损失的价值」
  assert.strictEqual(r.meta.notShareableCount, 0);
  assert.strictEqual(r.meta.notShareableValue, 0);
});

test('isShareable 只把显式 false 当作不可共享', () => {
  assert.strictEqual(SC.isShareable({ shareable: false }), false);
  assert.strictEqual(SC.isShareable({ shareable: true }), true);
  assert.strictEqual(SC.isShareable({}), true);
  assert.strictEqual(SC.isShareable(null), true);
});

console.log('\n[5] ★ 新口径核心：没人玩过就不计分');

test('有人拥有但谁都没玩过 -> 0 分，状态是「无人玩过」', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: '买了没玩', price: 328, ownerIds: ['A'], playedBy: [] }]
  });
  assert.strictEqual(scoreOf(r, 'A'), 0);
  assert.strictEqual(r.totals.score, 0);
  assert.strictEqual(r.games[0].status, 'unplayed');
  assert.strictEqual(r.games[0].statusText, '无人玩过');
});

test('完全不给 playedBy（等于没有游玩数据）-> 同样按「无人玩过」处理，绝不退回按拥有计分', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: '没有游玩数据', price: 328, ownerIds: ['A'] }]
  });
  assert.strictEqual(scoreOf(r, 'A'), 0);
  assert.strictEqual(r.games[0].status, 'unplayed');
});

test('理论上 5 人能玩、实际只有 1 人玩过 -> 只按 1 人计分', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 328, ownerIds: ['A'], playedBy: ['B'] }]
  });
  assert.strictEqual(scoreOf(r, 'A'), 328);          // 1 x 328 / 1
  assert.strictEqual(r.games[0].beneficiaryCount, 1); // 实际受益 1 人
  assert.strictEqual(r.games[0].potentialCount, 5);   // 理论可玩 5 人
});

test('拥有者自己玩自己的游戏不算数（没给别人带来价值）', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 328, ownerIds: ['A', 'B'], playedBy: ['A', 'B'] }]
  });
  assert.strictEqual(r.totals.score, 0);
  assert.strictEqual(r.games[0].status, 'unplayed');
});

test('playedBy 里混入拥有者 / 不存在的成员 -> 一律剔除', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 100, ownerIds: ['A'], playedBy: ['A', 'ZZZ', 'B'] }]
  });
  assert.strictEqual(r.games[0].beneficiaryCount, 1); // 只有 B 算
  assert.strictEqual(scoreOf(r, 'A'), 100);
});

test('同一个人重复出现在 playedBy 里只算一次', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 100, ownerIds: ['A'], playedBy: ['B', 'B', 'B', 'B'] }]
  });
  assert.strictEqual(r.games[0].beneficiaryCount, 1);
  assert.strictEqual(scoreOf(r, 'A'), 100);
});

test('只有实际玩过的人才有「白玩到」，没玩过的人收益为 0', () => {
  const r = SC.calculate({
    members: SIX,
    games: [{ id: 'g1', name: 'X', price: 200, ownerIds: ['A'], playedBy: ['B', 'C'] }]
  });
  const get = (id) => r.rows.find((x) => x.memberId === id);
  assert.strictEqual(get('B').receivedValue, 200);
  assert.strictEqual(get('C').receivedValue, 200);
  assert.strictEqual(get('D').receivedValue, 0);   // 理论上能玩但没玩
  assert.strictEqual(get('E').receivedValue, 0);
});

test('闲置共享池统计：可共享却没人玩过的游戏会被单独计出来', () => {
  const r = SC.calculate({
    members: SIX,
    games: [
      { id: 'g1', name: '有人玩', price: 100, ownerIds: ['A'], playedBy: ['B'] },
      { id: 'g2', name: '没人玩1', price: 200, ownerIds: ['A'], playedBy: [] },
      { id: 'g3', name: '没人玩2', price: 300, ownerIds: ['B'], playedBy: [] }
    ]
  });
  assert.strictEqual(r.meta.unplayedCount, 2);
  assert.strictEqual(r.meta.unplayedValue, 500);
  assert.strictEqual(r.meta.activeGameCount, 1);
});

test('新口径下守恒不变量依然成立（P 口径的护栏）', () => {
  const r = SC.calculate({
    members: SIX,
    games: [
      { id: 'g1', name: 'X', price: 328, ownerIds: ['A'], playedBy: ['B'] },
      { id: 'g2', name: 'Y', price: 398, ownerIds: ['A', 'B', 'C'], playedBy: ['D'] },
      { id: 'g3', name: 'Z', price: 48, ownerIds: ['F'], playedBy: ['A', 'B', 'C', 'D', 'E'] },
      { id: 'g4', name: 'W', price: 199, ownerIds: ['D'], playedBy: [] }
    ]
  });
  assert.strictEqual(r.totals.scoreCents, r.totals.receivedValueCents);
  assert.strictEqual(r.totals.receivedValueCents, (328 * 1 + 398 * 1 + 48 * 5) * 100);
});

console.log('\n[6] 校验器');

test('超过 6 人 -> 报错', () => {
  const issues = SC.validate({ members: members(['A', 'B', 'C', 'D', 'E', 'F', 'G']), games: [] });
  assert.ok(issues.some((i) => i.code === 'TOO_MANY_MEMBERS' && i.level === 'error'));
});

console.log('\n[7] 示例数据跑分（仅打印，便于人工核对）');

const demo = SC.calculate({
  members: SIX,
  games: [
    { id: 'g1', name: '黑神话：悟空', price: 268, ownerIds: ['A'], playedBy: ['B', 'C'] },
    { id: 'g2', name: '艾尔登法环', price: 398, ownerIds: ['A', 'B'], playedBy: ['C'] },
    { id: 'g3', name: '赛博朋克 2077', price: 298, ownerIds: ['B', 'C', 'D'], playedBy: ['A', 'E'] },
    { id: 'g4', name: '博德之门 3', price: 298, ownerIds: ['A', 'C'], playedBy: [] },
    { id: 'g5', name: '双人成行', price: 198, ownerIds: ['D', 'E'], playedBy: ['F'] }
  ]
});
console.log('  成员   贡献分     占比');
demo.rows.forEach((r) => {
  console.log(
    '  ' + r.name + '   ' + SC.formatYuan(r.score).padStart(10) + '   ' + (r.share * 100).toFixed(1) + '%'
  );
});
console.log('  贡献总池 ' + SC.formatYuan(demo.totals.score));
console.log('  闲置共享池 ' + SC.formatYuan(demo.meta.unplayedValue) + '（' + demo.meta.unplayedCount + ' 款没人玩过）');

console.log('\n\u2705 全部 ' + passed + ' 项断言通过\n');
