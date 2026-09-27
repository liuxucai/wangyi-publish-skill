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
| playwright-core | 位于 `~/.workbuddy/binaries/node/workspace/node_modules`，运行时设 `NODE_PATH` 指向该目录 |
| 隔离 Chrome | 用 isolated-browser 的 launch.js 拉起，profile `~/.chrome_qclaw_wyy`（登录态持久） |
| 账号已实名 | **未实名的账号发布按钮点了没反应**。实名只能在手机端"网易新闻"App（我的→创作中心→去实名认证）完成，需身份证+人脸，网页端无法代办 |
| 正文 ≥250 字 | 少于 250 字不会被分发到头条等展现位置 |

### 启动隔离 Chrome（必须后台保活）

沙箱会回收 detached 子进程，必须 `run_in_background: true` 执行：

```bash
ISOB_PROFILE_DIR="C:/Users/甲骨龙集成电脑/.chrome_qclaw_wyy" \
  node "C:/Users/甲骨龙集成电脑/.workbuddy/skills/isolated-browser/scripts/launch.js" \
  "https://mp.163.com/#/article-publish" && sleep 7200
```

### 运行脚本

```bash
# 登录（已有登录态会自动跳过）
NODE_PATH="C:/Users/甲骨龙集成电脑/.workbuddy/binaries/node/workspace/node_modules" \
  node scripts/login.cjs

# 填充+插图+预览（不发布，草稿自动保存）
NODE_PATH="..." node scripts/publish.cjs title.txt body.txt D:/path/image.jpg

# 正式发布
NODE_PATH="..." node scripts/publish.cjs title.txt body.txt D:/path/image.jpg --publish
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

### 2. 正文插图：DataTransfer drop 事件

- 页面上唯一常驻的 `input[type=file]` 是「导入文档」入口（accept=.doc/.docx），**不能用它传图片**
- 封面"上传图片"按钮点击后弹的是**原生文件对话框**（非 DOM input），Playwright 的 filechooser 事件捕获不到，还会阻塞 CDP 截图——封面自动化不可行
- ✅ 把图片读成 base64 → `atob` → `Uint8Array` → `new File([arr], 'x.jpg', {type:'image/jpeg'})` → 放入 `DataTransfer.items` → 对 `.public-DraftEditor-content` 派发 `DragEvent('drop')`。图片自动上传到网易图床（dingyue.ws.126.net）并插入光标处
- **正文无图不允许发布**（弹窗"正文中至少上传一张图片"），插图一举两得（配图+满足发布条件）

### 3. 封面：直接选"自动"

`input[type=radio][value=auto]` 用 `evaluate(el => el.click())` 选中。不要碰单图/三图/大图的上传按钮。

### 4. 标题：React setter

`textarea.netease-textarea`，用 `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set` 赋值后派发 input/change/blur 事件。

### 5. 发布结果判定

- 点击发布后 URL 不变、无弹窗、页面无变化 = **被"请先通过实名认证再发布内容"拦截**（`document.body.innerText.includes('请先通过实名认证')` 检测）
- 成功：URL 跳转或出现"发布成功"

## 发布页元素速查

| 元素 | 选择器 |
|------|--------|
| 标题 | `textarea.netease-textarea`（5~30字） |
| 正文编辑器 | `.public-DraftEditor-content`（DraftJS） |
| 字数 | 页面文本 `共(\d+)字` |
| 封面-自动 | `input[type=radio][value=auto]` |
| 发布按钮 | `button:visible` 文本恰为"发布" |
| 实名提示条 | "请先通过实名认证再发布内容 去完成>" |

## 常见问题 → 详见 references/troubleshooting.md

- 登录表单在跨域 iframe，密码必须 `pressSequentially` 逐字输入；用 `input[type="password"]:visible` 选框（第一个密码框是隐藏的）
- 首次登录可能触发二次验证：滑块（yidun_slider）+ 短信验证码
- SPA 内 goto hash 有时不生效、404 页没有侧边栏菜单，导航优先从首页菜单点击

## 账号凭据

- 地址：mp.163.com
- 账号：13414054304@163.com
- 密码：wangyi.939.
- 认证手机：134****4304

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
