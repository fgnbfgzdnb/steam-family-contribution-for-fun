/*!
 * 报告渲染与交互冒烟测试
 *
 * ★ 报告是本地生成的静态文件，不依赖任何后端。
 *   做法：拿夹具生成一份**真报告**，再用 jsdom 当真浏览器打开它。
 *   测的就是用户双击打开的那份东西本身。
 *
 * 需要 jsdom（可选依赖）：
 *   NODE_PATH=<jsdom 所在 node_modules> node tests/ui.smoke.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');
const ENGINE = require('../src/engine.js');

const ROOT = path.join(__dirname, '..');
const errors = [];
let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('  \u2713 ' + name);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function money(n) {
  return '\u00a5' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ------------------------------------------------------------------ *
 * 夹具：6 人 / 86 款游戏（9 款有名有姓 + 17 款有价没人玩 + 60 款闲置免费）。
 * playtime 的键是内部成员 id（秒）。
 * ------------------------------------------------------------------ */
function makeFixture() {
  const members = ['甲', '乙', '丙', '丁', '戊', '己'].map((n, i) => ({ id: 'm' + (i + 1), name: n }));
  const base = { shareable: true, priceState: 'priced', region: 'cn', regionLabel: '国区', currency: 'CNY' };
  const H = 3600;
  const games = [
    // ★ g1/g2 额外带「折扣价 ≠ 标价」两个来源字段（接口的真实形状），用来测口径切换
    { id: 'g1', appid: 2358720, name: '黑神话：悟空', nameEn: 'Black Myth: Wukong', price: 268, priceFinal: 268, priceOriginal: 358, ownerIds: ['m1'], playedBy: ['m2', 'm3'], playtime: { m2: 12.5 * H, m3: 45 * 60 }, ...base },
    { id: 'g2', appid: 1245620, name: '艾尔登法环', nameEn: 'ELDEN RING', price: 298, priceFinal: 298, priceOriginal: 398, ownerIds: ['m1', 'm2'], playedBy: ['m3'], playtime: { m3: 3.2 * H }, ...base },
    { id: 'g3', appid: 1091500, name: '赛博朋克 2077', price: 298, ownerIds: ['m3'], playedBy: [], playtime: {}, ...base },
    { id: 'g4', appid: 292030, name: '巫师 3：狂猎', price: 199, ownerIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], playedBy: [], playtime: {}, ...base },
    { id: 'g5', appid: 730, name: '反恐精英 2', price: 0, ownerIds: ['m4'], playedBy: ['m5'], playtime: { m5: H }, ...base, priceState: 'free' },
    { id: 'g6', appid: 1174180, name: '荒野大镖客 2', price: 279, ownerIds: ['m5'], playedBy: [], playtime: {}, ...base, shareable: false },
    { id: 'g7', appid: 289070, name: '文明 6', nameEn: 'Sid Meier\u2019s Civilization VI', price: 220, ownerIds: ['m1', 'm2', 'm3'], playedBy: ['m4', 'm5', 'm6'], playtime: { m4: 30 * H, m5: 2 * H, m6: 10 * 60 }, ...base },
    { id: 'g8', appid: 413150, name: 'Stardew Valley', nameEn: 'Stardew Valley', price: 48, ownerIds: ['m4', 'm5'], playedBy: ['m1', 'm6'], playtime: { m1: 5 * H, m6: 90 * 60 }, ...base },
    // ★ 拥有者也在 playedBy 里（接口给的就是这样，由引擎剔除）
    { id: 'g9', appid: 570, name: 'Dota 2', price: 0, ownerIds: ['m4', 'm5'], playedBy: ['m5', 'm6'], playtime: { m5: 100 * H, m6: 2 * H }, ...base, priceState: 'free' }
  ];
  for (let i = 0; i < 17; i += 1) {
    games.push({
      id: 'gf' + i, appid: 900000 + i, name: '填充游戏 ' + (i + 1),
      price: 100, ownerIds: ['m6'], playedBy: [], playtime: {}, ...base
    });
  }
  // ★ 60 款「没人玩过的免费游戏」：用来验证明细的分批展示
  for (let i = 0; i < 60; i += 1) {
    games.push({
      id: 'f' + i, appid: 910000 + i, name: '闲置游戏 ' + String(i + 1).padStart(2, '0'),
      price: 0, ownerIds: ['m4'], playedBy: [], playtime: {},
      ...base, priceState: 'free'
    });
  }
  return { familyGroupId: 'FIXTURE', members, games };
}

