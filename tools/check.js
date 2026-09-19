#!/usr/bin/env node
/*!
 * Steam 连接自检
 * ------------------------------------------------------------------
 * 连不上 Steam 的时候先跑这个，它会逐项告诉你是哪一层出了问题，
 * 而不是让你对着一个 "fetch failed" 发呆。
 *
 *   node tools/check.js                    # 基础自检
 *   node tools/check.js 76561197960435530  # 顺带测某个账号的昵称解析（免密钥）
 *   STEAM_ACCESS_TOKEN=xxx node tools/check.js   # 连「家庭组读取」一起验证
 *
 * 顺便，它也是这套接口可用性的活文档：
 *   - 哪些接口完全不需要凭据（价格、家庭共享判定、昵称头像）
 *   - 哪个接口必须要 access_token（家庭组三件套）
 *   - ★ 全项目已经不用 Web API Key 了
 *   - 家庭组成员为什么读不到
 */
'use strict';

const S = require('../src/steam.js');

const steamid = process.argv[2] || '';
const TOKEN = (process.env.STEAM_ACCESS_TOKEN || '').trim();

const OK = '\u2713';
const NO = '\u2717';
const WARN = '!';

function line(icon, text) { console.log('  ' + icon + ' ' + text); }
function indent(text) { console.log('      ' + text); }

async function step(title, fn) {
  console.log('\n' + title);
  try {
    await fn();
    return true;
  } catch (e) {
    line(NO, e.message);
    return false;
  }
}

