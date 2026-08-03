# Linear → PR 使用经验

## 需求来源不只有正文

Linear 评论区经常包含：

- 产品需求或设计说明
- 原型与附件
- 验收标准和测试补充
- 对正文的修订或否定

因此必须按时间顺序审阅全部评论、附件和关键文档，不能只看 issue description，也不能只看关键词命中的评论。

## 冲突处理

较新的评论不自动拥有覆盖权。只有出现“最终方案”“以此为准”“旧方案取消”等明确证据，才能作为候选最新口径；否则应列出冲突并询问用户。

## 项目标识与输入

Linear identifier 应优先使用完整形式，例如 `ENG-123`。不同项目的 team key 不同，Skill 不应写死团队 key。

裸数字输入仅在显式配置 `LINEAR_TEAM_KEY` 时才可补全：

```bash
export LINEAR_TEAM_KEY=ENG
```

未配置时应询问，而不是选择任意团队。

## 代码落点

同一仓库可能存在旧版/新版页面、平台覆写组件、生成代码或多个服务实现。必须从实际路由、注册关系和 import 沿调用链确认真实生效文件，避免只按同名文件或关键词判断。

分层名称因项目而异。报告应使用代码真实存在的层次，例如 controller/use-case/adapter、route/handler/service/repository，不能把某种架构模板强加给所有项目。

## Git 基线与隔离

通用解析顺序：

1. 用户显式给出的 `--base <branch>`。
2. 目标仓库的 `AGENTS.md`、贡献指南或其他明确工作流文档。
3. 远程默认分支和已有 PR 约定。
4. 仍有歧义时询问用户。

确认后：

- `git fetch origin <base>`
- 显式以 `origin/<base>` 为 worktree base
- 在独立任务分支/worktree 中修改
- 主工作区 dirty 时不做 reset/clean/stash
- PR base 使用同一个已确认基线

不要假定每个项目都使用 `dev`，也不要假定任务分支只能叫 `feature/*` 或 `fix/*`；优先遵循仓库规范。

## 自动 PR 的授权边界

用户确认需求理解卡和实施计划后，Skill 可在验证通过后自动：

- 提交本任务文件
- 推送本任务分支（不 force）
- 创建到已确认 base 的 PR

授权不包括：

- 直推受保护分支
- force push
- 合并、approve 或 ready PR
- 回写 Linear
- 发布、部署或操作生产环境

## 验证

Skill 应从目标项目读取实际命令，例如：

- `package.json` / workspace scripts
- `Makefile` / task runner 配置
- `go.mod`、`Cargo.toml`、构建文件
- `AGENTS.md` / `CLAUDE.md` / contributing guide

报告必须区分已通过、失败和未执行的验证，不应把某个项目的命令当作通用默认。

## 凭据

Linear API key 可来自：

1. `LINEAR_API_KEY`
2. `LINEAR_API_KEY_FILE`
3. `~/.config/pi/linear-api-key`

文件权限建议为 `600`。不要把 key 放入 Git、日志、PR body 或会话文本。
