/*!
 * 静态报告测试（离线，不需要后端、不需要网络）
 *
 * 守的是这条链路：
 *   夹具 JSON（家庭组 payload 形状）
 *     -> tools/family-report.js --from --html     （组装 + 全量内联）
 *     -> 单文件 HTML
 *     -> 用 jsdom 当真浏览器打开它
 *     -> 页面上的数字必须等于**手算**的答案
 *
 * ★ 期望值是手写的常量，不调用本项目的任何代码 —— 它必须是一个**独立锚点**。
 *   引擎或组装逻辑哪天改了口径，这里要立刻红，而不是跟着一起错。
 *
 * 需要 jsdom：
 *   NODE_PATH=<jsdom 所在 node_modules> node tests/static-report.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'family-api-sample.json');
const STORAGE_KEY = 'steam_family_contribution_v3';
const errors = [];
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log('  \u2713 ' + name);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    try { if (fn()) return true; } catch (e) { /* 继续轮询 */ }
    await sleep(20);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 手算的标准答案
 *
 * 夹具（tests/fixtures/family-api-sample.json）6 人 / 9 款游戏：
 *   黑神话：悟空   1 人拥有，2 位非拥有者玩过   268 x 2 = 536
 *   艾尔登法环     2 人拥有，1 位非拥有者玩过   298 x 1 = 298（两位拥有者各 149）
 *   文明 6         3 人拥有，3 位非拥有者玩过   220 x 3 = 660（三位拥有者各 220）
 *   星露谷物语     2 人拥有，2 位非拥有者玩过    48 x 2 = 96（两位拥有者各 48）
 *   赛博朋克 2077  1 人拥有，没人玩过           -> 0（没人玩过）
 *   巫师 3         全员拥有                    -> 0（全员拥有）
 *   反恐精英 2     免费，有人玩过               -> 0（免费）
 *   荒野大镖客 2   不支持家庭共享，有人玩过      -> 0（不可共享）
 *   Dota 2         免费，有人玩过               -> 0（免费）
 *
 * 标价口径（originalPrice）：黑神话 358x2=716、法环 398x1=398、文明6 660、星露谷 96
 * ------------------------------------------------------------------ */

const FINAL = {
  scoreTotal: 1590,
  score: { '阿肯': 905, '老王': 369, '小林': 220, 'Momo': 48, '阿七': 48, '大熊': 0 },
  received: { '阿肯': 48, '老王': 268, '小林': 566, 'Momo': 220, '阿七': 220, '大熊': 268 },
  byGame: { '黑神话：悟空': 536, '艾尔登法环': 298, '文明 6': 660, '星露谷物语': 96 }
};
const ORIGINAL_TOTAL = 1870;   // 716 + 398 + 660 + 96

function money(n) {
  return '\u00a5' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** 页面上的净贡献字符串（含正负号） */
function net(netYuan) {
  return (netYuan < 0 ? '\u2212' : '+') + money(Math.abs(netYuan));
}
function fileUrl(p) { return 'file:///' + p.replace(/\\/g, '/').replace(/^\//, ''); }

/* ------------------------------------------------------------------ *
 * 生成报告
 * ------------------------------------------------------------------ */

/* ★ 报告要落在仓库目录里：--out 只允许当前目录内的 .html（src/safe-path.js）。 */
const TMP = path.join(ROOT, 'tests', '.tmp');
fs.mkdirSync(TMP, { recursive: true });
const outFile = path.join(TMP, 'steam-family-report-test-' + process.pid + '.html');
const cliJson = execFileSync(process.execPath,
  [path.join(ROOT, 'tools', 'family-report.js'), '--from', FIXTURE, '--html', outFile, '--json'],
  { cwd: ROOT, encoding: 'utf8' }).toString();

const RAW = fs.readFileSync(outFile, 'utf8');

function open(html, url) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: url,
    virtualConsole: vc,
    beforeParse(window) {
      // ★ 静态报告一个请求都不该发出去。装了计数器：谁要是把网络路径又走通了，这里立刻转红。
      window.fetch = function (input) {
        calls.push(String(input));
        return Promise.reject(new Error('静态报告不该联网'));
      };
    }
  });
  return { dom: dom, doc: dom.window.document, window: dom.window, calls: calls };
}

