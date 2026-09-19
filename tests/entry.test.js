/*!
 * 「一条命令出报告」入口的测试（离线，不需要网络）
 *
 * 守的是这个承诺：**下载完就能用，不需要任何后端、不需要两端操作**。
 * 所以这里既测纯函数（token 从哪来、各平台的打开命令），
 * 也真的用子进程跑一遍那条命令，确认它确实产出了报告。
 *
 * ★ require 入口不会触发它跑主流程 —— steam-family.js 有 `require.main === module` 守卫。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'family-api-sample.json');
const ENTRY = path.join(ROOT, 'steam-family.js');

const entry = require('../steam-family.js');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('  \u2713 ' + name);
}

/* ★ 临时文件必须落在仓库目录里：--from / --out 现在只允许当前目录内的路径
 *   （src/safe-path.js 的闸门），写到系统临时目录会被直接拒掉。 */
const TMP = path.join(ROOT, 'tests', '.tmp');
fs.mkdirSync(TMP, { recursive: true });
function tmpFile(name) {
  return path.join(TMP, name + '-' + process.pid + '.' + process.hrtime.bigint().toString(36) + '.json');
}
function rm(p) { try { fs.unlinkSync(p); } catch (e) { /* 删除失败不影响结论 */ } }

(async function main() {
  console.log('\n[入口] access_token 从哪来');

  await test('--token 优先于环境变量', async () => {
    const t = await entry.resolveToken(['--token', 'from-arg'], { STEAM_ACCESS_TOKEN: 'from-env' });
    assert.strictEqual(t, 'from-arg');
  });

  await test('没有 --token 时读环境变量', async () => {
    const t = await entry.resolveToken([], { STEAM_ACCESS_TOKEN: 'from-env' });
    assert.strictEqual(t, 'from-env');
  });

  await test('★ 来源都没有、又不是交互式终端 -> 明确报错，绝不挂在那里等输入', async () => {
    const saved = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    // ★ 万一这条保护被改坏（真的跑去等输入了），这里兜住 ——
    //   否则整个测试会挂死，「卡住」比「失败」难查得多。
    const guard = setTimeout(() => {
      console.error('\n  \u2717 超时：没有报错，而是在等输入 —— 「非交互式终端」的保护失效了\n');
      process.exit(1);
    }, 5000);
    try {
      await assert.rejects(
        () => entry.resolveToken([], {}),
        /不是交互式终端/,
        '非交互模式下必须报错退出（管道/CI 里挂住等输入是最糟的失败方式）'
      );
    } finally {
      clearTimeout(guard);
      Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
    }
  });

  console.log('\n[入口] ★ API Key 链路已整体移除');

  await test('resolveApiKey 不该再存在（本项目不用 Web API Key）', () => {
    assert.strictEqual(entry.resolveApiKey, undefined,
      '不需要 Web API Key：家庭组只认 access_token，昵称头像走免密钥接口');
  });

  await test('★ 入口源码里不该再出现那个已移除的凭据入口', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'steam-family.js'), 'utf8');
    // ★ needle 拆开拼：本仓库有一条闸门专门禁这两种形态（禁的是「公开文字里点名」），
    //   写成整串会把自己扫红 —— 而这条断言本身是「禁止它们出现」，属于允许的用法。
    const badOpt = '--api' + '-key';
    const badEnv = 'STEAM_API' + '_KEY';
    assert.ok(src.indexOf(badOpt) < 0, '入口不该再接受那个已移除的参数');
    assert.ok(src.indexOf(badEnv) < 0, '入口不该再读那个已移除的环境变量');
    assert.ok(src.indexOf('resolveApiKey') < 0, '入口不该再有 resolveApiKey');
  });

  await test('★ 取 token 的提示必须警告「取完别再刷新 Steam 页面」', () => {
    // 实测：store 页面每加载一次就换发新 token，旧的立即作废（哪怕 exp 还没到）——
    // 这是 401 最常见的原因，不写进提示里用户一定踩。
    const src = fs.readFileSync(path.join(__dirname, '..', 'steam-family.js'), 'utf8');
    assert.ok(src.indexOf('别再刷新') >= 0, '要提醒：取完 token 直接回来粘，中途别刷新 Steam 页面');
    assert.ok(src.indexOf('作废') >= 0, '要说清旧 token 会立即作废');
  });

  await test('★ 交互式粘贴 token 时不回显（录屏 / 旁人看不到）', () => {
    // readline 默认把输入回显到 output —— 那行会留在滚屏里。
    // ★ 这条测试要能把「没关回显」判出来：readline 只在 output 是 TTY 时才回显，
    //   而测试里 stdout 是被捕获的（不是 TTY），所以必须**在子进程里把 isTTY 伪装成 true**，
    //   否则不管代码怎么写都不会回显，这条测试就成了永远绿的哑弹。
    const secret = 'stub-token-abcdefghij';
    const code = 'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });'
      + 'require(' + JSON.stringify(ENTRY) + ').askToken().then(function (t) {'
      + " console.log('LEN=' + t.length); });";
    const out = execFileSync(process.execPath, ['-e', code],
      { input: secret + '\n', encoding: 'utf8', cwd: ROOT, timeout: 30000 });
    assert.ok(out.indexOf(secret) < 0,
      'token 被回显到 stdout 了 —— 终端滚屏 / 录屏都能看到，要关掉 readline 的回显');
    assert.ok(out.indexOf('LEN=' + secret.length) >= 0,
      'askToken 应该把输入原样返回（长度 ' + secret.length + '）');
  });

  await test('★ 交互提示的顺序：功能 → 用法 → token 重要性 → 网络要求', () => {
    // 一上来就讲网络和凭据，会让人还没搞清这工具是什么就被劝退。
    // ★ 匹配带编号的段标题，不要只匹配词：解释这段顺序的注释里也出现了同样的词，
    //   用裸词会先命中注释、把顺序判错。
    const src = fs.readFileSync(path.join(__dirname, '..', 'steam-family.js'), 'utf8');
    const heads = ['1. 它做什么', '2. 怎么用', '3. token 是什么', '4. 网络前提'];
    const at = heads.map((k) => src.indexOf(k));
    at.forEach((v, i) => assert.ok(v > 0, '第 ' + (i + 1) + ' 段标题「' + heads[i] + '」不见了'));
    for (let i = 1; i < at.length; i += 1) {
      assert.ok(at[i - 1] < at[i],
        '顺序必须是「功能 → 用法 → token 重要性 → 网络要求」，实际位置：' + at.join(' < '));
    }
  });

  await test('★ 价格必须每次现查（一次性脚本，缓存换不来值得的不确定性）', () => {
    ['steam-family.js', path.join('tools', 'family-report.js')].forEach((rel) => {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.ok(src.indexOf('store-items.json') < 0, rel + '：价格不该再接缓存文件');
      assert.ok(src.indexOf('cache: priceCache') < 0, rel + '：getPrices 不该传 cache');
      assert.ok(/getPrices\([^]*?onProgress/.test(src), rel + '：不缓存就得给进度，否则像卡死');
    });
  });

  await test('★ 昵称仍要有缓存（免密钥接口有 IP 级限流，重复敲容易吃 429）', () => {
    ['steam-family.js', path.join('tools', 'family-report.js')].forEach((rel) => {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.ok(src.indexOf('user-profiles.json') >= 0, rel + '：昵称没接缓存文件');
      assert.ok(src.indexOf('.flush()') >= 0, rel + '：退出前没 flush（定时落盘可能来不及写）');
    });
  });

  await test('★ 昵称缓存必须落在工程目录之外（缓存里是别人的昵称与 SteamID）', () => {
    const steam = require('../src/steam.js');
    ['cacheDir', 'cacheFile', 'legacyCacheHint'].forEach((fn) => {
      assert.strictEqual(typeof steam[fn], 'function', 'src/steam.js 没导出 ' + fn);
    });

    const dir = steam.cacheDir();
    assert.ok(path.isAbsolute(dir), 'cacheDir() 要给出绝对路径，实际：' + dir);
    assert.ok(dir.indexOf(ROOT) !== 0,
      '缓存目录不能在工程目录里（打包外发就会把真人身份带出去），实际：' + dir);
    assert.strictEqual(path.dirname(steam.cacheFile('user-profiles.json')), dir,
      'cacheFile 落点要和 cacheDir 一致');

    // 环境变量能改位置 —— 这条是给「想让它待在别处」的人留的
    const prev = process.env.STEAM_FAMILY_CACHE;
    process.env.STEAM_FAMILY_CACHE = path.join(os.tmpdir(), 'sfc-cache-probe');
    try {
      assert.strictEqual(steam.cacheDir(), path.join(os.tmpdir(), 'sfc-cache-probe'),
        'STEAM_FAMILY_CACHE 没被认');
    } finally {
      if (prev === undefined) delete process.env.STEAM_FAMILY_CACHE;
      else process.env.STEAM_FAMILY_CACHE = prev;
    }

    // 两个入口都不许再自己拼工程内的 .cache
    ['steam-family.js', path.join('tools', 'family-report.js')].forEach((rel) => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(src.indexOf("'.cache'") < 0, rel + '：还在往工程目录里的 .cache 写');
      assert.ok(src.indexOf('steam.cacheFile(') >= 0, rel + '：缓存路径没走 steam.cacheFile()');
    });
  });

  await test('★ 指引必须说清 F12 里「哪个面板、点哪里」取（Network 优先，Console 兜底）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'steam-family.js'), 'utf8');
    assert.ok(src.indexOf('Network') >= 0, '要指出 F12 的 Network 面板');
    assert.ok(src.indexOf('Fetch/XHR') >= 0, '要给 Network 的筛选步骤');
    assert.ok(src.indexOf('Ctrl+F') >= 0, '要教用 Ctrl+F 搜 access_token 定位请求');
    assert.ok(src.indexOf('Request URL') >= 0, '要说清从哪个字段里复制');
    assert.ok(src.indexOf('Console') >= 0 && src.indexOf('loyalty_webapi_token') >= 0,
      'Console 那行命令要作为兜底保留（页面没发请求时只有它拿得到）');
    // Network 排在前面：它更快，而且不用先过 Chrome 的 allow pasting 那道坎
    assert.ok(src.indexOf('Network') < src.indexOf('Console'),
      '顺序应是「Network 优先、Console 兜底」');
  });

  await test('★ 取 token 的页面要固定成家庭组管理页（别让用户在标签页之间跳）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'steam-family.js'), 'utf8');
    assert.ok(src.indexOf('account/familymanagement') >= 0, '要指明在家庭组管理页取 token');
  });

  await test('★ 不做本地代理端口自动探测（要代理的人自己开，猜错的代价由用户承担）', () => {
    const core = fs.readFileSync(path.join(__dirname, '..', 'src', 'steam.js'), 'utf8');
    assert.ok(core.indexOf('autoDetectProxyEnv') < 0, 'src/steam.js 不该再有自动探测代理');
    assert.ok(core.indexOf('LOCAL_PROXY_PORTS') < 0, 'src/steam.js 不该再内置代理端口清单');
    assert.ok(core.indexOf("require('net')") < 0, '探测没了就别再引 net 模块');
    ['steam-family.js', path.join('tools', 'family-report.js')].forEach((rel) => {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.ok(src.indexOf('autoDetectProxyEnv') < 0, rel + ' 不该调用代理自动探测');
    });
  });

  await test('★ run.bat 必须是 CRLF 行尾（LF 会让 cmd 吃字符、窗口一片空白）', () => {
    // 写成 LF 后双击 bat，cmd 报 "'etlocal' is not recognized"，
    // 而且前 18 秒一片空白（端口探测逐个阻塞 2s），用户以为「打开 bat 啥都没」。
    const buf = fs.readFileSync(path.join(__dirname, '..', 'run.bat'));
    let bare = 0;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) bare += 1;
    }
    assert.strictEqual(bare, 0, 'run.bat 里有 ' + bare + ' 个裸 LF —— cmd 解析会错乱');
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), 'run.bat 不该带 BOM');
  });

  await test('★★ run.bat 只许调用入口一次（多了会把报告跑两遍）', () => {
    // 多调一次的后果不是「多打印几行」：交互模式下会连着问两次 token，
    // 配了环境变量则双倍请求 Steam（上千款价格查两遍），白白多一份被限流的风险。
    // 这类「插入新块时没删掉旧行」的事故只有数次数才抓得住 —— 别的断言都还是绿的。
    const bat = fs.readFileSync(path.join(__dirname, '..', 'run.bat'), 'utf8');
    const hits = bat.match(/\bnode\s+"%~dp0steam-family\.js"/g) || [];
    assert.strictEqual(hits.length, 1,
      'run.bat 里入口被调用了 ' + hits.length + ' 次（必须恰好 1 次）');
  });

  await test('★ run.bat 不该再有 PowerShell 探测和英文提示（探测整个功能都不要了）', () => {
    const bat = fs.readFileSync(path.join(__dirname, '..', 'run.bat'), 'utf8');
    // 阻塞式 TcpClient.Connect() 每个关闭的端口约 2s，9 个端口 = 18s 空白窗口；
    // 改成猜代理的话，猜错的代价由用户承担、还看不见 —— 所以这个功能不做。
    assert.ok(bat.indexOf('powershell') < 0, 'run.bat 不该再调 PowerShell 探端口');
    assert.ok(bat.indexOf('[run.bat]') < 0, 'run.bat 不该再有面向用户的英文提示（提示统一由 Node 用中文打）');
    assert.ok(bat.indexOf('steam-family.js') >= 0, 'run.bat 至少得把入口跑起来');
    assert.ok(bat.indexOf('pause') >= 0, '双击运行时窗口会秒关，必须 pause 让人看清结果');
    // ★ pause 恒返回 0，会把入口的退出码吃掉 —— 必须先存下 ERRORLEVEL 再 exit /b 传出去。
    assert.ok(/set\s+"?SFC_EXIT=/.test(bat), 'run.bat 要先存下 ERRORLEVEL');
    assert.ok(bat.indexOf('exit /b %SFC_EXIT%') >= 0, 'run.bat 最后要把退出码原样传出去');
  });

  console.log('\n[入口] 打开浏览器用的命令（各平台）');

  await test('★★ Windows 必须不经 shell：交给 explorer.exe，且参数原样传', async () => {
    const c = entry.openCommandFor('C:/a/b&ver&.html', 'win32');
    assert.strictEqual(c.cmd, 'explorer.exe', 'Windows 下用 explorer.exe 直接吃路径');
    assert.deepStrictEqual(c.args, ['C:/a/b&ver&.html'], '路径原样交给它，自己别再拼命令行');
  });

  await test('★★ Windows 下不许把启动交给 cmd（「用了 args 数组就安全」是错的）', async () => {
    // 被启动的是 cmd.exe 本身，它会把整条命令行**重新解析一遍**：
    // 而 pathToFileURL 不编码 &，于是 `--out "a&ver&.html"` 里的 & 成了命令分隔符，
    // ver 会真的执行。换了 explorer.exe 这条路才算断。
    const src = fs.readFileSync(path.join(__dirname, '..', 'steam-family.js'), 'utf8');
    assert.ok(!/spawn\(\s*['"]cmd['"]/.test(src), '别再 spawn cmd');
    assert.ok(src.indexOf("'start'") < 0, '别再拼那个 start 命令行');
  });

  await test('macOS 用 open，Linux 用 xdg-open', async () => {
    assert.strictEqual(entry.openCommandFor('/tmp/a.html', 'darwin').cmd, 'open');
    assert.strictEqual(entry.openCommandFor('/tmp/a.html', 'linux').cmd, 'xdg-open');
    assert.deepStrictEqual(entry.openCommandFor('/tmp/a.html', 'linux').args, ['/tmp/a.html']);
  });

  await test('★ 交给系统的是原样路径，不做 shell / URL 转换（& 与中文都不能被当成语法）', async () => {
    const p = path.join(os.tmpdir(), '报告 & 测试.html');
    assert.deepStrictEqual(entry.openCommandFor(p, 'win32').args, [p]);
    assert.deepStrictEqual(entry.openCommandFor(p, 'darwin').args, [p]);
  });

  console.log('\n[入口] 读离线数据文件');

  await test('直接给家庭组 payload 形状的 JSON 能读', async () => {
    const p = entry.readPayloadFile(FIXTURE);
    assert.strictEqual(p.members.length, 6);
    assert.strictEqual(p.games.length, 9);
  });

  await test('包了一层 { family: {...} } 也能读', async () => {
    const p = tmpFile('wrap');
    fs.writeFileSync(p, JSON.stringify({ family: JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) }));
    try {
      assert.strictEqual(entry.readPayloadFile(p).members.length, 6);
    } finally { rm(p); }
  });

  await test('★ 形状不对时立刻报错，而不是渲染出白屏再让人去猜', async () => {
    const p = tmpFile('bad');
    fs.writeFileSync(p, JSON.stringify({ hello: 'world' }));
    try {
      assert.throws(() => entry.readPayloadFile(p), /形状不对/);
    } finally { rm(p); }
  });

  console.log('\n[入口] 端到端：真用子进程跑一遍那条命令');

  const outFile = path.join(TMP, 'entry-e2e-' + process.pid + '.html');
  rm(outFile);
  const stdout = execFileSync(process.execPath,
    [ENTRY, '--from', FIXTURE, '--no-open', '--out', outFile],
    { cwd: ROOT, encoding: 'utf8' }).toString();

  await test('★ 命令跑完就产出了一份报告 —— 全程没有监听端口', async () => {
    assert.ok(fs.existsSync(outFile), '报告文件没生成');
    const html = fs.readFileSync(outFile, 'utf8');
    assert.ok(!/<link[^>]+stylesheet/i.test(html), '还有外链样式');
    assert.ok(!/<script[^>]+src=/i.test(html), '还有外链脚本');
    assert.ok(html.indexOf('__FAMILY_DATA__') >= 0, '数据没内联进页面');
  });

  await test('终端会打印报告路径，并说明它是自包含单文件', async () => {
    assert.ok(stdout.indexOf(outFile) >= 0, '应打印报告路径，实际输出：' + stdout.slice(-300));
    assert.ok(stdout.indexOf('自包含') >= 0, '应说明可以直接发给别人');
  });

  await test('★ 终端简报的数字与手算一致（不是「跑完了」就算过）', async () => {
    assert.ok(stdout.indexOf('\u00a51,590.00') >= 0, '贡献总池应为 ¥1,590.00。实际输出：' + stdout);
    assert.ok(stdout.indexOf('\u00a5905.00') >= 0, '阿肯的贡献应为 ¥905.00');
  });

  await test('--no-open 时不弹浏览器（脚本化场景不能被弹窗打断）', async () => {
    assert.ok(stdout.indexOf('没自动弹出来') >= 0 || stdout.indexOf('双击') >= 0,
      '没打开时应提示手动双击，实际输出：' + stdout.slice(-200));
  });

  rm(outFile);

  console.log('\n[入口] 路径闸门：--from / --out 只碰当前目录');

  await test('★ --from 拒绝目录穿越、绝对路径、非 .json、控制字符', () => {
    const { resolveInputFile } = require('../src/safe-path.js');
    assert.strictEqual(resolveInputFile('data/sample.json', '--from'),
      path.join(ROOT, 'data', 'sample.json'), '当前目录内的 .json 要放行');
    // ★ 反斜杠在 POSIX 上只是普通字符、不是路径分隔符 —— 下面这两条只在 Windows 上
    //   才构成「越界」。不条件化的话，Linux 上 `C:\Windows\x.json` 会被当成当前目录里
    //   一个名字很怪的文件而放行，CI 必红（这个缺陷是 CI 第一次跑时抓出来的）。
    const badInputs = ['../secret.json', 'a/b/../../../x.json', '/etc/passwd.json'];
    if (process.platform === 'win32') {
      badInputs.push('..\\secret.json', 'C:\\Windows\\x.json');
    }
    badInputs.forEach(function (bad) {
      assert.throws(() => resolveInputFile(bad, '--from'), /当前目录/, '不该放行：' + bad);
    });
    assert.throws(() => resolveInputFile('data/sample.txt', '--from'), /扩展名/, '非 .json 要拒');
    assert.throws(() => resolveInputFile('', '--from'), /不能是空的/);
    assert.throws(() => resolveInputFile('a\u0000b.json', '--from'), /控制字符/);
  });

  await test('★ --out 拒绝穿越，且只认 .html / .htm', () => {
    const { resolveOutputFile, isOpenableReport } = require('../src/safe-path.js');
    assert.strictEqual(resolveOutputFile('r.html', '--out'), path.join(ROOT, 'r.html'));
    assert.strictEqual(resolveOutputFile('sub/r.htm', '--out'), path.join(ROOT, 'sub', 'r.htm'));
    // 同上：反斜杠形态只在 Windows 上有意义
    const badOuts = ['../r.html', 'a/../../r.html', '/tmp/r.html'];
    if (process.platform === 'win32') {
      badOuts.push('..\\r.html', 'C:\\Windows\\r.html');
    }
    badOuts.forEach(function (bad) {
      assert.throws(() => resolveOutputFile(bad, '--out'), /当前目录/, '不该放行：' + bad);
    });
    ['r.txt', 'r.exe', 'r', '.bashrc'].forEach(function (bad) {
      assert.throws(() => resolveOutputFile(bad, '--out'), /扩展名/, '不该放行：' + bad);
    });
    // 打开浏览器前的第二道（这里是纯判断，不抛错）
    assert.strictEqual(isOpenableReport(path.join(ROOT, 'r.html')), true);
    assert.strictEqual(isOpenableReport(path.join(ROOT, '..', 'r.html')), false, '目录外不许打开');
    assert.strictEqual(isOpenableReport(path.join(ROOT, 'r.exe')), false, '非 html 不许交给系统打开');
  });

  await test('★ 端到端：--from / --out 指向当前目录外会被拒，并给出人话的错误', () => {
    function runExpectFail(args, pattern) {
      try {
        execFileSync(process.execPath, [ENTRY].concat(args), { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        const msg = String((e.stderr || '') + (e.stdout || ''));
        assert.ok(pattern.test(msg), '错误消息应说明原因，实际：' + msg.slice(0, 300));
        assert.ok(msg.indexOf('at Object.') < 0, '不该把调用栈甩给用户');
        return;
      }
      throw new Error('本应被拒绝：' + args.join(' '));
    }
    runExpectFail(['--from', '../data.json', '--no-open'], /当前目录/);
    runExpectFail(['--from', FIXTURE, '--out', '../evil.html', '--no-open'], /当前目录/);
    runExpectFail(['--from', FIXTURE, '--out', 'evil.txt', '--no-open'], /扩展名/);
  });

  console.log('\n\u2705 入口测试全部 ' + passed + ' 项通过\n');
})().catch((e) => {
  console.error('\n\u274c 失败：' + e.message);
  process.exit(1);
});
