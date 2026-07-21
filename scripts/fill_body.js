/**
 * 网易号发布 - 填入文章内容
 */
const WebSocket = require('ws');
const http = require('http');

const TITLE = '资源有限';
const BODY_HTML = `<p>在资源有限的条件下，如何做出最优决策，是每个人都会面临的课题。</p><p>资源有限，并不意味着无路可走。相反，它往往倒逼我们去思考：什么是真正重要的？什么可以舍弃？什么必须坚持？</p><p>经济学的基本假设告诉我们，资源是稀缺的，选择是有代价的。这个道理看似简单，应用起来却需要深刻的自我认知和清晰的优先级判断。</p><p>面对有限的时间、金钱、精力，我们真正需要做的，不是贪多求全，而是精准聚焦。把有限资源投入到最核心的目标上，往往比分散用力更能产生突破性结果。</p><p>资源的边界，往往也是思维的边界。打破局限的第一步，是承认局限的存在。接受"资源有限"这个事实，才能在此基础上做出最理性的规划和行动。</p>`;

function discoverChromePort() {
  return new Promise((resolve) => {
    const ports = [9222, 9223, 9224, 9225, 4637];
    let idx = 0;
    function tryPort() {
      if (idx >= ports.length) return resolve(null);
      const port = ports[idx++];
      http.get({ host: '127.0.0.1', port, path: '/json', timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try {
            const tabs = JSON.parse(data);
            const pageTab = tabs.find(t => t.type === 'page');
            if (pageTab) resolve({ wsUrl: pageTab.webSocketDebuggerUrl, port });
            else tryPort();
          } catch (e) { tryPort(); }
        });
      }).on('error', () => tryPort());
    }
    tryPort();
  });
}