(async function main() {
  const A = open(RAW, 'http://localhost/report.html');
  const B = open(RAW, fileUrl(outFile));

  // DOMContentLoaded 是异步触发的，必须等渲染落地再断言
  const renderedA = await waitFor(() => A.doc.querySelectorAll('#rankList .rank-item').length > 0, 5000);
  const renderedB = await waitFor(() => B.doc.querySelectorAll('#rankList .rank-item').length > 0, 5000);

  const doc = A.doc;

  console.log('\n[报告] 产物本身（单文件、自包含）');

  test('没有留下任何外部引用（CSS / JS 必须全部内联）', () => {
    assert.ok(!/<link[^>]+stylesheet/i.test(RAW), 'styles.css 还是外链 —— 换台机器打开就没样式了');
    assert.ok(!/<script[^>]+src=/i.test(RAW), '还有外链脚本（engine.js / app.js 没内联）');
    assert.ok(RAW.indexOf('<style>') >= 0, '应内联了样式');
  });

  test('数据被内联进页面（__FAMILY_DATA__）', () => {
    assert.ok(RAW.indexOf('__FAMILY_DATA__') >= 0, '页面里找不到内联数据');
    assert.ok(RAW.indexOf('FIXTURE-GROUP') >= 0, '内联数据里应含夹具的家庭组 id');
  });

  test('脚本标签结构正确（数据 + engine + app 三段，没有提前闭合）', () => {
    const opens = (RAW.match(/<script/g) || []).length;
    const closes = (RAW.match(/<\/script>/g) || []).length;
    assert.strictEqual(opens, 3, '应有 3 个 <script>，实际 ' + opens);
    assert.strictEqual(closes, 3, '闭合次数应恰好等于开启次数，实际 ' + closes +
      '（多了说明内联的 JS 里有裸 </script 提前闭合了）');
  });

  console.log('\n[报告] 用 jsdom 当真浏览器打开');

  test('页面渲染出了贡献榜与成员（说明内联的脚本真的跑起来了）', () => {
    assert.ok(renderedA, '报告应在 5 秒内渲染出贡献榜（渲染不出来说明内联脚本没跑）');
    assert.strictEqual(doc.querySelectorAll('#memberList .member').length, 6, '应渲染 6 位成员');
    assert.strictEqual(doc.querySelectorAll('#rankList .rank-item').length, 6, '应渲染 6 条贡献榜');
  });

  test('★ 一个网络请求都没发（数据本来就在页面里）', () => {
    assert.deepStrictEqual(A.calls, [], '静态报告不该发任何请求，实际发了：' + A.calls.join('、'));
  });

  /* ------------------------------------------------------------------ *
   * 注入演练
   *   ★ 为什么单列一段：报告是「发给别人双击打开」的，而 --from 吃的那份 JSON
   *     完全可以是别人递过来的。在线链路里 appid 一定是 Number，但离线链路不是 ——
   *     所以不能靠「上游会过滤」，渲染那一层必须自己转义。
   *   ★ 判定标准只有一条：payload 有没有变成**元素**。
   *     同时要求 payload 原文仍以**文本**存在 —— 否则「全部丢掉」也能骗过判定。
   * ------------------------------------------------------------------ */
  console.log('\n[报告] 注入演练：--from 喂进来的字段不能变成页面元素');

  const buildStaticReportHtml = require(path.join(ROOT, 'src', 'static-report.js')).buildStaticReportHtml;
  const PWN = '<img src=x onerror="window.__PWNED=1">';
  const fixtureRaw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const attackPayload = JSON.parse(JSON.stringify(fixtureRaw.family ? fixtureRaw.family : fixtureRaw));
  attackPayload.games[0].appid = PWN;   // 在线链路里这一定是整数；离线链路可以是任意字符串
  const attackHtml = buildStaticReportHtml(attackPayload, { priceMode: 'final' });
  const C = open(attackHtml, 'http://localhost/attack.html');
  const attackRendered = await waitFor(() => C.doc.querySelectorAll('#valueBody tr').length > 0, 5000);

  test('★ appid 是字符串 HTML 时只当文本渲染，不变成元素', () => {
    assert.ok(attackRendered, '明细表没渲染出来 —— 这条演练根本没打到目标，不算过');
    assert.strictEqual(C.window.__PWNED, undefined,
      '注入成立：appid 未转义就进了 innerHTML（--from 的 JSON 由别人递过来时可直接执行脚本）');
    assert.strictEqual(C.doc.querySelectorAll('#valueBody img, #valueBody svg').length, 0,
      '明细里多出了注入的元素');
    assert.ok(C.doc.body.textContent.indexOf('<img') >= 0,
      'payload 原文应作为**文本**保留（转义 ≠ 把串吞掉，否则这条测试照样能「过」）');
  });

  const BAD_AVATARS = [
    'javascript:window.__PWNED=1',
    'data:text/html,<script>window.__PWNED=1</script>',
    'http://' + 'avatars.steamstatic.com/x.jpg',            // 协议不对
    'https://' + 'avatars.steamstatic.com.evil.example/x.jpg', // 后缀混淆
    'https://' + 'evil.example/x.jpg'
  ];
  const avPayload = JSON.parse(JSON.stringify(fixtureRaw.family ? fixtureRaw.family : fixtureRaw));
  avPayload.members.forEach(function (m, i) { m.avatar = BAD_AVATARS[i % BAD_AVATARS.length]; });
  const E = open(buildStaticReportHtml(avPayload, { priceMode: 'final' }), 'http://localhost/avatar.html');
  const avRendered = await waitFor(function () { return E.doc.querySelectorAll('#memberList .member').length > 0; }, 5000);

  // 正向对照：真 CDN 地址要照常渲染成 img —— 否则这道卡口可能把功能一起掐死了
  const okPayload = JSON.parse(JSON.stringify(fixtureRaw.family ? fixtureRaw.family : fixtureRaw));
  okPayload.members.forEach(function (m) { m.avatar = 'https://avatars.steamstatic.com/' + 'a'.repeat(40) + '_medium.jpg'; });
  const F = open(buildStaticReportHtml(okPayload, { priceMode: 'final' }), 'http://localhost/avatar-ok.html');
  const okRendered = await waitFor(function () { return F.doc.querySelectorAll('#memberList .member').length > 0; }, 5000);

  test('★ 头像只认 CDN 前缀：别的协议 / 域名一律退回文字头像', () => {
    // esc() 只管 HTML 转义，**不管协议**。avatar 在离线链路（--from 的 JSON）里
    // 可以是任意字符串，所以这里单独卡一道。
    assert.ok(avRendered, '成员列表没渲染出来 —— 这条演练没打到目标，不算过');
    assert.strictEqual(E.doc.querySelectorAll('#memberList img').length, 0,
      'memberList 里出现了 img —— 非 CDN 地址被当头像用了');
    assert.strictEqual(E.window.__PWNED, undefined, '注入成立');
    assert.ok(okRendered, '正向对照没渲染出来');
    assert.strictEqual(F.doc.querySelectorAll('#memberList img').length, okPayload.members.length,
      '正常 CDN 头像应该照常渲染（否则这道卡口把功能掐死了）');
  });

  test('★ warnings 不进产物（远端可控文本不能随报告转发出去）', () => {
    const leaking = JSON.parse(JSON.stringify(fixtureRaw.family ? fixtureRaw.family : fixtureRaw));
    leaking.priceMeta = {
      source: 'store',
      degraded: true,
      warnings: ['Steam 返回了非 JSON 内容（可能被网络中间层拦截）：见 https://api.steampowered.com/x?access_token=LEAKED-TOKEN']
    };
    const html = buildStaticReportHtml(leaking, {});
    assert.ok(html.indexOf('access_token') < 0,
      'warnings 被原样内联进了报告 —— 对端在错误页里回显请求 URL 就等于把 token 送出去');
    assert.ok(html.indexOf('LEAKED-TOKEN') < 0, 'warnings 内容没被剔除');
    assert.ok(html.indexOf('"degraded":true') >= 0, '除 warnings 外的元信息应保留（别一刀切）');
  });

  test('★ 不往访客的浏览器里写数据', () => {
    assert.strictEqual(A.window.localStorage.getItem(STORAGE_KEY), null,
      '静态报告不该把自己的数据塞进访客的 localStorage');
  });

  test('KPI「贡献总池」= 手算的 ' + money(FINAL.scoreTotal), () => {
    const t = doc.querySelector('#kpi').textContent;
    assert.ok(t.indexOf(money(FINAL.scoreTotal)) >= 0, '实际 KPI：' + t.replace(/\s+/g, ' ').slice(0, 160));
  });

  test('每人的净贡献 = 手算的（贡献 − 白玩到）', () => {
    Object.keys(FINAL.score).forEach((name) => {
      const el = Array.from(doc.querySelectorAll('#rankList .rank-item'))
        .filter((x) => x.querySelector('.rank-name').textContent === name)[0];
      assert.ok(el, '贡献榜里应有 ' + name);
      const expect = net(FINAL.score[name] - FINAL.received[name]);
      assert.strictEqual(el.querySelector('.rank-net').textContent, expect, name + ' 的净贡献应为 ' + expect);
    });
  });

  test('★ 净贡献求和为 0（不变量：sum(贡献) === sum(白玩到)）', () => {
    const sum = Object.keys(FINAL.score)
      .reduce((a, k) => a + (FINAL.score[k] - FINAL.received[k]), 0);
    assert.strictEqual(sum, 0, '手算值自己就不满足不变量，夹具或期望值写错了');
  });

  test('明细只列产生价值的 4 款游戏，「项目总贡献」逐款对上', () => {
    const rows = Array.from(doc.querySelectorAll('#valueBody tr'));
    assert.strictEqual(rows.length, 4, '应只有 4 款游戏产生了共享价值，实际 ' + rows.length);
    Object.keys(FINAL.byGame).forEach((name) => {
      const row = rows.filter((r) => r.children[0].textContent.indexOf(name) === 0)[0];
      assert.ok(row, '明细里应有「' + name + '」');
      const total = row.children[4].textContent.replace(/\s+/g, ' ').trim();
      assert.strictEqual(total, money(FINAL.byGame[name]), name + ' 的项目总贡献应为 ' + money(FINAL.byGame[name]));
    });
  });

  test('★ 明细「项目总贡献」合计 = 贡献总池（逐分对上）', () => {
    const sum = Array.from(doc.querySelectorAll('#valueBody tr'))
      .reduce((a, r) => a + Math.round(Number(r.children[4].textContent.replace(/[^0-9.]/g, '')) * 100), 0);
    assert.strictEqual(sum, FINAL.scoreTotal * 100, '明细合计与总池对不上');
  });

  console.log('\n[报告] 离线报告里仍然可用的功能');

  test('★ 切换「计分方式」为标价 -> 总池变成 ' + money(ORIGINAL_TOTAL), () => {
    const sel = doc.getElementById('priceMode');
    assert.ok(sel, '报告里应保留口径切换');
    sel.value = 'original';
    sel.dispatchEvent(new A.window.Event('change', { bubbles: true }));
    const t = doc.querySelector('#kpi').textContent;
    assert.ok(t.indexOf(money(ORIGINAL_TOTAL)) >= 0,
      '标价口径下总池应为 ' + money(ORIGINAL_TOTAL) + '，实际 KPI：' + t.replace(/\s+/g, ' ').slice(0, 160));
    sel.value = 'final';
    sel.dispatchEvent(new A.window.Event('change', { bubbles: true }));
    assert.ok(doc.querySelector('#kpi').textContent.indexOf(money(FINAL.scoreTotal)) >= 0, '切回折扣价应复原');
  });

  test('筛选下拉按成员重建（离线也照样能用）', () => {
    const opts = Array.from(doc.getElementById('filterOwner').querySelectorAll('option'));
    assert.strictEqual(opts.length, 7, '应「全部」+ 6 位成员');
  });

  console.log('\n[报告] 已移除的入口必须一个都不剩');

  test('★ ①「读取家庭组」整块已删除（它是已移除形态的产物）', () => {
    assert.strictEqual(doc.querySelector('.steam-card'), null, '报告里不该有「① 读取家庭组」这张卡片');
    assert.strictEqual(doc.getElementById('tokenInput'), null, '不该再有 token 输入框');
    assert.strictEqual(doc.querySelector('.key-help'), null, '不该再有取 token 的教程块');
    assert.strictEqual(doc.querySelector('.trust-box'), null, '不该再有「token 会被中转」那套风险说明');
  });

  test('★「刷新价格」与「清空显示」已删除（快照不该被清空）', () => {
    ['refresh-prices', 'reset'].forEach((act) => {
      assert.strictEqual(doc.querySelector('[data-act="' + act + '"]'), null,
        '不该再有 ' + act + ' 这个入口');
    });
  });

  test('顶部出现快照说明条，并写明生成时间', () => {
    const bar = doc.getElementById('snapshotBar');
    assert.ok(bar, '应有快照说明条');
    assert.strictEqual(bar.hidden, false, '快照模式下必须显示');
    assert.ok(bar.textContent.indexOf('静态快照') >= 0, '要说明这是快照：' + bar.textContent);
    assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(bar.textContent), '要带上生成时间：' + bar.textContent);
  });

  test('「导出 JSON」仍然可用（纯本地操作）', () => {
    const el = doc.querySelector('[data-act="export"]');
    assert.ok(el && el.hidden === false, '导出是纯前端操作，离线报告里应保留');
  });

  console.log('\n[报告] file:// 打开的真实场景');

  test('★ 用 file:// 直接打开报告时，显示的是快照说明，而不是「这是空模板」', () => {
    assert.ok(renderedB, 'file:// 下也应正常渲染');
    const bar = B.doc.getElementById('snapshotBar');
    const text = bar ? bar.textContent : '';
    assert.ok(text.indexOf('静态快照') >= 0, '应显示快照说明，实际：' + text);
    assert.ok(text.indexOf('模板') < 0, '报告里是有数据的，不该被当成空模板：' + text);
    assert.strictEqual(B.doc.querySelectorAll('#rankList .rank-item').length, 6, 'file:// 下应渲染 6 条贡献榜');
  });

  console.log('\n[报告] 命令行 --json 与手算值一致');

  test('--json 的输出 = 手算答案', () => {
    const j = JSON.parse(cliJson);
    assert.strictEqual(j.totals.scoreCents, FINAL.scoreTotal * 100, '贡献总池对不上');
    assert.strictEqual(j.totals.receivedValueCents, FINAL.scoreTotal * 100, '不变量在 CLI 侧也应成立');
    Object.keys(FINAL.score).forEach((name) => {
      const row = j.rows.filter((r) => r.name === name)[0];
      assert.ok(row, '--json 里应有 ' + name);
      assert.strictEqual(Math.round(row.score * 100), FINAL.score[name] * 100, name + ' 的贡献分对不上');
    });
  });

  test('页面运行期间没有 JS 报错', () => {
    assert.deepStrictEqual(errors, [], '出现了 JS 错误：\n' + errors.join('\n'));
  });

  try { fs.unlinkSync(outFile); } catch (e) { /* 临时文件删不掉不影响结论 */ }

  console.log('\n\u2705 静态报告测试全部 ' + passed + ' 项通过\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n\u274c 失败：' + e.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exit(1);
});
