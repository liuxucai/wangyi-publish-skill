/**
 * wyy-publisher/lib.js
 * 网易号 CDP 客户端封装
 */
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.pending = {};
    this.msgId = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id && this.pending[msg.id]) {
            this.pending[msg.id](msg.result);
            delete this.pending[msg.id];
          }
        } catch (e) {}
      });
    });
  }

  send(method, params = {}, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending[id] = resolve;
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending[id]) {
          delete this.pending[id];
          reject(new Error(`超时: ${method}`));
        }
      }, timeout);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.value;
  }

  async getUrl() {
    return await this.eval('window.location.href');
  }

  async getTitle() {
    return await this.eval('document.title');
  }

  async getBodyText(maxLen = 300) {
    return await this.eval(`document.body.innerText.substring(0, ${maxLen})`);
  }

  async screenshot(filename) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (r?.data) {
      const fs = require('fs');
      fs.writeFileSync(filename, Buffer.from(r.data, 'base64'));
      return filename;
    }
    return null;
  }

  close() {
    this.ws.close();
  }
}

/**
 * 发现 Chrome CDP 端口
 * @returns {Promise<{wsUrl: string, port: number}>}
 */
function discoverChromePort(ports = [9222, 9223, 9224, 9225, 4637]) {
  return new Promise((resolve) => {
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 填标题
 */
async function fillTitle(client, title) {
  return await client.eval(`
    (function(){
      var ta = document.querySelector('textarea.netease-textarea');
      if (!ta) return 'TITLE_NF';
      ta.focus();
      var setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      setter.call(ta, '${title.replace(/'/g, "\\'")}');
      ['input', 'change', 'blur'].forEach(function(e) {
        ta.dispatchEvent(new Event(e, {bubbles: true, cancelable: true}));
      });
      return 'OK: ' + ta.value + ' (' + ta.value.length + '字)';
    })()
  `);
}

/**
 * 填正文（DraftJS 编辑器）
 * 注意：不能用 innerHTML 直接替换，用分段落 appendChild 方式
 */
async function fillBody(client, bodyText) {
  const escaped = bodyText.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  return await client.eval(`
    (function(){
      var editor = document.querySelector('.public-DraftEditor-content');
      if (!editor) return 'EDITOR_NF';

      var text = \`${escaped}\`;
      var paragraphs = text.split('\\n\\n');

      editor.innerHTML = '';
      paragraphs.forEach(function(p) {
        p = p.trim();
        if (!p) return;
        var pEl = document.createElement('p');
        pEl.innerText = p;
        editor.appendChild(pEl);
      });

      editor.dispatchEvent(new Event('input', {bubbles: true, cancelable: true}));
      editor.dispatchEvent(new Event('change', {bubbles: true, cancelable: true}));

      return 'OK: ' + (editor.innerText || '').length + '字';
    })()
  `);
}

/**
 * 获取正文字数
 */
async function getBodyLength(client) {
  return await client.eval(`
    (function(){
      var editor = document.querySelector('.public-DraftEditor-content');
      return editor ? (editor.innerText || '').length : 0;
    })()
  `);
}

/**
 * 点击发布按钮
 */
async function clickPublish(client) {
  return await client.eval(`
    (function(){
      var allBtns = document.querySelectorAll('button');
      var pubBtn = null;
      for (var i = 0; i < allBtns.length; i++) {
        if (allBtns[i].innerText && allBtns[i].innerText.trim() === '发布') {
          pubBtn = allBtns[i];
          break;
        }
      }
      if (!pubBtn) return 'PUB_BTN_NF';
      pubBtn.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
      pubBtn.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      return 'CLICKED';
    })()
  `);
}

/**
 * 设置封面模式
 * @param {string} mode - 'threeImg' | 'custom' | 'bigImg' | 'auto'
 */
async function setCoverMode(client, mode) {
  return await client.eval(`
    (function(){
      var radio = document.querySelector('input[type="radio"][value="${mode}"]');
      if (!radio) return 'RADIO_NF: ' + '${mode}';
      radio.click();
      return 'OK: ' + radio.value;
    })()
  `);
}

/**
 * 检查账号状态
 */
async function checkAccountStatus(client) {
  return await client.eval(`
    (function(){
      var text = document.body.innerText;
      if (text.includes('正在审核中')) return 'ACCOUNT_AUDITING';
      if (text.includes('审核通过')) return 'ACCOUNT_APPROVED';
      if (text.includes('审核未通过')) return 'ACCOUNT_REJECTED';
      return 'ACCOUNT_UNKNOWN';
    })()
  `);
}

module.exports = {
  CDPClient,
  discoverChromePort,
  sleep,
  fillTitle,
  fillBody,
  getBodyLength,
  clickPublish,
  setCoverMode,
  checkAccountStatus
};