class CDPClient {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.pending = {}; this.msgId = 0; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id && this.pending[msg.id]) { this.pending[msg.id](msg.result); delete this.pending[msg.id]; }
        } catch (e) {}
      });
    });
  }
  send(method, params, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending[id] = resolve;
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending[id]) { delete this.pending[id]; reject(new Error(`超时: ${method}`)); } }, timeout);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.value;
  }
  async getUrl() {
    const r = await this.send('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true });
    return r?.result?.value;
  }
  async screenshot(filename) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (r?.data) {
      const fs = require('fs');
      fs.writeFileSync(filename, Buffer.from(r.data, 'base64'));
      console.log(`   📸 截图: ${filename}`);
    }
  }
  close() { this.ws.close(); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== 网易号发布文章 ===\n');
  const info = await discoverChromePort();
  if (!info) { console.error('❌ 未找到 Chrome CDP'); process.exit(1); }
  const client = new CDPClient(info.wsUrl);
  await client.connect();
  console.log('   ✅ 已连接 CDP\n');

  const url = await client.getUrl();
  console.log('当前URL:', url);

  // 1. 填标题
  console.log('\n1. 填入标题...');
  const titleResult = await client.eval(`
    (function(){
      var ta = document.querySelector('textarea.netease-textarea');
      if (!ta) return 'TITLE_NF';
      ta.focus();
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '${TITLE}');
      ta.dispatchEvent(new Event('input', {bubbles: true, cancelable: true}));
      ta.dispatchEvent(new Event('change', {bubbles: true, cancelable: true}));
      return 'OK: ' + ta.value + ' (' + ta.value.length + '字)';
    })()
  `);
  console.log('   ' + titleResult);

  await sleep(300);

  // 2. 填正文 - DraftJS 编辑器
  console.log('\n2. 填入正文（DraftJS编辑器）...');

  // 方法: 直接设置 DraftJS 编辑器的 content
  const bodyResult = await client.eval(`
    (function(){
      var editor = document.querySelector('.public-DraftEditor-content');
      if (!editor) return 'EDITOR_NF';

      // DraftJS 使用 Immutable.js，需要用正确的 API
      // 尝试找到 editor 实例
      var keys = Object.keys(editor);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].startsWith('__reactFiber')) {
          var fiber = editor[keys[i]];
          var stateNode = fiber && fiber.stateNode;
          if (stateNode && stateNode._draftJSContent) {
            return 'FOUND_DRAFTJS: ' + keys[i];
          }
        }
      }

      // 尝试向上找 React fiber
      var parent = editor.parentElement;
      for (var depth = 0; depth < 5; depth++) {
        if (!parent) break;
        var pKeys = Object.keys(parent);
        for (var j = 0; j < pKeys.length; j++) {
          if (pKeys[j].startsWith('__reactFiber')) {
            var f = parent[pKeys[j]];
            // 检查是否有 editorState 或类似属性
            var desc = Object.keys(f).join(',');
            if (desc.includes('editor') || desc.includes('Draft')) {
              return 'FIBER depth=' + depth + ': ' + desc.substring(0, 100);
            }
          }
        }
        parent = parent.parentElement;
      }

      return 'NO_FIBER';
    })()
  `);
  console.log('   ' + bodyResult);

  // 尝试 DraftJS 的官方方法
  const draftMethod = await client.eval(`
    (function(){
      var editor = document.querySelector('.public-DraftEditor-content');
      if (!editor) return 'EDITOR_NF';

      // 尝试通过 editor 的 parent 找 React Root
      var root = editor.parentElement;
      while (root && !root._reactRoot) {
        root = root.parentElement;
      }
      if (root && root._reactRoot) return 'HAS_REACT_ROOT';

      // 找 _reactFiber 或 __reactFiber
      var allEls = document.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        var keys = Object.keys(allEls[i]);
        for (var j = 0; j < keys.length; j++) {
          var k = keys[j];
          if (k.startsWith('__reactFiber') || k.startsWith('_reactInternal')) {
            return 'FOUND_KEY: ' + k + ' at element ' + i + ' tag=' + allEls[i].tagName;
          }
        }
      }
      return 'NO_REACT_FIBER';
    })()
  `);
  console.log('   React状态:', draftMethod);

  // 直接注入内容到 DraftJS
  const injectResult = await client.eval(`
    (function(){
      var editor = document.querySelector('.public-DraftEditor-content');
      if (!editor) return 'EDITOR_NF';

      // 方案1: 模拟键盘输入
      editor.focus();
      
      // 构造合成事件
      function simulateTyping(text) {
        // 模拟用户输入
        var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        var inputEvent = new Event('input', { bubbles: true, cancelable: true, composed: true });
        var keyDownEvent = new KeyboardEvent('keydown', { bubbles: true, key: 'a', keyCode: 65 });
        var keyPressEvent = new KeyboardEvent('keypress', { bubbles: true, key: 'a', keyCode: 65 });
        var keyUpEvent = new KeyboardEvent('keyup', { bubbles: true, key: 'a', keyCode: 65 });
        
        // 对于 DraftJS，主要通过 beforeinput 事件注入
        var beforeInputEvent = new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text
        });
        editor.dispatchEvent(beforeInputEvent);
        
        // 也尝试插入到 DOM
        if (!editor.innerHTML || editor.innerHTML === '<br>' || editor.innerHTML === '<p><br></p>') {
          editor.innerHTML = '<p>' + text.replace(/\\n/g, '<br>') + '</p>';
        }
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        
        return editor.innerText.length;
      }

      var text = '${BODY_HTML.replace(/'/g, "\\'").replace(/\n/g, '')}';
      // 转成纯文本
      var plainText = text.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\\s+/g, ' ').trim();
      var len = simulateTyping(plainText);
      return 'INJECTED: len=' + len + ' html=' + editor.innerHTML.substring(0, 50);
    })()
  `);
  console.log('   注入结果:', injectResult);

  // 3. 检查当前状态
  console.log('\n3. 检查发布状态...');
  const state = await client.eval(`
    (function(){
      var ta = document.querySelector('textarea.netease-textarea');
      var editor = document.querySelector('.public-DraftEditor-content');
      var publishBtn = null;
      var allBtns = document.querySelectorAll('button');
      for (var i = 0; i < allBtns.length; i++) {
        if (allBtns[i].innerText && allBtns[i].innerText.trim() === '发布') {
          publishBtn = allBtns[i];
          break;
        }
      }
      return JSON.stringify({
        titleLen: ta ? ta.value.length : 0,
        titleVal: ta ? ta.value : '',
        editorTextLen: editor ? (editor.innerText || '').length : 0,
        editorHTML: editor ? editor.innerHTML.substring(0, 50) : '',
        publishBtnFound: !!publishBtn,
        publishBtnDisabled: publishBtn ? publishBtn.disabled : null
      });
    })()
  `);
  console.log('   ' + state);

  await client.screenshot('wyy_article_filled.png');

  // 4. 点发布按钮
  console.log('\n4. 点击发布按钮...');
  const clickPub = await client.eval(`
    (function(){
      var allBtns = document.querySelectorAll('button');
      var publishBtn = null;
      for (var i = 0; i < allBtns.length; i++) {
        if (allBtns[i].innerText && allBtns[i].innerText.trim() === '发布') {
          publishBtn = allBtns[i];
          break;
        }
      }
      if (!publishBtn) return 'PUB_BTN_NF';
      publishBtn.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
      publishBtn.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
      publishBtn.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      return 'CLICKED: disabled=' + publishBtn.disabled;
    })()
  `);
  console.log('   ' + clickPub);

  console.log('\n5. 等待处理（5秒）...');
  await sleep(5000);

  const finalUrl = await client.getUrl();
  console.log('6. 最终URL:', finalUrl);

  await client.screenshot('wyy_final.png');

  if (finalUrl.includes('publish') || finalUrl.includes('article')) {
    // 检查是否弹出对话框
    const dialogCheck = await client.eval(`
      (function(){
        var dialogs = document.querySelectorAll('[role="dialog"], .modal, .ant-modal, .ne-modal');
        var bodyText = document.body.innerText.substring(0, 500);
        return JSON.stringify({
          dialogs: dialogs.length,
          bodySnippet: bodyText
        });
      })()
    `);
    console.log('   对话框检查:', dialogCheck);
  }

  client.close();
  console.log('\n=== 完成 ===');
}

main().catch(e => { console.error('错误:', e.message); process.exit(1); });
