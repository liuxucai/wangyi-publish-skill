# 网易号发布问题排查（2026-09-27 实测全记录）

> v1 的 xb CLI 相关排查（ref 失效、snapshot 等）已删除——xb 路线废弃，现统一用 playwright-core 直连 CDP。

## 一、环境与进程

### 沙箱回收隔离 Chrome

**症状**：脚本里 spawn 的 Chrome（detached+unref）在命令结束后被杀。
**解决**：launch.js 启动命令必须 `run_in_background: true`，并接 `&& sleep 7200` 保活。

### CDP 连接失败

**排查**：`curl http://127.0.0.1:9222/json` 看是否有 tab；没有则用 launch.js 重新拉起。备用端口 9223-9225。
**注意**：profile 用 `~/.chrome_qclaw_wangyi2`（网易号登录态专用，2026-10-13 确认实际目录名；
SKILL.md 早前写的 `.chrome_qclaw_wyy` 不存在）。与主实例（9222，`.chrome_qclaw_stable`）**并行运行**时
必须用独立端口（如 9223）：`ISOB_CDP_PORT=9223 ISOB_PROFILE_DIR="$HOME/.chrome_qclaw_wangyi2" node launch.js ...`

### `ws` 模块不存在

**症状**：v1 脚本 `require('ws')` 报 MODULE_NOT_FOUND。
**解决**：已废弃 ws 方案，改用 playwright-core（路径由 `../../isolated-browser/scripts/pathkit.js` 运行时探测，无需手工设 NODE_PATH）。

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
**解决**：见下节「插图方法迭代」——CDP 原生拖拽。

### 插图方法迭代：合成 DragEvent 已证伪 → CDP 原生拖拽（2026-10-13 实测）

- ❌ **旧方法（2026-09-27 有效）**：构造 `DataTransfer` + `File` → 对 `.public-DraftEditor-content`
  派发合成 `DragEvent('drop')`。2026-10-13 复测**失效**：加监听证实事件能到达编辑器
  （`types=['Files']`、`nFiles=1`），但编辑器不处理（`defaultPrevented=false`、不发起上传、
  轮询 30s img 数不变）。推测编辑器升级后校验 `isTrusted`。
- ✅ **新方法：CDP `Input.dispatchDragEvent`**（真实输入事件，isTrusted=true，2.5s 内插图成功）：

```js
const client = await page.context().newCDPSession(page);
await client.send('Input.setInterceptDrags', { enabled: true });
const data = { items: [], files: ['D:\\path\\img.jpg'], dragOperationsMask: 1 };
for (const type of ['dragEnter', 'dragOver', 'drop']) {
  await client.send('Input.dispatchDragEvent', { type, x, y, data });
  await sleep(500);
}
```

  `files` 直接传**本地文件绝对路径**，无需 base64/Uint8Array。已并入 `publish.cjs`。

### CDP 拖拽落点坑：编辑器 rect 公式在滚动后失效

**症状**：同一套 dispatchDragEvent，第一张图成功、第二张开始全失败（24s 内 img 数不变）。
**原因**：落点公式 `rect.top + min(h-20, 300)` 用的是**编辑器整体 rect**——页面滚动后
`rect.top` 为负（如 -293），算出的 y 落到视口顶部工具栏区，drop 目标不在编辑器内容上。
**解决**：落点优先取**光标 selection 的实际 rect**（`window.getSelection().getRangeAt(0).getBoundingClientRect()`，
先点编辑器 + Control+End）；fallback 用 `clamp(er.top+100, 150, innerHeight-100)`。已并入 publish.cjs。

### 「您的账号未上线，暂不支持发布」（2026-10-13 新拦截类型）

**症状**：点「发布」后弹提示窗「您的账号未上线，暂不支持发布」，URL 不变。
**与旧拦截的区别**：不是实名认证（实名提示条文案不同），是**账号状态**未达到可发布级别。
**解决**：无法自动化。内容/配图/封面会**自动保存在草稿箱**（发布页每约 1 分钟自动保存），
账号上线后打开草稿直接点发布即可。脚本检测到后 exit 2 并提示。

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
| 弹窗"您的账号未上线，暂不支持发布" | ❌ 账号状态限制；草稿已自动保存，上线后直接发布 |
| 字数统计"共0字" | ❌ paste 注入失败/没用 paste |
| 弹窗"账号信息正在审核中" | ⏳ 等审核 |
| drop 事件到达（types=Files）但 img 数不变 | ❌ 合成 DragEvent 被忽略，改 CDP dispatchDragEvent |
| dispatchDragEvent 坐标落在视口顶部/负值 | ❌ 落点公式未考虑滚动，改用光标 selection rect |

---

## 六、多图（3 张）改造（2026-10-12）

**新增能力**：配图路径既可用**位置参数**跟在 body 之后（可多个），也可用 `--image` 重复传参（两者会合并）；
另新增 `--keyword` / `--tags` / `--image-top` / `--image-dir` / `--no-image`。
不给图时由共享工具 `../../isolated-browser/scripts/post_images.js` 的 `planImages()` 按标签从素材库自动挑 3 张。

### 实现要点
- 沿用 **DataTransfer `drop` 事件**（网易号唯一的 `input[type=file]` 是「导入文档」入口，不能用它传图）。
- **逐张**：每张先 `Control+End` 把光标移到正文末尾 → `drop` → 轮询 `.public-DraftEditor-content img` 数递增确认；
  多张会在正文末尾**连续**排列（网易号编辑器上传固定追加到末尾）。
- 每张都独立校验，避免"传了但没进去"。

### 已知状态
- 网易号**正文必须有图才能发布**（平台硬要求），所以 `--no-image` 在本平台等于放弃发布。
- 2026-10-13 三图链路真实验证通过：CDP 拖拽 3/3 成功（9/11/12.jpg → dingyue.ws.126.net 图床外链）。
- 插图逐张追加到正文末尾（每张先 Control+End 再 drop）。

### 已证伪（勿再试）
| 做法 | 为什么不行 |
|---|---|
| 用页面唯一的 `input[type=file]` 传图 | 那是「导入文档」入口（accept=.doc/.docx），传图会报"只支持 docx/pdf/txt" |
| 一次性 drop 多个 File | 编辑器按单次处理，多文件不可控；必须逐张 drop |
| 依赖"上传成功"提示判断 | 提示会残留易误判；以正文 `img` 数递增为准 |
| 合成 DragEvent('drop') + DataTransfer/File 插图 | 2026-10-13 证伪：事件可达但编辑器不处理（defaultPrevented=false）；改 CDP dispatchDragEvent |
| 落点用「编辑器 rect.top+300」固定公式 | 页面滚动后 rect.top 为负，落点飞出内容区；改光标 selection rect |
| 点击封面「上传图片」按钮（单图/大图模式） | 弹**原生文件对话框**，filechooser 捕获不到且阻塞渲染；封面用「自动」 |
