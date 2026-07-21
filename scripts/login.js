/**
 * 网易号登录脚本 - CDP直连（跨域iframe操作）
 */
const WebSocket = require('ws');
const http = require('http');

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
  async evalInFrame(frameId, expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, contextId: undefined });
    return r?.result?.value;
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.value;
  }
  async getUrl() {
    const r = await this.send('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true });
    return r?.result?.value;
  }
  async activateFrame(frameId) {
    await this.send('Page.bringFrameToFront', { frameId });
    await new Promise(r => setTimeout(r, 500));
  }
  async getFrameTree() {
    return await this.send('Page.getFrameTree', {});
  }
  async createIsolatedWorld(frameId, worldName) {
    return await this.send('Page.createIsolatedWorld', { frameId, worldName, grantReadability: true });
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
  console.log('=== 网易号登录 ===\n');
  const info = await discoverChromePort();
  if (!info) { console.error('❌ 未找到 Chrome CDP'); process.exit(1); }
  const client = new CDPClient(info.wsUrl);
  await client.connect();
  console.log('   ✅ 已连接 CDP\n');

  // 获取frame tree
  const tree = await client.getFrameTree();
  const mainFrameId = tree.frameTree.frame.id;
  const iframeFrame = tree.frameTree.childFrames[0].frame;
  const iframeFrameId = iframeFrame.id;
  console.log('主页面 frame:', mainFrameId);
  console.log('登录iframe frame:', iframeFrameId);
  console.log('iframe URL:', iframeFrame.url.substring(0, 80));

  // 创建isolated world来访问iframe
  console.log('\n创建isolated world...');
  await client.createIsolatedWorld(iframeFrameId, 'loginWorld');

  // 检查登录表单
  const check = await client.eval(`
    (function(){
      var inputs = document.querySelectorAll('input');
      var result = {};
      inputs.forEach(function(inp, i) {
        result['inp'+i] = { type: inp.type, placeholder: inp.placeholder, name: inp.name, id: inp.id, value: inp.value };
      });
      var links = document.querySelectorAll('a, button');
      var actions = [];
      links.forEach(function(l) { if(l.innerText.trim()) actions.push(l.innerText.trim().substring(0,30)); });
      return JSON.stringify({ inputs: result, actions: actions.slice(0,10) });
    })()
  `);
  console.log('表单元素:', check);

  // 尝试填入账号
  const fillResult = await client.eval(`
    (function(){
      // 找账号输入框 - 网易邮箱号
      var userInput = document.querySelector('input[id*="account"], input[id*="user"], input[name*="account"], input[id*="email"], input[placeholder*="邮箱"], input[placeholder*="手机"]');
      if (!userInput) {
        // 尝试所有input
        var all = document.querySelectorAll('input');
        for (var i = 0; i < all.length; i++) {
          var inp = all[i];
          if (inp.type !== 'hidden' && inp.type !== 'checkbox' && inp.type !== 'radio' && inp.type !== 'button' && inp.type !== 'submit') {
            userInput = inp;
            break;
          }
        }
      }
      if (!userInput) return 'USER_NF';

      // 找密码输入框
      var passInput = document.querySelector('input[type="password"]');
      if (!passInput) return 'PASS_NF';

      userInput.value = '${ACCOUNT}';
      passInput.value = '${PASSWORD}';

      userInput.dispatchEvent(new Event('input', {bubbles: true}));
      userInput.dispatchEvent(new Event('change', {bubbles: true}));
      passInput.dispatchEvent(new Event('input', {bubbles: true}));
      passInput.dispatchEvent(new Event('change', {bubbles: true}));

      return 'OK: user=' + userInput.value + ' pass_len=' + passInput.value.length;
    })()
  `);
  console.log('\n1. 填入账号密码:', fillResult);

  await client.screenshot('wyy_step1.png');
  await sleep(500);

  // 点击登录按钮
  const clickResult = await client.eval(`
    (function(){
      // 找登录按钮
      var btn = document.querySelector('button[type="submit"]');
      if (!btn) {
        var links = document.querySelectorAll('a, button');
        for (var i = 0; i < links.length; i++) {
          var t = links[i].innerText.trim();
          if (t.includes('登录') || t.includes('登 录')) {
            btn = links[i];
            break;
          }
        }
      }
      if (!btn) return 'BTN_NF';
      btn.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
      btn.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
      btn.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      return 'CLICKED: ' + btn.innerText.trim().substring(0, 30);
    })()
  `);
  console.log('2. 点击登录:', clickResult);

  console.log('\n3. 等待页面跳转（8秒）...');
  await sleep(8000);

  const url = await client.getUrl();
  console.log('4. 当前URL:', url);

  await client.screenshot('wyy_after_login.png');

  if (url.includes('login')) {
    console.log('⚠️ 仍在登录页，可能触发了安全验证');
    // 检查是否有验证码
    const checkCaptcha = await client.eval(`
      (function(){
        var body = document.body.innerText || '';
        var hasCaptcha = body.includes('验证码') || body.includes('验证') || document.querySelector('img[src*="captcha"], canvas') !== null;
        return JSON.stringify({ hasCaptcha: hasCaptcha, bodySnippet: body.substring(0, 200) });
      })()
    `);
    console.log('验证码检查:', checkCaptcha);
  } else {
    console.log('✅ 登录成功！');
  }

  client.close();
}

main().catch(e => { console.error('错误:', e.message); process.exit(1); });
