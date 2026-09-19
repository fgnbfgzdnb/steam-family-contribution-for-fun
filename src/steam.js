/*!
 * Steam 数据接入层（Node 专用，不要引到浏览器里）
 * ------------------------------------------------------------------
 * 接口结论（下面的数字都是实际调用确认过的）：
 *
 *  [1] IStoreBrowseService/GetItems  —— 批量取国区价格，★不需要 API Key★
 *      一次可请求 200 个 appid（~450ms）。返回人民币原价 / 现价 / 折扣，
 *      并带 feature_categoryids，其中 62 == 支持 Steam 家庭共享。
 *      这是本工具最重要的数据源。
 *
 *  [2] steamcommunity.com/actions/ajaxresolveusers —— 昵称 + 头像，★免任何密钥★
 *      一次只能带一个 steamid：实测带 2 / 3 / 6 个一律 429（静默 120s 后仍然如此），
 *      而逐个单发 18/18 成功、间隔 0s 也不会被限流。所以这里是串行逐个请求，
 *      并对偶发 429 做退避重试；失败就降级成「玩家XXXXXX」，绝不阻塞主流程。
 *      ★ 它还会返回 real_name / city / country 等隐私字段 —— 一律丢掉，不进报告。
 *      （昵称/头像**不走** ISteamUser/GetPlayerSummaries：那个接口只吃 Web API Key，
 *        带 access_token 直接 HTTP 400「Required parameter 'key' is missing」。）
 *
 *  [5] IFamilyGroupsService/* —— 家庭组三个接口，本工具的核心。
 *      ★要的是登录态的 OAuth access_token，Web API Key 不行★
 *      （带 Key 一律 401 —— 家庭组的三个接口只认 access_token，没有别的路。）
 *      · GetFamilyGroupForUser —— 家庭组 id + 成员名单（只有 steamid/role，没有昵称）
 *      · GetSharedLibraryApps  —— 共享库 + 每款游戏的 owner_steamids（自动归属）
 *      · GetPlaytimeSummary    —— 谁玩过哪款游戏、玩了多久（★POST + 显式 Content-Length★，
 *                                 缺了会 411，GET 会 405）
 *      token 由用户在 Steam 网页端自行取（F12 → application_config），本工具不代取、不落盘。
 *
 *  [6] store.steampowered.com / steamcommunity.com 在部分网络下不可达，
 *      而且浏览器直连会被 CORS 拦。所以价格统一走 [1]，
 *      所有请求都由 Node 自己发出，不依赖任何中转层。
 *
 *  ★ 全项目只用一种凭据：access_token（不需要 Web API Key）：
 *    家庭组三个接口只认 access_token，
 *    昵称/头像走 [2] 这条免密钥路径。
 */
'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API = 'https://api.steampowered.com';
const STORE = 'https://store.steampowered.com';
const COMMUNITY = 'https://steamcommunity.com';
const USER_AGENT = 'steam-family-contribution/1.0 (+local tool)';
const STEAM64_BASE = 76561197960265728n;

/** Steam 商店分类 id：62 = 家庭共享（store appdetails 的 categories 里直接写着 description:"家庭共享"，已确认） */
const CATEGORY_FAMILY_SHARING = 62;

/** api 域批量取价：一次带多少个 appid。实测 200 没问题，留余量用 100。 */
const PRICE_BATCH_SIZE = 100;

/** store 域 appdetails 一次只能查 1 个 appid（多传直接 HTTP 400），所以两次请求之间要限速 */
const STORE_REQUEST_DELAY = 350;

const DEFAULT_TIMEOUT = 20000;

/**
 * 区域级联顺序：国区 → 港区 → 新加坡 → 美区。
 * 国区没上架的游戏，按这个顺序找替代价。
 */
const REGIONS = [
  { cc: 'cn', currency: 'CNY', label: '国区' },
  { cc: 'hk', currency: 'HKD', label: '港区' },
  { cc: 'sg', currency: 'SGD', label: '新加坡' },
  { cc: 'us', currency: 'USD', label: '美区' }
];

/** 汇率接口挂掉时的兜底（1 单位外币 ≈ 多少人民币），仅作后备，正常走实时汇率 */
const FALLBACK_FX = { CNY: 1, HKD: 0.9, SGD: 5.3, USD: 7.1 };
const FX_URL = 'https://open.er-api.com/v6/latest/CNY';

/* ============================ 缓存目录 ============================
 * ★ 缓存一律落在**用户级缓存目录**，不落工程目录。
 *   理由很实在：昵称缓存里是组里成员的身份信息（steamid + 昵称 + 头像 URL）。
 *   它要是落在工程目录里，谁把整个项目目录打包发出去，就顺手把成员身份一起发了 ——
 *   落点在工程目录之外，「仓库目录」和「有个人数据的地方」才是彻底分开的，
 *   .gitignore 也退化成第二道保险而不是唯一防线。
 *   要换位置：设环境变量 STEAM_FAMILY_CACHE=<目录>。
 */
function cacheDir() {
  const override = String(process.env.STEAM_FAMILY_CACHE || '').trim();
  if (override) return path.resolve(override);
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches')
      : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'));
  return path.join(base, 'steam-family-contribution');
}

/** 缓存文件的完整路径（调用方只关心文件名，落点统一由 cacheDir() 决定） */
function cacheFile(name) { return path.join(cacheDir(), name); }

/**
 * 工程目录里不该出现缓存。跑一次就提醒一句：那份副本该删了 ——
 * 它里面可能真有别人的身份信息，而它待在仓库目录里这件事本身就是风险。
 */
function legacyCacheHint(projectDir) {
  const legacy = path.join(projectDir, '.cache');
  try {
    if (!fs.existsSync(legacy)) return '';
    const files = fs.readdirSync(legacy).filter((f) => /\.(json|html|log|txt)$/.test(f));
    if (!files.length) return '';
    return '发现项目目录里有一个 .cache/（' + files.length + ' 个文件，含成员昵称与头像）—— '
      + '缓存现在落在 ' + cacheDir() + '，不写在这里。建议手工删掉 .cache/，别把整个目录打包外发。';
  } catch (e) {
    return '';
  }
}

/* ============================ 代理支持 ============================ */
/*
 * Steam 在国内经常需要走代理，而 Node 的 fetch/http 默认不读 https_proxy。
 * 这里实现一个 CONNECT 隧道的 https.Agent，并且默认「直连优先、失败再走代理」，
 * 避免把本来直连能通的网络搞坏。设 STEAM_FORCE_DIRECT=1 可完全禁用代理。
 */

const agentCache = new Map();

function getProxyUrl(targetHost) {
  if (process.env.STEAM_FORCE_DIRECT === '1') return null;
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!raw) return null;

  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const rule of noProxy) {
    if (rule === '*') return null;
    const host = rule.replace(/^\*?\.?/, '').toLowerCase();
    if (host && (targetHost === host || targetHost.endsWith('.' + host))) return null;
  }
  return raw;
}

/**
 * 代理 URL 在上屏幕 / 进日志之前，先把凭据抹掉。
 *   `HTTPS_PROXY=http://<用户名>:<口令>@host:7890` 是很常见的写法，而这一行会被滚屏、
 *   被截图求助、被贴进 CI 日志 —— 用户名口令不该跟着出去。
 */
function redactProxyUrl(url) {
  return String(url == null ? '' : url).replace(/\/\/[^@/]*@/, '//***@');
}

/*
 * ★ 有意**不做**「自动探测本机代理端口」。
 *   探到的端口并不保证连得通 Steam（实测有机器直连一切正常、
 *   经本地 Clash 端口反而 ECONNRESET），而猜错的代价由用户承担、还看不见 ——
 *   不如不做。需要代理的人自己心里有数：开加速器（选覆盖 api 域的路由模式），
 *   或显式设 HTTPS_PROXY；想强制直连就设 STEAM_FORCE_DIRECT=1。
 */

/*
 * ★ 这个函数的 CONNECT 路径**不在离线测试范围内**：要真跑通得先起一个本地代理端口，
 *   而那会破坏「全离线」这条被测试钉着的承诺（也是刻意不做端口探测的原因之一）。
 *   它的正确性靠线上使用暴露，改动时请手工验一次走代理与走直连两条路。
 */
