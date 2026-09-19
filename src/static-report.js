/*!
 * 静态报告生成器 —— 把线上页面整个内联成一个**自包含**的 HTML 文件。
 *
 * 产物特点：单文件、双击即开（不用装 Node、不用起服务）。
 *
 * ★ 说「自包含」要留个准确的口径：**样式、脚本、数据全在里面**，
 *   但成员头像是 `<img src="https://avatars.steamstatic.com/...">` ——
 *   收件人打开报告时浏览器会去 Steam CDN 取头像（他的 IP 与打开时间因此对 Steam 可见，
 *   断网时只见回退文字头像）。这一点在 README 里如实写了。
 *   要连头像也不出网，把 avatar 字段留空即可（页面上会退回文字头像）。
 *
 * 两个消费者：
 *   ① tools/family-report.js --html  （已经拿到数据的场景，顺手导出）
 *   ② steam-family.js                （「一条命令出报告」的入口）
 * 所以内联逻辑只留这一份，别在两边各写一遍。
 *
 * ★ 复用 index.html + styles.css + src/*.js，而不是另写一套渲染 ——
 *   报告和网页必须是同一套代码算出来、画出来的。
 *   app.js 检测到 window.__FAMILY_DATA__ 就会走「静态快照」那条启动路径。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveOutputFile } = require('./safe-path.js');

const ROOT = path.join(__dirname, '..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/**
 * JSON 内联进 <script> 的安全写法：把每个 < 转成 \u003c。
 * 这样 </script 和 <!-- 都不可能出现在脚本里（\u003c 在 JSON 里是合法转义）。
 */
function safeJson(o) { return JSON.stringify(o).replace(/</g, '\\u003c'); }

/** JS 源码内联前的转义：只处理真正会破坏 HTML 解析的那两个序列 */
function safeJs(s) {
  if (/<\/script/i.test(s)) s = s.replace(/<\/script/gi, '<\\/script');
  if (s.indexOf('<!--') >= 0) s = s.replace(/<!--/g, '<\\!--');
  return s;
}

/**
 * 进报告之前的最后一道清洗。
 *
 * ★ 为什么放在**这里**、而不是只在 src/payload.js 组装时做：
 *   离线链路（`--from data.json`）根本不经过 buildFamilyPayload() ——
 *   那份 JSON 可以是别人递过来的，里面什么字段都能有。而这里是内联之前的唯一关口。
 * ★ 剔掉的是 warnings：它会拼「远端返回的原话」（中间层回的错误页、代理报错…），
 *   对端若在错误页里回显请求 URL，那串 URL 上就带着 access_token。
 *   这份报告是要转发给别人双击打开的，所以这类文本一律不进产物。
 *   （跑脚本的人在终端已经逐条看过这些告警，报告里也没有任何地方渲染它。）
 */
function stripForReport(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = Object.assign({}, payload);
  delete out.warnings;
  const meta = out.priceMeta;
  if (meta && typeof meta === 'object' && 'warnings' in meta) {
    const clean = {};
    Object.keys(meta).forEach(function (k) { if (k !== 'warnings') clean[k] = meta[k]; });
    out.priceMeta = clean;
  }
  return out;
}

/**
 * 生成报告的 HTML 字符串（不落盘）。
 *
 * @param {object} payload  家庭组 payload 形状的数据（src/payload.js 的输出）
 * @param {object} [opts]   { priceMode: 'final' | 'original', generatedAt }
 *                          generatedAt 显式给空串 = 报告不写「生成于 …」
 *                          （进仓库的示例报告用它，免得把生成那一刻的时间也带上）
 */
function buildStaticReportHtml(payload, opts) {
  opts = opts || {};
  const html = read('index.html');
  const css = read('styles.css');
  const engineJs = read('src/engine.js');
  const appJs = read('src/app.js');

  const stamp = opts.generatedAt != null
    ? String(opts.generatedAt)
    : (payload && payload.generatedAt != null ? String(payload.generatedAt) : new Date().toISOString());

  const data = {
    generatedAt: stamp,
    priceMode: opts.priceMode === 'original' ? 'original' : 'final',
    family: stripForReport(payload)
  };

  const out = html
    .replace('<link rel="stylesheet" href="styles.css">', '<style>\n' + css + '\n</style>')
    .replace('<script src="src/engine.js"></script>', '<script>\n' + safeJs(engineJs) + '\n</script>')
    .replace('<script src="src/app.js"></script>',
      '<script>window.__FAMILY_DATA__ = ' + safeJson(data) + ';</script>\n<script>\n' + safeJs(appJs) + '\n</script>');

  // ★ 锚点对不上时必须炸掉。否则会「成功」产出一个没有样式、没有数据的空白报告，
  //   而使用者只看到「命令跑完了」—— 这种静默失败比直接报错难查得多。
  //   ★ 检查的是「结果里还有没有外链」，而不是某个固定字符串 ——
  //     这样 index.html 换了写法或改了文件名，也照样拦得住。
  const missing = [];
  if (out === html) missing.push('模板锚点一个都没匹配上');
  if (/<link[^>]+stylesheet/i.test(out)) missing.push('样式还是外链（styles.css 没内联）');
  if (/<script[^>]+src=/i.test(out)) missing.push('脚本还是外链（engine.js / app.js 没内联）');
  if (out.indexOf('__FAMILY_DATA__') < 0) missing.push('__FAMILY_DATA__（数据没注入）');
  if (missing.length) {
    throw new Error('生成的报告不完整：' + missing.join('、') +
      '\n（index.html 的模板改了，就要同步改 src/static-report.js 里的替换锚点）');
  }
  return out;
}

/**
 * 生成并写盘，返回绝对路径。
 * ★ 输出路径统一走 safe-path 闸门：必须是当前目录内的 .html / .htm。
 *   这里是不写盘前的最后一站，所有调用方（steam-family.js / tools/family-report.js）
 *   都被它覆盖，不需要各自再查一遍。
 */
function writeStaticReport(payload, outPath, opts) {
  const abs = resolveOutputFile(outPath, '--out');
  // ★ 别把模板本身覆盖掉：index.html 是报告模板（外链 styles.css + 两个 <script src>）。
  //   一旦被 `--out index.html` 写到同一个名字，模板就没了，之后每次都生成不出报告。
  //   判据看内容而不是文件名：生成出来的报告里那个样式外链已经被换成内联 <style> 了。
  if (fs.existsSync(abs)) {
    const prev = fs.readFileSync(abs, 'utf8').slice(0, 8192);
    if (prev.indexOf('<link rel="stylesheet" href="styles.css">') >= 0) {
      throw new Error('--out 指向的是报告模板本身（' + abs + '）：换个文件名再跑，别把模板覆盖掉');
    }
  }
  fs.writeFileSync(abs, buildStaticReportHtml(payload, opts), 'utf8');
  return abs;
}

module.exports = { buildStaticReportHtml, writeStaticReport };
