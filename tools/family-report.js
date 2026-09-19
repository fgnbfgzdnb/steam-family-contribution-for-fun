#!/usr/bin/env node
/*!
 * 家庭组贡献度报表（命令行）+ 静态报告生成
 * ------------------------------------------------------------------
 * 直接从 Steam 拉家庭组数据、算完贡献度，打印排行榜；
 * 加 --html 则额外产出一份**自包含的单文件 HTML 报告** ——
 * 双击就能打开，不用装 Node、不用起服务、不用联网，适合直接发给别人看。
 *
 * 用法：
 *   STEAM_ACCESS_TOKEN=xxx node tools/family-report.js
 *   STEAM_ACCESS_TOKEN=xxx node tools/family-report.js --top 20
 *   STEAM_ACCESS_TOKEN=xxx node tools/family-report.js --json > out.json
 *   STEAM_ACCESS_TOKEN=xxx node tools/family-report.js --html report.html
 *
 *   离线（完全不联网，吃一份家庭组 payload JSON）：
 *   node tools/family-report.js --from data.json --html report.html
 *   node tools/family-report.js --from data.json --json
 *
 * 只读，不会修改任何 Steam 数据。
 * token 只从环境变量读，不要写进文件。
 * ★ 全程不需要 Web API Key：家庭组只认 access_token，昵称头像走免密钥接口。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const steam = require('../src/steam.js');
const SC = require('../src/engine.js');
const { buildFamilyPayload, toEngineInput } = require('../src/payload.js');
const { writeStaticReport } = require('../src/static-report.js');
const { resolveInputFile } = require('../src/safe-path.js');

const TOKEN = (process.env.STEAM_ACCESS_TOKEN || '').trim();

/**
 * ★ 价格不缓存（每次执行都现查），昵称头像缓存 24 小时 —— 理由见 steam-family.js 顶部。
 *   缓存里只有公开信息，★token 永不落盘★。
 * ★ 缓存落点是用户级缓存目录（steam.cacheFile 决定），不在工程目录里 ——
 *   它里面是组里成员的昵称与 SteamID，不该跟着项目目录被打包外发。
 */
const PROFILE_CACHE_TTL = 24 * 3600 * 1000;

const args = process.argv.slice(2);

function hasFlag(name) { return args.indexOf(name) >= 0; }

/**
 * 取 --x 后面跟的值。
 * present = 这个开关在不在；value = 值（后面没跟值、或又跟了另一个 --flag 时是默认值）。
 */
function optValue(name, dflt) {
  const i = args.indexOf(name);
  if (i < 0) return { present: false, value: dflt };
  const v = args[i + 1];
  return { present: true, value: (v && v.indexOf('--') !== 0) ? v : dflt };
}

const wantJson = hasFlag('--json');
const htmlOpt = optValue('--html', 'family-report.html');
const fromOpt = optValue('--from', null);
const topArg = args.indexOf('--top');
const TOP = topArg >= 0 ? Number(args[topArg + 1]) || 5 : 5;

if (fromOpt.present && !fromOpt.value) {
  console.error('\n--from 后面要跟一个 JSON 文件路径。\n');
  process.exit(1);
}

function padZ(s, n) {   // 中文按 2 个字宽算，让表格对齐
  const str = String(s);
  let w = 0;
  for (const ch of str) w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, n - w));
}
function padS(s, n) { return String(s).padStart(n); }

/* ------------------------------------------------------------------ *
 * 取数据：联网读 Steam，或从文件读（离线）
 * ------------------------------------------------------------------ */

