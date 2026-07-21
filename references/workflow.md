# 网易号发布详细流程

## 环境准备

### 启动 Chrome（固定 profile）

```powershell
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profileDir = "$env:USERPROFILE\.chrome_qclaw_wyy"
$url = "https://mp.163.com/#/article-publish"

if (-not (Test-Path $profileDir)) {
  New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
}

Start-Process $chromePath -ArgumentList @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profileDir",
  $url
)
```

### CDP 端口发现

```js
// 探测端口
const ports = [9222, 9223, 9224, 9225];
for (const port of ports) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  const tabs = await res.json();
  const pageTab = tabs.find(t => t.type === 'page');
  if (pageTab) return pageTab.webSocketDebuggerUrl;
}
```

## 登录流程

### 登录页结构

- 主页面：`https://mp.163.com/login.html`
- 登录表单：在跨域 iframe (`dl.reg.163.com`) 内
- 元素 refs（每次 snapshot 重新获取）：
  - `e41`：邮箱输入框
  - `e42`：密码输入框
  - `e39`：登录按钮

### 登录命令

```bash
# 1. 输入密码（必须用 type，不能用 fill）
node xb.cjs run --browser chrome type "e42" "wangyi.939."

# 2. 点击登录
node xb.cjs run --browser chrome click "e39"

# 3. 等待加载
node xb.cjs run --browser chrome wait --load networkidle

# 4. 确认 URL
node xb.cjs run --browser chrome get url
# 成功 → https://mp.163.com/#/article-publish
```

### 为什么不支持 xb fill？

登录表单在 `dl.reg.163.com`（跨域）iframe 内。`xb fill` 对跨域 iframe 元素可能不触发正确的事件。`xb type` 逐字输入可触发正确的事件链。

## 发布页操作

### 页面元素

```html
<!-- 标题 -->
<textarea class="netease-textarea" placeholder="请输入标题 (5~30个字)"></textarea>

<!-- 正文编辑器（DraftJS） -->
<div class="public-DraftEditor-content" contenteditable="true"></div>

<!-- 封面选择 -->
<input type="radio" name="..." value="threeImg" /> 三图
<input type="radio" name="..." value="custom" /> 单图
<input type="radio" name="..." value="bigImg" /> 大图
<input type="radio" name="..." value="auto" /> 自动

<!-- 发布按钮 -->
<button>发布</button>
```

### 填标题

```js
var ta = document.querySelector('textarea.netease-textarea');
ta.focus();
var setter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype, 'value'
).set;
setter.call(ta, '标题内容');
['input', 'change', 'blur'].forEach(function(e) {
  ta.dispatchEvent(new Event(e, {bubbles: true, cancelable: true}));
});
```

### 填正文（DraftJS）

**不能用 innerHTML 直接替换**，DraftJS 会忽略。需要：

```js
var editor = document.querySelector('.public-DraftEditor-content');
var paragraphs = bodyText.split('\n\n');

editor.innerHTML = ''; // 清空
paragraphs.forEach(function(p) {
  p = p.trim();
  if (!p) return;
  var pEl = document.createElement('p');
  pEl.innerText = p;
  editor.appendChild(pEl);
});

editor.dispatchEvent(new Event('input', {bubbles: true, cancelable: true}));
editor.dispatchEvent(new Event('change', {bubbles: true, cancelable: true}));
```

### 点击发布

```js
var allBtns = document.querySelectorAll('button');
var pubBtn = null;
for (var i = 0; i < allBtns.length; i++) {
  if (allBtns[i].innerText.trim() === '发布') {
    pubBtn = allBtns[i];
    break;
  }
}
if (pubBtn) {
  pubBtn.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
  pubBtn.dispatchEvent(new MouseEvent('click', {bubbles: true}));
}
```

## 发布结果判定

### 成功

- URL 跳转到文章管理页
- 页面显示"发布成功"或文章列表

### 失败原因

| 提示 | 原因 |
|------|------|
| 您的账号信息正在审核中 | 账号未审核通过，需等待 |
| 正文少于250字 | 内容过短，不会被分发 |
| 请上传封面图片 | 三图/单图/大图模式需上传图片 |

## 关键 ref（需动态获取）

每次 snapshot 后重新获取，当前稳定 refs：

- `e8`：标题输入（textbox "请输入标题 (5~30个字)"）
- `e10` / `e67`：正文编辑器（button "请输入正文" + 内部 textbox）
- `e65`：发布按钮（button "发布"）
- `e59`：`input[type=radio][value=threeImg]`（三图）
- `e62`：`input[type=radio][value=auto]`（自动封面）
