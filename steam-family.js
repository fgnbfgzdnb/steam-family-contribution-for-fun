#!/usr/bin/env node
/*!
 * Steam 家庭组贡献度 —— 一条命令出报告
 * ================================================================
 *   node steam-family.js
 *
 * 跑完直接弹出报告页面，然后进程退出。
 *
 * ★ 这一条命令自己直连 Steam（Node 直接发请求，不受浏览器 CORS 限制），
 *   算完把结果写成一份自包含的 HTML，再交给默认浏览器打开 ——
 *   没有常驻进程、没有本地端口，跑完就结束。
 *
 * ★ 需要：Node 18+、一个 Steam access_token（下面会教你怎么拿）。
 *   不需要 npm install（本项目零运行时依赖），也**不需要任何 Web API Key** ——
 *   家庭组数据只认 access_token，昵称头像走 steamcommunity 的免密钥接口。
 *
 * 参数：
 *   --token <t>    直接给 token（不给就读环境变量 STEAM_ACCESS_TOKEN，再没有就交互式问）
 *   --out <path>   报告输出路径（默认 ./steam-family-report.html）
 *   --original     报告默认按「标价」展示（不写则是当前国区折扣价）
 *   --no-open      生成后不自动打开浏览器（脚本化时用）
 *   --from <json>  离线：直接吃一份家庭组 payload JSON，完全不联网
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Writable } = require('stream');
const { spawn } = require('child_process');

const steam = require('./src/steam.js');
const SC = require('./src/engine.js');
const { buildFamilyPayload, toEngineInput } = require('./src/payload.js');
const { writeStaticReport } = require('./src/static-report.js');
const { resolveInputFile, isOpenableReport } = require('./src/safe-path.js');

const DEFAULT_OUT = 'steam-family-report.html';

/**
 * ★ 价格**不缓存**：这是一次性脚本，每次执行都现查 Steam。
 *   报告里的数字代表「生成它的那一刻」的价 —— 中间隔了缓存就可能差一个折扣，
 *   而省下的那点时间不值得用这个不确定性去换。
 *   （要等十几秒这件事用进度行解决，不用缓存解决。）
 *
 * 昵称头像是**另一回事**，它必须缓存：免密钥的 ajaxresolveusers 有 IP 级限流，
 *   重复敲同一个接口容易吃 429。这里只存公开信息，24 小时过期。
 * ★ 缓存里只有公开信息 —— access_token 永远只在内存里，不落盘。
 *
 * ★ 缓存**不写在工程目录里**：落点是用户级缓存目录（见 src/steam.js 的 cacheDir()），
 *   可以用 STEAM_FAMILY_CACHE 改。原因是它里面是组里成员的昵称与 SteamID ——
 *   落在工程目录里的话，谁把整个项目目录打包发出去就顺手把人发了。
 */
const PROFILE_CACHE_TTL = 24 * 3600 * 1000;   // 昵称头像：24 小时

/* ------------------------------ 小工具 ------------------------------ */

function padZ(s, n) {   // 中文按 2 个字宽算，让表格对齐
  const str = String(s);
  let w = 0;
  for (const ch of str) w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, n - w));
}
function padS(s, n) { return String(s).padStart(n); }

/** 取 --x 后面跟的值；present 表示开关在不在，value 是值（缺值时为默认值） */
function optValue(args, name, dflt) {
  const i = args.indexOf(name);
  if (i < 0) return { present: false, value: dflt };
  const v = args[i + 1];
  return { present: true, value: (v && v.indexOf('--') !== 0) ? v : dflt };
}

/* ------------------------------ token ------------------------------ */

/**
 * 按「显式参数 → 环境变量 → 交互式问」的顺序取 access_token。
 * ★ 刻意不落盘、不做缓存：它是账号级凭据，约 1 天就过期，
 *   存下来既不划算又多一个泄漏面。
 */
async function resolveToken(args, env) {
  const opt = optValue(args, '--token', null);
  if (opt.present && opt.value) return String(opt.value).trim();

  const fromEnv = ((env && env.STEAM_ACCESS_TOKEN) || '').trim();
  if (fromEnv) return fromEnv;

  if (!process.stdin.isTTY) {
    throw new Error('没有拿到 access_token，而且当前不是交互式终端，没法问你。\n' +
      '  用法：STEAM_ACCESS_TOKEN=xxx node steam-family.js');
  }
  return await askToken();
}

