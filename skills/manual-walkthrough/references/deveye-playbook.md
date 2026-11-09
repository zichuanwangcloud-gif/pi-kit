# DevEye 走查实操手册

本文件是「怎么操控浏览器」的全部细节。命令来自 deveye v1.20 实测，换版本先 `deveye --version` 核对。

## 0. 开一次会话前必做

```bash
deveye ping                      # 不通：看 server 是否在跑、日志有没有 Extension connected
deveye tabs --json               # 记下目标 tabId 和 active 状态
```

不通时先判断是不是隧道断了（用户侧关了 SSH 端口转发窗口），别急着重装。

## 1. 锁死标签页

```bash
TAB=<tabId>
de() { deveye "$@" -t $TAB; }    # -t 必须在子命令之后
```

- **绝不** `deveye open` / `close` / 切换用户其他标签页。浏览器是用户真实 Chrome，可能开着生产站和已登录会话。
- 需要新页面时，请用户自己开好并把标签 id 告诉你；或改用无头链路（§6）。
- 同一时刻只操作一个 tab。多批任务把 `TAB` 写进每批脚本开头。

## 2. 找元素：snapshot 优先，截图只用于验结果

```bash
de snapshot --interactive-only --viewport-only --compact | head -c 4000
```

- 输出长时一律 `| head -c N` 截断，防止上下文爆掉。
- 同名按钮有多个时用 snapshot 给出的 uid：`de click --uid eN`。
- 不用 `screenshot` 找元素，也不要在自动化流程里用 `pick`（需要人点屏幕）。
- 下拉不是原生 select：先点触发按钮，再 `click --text` 浮层选项。原生 select 才用 `select -l`。
- 弹窗/抽屉多数是 `div[role=dialog]`，少数没有；按可见文字定位。
- 有新手引导遮罩时注入一条 style 隐藏：
  ```bash
  de eval "var s=document.createElement('style');s.textContent='.driver-overlay,.driver-popover{display:none!important}';document.head.appendChild(s);'ok'" --no-snapshot
  ```

## 3. 登录配方（实测可用）

```bash
BASE=${BASE:?页面根地址，如 https://host:3020}
EMAIL=${EMAIL:?登录邮箱}
PASSWORD=${PASSWORD:?登录密码}
# 1. 清登录态（换身份前必做）
de eval "['auth_token','refresh_token','auth_user','token_expires_at'].forEach(k=>localStorage.removeItem(k));'ok'" --no-snapshot
de navigate goto "$BASE/login" --timeout 60000
de wait "#email" --timeout 20000
# 2. 协议勾选框：check 不生效，用 click
de click "#login-agreement-consent"
# 3. 填账号
de type "#email" "$EMAIL" --clear
de type "input[type=password]" "$PASSWORD" --clear
# 4. 提交：不要用 --submit，不会触发登录
de click --text "登录" --timeout 60000
# 5. 确认落地身份
de wait --url-contains dashboard --timeout 20000
de eval "JSON.parse(localStorage.auth_user).email" --no-snapshot
```

超管登录后默认落个人视角 `/dashboard`；管理页面从左侧菜单顶部「平台管理」区进入，或直接 goto `/admin/dashboard`。

## 4. 截图：先验活，再截，再自检

```bash
TAB=${TAB:?目标 tabId，来自 deveye tabs --json}
SH=${SH:?截图目录绝对路径}
shot() {
  local act; act=$(deveye tabs --json | python3 -c "import json,sys;d=json.load(sys.stdin);print([t for t in d if t['tabId']==$TAB][0]['active'])")
  [ "$act" = "True" ] || { echo "!! 目标 tab 不在前台，跳过 $1"; return 1; }
  de screenshot -o "$SH/$1.png" "${@:2}"
}
```

- 默认视口截图；整页用 `--full-page`；只截某块用 `--selector` 或 `--interactive-region`。
- 弹窗/抽屉打开后再补一张；Tab 切换后、滚到小节顶部后再截。
- 跑完自检无重复帧：
  ```bash
  md5sum "$SH"/<批次>-*.png | sort | uniq -c -w32
  ```
  有 `2` 开头的行说明两张图字节相同 = 页面没变或截到了陈旧帧。
- **不要 Read 截图文件**（浪费上下文）。要看页面内容用 `dumpControls` / `innerText`。

## 5. 超时与中断

- 单条命令可加 `--timeout 60000`（上限 300000）。
- 连续 3 次超时：先 `deveye ping` 看扩展是否还连着；仍不通就写完已完成章节，在报告里写明中断点，不要死等。
- 等待页面变化用 `wait --url-contains` / `wait --text` / `wait --eval`，不要 `sleep`。

## 6. 无头降级（用户在用浏览器 / 禁碰真实浏览器时）

全部截图与操作改用本机无头 Chromium（Playwright），思路：

- `tools/lib.mjs` 提供：`openRole('admin'|'main'|'sub')` 自动读 creds.env 登录并缓存登录态；`goto`、`tab`、`pickOption`、`setSwitch`、`scrollHeading`、`dumpControls`、`closeDialog`；`shot(page, '<编号>')` / `{full:true}` / `{sel:'div[role=dialog]'}`。
- 每批写一个 `tools/<批次>.mjs`，在 scratch 目录下 `node tools/<批次>.mjs` 运行；按编号拆函数，用命令行参数选择跑哪个，别一口气写完再跑。
- 截图前保证目标内容真的在视口里（弹窗已开、Tab 已切、小节已滚到顶）。
- DevEye 仍可用于临时 `snapshot` 查看，但不作为截图来源，也不在用户标签页上做改数据操作。

## 7. 常用动作速查

| 目的 | 命令 |
|---|---|
| 导航 | `de navigate goto URL --wait-for selector` |
| 等条件 | `de wait --text "保存成功"` / `--url-contains x` / `--eval "..."` |
| 批量填表 | `de fill-form '[{"ref":"e1","value":"..."}]'` |
| 键盘快捷键 | `de keyboard "Control+a"`（`type` 需要目标元素） |
| 勾选 | `de check "#agree"`（自定义组件除外，见登录配方） |
| 上传 | `de upload "#file-input" ./file.pdf` |
| 看接口 | `de network --url "/api" --detail` |
| 看报错 | `de console --level error` |
| 纯数据查询 | `de eval "expr" --no-snapshot` |