const FIXTURE = makeFixture();
const FIXTURE_RESULT = ENGINE.calculate(FIXTURE);

/** 「标价」口径的期望值 —— 让引擎按标价再算一遍，不自写数字 */
const ORIGINAL_RESULT = ENGINE.calculate({
  ...FIXTURE,
  games: FIXTURE.games.map((g) => ({ ...g, price: (g.priceOriginal != null ? g.priceOriginal : g.price) }))
});

/**
 * 把「引擎输入形状」的夹具转成报告要吃的家庭组 payload 形状。
 * ★ 报告里的成员 id 会被重新分配，所以断言一律按**名字**认人，不按 id。
 */
function toFamilyShape(state) {
  const sid = (id) => 'S' + id;
  const members = state.members.map((m) => ({ steamid: sid(m.id), name: m.name, avatar: '' }));
  const games = state.games.map((g) => {
    const playtime = {};
    Object.keys(g.playtime || {}).forEach((k) => { playtime[sid(k)] = g.playtime[k]; });
    const price = (g.priceFinal != null) ? g.priceFinal : g.price;
    return {
      appid: g.appid,
      name: g.name,
      nameEn: g.nameEn || '',
      ownerSteamIds: (g.ownerIds || []).map(sid),
      ownerCount: (g.ownerIds || []).length,
      playtimeForever: 0,
      playedBy: (g.playedBy || []).map(sid),
      playtime: playtime,
      price: price,
      originalPrice: (g.priceOriginal != null) ? g.priceOriginal : price,
      currentPrice: price,
      rawOriginal: 0, currency: 'CNY', region: 'cn', regionLabel: '国区', discountPct: 0,
      shareable: g.shareable !== false,
      priceState: g.priceState || 'priced',
      isFree: g.priceState === 'free',
      packageName: '', storeUrlPath: ''
    };
  });
  return { familyGroupId: 'FIXTURE', members: members, games: games, playtimeAvailable: true, priceMeta: null };
}

/* ---------------------------- 生成报告 ---------------------------- */

/* ★ 临时文件要落在仓库目录里：--from / --out 只允许当前目录内的路径（src/safe-path.js）。 */
const TMP = path.join(ROOT, 'tests', '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const fixtureFile = path.join(TMP, 'ui-smoke-fixture-' + process.pid + '.json');
const reportFile = path.join(TMP, 'ui-smoke-report-' + process.pid + '.html');
fs.writeFileSync(fixtureFile, JSON.stringify(toFamilyShape(FIXTURE)), 'utf8');
execFileSync(process.execPath,
  [path.join(ROOT, 'tools', 'family-report.js'), '--from', fixtureFile, '--html', reportFile],
  { cwd: ROOT, stdio: 'pipe' });

function cleanup() {
  [fixtureFile, reportFile].forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ } });
}

/* ---------------------------- 打开报告 ---------------------------- */

