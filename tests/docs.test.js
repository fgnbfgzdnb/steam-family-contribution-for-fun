/*!
 * 文档口径闸门 + 发布闸门
 *
 * 三件事：
 *   ① 「README 里提到的入口 / 脚本 / 环境变量必须都是白名单里的」。
 *      写成白名单而不是「已下线入口黑名单」：黑名单得把那些名字写出来，
 *      而「仓库里不该出现的东西」连注释里举例都不该出现 —— 例子会被还原出来。
 *   ② 开源前的红线扫描：仓库里不能出现私钥/凭据字面量、不能关掉证书校验、
 *      不能有 access_token 落盘、不能有未登记的出网域名、不能有密钥类文件、
 *      必须保持零运行时依赖（供应链面 = 0）。
 *      —— 这一条是「扫 git 会带走的那些文件」，所以本地生成的真报告不会被误伤。
 *   ③ 对外文字红线：不许点名「已不存在的形态 / 校外基础设施」，不许写改动纪年。
 *      判据只有两条（见 FORBIDDEN_FORMS / FORBIDDEN_PROCS 处的说明）：
 *      点名读者在这个仓库里看不到的东西，或者点名一段已经发生过的经过。
 *
 * 零依赖、全离线（只读文本），所以能进 `npm test`。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  \u2713 ' + name);
}

const README = read('README.md');
const INDEX = read('index.html');

/* ★ 读者会不会「照着做却撞墙」—— 用**白名单**判，不用黑名单。
 *   这里的三个表就是 README 允许出现的全部入口 / npm 脚本 / 环境变量。
 *   任何不在表里的名字都会被拦下 —— 不管是新加的，还是读者照着做也没有用的旧名字。 */
const ENTRY_ALLOW = ['steam-family.js', 'run.bat', 'run.sh'];
const SCRIPT_ALLOW = ['test', 'test:ui', 'test:report', 'check', 'report', 'report:html', 'report:sample', 'install', 'i'];
const ENV_ALLOW = ['STEAM_ACCESS_TOKEN', 'HTTPS_PROXY', 'STEAM_FORCE_DIRECT', 'STEAM_FAMILY_CACHE'];

console.log('\n[文档] README 提到的入口 / 脚本 / 环境变量必须都在白名单里');

test('★ README 里的 node 入口名只能来自白名单', function () {
  const found = (README.match(/node\s+[A-Za-z0-9_./-]+\.js/g) || []).map(function (m) {
    return m.replace(/^node\s+/, '');
  });
  const bad = found.filter(function (f) { return ENTRY_ALLOW.indexOf(f) < 0; });
  assert.deepStrictEqual(bad, [], 'README 里出现了白名单外的入口：' + bad.join('、') +
    ' —— 读者照着做会撞墙（要么加进 ENTRY_ALLOW，要么从 README 里去掉）');
});

