---
name: manual-walkthrough
description: 用 DevEye/浏览器自动化在真实运行的控制台里逐页走查，产出一本带截图的客户向操作手册（"写一本操作手册""走查这个页面""截图写成手册""把功能讲给客户""补一本手册"）。核心纪律：锁定标签页、截图前验活、不碰别人的标签、演示数据可清理、结论要有页面证据。项目耦合全部收在 references/project-profile.md，换项目只填这一份，可按 references/project-profile.md 的模板自建项目档案。
compatibility: 需要可达的目标站点、一个登录账号与 deveye CLI（或降级到本机无头 Playwright）。写文件只落在 scratch 目录与手册目录，不改仓库源码、不碰 git。
allowed-tools: read bash write invoke_skill
metadata:
  category: documentation-walkthrough
  portability: project-agnostic
---

# Manual Walkthrough：从走查到一本客户能自己看的手册

```text
定范围与读者 → 起环境/造演示数据 → 逐页走查（DevEye 或 Playwright）→ 截图与证据
→ 写章节（模板）→ 汇总走查发现 → 发布到手册站 → 自检交付
```

参考文件：

| 文件 | 内容 |
|---|---|
| `references/deveye-playbook.md` | 连接、锁标签页、登录配方、找元素、截图验活、超时降级 |
| `references/environment.md` | 演示环境、creds.env、造数据脚本、命名规则、清理 |
| `references/manual-template.md` | 章节模板、写作口吻、发布到手册站、交付自检 |
| `references/project-profile.md` | 项目档案模板：站点端口、角色与登录、菜单与术语陷阱、已知坑、既有手册 |

## 六条铁律

1. **读者不是开发者。** 正文不出现代码、路由名、组件名、CR 编号、内部术语。术语以页面上实际显示的文字为准，照抄。
2. **锁死一个标签页。** 所有操作带 `-t <tabId>`，`-t` 放在子命令之后。绝不对用户其他标签页操作，不 `deveye open/close` 用户没让动的标签。
3. **截图前先验活。** 目标标签不在前台时截图会拿到陈旧帧或别人的页面。先查 `tabs --json` 里目标 tab `active==True` 再截；用户在用浏览器时不靠猜测，改用 Playwright 无头链路。
4. **结论必须带页面证据。** 每条"这个按钮会怎样"都要有截图或页面文字支撑；没走到的写 `> ⚠️ 本次走查未能覆盖：原因`，并在报告里单列。
5. **演示数据可识别、可清理。** 新建对象统一前缀（默认「手册-」），账号登记在 `~/.cache/<项目>-manual/creds.env`，密码不进任何 .md 和截图。
6. **不改仓库、不碰生产。** 写文件只落在 scratch 与手册目录；生产站只读，动生产页面前先问用户。

## 流程

### 1. 定范围（先写在一句话里）

- 读者：超管 / 主用户 / 子用户 / 接入方，先分角色再排流程。
- 范围：本次覆盖哪些页面或流程，明确**不写**什么。
- 版本：走查用的分支、commit、站点地址，写进手册首页。

### 2. 起环境

读 `references/environment.md`：演示库、creds.env、造数脚本。造数据优先走**业务 API**（与页面同一条链路），其次 SQL 兜底；造完用页面自己确认一遍。

### 3. 逐页走查

按 `references/deveye-playbook.md` 执行。每页固定产出：页面概览截图、每个主操作的截图、必要时的弹窗/抽屉截图。截图存 `img/<编号>-<序号>.png`，跑完 `md5sum | uniq -c -w32` 自检无重复帧。

### 4. 写章节

按 `references/manual-template.md`。每个大节用 `<section id="...">` 包起来（手册站靠它做搜索定位）。

### 5. 汇总走查发现

单列一节「走查发现的问题」：现象 → 影响 → 建议修法。这部分往往最有用，别省。

### 6. 发布与自检

发布到手册站（读 `references/manual-template.md` 的发布小节），然后逐条过交付自检。

## 输出

- 手册正文（独立单页 HTML 或 Markdown 源）
- 截图目录
- 走查报告：已完成编号 + 截图张数、未覆盖项及原因、新登记账号（只写邮箱）、疑似缺陷一行一条、结束时的浏览器状态（登录身份、当前页）
