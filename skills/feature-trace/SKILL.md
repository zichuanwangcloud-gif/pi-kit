---
name: feature-trace
description: 从一句话功能描述、Linear issue、changelog 或 PR 标题回溯真实代码实现、前端 UI 入口、用户可见中英文文案和后端调用链，并生成 QA checklist。用于“功能溯源”“前端入口在哪”“这个功能怎么测”“提测说明”“功能定位”等请求。
compatibility: Requires ripgrep and a readable project checkout. Optimized for Vue/React plus Go backends, including CloudRouter clouditera shadow components.
allowed-tools: read bash
metadata:
  source: /opt/CloudRouter/.claude/skills/clouditera/feature-trace/SKILL.md
  pi-port: "1"
---

# feature-trace：功能溯源与测试指引

输入一句功能描述，产出“业务摘要 → 真实代码调用链 → 用户可见入口 → UI 文案证据 → QA checklist”。

## Pi 工具约定

- 用 `bash` 执行 `rg --files`、`rg -n`、`find`、`git log/show` 做发现和搜索。
- 用 `read` 阅读目标文件，不使用 `cat`、`sed` 代替。
- 本 Skill 只分析和输出报告，不修改项目文件。
- 所有结论必须有文件和行号证据；找不到时明确写“未找到”，不能编造。

## 核心原则

1. **双向追溯**：后端路由 → handler → service → repository，同时前端 API → 页面组件 → 路由 → 菜单。
2. **真实渲染树优先**：同名组件可能有上游版、影子版和旧版；必须沿当前路由/import 确认实际生效文件。
3. **字段证据优先**：最终落到按钮、标签、表头、Toast 等用户肉眼可见文案。
4. **中英文对照**：有 i18n 时给出 key、中文、英文和文件:行号；无 i18n 时列硬编码文案。
5. **禁止幻觉**：需求名和代码术语不一致时列候选，不猜相近功能。
6. **分层准确**：CloudRouter 后端遵守 handler → service → repository，不把 repository 逻辑误写成 handler 行为。

## Phase 1：项目探测

先建立项目地图。使用：

```bash
rg --files -g 'package.json' -g 'pnpm-workspace.yaml' -g 'go.mod' -g 'Cargo.toml'
rg --files | rg '(^|/)(router|routes|pages|views|components|i18n|locales|api|services?|handlers?|repositories?)/'
```

记录：

- 前端框架与 package 路径
- 路由文件
- 侧边栏/菜单组件
- i18n 中文与英文文件
- 前端 API 封装目录
- 后端路由、handler、service、repository 目录
- monorepo 中目标 app

CloudRouter 特别检查：

- `apps/console` 与 `apps/console-v2`
- `router/index.ts` 与 `router/clouditera/index.ts`
- 上游组件与 `clouditera` 影子组件
- `internal/server/routes`、`internal/handler`、`internal/service`、`internal/repository`

## Phase 2：关键词提取

从输入抽取：

- 1–3 个名词概念
- 1–2 个操作动词
- 中英文和常见代码命名变体
- Issue/PR/commit 编号（若有）

先用多个窄查询，不要直接对整个仓库输出海量结果：

```bash
rg -n -i 'keyword1|关键词1' <候选目录>
git log --oneline --all --grep='keyword' -20
```

## Phase 3：后端追溯

1. 从路由或 handler 搜索核心词。
2. 用 `read` 阅读命中函数上下文。
3. 反查路由注册，确认 HTTP 方法、路径和中间件/权限。
4. 沿调用链定位 service 和 repository。
5. 记录数据表、Redis、第三方 API 和副作用。

输出证据格式：

```text
apps/.../routes/foo.go:42 POST /api/v1/foo
apps/.../handler/foo.go:88 HandleFoo
apps/.../service/foo.go:131 CreateFoo
apps/.../repository/foo.go:57 Insert
```

纯前端功能应明确标注“未涉及后端”；不要强行寻找不存在的 API。

## Phase 4：前端追溯

1. 用后端 API 路径搜索前端 API 封装。
2. 用封装函数名搜索实际调用页面/组件。
3. 沿 route `component`/dynamic import 确认真实渲染组件。
4. 沿菜单配置确认角色可见性和菜单路径。
5. 收集页面中的 i18n key、硬编码文案、按钮、标签、表头、Toast 和 placeholder。
6. 在 zh/en locale 中定位对应值与行号。

必须防止“修错/查错组件树”：如果存在多个候选，逐一说明为什么某个生效、其他不生效。

## Phase 5：Git 证据（可选）

输入像 commit/PR/changelog 时：

```bash
git log --oneline --all --grep='<keyword>' -20
git show <sha> --stat
git show <sha> -- <target-files>
```

Git 证据用于精化，不替代当前代码调用链确认。

## 输出模板

```markdown
# <20 字以内标题>

## 业务摘要

<3–5 句话：问题、角色、触发、流程、结果和上下游。>

## 代码调用链

| 层级 | 位置 | 证据 |
|---|---|---|
| 路由 | `file:line` | `METHOD /path` |
| Handler | `file:line` | `FuncName` |
| Service | `file:line` | `MethodName` |
| Repository/外部依赖 | `file:line` | 表/Redis/API |
| 前端 API | `file:line` | `func()` |
| 页面/组件 | `file:line` | 实际渲染组件 |

## 前端入口

**角色与菜单路径**：<角色> → <菜单组> → <菜单项> → <页面> → <交互元素>

### UI 字段证据

| i18n key/硬编码 | 中文 | English | 类型 | 位置 |
|---|---|---|---|---|
| `key` | 文案 | Text | 按钮 | `zh.ts:1 / en.ts:1 / View.vue:1` |

## 生效树判定

- 实际路由/import：...
- 被排除的同名候选：...（原因）

## QA Checklist

### Golden Path
- [ ] ...

### 边界条件
- [ ] ...

### 异常场景
- [ ] ...

### 权限场景
- [ ] ...

### 回归点
- [ ] ...

## 复现路径

1. 以 `<角色>` 登录
2. 点击 `<用户可见菜单文案>`
3. 操作 `<按钮/字段文案>`
4. 观察 `<明确结果>`

## 未确认项

- 未找到/多候选/需产品确认的内容
```

## 完成前检查

- [ ] 找到唯一真实路由和渲染树，或明确列出候选。
- [ ] 后端调用链没有跨层误判。
- [ ] 至少给出一个用户可见字段证据；纯后端任务明确说明无 UI。
- [ ] i18n 文案真实存在，带文件:行号。
- [ ] QA 覆盖成功、边界、异常、权限和回归。
- [ ] 不把推断写成事实。
