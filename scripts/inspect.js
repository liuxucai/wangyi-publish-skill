/**
 * 网易号发布页 DOM 探查
 */
const WebSocket = require('ws');
const http = require('http');

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
  const info = await discoverChromePort();
  if (!info) { console.error('未找到Chrome'); process.exit(1); }
  const client = new CDPClient(info.wsUrl);
  await client.connect();
  console.log('已连接\n');

  const url = await client.getUrl();
  console.log('URL:', url);

  // 探查正文编辑器
  console.log('\n=== 正文编辑器探查 ===');
  const bodyEditor = await client.eval(`
    (function(){
      // 找正文输入区域
      var candidates = [];
      
      // 方法1: contenteditable
      var editables = document.querySelectorAll('[contenteditable]');
      candidates.push('contenteditable: ' + editables.length);
      editables.forEach(function(el, i) {
        candidates.push('  CE' + i + ': tag=' + el.tagName + ' id=' + el.id + ' class=' + el.className.substring(0,50) + ' text=' + (el.innerText || '').substring(0,30));
      });
      
      // 方法2: textarea
      var textareas = document.querySelectorAll('textarea');
      candidates.push('textarea: ' + textareas.length);
      textareas.forEach(function(el, i) {
        candidates.push('  TA' + i + ': id=' + el.id + ' name=' + el.name + ' class=' + el.className.substring(0,50) + ' placeholder=' + el.placeholder);
      });
      
      // 方法3: 普通input
      var inputs = document.querySelectorAll('input');
      candidates.push('input(text): ' + inputs.length);
      for (var i = 0; i < inputs.length; i++) {
        if (inputs[i].type === 'text' || inputs[i].type === '') {
          candidates.push('  IN' + i + ': id=' + inputs[i].id + ' class=' + inputs[i].className.substring(0,50) + ' placeholder=' + inputs[i].placeholder);
        }
      }
      
      // 方法4: 找class含editor/content/body的区域
      var allDivs = document.querySelectorAll('div');
      var editorDivs = [];
      allDivs.forEach(function(el, i) {
        var cls = (el.className || '').toLowerCase();
        var id = (el.id || '').toLowerCase();
        if (cls.includes('editor') || cls.includes('content') || cls.includes('body') || cls.includes('article') || cls.includes('rich') || id.includes('editor') || id.includes('content')) {
          editorDivs.push('  DIV' + i + ': tag=' + el.tagName + ' id=' + el.id + ' class=' + el.className.substring(0,60) + ' contenteditable=' + el.contentEditable);
        }
      });
      candidates.push('editorDivs: ' + editorDivs.length);
      candidates = candidates.concat(editorDivs.slice(0, 10));
      
      // 方法5: 找包含"请输入正文"的元素
      var bodyEl = null;
      var allEls = document.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        if (allEls[i].innerText && allEls[i].innerText.includes('请输入正文') && allEls[i].innerText.length < 30) {
          bodyEl = allEls[i];
          break;
        }
      }
      if (bodyEl) {
        candidates.push('BODY_EL: tag=' + bodyEl.tagName + ' id=' + bodyEl.id + ' class=' + bodyEl.className.substring(0,60));
        // 向上找3层
        var parent = bodyEl.parentElement;
        for (var j = 0; j < 3; j++) {
          if (parent) {
            candidates.push('  parent' + j + ': ' + parent.tagName + ' id=' + parent.id + ' class=' + (parent.className || '').substring(0,50));
            parent = parent.parentElement;
          }
        }
        // 找同级的下一个兄弟
        var sib = bodyEl.nextElementSibling;
        if (sib) candidates.push('  nextSibling: ' + sib.tagName + ' id=' + sib.id + ' class=' + (sib.className || '').substring(0,50));
        // 找子元素
        var children = bodyEl.children;
        for (var k = 0; k < Math.min(children.length, 10); k++) {
          candidates.push('  child' + k + ': ' + children[k].tagName + ' id=' + children[k].id + ' class=' + (children[k].className || '').substring(0,40));
        }
      }
      
      return candidates.join('\\n');
    })()
  `);
  console.log(bodyEditor);

  // 探查标题输入
  console.log('\n=== 标题输入探查 ===');
  const titleInfo = await client.eval(`
    (function(){
      var inputs = document.querySelectorAll('input');
      var result = [];
      inputs.forEach(function(inp, i) {
        var info = 'IN' + i + ': type=' + inp.type + ' id=' + inp.id + ' name=' + inp.name + ' class=' + (inp.className || '').substring(0,50) + ' placeholder=' + inp.placeholder + ' value=' + (inp.value || '').substring(0,20);
        result.push(info);
      });
      return result.join('\\n');
    })()
  `);
  console.log(titleInfo);

  await client.screenshot('wyy_editor_inspect.png');

  client.close();
}

main().catch(e => { console.error('错误:', e.message); process.exit(1); });
