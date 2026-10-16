---
name: wyy-publisher
description: |
  网易号（mp.163.com）文章发布 Skill。
  支持自动填标题 + DraftJS 正文粘贴注入 + 正文配图上传 + 封面设置 + 发布。
  触发词：网易号发布、发文章到网易号、发网易号
---

# 网易号文章发布 Skill v2（playwright-core CDP 版）

> 2026-09-27 全流程实测重构。v1 的 xb CLI 路线、ws 模块脚本（lib.js/publish.js/login.js 等）已全部删除——`ws` 模块环境里没有装，那些脚本跑不起来，且 appendChild 填正文方法被证伪。

## 适用场景

将文章（标题+正文+正文配图）发布或存草稿到网易号创作平台（mp.163.com）。

## 前置条件

| 依赖 | 说明 |
|------|------|
| playwright-core | **无需手工指定路径**：由 `../../isolated-browser/scripts/pathkit.js` 运行时探测（WorkBuddy 托管 node → OpenClaw/qclaw 安装目录 → 就近 node_modules）。要强制指定时设 `OPENCLAW_NODE_MODULES` |
| 隔离 Chrome | 用 isolated-browser 的 launch.js 拉起，profile `~/.chrome_qclaw_wyy`（登录态持久） |
| 账号已实名 | **未实名的账号发布按钮点了没反应**。实名只能在手机端"网易新闻"App（我的→创作中心→去实名认证）完成，需身份证+人脸，网页端无法代办 |
| 账号已上线 | **「账号未上线」的账号点发布会被弹窗拦截**（2026-10-13 实测）。内容/封面已自动存草稿箱，上线后打开草稿直接发布 |
| 正文 ≥250 字 | 少于 250 字不会被分发到头条等展现位置 |
| 截图 | 本页 `page.screenshot` 会 30s 超时，**必须用 CDP `Page.captureScreenshot`**（publish.cjs 已内置 `cdpShot()`） |

### 启动隔离 Chrome（必须后台保活）

沙箱会回收 detached 子进程，必须 `run_in_background: true` 执行。
⚠️ profile 实际是 `~/.chrome_qclaw_wangyi2`（早前文档写的 `.chrome_qclaw_wyy` 不存在）；
与主实例（9222）并行运行时必须用独立端口（如 9223）：

```bash
ISOB_PROFILE_DIR="$HOME/.chrome_qclaw_wangyi2" ISOB_CDP_PORT=9223 \
  node "$HOME/.workbuddy/skills/isolated-browser/scripts/launch.js" \
  "https://mp.163.com/#/article-publish" && sleep 7200
```

### 运行脚本

> playwright-core 的路径由脚本自己探测，**不需要**再设 `NODE_PATH`。

```bash
# 登录（已有登录态会自动跳过；凭据走环境变量，不要写进文件）
WYY_ACCOUNT="<邮箱或手机号>" WYY_PASSWORD="<密码>" node scripts/login.cjs

# 填充+插图+预览（不发布，草稿自动保存）；配图默认 3 张（按标签从素材库自动挑）
node scripts/publish.cjs title.txt body.txt --keyword "婚车租车" --tags "婚庆用车,婚庆婚车车队" --cdp 9223
node scripts/publish.cjs title.txt body.txt --image a.jpg --image b.jpg --image c.jpg --cdp 9223   # 手动 3 张

# 正式发布
node scripts/publish.cjs title.txt body.txt --keyword "婚车租车" --tags "婚庆用车,婚庆婚车车队" --publish --cdp 9223
```

## 核心技术要点（实测结论，勿走回头路）

### 1. 正文注入：必须用 paste 事件

- ❌ `innerHTML` 替换 —— DraftJS 忽略
- ❌ `appendChild` 逐段插入 `<p>` —— 视觉上有字，但字数统计"共0字"，**发布出去是空的**（v1 的错误方法）
- ✅ 点击编辑器聚焦 → `Control+End` 移光标 → 构造 `DataTransfer` + `setData('text/plain', 全文)` → 派发 `ClipboardEvent('paste')`

```js
const dt = new DataTransfer();
dt.setData('text/plain', text);
editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
```

### 2. 正文插图：CDP 原生拖拽（2026-10-13 更新）

