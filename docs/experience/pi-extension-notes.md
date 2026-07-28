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
- Skill 相对路径以 `SKILL.md` 所在目录为准，不应依赖资源发现根目录。

## 状态

- `pi.appendEntry()` 不进入模型上下文，适合持久状态和帮助卡片。
- 可在 `session_start` 扫描 branch 中最新 custom entry 恢复状态。
- 自动任务在 reload/resume 后应先恢复为 paused。

## 输出

- 自定义工具输出必须截断，大日志写入 `~/.pi/agent/state/` 或临时文件。
- 帮助信息用 entry renderer，可避免调用模型和占用 token。

## Package

- 用 `package.json` 的 `pi.extensions` / `pi.skills` 显式声明资源。
- 本地开发：`pi install /absolute/path/to/package`
- 跨机器：发布私有 Git 仓库后用 `pi install git:<url>@<tag>`。
- 扩展有完整系统权限，只安装可信仓库。
