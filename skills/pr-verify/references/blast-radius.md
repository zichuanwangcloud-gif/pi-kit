# F 节：爆炸半径与回归——改动碰到了谁

这是最容易漏、也最能靠机械手段兜住的一节。AI 改共享组件时不知道有六个页面在用它；改一个被十处调用的函数签名时，编译器能拦类型不匹配，拦不住语义变化。

> 由 SKILL.md 的 F 节引用。脚本 `scripts/golden-diff.sh` 是差分部分的机械形态。可 `invoke_skill change-impact` / `schema-migration-audit` / `api-contract-audit` 取材，但本节每格以本次运行输出为准。

## 本文小节

- [引用方表](#引用方表)
- [黄金请求差分](#黄金请求差分)
- [差异归类](#差异归类)
- [视觉回归](#视觉回归)
- [schema 与回滚](#schema-与回滚)
- [存量数据与默认值](#存量数据与默认值)
- [依赖变化](#依赖变化)
- [判定](#判定)

## 引用方表

对 `$IMPL_FILES` 里每个被修改的导出符号（函数、类型、常量）、数据库表/列、共享组件、配置项，找引用方：

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${WT_HEAD:?}" "${IMPL_FILES:?}" "${PACK:?}"
: > "$PACK/blast-radius.txt"
while IFS= read -r f; do
  SYM='<从该文件 diff 中提取的被改符号名，一次一个>'
  printf '## %s :: %s\n' "$f" "$SYM" >> "$PACK/blast-radius.txt"
  grep -rnw --include='*.go' --include='*.ts' --include='*.vue' --include='*.py' --include='*.rs' --include='*.java' \
    -e "$SYM" "$WT_HEAD" 2>/dev/null | grep -v "^$WT_HEAD/$f:" >> "$PACK/blast-radius.txt" || true
done < "$IMPL_FILES"
wc -l < "$PACK/blast-radius.txt"
```

文本命中只是候选；有语言服务器/索引（`gopls references`、`tsc --listFilesOnly`、IDE 索引）优先用。每条候选标 `DIRECT`/`TRANSITIVE`/`EXCLUDED(原因)`，然后填第三列「所属业务/页面」——这一列就是回归范围：改了一个共享组件，哪六个页面用了它，那六个页面都得过一遍 B 节式的真跑或既有 e2e。

## 黄金请求差分

攒一份「黄金请求集」：几十到几百条覆盖主要业务的真实请求（脱敏），每条一个文件放在 `$GOLDEN_DIR`：

```text
$GOLDEN_DIR/
  list-orders.req          # 首行 "GET /api/orders?page=1"，随后可选 Header 行，空行，可选 body
  create-order.req
  ignore-keys.txt          # 每行一个噪声字段名：id created_at updated_at request_id trace_id
```

同一组请求分别打 base 与 head 服务，去噪后 diff：

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${ENVFILE:?}" "${GOLDEN_DIR:?}" "${URL_BASE:?}" "${URL_HEAD:?}"
bash skills/pr-verify/scripts/golden-diff.sh "$ENVFILE"; EXIT=$?
echo "golden-diff exit=$EXIT"
```

脚本按实际安装位置调用。退出码：`0` 全部相同；`1` 有差异需归类；`2` 请求失败或配置缺失。响应与 diff 落 `$PACK/golden/`。没有黄金请求集 → 此格 `BLOCKED`，报告建议从访问日志抽样建立。

## 差异归类

每条 `DIFF` 二选一：

| 归类 | 判据 | 处置 |
|---|---|---|
| 本 PR 预期改动 | 能指到验收表的某一行（写行号） | 记录，不影响判定 |
| 回归 | 指不到验收表任何一行 | `FAIL`，附 diff 原文 |

「看起来是改进」不是第三类。指不到验收表的差异，要么补进验收表（回 A 节，走「需要猜」流程），要么就是回归。

## 视觉回归

diff 触及样式、共享 UI 组件、布局时，对引用方表里列出的每个页面在 base 与 head 各截一张图比对（项目既有的 Playwright 截图对比/Percy/Chromatic 优先）。遮挡、裁字、溢出必须在**真实浏览器**里以 1:1 的容器链复现，注释里写「已实测」不算。像素差异 > 0 的页面逐张归类，同上表。

## schema 与回滚

有迁移文件的 PR：

1. 在类生产库副本上跑迁移，记录耗时、锁级别（是否锁表、是否 `CONCURRENTLY`、是否在事务内）；
2. 跑回滚（down 迁移或手写逆操作），确认数据可逆或写明不可逆点；
3. **旧代码在新 schema 上启动并跑黄金请求**——蓝绿/滚动发布期间两版并存，新增非空列无默认值、删列、改类型都会让旧版崩；
4. 新代码在旧 schema 上启动（迁移未执行时的降级）——能否明确失败而非静默错数据。

四步的命令与输出落 `$PACK/schema-<步>.out`。第 3 步失败 → `FAIL`，除非发布流程文档明确禁止并存窗口。

## 存量数据与默认值

AI 默认世界从这个 PR 开始。逐项回答并附证据：

- 新功能对**已有**几十万条老数据的行为：需要回填吗？回填脚本在哪、跑多久、可中断可重入吗？
- 新配置项缺省时的行为：老部署没配它会怎样？默认值是什么？
- feature flag 默认态：默认关吗？有 kill switch 吗？开着的时候关掉能立刻生效吗？
- 新增枚举值/状态：旧代码遇到未知值是忽略、报错还是崩？

每项在 head 环境上真跑一次（空配置启动、老数据请求、flag 切换），输出落盘。

## 依赖变化

lockfile 有 diff 时：

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${ROOT:?}" "${BASE_OID:?}" "${HEAD_OID:?}" "${PACK:?}"
git -C "$ROOT" diff "${BASE_OID}...${HEAD_OID}" -- go.sum go.mod package-lock.json pnpm-lock.yaml yarn.lock Cargo.lock poetry.lock requirements*.txt \
  | grep -E '^\+' | grep -vE '^\+\+\+' > "$PACK/deps-added.txt" || true
wc -l < "$PACK/deps-added.txt"
```

对每个新增包：

1. 仓库里是否已有同功能依赖（问独立上下文：「这个包做什么，仓库现有依赖里有没有能做同一件事的」）；
2. 包名在注册表里真实存在且下载量/维护状态合理——AI 会 import 不存在的包名，且这类名字已被攻击者抢注；
3. 许可证与项目兼容；
4. 是谁带进来的（`go mod why`、`npm explain`、`cargo tree -i`）。

第 2 项不存在 → `FAIL`；第 1 项有同类 → Medium 发现。可 `invoke_skill dependency-upgrade` 取材。

## 判定

| 子项 | `PASS` 条件 |
|---|---|
| 引用方表 | 每个 `DIRECT` 引用方所属业务已有真跑或既有测试输出 |
| 黄金差分 | 无「回归」归类 |
| 视觉回归 | 无未归类像素差异 |
| schema 与回滚 | 四步完成，旧代码新 schema 可运行 |
| 存量与默认值 | 四问都有真跑输出 |
| 依赖 | 新增包全部存在、无同类重复 |

任一 `FAIL` → F 节 `FAIL`；黄金请求集缺失时差分 `BLOCKED`，其余照常。