test('★ README 里的 shell 入口名只能来自白名单', function () {
  const found = (README.match(/(?:\.\/)?\b[A-Za-z0-9_-]+\.(?:sh|bat)\b/g) || []).map(function (m) {
    return m.replace(/^\.\//, '');
  });
  const bad = found.filter(function (f) { return ENTRY_ALLOW.indexOf(f) < 0; });
  assert.deepStrictEqual(bad, [], 'README 里出现了白名单外的脚本：' + bad.join('、'));
});

test('★ README 里的 npm 脚本名只能来自白名单（npm start 这类会在这里被拦下）', function () {
  const found = [];
  (README.match(/npm\s+run\s+[A-Za-z0-9:_-]+/g) || []).forEach(function (m) {
    found.push(m.replace(/^npm\s+run\s+/, ''));
  });
  (README.match(/npm\s+(?!run\b)[A-Za-z][A-Za-z0-9:_-]*/g) || []).forEach(function (m) {
    found.push(m.replace(/^npm\s+/, ''));
  });
  const bad = found.filter(function (f) { return SCRIPT_ALLOW.indexOf(f) < 0; });
  assert.deepStrictEqual(bad, [], 'README 里出现了白名单外的 npm 脚本：' + bad.join('、'));
});

test('★ README 里的 STEAM_* 配置项名只能来自白名单', function () {
  // 只看 STEAM_ 前缀：这一族的名字才是「本项目的配置项」，
  // OS 自带的目录变量（LOCALAPPDATA / XDG_CACHE_HOME…）与文档文件名不在此列。
  // 已移除的那个凭据环境变量正好落在这一族里，所以这条拦得住。
  const found = [...new Set(README.match(/\bSTEAM_[A-Z0-9_]+\b/g) || [])];
  const bad = found.filter(function (v) { return ENV_ALLOW.indexOf(v) < 0; });
  assert.deepStrictEqual(bad, [], 'README 里出现了白名单外的配置项名：' + bad.join('、') +
    ' —— 设了也没有用的名字不该出现在文档里');
});

test('★ 讲 token 去向时，必须说清它不经过任何第三方', function () {
  assert.ok(README.indexOf('不经过任何第三方') >= 0 || README.indexOf('不需要你把它交给任何人') >= 0,
    '要明确告诉读者：token 只在自己机器上用，不经过任何第三方服务');
});

test('★ README 里不许出现点分数字串（版本号写成 vX.Y.Z，别让 IP 混进来）', function () {
  // 这条替代了原来那条「把真实服务器 IP 拆成两半写进去」的 tripwire ——
  // 同属「闸门自己携带真实数据」的毛病（连注释里举例都不行：示例本身会被还原出来）。
  // 改成按形态判：任何「数字.数字(.数字)」只要不是 v 前缀的版本号就当场拦下
  // （README 现在一个都没有）。
  const hits = [];
  const RE = /(?:^|[^0-9A-Za-z.])([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})/g;
  let m;
  while ((m = RE.exec(README)) !== null) hits.push(m[1]);
  assert.deepStrictEqual(hits, [],
    'README 里出现了点分数字串（像 IP）：' + hits.join('、') + ' —— 版本号请写成 vX.Y.Z');
});

test('★ 必须说清「报告里是组里真人的信息，别转发到家庭组以外」', function () {
  assert.ok(README.indexOf('别把报告转发') >= 0,
    '报告里是成员昵称/头像/SteamID/整份游戏库，读者要知道不该往外转');
  assert.ok(README.indexOf('家庭组以外') >= 0, '要说清边界是「家庭组以外」');
});

test('★ 必须说清「不需要任何 Web API Key」，且不承诺任何内置凭据', function () {
  assert.ok(README.indexOf('不需要任何 Web API Key') >= 0 || README.indexOf('不需要 Web API Key') >= 0,
    '要明确告诉读者：只需要一个 access_token，Key 一点都用不上');
  assert.ok(README.indexOf('不含任何内置') >= 0,
    '开源项目要明说：仓库里没有任何凭据，也不会去用别人的');
});

test('★ 必须警告「取完 token 别再刷新 Steam 页面」（token 会被轮换作废）', function () {
  // store 页面每加载一次就换发新 token（新 jti），旧的立即作废，
  // 哪怕 exp 还剩好几个小时 —— 这是 401 最常见的原因，比「过期」常见得多。
  assert.ok(README.indexOf('轮换') >= 0, '要说清 401 的头号原因是 token 被轮换作废');
  assert.ok(README.indexOf('别再刷新') >= 0 || README.indexOf('不要再刷新') >= 0,
    '要给出可操作的动作：取完 token 直接回来跑');
});

test('★ 必须写明昵称/头像走的是免密钥接口', function () {
  assert.ok(README.indexOf('免密钥') >= 0,
    '要写明昵称头像来自 Steam 社区那条免密钥接口（读者据此判断要不要额外准备 Key）');
});

test('★ 必须如实交代「自包含」的例外：头像是外链，收件人会回源 Steam CDN', function () {
  // 报告确实把样式/脚本/数据全内联了，但成员头像是 <img src="avatars.steamstatic.com/...">。
  // 收件人双击打开 = 他的 IP 与打开时间对 Steam CDN 可见 —— 只说「自包含」是误导。
  // ★ 这里锚的是那段警告里独有的说法：光查 avatars.steamstatic.com 是哑的 ——
  //   技术章节里也提到了这个域名，把警告整段删掉闸门照样绿。
  assert.ok(README.indexOf('自包含') >= 0, '「自包含」这句话不该被删掉，只是要补上例外');
  assert.ok(README.indexOf('avatars.steamstatic.com') >= 0,
    '要写明头像来自 avatars.steamstatic.com（出网清单里得有它）');
  assert.ok(README.indexOf('对 Steam 可见') >= 0,
    '要在「自包含」附近如实写一句：收件人打开时头像会回源 Steam CDN，他的 IP 与打开时间对 Steam 可见；' +
    '并给出「清空 avatar 字段」这个不出网的选项');
});

console.log('\n[文档] 报告模板里不能残留已移除的入口');

test('★ 不该再有 token 输入框 / 读取按钮 / 取 token 教程 / 风险说明块', function () {
  ['id="tokenInput"', 'data-act="family-import"', 'trust-box', 'key-help'].forEach(function (needle) {
    assert.ok(INDEX.indexOf(needle) < 0, '报告模板里还留着 ' + needle);
  });
});

test('★ 不该再有「刷新价格」「清空显示」（快照不该被清空）', function () {
  ['data-act="refresh-prices"', 'data-act="reset"'].forEach(function (needle) {
    assert.ok(INDEX.indexOf(needle) < 0, '报告模板里还留着 ' + needle);
  });
});

test('★ 报告模板必须有 CSP，至少掐掉 connect-src（别给注入留外带通道）', function () {
  // 只加 connect-src 'none'：页面本来一个网络调用都没有（static-report 测试钉着这一点），
  // 所以它不可能弄坏功能，却能把「注入成功之后把数据带出去」这条路堵死。
  assert.ok(/http-equiv="Content-Security-Policy"/.test(INDEX), 'index.html 里没有 CSP meta');
  assert.ok(/connect-src 'none'/.test(INDEX), "CSP 里要写 connect-src 'none'");
});

console.log('\n[发布闸门] 凭据与隐私红线（扫全部会进仓库的文件）');

/* 扫的就是「会进仓库的那些文件」：优先问 git（`git ls-files`），
 *   拿不到 git（比如发布出去的 tarball）再退回扫目录。
 *   退回扫目录时要把 .gitignore 里那些可重建的报告产物剔掉，否则会误报。 */
function trackedLikeFiles() {
  try {
    const out = require('child_process')
      .execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const list = out.split('\n').map((s) => s.trim()).filter(Boolean);
    if (list.length >= 20) return list;
  } catch (e) { /* 没有 git 就用下面的兜底 */ }
  const skip = new Set(['.git', '.cache', '.workbuddy', 'node_modules']);
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    if (skip.has(e.name)) return [];
    const rel = dir ? dir + '/' + e.name : e.name;
    return e.isDirectory() ? walk(rel) : [rel];
  });
  // 兜底模式下剔掉可重建的报告产物（它们不在仓库里，只是本地跑出来的）。
  // ★ 与 .gitignore 的「*.html + 白名单」对齐：根目录下的 .html 一律当成本地报告产物，
  //   只有仓库自带的 index.html / report-sample.html 例外（子目录里的另有规则，不在这里判）。
  const KEEP_HTML = ['index.html', 'report-sample.html'];
  return walk('').filter(function (f) {
    if (/^tests\/\.tmp\//.test(f)) return false;
    if (!/\.html?$/i.test(f)) return true;
    if (f.indexOf('/') >= 0) return true;
    return KEEP_HTML.indexOf(f) >= 0;
  });
}
const FILES = trackedLikeFiles().filter((f) => fs.existsSync(path.join(ROOT, f)));
assert.ok(FILES.length >= 25 && FILES.indexOf('README.md') >= 0, '文件清单没扫出来，闸门本身有问题');