function makeProxyAgent(proxyUrl) {
  if (agentCache.has(proxyUrl)) return agentCache.get(proxyUrl);
  const p = new URL(proxyUrl);
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 4,
    // 关键：用 CONNECT 隧道替换默认的 TCP 建连
    createConnection(options, cb) {
      let settled = false;
      const done = (err, sock) => {
        if (settled) return;
        settled = true;
        cb(err, sock);
      };
      const host = options.host;
      const port = options.port || 443;
      const connectReq = http.request({
        host: p.hostname,
        port: p.port || (p.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT',
        path: `${host}:${port}`,
        headers: {
          Host: `${host}:${port}`,
          'Proxy-Connection': 'Keep-Alive',
          ...(p.username ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64') } : {})
        }
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          done(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
          return;
        }
        const tlsSocket = tls.connect({ socket, servername: host }, () => done(null, tlsSocket));
        tlsSocket.on('error', (e) => done(e));
      });
      connectReq.on('error', (e) => done(e));
      connectReq.end();
    }
  });
  agentCache.set(proxyUrl, agent);
  return agent;
}

/* ============================ HTTP ============================ */

/** 直连用的连接池：一次导入要发好几个请求，复用连接能省掉重复握手。 */
const directAgent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 15000 });

/**
 * 响应体硬上限：一批 100 个 appid 的返回也就几十 KB，8MB 已经宽松到不可能误伤。
 * 这条限制存在的唯一意义是 —— 中间层（加速器 / 杀软 / 企业代理）塞回来一大坨东西时，
 * 别让 `res.on('data')` 无脑往数组里堆，最后把内存吃光。
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * 墙钟总上限 = socket 空闲超时的倍数。
 * ★ 为什么不能只靠 `options.timeout`：那是「静默多久算死」，对端只要每隔几秒
 *   挤几个字节就能让它永远不触发 —— 慢速滴流能把进程吊住。所以另给一个
 *   从发起到结束的绝对上限。
 */
const TOTAL_TIMEOUT_FACTOR = 4;

/**
 * 把响应流读成字符串，并且**给响应体一个硬上限**。
 *
 * ★ 为什么单独抽成函数：上限这条只在「对端塞一大坨」时才生效，而离线测试里起不了
 *   真的 HTTPS 服务（自签证书不能进仓库，发布闸门会拦私钥头）。抽成纯函数之后，
 *   测试可以喂一个假的 EventEmitter 进来，把这条规则真正跑一遍。
 *
 * @param {import('http').IncomingMessage} res 响应流
 * @param {number} [maxBytes] 上限，默认 MAX_RESPONSE_BYTES
 */
