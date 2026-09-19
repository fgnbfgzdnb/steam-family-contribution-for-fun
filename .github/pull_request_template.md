## 这个 PR 做了什么

<!-- 一两句说清。关联的 issue 用 #123 引用。 -->

## 提交前自查

- [ ] `npm test` 全绿（零依赖，改完必跑）
- [ ] 动了报告渲染 / 报告产物的话，`npm install` 之后
      `npm run test:ui` 与 `npm run test:report` 也全绿
- [ ] 没有把**任何真人的 Steam 资料**写进代码、测试或注释
      （SteamID / 个人主页名 / 头像 hash / 昵称 —— 一个都不行）
- [ ] 没有把 token、代理凭据、服务器地址写进任何地方
- [ ] 新增的文件已经 `git add` 过
      （发布闸门扫的是 `git ls-files`，没 add 就不在保护范围内）
- [ ] 改了口径类文字（README / CONTRIBUTING / 提示语）的话，
      `tests/docs.test.js` 仍然全绿

## 说明

<!--
有取舍、有反直觉的地方写在这里。
如果是 AI 协助完成的，也请注明 —— 不代表会被拒绝，只是审查会更仔细。
-->
