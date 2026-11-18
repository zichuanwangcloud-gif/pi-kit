# 操作视频：分镜登记与渲染

手册视频**不是录屏**，是用本次走查的截图合成的一段带中文说明的短片。这样手册与视频永远同源：改了正文，重跑一条命令就能重出视频，不用再走一遍操作流程。

```text
走查截图 → steps.json（分镜） → render-video.mjs → manual-video.mp4 → 内嵌进手册
```

## 1. 分镜文件放在哪

与截图同目录，命名固定为 `steps.json`，放在 `img/` 的兄弟目录（即手册源目录根下）：

```text
/opt/<project>/.scratch/<feature>-manual/
├── img/1-1.png
├── steps.json
├── sections/1.md
└── manual-video.mp4        ← 渲染产物
```

`img` 里的路径写相对 `steps.json` 的路径，换成绝对路径也能跑，但相对路径更利于整目录搬走。

## 2. steps.json 结构

```json
{
  "title": "测试任务操作手册",
  "size": "1280x720",
  "fps": 30,
  "intro": { "title": "测试任务操作手册", "subtitle": "版本 feat/concurrency · 2026-11-18" },
  "steps": [
    {
      "img": "img/1-1.png",
      "chapter": "第 1 步 · 打开任务列表",
      "caption": "在左侧菜单进入「测试任务」，默认只显示分配给我的任务",
      "hold": 4,
      "zoom": "in"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `title` | 视频标题，也用于缺省文件名 |
| `size` | 输出尺寸，默认 `1280x720`；宽屏手册用 `1920x1080` |
| `fps` | 默认 30；调低到 24 体积更小，肉眼几乎无差 |
| `intro` | 可选片头，2.5 秒；`subtitle` 放版本与批次日期 |
| `steps[].img` | 截图路径（必填） |
| `steps[].chapter` | 底部第一行，写「第 N 步 · 动作名」 |
| `steps[].caption` | 底部第二行，一句话说明；可省略 |
| `steps[].hold` | 该分镜停留秒数，默认 4；文字多的画面给 5–6 |
| `steps[].zoom` | `in` / `out` / `none` / `pan-right` / `pan-left`，默认 `in` |

### 分镜怎么挑

- 一本手册 **6–20 个分镜**为宜。少于 6 个讲不清主流程，多于 20 个没人看完——细节留给图文手册。
- 一个分镜 = 一个"用户此刻眼睛看向哪"。同一屏连拍三张（填表前、填表中、填完）只留**填完**那张最有信息量的。
- 相邻分镜用不同 `zoom`：`in` 推进细节、`out` 拉远看全局、`pan-*` 横移看长列表。连续五个 `in` 会让观众失去节奏感。
- **不要**把加载骨架屏、调试弹窗、报错 toast 收进分镜。它们属于「走查发现的问题」，写进报告，不进视频。
- 页面首屏与结果页各必有一条；分步操作至少一条。

### 文案怎么写

- `chapter`：8–14 字，动作动词开头（"打开任务列表""提交审核"）。
- `caption`：20–45 字，讲**这一步做什么、要点在哪**，不讲原理。术语照抄页面上的字。
- 不写"点击这里"这类空话，也不出现路由名、组件名、代码。

## 3. 渲染

```bash
SK=<本 skill 目录>
node "$SK/scripts/render-video.mjs" steps.json --check                 # 只验依赖与素材
node "$SK/scripts/render-video.mjs" steps.json --out manual-video.mp4  # 正式渲染
```

成功输出形如：

```text
✓ /path/manual-video.mp4
  1280x720 · 14.5s · 3 个分镜 · 0.7 MB
```

渲染器自带三道自检：

- **重复帧**：截图字节相同 → 警告"页面没变或截到陈旧帧"。
- **时长偏差**：实际时长与 `hold` 之和差超过 1.5 秒 → 警告。
- **产物过小**：成片 < 20 KB 或时长读不出 → 直接判失败。

告警不阻断渲染。但交付报告里必须交代：要么分镜已修，要么写明为什么这个告警可以接受。

## 4. 依赖与排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `找不到可用的 ffmpeg` | 系统没装 | `sudo apt install ffmpeg`，或 `pip install --user imageio-ffmpeg`，或 `FFMPEG=/path/to/ffmpeg` |
| `ffmpeg 不完整（缺 libx264…）` | 用的是 Playwright 自带的精简 ffmpeg，它只能编 webm、没有 zoompan/drawtext | 同上装完整版；不要把 PATH 指向 `ms-playwright/ffmpeg-*` |
| `找不到可用的中文字体` / 字幕全是方块 | 缺 CJK 字体 | `sudo apt install fonts-noto-cjk`，或 `MANUAL_FONT=/path/to/font.ttc` |
| 时长是十几二十分钟 | `zoompan` 的 `d=` 写成了总帧数 | 渲染器已固定 `d=1`，靠 `-t` 控时长；自己改滤镜时别动它 |
| 字幕串行/报错 | 文案里有 `:` `'` `%` | 渲染器用 `textfile=` 规避转义，别改回 `text=` 内联 |
| 文字发虚 | 截图先缩后放大 | 渲染器已先 `scale` 放大再推拉；截图本身用 `device_scale_factor=2` 更清楚 |

字体探测顺序：`steps.json` 的 `font` → `$MANUAL_FONT` → `fc-match` 依次试 Noto Sans CJK SC / Source Han Sans SC / WenQuanYi Zen Hei / Noto Sans CJK JP。

## 5. 发布

- 单页 HTML 手册：把视频放同目录，正文顶部插入

  ```html
  <video controls preload="metadata" src="manual-video.mp4" style="width:100%;border-radius:8px"></video>
  ```

- Markdown 源：`<video>` 标签在多数渲染器里可用；不支持时退化为一行链接 `[观看操作视频](manual-video.mp4)`，**不要**只留视频不留文字版。
- 手册站有独立资源目录（如 `public/shots/<id>/`）时，视频放同一批目录并保持相对引用不变。
- 视频文件一般 **0.5–5 MB**。超过 10 MB 先降 `fps` 到 24、`size` 到 1280x720，再看是否 `hold` 过长。
