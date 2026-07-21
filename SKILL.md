---
name: wyy-publisher
description: |
  网易号（mp.163.com）文章发布 Skill。
  支持自动填标题 + DraftJS 正文章编辑器 + 封面设置 + 发布。
  触发词：网易号发布、发文章到网易号、发网易号
---

# 网易号文章发布 Skill v1

## 适用场景

将文章发布到网易号创作平台。

## ⚠️ 账号状态限制

**网易号需要完成内容审核才能发布文章。**

发布页若显示 **"您的账号信息正在审核中，请耐心等待哦"**，说明账号尚未审核通过，暂时无法发布。

## 发布页 URL

```
https://mp.163.com/#/article-publish
```

## 发布页关键元素

| 元素 | 选择器 | 说明 |
|------|--------|------|
| 标题输入 | `textarea.netease-textarea` | placeholder="请输入标题 (5~30个字)" |
| 正文编辑器 | `.public-DraftEditor-content` | DraftJS 富文本编辑器 |
| 发布按钮 | `button` innerText="发布" | 需账号审核通过 |
| 封面-三图 | `input[type=radio][value=threeImg]` | 默认选中，需上传3张图 |
| 封面-单图 | `input[type=radio][value=custom]` | 需上传1张图 |
| 封面-大图 | `input[type=radio][value=bigImg]` | 需上传1张大图 |
| 封面-自动 | `input[type=radio][value=auto]` | 自动生成封面 |

## 正文要求

- 正文需 **≥250字** 才能分发到头条等展现位置
- DraftJS 编辑器需要用特殊方法注入内容（不能用 innerHTML 直接替换）

## 发布流程

### 1. 启动浏览器 + 登录

使用固定 user-data-dir 保存登录态：
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

### 2. 登录（如果需要）

网易号登录表单在跨域 iframe (`dl.reg.163.com`) 内，但 xb 可以操作。

**注意：账号密码填写必须用 `xb type`（逐字输入），不能用 `xb fill`！**

```bash
# 1. 清空并逐字输入密码
node xb.cjs run --browser chrome type "e42" "wangyi.939."

# 2. 点击登录
node xb.cjs run --browser chrome click "e39"
```

> `e41`=邮箱号，`e42`=密码，`e39`=登录按钮（每次需重新 snapshot 获取 ref）

### 3. 检查账号状态

发布页显示 **"您的账号信息正在审核中"** = 账号未通过审核，不能发布。

### 4. 填标题

```js
var ta = document.querySelector('textarea.netease-textarea');
ta.focus();
var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
setter.call(ta, '标题内容');
ta.dispatchEvent(new Event('input', {bubbles: true, cancelable: true}));
ta.dispatchEvent(new Event('change', {bubbles: true, cancelable: true}));
```

### 5. 填正文（DraftJS）

DraftJS 不能直接 innerHTML 替换，必须用以下方法：

```js
var editor = document.querySelector('.public-DraftEditor-content');
if (!editor) return 'EDITOR_NF';

// 分段落填入（每次清空+重建）
var text = '...'; // 正文文本
editor.innerHTML = '';
var paragraphs = text.split('\n\n');
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

### 6. 发布

```js
var allBtns = document.querySelectorAll('button');
var pubBtn = null;
for (var i = 0; i < allBtns.length; i++) {
  if (allBtns[i].innerText && allBtns[i].innerText.trim() === '发布') {
    pubBtn = allBtns[i];
    break;
  }
}
pubBtn.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
pubBtn.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
```

## 文件结构

```
skills/wyy-publisher/
  SKILL.md                    # 本文件
  scripts/
    publish.js                # 完整发布脚本
    lib.js                    # CDP 封装库
  references/
    workflow.md               # 详细流程
    troubleshooting.md        # 问题排查
    commands.md               # xb 命令参考
```

## 已知限制

1. **账号审核中**：账号未审核通过时不能发布，需等待审核
2. **封面需上传**：三图/单图/大图模式需要上传图片（暂不支持自动化上传）
3. **正文≥250字**：正文少于250字不会被分发到头条
4. **iframe 跨域**：登录表单在 dl.reg.163.com 跨域 iframe，必须用 xb type（不能用 fill）

## 账号凭据

- 地址：mp.163.com
- 账号：13414054304@163.com
- 密码：wangyi.939.
