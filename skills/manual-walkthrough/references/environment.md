# 环境、演示数据与安全边界

## 目录约定

```text
/opt/<project>/.scratch/<feature>-manual/
├── BRIEF.md              本批次通用说明（读者、站点、标签 id、禁区）
├── tools/lib.mjs         无头 Playwright 封装（登录缓存、截图、控件操作）
├── tools/<批次>.mjs      每批一个脚本
├── sections/<编号>.md    章节源文件
├── img/<编号>-<序号>.png 截图
└── shots/                发布用截图（可选，直接复用 img/）
```

credentials 放 `~/.cache/<project>-manual/creds.env`：

```bash
export ADMIN_EMAIL=admin@demo.local
export ADMIN_PASSWORD='...'
export MAIN_EMAIL=...   # 主用户
export SUB_EMAIL=...    # 子用户
```

- 密码**只**在 creds.env；不写进任何 .md、不写进截图说明、不回帖。
- 新登记账号在报告里只写邮箱。

## 演示环境

- 用**独立演示库**，不用生产库，也不用上游指向生产的克隆库；哪些库不可用见项目档案。
- 站点地址、后端端口、前端端口写进 BRIEF.md 开头；走查版本（分支、commit）写进手册首页。
- 起服务走项目自己的编排入口（`nx up` / `make dev` / `compose up`），不要手动起裸进程。

## 造数据

优先级：

1. **业务 API**——与页面走同一条链路，造出来的数据形态最真实。用管理员 token 调接口。
2. **SQL 兜底**——API 不覆盖的字段（密码哈希、状态位）再用 SQL 补。示例：
   ```bash
   docker exec <pg> psql -U <user> -d <db> -Atc "select id from users where email='x'"
   ```
3. **页面操作**——本身就是走查的一部分，能走就走。

规则：

- 新建对象统一前缀，默认「手册-」（`手册-张三`、`手册-分组A`），方便识别与清理。
- 只删自己建的东西；不删库里已有的用户、分组、账号、订阅。
- 造完用页面自己确认一遍，别只看接口返回。
- 不要用真实 API Key 调网关/发真实请求。

## 清理

- 批次结束列出本批新建的对象（表 + id），问用户是否清理；用户确认后再删。
- 截图和章节源文件保留在 scratch，可复跑补图。

## 安全边界

- 写文件只落在 scratch 与手册目录，不改仓库源码、不碰 git。
- 生产站只读；动生产页面前先问用户。
- 用户真实浏览器里可能有生产登录态：不在别人的标签页上做改数据操作。
