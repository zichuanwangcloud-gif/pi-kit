# Pi Extension 开发笔记

## 生命周期

- `input` 在 Skill/Template 展开前触发。
- `before_agent_start` 适合按轮注入系统提示。
- `agent_end` 后可能还有 retry、compaction 或 follow-up。
- 需要“真正空闲”时使用 `agent_settled`。
- `/reload` 会重建 Extension；恢复中的自动化任务应默认暂停，不能静默续跑。

## Skill

- Pi 启动时只把 Skill 的 name/description 放入上下文。
- `/skill:name` 是 Pi 原生展开入口。
- Extension 的 `pi.sendUserMessage()` 会跳过 command/template expansion；扩展若要调度 Skill，需要自行读取 Skill 或把内容直接作为工具结果返回。
- Skill 相对路径以 `SKILL.md` 所在目录为准，不应依赖资源发现根目录或作者机器上的绝对路径。
- `metadata.source` 如果需要保留，应使用可公开、可复现的来源标识，不应记录本机内部仓库路径。

## 通用扩展设计

- 名称、entry type、帮助标题和错误信息避免包含某个业务项目名。
- 项目可变项应来自命令参数、仓库配置或运行时探测。
- 无法安全推导的分支、目录、命令和外部目标应询问用户，不设置组织专属默认。
- 示例仅用于解释 API；不要让示例路径进入运行时安全判断。

## 状态

- `pi.appendEntry()` 不进入模型上下文，适合持久状态和帮助卡片。
- 可在 `session_start` 扫描 branch 中最新 custom entry 恢复状态。
- 自动任务在 reload/resume 后应先恢复为 paused。
- 状态应记录实际 `cwd`、branch 和用户确认后的参数，不能依赖固定仓库路径。

## 输出

- 自定义工具输出必须截断，大日志写入 `~/.pi/agent/state/` 或临时文件。
- 帮助信息使用 entry renderer，可避免调用模型和占用 token。
- 对自动发现的配置应显示证据来源，便于用户纠正。

## Package

- 用 `package.json` 的 `pi.extensions` / `pi.skills` 显式声明资源。
- 本地开发：`pi install /absolute/path/to/package`
- 跨机器：使用可信 Git URL，并尽量固定 tag 或 commit。
- 扩展有完整用户权限，只安装已审阅的仓库。
- package description、keywords、文件名和测试都属于公开接口，应保持项目中立。
