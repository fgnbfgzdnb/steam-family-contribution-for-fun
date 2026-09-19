#!/usr/bin/env node
/*!
 * 命令行跑分：把家庭组数据做成 JSON 丢进来，直接输出贡献榜。
 * 说明内核是 headless 的，所以报告与脚本可以共用同一套规则。
 *
 * 用法:
 *   node cli.js                    # 用内置示例数据
 *   node cli.js data.json          # 用自定义数据文件
 *   node cli.js data.json --json   # 输出机器可读的完整结果
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SC = require('./src/engine.js');
const { resolveInputFile } = require('./src/safe-path.js');

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const file = args.find((a) => !a.startsWith('--'));

function sample() {
  const names = ['阿肯', '老王', '小林', 'Momo', '阿七', '大熊'];
  const members = names.map((n) => ({ id: n, name: n }));
  // [appid, 名称, 无折扣原价, 拥有者, 是否支持家庭共享]
  const spec = [
    [2358720, '黑神话：悟空', 268, ['阿肯'], true],
    [1245620, '艾尔登法环', 298, ['阿肯', '老王'], true],
    [1091500, '赛博朋克 2077', 298, ['老王', '小林', 'Momo'], true],
    [1086940, '博德之门 3', 298, ['阿肯', '小林'], true],
    [289070, '文明 6', 220, ['阿肯', '老王', 'Momo', '大熊'], true],
    [292030, '巫师 3：狂猎', 199, names, true],
    [1426210, '双人成行', 198, ['Momo', '阿七'], false],
    [1174180, '荒野大镖客 2', 279, ['老王'], false],
    [367520, '空洞骑士', 58, ['阿肯', '阿七', '大熊'], true],
    [413150, '星露谷物语', 48, ['小林', 'Momo', '阿七', '大熊'], true],
    [105600, '泰拉瑞亚', 42, ['阿七', '大熊'], true],
    [550, '求生之路 2', 42, ['老王', '大熊'], true],
    [1203220, '永劫无间', 0, ['小林', '阿七'], false]
  ];
  return {
    members,
    games: spec.map((s, i) => ({
      id: 'g' + i, appid: s[0], name: s[1], price: s[2], ownerIds: s[3], shareable: s[4]
    }))
  };
}

let state;
if (file) {
  // ★ 路径过 safe-path 闸门：只认当前目录内的 .json
  state = JSON.parse(fs.readFileSync(resolveInputFile(file, '数据文件'), 'utf8'));
} else {
  state = sample();
}

const issues = SC.validate(state);
issues.forEach((i) => console.warn('[' + i.level + '] ' + i.message));

const result = SC.calculate(state);

if (wantJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n, ' ');
const padS = (s, n) => String(s).padStart(n, ' ');

console.log('');
console.log('Steam 家庭组贡献度 · ' + result.meta.memberCount + ' 人 / ' + result.meta.gameCount + ' 款游戏');
console.log('  库总原价（全部）   ' + SC.formatYuan(result.meta.libraryValue));
console.log('  共享池原价（可共享） ' + SC.formatYuan(result.meta.groupValue) + '   参与分配 ' + result.meta.activeGameCount + ' 款');
console.log('  贡献总池           ' + SC.formatYuan(result.totals.score));
if (result.meta.notShareableCount > 0) {
  console.log('  已排除             ' + result.meta.notShareableCount + ' 款不支持家庭共享的游戏（原价 ' +
    SC.formatYuan(result.meta.notShareableValue) + '）—— 别人玩不到，不计分');
}
console.log('');
// ★ 全 0 分往往不是「大家都没玩」，而是游玩记录没取回来 —— 明说，别让人以为算对了。
//   另外两个入口（steam-family.js / tools/family-report.js）都有这句，这里对齐。
if (result.totals.scoreCents === 0 && result.meta.gameCount > 0) {
  console.log('  ! 贡献总池是 0。如果这个家庭组确实有人玩过别人拥有的游戏，');
  console.log('    那多半是「谁玩过」这份数据没取回来（Steam 的 GetPlaytimeSummary 未公开，可能失败）。');
  console.log('');
}
console.log('  ' + pad('#', 4) + pad('成员', 12) + padS('贡献分', 14) + padS('占比', 9) +
  padS('拥有', 7) + padS('白玩到', 14) + padS('受益/贡献', 12));
console.log('  ' + '-'.repeat(70));
result.rows.forEach((r) => {
  console.log('  ' + pad(r.rank, 4) + pad(r.name, 12) +
    padS(SC.formatYuan(r.score), 14) +
    padS((r.share * 100).toFixed(1) + '%', 9) +
    padS(r.ownedCount, 7) +
    padS(SC.formatYuan(r.receivedValue), 14) +
    padS(r.scoreCents > 0 ? r.ratio.toFixed(2) : (r.receivedValueCents > 0 ? 'Inf' : '-'), 12));
});
console.log('');
