# 贡献

## 跑测试

```bash
npm test                 # 零依赖、全离线（含发布闸门 tests/docs.test.js）
npm run test:ui          # 报告渲染冒烟（需要 jsdom：npm i）
npm run test:report
```

`tests/docs.test.js` 是**发布闸门**：它会扫所有会进仓库的文件，检查文档口径、
凭据红线、真人数据红线、出网域名白名单、以及「零运行时依赖 + 无 install 生命周期脚本」。
它扫的是 `git ls-files`，所以**新增文件要先 `git add` 才在扫描范围内**。

### Node 版本

- 工具本身只要 **Node 18+** —— `npm test` 在 18 / 20 / 22 上都能跑；
- 后两套测试依赖 jsdom，而当前 `devDependencies` 里 jsdom 要求的 Node 版本比 18 高，
  版本不够时 `npm i` 会报 `EBADENGINE`，那两套就起不来。想跑全量请用较新的 Node。

CI（`.github/workflows/test.yml`）就是按这个分工的：`gate` 在 18 / 20 / 22 上跑 `npm test`，
`report` 单独一个 job、装完 jsdom 再跑后两套。

## 两条硬规矩

1. **算法只准写在 `src/engine.js`** —— 界面与命令行都只消费它的返回值。
   终端里打的分和报告里画的分必须由同一份代码算出来。
2. **「Steam 数据 → 报告认的字段」的组装只有一处**（`src/payload.js`）。
   两处各写一份口径的话，改一处漏一处，命令行打出的分和报告里画的分就会对不上。

## 提交前请检查

- 不要在代码、注释、文档、测试夹具里写任何形式的凭据，包括**看起来像**的。
  测试桩一律用短得离谱的值或明显的占位符（`'from-env'`、`stub-token-…`）。
- 不要把真实玩家的数据带进仓库：需要样例就用 `tests/fixtures/family-api-sample.json`
  那种合成数据（六个假 steamid + 假昵称）。
- 昵称接口会返回 `real_name`、`city`、`country` 等隐私字段 —— **一律丢弃**，
  `mapResolvedUser()` 只保留 6 个必要字段，有单测锁住这条。
- 凡是插进 `innerHTML` 的字段一律过 `esc()`，别依赖「上游会过滤」。
- 新增任何出网目标都要同步进 `tests/docs.test.js` 的域名白名单，让它是有意为之而不是顺手写进去的。
- 改了文档口径或加了防护，顺手把闸门里的断言也加上，并**反向验证一次**
  （把防护摘掉，确认测试会红 —— 只查域名的弱断言是哑的）。

## 关于 `access_token`

它是**账号级凭据**，等同于 Steam 登录态。这个项目对它只有三条约束：

- 只从命令行参数 / 环境变量 / 交互式输入获得，**不写进任何文件、不进 localStorage**；
- 只发给 Steam 官方域（`api` / `store` / `steamcommunity`），不经过任何第三方；
- 请求失败时错误消息里不带 token 内容（URL 里带是 Steam 接口本身的要求 —— 因此
  **会解密 HTTPS 的加速器/杀软能看到它**，README 里如实写了这一条）。
