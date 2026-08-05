---
name: feature-trace
description: 从功能描述、Issue、changelog、commit 或 PR 线索追踪当前仓库中的真实代码实现、用户入口、可见文案、依赖调用链，并生成带证据的 QA checklist。用于“功能入口在哪”“实现在哪里”“这个功能怎么测”“提测说明”“功能定位”等请求。仅用于定位现有功能的实现位置和测试点；要评估改动的影响半径请用 `change-impact`，要审计已开 PR 请用 `pr-audit`。
compatibility: Requires a readable project checkout and a code search tool such as ripgrep. Supports monorepos and common frontend/backend stacks without requiring a specific framework.
allowed-tools: read bash
metadata:
  category: code-understanding
  portability: project-agnostic
---

# Feature Trace：功能溯源与测试指引

输入一个功能线索，产出“业务摘要 → 真实代码路径 → 用户入口 → 文案/接口证据 → QA checklist”。

## 工具约定

- 用 `bash` 执行 `rg --files`、`rg -n`、`find`、`git log/show` 等发现命令。
- 用 `read` 阅读目标文件，不使用 `cat`、`sed` 代替。
- 本 Skill 只分析和输出报告，不修改项目文件。
- 所有事实结论尽量提供 `文件:行号`；找不到时明确写“未找到”或“待确认”，不能编造。
- 先读取仓库根目录和目标模块的 `AGENTS.md`、`CLAUDE.md`、贡献指南等项目说明。

## 核心原则

1. **从项目事实出发**：先识别仓库类型、应用边界和架构，再选择追踪路径，不预设 Vue/React/Go 或固定目录。
2. **双向追溯**：可从入口向依赖追踪，也可从 API/事件/数据模型反查调用方，直到两侧证据闭合。
3. **真实生效树优先**：同名组件、旧版页面、平台覆写、生成代码和多服务实现可能并存；必须沿当前注册/import/配置确认实际生效文件。
4. **用户证据优先**：有 UI 时落到菜单、按钮、字段、提示、URL 或 CLI 输出；无 UI 时明确接口、事件或后台触发入口。
5. **国际化不强求**：存在 i18n 时给出 key 和语言值；没有时列硬编码文案；服务端任务不要虚构 UI。
6. **架构忠实**：使用目标项目真实的层级名称和调用关系，不把固定的 handler/service/repository 模板强加给所有代码库。
7. **推断与事实分离**：需求术语和代码术语不一致时列候选与排除依据。

## Phase 0：边界与项目说明

先确认：

```bash
git rev-parse --show-toplevel
git status --short --branch
find . -maxdepth 3 \( -name AGENTS.md -o -name CLAUDE.md \) -not -path './.git/*'
```

只读取当前仓库及相关目标模块的说明。记录：

- 输入指向的 Issue/PR/commit/功能关键词
- 当前 checkout 和分支是否足以代表待测版本
- 是否为 monorepo，以及可能的应用边界
- 项目要求的搜索、生成文件或测试约定

如果用户给的是 Issue URL/编号而当前环境无法读取，应说明缺口，并先基于可用文字做候选搜索，不臆造需求正文。

## Phase 1：项目探测

用有限查询建立项目地图：

```bash
rg --files -g 'package.json' -g 'pnpm-workspace.yaml' -g 'go.mod' \
  -g 'Cargo.toml' -g 'pyproject.toml' -g 'pom.xml' -g 'build.gradle*'
rg --files | rg '(^|/)(router|routes|pages|views|components|locales|i18n|api|controllers?|handlers?|services?|repositories?|cmd)/'
```

根据实际项目记录：

- 用户入口：Web 路由、移动端导航、CLI command、HTTP/RPC route、job/event consumer
- 组合关系：imports、注册表、依赖注入、插件清单、feature flag
- 文案来源：locale、模板、schema、硬编码输出
- 数据与外部依赖：repository/DAO、消息队列、缓存、第三方 API
- 目标 app/package/module

没有某类层次时跳过，不为了套模板而继续搜索。

## Phase 2：关键词与历史线索

从输入提取：

- 1–3 个业务名词
- 1–2 个操作动词
- 中英文、缩写和常见代码命名变体
- Issue/PR/commit 编号
- 可能的 URL、API path、配置 key 或文案

先对候选目录做多个窄查询，再扩展范围：

