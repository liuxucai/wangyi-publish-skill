/**
 * 网易号发布 - 完整发布 v2
 * 用 CDP MouseEvent 直接触发发布按钮
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
  send(method, params = {}, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending[id] = resolve;
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending[id]) { delete this.pending[id]; reject(new Error(`超时: ${method}`)); } }, timeout);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r?.result?.value;
  }
  async getUrl() { return await this.eval('window.location.href'); }
  async getBodyText(n = 300) { return await this.eval(`document.body.innerText.substring(0, ${n})`); }
  async screenshot(fname) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (r?.data) {
      const fs = require('fs');
      fs.writeFileSync(fname, Buffer.from(r.data, 'base64'));
      console.log('   📸 ' + fname);
    }
  }
  close() { this.ws.close(); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== 网易号发布 v2 ===\n');
  const info = await discoverChromePort();
  if (!info) { console.error('❌ 未找到Chrome'); process.exit(1); }
  const client = new CDPClient(info.wsUrl);
  await client.connect();
  console.log('   ✅ 已连接\n');

  const url = await client.getUrl();
  console.log('URL:', url);

  // 1. 确认当前状态
  console.log('\n1. 当前状态...');
  const state1 = await client.eval(`
    (function(){
      var ta = document.querySelector('textarea.netease-textarea');
      var editor = document.querySelector('.public-DraftEditor-content');
      var bodyLen = editor ? (editor.innerText || '').length : 0;
      var autoRadio = document.querySelector('input[type="radio"][value="auto"]');
      return JSON.stringify({
        title: ta ? ta.value : '',
        bodyLen: bodyLen,
        autoChecked: autoRadio ? autoRadio.checked : false,
        url: window.location.href
      });
    })()
  `);
  console.log('   ' + state1);

  // 2. 确保自动封面
  console.log('\n2. 切换到自动封面...');
  const coverResult = await client.eval(`
    (function(){
      var autoRadio = document.querySelector('input[type="radio"][value="auto"]');
      if (!autoRadio) return 'AUTO_RADIO_NF';
      if (autoRadio.checked) return 'ALREADY_AUTO';
      autoRadio.click();
      return 'SWITCHED_TO_AUTO: checked=' + autoRadio.checked;
    })()
  `);
  console.log('   ' + coverResult);

  // 3. 检查正文是否真的写入了
  console.log('\n3. 验证正文状态...');
  const bodyCheck = await client.eval(`
    (function(){
      var editor = document.querySelector('.public-DraftEditor-content');
      if (!editor) return 'EDITOR_NF';
      var text = editor.innerText || '';
      return 'bodyLen=' + text.length + ' preview=' + text.substring(0, 80);
    })()
  `);
  console.log('   ' + bodyCheck);

  // 4. 点发布（CDP MouseEvent）
  console.log('\n4. 点击发布按钮（CDP MouseEvent）...');
  
  // 先获取按钮位置
  const btnBox = await client.eval(`
    (function(){
      var allBtns = document.querySelectorAll('button');
      for (var i = 0; i < allBtns.length; i++) {
        if (allBtns[i].innerText && allBtns[i].innerText.trim() === '发布') {
          var rect = allBtns[i].getBoundingClientRect();
          return JSON.stringify({
            found: true,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            disabled: allBtns[i].disabled
          });
        }
      }
      return JSON.stringify({found: false});
    })()
  `);
  console.log('   按钮位置:', btnBox);

  const btnInfo = JSON.parse(btnBox);
  if (btnInfo.found && !btnInfo.disabled) {
    // 发送完整的 MouseEvent 序列
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: btnInfo.x,
      y: btnInfo.y,
      button: 'left',
      clickCount: 1
    });
    await sleep(50);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: btnInfo.x,
      y: btnInfo.y,
      button: 'left',
      clickCount: 1
    });
    console.log('   ✅ MouseEvent 已发送');
  } else {
    console.log('   ⚠️ 按钮未找到或被禁用');
  }

  console.log('\n5. 等待页面响应（8秒）...');
  await sleep(8000);

  const finalUrl = await client.getUrl();
  const finalBody = await client.getBodyText(500);
  await client.screenshot('wyy_v2_result.png');

  console.log('\n======================================');
  console.log('发布结果');
  console.log('======================================');
  console.log('URL:', finalUrl);
  console.log('\n页面内容:\n' + finalBody.substring(0, 400));

  // 检查是否是文章管理页
  if (finalUrl.includes('management') || finalUrl.includes('success')) {
    console.log('\n🎉 可能发布成功！请确认页面内容。');
  } else {
    console.log('\n⚠️ URL 未变化，检查是否有错误提示。');
  }
  console.log('======================================');

  client.close();
}

main().catch(e => { console.error('错误:', e.message); process.exit(1); });