(async function main() {
  console.log('');
  console.log('  Steam 连接自检');
  console.log('  ' + '='.repeat(58));

  const proxy = S.getProxyUrl('api.steampowered.com');
  console.log('\n环境');
  // ★ 代理 URL 里可能带着用户名口令（`HTTPS_PROXY=http://<用户名>:<口令>@host:7890`）。
  //   这行会滚屏，也可能被截图求助 / 贴进 CI 日志 —— 打出来之前先抹掉凭据部分。
  line(proxy ? WARN : OK, '代理：' + (proxy ? S.redactProxyUrl(proxy) : '未设置（走直连）'));
  if (process.env.STEAM_FORCE_DIRECT === '1') {
    indent('STEAM_FORCE_DIRECT=1，已强制禁用代理');
  }
  line(TOKEN ? OK : WARN, 'access_token：' + (TOKEN
    ? '已设置（来自环境变量）'
    : '未设置 —— 只能验证免密钥接口，「家庭组读取」那条会跳过'));
  indent('★ 本项目不需要 Web API Key：家庭组只认 access_token，昵称头像走免密钥接口。');

  let priceOk = false;

  await step('1. 取价接口（IStoreBrowseService，免 Key）', async () => {
    const t0 = Date.now();
    const r = await S.getStoreItems([1245620, 2358720, 779340], { onProgress: null });
    const ms = Date.now() - t0;
    const names = Object.values(r).filter((x) => x.appid).map((x) => x.name + ' ' + (x.originalCents / 100) + '元');
    if (names.length < 3) throw new Error('只返回了 ' + names.length + ' 条，接口可能异常');
    line(OK, '正常，' + ms + 'ms');
    names.forEach((n) => indent(n));
    priceOk = true;
  });

  await step('2. 家庭共享判定（分类 62）', async () => {
    // 艾尔登法环可共享；荒野大镖客 2 / 双人成行 需要第三方启动器，不可共享
    const r = await S.getStoreItems([1245620, 1174180, 1426210, 730], {});
    const expect = { 1245620: true, 1174180: false, 1426210: false, 730: false };
    let bad = 0;
    Object.keys(expect).forEach((k) => {
      const it = r[k];
      if (!it) return;
      const pass = it.shareable === expect[k];
      if (!pass) bad += 1;
      line(pass ? OK : NO, (it.name || k).padEnd(24) + (it.shareable ? '可共享' : '不可共享') +
        '   ' + (it.priceState === 'free' ? '免费' : (it.originalCents / 100) + ' 元'));
    });
    if (bad) throw new Error('有 ' + bad + ' 项与预期不符，Steam 的分类定义可能变了');
    line(OK, '判定逻辑与预期一致');
  });

  await step('3. 家庭组接口（★只认 access_token，Web API Key 一律 401★）', async () => {
    if (!TOKEN) {
      const r = await S.getJSON('https://api.steampowered.com/IFamilyGroupsService/GetFamilyGroupForUser/v1/?steamid=76561197960435530').catch((e) => ({ err: e }));
      line(OK, '接口可达（无 token 时返回 ' + (r.err ? r.err.message.slice(0, 30) : 'HTTP ' + r.status) + '）');
      indent('这个接口要的是 access_token，不是 Web API Key —— 用 Key 一定 401，');
      indent('而且它压根不在无密钥 GetSupportedAPIList 返回的公开接口清单里。');
      indent('取 token：家庭组管理页 https://store.steampowered.com/account/familymanagement/ → F12');
      indent('  方法一（最快）Network 标签 → 硬刷新页面 → Ctrl+F 搜 access_token → 从 Request URL 复制那串值');
      indent('  方法二（最稳）Console 标签 → copy(JSON.parse(application_config.dataset.loyalty_webapi_token))');
      indent('★ 取完别再刷新任何 Steam 页面：页面每加载一次就换发新 token，旧的立即作废。');
      indent('然后跑：STEAM_ACCESS_TOKEN=xxx node tools/check.js');
      return;
    }
    const fam = await S.resolveFamily(TOKEN, {});
    line(OK, '读到家庭组 ' + fam.familyGroupId + '：' + fam.members.length + ' 位成员，共享库 ' + fam.apps.length + ' 款游戏');
    fam.members.slice(0, 8).forEach((m) => indent(m.name + '  ' + m.steamid + (m.nameResolved ? '' : '  (昵称没解析到：免密钥接口限流)')));
    if (fam.apps.length) {
      const sample = fam.apps.slice(0, 5);
      indent('归属抽样：');
      sample.forEach((a) => indent('  appid ' + String(a.appid).padEnd(9) + a.ownerSteamIds.length + ' 人拥有'));
    }
  });

  if (steamid) {
    await step('4. 昵称/头像解析（免密钥：steamcommunity ajaxresolveusers）', async () => {
      const parsed = S.parseSteamId(steamid);
      if (!parsed || parsed.type !== 'steamid64') {
        throw new Error('这一步只接受 steamid64。自定义链接名要靠 ResolveVanityURL，而那个接口只吃 Web API Key，本项目不用它。');
      }
      const t0 = Date.now();
      const got = await S.resolveUserProfiles([parsed.steamid64], {});
      if (!got.length) throw new Error('没解析到昵称 —— 可能是被限流（429）或该账号资料不可见。稍等一会儿重跑。');
      const p = got[0];
      line(OK, p.name + '（' + p.steamid + '）  ' + (Date.now() - t0) + 'ms');
      indent('头像：' + (p.avatar || '（无）'));
      indent('主页：' + (p.profileUrl || '（无）'));
      indent('★ 这个接口一次只能带一个 steamid：带 2 个及以上一律 429（实测 chunk=2/3/6 全被拒）。');
    });
  } else {
    console.log('\n4. 昵称/头像解析（免密钥）');
    line(WARN, '跳过。用法：node tools/check.js <steamid64>');
  }

  console.log('\n' + '  ' + '='.repeat(58));
  if (priceOk) {
    console.log('  结论：核心数据源（价格 + 家庭共享判定 + 免密钥昵称）可用。');
    if (!TOKEN) {
      console.log('  提示：设上 STEAM_ACCESS_TOKEN 才能验证「家庭组成员读取」这一条。');
    }
  } else {
    console.log('  结论：连不上价格数据源。');
    console.log('  可以试试：');
    console.log('    1. 开加速器（注意路由模式，有些模式只代理 store 域不代理 api 域），');
    console.log('       或设置 HTTPS_PROXY=http://127.0.0.1:端口 后重跑');
    console.log('    2. 确认能访问 https://api.steampowered.com 或 https://store.steampowered.com');
    console.log('       两个域只要有一个通就能取价（工具会自动降级）。');
  }
  console.log('');
})().catch(function (e) {
  console.error('\n自检脚本本身出错：' + e.stack);
  process.exit(1);
});