function readBody(res, maxBytes) {
  const limit = maxBytes || MAX_RESPONSE_BYTES;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let done = false;
    res.on('data', (c) => {
      if (done) return;
      received += c.length;
      if (received > limit) {
        done = true;
        const err = new Error('响应体超过 ' + Math.round(limit / 1024) + 'KB 上限，已中止读取' +
          '（多半是中间层塞回来的东西，不是 Steam 的正常返回）');
        err.tooLarge = true;
        res.destroy();
        reject(err);
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    res.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

/** 发起一次请求，返回 {status, body}。支持直连与代理两条路，支持 GET / POST。 */
function httpRaw(url, { timeout = DEFAULT_TIMEOUT, viaAgent = null, method = 'GET', body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
    const payload = body == null ? '' : String(body);
    if (method !== 'GET') {
      // ★ Steam 的边缘节点（Akamai）要求 POST 必须带 Content-Length，
      // 否则直接回 411 Length Required —— 空 body 也要显式给 0。
      headers['Content-Length'] = Buffer.byteLength(payload);
      headers['Content-Type'] = contentType || 'application/x-www-form-urlencoded';
    }

    let req = null;
    let settled = false;
    function finish(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    }

    const totalMs = timeout * TOTAL_TIMEOUT_FACTOR;
    const deadline = setTimeout(() => {
      const err = new Error('请求超过总时限（' + Math.round(totalMs / 1000) + 's），已中止');
      err.timeout = true;
      if (req) req.destroy(err);
      finish(() => reject(err));
    }, totalMs);
    if (deadline.unref) deadline.unref();

    req = https.request(url, {
      method,
      headers,
      agent: viaAgent || directAgent,
      timeout
    }, (res) => {
      readBody(res).then(
        (text) => finish(() => resolve({ status: res.statusCode, body: text })),
        (e) => { if (req) req.destroy(e); finish(() => reject(e)); }
      );
    });
    req.on('timeout', () => req.destroy(new Error('请求超时（' + timeout + 'ms）')));
    req.on('error', (e) => finish(() => reject(e)));
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把「来自远端、准备写进日志或错误消息」的文本洗一遍。
 *
 * ★ 为什么必须有这一道：错误正文来自对端 —— 可能是中间层（加速器 / 杀软 / 企业代理）
 *   回的一页 HTML，而它完全可能把**请求 URL 回显出来**；家庭组那几个接口的 URL 上
 *   就带着 access_token。这段文本会进 warnings，warnings 又会被内联进要转发的报告。
 *   所以统一在这里：① 剥 ANSI 转义与其它控制字符（远端文本能把终端刷花、也能污染产物）
 *   ② 抹掉三类**具体的**凭据形态：`key=<值>`（键名限 access_token / token / api_key /
 *      apikey / password / passwd / secret）、JWT 形态、32 位十六进制；③ 截断。
 *
 * ★ 如实写明它**覆盖到哪**，别把它当成「凡是凭据都能抹掉」：
 *   · 百分号编码过的形态（`access_token%3D<值>`）不匹配；
 *   · `Bearer <值>` 这种没有 `=` 的写法不匹配；
 *   · 又短、又不属于上述三种形态的裸串不匹配。
 *   这三种只有少数中间层才会回显，而且影响面仅限**使用者自己的终端** ——
 *   报告产物本来就不含 warnings（有另一道在 `stripForReport` 里）。所以这里选择
 *   把边界写清楚，而不是把正则放宽：放宽会带来误伤，而它的定位只是兜底。
 *
 * ★ 它是「兜底」，不是许可证：调用方仍然不该把凭据拼进消息里。
 */
function redactText(s, max = 160) {
  return String(s == null ? '' : s)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')                      // ANSI CSI 序列
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ') // 其余 C0 控制字符
    .replace(/\b(access_token|token|api_?key|apikey|password|passwd|secret)=([^&\s"'<>]{1,300})/gi, '$1=***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]{8,}/g, '***')    // JWT 形态
    .replace(/\b[0-9a-f]{32}\b/gi, '***')                            // 32 位 hex（API Key 形态）
    .slice(0, max);
}

/** 单次请求，成功返回解析后的对象；网络层失败抛带 network 标记的错误。 */
async function requestOnce(url, { timeout = DEFAULT_TIMEOUT, agent = null, label = '', method = 'GET', body = null } = {}) {
  let r;
  try {
    r = await httpRaw(url, { timeout, viaAgent: agent, method, body });
  } catch (e) {
    const msg = e.message || e.code || '未知网络错误';
    const err = new Error(label + msg);
    err.network = true;
    throw err;
  }
  if (r.status === 401 || r.status === 403) {
    // ★ 文案不要再提 API Key：本项目只用 access_token。
    //   到底是「过期」还是「被轮换作废」，由调用方按接口语义补充（见 tokenRejectedMessage）。
    const err = new Error('Steam 拒绝了请求（HTTP ' + r.status + '）：凭据无效、已失效或权限不足。');
    err.status = r.status;
    throw err;
  }
  if (r.status === 429) {
    const err = new Error('请求过于频繁（HTTP 429），稍后会自动重试。');
    err.status = 429;
    err.network = true;   // 属于可重试的范畴
    throw err;
  }
  if (r.status < 200 || r.status >= 300) {
    const err = new Error('Steam 返回 HTTP ' + r.status);
    err.status = r.status;
    throw err;
  }
  try {
    return JSON.parse(r.body);
  } catch (e) {
    throw new Error('Steam 返回了非 JSON 内容（可能被网络中间层拦截）：' + redactText(r.body, 120));
  }
}

/**
 * GET JSON，带完整的容错：
 *   - 直连优先，失败自动改走代理（可用 proxy:'direct'|'proxy' 强制）
 *   - 网络类错误按路由各重试 retries 次，指数退避
 *   - 失败时把所有尝试的错误都列出来，便于判断是网络问题还是配置问题
 * 一次导入要发几十个请求，没有重试纯属碰运气。
 */
async function getJSON(url, { timeout = DEFAULT_TIMEOUT, proxy, retries = 2, method = 'GET', body = null } = {}) {
  const mode = proxy || 'auto';
  const proxyUrl = getProxyUrl(new URL(url).hostname);

  const routes = [];
  if (mode === 'direct' || !proxyUrl) routes.push([null, '直连']);
  else if (mode === 'proxy') routes.push([makeProxyAgent(proxyUrl), '经代理']);
  else routes.push([null, '直连'], [makeProxyAgent(proxyUrl), '经代理']);

  const failures = [];
  for (const [agent, label] of routes) {
    for (let i = 0; i <= retries; i++) {
      try {
        return await requestOnce(url, { timeout, agent, label: label + ' ', method, body });
      } catch (e) {
        if (!e.network) throw e;   // 业务错误（Key 无效等）重试无意义
        failures.push(label + (retries > 0 ? '第' + (i + 1) + '次' : '') + '：' + e.message);
        if (i < retries) await sleep(500 * (i + 1));
      }
    }
  }
  const err = new Error('连接 Steam 失败。' + failures.join('；') +
    '（如果是网络受限环境，可设置 HTTPS_PROXY 环境变量后重试）');
  err.network = true;
  throw err;
}

/* ============================ steamid 工具 ============================ */

/**
 * 把各种形式的 SteamID 解析成统一形式。
 * 支持：steamid64 / [U:1:ACCOUNTID] / STEAM_x:y:z / 个人资料链接 / 自定义链接名
 * @returns {{type:'steamid64',steamid64:string}|{type:'vanity',vanity:string}|null}
 */
function parseSteamId(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return null;

  if (/^\d{17}$/.test(s)) return { type: 'steamid64', steamid64: s };

  const u = s.match(/^\[?U:1:(\d+)\]?$/i);
  if (u) return { type: 'steamid64', steamid64: (STEAM64_BASE + BigInt(u[1])).toString() };

  const s0 = s.match(/^STEAM_(\d):(\d):(\d+)$/i);
  if (s0) {
    const accountId = BigInt(s0[3]) * 2n + BigInt(s0[2]);
    return { type: 'steamid64', steamid64: (STEAM64_BASE + accountId).toString() };
  }

  const mProfile = s.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (mProfile) return { type: 'steamid64', steamid64: mProfile[1] };

  const mVanity = s.match(/steamcommunity\.com\/id\/([^/?#\s]+)/i);
  if (mVanity) return { type: 'vanity', vanity: decodeURIComponent(mVanity[1]) };

  if (/^[A-Za-z0-9_-]{2,64}$/.test(s)) return { type: 'vanity', vanity: s };

  return null;
}

/** 是否看起来就是 steamid64 */
function isSteamId64(s) {
  return /^\d{17}$/.test(String(s || '').trim());
}

/** steamid64 -> 32 位账号 id（展示用户永久链接用） */
function steamId64ToAccountId(steamid64) {
  try {
    return (BigInt(steamid64) - STEAM64_BASE).toString();
  } catch (e) {
    return null;
  }
}

/** 由 32 位账号 id 生成 steamid64 */
function accountIdToSteamId64(accountId) {
  return (STEAM64_BASE + BigInt(accountId)).toString();
}

/* ============================ 磁盘缓存 ============================ */

/**
 * 极简 JSON 文件缓存。
 * ★ 现在只用来缓存**公开数据**：成员昵称/头像（那个接口有 IP 级限流，值得缓存）
 *   与价格数据源结论、汇率。
 *   ★ 价格本身不缓存 ★ —— 本项目是一次性脚本，每次执行都现查，
 *   报告里的价就该是运行那一刻的价（详见 steam-family.js 顶部注释）。
 * @returns {{get(key):any|undefined, set(key,val):void, flush():void}}
 */
/**
 * 缓存一律 0700 目录 + 0600 文件。
 *   里面是别人的昵称与 SteamID，多用户机器上不该同组其他账号可读。
 *   （Windows 上 mode 基本被 ACL 说了算，这里主要是给 macOS / Linux 上的人负责。）
 */
function writeCacheFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
}

function createCache(file, ttlMs, maxEntries = 0) {
  let data = {};
  let dirty = false;
  try {
    if (file && fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) {
    data = {};
  }
  const now = () => Date.now();
  let flushTimer = null;

  /**
   * 超过上限就淘汰最旧的一批。
   * 为什么需要：每个人的家庭组都会带进他们自己的游戏，缓存只增不减的话，
   * 用的人越多文件越大。淘汰按写入时间（e.t）排序，把老的先扔掉。
   */
  function evictIfNeeded() {
    if (!maxEntries || maxEntries <= 0) return;
    const keys = Object.keys(data);
    if (keys.length <= maxEntries) return;
    keys.sort((a, b) => (data[a].t || 0) - (data[b].t || 0));
    const drop = keys.length - maxEntries;
    for (let i = 0; i < drop; i += 1) delete data[keys[i]];
  }

  function scheduleFlush() {
    if (!file || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        writeCacheFile(file, JSON.stringify(data));
      } catch (e) { /* 缓存写失败不影响主流程 */ }
    }, 800).unref?.();
  }

  return {
    get(key) {
      const e = data[key];
      if (!e) return undefined;
      if (ttlMs > 0 && now() - e.t > ttlMs) return undefined;
      return e.d;
    },
    set(key, val) {
      data[key] = { t: now(), d: val };
      dirty = true;
      evictIfNeeded();
      scheduleFlush();
    },
    /** 同步落盘，进程退出前调用 */
    flush() {
      if (!file || !dirty) return;
      try {
        writeCacheFile(file, JSON.stringify(data));
        dirty = false;
      } catch (e) { /* ignore */ }
    },
    get size() { return Object.keys(data).length; }
  };
}

/* ============================ Steam 接口 ============================ */

/* -------- 昵称 / 头像：免密钥路径（steamcommunity ajaxresolveusers） -------- */
/*
 * ★ 为什么不用 ISteamUser/GetPlayerSummaries：那个接口**只吃 Web API Key** ——
 *   实测带 access_token 调它直接 HTTP 400「Required parameter 'key' is missing」。
 *   本项目的原则是「用户只准备一个 access_token」，所以昵称/头像改走这条免密钥路径：
 *
 *     https://steamcommunity.com/actions/ajaxresolveusers?steamids=<单个 id>
 *
 * 实测（不带任何凭据）：
 *   · 一次带多个 id → 一律 429（chunk=2 / 3 / 6 都如此，静默 120s 后仍然 429）；
 *   · 一次只带一个 id → 18/18 成功，间隔 0s 也不会被限流；
 *   · 但密集连打仍会偶发 429（body 是字符串 null），所以要退避重试。
 * 结论：逐个串行请求 + 429 退避；拿不到就降级成「玩家XXXXXX」，绝不阻塞主流程。
 */

/** 头像 CDN：ajaxresolveusers 只返回 hash，域名要自己拼。 */
const AVATAR_CDN = 'https://avatars.steamstatic.com';

/** hash -> 头像 URL。kind: 'medium' | 'full' */
function avatarUrlFromHash(hash, kind) {
  const h = String(hash == null ? '' : hash).trim();
  // ★ 只认十六进制：这个值来自 Steam 的返回，正常永远是 40 位 sha1。
  //   但报告是要**发给别人**的，而它最终会变成一个 <img src> ——
  //   所以别给「拼进去一个 ../、?x=、或跨域域名」留任何缝隙；不匹配就当没有头像。
  if (!/^[0-9a-f]{6,64}$/i.test(h)) return '';
  return `${AVATAR_CDN}/${h}${kind === 'full' ? '_full' : '_medium'}.jpg`;
}

/**
 * ajaxresolveusers 返回的 profile_url 是「自定义链接名」而不是完整 URL
 * （实测形如 "somevanity"），为空就得退回 /profiles/<steamid>。
 */
function profileUrlOf(steamid, vanity) {
  const v = String(vanity || '').trim();
  if (v && !/^\d+$/.test(v)) return `${COMMUNITY}/id/${encodeURIComponent(v)}`;
  return `${COMMUNITY}/profiles/${encodeURIComponent(steamid)}`;
}

/**
 * 把 ajaxresolveusers 的一条记录归一化成项目内部形状。
 * ★ 它还会返回 real_name / city / state / country / is_friend 等字段 ——
 *   一律丢掉，只留报告用得上的几项。别人的真实姓名没理由被写进一份会到处转发的 HTML。
 * @returns {{steamid,name,avatar,avatarFull,profileUrl,state}|null}
 */
function mapResolvedUser(raw) {
  if (!raw || !isSteamId64(String(raw.steamid || ''))) return null;
  const steamid = String(raw.steamid);
  return {
    steamid,
    name: String(raw.persona_name || '').trim(),
    avatar: avatarUrlFromHash(raw.avatar_url, 'medium'),
    avatarFull: avatarUrlFromHash(raw.avatar_url, 'full'),
    profileUrl: profileUrlOf(steamid, raw.profile_url),
    state: raw.persona_state
  };
}

/**
 * 逐个解析昵称 / 头像（免密钥）。
 *
 * ★ 永不抛错：这是「锦上添花」的数据，读不到只是成员显示成「玩家XXXXXX」，
 *   价格、归属、计分一项都不受影响 —— 所以任何失败都吞掉，返回已拿到的那部分。
 *
 * @param {string[]} steamids
 * @param {object} [o]
 * @param {object} [o.cache]       可选缓存（createCache 的返回值）；昵称很少变，缓存能省掉重复请求
 * @param {number} [o.retries]     单个 id 的重试次数（默认 2，只对 429 / 网络错生效）
 * @param {function} [o.injectHttp] 测试注入点：替代真实请求，(url) => Promise<json>
 * @param {function} [o.injectSleep] 测试注入点：替代真实等待，(ms) => Promise<void>
 * @returns {Promise<Array<{steamid,name,avatar,avatarFull,profileUrl,state}>>}
 */
async function resolveUserProfiles(steamids, { cache = null, retries = 2, injectHttp = null, injectSleep = null, timeout = 15000 } = {}) {
  const ids = [...new Set([].concat(steamids || []).map((s) => String(s).trim()).filter(isSteamId64))];
  if (!ids.length) return [];
  const wait = injectSleep || sleep;
  const out = [];

  for (const id of ids) {
    const cacheKey = 'user_' + id;
    const hit = cache && cache.get(cacheKey);
    if (hit) { out.push(hit); continue; }

    let mapped = null;
    for (let attempt = 0; attempt <= retries && !mapped; attempt += 1) {
      // 429 退避：1s → 4s。指数是为了给 Steam 的限流窗口留够时间，
      // 但又不能无限等 —— 昵称不值得让用户干等半分钟。
      if (attempt) await wait(1000 * attempt * attempt);
      try {
        const url = `${COMMUNITY}/actions/ajaxresolveusers?steamids=${encodeURIComponent(id)}`;
        const j = injectHttp ? await injectHttp(url) : await getJSON(url, { timeout, retries: 0 });
        mapped = mapResolvedUser(Array.isArray(j) ? j[0] : null);
      } catch (e) {
        // 只有 429（限流）和网络抖动值得重试；其余（404 等）重试无意义
        const retryable = !e || e.status === 429 || e.network === true;
        if (!retryable) break;
      }
    }
    if (mapped) {
      out.push(mapped);
      if (cache) cache.set(cacheKey, mapped);
    }
  }
  return out;
}

/* -------- 价格 + 可共享判定 -------- */

/**
 * 取出一个购买选项的「无折扣原价」（分）。
 * 三种形态字段名不同，必须分别处理：
 *   - 普通 app 包：original_price_in_cents / discount_pct
 *   - 捆绑包：    price_before_bundle_discount / bundle_discount_pct
 *   - 不打折：    没有 original 字段，现价即原价
 */
function optionOriginalCents(o) {
  if (!o) return 0;
  const finalCents = Number(o.final_price_in_cents || 0) || 0;
  if (o.original_price_in_cents) return Number(o.original_price_in_cents) || 0;
  if (o.price_before_bundle_discount) return Number(o.price_before_bundle_discount) || 0;
  const disc = Number(o.discount_pct || o.bundle_discount_pct || 0);
  if (disc > 0) {
    // 极少数情况打折却没给原价，按折扣率反推。
    // 这个工具的核心就是「按原价算」，把折扣价当原价会系统性低估贡献。
    return Math.round(finalCents / (1 - disc / 100));
  }
  return finalCents;
}

/**
 * 从 purchase_options 里挑出「游戏本体」的购买选项。
 *
 * ★ 不能直接用 best_purchase_option：
 *   实测《全面战争：三国》的 best 是「Warlord Edition 捆绑包」¥109.48
 *   （66% 的 bundle 折扣），而本体其实是 ¥198。
 *   拿捆绑包价当原价，会系统性低估这类游戏的贡献。
 *
 * 所以：先剔除捆绑包（只有 bundleid、没有 packageid 的就是 bundle），
 *      再优先保留「只含 1 款游戏」的选项，最后取最便宜的 ——
 *      也就是「要拥有这款游戏的最低门槛」。
 */
function pickBasePurchaseOption(item) {
  const opts = Array.isArray(item.purchase_options) ? item.purchase_options : [];
  const best = item.best_purchase_option || null;

  let cands = opts.filter((o) => o && o.packageid);
  if (cands.length) {
    const single = cands.filter((o) => Number(o.included_game_count) === 1);
    if (single.length) cands = single;
  }
  if (!cands.length) cands = best ? [best] : [];
  if (!cands.length) return null;

  return cands.reduce((min, o) =>
    (Number(o.final_price_in_cents || 0) < Number(min.final_price_in_cents || 0) ? o : min), cands[0]);
}

/**
 * 把一个 store_item 归一化成我们关心的字段。
 * 这里集中处理所有「Steam 字段含义」的判断，便于单测。
 */
function mapStoreItem(item) {
  if (!item) return null;
  const feat = (item.categories && item.categories.feature_categoryids) || [];
  const isFree = item.is_free === true;
  const picked = pickBasePurchaseOption(item);

  let finalCents = picked ? Number(picked.final_price_in_cents || 0) || 0 : 0;
  let originalCents = optionOriginalCents(picked);

  // 免费游戏优先：免费游戏也可能挂着可购买的附加内容
  // （例如 CS2 的「优先状态升级」¥103），那不是游戏本体的价格，必须归零。
  if (isFree) {
    finalCents = 0;
    originalCents = 0;
  }

  const discountPct = (!isFree && picked) ? Number(picked.discount_pct || 0) || 0 : 0;

  let priceState;
  if (isFree) priceState = 'free';                     // 免费游戏
  else if (!picked) priceState = 'unavailable';        // 国区无售价（区域不可售 / 未上架）
  else priceState = 'priced';

  // 列出其它版本，界面上可切换（本体 / 豪华版 / 完全版…）
  const alternatives = (Array.isArray(item.purchase_options) ? item.purchase_options : [])
    .filter((o) => o && o.packageid)
    .map((o) => ({
      packageId: o.packageid,
      name: o.purchase_option_name || '',
      originalCents: optionOriginalCents(o),
      finalCents: Number(o.final_price_in_cents || 0) || 0,
      discountPct: Number(o.discount_pct || 0) || 0
    }))
    .filter((o, i, arr) => arr.findIndex((x) => x.packageId === o.packageId) === i)
    .sort((a, b) => a.originalCents - b.originalCents)
    .slice(0, 8);

  return {
    appid: item.appid || item.id || 0,
    name: item.name || '',
    type: item.type,
    // 分类 62 = 支持 Steam 家庭共享
    shareable: feat.indexOf(CATEGORY_FAMILY_SHARING) >= 0,
    isFree,
    priceState,
    originalCents,
    finalCents,
    discountPct,
    currency: 'CNY',
    // 价格取自哪个版本，界面上显示出来，免得用户不知道钱是按哪版算的
    packageId: picked ? picked.packageid : null,
    packageName: picked ? (picked.purchase_option_name || '') : '',
    alternatives,
    storeUrlPath: item.store_url_path || '',
    unlisted: item.unlisted === true
  };
}

/** 批量取指定区域的价格与可共享标记（api 域，免 API Key）。命中缓存的不重复请求。 */
async function getStoreItems(appids, { cache = null, opts = {}, onProgress = null, batchSize = PRICE_BATCH_SIZE, region = REGIONS[0], stats = null } = {}) {
  const uniq = [...new Set([].concat(appids).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const result = {};
  const missing = [];
  const cacheKey = (id) => 'app_' + region.cc + '_' + id;

  uniq.forEach((id) => {
    const hit = cache && cache.get(cacheKey(id));
    if (hit) result[id] = hit;
    else missing.push(id);
  });

  // 告诉调用方这一批里有多少是缓存里就有的、多少要实时去 Steam 拿
  if (stats) {
    stats.asked = (stats.asked || 0) + uniq.length;
    stats.hits = (stats.hits || 0) + (uniq.length - missing.length);
    stats.fetched = (stats.fetched || 0) + missing.length;
  }

  let done = 0;
  for (let i = 0; i < missing.length; i += batchSize) {
    const chunk = missing.slice(i, i + batchSize);
    const input = JSON.stringify({
      ids: chunk.map((appid) => ({ appid })),
      context: { language: 'schinese', country_code: region.cc.toUpperCase(), currency: region.currency },
      data_request: { include_all_purchase_options: true, include_basic_info: true }
    });
    const j = await getJSON(`${API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(input)}`, opts);
    const items = (j && j.response && j.response.store_items) || [];
    items.forEach((item) => {
      const mapped = mapStoreItem(item);
      if (!mapped || !mapped.appid) return;   // appid = 0 表示这个 appid 无效
      mapped.region = region.cc;
      mapped.regionLabel = region.label;
      mapped.source = 'api';
      result[mapped.appid] = mapped;
      if (cache) cache.set(cacheKey(mapped.appid), mapped);
    });
    done += chunk.length;
    if (onProgress) onProgress(done, missing.length);
    // 温和限速，避免被 Steam 判为异常流量
    if (i + batchSize < missing.length) await sleep(250);
  }

  // 没查到的补一个占位，避免调用方拿到 undefined
  uniq.forEach((id) => {
    if (!result[id]) {
      result[id] = {
        appid: id, name: '', shareable: false, isFree: false, priceState: 'unknown',
        originalCents: 0, finalCents: 0, discountPct: 0,
        region: region.cc, regionLabel: region.label, source: 'api'
      };
    }
  });

  return result;
}

/* ============================ 汇率 ============================ */

/**
 * 取「1 单位外币 = 多少人民币」。
 * 跨区取价必须换算，否则港区 HK$479 和美区 $59.99 没法放在一起比。
 */
async function getExchangeRates({ cache = null, opts = {} } = {}) {
  const hit = cache && cache.get('fx_cny');
  if (hit) return hit;

  let rates = null;
  try {
    const j = await getJSON(FX_URL, opts);
    if (j && j.result === 'success' && j.rates) {
      rates = { CNY: 1 };
      ['HKD', 'SGD', 'USD'].forEach((c) => {
        if (j.rates[c]) rates[c] = 1 / j.rates[c];
      });
      rates.updatedAt = j.time_last_update_utc || '';
      rates.source = 'live';
    }
  } catch (e) { /* 落到兜底汇率 */ }

  if (!rates) rates = Object.assign({ updatedAt: '', source: 'fallback' }, FALLBACK_FX);
  if (cache) cache.set('fx_cny', rates);
  return rates;
}

/** 把某区域货币的「分」换算成人民币元 */
function toCnyYuan(cents, currency, rates) {
  const r = (rates && rates[currency]) || FALLBACK_FX[currency] || 1;
  return Math.round((Number(cents || 0) / 100) * r * 100) / 100;
}

/* ============================ 家庭组 ============================ */

function requireToken(token) {
  if (!token || !String(token).trim()) {
    const e = new Error(
      '这个操作需要 Steam access_token（不是 Web API Key）。' +
      '打开 https://store.steampowered.com/account/familymanagement/ （家庭组管理页，能看到组员＝已登录），按 F12：' +
      'Network 标签里 Ctrl+F 搜 access_token，从某条请求的 Request URL 里复制那串值；' +
      '或 Console 标签里执行 copy(JSON.parse(application_config.dataset.loyalty_webapi_token)) 直接进剪贴板。'
    );
    e.code = 'NO_ACCESS_TOKEN';
    throw e;
  }
  return String(token).trim();
}

/**
 * 401 的可操作解释 —— ★排查顺序：先看「有没有刷新过 Steam 页面」，再看「是不是过期」★
 *
 * 实测（本机真机对照）：store 页面每次加载都会换发一枚新 token（新 jti），
 * 旧的那枚**立刻作废**，哪怕 exp 还剩好几个小时。
 * 同一分钟、同一网络下：旧 token 401、新 token 200；两枚 exp 都没到，
 * 而且两枚的 ip_subject 都与脚本出口 IP 不一致 —— 所以既不是「过期」，
 * 也不是「token 绑 IP」（ip_subject 不需要匹配调用方出口），就是被轮换掉了。
 */
function tokenRejectedMessage(detail) {
  return 'Steam 拒绝了 access_token（HTTP 401）。' +
    '最常见的原因不是过期，而是取完 token 后又刷新/打开过 Steam 网页 —— ' +
    'store 页面每次加载都会换发新 token，旧的那枚立即作废（哪怕还没到期）。' +
    '请重新取一次：刷新家庭组管理页 https://store.steampowered.com/account/familymanagement/ → F12 → ' +
    'Network 标签 Ctrl+F 搜 access_token，从 Request URL 里复制那串值' +
    '（或 Console 标签执行 copy(JSON.parse(application_config.dataset.loyalty_webapi_token)) 直接进剪贴板），' +
    '取完直接回来跑，中途别再刷新任何 Steam 页面。' +
    '（其次才是过期：token 寿命约 24 小时。）' +
    (detail ? '（' + redactText(detail, 120) + '）' : '');
}

/**
 * 拿当前登录账号所属的家庭组。
 *
 * ★ 只要 access_token，不接受也不需要 Web API Key ★
 *   家庭组是账号级私密数据：Key 调这些接口一律 401（实测），而且
 *   IFamilyGroupsService 根本不在无密钥 GetSupportedAPIList 返回的 27 个公开接口里。
 *
 * 两类失败必须分清，别混成一句话：
 *   - HTTP 401                   → TOKEN_REJECTED（多半是被轮换作废，见 tokenRejectedMessage）
 *   - is_not_member_of_any_group → NOT_IN_FAMILY_GROUP（token 是好的，这个账号确实没加家庭组）
 */
async function getFamilyGroupForUser(accessToken, opts) {
  const t = requireToken(accessToken);
  const url = `${API}/IFamilyGroupsService/GetFamilyGroupForUser/v1/` +
    `?access_token=${encodeURIComponent(t)}&include_family_group_response=true`;

  let j;
  try {
    j = await getJSON(url, opts);
  } catch (e) {
    if (e && e.status === 401) {
      const err = new Error(tokenRejectedMessage(e.message));
      err.code = 'TOKEN_REJECTED';
      err.status = 401;
      throw err;
    }
    throw e;
  }

  const r = (j && j.response) || {};
  const group = r.family_group || r.family_group_response || null;
  const groupId = String(
    r.family_groupid || (group && (group.family_groupid || group.family_group_id)) || ''
  ).trim();

  // ★ Steam 会明确说「这个账号不在任何家庭组里」—— 别再和 token 失效混为一谈
  if (!groupId && r.is_not_member_of_any_group) {
    const e = new Error('这个账号没有加入任何 Steam 家庭组（Steam 返回 is_not_member_of_any_group=true）。' +
      'token 本身是有效的 —— 换组里其他人的 token 就能读到。');
    e.code = 'NOT_IN_FAMILY_GROUP';
    throw e;
  }

  if (!groupId) {
    const e = new Error('没读到家庭组，但 Steam 也没说「不在任何组里」。' +
      '可能是 access_token 已失效，或者这个接口的返回结构变了 —— 先重新取一次 token 再试。');
    e.code = 'NO_FAMILY_GROUP';
    throw e;
  }
  return { familyGroupId: groupId, group };
}

/** 从 group.members 提取成员 id */
function extractFamilyMembers(group) {
  const out = [];
  const seen = {};
  ((group && group.members) || []).forEach((m) => {
    const id = String(m.steamid || m.steam_id || '').trim();
    if (!isSteamId64(id) || seen[id]) return;
    seen[id] = true;
    out.push({ steamid: id, role: m.role });
  });
  return out;
}

/**
 * ★ 核心接口 ★ 返回家庭组共享库里每个 app 及其拥有者。
 * 一次调用就能拿到「游戏 + 归属」，不需要逐个成员去拉 GetOwnedGames，
 * 也不用再让用户手动勾选谁拥有哪款游戏。
 */
async function getSharedLibraryApps(accessToken, familyGroupId, opts) {
  const t = requireToken(accessToken);
  const url = `${API}/IFamilyGroupsService/GetSharedLibraryApps/v1/` +
    `?access_token=${encodeURIComponent(t)}&family_groupid=${encodeURIComponent(familyGroupId)}` +
    `&include_own=true&include_excluded=false&include_non_games=false`;
  const j = await getJSON(url, opts);
  const apps = (j && j.response && j.response.apps) || [];

  return apps
    // exclude_reason 非 0 表示这款游戏在家庭里被排除，不该算进来
    .filter((a) => a.exclude_reason === undefined || a.exclude_reason === 0)
    .map((a) => ({
      appid: Number(a.appid),
      // 家庭组接口本身就带游戏名（实测 1424/1424 都有），
      // 拿它当兜底：价格接口挂了也不会出现一堆「appid 12345」。
      name: a.name || '',
      ownerSteamIds: (a.owner_steamids || []).map(String).filter(isSteamId64),
      playtimeForever: Number(a.playtime_forever || a.rt_playtime || 0),
      appType: a.app_type,
      excludeReason: a.exclude_reason || 0
    }))
    .filter((a) => Number.isInteger(a.appid) && a.appid > 0);
}

/**
 * ★ 取家庭组共享库的**游玩记录** —— 回答「谁玩了谁的什么」。
 *
 * 「我的游戏有没有被别人玩过」只能从这里拿到：
 *   - GetOwnedGames 只含自己拥有的游戏，别人通过共享玩的**不在其库里**；
 *   - GetSharedLibraryApps 的 rt_playtime 是单数语义（请求者视角），没有分人粒度。
 *
 * 改这个函数前先读这两条：
 *   1. 它**必须用 POST** —— GET 会返回 405 Method Not Allowed；
 *   2. POST **必须带 Content-Length**，空 body 也要显式给 0，
 *      否则 Akamai 边缘节点直接回 411 Length Required。
 *
 * 这是 Steam 的未公开接口（Xpaw 标为 UNDOCUMENTED），有被改动/下线的风险，
 * 所以调用方必须能接受它失败并降级，不能把计分硬绑在它上面。
 *
 * @returns {Map<number, Map<string, number>>} appid -> (steamid -> 游玩秒数)
 *          ★ 时长要留着：计分只看「玩没玩过」，但页面上要展示「谁玩了多久」。
 */
async function getPlaytimeSummary(accessToken, familyGroupId, opts) {
  const t = requireToken(accessToken);
  const gid = String(familyGroupId == null ? '' : familyGroupId).trim();
  if (!gid) throw new Error('缺少 family_groupid，无法读取游玩记录。');

  const url = `${API}/IFamilyGroupsService/GetPlaytimeSummary/v1/` +
    `?access_token=${encodeURIComponent(t)}&family_groupid=${encodeURIComponent(gid)}`;
  const j = await getJSON(url, Object.assign({ method: 'POST', body: '' }, opts || {}));
  const entries = (j && j.response && j.response.entries) || [];

  const byApp = new Map();
  entries.forEach((e) => {
    const appid = Number(e.appid);
    const steamid = String(e.steamid == null ? '' : e.steamid);
    if (!Number.isInteger(appid) || appid <= 0) return;
    if (!isSteamId64(steamid)) return;
    // ★ 条目存在就算「玩过」：不设时长门槛（0 分钟也算）。
    if (!byApp.has(appid)) byApp.set(appid, new Map());
    const byUser = byApp.get(appid);
    const secs = Math.max(0, Number(e.seconds_played) || 0);
    // 同一人可能有多条记录，取较大值
    byUser.set(steamid, Math.max(byUser.get(steamid) || 0, secs));
  });
  return byApp;
}

/* ------------------------ api 域可达性探测 ------------------------ */
/*
 * 为什么家庭组读不了 = 为什么「价格能查、家庭组却超时」会让人困惑：
 *
 *   价格接口（IStoreBrowseService / appdetails）有双数据源，api 域挂了会自动
 *   降级到 store 域逐个取价；但家庭组三个接口（IFamilyGroupsService/*）只
 *   部署在 api.steampowered.com，store 域**根本没有这条路径**可降级。
 *
 * 所以一个常见现场是：用户开了只代理 store 域的加速器（或干脆没开代理），
 * 价格照常查得到，但「正在读取家庭组…」会一直挂到直连+代理的重试全部跑完
 * （可达一两分钟）才报一个笼统的网络错。用户根本不知道卡在哪。
 *
 * 这里的做法：读家庭组前先用一个无 token 的探测请求问一次 ——
 *   401/403 = 域名可达（接口在，只是没带凭据）；网络错 = 域名不可达。
 * 不可达就立刻抛出一条**专属于 api 域**的可操作提示，把「store 域能取价、
 * api 域读家庭组」这件事说清楚，并指明加速器/HTTPS_PROXY 的方向。
 *
 * 探测路由「有代理就先试代理、不通再试直连兜底」——既不白等注定失败的直连，
 * 也不会因为代理此刻抽风就误判「不可达」而把整条读家庭组中止。
 */

/** 探测请求的超时：不可达时这就是用户等待的上限，要短。 */
const FAMILY_PROBE_TIMEOUT = 8000;

/** api 域不可达时的可操作提示。抽成纯函数便于单测锁住文案（这条提示是 UX 关键）。 */
function familyUnreachableMessage(detail) {
  return '连不上 api.steampowered.com：读家庭组必须能连通这个域名' +
    '（IFamilyGroupsService 只在 api 域，store 域降级只覆盖价格、救不了家庭组）。' +
    '请确认加速器/代理覆盖了 api.steampowered.com —— 国内很多加速器只代理 store 域不代理 api 域；' +
    '设 HTTPS_PROXY 环境变量后重试。' +
    '（' + redactText(detail, 120) + '）';
}

/**
 * 读家庭组前快速探一次 api.steampowered.com 是否可达。不可达立刻抛可操作的错。
 * 可达（拿到 HTTP 响应，如 401/403）则静默返回，交给后续正式调用。
 *
 * 路由顺序：有代理就先试代理（最可能通的那条），不通再试直连兜底；没代理就只试直连。
 * —— 既避免「直连注定失败时白等一遍超时把探测拖慢」，又保留兜底，
 *   不会因为代理此刻抽风就误判「不可达」而把整条读家庭组中止。
 */
async function probeFamilySource(opts) {
  const probeUrl = `${API}/IFamilyGroupsService/GetFamilyGroupForUser/v1/`;
  const base = Object.assign({ timeout: FAMILY_PROBE_TIMEOUT, retries: 0 }, opts || {});
  // 调用方显式指定了 proxy 就只走那一条；否则按「代理优先 + 直连兜底」
  const proxyUrl = getProxyUrl('api.steampowered.com');
  const routes = base.proxy ? [base.proxy]
    : (proxyUrl ? ['proxy', 'direct'] : ['direct']);
  let lastErr = null;
  for (const route of routes) {
    try {
      await getJSON(probeUrl, Object.assign({}, base, { proxy: route }));
      return;                       // 拿到 2xx = 可达
    } catch (e) {
      if (!e.network) return;        // 401/403 = 域名可达（接口在），继续走正式流程
      lastErr = e;                   // 网络错：试下一条路由
    }
  }
  const err = new Error(familyUnreachableMessage(lastErr ? lastErr.message : ''));
  err.network = true;
  err.code = 'API_DOMAIN_UNREACHABLE';
  throw err;
}

/**
 * 一站式读家庭组：成员 + 游戏归属 + **游玩记录** + 昵称头像。
 * ★ 全程只用 access_token，不需要任何 Web API Key ★
 *   家庭组接口只给 steamid，昵称头像走免密钥的 ajaxresolveusers（见 resolveUserProfiles）。
 *
 * 计分口径是「按被别人实际玩过」，所以 playedBy 是必需品：
 * 拿到就挂到每款游戏上；拿不到就留空 —— 引擎会把它们当「没人玩过」计 0 分，
 * 绝不偷偷退回按拥有计分。playtimeAvailable 负责把这件事告诉上层。
 *
 * @param {string} accessToken
 * @param {object} [opts] 透传给各次请求；额外认 opts.cache（昵称缓存）、
 *                        opts.injectHttp / opts.injectSleep（测试注入点）
 */
async function resolveFamilyCore(accessToken, opts) {
  // 家庭组接口的请求都很小，用比价格更紧的超时 + 1 次重试即可。
  // probe 已挡住「完全不可达」的情况；这里收紧是为了让「probe 通过、正式调用却撞上不可达窗口」
  // 这种 flaky 情况不会跑满 retries=2 × 双路由 ≈ 120s 才罢休 —— 最多 ~60s 就报可操作的错。
  const familyOpts = Object.assign({ timeout: 15000, retries: 1 }, opts || {});
  const { familyGroupId, group } = await getFamilyGroupForUser(accessToken, familyOpts);
  const rawMembers = extractFamilyMembers(group);

  // 共享库与游玩记录并行拉，省一个来回。
  // playtime 是未公开接口，失败不能阻塞主流程（上层据此降级提示）。
  const [shared, playtime] = await Promise.all([
    getSharedLibraryApps(accessToken, familyGroupId, familyOpts),
    getPlaytimeSummary(accessToken, familyGroupId, familyOpts).catch(() => null)
  ]);

  // 把「玩过它的人」与「各自玩了多久」挂到每款游戏上。
  // playedBy 保持 steamid 数组（引擎只数人头），playtime 是 id -> 秒 的映射，供页面展示。
  shared.forEach((a) => {
    const m = playtime && playtime.get(a.appid);
    if (!m || !m.size) {
      a.playedBy = [];
      a.playtime = {};
      return;
    }
    a.playedBy = Array.from(m.keys());
    a.playtime = {};
    m.forEach((secs, id) => { a.playtime[id] = secs; });
  });

  // owner_steamids 里可能出现 group.members 没列到的账号，一并纳入
  const ids = [];
  const seen = {};
  rawMembers.forEach((m) => { if (!seen[m.steamid]) { seen[m.steamid] = true; ids.push(m.steamid); } });
  shared.forEach((a) => a.ownerSteamIds.forEach((id) => {
    if (!seen[id]) { seen[id] = true; ids.push(id); }
  }));

  // 昵称/头像：免密钥，逐个串行请求（一次带多个 id 会被 Steam 一律 429，见 resolveUserProfiles）。
  // 6 人家庭组约 2~4 秒。resolveUserProfiles 内部已经吞掉所有失败并退避重试，
  // 拿不到就是少几个昵称（显示成「玩家XXXXXX」），价格与计分完全不受影响。
  const players = await resolveUserProfiles(ids, Object.assign({}, opts, { timeout: 15000 }));
  const byId = {};
  players.forEach((p) => { byId[p.steamid] = p; });

  const members = ids.map((id) => {
    const p = byId[id] || {};
    return {
      steamid: id,
      accountId: steamId64ToAccountId(id),
      name: p.name || ('玩家' + String(id).slice(-6)),
      avatar: p.avatar || '',
      profileUrl: p.profileUrl || '',
      nameResolved: !!p.name
    };
  });

  return { familyGroupId, members, apps: shared, rawMembers, playtimeAvailable: !!playtime };
}

/**
 * 读家庭组的外部门面：先探一次 api 域可达性，再委托给 resolveFamilyCore。
 *
 * - 不可达：probeFamilySource 已经抛了**专属于 api 域**的可操作提示，
 *   用户不用干等重试跑完（直连+代理各重试可达一两分钟）。
 * - 可达但正式调用仍网络失败（中途断流 / 代理不稳）：补一句 api 域专属说明，
 *   避免「价格查得到、家庭组却失败」让人以为是计分或代码问题。
 */
async function resolveFamily(accessToken, opts) {
  await probeFamilySource(opts);
  try {
    return await resolveFamilyCore(accessToken, opts);
  } catch (e) {
    if (e && e.network) {
      const err = new Error('读家庭组时连接 api.steampowered.com 失败：' + e.message +
        '（家庭组接口只在 api 域，store 域降级只覆盖价格。请检查代理是否稳定覆盖 api.steampowered.com。）');
      err.network = true;
      throw err;
    }
    throw e;
  }
}

/* ============================ 价格：store 域后备源 ============================ */

/** 把 store appdetails 的一条结果归一化成和 mapStoreItem 一样的结构 */
function mapAppDetails(entry, appid, region) {
  const base = {
    appid, name: '', shareable: false, isFree: false, priceState: 'unavailable',
    originalCents: 0, finalCents: 0, discountPct: 0, currency: region.currency,
    packageId: null, packageName: '', alternatives: [],
    storeUrlPath: 'app/' + appid, unlisted: false,
    region: region.cc, regionLabel: region.label, source: 'store'
  };
  if (!entry || !entry.success || !entry.data) return base;

  const d = entry.data;
  const po = d.price_overview || null;
  const catIds = (d.categories || []).map((c) => c.id);
  const isFree = d.is_free === true;

  let priceState;
  if (isFree) priceState = 'free';
  else if (!po) priceState = 'unavailable';
  else priceState = 'priced';

  return Object.assign(base, {
    name: d.name || '',
    // appdetails 的 categories 里直接写着 description: "家庭共享"，比推断可靠
    shareable: catIds.indexOf(CATEGORY_FAMILY_SHARING) >= 0,
    isFree,
    priceState,
    originalCents: po ? Number(po.initial || 0) : 0,
    finalCents: po ? Number(po.final || 0) : 0,
    discountPct: po ? Number(po.discount_percent || 0) : 0,
    currency: po ? po.currency : region.currency
  });
}

/**
 * store 域批量取价。
 * ★ 注意：appdetails 一次只接受 1 个 appid（传多个直接 HTTP 400）★
 * 所以只能串行 + 限速，几百款游戏会明显慢 —— 仅作为 api 域不可用时的后备。
 */
async function getStoreDomainPrices(appids, { cache = null, opts = {}, onProgress = null, region = REGIONS[0] } = {}) {
  const uniq = [...new Set([].concat(appids).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const result = {};
  const key = (id) => 'store_' + region.cc + '_' + id;
  let done = 0;

  for (const id of uniq) {
    const hit = cache && cache.get(key(id));
    if (hit) {
      result[id] = hit;
    } else {
      try {
        const mapped = await fetchOnePriceFromStore(id, region, opts);
        result[id] = mapped;
        if (cache) cache.set(key(id), mapped);
      } catch (e) {
        result[id] = mapAppDetails(null, id, region);
      }
      await sleep(STORE_REQUEST_DELAY);
    }
    done += 1;
    if (onProgress) onProgress(done, uniq.length);
  }
  return result;
}

async function fetchOnePriceFromStore(appid, region, opts) {
  const url = `${STORE}/api/appdetails?appids=${appid}&cc=${region.cc}&l=schinese` +
    `&filters=price_overview,basic,categories`;
  const j = await getJSON(url, opts);
  return mapAppDetails(j && j[String(appid)], appid, region);
}

/* ============================ 价格：统一入口 ============================ */

/**
 * 探测「api 域能不能用」并记住结论。
 *
 * 为什么需要：api 域挂掉时，一次失败要等重试跑完（十几秒到几十秒），
 * 每批价格都等一遍完全不能接受。这里用一个极小的请求探一次，
 * 结论在内存和磁盘缓存里各留 5 分钟，期间直接用已知可用的那个源。
 */
const SOURCE_MEMO_TTL = 5 * 60 * 1000;
let sourceMemo = null;
let sourceMemoAt = 0;

async function probePriceSource(cache, opts) {
  if (sourceMemo && Date.now() - sourceMemoAt < SOURCE_MEMO_TTL) return sourceMemo;

  const cached = cache && cache.get('price_source');
  if (cached && cached.at && Date.now() - cached.at < SOURCE_MEMO_TTL) {
    sourceMemo = cached.source;
    sourceMemoAt = cached.at;
    return sourceMemo;
  }

  let source = 'store';
  try {
    // 探测请求要尽量短：6 秒超时、不重试
    await getStoreItems([730], { opts: Object.assign({}, opts, { timeout: 6000, retries: 0 }) });
    source = 'api';
  } catch (e) {
    source = 'store';
  }
  sourceMemo = source;
  sourceMemoAt = Date.now();
  if (cache) cache.set('price_source', { source, at: Date.now() });
  return source;
}

/** 供界面/自检强制重新探测 */
function resetPriceSourceMemo() {
  sourceMemo = null;
  sourceMemoAt = 0;
}

/**
 * 统一取价：区域级联 + 数据源故障转移。
 *
 * 1. 先在国区整批查（优先 api 域批量，api 不可用自动退到 store 域逐个）。
 * 2. 国区拿不到价的（区域锁 / 已下架），按 港区 → 新加坡 → 美区 依次补查。
 * 3. 跨区价格按实时汇率折算成人民币，附在 cnyOriginal / cnyFinal 上。
 *
 * 为什么要级联：国区没上架的游戏不能简单当成 0 元，
 * 否则拥有这类游戏的人会被白扣贡献。
 *
 * @returns {{prices:object, rates:object, usedSource:string, degraded:boolean, warnings:string[]}}
 */
async function getPrices(appids, { cache = null, opts = {}, onProgress = null, preferSource = 'auto', stats = null } = {}) {
  const uniq = [...new Set([].concat(appids).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const warnings = [];
  let prices = {};
  let usedSource;
  let degraded = false;

  if (!uniq.length) {
    return { prices, rates: await getExchangeRates({ cache, opts }), usedSource: 'api', degraded, warnings };
  }

  usedSource = preferSource === 'auto' ? await probePriceSource(cache, opts) : preferSource;
  degraded = usedSource === 'store';

  // ---- 第一步：国区整批 ----
  const cn = REGIONS[0];
  if (usedSource === 'store') {
    warnings.push('当前使用 store.steampowered.com 逐个取价（api.steampowered.com 不可达），会比较慢。');
    prices = await getStoreDomainPrices(uniq, { cache, opts, region: cn, onProgress });
  } else {
    try {
      prices = await getStoreItems(uniq, { cache, opts, region: cn, onProgress, stats });
    } catch (e) {
      // 探测时还活着、现在挂了 —— 立刻降级
      usedSource = 'store';
      degraded = true;
      sourceMemo = 'store';
      sourceMemoAt = Date.now();
      if (cache) cache.set('price_source', { source: 'store', at: Date.now() });
      warnings.push('api.steampowered.com 请求失败，已切换到 store.steampowered.com 逐个取价。原因：' +
        redactText(e.message || e, 100));
      prices = await getStoreDomainPrices(uniq, { cache, opts, region: cn, onProgress });
    }
  }

  // ---- 第二步：国区缺价的按 港区 → 新加坡 → 美区 补 ----
  const needsPrice = (p) => p && (p.priceState === 'unavailable' || p.priceState === 'unknown');

  for (let ri = 1; ri < REGIONS.length; ri++) {
    const region = REGIONS[ri];
    const missing = uniq.filter((id) => needsPrice(prices[id]));
    if (!missing.length) break;

    let filled;
    try {
      filled = usedSource === 'api'
        ? await getStoreItems(missing, { cache, opts, region })
        : await getStoreDomainPrices(missing, { cache, opts, region });
    } catch (e) {
      continue;   // 单个区域查失败不致命，继续试下一个
    }

    let got = 0;
    missing.forEach((id) => {
      const p = filled[id];
      if (p && p.priceState === 'priced') {
        prices[id] = p;
        got += 1;
      }
    });
    if (got) warnings.push('有 ' + got + ' 款游戏国区无售价，已改用' + region.label + '价格（按汇率折算）。');
  }

  // ---- 第三步：汇率换算 ----
  // ★ 全是国区价时就**不请求汇率接口**：没有跨区价格要折算，少一次出网、少一个失败点
  //   （也就不用为了一个没人要的数字去敲第三方接口）。
  const needFx = Object.keys(prices).some((id) => {
    const p = prices[id];
    return p && p.currency && p.currency !== 'CNY';
  });
  const rates = needFx ? await getExchangeRates({ cache, opts }) : { CNY: 1, source: 'not-needed' };
  if (rates.source === 'fallback') {
    warnings.push('汇率接口不可用，跨区价格用的是内置兜底汇率，仅供参考。');
  }
  Object.keys(prices).forEach((id) => {
    const p = prices[id];
    if (!p) return;
    p.cnyOriginal = toCnyYuan(p.originalCents, p.currency, rates);
    p.cnyFinal = toCnyYuan(p.finalCents, p.currency, rates);
  });

  return { prices, rates, usedSource, degraded, warnings };
}

module.exports = {
  // 常量
  CATEGORY_FAMILY_SHARING,
  PRICE_BATCH_SIZE,
  REGIONS,
  // steamid
  parseSteamId,
  isSteamId64,
  steamId64ToAccountId,
  accountIdToSteamId64,
  // 接口
  getJSON,
  getProxyUrl,
  redactProxyUrl,
  // 昵称 / 头像（★免密钥★：steamcommunity ajaxresolveusers，一次只能一个 id）
  resolveUserProfiles,
  mapResolvedUser,
  avatarUrlFromHash,
  profileUrlOf,
  AVATAR_CDN,
  // 家庭组（只要 access_token）
  getFamilyGroupForUser,
  tokenRejectedMessage,      // 401 的可操作解释（轮换作废优先于过期）
  getSharedLibraryApps,
  getPlaytimeSummary,   // ★「谁玩了什么」的唯一来源（POST，未公开接口）
  resolveFamily,
  resolveFamilyCore,
  extractFamilyMembers,
  probeFamilySource,            // ★ 读家庭组前探一次 api 域可达性
  familyUnreachableMessage,     // api 域不可达时的可操作提示（纯函数，单测锁文案）
  // 价格
  getStoreItems,
  getStoreDomainPrices,
  getPrices,
  probePriceSource,
  resetPriceSourceMemo,
  getExchangeRates,
  toCnyYuan,
  mapStoreItem,
  mapAppDetails,
  pickBasePurchaseOption,
  optionOriginalCents,
  // 工具
  createCache,
  cacheDir,
  cacheFile,
  legacyCacheHint,
  redactText,
  readBody,
  // ★ httpRaw 单独导出是**为了测总时限**：它内部走 https.request，离线测试起不了真实服务端，
  //   只能把 https.request 换掉来模拟「对端收下请求却永不回应」。生产代码不直接用它。
  httpRaw
};