async function loadPayload() {
  if (fromOpt.present) {
    // ★ 路径过 safe-path 闸门：只认当前目录内的 .json
    const abs = resolveInputFile(fromOpt.value, '--from');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      throw new Error('读不了数据文件 ' + abs + '：' + e.message);
    }
    // 允许直接就是 payload（含 members/games），也允许包一层 { family: {...} }
    const p = raw && raw.family ? raw.family : raw;
    if (!p || !Array.isArray(p.members) || !Array.isArray(p.games)) {
      throw new Error('数据文件形状不对：需要 { members: [...], games: [...] }');
    }
    console.error('已从文件读取：' + abs + '（' + p.members.length + ' 位成员 / ' + p.games.length + ' 款游戏）');
    return p;
  }

  if (!TOKEN) {
    console.error('\n缺少 STEAM_ACCESS_TOKEN。取法：打开家庭组管理页');
    console.error('  https://store.steampowered.com/account/familymanagement/ 然后按 F12：');
    console.error('    方法一（最快）Network 标签 → 硬刷新 → Ctrl+F 搜 access_token → 复制 Request URL 里那串值');
    console.error('    方法二（最稳）Console 标签 → copy(JSON.parse(application_config.dataset.loyalty_webapi_token))');
    console.error('\n不想联网的话，可以用 --from data.json 直接吃一份已保存的数据。\n');
    process.exit(1);
  }

  console.error('正在读取家庭组…');
  // 昵称缓存（只存昵称/头像这类公开信息，24h 过期）：ajaxresolveusers 有 IP 级限流，
  // 缓存能让重复跑不再去敲它。★token 永远不落盘★。
  const cache = steam.createCache(steam.cacheFile('user-profiles.json'), PROFILE_CACHE_TTL, 200);
  const fam = await steam.resolveFamily(TOKEN, { cache });
  cache.flush();
  console.error('家庭组 ' + fam.familyGroupId + '：' + fam.members.length + ' 位成员，共享库 ' + fam.apps.length + ' 款游戏');
  const unnamed = fam.members.filter((m) => !m.nameResolved).length;
  if (unnamed) console.error('  ! 有 ' + unnamed + ' 位成员没读到昵称（免密钥接口偶发限流），显示成「玩家XXXXXX」；不影响计分。');

  // ★ 价格每次现查，不传 cache：一次性脚本，缓存换不来值得的不确定性。
  //   进度走 stderr —— --json 时 stdout 必须只有 JSON。
  console.error('正在查询价格…（每次都是现查的，1400 款约 20 秒）');
  const t0 = Date.now();
  let lastMark = 0;
  const pr = await steam.getPrices(fam.apps.map((a) => a.appid), {
    onProgress: (done, total) => {
      const mark = Math.floor((done / Math.max(1, total)) * 4);
      if (mark > lastMark || done === total) {
        lastMark = mark;
        console.error('  取价中… ' + done + ' / ' + total);
      }
    }
  });
  console.error('  取价完成（' + ((Date.now() - t0) / 1000).toFixed(1) + 's，数据源 ' + pr.usedSource + '）');
  pr.warnings.forEach((w) => console.error('  ! ' + w));

  // ★ 与 steam-family.js 调**同一个**组装函数（src/payload.js）：
  //   两条入口的数据形状必须一模一样，否则 app.js 认不出来。
  return buildFamilyPayload(fam, pr.prices, {
    source: pr.usedSource, degraded: pr.degraded, warnings: pr.warnings, rates: pr.rates
  });
}

/* 静态报告的生成逻辑在 src/static-report.js —— 与 steam-family.js 入口共用同一份 */

/* ------------------------------------------------------------------ *
 * 终端报表
 * ------------------------------------------------------------------ */