- ❌ `innerHTML` 替换 —— DraftJS 忽略
- ❌ `appendChild` 逐段插入 `<p>` —— 视觉上有字，但字数统计"共0字"，**发布出去是空的**（v1 的错误方法）
- ❌ **合成 `DragEvent('drop')` + DataTransfer/File（2026-09-27 的旧方法）—— 已证伪**：
  编辑器升级后忽略 isTrusted=false 的拖拽（事件可达但不处理）
- ✅ **CDP `Input.dispatchDragEvent`**（真实事件，`files` 直接传本地路径，无需 base64）：

```js
const client = await page.context().newCDPSession(page);
await client.send('Input.setInterceptDrags', { enabled: true });
const data = { items: [], files: ['D:\\path\\img.jpg'], dragOperationsMask: 1 };
for (const type of ['dragEnter', 'dragOver', 'drop']) {
  await client.send('Input.dispatchDragEvent', { type, x, y, data });  // 落点=光标 selection rect
  await sleep(500);
}
```

- ⚠️ 落点必须取**光标 selection 的 rect**——「编辑器 rect.top+300」公式在页面滚动后会落到
  视口顶部工具栏区（rect.top 为负），drop 无效（2026-10-13 实测坑）
- 图片自动上传到网易图床（dingyue.ws.126.net）并插入光标处
- **正文无图不允许发布**（弹窗"正文中至少上传一张图片"），插图一举两得（配图+满足发布条件）

### 3. 封面：直接选"自动"

`input[type=radio][value=auto]` 用 `evaluate(el => el.click())` 选中。不要碰单图/三图/大图的上传按钮。

### 4. 标题：React setter

`textarea.netease-textarea`，用 `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set` 赋值后派发 input/change/blur 事件。

### 5. 发布结果判定（2026-10-13 更新）

- 点击发布后 URL 不变 + 弹窗「**您的账号未上线，暂不支持发布**」= **账号状态限制**（无法自动化）；
  内容/配图/封面已自动保存在草稿箱，账号上线后打开草稿直接点发布即可（脚本 exit 2）
- URL 不变 + 「请先通过实名认证」= 未实名拦截（`document.body.innerText.includes('请先通过实名认证')`）
- 成功：URL 跳转或出现"发布成功"

## 发布页元素速查

| 元素 | 选择器 |
|------|--------|
| 标题 | `textarea.netease-textarea`（5~30字） |
| 正文编辑器 | `.public-DraftEditor-content`（DraftJS） |
| 字数 | 页面文本 `共(\d+)字` |
| 封面-自动 | `input[type=radio][value=auto]`（另有 threeImg 默认 / custom 单图 / bigImg 大图；单图/大图的上传按钮弹原生对话框勿点） |
| 发布按钮 | `button:visible` 文本恰为"发布" |
| 实名提示条 | "请先通过实名认证再发布内容 去完成>" |
| 账号未上线弹窗 | 「您的账号未上线，暂不支持发布」+ 确认按钮 |
| 工具栏图片按钮 | `.rich-editor-panel-item`（无 title/aria 区分，勿盲点） |

## 常见问题 → 详见 references/troubleshooting.md

- 登录表单在跨域 iframe，密码必须 `pressSequentially` 逐字输入；用 `input[type="password"]:visible` 选框（第一个密码框是隐藏的）
- 首次登录可能触发二次验证：滑块（yidun_slider）+ 短信验证码
- SPA 内 goto hash 有时不生效、404 页没有侧边栏菜单，导航优先从首页菜单点击

## 账号凭据

- 地址：mp.163.com
- **凭据不落盘**：历史版本曾把账号密码明文写在本文件和 `scripts/login.cjs` 里，现已移除。
  需要重新登录时用环境变量传入，不要写进任何文件、也不要提交到仓库：
  ```bash
  WYY_ACCOUNT="<邮箱或手机号>" WYY_PASSWORD="<密码>" node scripts/login.cjs
  ```
  正常情况下登录态已持久化在隔离 profile（`ISOB_PROFILE_DIR`）里，无需重复登录。
- ⚠️ 该密码曾以明文提交进 git 历史，**建议到网易号后台改密**，并清理仓库历史。

## 文件结构

```
wangyi-publish-skill/
  SKILL.md                      # 本文件
  scripts/
    publish.cjs                 # 发布主脚本（paste 正文 + drop 插图 + 自动封面 + 发布）
    login.cjs                   # 登录脚本（跨域 iframe 逐字输入）
  references/
    workflow.md                 # 详细流程
    troubleshooting.md          # 问题与解决方法全记录
```
