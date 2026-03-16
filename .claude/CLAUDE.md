# Plan 相关（AI 完成后别忘更新）

`plan/` 为项目规划目录（gitignored），结构与约定见 `plan/README.md`。做完与 plan 相关的开发后请做以下更新，避免状态滞后。

## 目录与文件名

- **plan/** 下：`ROADMAP.md`、`STATUS.md`、`ideas/`、`tech-ideas/`、`marketing/`、`features/`
- 文档命名：`NNN-简短描述性-slug.md`（三位数 + kebab-case，如 `001-local-ui-first-class.md`）
- 新文档按此命名；已有文档不必为符合约定而改名

## 语言

- `plan/` 下所有文档全部用**中文**撰写

## 状态约定（frontmatter）

在 **ideas/**、**tech-ideas/**、**marketing/**、**features/** 下的 `.md` 顶部用 YAML 标注状态：

```yaml
---
status: draft | planned | in_progress | pr | done
pr: 42              # 可选
done_at: 2025-03-08 # 可选
note: 一句话备注     # 可选
---
```

## 做完后必做

- **完成某个 feature / idea 的实现**
  → 打开对应 `plan/features/` 或 `plan/ideas/` 或 `plan/tech-ideas/` 或 `plan/marketing/` 下的文档，把 frontmatter 里 `status` 改为 `done`，并可选填 `done_at`、`note`。
- **开了 PR**
  → 该文档 frontmatter 里设 `status: pr`，并填 `pr: <号或 URL>`。
- **总览**
  → 若该条目在 `plan/STATUS.md` 的表里，顺手更新该行的状态/备注。

这样下次看 plan 或 STATUS 时，不会误以为还没做完。

# Agent 自验原则

> 核心原则：**agent 自己验证，不消耗用户时间。** 永远不要把"你刷新一下试试"当作验证手段。

## E2E 测试体系

项目有完整的 E2E 测试，agent 改完代码后**必须运行**来确认没有搞坏产品：

```bash
pnpm build && pnpm test:e2e   # 构建后跑 E2E（13 个测试，~3s）
```

E2E 覆盖的关键流程：
- **generated-html**（7 tests）— fixture → parse → transform → 生成 HTML → Playwright 打开浏览器验证：无 console 错误、self-contained 无外部请求、数据正确嵌入、scene 渲染、用户 prompt 可见、无错误状态、title 正确
- **editor-server**（4 tests）— Hono server API 正常、viewer HTML 带 editor flag、浏览器能加载
- **cli-smoke**（2 tests）— `--version` 和 `--help` 正常

## 不同改动的验证策略

**改 viewer（`packages/viewer/`）：**
1. `pnpm build && pnpm test:e2e` — 确认生成的 HTML 在浏览器中正常渲染
2. 如需视觉验证，用 Playwright 截图：
   ```typescript
   import { chromium } from "playwright";
   const browser = await chromium.launch();
   const page = await browser.newPage();
   await page.goto("file:///path/to/generated/index.html");
   await page.screenshot({ path: "/tmp/screenshot.png" });
   ```
3. 如果改动涉及新 UI 功能，**在 `e2e/generated-html.test.ts` 中添加对应断言**

**改 CLI/API（`packages/cli/src/`）：**
1. `pnpm test` — 单元测试
2. `pnpm build && pnpm test:e2e` — 确认 CLI 启动正常、API 返回正确、生成的 HTML 不坏

**改共享类型（`packages/types/`）：**
1. `pnpm test && pnpm build && pnpm test:e2e` — 全量验证

**改 generator/transform 等核心管线：**
1. 必须跑 E2E — 这些改动最容易导致产出的 HTML 在浏览器中报错（如 `</` 转义、`</head>` 注入位置等）

## 如何用 Playwright 做 ad-hoc 验证

E2E 测试之外，如果需要验证具体的 UI 行为（布局、交互、z-index 等），直接用 Playwright：

```typescript
import { chromium } from "playwright";

// 方式 1：验证生成的静态 HTML
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("file:///path/to/index.html", { waitUntil: "networkidle" });
await page.screenshot({ path: "/tmp/verify.png" });

// 方式 2：验证 dev server（pnpm dev 运行中）
await page.goto("http://localhost:5173/?view=dashboard");
await page.screenshot({ path: "/tmp/dashboard.png" });

// 方式 3：验证 editor server
await page.goto("http://localhost:13456/?session=some-slug");
await page.screenshot({ path: "/tmp/editor.png" });
```

## E2E 测试文件

| 文件 | 用途 |
|------|------|
| `e2e/helpers.ts` | 共享：fixture → parse → transform → generate HTML |
| `e2e/generated-html.test.ts` | 生成的 HTML 在浏览器中的完整验证 |
| `e2e/editor-server.test.ts` | Server API + viewer 加载 |
| `e2e/cli-smoke.test.ts` | CLI 启动基本检查 |
| `e2e/vitest.config.ts` | E2E 专用 vitest 配置（30s timeout） |

## 添加新 E2E 测试

新增 UI feature 时，**必须**在 `e2e/generated-html.test.ts` 或新文件中添加对应测试。模式：

```typescript
it("new feature works", async () => {
  // page 已在 beforeAll 中打开了生成的 HTML
  const element = page.locator("[data-testid='my-feature']");
  await expect(element).toBeVisible();  // 或用 page.textContent + expect
});
```

开发模式下的 HMR：
- `pnpm dev` — Viewer HMR (Vite :5173) + CLI auto-restart (tsx watch :13456)
- `pnpm dev:website` — Website (Astro) + Viewer (Vite) HMR
- 改 viewer/CLI 源码自动生效，无需手动 build 或重启