(async function main() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

  const netCalls = [];
  const dom = new JSDOM(fs.readFileSync(reportFile, 'utf8'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/report.html',
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = function (input) {
        netCalls.push(String(input));
        return Promise.reject(new Error('报告不该联网'));
      };
    }
  });

  const window = dom.window;
  const doc = window.document;

  let ready = false;
  for (let i = 0; i < 200; i += 1) {
    if (doc.querySelectorAll('#valueBody tr').length > 0) { ready = true; break; }
    await sleep(25);
  }
  assert.ok(ready, '报告应在 5 秒内渲染出明细（渲染不出来说明内联脚本没跑起来）');

  function detailRows() {
    return Array.from(doc.querySelectorAll('#valueBody tr'))
      .filter((r) => !r.querySelector('.empty') && r.children.length === 5);
  }
  function detailByName(name) {
    return detailRows().filter((r) => r.children[0].textContent.indexOf(name) === 0)[0] || null;
  }
  function rankItem(name) {
    return Array.from(doc.querySelectorAll('#rankList .rank-item'))
      .filter((x) => x.querySelector('.rank-name').textContent === name)[0] || null;
  }
  function rankNet(name) {
    const el = rankItem(name);
    return el ? el.querySelector('.rank-net').textContent : null;
  }
  function cellText(row, i) { return row.children[i].textContent.replace(/\s+/g, ' ').trim(); }
  function click(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
  function fire(el, type) { el.dispatchEvent(new window.Event(type, { bubbles: true })); }
  function setSort(mode) { const s = doc.getElementById('sortMode'); s.value = mode; fire(s, 'change'); }
  function toggle(id, on) { const c = doc.getElementById(id); c.checked = on; fire(c, 'change'); }
  function moreBtn() { return doc.getElementById('detailMore'); }
  function expandAll() {
    let n = 0;
    while (moreBtn() && !moreBtn().hidden && n < 100) { click(moreBtn()); n += 1; }
    return n;
  }
  /** 在成员下拉里按**名字**选中某项（报告里的 id 是重新分配的，不能写死） */
  function selectMember(selId, name) {
    const sel = doc.getElementById(selId);
    const opt = Array.from(sel.options).filter((o) => o.textContent === name)[0];
    assert.ok(opt, selId + ' 里应能找到 ' + name);
    sel.value = opt.value;
    fire(sel, 'change');
  }

  console.log('\n[报告] 初始渲染（夹具 6 人 / 86 款游戏）');

  await test('成员与贡献榜按夹具渲染', async () => {
    assert.strictEqual(doc.querySelectorAll('#memberList .member').length, 6);
    assert.strictEqual(doc.querySelectorAll('#rankList .rank-item').length, 6);
  });

  await test('★ 一个网络请求都没发（报告的数据就在页面里）', async () => {
    assert.deepStrictEqual(netCalls, [], '报告不该发请求，实际发了：' + netCalls.join('、'));
  });

  await test('KPI 显示共享池与贡献总池（引擎实算）', async () => {
    assert.strictEqual(doc.querySelectorAll('#kpi .kpi-item').length, 6);
    const t = doc.querySelector('#kpi').textContent;
    assert.ok(t.indexOf(money(FIXTURE_RESULT.meta.groupValue)) >= 0, '实际：' + t.slice(0, 140));
    assert.ok(t.indexOf(money(FIXTURE_RESULT.totals.score)) >= 0);
  });

  await test('贡献榜展示净贡献（贡献 − 使用），正负号正确', async () => {
    FIXTURE_RESULT.rows.forEach((r) => {
      const expect = (r.netCents < 0 ? '\u2212' : '+') + money(Math.abs(r.net));
      assert.strictEqual(rankNet(r.name), expect, r.name + ' 的净贡献对不上');
    });
  });

  await test('贡献榜按净贡献从高到低排，且每项有双向柱状图', async () => {
    const items = Array.from(doc.querySelectorAll('#rankList .rank-item'));
    const nets = items.map((el) => {
      const t = el.querySelector('.rank-net').textContent;
      return (t.indexOf('\u2212') === 0 ? -1 : 1) * Number(t.replace(/[^0-9.]/g, ''));
    });
    for (let i = 1; i < nets.length; i += 1) {
      assert.ok(nets[i] <= nets[i - 1], '净贡献应降序：' + nets.join(', '));
    }
    assert.ok(items.some((el) => el.querySelector('.netfill.neg')), '夹具里应有净白玩的人（负值柱）');
  });

  console.log('\n[报告] 逐游戏价值明细');

  await test('默认只看有价值的：只列产生了共享价值的游戏，且按价值降序', async () => {
    const rows = detailRows();
    assert.ok(rows.length > 0, '应有数据行');
    const vals = rows.map((r) => Number(cellText(r, 4).replace(/[^0-9.]/g, '')) || 0);
    vals.forEach((v) => assert.ok(v > 0, '不该出现 0 价值的行，实际：' + vals.join(', ')));
    for (let i = 1; i < vals.length; i += 1) {
      assert.ok(vals[i] <= vals[i - 1], '应按价值降序，实际：' + vals.join(', '));
    }
    assert.strictEqual(rows.length, 4, '夹具里应只有这 4 款产生价值');
  });

  await test('★ 游戏名：中文名为主，英文名作为小字注在下面', async () => {
    const row = detailByName('黑神话：悟空');
    assert.ok(row, '应能找到黑神话');
    const cn = row.querySelector('.name-cn');
    const en = row.querySelector('.name-en');
    assert.ok(cn, '应有中文名元素');
    assert.strictEqual(cn.textContent, '黑神话：悟空');
    assert.ok(en, '应有英文名小字');
    assert.strictEqual(en.textContent, 'Black Myth: Wukong');
    assert.ok(cn.compareDocumentPosition(en) & 4, '英文名应排在中文名之后（即显示在下面）');
  });

  await test('Steam 本身没有中文名时，不重复显示一遍英文小字', async () => {
    const row = detailRows().filter((r) => r.children[0].textContent.indexOf('Stardew Valley') === 0)[0];
    assert.ok(row, '应能找到 Stardew Valley');
    assert.strictEqual(row.querySelector('.name-en'), null, '主名即英文时不该再显示小字');
    assert.strictEqual(row.querySelector('.name-cn').textContent, 'Stardew Valley');
  });

  await test('明细同时展示拥有者', async () => {
    const row = detailByName('黑神话：悟空');
    assert.ok(row, '应能找到黑神话');
    assert.strictEqual(cellText(row, 1), '甲', '拥有者应为甲');
  });

  await test('★ 明细展示使用者，且带上各自的游玩时间', async () => {
    const row = detailByName('黑神话：悟空');
    assert.ok(row, '应能找到黑神话');
    const players = Array.from(row.querySelectorAll('.player')).map((p) => ({
      name: p.textContent.replace(/[0-9.]+.*$/, '').trim(),
      dur: p.querySelector('em').textContent
    }));
    assert.strictEqual(players.length, 2, '黑神话有 2 个使用者');
    const byName = {};
    players.forEach((p) => { byName[p.name] = p.dur; });
    assert.strictEqual(byName['乙'], '12.5 小时', '12.5 小时应格式化正确，实际：' + byName['乙']);
    assert.strictEqual(byName['丙'], '45 分钟', '45 分钟应格式化正确，实际：' + byName['丙']);
  });

  await test('游玩时间格式化：小时 / 分钟', async () => {
    const row = detailByName('文明 6');
    assert.ok(row, '应能找到文明 6');
    const durs = Array.from(row.querySelectorAll('.player em')).map((e) => e.textContent);
    assert.ok(durs.indexOf('30.0 小时') >= 0, '应有 30.0 小时，实际：' + durs.join(', '));
    assert.ok(durs.indexOf('10 分钟') >= 0, '应有 10 分钟，实际：' + durs.join(', '));
  });

  await test('拥有者玩自己的游戏不计入使用者', async () => {
    const row = detailByName('文明 6');
    const names = Array.from(row.querySelectorAll('.player')).map((p) => p.textContent.slice(0, 1));
    ['甲', '乙', '丙'].forEach((n) => {
      assert.ok(names.indexOf(n) < 0, '拥有者 ' + n + ' 不该出现在使用者里');
    });
  });

  await test('明细表头就是这 5 列', async () => {
    const heads = Array.from(doc.querySelectorAll('.data-table thead th')).map((t) => t.textContent.trim());
    assert.deepStrictEqual(heads, ['游戏', '拥有者', '使用者（游玩时间）', '单份贡献', '项目总贡献']);
  });

  console.log('\n[报告] 筛选与排序');

  await test('取消「只看有价值的」后，无价值的游戏也会列出来（先全部展开）', async () => {
    const before = detailRows().length;
    toggle('onlyValuable', false);
    await sleep(80);
    expandAll();
    await sleep(80);
    assert.ok(detailRows().length > before,
      '取消筛选后行数应增加（' + before + ' → ' + detailRows().length + '）');
    toggle('onlyValuable', true);
    await sleep(80);
    assert.strictEqual(detailRows().length, before, '勾回来应恢复');
  });

  await test('「只看多人共有」筛掉单人拥有的游戏', async () => {
    toggle('onlyShared', true);
    await sleep(80);
    detailRows().map((r) => cellText(r, 1)).forEach((o) => {
      assert.ok(o.split('、').length >= 2, '不该出现单人拥有的：' + o);
    });
    toggle('onlyShared', false);
    await sleep(80);
  });

  await test('「隐藏免费/无价」勾上后行数减少', async () => {
    toggle('onlyValuable', false);
    await sleep(80);
    expandAll();
    await sleep(80);
    const before = detailRows().length;
    toggle('hideFree', true);
    await sleep(80);
    expandAll();
    await sleep(80);
    assert.ok(detailRows().length < before,
      '勾上后行数应减少（' + before + ' → ' + detailRows().length + '）');
    toggle('hideFree', false);
    await sleep(80);
    toggle('onlyValuable', true);
    await sleep(80);
  });

  await test('切到「按名称」排序，行序按名称升序', async () => {
    setSort('name');
    await sleep(80);
    const names = detailRows().map((r) => cellText(r, 0).replace(/\d+$/, '').trim());
    assert.deepStrictEqual(names, names.slice().sort((a, b) => a.localeCompare(b, 'zh')));
    setSort('contribution');
    await sleep(80);
  });

  await test('切到「价格高 → 低」排序，行序确实变了', async () => {
    const byValue = detailRows().map((r) => cellText(r, 0));
    setSort('price');
    await sleep(80);
    assert.notDeepStrictEqual(detailRows().map((r) => cellText(r, 0)), byValue, '两种排序下顺序应当不同');
    setSort('contribution');
    await sleep(80);
  });

  console.log('\n[报告] 明细分批展示');

  await test('默认渲染「和贡献榜一样长」的行数，而不是把库里全部铺出来', async () => {
    const rankLen = doc.querySelectorAll('#rankList .rank-item').length;
    toggle('onlyValuable', false);
    await sleep(80);
    assert.ok(FIXTURE.games.length > rankLen + 50, '夹具里的游戏要够多才测得出分批');
    assert.strictEqual(detailRows().length, rankLen,
      '默认应渲染 ' + rankLen + ' 行（= 贡献榜长度），实际 ' + detailRows().length);
    assert.strictEqual(moreBtn().hidden, false, '还有没显示的游戏时按钮必须可见');
  });

  await test('★ 每点一次「展开更多」恰好追加 50 行', async () => {
    const before = detailRows().length;
    click(moreBtn());
    await sleep(80);
    assert.strictEqual(detailRows().length, before + 50, '点一次应恰好加 50 行');
  });

  await test('★ 一直点下去能看到全部记录，之后按钮隐藏', async () => {
    const clicks = expandAll();
    await sleep(80);
    assert.ok(clicks < 100, '不该点个没完，实际点了 ' + clicks + ' 次');
    assert.strictEqual(detailRows().length, FIXTURE.games.length, '展开到底应显示全部');
    assert.strictEqual(moreBtn().hidden, true, '没有剩余时按钮应隐藏');
  });

  await test('改筛选后回到默认长度（分页跟着数据集走）', async () => {
    const explicit = FIXTURE_RESULT.games.filter((g) => g.totalContributionCents > 0).length;
    toggle('onlyValuable', true);
    await sleep(80);
    assert.ok(detailRows().length < FIXTURE.games.length, '改筛选后不该还留着一屏全展开的状态');
    assert.strictEqual(detailRows().length, Math.min(explicit, 6), '应回到默认长度');
    assert.strictEqual(moreBtn().hidden, true, '这批全显示完了，按钮应隐藏');
  });

  console.log('\n[报告] 明细的成员筛选（提供者 / 使用者）');

  await test('两个筛选下拉的选项跟着成员列表走', async () => {
    const opts = (id) => Array.from(doc.getElementById(id).querySelectorAll('option'));
    const names = FIXTURE.members.map((m) => m.name);
    assert.strictEqual(opts('filterOwner').length, names.length + 1, '提供者下拉应是「全部」+ 每个人');
    assert.deepStrictEqual(opts('filterOwner').slice(1).map((o) => o.textContent), names);
    assert.deepStrictEqual(opts('filterPlayer').slice(1).map((o) => o.textContent), names);
  });

  await test('按「提供者」筛选：只剩下这个人拥有的游戏', async () => {
    selectMember('filterOwner', '甲');
    await sleep(80);
    toggle('onlyValuable', false);
    await sleep(80);
    expandAll();
    await sleep(80);
    const owners = detailRows().map((r) => cellText(r, 1));
    const expect = FIXTURE.games.filter((g) => g.ownerIds.indexOf('m1') >= 0).length;
    assert.ok(expect > 0, '夹具里甲应该有游戏');
    assert.strictEqual(owners.length, expect, '应正好是甲拥有的 ' + expect + ' 款，实际 ' + owners.length);
    owners.forEach((o) => assert.ok(o.split('、').indexOf('甲') >= 0, '不该出现甲没拥有的：' + o));
    const sel = doc.getElementById('filterOwner');
    sel.value = '';
    fire(sel, 'change');
    await sleep(80);
    toggle('onlyValuable', true);
    await sleep(80);
  });

  await test('按「使用者」筛选：只剩这个人玩过的、且不是他自己拥有的游戏', async () => {
    selectMember('filterPlayer', '戊');
    await sleep(80);
    toggle('onlyValuable', false);
    await sleep(80);
    expandAll();
    await sleep(80);
    const rows = detailRows();
    const expect = FIXTURE.games.filter(
      (g) => g.playedBy.indexOf('m5') >= 0 && g.ownerIds.indexOf('m5') < 0).length;
    assert.ok(expect > 0, '夹具里戊应该玩过别人的游戏');
    assert.strictEqual(rows.length, expect, '应正好是 ' + expect + ' 款，实际 ' + rows.length);
    rows.forEach((r) => {
      assert.ok(cellText(r, 2).indexOf('戊') >= 0, '使用者列应含戊：' + cellText(r, 2));
      assert.ok(cellText(r, 1).split('、').indexOf('戊') < 0, '不该出现戊拥有的：' + cellText(r, 1));
    });
    const sel = doc.getElementById('filterPlayer');
    sel.value = '';
    fire(sel, 'change');
    await sleep(80);
    toggle('onlyValuable', true);
    await sleep(80);
  });

  console.log('\n[报告] 计分口径切换（折扣价 / 标价）');

  await test('默认口径是折扣价，且页面上确实有切换控件', async () => {
    const sel = doc.getElementById('priceMode');
    assert.ok(sel, '必须有「计分方式」切换控件');
    assert.strictEqual(sel.value, 'final', '默认必须是折扣价（默认口径不能悄悄变）');
    assert.ok(doc.querySelector('#kpi').textContent.indexOf(money(FIXTURE_RESULT.totals.score)) >= 0);
  });

  await test('「计分方式」在③贡献榜卡片里', async () => {
    const card = doc.querySelector('.rank-card');
    assert.ok(card, '应有③贡献榜卡片');
    assert.ok(card.contains(doc.getElementById('priceMode')), '计分方式控件应该在贡献榜里');
  });

  await test('★ 切到「标价」：贡献总池 / 每人净贡献都按标价重算', async () => {
    const beforeNets = FIXTURE_RESULT.rows.map((r) => rankNet(r.name));
    const sel = doc.getElementById('priceMode');
    sel.value = 'original';
    fire(sel, 'change');
    await sleep(120);

    assert.ok(ORIGINAL_RESULT.totals.scoreCents > FIXTURE_RESULT.totals.scoreCents,
      '夹具里标价 ≥ 折扣价，标价口径的总额必须更大（否则这个测试证明不了任何事）');
    assert.ok(doc.querySelector('#kpi').textContent.indexOf(money(ORIGINAL_RESULT.totals.score)) >= 0,
      '标价口径下「贡献总池」应等于引擎按标价算出来的值');
    ORIGINAL_RESULT.rows.forEach((r) => {
      const expect = (r.netCents < 0 ? '\u2212' : '+') + money(Math.abs(r.net));
      assert.strictEqual(rankNet(r.name), expect, '标价口径下 ' + r.name + ' 的净贡献对不上');
    });
    assert.notDeepStrictEqual(FIXTURE_RESULT.rows.map((r) => rankNet(r.name)), beforeNets,
      '切到标价后净贡献必须真的变化，不能只是重渲染了同一套数字');
  });

  await test('★ 切回「折扣价」：数字逐项复原（切换不能是单向的）', async () => {
    const sel = doc.getElementById('priceMode');
    sel.value = 'final';
    fire(sel, 'change');
    await sleep(120);
    assert.ok(doc.querySelector('#kpi').textContent.indexOf(money(FIXTURE_RESULT.totals.score)) >= 0,
      '切回折扣价后「贡献总池」应完全复原');
    FIXTURE_RESULT.rows.forEach((r) => {
      const expect = (r.netCents < 0 ? '\u2212' : '+') + money(Math.abs(r.net));
      assert.strictEqual(rankNet(r.name), expect, '切回折扣价后 ' + r.name + ' 的净贡献应完全复原');
    });
  });

  await test('★ 不变量成立，且明细合计精确等于贡献总池', async () => {
    assert.strictEqual(FIXTURE_RESULT.totals.scoreCents, FIXTURE_RESULT.totals.receivedValueCents,
      '折扣价口径下 sum(贡献) 与 sum(白玩到的价值) 不相等');
    assert.strictEqual(ORIGINAL_RESULT.totals.scoreCents, ORIGINAL_RESULT.totals.receivedValueCents,
      '标价口径下 sum(贡献) 与 sum(白玩到的价值) 不相等');
    const sum = detailRows().reduce(
      (a, r) => a + Math.round(Number(cellText(r, 4).replace(/[^0-9.]/g, '')) * 100), 0);
    assert.strictEqual(sum, FIXTURE_RESULT.totals.scoreCents,
      '明细「项目总贡献」合计应精确等于贡献总池');
  });

  console.log('\n[报告] 已移除的入口一个都不该剩');

  await test('★ 已删除：① 读取卡片、token 输入、取 token 教程、风险说明', async () => {
    assert.strictEqual(doc.querySelector('.steam-card'), null, '① 卡片是已移除形态的产物');
    assert.strictEqual(doc.getElementById('tokenInput'), null, '不该再有 token 输入框');
    assert.strictEqual(doc.querySelector('.key-help'), null, '不该再有取 token 的教程块');
    assert.strictEqual(doc.querySelector('.trust-box'), null, '不该再有「token 会被中转」那套说明');
  });

  await test('★ 已删除：刷新价格 / 清空显示，以及所有手工维护入口', async () => {
    const acts = Array.from(doc.querySelectorAll('[data-act]')).map((e) => e.getAttribute('data-act'));
    ['refresh-prices', 'reset', 'family-import', 'add-member', 'rm-member', 'rm-game',
      'add-custom', 'add-catalog', 'import-file', 'open-game', 'grid-more', 'close-modal'
    ].forEach((a) => {
      assert.ok(acts.indexOf(a) < 0, '不该再有 ' + a + ' 入口');
    });
    assert.strictEqual(doc.getElementById('memberName'), null, '不应再有成员输入框');
    assert.strictEqual(doc.getElementById('modalMask'), null, '单卡片弹层应已移除');
  });

  await test('「导出 JSON」仍然可用（纯本地操作）', async () => {
    const el = doc.querySelector('[data-act="export"]');
    assert.ok(el, '导出按钮应保留');
  });

  await test('页面运行期间没有 JS 报错', async () => {
    assert.deepStrictEqual(errors, [], '出现了 JS 错误：\n' + errors.join('\n'));
  });

  cleanup();
  console.log('\n\u2705 报告冒烟测试全部 ' + passed + ' 项通过\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n\u274c 失败：' + e.message);
  if (errors.length) console.error(errors.join('\n'));
  cleanup();
  process.exit(1);
});
