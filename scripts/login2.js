/**
 * 网易号登录 - CDP frameId 操作
 */
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const ACCOUNT = '13414054304@163.com';
const PASSWORD = 'wangyi.939.';

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
            if (pageTab) resolve({ wsUrl: pageTab.webSocketDebuggerUrl, port, pageTab });
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
          // Handle runtime.exceptionThrown
          if (msg.method === 'Runtime.exceptionThrown') {
            console.log('[Exception]', msg.params.exceptionDetails.text);
          }
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
  // 在指定 frameId 中执行 JS
  async evalInFrame(frameId, expression) {
    // 使用 frameId 执行表达式
    const r = await this.send('Runtime.evaluate', { 
      expression: `(function(){
        try {
          var frame = document.getElementById('${frameId}') || frames['${frameId}'];
          if (!frame) return 'FRAME_NF';
          return frame.eval(\`${expression.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`);
        } catch(e) {
          return 'ERR: ' + e.message;
        }
      })()`,
      returnByValue: true
    });
    return r?.result?.value;
  }
  // 在主框架执行
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.value;
  }
  async getFrameTree() {
    return await this.send('Page.getFrameTree', {});
  }
  async navigate(url) {
    await this.send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, 3000));
  }
  async screenshot(filename) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (r?.data) {
      const fs = require('fs');
      fs.writeFileSync(filename, Buffer.from(r.data, 'base64'));
      console.log(`   📸 截图: ${filename}`);
    }
  }
  async enableAll() {
    await this.send('Page.enable', {});
    await this.send('Runtime.enable', {});
  }
  close() { this.ws.close(); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== 网易号登录（frameId方式）===\n');
  const info = await discoverChromePort();
  if (!info) { console.error('❌ 未找到 Chrome CDP'); process.exit(1); }
  const client = new CDPClient(info.wsUrl);
  await client.connect();
  await client.enableAll();
  console.log('   ✅ 已连接 CDP\n');

  // 获取 frame tree
  const tree = await client.getFrameTree();
  const mainFrame = tree.frameTree.frame;
  const iframeFrame = tree.frameTree.childFrames[0]?.frame;
  console.log('主页面:', mainFrame.id, mainFrame.url.substring(0, 60));
  console.log('iframe:', iframeFrame?.id, iframeFrame?.url.substring(0, 60));

  // 先清空密码框，再重新填入
  console.log('\n1. 清空并填入密码...');
  
  // 方法：用主frame的JS通过 frames 访问子iframe
  const iframeName = iframeFrame?.name || 'x-URS-iframe1783314869769.564';
  const testAccess = await client.eval(`
    (function(){
      try {
        var iframeEl = document.querySelector('iframe[name="${iframeName}"]');
        if (!iframeEl) return 'IFRAME_BY_NAME_NF';
        var iframeWin = iframeEl.contentWindow;
        var iframeDoc = iframeWin.document;
        return 'ACCESS_OK: inputs=' + iframeDoc.querySelectorAll('input').length;
      } catch(e) {
        return 'CROSS_ORIGIN_ERR: ' + e.message;
      }
    })()
  `);
  console.log('   iframe访问测试:', testAccess);

  // 尝试用另一种方式: 在子frame的上下文中执行
  // 通过递归地找iframe的window
  const access2 = await client.eval(`
    (function(){
      try {
        var iframes = document.querySelectorAll('iframe');
        var results = [];
        iframes.forEach(function(iframe, i) {
          try {
            var win = iframe.contentWindow;
            var doc = win.document;
            var inputs = doc.querySelectorAll('input');
            results.push('iframe' + i + ': ' + inputs.length + ' inputs, name=' + iframe.name);
          } catch(e) {
            results.push('iframe' + i + ': CROSS_ORIGIN');
          }
        });
        return results.join(' | ');
      } catch(e) { return 'ERR: ' + e.message; }
    })()
  `);
  console.log('   iframe列表:', access2);

  // 找到iframe，用CDP的frameId来执行
  // CDP可以切换frame
  console.log('\n2. 切换到登录iframe执行JS...');
  const loginIframeId = iframeFrame?.id;
  
  // 在主页面执行：定位到正确的iframe URL
  const switchResult = await client.eval(`
    (function(){
      // 找到dl.reg.163.com的iframe
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        var src = iframes[i].src || '';
        if (src.includes('dl.reg.163.com')) {
          return 'FOUND_IFRAME: ' + i + ' src=' + src.substring(0, 100);
        }
      }
      return 'NOT_FOUND';
    })()
  `);
  console.log('   登录iframe:', switchResult);

  // 既然跨域无法直接访问iframe DOM，那就通过模拟表单提交
  // 检查是否有form提交地址
  const formInfo = await client.eval(`
    (function(){
      try {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          var iframe = iframes[i];
          try {
            var doc = iframe.contentDocument || iframe.contentWindow.document;
            var forms = doc.querySelectorAll('form');
            if (forms.length > 0) {
              var form = forms[0];
              return JSON.stringify({
                action: form.action,
                method: form.method,
                inputs: Array.from(doc.querySelectorAll('input')).map(function(inp) {
                  return { name: inp.name, type: inp.type, placeholder: inp.placeholder };
                })
              });
            }
          } catch(e) {}
        }
        return 'NO_FORM_OR_CROSS_ORIGIN';
      } catch(e) { return 'ERR: ' + e.message; }
    })()
  `);
  console.log('   表单信息:', formInfo);

  // 尝试通过message API访问
  const msgApi = await client.eval(`
    (function(){
      // 发送消息到子iframe
      var iframes = document.querySelectorAll('iframe');
      var result = [];
      iframes.forEach(function(iframe, i) {
        try {
          iframe.contentWindow.postMessage({type: 'test', value: 'hello'}, '*');
          result.push('msg_sent_to_iframe' + i);
        } catch(e) {
          result.push('iframe' + i + '_err: ' + e.message.substring(0, 50));
        }
      });
      return result.join(', ');
    })()
  `);
  console.log('   postMessage:', msgApi);

  // 最关键的方法：直接用 CDP 的 frameId 切换能力
  // 通过 CDP 协议，Runtime.evaluate 接受 executionContextId 参数
  // 需要先获取 executionContextId
  
  console.log('\n3. 尝试 CDP 跨域执行...');
  const cdpXdomain = await client.eval(`
    (function(){
      // 检查 xb 是否支持跨 iframe 选择器
      // 在 xb 内部，可能是通过 contentDocument 来访问的
      // 让我们检查当前页面有哪些元素
      var inputs = document.querySelectorAll('input');
      return 'MAIN_FRAME inputs: ' + inputs.length;
    })()
  `);
  console.log('   主frame:', cdpXdomain);

  // 用 CDP 的方法: 通过 inject script 到所有 frame
  // 先试试dl.reg.163.com的URL直连
  console.log('\n4. 导航到登录iframe直连URL...');
  await client.navigate('https://dl.reg.163.com/webzj/v1.0.1/pub/index_dl2_new.html?cd=https%3A%2F%2Fstatic.ws.126.net%2F163%2Ff2e%2Fnews%2Fmp_pc_login%2Fresource%2Fstatic%2F&cf=login.zs39.css&MGID=1783314869769.564&pkid=hJWZDGT&product=subscribe');
  
  const url = await client.eval('window.location.href');
  console.log('   当前URL:', url);
  
  const snapshot = await client.eval(`
    (function(){
      var inputs = document.querySelectorAll('input');
      var btns = document.querySelectorAll('button, a');
      var inputInfo = [];
      inputs.forEach(function(inp, i) {
        inputInfo.push({n: inp.name, t: inp.type, p: inp.placeholder, v: inp.value, i: inp.id});
      });
      var btnInfo = [];
      btns.forEach(function(b, i) {
        if (b.innerText.trim()) btnInfo.push(b.innerText.trim().substring(0, 30));
      });
      return JSON.stringify({inputs: inputInfo, btns: btnInfo, title: document.title, bodyLen: document.body.innerText.length});
    })()
  `);
  console.log('   页面内容:', snapshot);

  await client.screenshot('wyy_direct_login.png');

  client.close();
}

main().catch(e => { console.error('错误:', e.message); process.exit(1); });
