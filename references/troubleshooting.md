# 网易号发布问题排查

## 登录问题

### 登录表单 ref 失效

**症状**: `Unknown ref: e42`

**原因**: 每次 `snapshot` 后元素 refs 会重新分配，必须重新获取。

**解决**: 每次操作前重新执行 `xb snapshot`。

```bash
node xb.cjs run --browser chrome snapshot -i -c -d 4
```

### 登录后仍停留在 login.html

**症状**: 点击登录后 URL 不变

**原因**: xb fill 对跨域 iframe 的事件处理不完整

**解决**: 使用 `xb type` 替代 `xb fill`：

```bash
# 必须用 type，不能用 fill
node xb.cjs run --browser chrome type "e42" "wangyi.939."
node xb.cjs run --browser chrome click "e39"
```

### 密码框在 snapshot 中看不到

**症状**: iframe 内的 input 在 accessibility tree 中不可见

**原因**: iframe 跨域，但 xb 仍可操作

**解决**: 使用 `xb snapshot -i`（包含 iframe 内元素）

## 正文问题

### DraftJS 正文章编辑器注入失败

**症状**: 填入正文后字数显示 0

**原因**: DraftJS 使用 Immutable.js 状态机，直接 innerHTML 不触发状态更新

**解决**: 用 appendChild 分段落方式：

```js
var editor = document.querySelector('.public-DraftEditor-content');
editor.innerHTML = '';
paragraphs.forEach(function(p) {
  var pEl = document.createElement('p');
  pEl.innerText = p;
  editor.appendChild(pEl);
});
editor.dispatchEvent(new Event('input', {bubbles: true}));
```

### 正文字数少于250字

**症状**: 页面显示"*正文少于250字或无图片的文章，不会被分发到头条等展现位置"

**原因**: 内容太短

**解决**: 确保正文 ≥250 字

## 账号问题

### "您的账号信息正在审核中"

**症状**: 发布页显示审核中提示

**原因**: 网易号账号需要通过审核才能发布文章

**解决**: 等待网易审核通过。审核时间通常1-3个工作日。

### 账号登录失效

**症状**: 打开发布页直接跳转到登录页

**原因**: Cookie 过期

**解决**: 重新执行登录流程

## Chrome 问题

### CDP 连接失败

**症状**: `discoverChromePort` 返回 null

**排查**:
1. 确认 Chrome 启动了 `--remote-debugging-port=9222`
2. 检查端口是否被占用：`netstat -an | findstr 9222`
3. 尝试其他端口：9223, 9224, 9225

### xb 命令报错 "Unknown ref"

**原因**: ref 过期（每次 snapshot 后重新分配）

**解决**: 重新获取 snapshot

### xb 启动 Chrome 报错

**症状**: `xb run --browser chrome open` 失败

**解决**: 
```powershell
# 使用 user profile 启动 Chrome
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profileDir = "$env:USERPROFILE\.chrome_qclaw_wyy"
Start-Process $chromePath -ArgumentList @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profileDir",
  "https://mp.163.com/#/article-publish"
)
```

## 发布结果判定

### URL 没变化

**可能原因**:
1. 账号审核中
2. 正文字数为0
3. 缺少封面图片（三图/单图/大图模式）

### 弹出对话框

检查 dialog 内容，可能是错误提示（字数不足、封面缺失等）

### 发布成功

- URL 跳转到文章管理页：`mp.163.com/#/main/management/article`
- 页面显示"发布成功"或文章列表