function printReport(res, input, top, out) {
  out = out || console.log;
  const members = input.members;
  out('');
  out('  Steam 家庭组贡献度 · ' + res.meta.memberCount + ' 人 / ' + res.meta.gameCount + ' 款游戏');
  out('  ' + '='.repeat(74));
  out('  共享池现价   ' + SC.formatYuan(res.meta.groupValue) +
    '   （另有 ' + res.meta.notShareableCount + ' 款不支持共享，现价 ' + SC.formatYuan(res.meta.notShareableValue) + '，不计分）');
  out('  贡献总池     ' + SC.formatYuan(res.totals.score) + '   参与分配 ' + res.meta.activeGameCount + ' 款');
  out('');
  out('  ' + padZ('#', 4) + padZ('成员', 28) + padS('贡献分', 12) + padS('占比', 8) +
    padS('拥有', 6) + padS('白玩到', 12) + padS('受益/贡献', 11));
  out('  ' + '-'.repeat(74));
  res.rows.forEach((r) => {
    const ratio = r.scoreCents > 0 ? r.ratio.toFixed(2) : (r.receivedValueCents > 0 ? '∞' : '—');
    out('  ' + padZ(r.rank, 4) + padZ(r.name, 28) +
      padS(SC.formatYuan(r.score), 12) + padS((r.share * 100).toFixed(1) + '%', 8) +
      padS(r.ownedCount + ' 款', 6) + padS(SC.formatYuan(r.receivedValue), 12) + padS(ratio, 11));
  });
  out('');
  out('  说明：受益/贡献 > 1 表示「从别人那儿白玩到的」比自己掏出去的多。');
  out('');

  // ★ 全 0 分往往不是「大家都没玩」，而是游玩记录没取回来 —— 明说，别让人以为算对了
  if (res.totals.scoreCents === 0 && res.meta.gameCount > 0) {
    out('  ! 贡献总池是 0。如果这个家庭组确实有人玩过别人拥有的游戏，');
    out('    那多半是「谁玩过」这份数据没取回来（Steam 的 GetPlaytimeSummary 未公开，可能失败），');
    out('    而不是真的没人玩过。');
    out('');
  }

  // 单人独占的最贵游戏 —— 最能体现「谁贡献了别人都没有的东西」
  const solo = res.games
    .filter((g) => g.status === 'active' && g.ownerCount === 1)
    .sort((a, b) => b.totalContributionCents - a.totalContributionCents)
    .slice(0, top);
  if (solo.length) {
    out('  单人独占、贡献最高的 ' + solo.length + ' 款：');
    solo.forEach((g) => {
      const owner = members.filter((m) => g.ownerIds.indexOf(m.id) >= 0)[0];
      out('    ' + SC.formatYuan(g.price).padStart(10) + '  ' + padZ(owner ? owner.name : '?', 26) +
        padZ(g.name, 34) + ' +' + SC.formatYuan(g.unitContribution));
    });
    out('');
  }
}

/* ------------------------------------------------------------------ */

function jsonOf(res) {
  return {
    meta: res.meta,
    rows: res.rows.map((r) => ({
      rank: r.rank, name: r.name, score: r.score, share: r.share,
      ownedCount: r.ownedCount, ownedValue: r.ownedValue,
      receivedValue: r.receivedValue, ratio: r.ratio
    })),
    totals: res.totals
  };
}

(async function main() {
  // ★ 工程目录里不该出现昵称缓存，那份副本里是组里成员的身份信息。
  //   全程走 stderr：--json 时 stdout 必须只有 JSON。
  const stale = steam.legacyCacheHint(path.join(__dirname, '..'));
  if (stale) console.error('\n  ! ' + stale + '\n');

  const payload = await loadPayload();
  const input = toEngineInput(payload);
  const res = SC.calculate(input);

  // ★ --json 时 stdout 必须**只有** JSON（要能直接管道给 jq 或别的脚本），
  //   给人看的报表和提示一律走 stderr。
  const emit = wantJson ? console.error : console.log;

  if (wantJson) console.log(JSON.stringify(jsonOf(res), null, 2));

  let written = null;
  if (htmlOpt.present) written = writeStaticReport(payload, htmlOpt.value);

  if (!wantJson) printReport(res, input, TOP, emit);

  if (written) {
    const kb = Math.round(fs.statSync(written).size / 1024);
    emit('');
    emit('  静态报告：' + written + '  (' + kb + ' KB)');
    emit('  单文件、自包含 —— 发给任何人双击就能打开，不用装 Node、不用联网。');
    emit('');
  }
})().catch(function (e) {
  console.error('\n失败：' + e.message);
  process.exit(1);
});
