#!/usr/bin/env node
// 手册操作视频渲染器：steps.json + 截图 → mp4。
//
//   node scripts/render-video.mjs <steps.json> [--out <path.mp4>] [--check]
//
// 设计取向：与手册共用同一批截图，永不再走一遍操作流程。
// 一段截图 = 一个分镜：缓慢推拉 + 底部两行中文说明 + 淡入淡出。
// 依赖系统 ffmpeg（需 libx264 + mp4 muxer + zoompan/drawtext 滤镜）。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const HELP = `用法: node render-video.mjs <steps.json> [--out <path.mp4>] [--check]

steps.json:
{
  "title": "测试任务操作手册",
  "size": "1280x720",
  "fps": 30,
  "intro": { "title": "测试任务操作手册", "subtitle": "版本 feat/concurrency · 2026-11-18" },
  "steps": [
    { "img": "img/1-1.png", "chapter": "第 1 步 · 打开任务列表",
      "caption": "在左侧菜单进入「测试任务」", "hold": 4, "zoom": "in" }
  ]
}

zoom 取值: in | out | none | pan-right | pan-left（默认 in）
hold: 该分镜停留秒数（默认 4）
--check: 只校验依赖与素材，不渲染`;

function die(message, hint) {
	console.error(`✗ ${message}`);
	if (hint) console.error(`  ${hint}`);
	process.exit(1);
}

function run(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
	// spawnSync 在极端情况下（命令不存在、被信号杀死、子进程未产出）会返回 null。
	// 探测链路上任何一环拿不到结果都应当降级成"这条命令不可用"，而不是抛 TypeError。
	if (!result || typeof result !== "object") {
		return { status: -1, stdout: "", stderr: "" };
	}
	return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ---------------------------------------------------------------- ffmpeg 探测

function resolves(cmd) {
	if (!cmd) return false;
	const probe = run(cmd, ["-version"]);
	return probe.status === 0;
}

function fromImageio() {
	for (const python of ["python3", "python"]) {
		const probe = run(python, [
			"-c",
			"import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())",
		]);
		if (probe.status === 0) {
			const path = probe.stdout.trim();
			if (path && existsSync(path)) return path;
		}
	}
	return null;
}

function findFfmpeg() {
	const candidates = [
		process.env.FFMPEG,
		"ffmpeg",
		fromImageio(),
	];
	for (const candidate of candidates) {
		if (resolves(candidate)) return candidate;
	}
	die(
		"找不到可用的 ffmpeg。",
		"安装其一后重跑：sudo apt install ffmpeg ｜ pip install --user imageio-ffmpeg ｜ 或设 FFMPEG=/path/to/ffmpeg",
	);
}

function capabilities(ffmpeg) {
	const encoders = run(ffmpeg, ["-hide_banner", "-encoders"]).stdout ?? "";
	const filters = run(ffmpeg, ["-hide_banner", "-filters"]).stdout ?? "";
	const formats = run(ffmpeg, ["-hide_banner", "-formats"]).stdout ?? "";
	return {
		x264: /\blibx264\b/.test(encoders),
		aac: /\baac\b/.test(encoders),
		mp4: /\bmp4\b/.test(formats),
		zoompan: /\bzoompan\b/.test(filters),
		drawtext: /\bdrawtext\b/.test(filters),
		concat: /\bconcat\b/.test(filters),
	};
}

// ---------------------------------------------------------------- 字体

const FONT_CANDIDATES = [
	"Noto Sans CJK SC",
	"Source Han Sans SC",
	"WenQuanYi Zen Hei",
	"Noto Sans CJK JP",
	"WenQuanYi Micro Hei",
	"Droid Sans Fallback",
];

function findFont(explicit) {
	const requested = [explicit, process.env.MANUAL_FONT].filter(Boolean);
	for (const name of [...requested, ...FONT_CANDIDATES]) {
		const probe = run("fc-match", ["-f", "%{file}", name]);
		if (probe.status !== 0) break;
		const path = probe.stdout.trim();
		if (path && existsSync(path)) return path;
	}
	die(
		"找不到可用的中文字体，视频说明会渲染成方块。",
		"安装中文字体（如 sudo apt install fonts-noto-cjk），或用 MANUAL_FONT=/path/to/font.ttc 指定",
	);
}

// ---------------------------------------------------------------- 素材解析

function loadSteps(file) {
	if (!existsSync(file)) die(`steps.json 不存在：${file}`);
	let spec;
	try {
		spec = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		die(`steps.json 不是合法 JSON：${error.message}`);
	}
	const base = dirname(resolve(file));
	const steps = Array.isArray(spec.steps) ? spec.steps : [];
	if (steps.length === 0) die("steps.json 里没有任何 steps。手册视频至少要有一个分镜。");

	const resolved = steps.map((step, index) => {
		if (!step.img) die(`第 ${index + 1} 个分镜缺少 img。`);
		const img = isAbsolute(step.img) ? step.img : join(base, step.img);
		if (!existsSync(img)) die(`分镜 ${index + 1} 的截图不存在：${img}`);
		return {
			index,
			img,
			chapter: String(step.chapter ?? `第 ${index + 1} 步`).trim(),
			caption: String(step.caption ?? "").trim(),
			hold: Number(step.hold ?? 4),
			zoom: String(step.zoom ?? "in"),
		};
	});
	return { spec, steps: resolved };
}

function duplicateFrames(steps) {
	const seen = new Map();
	const dups = [];
	for (const step of steps) {
		const hash = createHash("md5").update(readFileSync(step.img)).digest("hex");
		if (seen.has(hash)) dups.push([seen.get(hash), step.index]);
		else seen.set(hash, step.index);
	}
	return dups;
}

// ---------------------------------------------------------------- 滤镜

const ZOOM = {
	in: { z: "1+0.0012*on", center: true },
	out: { z: "max(1.30-0.0012*on,1.0)", center: true },
	none: { z: "1.0", center: true },
	"pan-right": { z: "1.18", center: false, x: "(iw-iw/zoom)*on/(on+1)" },
	"pan-left": { z: "1.18", center: false, x: "(iw-iw/zoom)*(1-on/(on+1))" },
};

function escapeFilterPath(path) {
	return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function segmentFilter(step, size, fps, font, files, duration) {
	const motion = ZOOM[step.zoom] ?? ZOOM.in;
	const x = motion.center ? "iw/2-(iw/zoom/2)" : motion.x;
	const y = motion.center ? "ih/2-(ih/zoom/2)" : "ih/2-(ih/zoom/2)";
	const pad = 18;
	const lines = step.caption ? 2 : 1;
	const boxHeight = lines === 2 ? 108 : 76;
	const boxTop = size.height - boxHeight;
	const fadeOut = Math.max(duration - 0.35, 0);

	const parts = [
		// 先放大再推拉，避免锐利文字被直接缩放糊掉
		`scale=${size.width * 2}:-2`,
		`zoompan=z='${motion.z}':x='${x}':y='${y}':d=1:s=${size.width}x${size.height}:fps=${fps}`,
		`drawbox=x=0:y=${boxTop}:w=iw:h=${boxHeight}:color=black@0.72:t=fill`,
		`drawtext=fontfile='${escapeFilterPath(font)}':textfile='${files.chapter}':fontsize=30:fontcolor=white:x=${pad * 2}:y=${boxTop + 14}`,
	];
	if (step.caption) {
		parts.push(
			`drawtext=fontfile='${escapeFilterPath(font)}':textfile='${files.caption}':fontsize=23:fontcolor=0x9fd0ff:x=${pad * 2}:y=${boxTop + 62}`,
		);
	}
	parts.push(
		`fade=t=in:st=0:d=0.35`,
		`fade=t=out:st=${fadeOut.toFixed(3)}:d=0.35`,
		"format=yuv420p",
	);
	return parts.join(",");
}

// ---------------------------------------------------------------- 渲染

function parseSize(raw) {
	const match = String(raw ?? "1280x720").match(/^(\d{2,5})x(\d{2,5})$/);
	if (!match) die(`size 格式应为 宽x高，例如 1280x720，收到：${raw}`);
	return { width: Number(match[1]), height: Number(match[2]) };
}

function render(ffmpeg, spec, steps, font, options) {
	const size = parseSize(spec.size);
	const fps = Number(spec.fps ?? 30);
	const work = mkdtempSync(join(tmpdir(), "manual-video-"));
	const segments = [];

	const encode = (args, label) => {
		const result = run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args], { cwd: work });
		if (result.status !== 0) {
			console.error(result.stderr?.trim());
			die(`渲染失败：${label}`);
		}
	};

	const textFile = (name, text) => {
		const path = join(work, name);
		writeFileSync(path, `${text}\n`, "utf8");
		return name;
	};

	// 片头
	if (spec.intro?.title) {
		const title = textFile("intro-title.txt", spec.intro.title);
		const subtitle = spec.intro.subtitle ? textFile("intro-subtitle.txt", spec.intro.subtitle) : null;
		const filters = [
			`drawtext=fontfile='${escapeFilterPath(font)}':textfile='${title}':fontsize=44:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-24`,
		];
		if (subtitle) {
			filters.push(
				`drawtext=fontfile='${escapeFilterPath(font)}':textfile='${subtitle}':fontsize=24:fontcolor=0x9fd0ff:x=(w-text_w)/2:y=(h-text_h)/2+46`,
			);
		}
		filters.push("fade=t=in:st=0:d=0.5", "fade=t=out:st=2.0:d=0.5", "format=yuv420p");
		const out = join(work, "seg-intro.mp4");
		encode(
			[
				"-f", "lavfi", "-i", `color=c=0x111827:s=${size.width}x${size.height}:r=${fps}:d=2.5`,
				"-vf", filters.join(","),
				"-c:v", "libx264", "-crf", "20", "-r", String(fps), out,
			],
			"片头",
		);
		segments.push(out);
	}

	steps.forEach((step, index) => {
		const files = {
			chapter: textFile(`seg-${index}-chapter.txt`, step.chapter),
			caption: step.caption ? textFile(`seg-${index}-caption.txt`, step.caption) : null,
		};
		const out = join(work, `seg-${index}.mp4`);
		encode(
			[
				"-loop", "1", "-framerate", String(fps), "-t", String(step.hold), "-i", step.img,
				"-vf", segmentFilter(step, size, fps, font, files, step.hold),
				"-c:v", "libx264", "-crf", "22", "-r", String(fps), out,
			],
			`分镜 ${index + 1}`,
		);
		segments.push(out);
	});

	const listFile = join(work, "list.txt");
	writeFileSync(listFile, segments.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n") + "\n");

	const out = resolve(options.out);
	mkdirSync(dirname(out), { recursive: true });
	const concat = run(
		ffmpeg,
		["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", out],
		{ cwd: work },
	);
	if (concat.status !== 0) {
		console.error(concat.stderr?.trim());
		rmSync(work, { recursive: true, force: true });
		die("拼接分段失败。");
	}

	rmSync(work, { recursive: true, force: true });
	return { path: out, size, fps };
}

function probe(ffmpeg, path) {
	const result = run(ffmpeg, ["-hide_banner", "-i", path]);
	const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const duration = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
	const stream = text.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
	const seconds = duration
		? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
		: null;
	return {
		seconds,
		width: stream ? Number(stream[1]) : null,
		height: stream ? Number(stream[2]) : null,
		bytes: statSync(path).size,
	};
}

// ---------------------------------------------------------------- 入口

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
	console.log(HELP);
	process.exit(args.length === 0 ? 1 : 0);
}

const specPath = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--out");
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
const checkOnly = args.includes("--check");

const { spec, steps } = loadSteps(specPath);
const ffmpeg = findFfmpeg();
const caps = capabilities(ffmpeg);

if (!caps.x264 || !caps.mp4 || !caps.zoompan || !caps.drawtext) {
	const missing = [
		!caps.x264 && "libx264 编码器",
		!caps.mp4 && "mp4 封装",
		!caps.zoompan && "zoompan 滤镜",
		!caps.drawtext && "drawtext 滤镜",
	].filter(Boolean);
	die(
		`ffmpeg 不完整（缺 ${missing.join("、")}）：${ffmpeg}`,
		"Playwright 自带的精简 ffmpeg 不能出 mp4。改装完整版：sudo apt install ffmpeg 或 pip install --user imageio-ffmpeg",
	);
}

const font = findFont(spec.font);
const dups = duplicateFrames(steps);
if (dups.length > 0) {
	console.error(
		`! 检测到重复截图：${dups.map(([a, b]) => `分镜 ${a + 1} 与 ${b + 1}`).join("，")}。` +
			"页面没变或截到了陈旧帧，视频里会出现两段一模一样的画面。",
	);
}

if (checkOnly) {
	console.log(`✓ 依赖与素材就绪：${steps.length} 个分镜，ffmpeg=${ffmpeg}`);
	console.log(`  字体：${font}`);
	process.exit(0);
}

const target = outPath ?? join(dirname(resolve(specPath)), "manual-video.mp4");
const { path } = render(ffmpeg, spec, steps, font, { out: target });
const info = probe(ffmpeg, path);

if (!info.seconds || info.bytes < 20 * 1024) {
	die(`渲染结果异常：${info.seconds ?? "?"}s，${info.bytes} 字节。`);
}

const planned = steps.reduce((sum, step) => sum + step.hold, 0) + (spec.intro?.title ? 2.5 : 0);
if (Math.abs(info.seconds - planned) > 1.5) {
	console.warn(`! 实际时长 ${info.seconds.toFixed(1)}s 与计划 ${planned.toFixed(1)}s 偏差较大，检查 hold 与 fade 参数。`);
}

console.log(`✓ ${path}`);
console.log(
	`  ${info.width}x${info.height} · ${info.seconds.toFixed(1)}s · ${steps.length} 个分镜 · ${(info.bytes / 1024 / 1024).toFixed(1)} MB`,
);
