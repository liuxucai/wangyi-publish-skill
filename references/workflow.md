# 网易号发布详细流程（v2，playwright-core CDP）

> 全部步骤已在 2026-09-27 端到端实测。旧版 xb CLI 流程已删除。

## 流程总览

```
启动隔离Chrome(后台保活) → login.cjs(如需) → publish.cjs <title> <body> [img] [--publish]
```

## Step 0 启动隔离 Chrome

```bash
ISOB_PROFILE_DIR="C:/Users/甲骨龙集成电脑/.chrome_qclaw_wyy" \
  node "C:/Users/甲骨龙集成电脑/.workbuddy/skills/isolated-browser/scripts/launch.js" \
  "https://mp.163.com/#/article-publish" && sleep 7200
```

- 必须 `run_in_background: true`（沙箱回收 detached 进程）
- 起来后 `curl http://127.0.0.1:9222/json` 验证

## Step 1 登录（scripts/login.cjs）

- playwright `connectOverCDP('http://127.0.0.1:9222')` → 遍历 frames 找 `input[type=password]`
- 账号/密码均 `pressSequentially` 逐字输入（60ms/字），密码框选 `:visible`
- 点击"登录"后等 10s 检查 URL：
  - 含 `login.html` → 可能二次验证（滑块/短信），人工处理
  - 含 `account-protect` → 滑块可自动拖，短信验证码需用户手机
  - 其他 → 成功

## Step 2 填内容（scripts/publish.cjs）

1. **标题**：React setter 写 `textarea.netease-textarea`，5~30 字
2. **正文**：点击 `.public-DraftEditor-content` 聚焦 → `Control+End` → ClipboardEvent('paste') 注入全文（段落间空行分隔）→ 用 `共(\d+)字` 校验
3. **配图**：base64 → File → DataTransfer → DragEvent('drop') 派发到编辑器 → 6s 后查 `.public-DraftEditor-content img` 数量确认上传成功（图片会上传到 dingyue.ws.126.net 图床）
4. **封面**：`radio[value=auto]` 置为自动
5. 截图预览（不带 --publish 到此结束，草稿自动保存）

## Step 3 发布（--publish）

- 真实点击 `button:visible` 文本"发布"
- 等 8s，检查：
  - URL 变化/"发布成功" → 成功
  - `innerText.includes('请先通过实名认证')` → 被实名拦截（手机 App 认证后再来，草稿还在）
  - 其他弹窗 → 读 `.custom-confirm-content` 文本判断

## 发布后

- 到"首页 → 管理 → 草稿管理"确认文章状态，清理重复草稿
- 内容管理页可查发布结果：`mp.163.com/subscribe_v4/index.html#/home`