function askToken() {
  return new Promise((resolve, reject) => {
    // ★ 这四段的顺序是刻意排的：先说「它是干什么的」，再说「怎么用」，
    //   然后才是 token 的分量（凭据性质 + 轮换作废这个头号坑），最后是网络前提。
    //   反过来排（一上来就讲网络和凭据）会让人还没搞清这工具是什么就被劝退。
    console.log('');
    console.log('  === 1. 它做什么 ===');
    console.log('  读你 Steam 家庭组的共享库，按「你的游戏有没有被别人玩过」折算贡献度，');
    console.log('  跑完生成一份自包含的 HTML 报告 —— 双击就能看，也能直接发给组里其他人。');
    console.log('  只需要一个 access_token：不用 Web API Key、不用 npm install、不起任何服务。');
    console.log('');
    console.log('  === 2. 怎么用（三步）===');
    console.log('  ① 按下面的步骤取一个 token（约 1 分钟，F12 里两个面板任选其一）');
    console.log('  ② 粘到这个终端，回车');
    console.log('  ③ 等它跑完，报告会自动弹出来');
    console.log('     读家庭组约 3 秒；价格每次都是现查的（1400 款约 20 秒），中途会打进度。');
    console.log('  不想交互的话：STEAM_ACCESS_TOKEN=xxx node steam-family.js');
    console.log('');
    console.log('     取 token —— 先打开家庭组管理页：');
    console.log('       https://store.steampowered.com/account/familymanagement/');
    console.log('       （能看到你的组员，就说明登录态是好的）');
    console.log('     下面两种方法取到的是同一枚 token，任选一种：');
    console.log('');
    console.log('     ★ 方法一：F12 → Network 面板里直接复制（最快，不用管 Chrome 的粘贴限制）');
    console.log('       1. 按 F12 → 切到「Network / 网络」标签 → 筛选栏点「Fetch/XHR」');
    console.log('       2. 保持面板开着，按 Ctrl+Shift+R 硬刷新页面');
    console.log('          （Network 只记录打开之后的请求；顺带这一步也保证拿到的是最新那枚 token）');
    console.log('       3. 按 Ctrl+F 搜 access_token —— 这个页面自己就在请求家庭组接口');
    console.log('       4. 双击搜索结果跳到那条请求 → 看 Headers 里的 Request URL');
    console.log('          选中 access_token= 后面那一长串，Ctrl+C 复制');
    console.log('          ★ 只要那串字符本身，别把开头的 & 或结尾的 ? 一起选上');
    console.log('');
    console.log('     方法二：F12 → Console 一行命令（搜不到请求时用这个，一定拿得到）');
    console.log('       1. 按 Ctrl+Shift+R 硬刷新页面（旧标签页里那枚 token 很可能已经作废了）');
    console.log('       2. 按 F12 → 切到「Console / 控制台」标签');
    console.log('       3. 第一次粘贴会被 Chrome 拦下 —— 手动输入 allow pasting 再回车（只需一次）');
    console.log('       4. 粘贴这行并回车，token 会直接进剪贴板：');
    console.log('            copy(JSON.parse(application_config.dataset.loyalty_webapi_token))');
    console.log('          想先看看它长什么样，就去掉外面的 copy(...) 再回车。');
    console.log('');
    console.log('     然后回到这个终端，Ctrl+V 粘贴、回车即可。');
    console.log('');
    console.log('  === 3. token 是什么，为什么要注意 ===');
    console.log('  它是账号级凭据，等同于你的 Steam 登录态：');
    console.log('    · 只在你自己的机器上用 —— 不写进任何文件、不经过任何第三方，进程结束就没了');
    console.log('    · ★ 取完就直接回来粘，中途别再刷新或打开任何 Steam 网页 ★');
    console.log('      页面每加载一次就换发一枚新 token，旧的那枚立刻作废（哪怕还没到期）——');
    console.log('      这是读家庭组报 401 的头号原因，比「过期」常见得多。');
    console.log('    · 约 24 小时后过期。用完想更保险：去 Steam 重新登录一次，旧 token 立即失效。');
    console.log('');
    console.log('  === 4. 网络前提（粘 token 之前先确认这一条）===');
    console.log('    ★ token 是作为 URL 参数发给 Steam 的（这套接口本身的要求）——');
    console.log('      会解密 HTTPS 的加速器 / 杀软 / 公司代理能看到它，尽量用自己的网络。');
    console.log('  读家庭组必须连通 api.steampowered.com —— 家庭组接口只在这个域名上，没有降级路径：');
    console.log('    · 国内通常要先开加速器，并选覆盖 api 域的「路由模式」节点');
    console.log('    · 有些加速器只代理 store 域、不代理 api 域，会出现「价格查得到、家庭组却读不了」');
    console.log('    · 建议现在就开好再回来粘 token，否则「正在读取家庭组…」会一直卡到超时');
    console.log('    · 本来就能直连 Steam 的话，什么都不用开');
    console.log('');

    // ★ 关掉回显：它是账号级凭据，粘进终端不该显示在屏幕上 ——
    //   那行会留在滚屏里，录屏或旁人都能看走。
    //   做法是给 readline 一个「什么都不写」的输出流，题面自己打到 stdout：
    //   问题显示、答案不显示（和 sudo / npm login 一个路子）。
    const muted = new Writable({ write(chunk, encoding, cb) { cb(); } });
    process.stdout.write('  粘贴 access_token 后回车（输入不会显示）：');
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.question('', (ans) => {
      rl.close();
      process.stdout.write('\n');
      // 顺手剥掉两侧可能带上的引号 —— 教程特意提醒过，但总有人会连引号一起复制
      const t = String(ans || '').trim().replace(/^["']|["']$/g, '');
      if (!t) { reject(new Error('没有拿到 token，已退出。')); return; }
      resolve(t);
    });
  });
}

/* ------------------------------ 打开浏览器 ------------------------------ */

/**
 * 各平台用哪条命令打开本地文件。
 *
 * ★★ Windows 下**故意不经 shell**。别改回 `cmd /c start "" <fileurl>`：
 *    看起来用了 args 数组就安全了 —— 不是。被启动的是 cmd.exe 本身，
 *    它会把自己的命令行**重新解析一遍**，而 `pathToFileURL()` 不编码 `&`，
 *    于是 `--out "a&ver&.html"` 里的 `&` 就成了命令分隔符，`ver` 会真的执行。
 *    换 explorer.exe 直接吃路径，不经 shell，这条路就断了。
 *    ★ 真要改回去，必须自己给参数加引号并把 `^` 转义。
 */
function openCommandFor(targetPath, platform) {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [targetPath] };
  if (platform === 'darwin') return { cmd: 'open', args: [targetPath] };
  return { cmd: 'xdg-open', args: [targetPath] };
}

/**
 * 用系统默认程序打开报告。打开失败不算致命（下面会提示手动双击）。
 *
 * ★ 交出去之前再过一次路径闸门：只打开「当前目录内、.html/.htm」的文件。
 *   写盘那一步已经查过了，这里是第二道 —— 防止哪天有别的调用方把别的路径塞进来，
 *   毕竟这条链路会去调 `explorer` / `open` / `xdg-open`。
 */
function openInBrowser(filePath) {
  const abs = path.resolve(String(filePath == null ? '' : filePath));
  if (!isOpenableReport(abs)) return false;
  const c = openCommandFor(abs, process.platform);
  try {
    const child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore' });
    // spawn 失败是异步 emit error，不是抛异常 —— 不接住会变成未捕获错误
    child.on('error', function () { /* 交给调用方提示「手动双击」 */ });
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------ 取数据 ------------------------------ */

/**
 * 读一份已保存的数据文件（`--from`）。
 * ★ 路径过 safe-path 闸门：只认当前目录内的 .json。
 */
function readPayloadFile(p) {
  const abs = resolveInputFile(p, '--from');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error('读不了数据文件 ' + abs + '：' + e.message);
  }
  // 允许直接是 payload（含 members/games），也允许包一层 { family: {...} }
  const payload = raw && raw.family ? raw.family : raw;
  if (!payload || !Array.isArray(payload.members) || !Array.isArray(payload.games)) {
    throw new Error('数据文件形状不对，需要 { members: [...], games: [...] }：' + abs);
  }
  return payload;
}

async function fetchFromSteam(token) {
  console.log('  正在读取家庭组…');
  // 昵称缓存：ajaxresolveusers 有 IP 级限流，缓存能让重复跑不再去敲这个接口。
  // ★ 落点在用户级缓存目录（steam.cacheFile 决定），不在工程目录里。
  const profileCache = steam.createCache(steam.cacheFile('user-profiles.json'), PROFILE_CACHE_TTL, 200);
  const fam = await steam.resolveFamily(token, { cache: profileCache });
  profileCache.flush();
  console.log('    家庭组 ' + fam.familyGroupId + '：' + fam.members.length + ' 位成员，共享库 ' + fam.apps.length + ' 款游戏');
  const unnamed = fam.members.filter((m) => !m.nameResolved).length;
  if (unnamed) {
    console.log('    ! 有 ' + unnamed + ' 位成员没读到昵称（免密钥接口偶发限流），会显示成「玩家XXXXXX」；');
    console.log('      只影响显示，价格、归属与计分完全不受影响。重跑一次通常就好了。');
  }

  // ★ 价格每次现查，不传 cache —— 一次性脚本，缓存的意义抵不过「价格可能已经变了」。
  //   1400 款要约 18 秒，所以给它打进度，别让人对着不动的屏幕猜是不是卡死了。
  console.log('  正在查询价格…（每次都是现查的，1400 款约 20 秒）');
  const t0 = Date.now();
  let lastMark = 0;
  const pr = await steam.getPrices(fam.apps.map((a) => a.appid), {
    // 每跨过 25% 打一行：既看得见进展，又不刷屏
    onProgress: (done, total) => {
      const mark = Math.floor((done / Math.max(1, total)) * 4);
      if (mark > lastMark || done === total) {
        lastMark = mark;
        console.log('    取价中… ' + done + ' / ' + total);
      }
    }
  });
  console.log('    取价完成，用了 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  pr.warnings.forEach((w) => console.log('    ! ' + w));

  return buildFamilyPayload(fam, pr.prices, {
    source: pr.usedSource, degraded: pr.degraded, warnings: pr.warnings, rates: pr.rates
  });
}

/* ------------------------------ 输出 ------------------------------ */

function printSummary(res, reportPath, opened) {
  console.log('');
  console.log('  Steam 家庭组贡献度 · ' + res.meta.memberCount + ' 人 / ' + res.meta.gameCount + ' 款游戏');
  console.log('  ' + '='.repeat(62));
  console.log('  共享池现价   ' + SC.formatYuan(res.meta.groupValue));
  console.log('  贡献总池     ' + SC.formatYuan(res.totals.score));
  console.log('');
  res.rows.forEach((r) => {
    console.log('  ' + padS(r.rank, 2) + '. ' + padZ(r.name, 22) +
      padS('贡献 ' + SC.formatYuan(r.score), 20) +
      padS('白玩到 ' + SC.formatYuan(r.receivedValue), 22));
  });
  console.log('');

  // ★ 全 0 分往往不是「大家都没玩」，而是游玩记录没取回来 —— 明说，别让人以为算对了
  if (res.totals.scoreCents === 0 && res.meta.gameCount > 0) {
    console.log('  ! 贡献总池是 0。如果这个家庭组确实有人玩过别人拥有的游戏，');
    console.log('    那多半是「谁玩过」这份数据没取回来（Steam 的 GetPlaytimeSummary 未公开，可能失败）。');
    console.log('');
  }

  console.log('  报告：' + reportPath);
  console.log(opened
    ? '  已经用浏览器打开它了 —— 上面有完整的贡献榜和逐游戏明细。'
    : '  没自动弹出来的话，双击上面这个文件就行。');
  console.log('  单文件、自包含：直接发给组里其他人，他们双击也能看。');
  console.log('');
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  const fromOpt = optValue(args, '--from', null);
  const outOpt = optValue(args, '--out', DEFAULT_OUT);
  const noOpen = args.indexOf('--no-open') >= 0;
  const priceMode = args.indexOf('--original') >= 0 ? 'original' : 'final';

  // ★ 工程目录里不该出现昵称缓存 —— 那份副本里是组里成员的身份信息。
  //   发现就提醒一句（只提醒，不代删：删别人的文件不该由这个脚本决定）。
  const stale = steam.legacyCacheHint(__dirname);
  if (stale) console.log('\n  ! ' + stale + '\n');

  // 命令行参数会进 shell 历史与进程列表（`ps` / 任务管理器里能看到）——
  // 这类凭据还是走环境变量稳妥，至少这里要提一句。
  if (args.indexOf('--token') >= 0) {
    console.log('  ! 你用了 --token：参数会留在 shell 历史里，任务管理器也看得到。');
    console.log('    更稳的写法是 STEAM_ACCESS_TOKEN=xxx node steam-family.js。\n');
  }

  const payload = fromOpt.present
    ? readPayloadFile(fromOpt.value)
    : await fetchFromSteam(await resolveToken(args, process.env));

  const res = SC.calculate(toEngineInput(payload));

  const abs = writeStaticReport(payload, outOpt.value, { priceMode });
  const opened = noOpen ? false : openInBrowser(abs);
  printSummary(res, abs, opened);

  return abs;
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('\n  失败：' + e.message + '\n');
    process.exit(1);
  });
}

module.exports = { main, resolveToken, askToken, openCommandFor, openInBrowser, readPayloadFile, fetchFromSteam };