```bash
rg -n -i 'keyword1|关键词1' <candidate-paths>
git log --oneline --all --grep='keyword' -20
```

搜索无结果时应更换代码术语、查 Git 历史或从用户可见文案反查，不以相似名称直接下结论。

## Phase 3：运行时/后端路径

根据项目架构，从真实注册点开始：

1. 找 route、command、event、job 或 public API 注册。
2. 阅读入口函数上下文，确认权限、中间件、feature flag 和参数。
3. 沿调用关系定位 use case/service/domain/data adapter。
4. 记录数据库、缓存、队列、文件、第三方 API 和其他副作用。
5. 反查调用方，确认该实现确实由当前入口使用。

证据示例：

```text
packages/api/routes/items.ts:42 POST /api/items
packages/api/controllers/items.ts:88 createItem
packages/core/use-cases/create-item.ts:31 execute
packages/db/item-repository.ts:57 insert
```

这是格式示例，不代表项目必须具有这些目录或层次。纯客户端功能应明确标注未发现服务端调用。

## Phase 4：用户入口与前端路径

若功能有 UI：

1. 用 API path、query/mutation、event 或函数名搜索客户端封装。
2. 用封装函数反查实际调用页面/组件。
3. 沿 route、dynamic import、注册表和 feature flag 确认真正渲染树。
4. 沿菜单/导航配置确认角色、权限和可见条件。
5. 收集按钮、标签、表头、toast、placeholder、错误提示等证据。
6. 若使用 i18n，在相关 locale 中定位 key 与语言值。

若功能不是 UI：

- CLI：记录命令、参数、help 文案和输出。
- API：记录鉴权、method/path/schema 和错误响应。
- 后台任务：记录调度、事件来源、开关和可观测结果。

存在多个候选时逐一说明生效/排除依据。

## Phase 5：Git 证据（按需）

输入包含 commit、PR 或 changelog 时：

```bash
git log --oneline --all --grep='<keyword>' -20
git show <sha> --stat
git show <sha> -- <target-files>
```

历史证据只用于解释演变；最终结论必须再次对照当前 checkout。

## Phase 6：形成 QA Checklist

测试点必须从追踪证据生成，至少考虑：

- 正常路径
- 输入/状态边界
- 失败与恢复
- 权限、角色或 feature flag
- 数据/缓存/异步副作用
- 相关入口和旧行为回归
- 多语言或可访问性（项目适用时）

无法在静态代码中确认的运行环境、账号、数据和第三方依赖列为测试前置或未确认项。

## 输出模板

```markdown
# <简短标题>

## 业务摘要
<问题、角色/调用方、触发、流程和结果。>

## 项目与版本边界
- 仓库/模块：...
- 当前分支/提交：...
- 项目说明：`AGENTS.md:...`

## 代码调用链
| 层级/职责 | 位置 | 证据 |
|---|---|---|
| 入口 | `file:line` | route/command/event |
| 编排/领域 | `file:line` | function/class |
| 数据/外部依赖 | `file:line` | DB/cache/queue/API |
| 客户端调用 | `file:line` | function/query |
| 页面/输出 | `file:line` | 实际生效组件/模板 |

## 用户入口
**角色/调用方与路径**：<导航、URL、CLI 或 API 入口>

### 可见字段/接口证据
| key/字段/硬编码 | 中文/值 | English/类型 | 位置 |
|---|---|---|---|
| `key` | 文案 | Text | `file:line` |

## 生效路径判定
- 实际注册/import/config：...
- 被排除候选：...（原因）

## QA Checklist
### Golden Path
- [ ] ...
### 边界条件
- [ ] ...
### 异常与恢复
- [ ] ...
### 权限/开关
- [ ] ...
### 回归点
- [ ] ...

## 复现或调用路径
1. ...

## 未确认项
- ...
```

对不适用的表格或章节可删减，但必须说明没有 UI、没有后端或没有 i18n，而不是留出虚构内容。

## 完成前检查

- [ ] 已读取适用的项目说明。
- [ ] 找到唯一真实注册/渲染/调用路径，或明确列出候选。
- [ ] 使用项目真实架构名称，没有跨层误判。
- [ ] 至少给出一个用户可见或调用者可观察的证据。
- [ ] 历史结论已对照当前 checkout。
- [ ] QA 覆盖成功、边界、异常、权限/开关和回归。
- [ ] 推断、未找到项和事实明确区分。
