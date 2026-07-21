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
            if (pageTab) {
              resolve({ wsUrl: pageTab.webSocketDebuggerUrl, port, tab: pageTab });
            } else {
              tryPort();
            }
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
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r?.result?.value;
  }
  async getFrameTree() {
    return await this.send('Page.getFrameTree', {});
  }
  async navigate(url) {
    await this.send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, 3000));
  }
  close() { this.ws.close(); }
}

async function main() {
  const info = await discoverChromePort();
  if (!info) { console.error('未找到Chrome'); process.exit(1); }
  const client = new CDPClient(info.wsUrl);
  await client.connect();
  console.log('已连接\n');

  const tree = await client.getFrameTree();
  console.log('=== Frame Tree ===');
  console.log(JSON.stringify(tree, null, 2));

  client.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
