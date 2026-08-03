# 贡献与通用化指南

本文用于防止 Pi Kit 再次与某个业务仓库、团队或技术栈绑定。

## 通用能力与项目约定的边界

适合进入 Pi Kit：

- 可跨仓库复用的任务步骤与安全闸门
- 通过探测或参数适配的 Git、Issue、PR 工作流
- 框架无关的代码检索、证据整理和验证策略
- Pi Extension/Skill 的实现经验

应留在目标项目：

- 固定绝对路径、仓库名称、公司名和内部命名空间
- 某个团队的 Issue key
- 固定的默认/发布/测试分支流向
- 特定 package、模块、测试路径和 commit scope
- 只有内部网络可访问的文档和凭据说明

如果项目确有特殊约定，应写入该项目的 `AGENTS.md`、`CLAUDE.md`、贡献指南或项目级 Skill，而不是写死在本包。

## Skill 设计检查

### Frontmatter

- `name` 稳定、简短，符合 Agent Skills 命名规则。
- `description` 描述产出、输入和触发场景，避免只写“辅助开发”。
- `compatibility` 只列真实依赖，不声称专用于某个仓库。
- `metadata` 不保留本机绝对来源路径。
- `allowed-tools` 遵循最小权限。

### 正文

- 先做项目探测，再使用框架或目录假设。
- 所有可变约定都应按“显式参数 → 项目文档/仓库配置 → 安全默认 → 询问”的顺序解析。
- 示例使用 `TEAM-123`、`develop`、`packages/web` 等中性占位符，并明确它们只是示例。
- 外部副作用需明确授权边界、前置确认点和停止条件。
- 将长篇、低频参考放在 `references/`，保持 `SKILL.md` 可审阅。

## 文档写作检查

- README 从“这个包适用于谁”开始，而不是从某个内部项目开始。
- 安装 URL 使用占位符或解释为 fork 地址，不绑定个人仓库。
- 命令示例应可被替换，不暗示唯一技术栈。
- 安全规则区分“工具默认策略”和“目标仓库真实策略”。
- 对自动化能力准确描述，不把规划能力写成已安装能力。

## 代码审查命令

```bash
npm run check
rg -n -i 'company-name|repo-name|/absolute/internal/path' \
  README.md docs skills extensions package.json
```

第二条命令中的关键词应替换为本次迁移前的专属名称。命中历史说明时也应确认它是否仍有保留价值。

## 发布前清单

- [ ] package metadata 不含特定客户、公司或仓库名称。
- [ ] Extension 文件名、entry type、帮助标题均为中性名称。
- [ ] Skill 不固定 Issue key、base branch、worktree 根目录或 commit scope。
- [ ] 测试验证的是通用策略，而非某个项目的字符串。
- [ ] README、迁移文档、帮助中心和 Skill 对授权边界的表述一致。
- [ ] `npm run check` 通过。