const CRED_PATTERNS = [
  [/-----BEGIN[^-]*PRIVATE KEY-----/, '仓库里出现了私钥'],
  [/\beyJ[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{8,}\./, '仓库里出现了 JWT 形态的真实凭据（测试桩请写成 x.y.z 或用假签名占位）'],
  [/(access_token|api_?key|secret|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/i, '硬编码的凭据字面量'],
  [/reject\s*Unauthorized\s*:\s*false/, '关掉了 TLS 证书校验'],
  // ★ 下面两条的" needles "故意拼出来：本文件自己也在扫描范围内，
  //   写成字面量就会自己把自己扫红。
  [new RegExp('steam' + '_family' + '_access' + '_token'), 'access_token 不允许被写进 localStorage'],
  [new RegExp('X' + '-Steam' + '-' + 'Token'), '这个转发头不该再出现'],
  [/\b1[3-9][0-9]{9}\b/, '像手机号'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[a-zA-Z]/, '像邮箱（git 身份除外，它不在这个清单里）']
];
const IP_ALLOW = ['127.0.0.1', '0.0.0.0', '203.0.113.', '192.0.2.', '198.51.100.', '5.5.5.5', '8.8.8.8'];

FILES.forEach(function (rel) {
  const txt = read(rel);
  test('干净：' + rel, function () {
    CRED_PATTERNS.forEach(function (row) {
      const m = txt.match(row[0]);
      assert.ok(!m, rel + '：' + row[1] + (m ? ' —— 命中 `' + m[0].slice(0, 40) + '`' : ''));
    });
    (txt.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []).forEach(function (ip) {
      assert.ok(IP_ALLOW.some((a) => ip.indexOf(a) === 0), rel + '：出现了非本地/非文档保留的 IP `' + ip + '`');
    });
  });
});

test('★ 仓库里不许有密钥类文件（.pem/.key/.p12/.pfx/id_rsa）', function () {
  const bad = FILES.filter(function (f) { return /\.(pem|key|p12|pfx)$/i.test(f) || /^id_(rsa|ed25519)/.test(path.basename(f)); });
  assert.deepStrictEqual(bad, [], '这些文件不能进仓库：' + bad.join(', '));
});

/* ★ 真人 steamid64 的红线。
 *   这个工具读的就是一个真实家庭组，跑一次就会拿到成员的真实 id ——
 *   别把它们当「测试数据」写进单测里。
 *   白名单只有两类：① 合成夹具用的 765611900000000xx；② 几条公开的历史常量
 *   （STEAM64_BASE、Gabe 的公开 id、STEAM_0:0:1234 的换算结果）。
 *   要加新值就得连注释一起加，让人一眼看出它是假的。 */
const FAKE_STEAMIDS = [
  '76561190000000001', '76561190000000002', '76561190000000003',
  '76561190000000004', '76561190000000005', '76561190000000006',
  '76561197960265728',            // STEAM64_BASE 起点
  '76561197960435530',            // Gabe Newell 的公开 id（文档里当换算例子）
  '76561197960268196', '76561197960268197',  // STEAM_0:0:1234 / STEAM_1:1:1234 的换算结果
  '76561198000000000'             // 测试里的假 Cookie 前缀
];

test('★ 全仓库不许出现真人 steamid64（白名单外一律红）', function () {
  const bad = [];
  FILES.forEach(function (rel) {
    (read(rel).match(/\b7656\d{13}\b/g) || []).forEach(function (id) {
      if (FAKE_STEAMIDS.indexOf(id) < 0) bad.push(rel + ' -> ' + id);
    });
  });
  assert.deepStrictEqual(bad, [], '这些像真实玩家的 steamid64 不能进仓库：\n    ' + bad.join('\n    '));
});

/* ★ 真人的「头像 hash」和「自定义主页名」怎么守。
 *
 *   不能用**黑名单**：那得把真人的主页名、头像 hash 一个个写成 needle 才拦得住，
 *   而 needle 放在仓库里就等于把要保护的东西本身公开了 —— 拼接、还原，
 *   任何人都做得到；当事人（同组的其他成员）也没同意被关联到这个仓库。
 *   所以改成**按形态白名单**：不携带任何真实值，覆盖反而更全。
 *   （真实值的反查交给不进仓库的工具：维护者本地那份真人为基准扫描。） */
const ID_ALLOW = ['gabelogannewell',   // Gabe Newell 的公开主页名，文档里当换算示例
  'somevanity'];                        // 合成夹具用的假主页名

test('★ 全仓库不许出现 40 位十六进制串（真人头像 hash 就是 40 位 sha1）', function () {
  // 这个仓库没有任何合法用途需要 40 位 hex。真要加（比如文档里引用某个 commit），
  // 就把值连同「它为什么是假的/公开的」注释一起加进下面这份白名单。
  const HASH_ALLOW = [
    '0000000000000000000000000000000000000000'   // git 的「零 SHA」哨兵（判断新建/删除引用用的公开常量）
  ];
  const bad = [];
  FILES.forEach(function (rel) {
    (read(rel).match(/\b[0-9a-f]{40}\b/g) || []).forEach(function (h) {
      if (HASH_ALLOW.indexOf(h) < 0) bad.push(rel + ' -> ' + h.slice(0, 8) + '…');
    });
  });
  assert.deepStrictEqual(bad, [], '这些像真人头像 hash 的值不能进仓库：\n    ' + bad.join('\n    '));
});

test('★ 自定义主页名只允许白名单里的值（合成夹具 / 公开示例）', function () {
  const bad = [];
  FILES.forEach(function (rel) {
    (read(rel).match(/steamcommunity\.com\/id\/([A-Za-z0-9_.-]+)/g) || []).forEach(function (m) {
      const name = m.split('/id/')[1];
      if (ID_ALLOW.indexOf(name) < 0) bad.push(rel + ' -> ' + name);
    });
  });
  assert.deepStrictEqual(bad, [], '主页名只允许白名单里的值（白名单外的很可能是真人的）：\n    ' + bad.join('\n    '));
});

console.log('\n[发布闸门] 对外文字红线：不许点名「看不到的东西」与「已经发生的经过」');

/* ★ 为什么要扫全部文件，而不是只扫 README 与报告模板：
 *   这两类东西最容易从 README 漏进源码注释与单测注释里（那边没人盯着）。
 *
 * ★ 判据（就两条，别的都不算违规）：
 *   ① 点名「已不存在的形态 / 校外基础设施」—— 读者在这个仓库里看不到它们，
 *      写出来等于把「还有另一个版本 / 一台服务器」讲出去。
 *   ② 点名「一段已经发生过的经过」—— 日期，以及那几个过程动词（见下面的表）。
 *
 * ★ 明确**不算**违规（别为了清字面量把这些也删了）：
 *   · README 的目录结构 / 参数表 / `npm test` 用法、CONTRIBUTING 的指路、
 *     package.json 的 scripts / bin、代码里「见 src/xxx.js」的改代码指引；
 *   · `SECURITY.md` 里用**否定句**讲清现状（不监听端口、不接收外部请求…），
 *     以及只维护最新版本这类支持范围声明 —— 讲功能边界不算点名旧形态；
 *   · 测试里的**断言本身**；
 *   · 无日期、无过程词的纯技术依据（例：某接口一次只能带一个 id，带 2/3/6 个一律 429）。
 *
 * ★ needle 一律拆开拼：本文件自己也在扫描范围内，写成整串会自己把自己扫红。 */
const FORBIDDEN_FORMS = [
  ['自托' + '管', '点名了一个已不存在的产品形态'],
  ['服务' + '端', '点名了一个已不存在的形态（讲现状请写成否定句，否定句放行）'],
  ['服务器上' + '现成的', '点名了一个已不存在的内部服务'],
  ['server' + '.js', '内部入口文件名'],
  ['deploy' + '/', '内部目录名'],
  ['audit' + '/', '内部目录名'],
  ['Docker' + 'file', '容器化部署形态'],
  ['docker' + '-compose', '容器化部署形态'],
  ['root' + '@', 'SSH 登录形态'],
  ['/opt' + '/', '内部部署路径'],
  ['ssh' + ' -i', 'SSH 私钥调用形态'],
  ['STEAM_API' + '_KEY', '已移除的凭据名（读者设了也没有用）'],
  ['--api' + '-key', '已移除的参数（传了也没有用）'],
  ['self-' + 'hosted', '已不存在的部署形态'],
  ['RATE_LIMIT' + '_PER_MIN', '已移除的配置项'],
  ['/api/' + 'family', '不存在的端点名']
];

const FORBIDDEN_PROCS = [
  [/\b20\d\d-\d\d-\d\d\b/, '日期 —— 改动纪年'],
  ['曾' + '经', '过程叙述'],
  ['早' + '先', '过程叙述'],
  ['后' + '来', '过程叙述'],
  ['试' + '过', '过程叙述'],
  ['踩' + '过', '过程叙述'],
  ['吃' + '过', '过程叙述'],
  ['★关键' + '教' + '训★', '说教式叙述'],
  ['漏' + '过一次', '过程叙述'],
  ['一' + '度', '过程叙述']
];

/* ★ 报告的「生成时间」是**功能字段**（快照说明条要把它显示出来），不是改动纪年 ——
 *   扫之前先把这个数据字段剔掉。剔的是 `"generatedAt": "…"` 这一种形态，
 *   不影响正文里的日期（正文里出现日期照样红）。 */
const stripStamps = (t) => t.replace(/"generatedAt"\s*:\s*"[^"]*"/g, '"generatedAt":""');

/* ★ 讲清现状的**否定句**要放行：「没有…」「不是…」「不需要…」后面接一个形态名，
 *   是在说明「这里没有那个东西」，不是在点名它。（`SECURITY.md` 就靠这句活着。）
 *   判据：命中处往前 12 个字符内出现否定词，就视为否定句。 */
const NEGATION = /(没有|不需要|不必|不是|不会|不该|不含|无|不)[^，。；\n]{0,8}$/;

test('★ 全仓库不许点名已不存在的形态 / 校外基础设施', function () {
  const bad = [];
  FILES.forEach(function (rel) {
    const txt = read(rel);
    FORBIDDEN_FORMS.forEach(function (row) {
      let i = txt.indexOf(row[0]);
      while (i >= 0) {
        const before = txt.slice(Math.max(0, i - 12), i);
        if (!NEGATION.test(before)) bad.push(rel + ' -> `' + row[0] + '`：' + row[1]);
        i = txt.indexOf(row[0], i + 1);
      }
    });
  });
  assert.deepStrictEqual(bad, [], '这些字样把「读者看不到的东西」讲了出口：\n    ' + bad.join('\n    '));
});

test('★ 全仓库不许出现日期与过程叙述（改动纪年 / 过程动词）', function () {
  const bad = [];
  FILES.forEach(function (rel) {
    const txt = stripStamps(read(rel));
    FORBIDDEN_PROCS.forEach(function (row) {
      const m = txt.match(row[0]);
      if (m) bad.push(rel + ' -> `' + m[0] + '`：' + row[1]);
    });
  });
  assert.deepStrictEqual(bad, [], '这些是过程性叙述，不该出现在公开文字里：\n    ' + bad.join('\n    '));
});

test('★ 公开树里不许出现内部发布流程（tools/hooks/）', function () {
  // 发布/更新流程不进仓库：它只会告诉读者「作者怎么推代码」，
  // 而且内部流程文件里必然带着只有当内部才存在的东西（另设的分支、内部目录名…）。
  const bad = FILES.filter(function (f) { return /^tools\/hooks\//.test(f); });
  assert.deepStrictEqual(bad, [], '内部发布流程不该进公开树：' + bad.join(', '));
});
test('★ 零运行时依赖 + 没有 install 生命周期脚本（供应链面 = 0）', function () {
  const pkg = JSON.parse(read('package.json'));
  assert.deepStrictEqual(pkg.dependencies || {}, {}, '本项目承诺零运行时依赖');
  ['preinstall', 'postinstall', 'install', 'prepare'].forEach(function (hook) {
    assert.ok(!pkg.scripts || !pkg.scripts[hook], 'npm 生命周期脚本 ' + hook + ' 会被自动执行，不能要');
  });
});

test('★ 出网目标只能是 Steam 与汇率源', function () {
  const ALLOW = ['api.steampowered.com', 'store.steampowered.com', 'steamcommunity.com',
    'avatars.steamstatic.com', 'open.er-api.com', 'nodejs.org', '127.0.0.1', 'localhost',
    'www.w3.org', 'github.com'];
  // ★ 后缀清单要跟着仓库里实际会出现的文本类型走 —— 少一个后缀（比如 yml/yaml），
  //   .github/ 下的 workflow 与 issue 模板正好落在闸门的盲区里。
  FILES.filter(function (f) { return /\.(js|html|css|json|md|sh|bat|yml|yaml)$/.test(f); }).forEach(function (rel) {
    (read(rel).match(/https?:\/\/[A-Za-z0-9._-]+/g) || []).forEach(function (u) {
      const host = u.replace(/^https?:\/\//, '');
      assert.ok(ALLOW.indexOf(host) >= 0, rel + '：出现了未登记的外链域名 `' + host + '`');
    });
  });
});

console.log('\n[文档] package.json 与目录一致性');

test('package.json 里的脚本都指向存在的文件', function () {
  const pkg = JSON.parse(read('package.json'));
  Object.keys(pkg.scripts).forEach(function (name) {
    const cmd = pkg.scripts[name];
    const m = cmd.match(/node\s+([^\s&|]+)/g) || [];
    m.forEach(function (part) {
      const rel = part.replace(/^node\s+/, '');
      const abs = path.join(ROOT, rel);
      assert.ok(fs.existsSync(abs), '`npm run ' + name + '` 指向了不存在的文件：' + rel);
    });
  });
});

test('package.json 的 bin 指向存在的入口', function () {
  const pkg = JSON.parse(read('package.json'));
  if (!pkg.bin) return;
  Object.keys(pkg.bin).forEach(function (name) {
    assert.ok(fs.existsSync(path.join(ROOT, pkg.bin[name])), 'bin ' + name + ' 指向的文件不存在');
  });
});

console.log('\n[发布闸门] 报告产物不得进仓库');

test('★ .gitignore 必须忽略根目录下「任意命名」的 .html 报告', function () {
  // 背景：报告默认叫 steam-family-report.html，但 --out 允许改成任意名字。
  //   只写默认名 + *.report.html 是不够的 —— `--out family.html` 生成的产物
  //   会堂而皇之出现在 git status 里，而报告里是真人信息。
  const lines = read('.gitignore').split('\n').map(function (s) { return s.trim(); });
  const iAll = lines.indexOf('*.html');
  assert.ok(iAll >= 0, '.gitignore 里缺少 `*.html` 这条总闸（要盖住 --out 的任意命名）');
  // ⚠ 放行必须排在 *.html 之后：gitignore 里后写的覆盖先写的，顺序反了 index.html 会被忽略。
  ['!index.html', '!report-sample.html'].forEach(function (needle) {
    const i = lines.indexOf(needle);
    assert.ok(i >= 0, '.gitignore 里缺少放行规则 `' + needle + '`');
    assert.ok(i > iAll, '`' + needle + '` 必须排在 `*.html` 之后，否则放行会被忽略规则吃掉');
  });
});

test('★ 不问写法，直接问 git：放行的没被忽略、报告的确实被忽略', function () {
  let run = null;
  try {
    run = require('child_process').execFileSync;
    run('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { return; }  // 没有 git（比如发布出去的 tarball）就跳过
  const ignored = function (f) {
    try { run('git', ['check-ignore', '-q', f], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }); return true; }
    catch (e) { return false; }
  };
  ['index.html', 'report-sample.html'].forEach(function (f) {
    assert.ok(!ignored(f), f + ' 被 .gitignore 忽略了 —— 它是仓库自带的文件，不能被忽略');
  });
  ['family.html', 'steam-family-report.html', '报告.html'].forEach(function (f) {
    assert.ok(ignored(f), f + ' 没被忽略 —— 用 --out 取这个名字生成的报告会被误提交');
  });
});

console.log('\n\u2705 文档口径测试全部 ' + passed + ' 项通过\n');
