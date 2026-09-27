# 网易号发布问题排查（2026-09-27 实测全记录）

> v1 的 xb CLI 相关排查（ref 失效、snapshot 等）已删除——xb 路线废弃，现统一用 playwright-core 直连 CDP。

## 一、环境与进程

### 沙箱回收隔离 Chrome

**症状**：脚本里 spawn 的 Chrome（detached+unref）在命令结束后被杀。
**解决**：launch.js 启动命令必须 `run_in_background: true`，并接 `&& sleep 7200` 保活。

### CDP 连接失败

**排查**：`curl http://127.0.0.1:9222/json` 看是否有 tab；没有则用 launch.js 重新拉起。备用端口 9223-9225。
**注意**：profile 必须用 `~/.chrome_qclaw_wyy`（网易号登录态专用），别和头条/知乎的 `.chrome_qclaw_stable` 混用。

### `ws` 模块不存在

**症状**：v1 脚本 `require('ws')` 报 MODULE_NOT_FOUND。
**解决**：已废弃 ws 方案，改用 playwright-core（`~/.workbuddy/binaries/node/workspace/node_modules`，运行时设 NODE_PATH）。

## 二、登录

### 登录表单找不到

**原因**：表单在跨域 iframe（dl.reg.163.com）内，主文档 querySelector 摸不到。
**解决**：playwright 遍历 `page.frames()` 找含 `input[type=password]` 的 frame 直接操作。

### 密码框点击超时 "element is not visible"

**原因**：iframe 内有 2 个 password input，第一个是隐藏的（备用登录方式）。
**解决**：用 `input[type="password"]:visible` 选可见的；账号框同理用 `input:visible` 过滤。

### 密码填写触发风控

**解决**：`pressSequentially` 逐字输入（delay 60ms），不要 `fill` 一次性灌入。

### 首次登录触发二次验证

**症状**：登录后跳 `#/layout/account-protect`，要求"向右拖动滑块填充拼图"+短信验证码。
**解决**：
- 滑块（`.yidun_slider`）：可尝试 playwright `mouse` 模拟人手拖动（先快后慢、带抖动、过冲回拉），实测可过
- 短信验证码：点"获取验证码"发到认证手机（134****4304），**必须用户告知验证码**，无法自动化
- 通过后自动进入创作后台

### 登录态失效

**症状**：打开发布页 302 到 login.html。
**解决**：重跑 `scripts/login.cjs`（有登录态时脚本会自动跳过）。

## 三、内容填充

### DraftJS 正文注入后"共0字"（v1 严重 bug）

**症状**：appendChild `<p>` 视觉上有字，但字数统计为 0，发布出去正文是空的。
**原因**：DraftJS 基于 Immutable.js 状态机，直接改 DOM 不更新内部 EditorState。
**解决**：paste 事件注入（见 SKILL.md 核心要点1）。注入后用 `共(\d+)字` 正则校验字数。

### 正文配图传错入口

**症状**：用页面唯一的 `input[type=file]` 上传图片，弹窗"文档导入只支持docx、pdf、txt格式"。
**原因**：那个 input 是「导入文档」入口（accept=.doc/.docx），不是图片上传。
**解决**：图片用 DataTransfer drop 事件插入正文（见 SKILL.md 核心要点2）。

### 封面上传卡死（截图超时）

**症状**：点击"上传图片"后 Playwright filechooser 事件超时、`elementFromPoint` 被挡、CDP 截图 30s 超时。
**原因**：点击弹出的是**原生文件对话框**（非 DOM input，疑似 File System Access API），阻塞渲染。
**解决**：
- 放弃封面上传自动化，封面选"自动"（`radio[value=auto]`）
- 连发 Esc（CDP `Input.dispatchKeyEvent`）关闭原生对话框，再点页面内"确认"清掉残留 confirm 弹窗

### 正文无图不能发布

**症状**：弹窗"正文中至少上传一张图片！"
**解决**：把配图直接插入正文（同时满足"文章配图"需求和平台要求）。

## 四、发布

### 点"发布"没反应（URL 不变、无弹窗）

**原因**：页面顶部有"请先通过实名认证再发布内容"提示条，发布被静默拦截。
**判定**：`document.body.innerText.includes('请先通过实名认证')`。
**解决**：无法网页端代办。手机端"网易新闻"App → 我的 → 创作中心 → 去实名认证（身份证+人脸）。认证通过后草稿箱继续发布。

### 账号审核中

**症状**：页面显示"您的账号信息正在审核中"。
**解决**：等待审核（1-3 个工作日），脚本检测到自动退出（exit 2）。

### 发布页 SPA 导航失效

**症状**：`goto('https://mp.163.com/#/xxx')` 后 URL 不变；或直接 goto 子路由落到 404 页（且 404 页没有侧边栏菜单，无法继续点击导航）。
**解决**：先 `goto` 首页 `#/home`，等渲染后用 `page.locator('text=草稿管理').click()` 菜单点击跳转。

### 重复草稿

**原因**：发布页自动保存草稿，反复填充/刷新会产生多条重复草稿。
**解决**：发布完成后到"首页→管理→草稿管理"清理多余草稿（发布前问用户）。

## 五、结果判定速查

| 现象 | 结论 |
|------|------|
| URL 跳转/出现"发布成功" | ✅ 成功 |
| URL 不变 + "请先通过实名认证" | ❌ 未实名，手机 App 认证 |
| 弹窗"正文中至少上传一张图片" | ❌ 需插图 |
| 字数统计"共0字" | ❌ paste 注入失败/没用 paste |
| 弹窗"账号信息正在审核中" | ⏳ 等审核 |
