# Linear → PR 使用经验

## 需求来源不是只有正文

Linear 评论区经常包含：

- 产品 PRD
- 原型/设计文档
- 验收标准
- 测试补充
- 对正文的修订或否定

因此必须按时间顺序审阅全部评论、附件和关键文档，不能只看 issue description，也不能只看关键词命中的评论。

## 冲突处理

较新的评论不自动拥有覆盖权。只有出现“最终方案”“以此为准”“旧方案取消”等明确证据，才能作为候选最新口径；否则应列出冲突并询问用户。

## 代码落点

CloudRouter 可能同时存在上游组件与 `clouditera` 影子组件。必须从实际路由和 import 沿调用链确认真实生效文件，避免修错同名组件。

## Git 隔离

- `git fetch origin dev`
- 显式以 `origin/dev` 为 base
- 在独立 feature/fix worktree 中修改
- 主工作区 dirty 时不做 reset/clean/stash
- push 和 PR 是外部动作，需在实现和验证后获得确认

## 凭据

Linear API Key 只存到：

```text
~/.config/pi/linear-api-key
```

权限必须为 `600`。不要进入 Git、日志或会话文本。
