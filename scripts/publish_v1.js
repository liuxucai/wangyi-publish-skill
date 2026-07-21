/**
 * 网易号发布 - 完整发布流程 v1
 * 关键：DraftJS 需要特殊注入方法
 */
const WebSocket = require('ws');
const http = require('http');

const TITLE = '资源有限';
// 正文需要 >=250字才能分发到头条
const BODY_TEXT = `在资源有限的条件下，如何做出最优决策，是每个人都会面临的课题。

资源有限，并不意味着无路可走。相反，它往往倒逼我们去思考：什么是真正重要的？什么可以舍弃？什么必须坚持？

经济学的基本假设告诉我们，资源是稀缺的，选择是有代价的。这个道理看似简单，应用起来却需要深刻的自我认知和清晰的优先级判断。

面对有限的时间、金钱、精力，我们真正需要做的，不是贪多求全，而是精准聚焦。把有限资源投入到最核心的目标上，往往比分散用力更能产生突破性结果。

资源的边界，往往也是思维的边界。打破局限的第一步，是承认局限的存在。接受"资源有限"这个事实，才能在此基础上做出最理性的规划和行动。

每一个伟大的成就，都始于对有限资源的创造性运用。越是资源有限，越需要我们深入思考本质，找到那条最高效的路径。

时间不可储存，注意力不可复制，机会稍纵即逝。在有限中寻求无限，是一种智慧，更是一种能力。`;

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
      console.log(`   📸 ${filename}`);
    }
  }
  close() { this.ws.close(); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== 网易号发布 v1 ===\n');
  const info = await discoverChromePort();
  if (!info) { console.error('❌ 未找到 Chrome CDP'); process.exit(1); }
  const client = new CDPClient(info.wsUrl);
  await client.connect();
  console.log('   ✅ 已连接\n');

  const url = await client.getUrl();
  console.log('URL:', url);

  // ============ 1. 填标题 ============
  console.log('\n1. 填标题...');
  const titleResult = await client.eval(`
    (function(){
      var ta = document.querySelector('textarea.netease-textarea');
      if (!ta) return 'TITLE_NF';
      ta.focus();
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '${TITLE}');
      ta.dispatchEvent(new Event('input', {bubbles: true, cancelable: true}));
      ta.dispatchEvent(new Event('change', {bubbles: true, cancelable: true}));
      ta.dispatchEvent(new Event('blur', {bubbles: true}));
      return 'OK: ' + ta.value + ' (' + ta.value.length + '字)';
    })()
  `);
  console.log('   ' + titleResult);
  await sleep(300);

  // ============ 2. 填正文 - DraftJS ============
  console.log('\n2. 填正文（DraftJS）...');

  // 方法：通过 __reactFiber 找 React stateNode，设 DraftJS ContentState
  const bodyResult = await client.eval(`
    (function(){
      var editor = document.querySelector('.public-DraftEditor-content');
      if (!editor) return 'EDITOR_NF';

      // 找最近的 React fiber
      function findFiber(el) {
        var keys = Object.keys(el);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].startsWith('__reactFiber') || keys[i].startsWith('_reactFiber')) {
            return el[keys[i]];
          }
        }
        return null;
      }

      // 向上找 8 层
      var el = editor;
      var fiber = null;
      for (var depth = 0; depth < 8; depth++) {
        if (!el) break;
        fiber = findFiber(el);
        if (fiber) break;
        el = el.parentElement;
      }
      if (!fiber) return 'NO_FIBER';

      // 遍历 fiber 找 editorState
      function findInFiber(f, path) {
        if (!f) return null;
        var keys = Object.keys(f);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (k === 'memoizedProps' || k === 'pendingProps') {
            var v = f[k];
            if (v && typeof v === 'object' && v.editorState) {
              return { path: path + '.' + k, es: v.editorState };
            }
          }
          if (k === 'stateNode' && f.stateNode && f.stateNode.editorState) {
            return { path: path + '.stateNode', es: f.stateNode.editorState };
          }
        }
        // 遍历 child
        if (f.child) {
          var r = findInFiber(f.child, path + '.child');
          if (r) return r;
        }
        // 遍历 sibling
        if (f.sibling) {
          var r = findInFiber(f.sibling, path + '.sibling');
          if (r) return r;
        }
        return null;
      }

      var found = findInFiber(fiber, 'root');
      if (!found) return 'NO_EDITOR_STATE in fiber';
      
      var es = found.es;
      // 确认是 DraftJS editorState
      var content = es && es._immutable && es._immutable.currentContent;
      if (!content) return 'NO_CONTENT: es._immutable=' + (es && es._immutable ? Object.keys(es._immutable).join(',') : 'null');

      // 用 DraftJS ContentState.createFromText 创建内容
      var text = ${JSON.stringify(BODY_TEXT)};
      var DraftJS = window.DraftJS || window.Draft;
      var ContentState, CharacterMetadata, Entity;
      try {
        // 尝试从全局找 DraftJS
        var keys = Object.keys(window);
        for (var wi = 0; wi < keys.length; wi++) {
          var w = window[keys[wi]];
          if (w && w.ContentState && w.ContentState.createFromText) {
            ContentState = w.ContentState;
            CharacterMetadata = w.CharacterMetadata;
            Entity = w.Entity;
            break;
          }
        }
      } catch(e) {}

      // 直接操作 immutable currentContent
      // 构造新 content
      var newContent = content;
      try {
        // 尝试: editorState = EditorState.push(es, newContent, 'insert-characters')
        // 先找 EditorState.push
        var EditorState = null;
        var draftGlobals = ['Draft', 'DraftJS', 'draftJs', 'draftjs'];
        for (var di = 0; di < draftGlobals.length; di++) {
          if (window[draftGlobals[di]] && window[draftGlobals[di]].EditorState) {
            EditorState = window[draftGlobals[di]].EditorState;
            break;
          }
        }

        if (EditorState && EditorState.push) {
          // 构造 fromText
          var newCS = ContentState.createFromText(text);
          var newES = EditorState.push(es, newCS, 'insert-characters');
          // 设回 stateNode
          var sn = found.path.split('.').reduce(function(obj, k) { return obj && obj[k]; }, fiber);
          if (sn && sn.editorState) {
            sn.editorState = newES;
          }
          return 'DRAFTJS_OK: text_len=' + text.length + ' via EditorState.push';
        }
      } catch(e) {
        return 'DRAFTJS_ERR: ' + e.message;
      }

      // 备用：直接改 _immutable.currentContent
      try {
        var immutable = es._immutable;
        // ContentState.createFromText
        var blocks = text.split('\\n').map(function(line) {
          return {
            key: 'atomic:' + Math.random().toString(36).substr(2, 5),
            type: 'unstyled',
            text: line,
            depth: 0,
            inlineStyleRanges: [],
            entityRanges: []
          };
        });
        // 如果全为空行，创建一个默认块
        if (blocks.length === 0 || blocks.every(function(b) { return !b.text; })) {
          blocks = [{ key: 'a', type: 'unstyled', text: text, depth: 0, inlineStyleRanges: [], entityRanges: [] }];
        }
        immutable._root = immutable._root.set('BLOCKS', immutable._root.getBlockMap ? immutable._root.getBlockMap().merge(blocks) : null);
        return 'MANUAL_SET: text_len=' + text.length;
      } catch(e2) {
        return 'ALL_FAIL: ' + e2.message;
      }
    })()
  `);
  console.log('   DraftJS:', bodyResult);

  await sleep(500);

  // ============ 3. 检查状态 ============
  console.log('\n3. 检查状态...');
  const state = await client.eval(`
    (function(){
      var ta = document.querySelector('textarea.netease-textarea');
      var editor = document.querySelector('.public-DraftEditor-content');
      var bodyText = editor ? (editor.innerText || '') : '';
      return JSON.stringify({
        titleLen: ta ? ta.value.length : 0,
        bodyLen: bodyText.length,
        bodySnippet: bodyText.substring(0, 100)
      });
    })()
  `);
  console.log('   ' + state);

  await client.screenshot('wyy_step3.png');

  // ============ 4. 如果正文未填入，尝试 execCommand 方案 ============
  const bodyLen = JSON.parse(state).bodyLen;
  if (bodyLen < 50) {
    console.log('\n4. 正文注入失败，尝试 execCommand 方案...');
    const execResult = await client.eval(`
      (function(){
        var editor = document.querySelector('.public-DraftEditor-content');
        if (!editor) return 'EDITOR_NF';
        
        var text = ${JSON.stringify(BODY_TEXT)};
        
        // 清空现有内容
        editor.innerHTML = '';
        
        // 分段落填入
        var paragraphs = text.split('\\n\\n');
        paragraphs.forEach(function(p, i) {
          p = p.trim();
          if (!p) return;
          var pEl = document.createElement('p');
          pEl.innerText = p;
          editor.appendChild(pEl);
        });
        
        editor.dispatchEvent(new Event('input', {bubbles: true, cancelable: true}));
        editor.dispatchEvent(new Event('change', {bubbles: true, cancelable: true}));
        
        return 'execCommand: bodyLen=' + (editor.innerText || '').length;
      })()
    `);
    console.log('   ' + execResult);
    await client.screenshot('wyy_execCommand.png');
  }

  // ============ 5. 截图确认 ============
  console.log('\n5. 最终状态确认...');
  const finalState = await client.eval(`
    (function(){
      var ta = document.querySelector('textarea.netease-textarea');
      var editor = document.querySelector('.public-DraftEditor-content');
      var charCount = document.querySelector('.public-DraftEditorPlaceholder-root, [class*="charCount"], [class*="char-count"]');
      var bodyText = editor ? (editor.innerText || '') : '';
      return JSON.stringify({
        title: ta ? ta.value : '',
        bodyLen: bodyText.length,
        bodyPreview: bodyText.substring(0, 80)
      });
    })()
  `);
  console.log('   ' + finalState);
  await client.screenshot('wyy_confirm.png');

  // ============ 6. 点击发布 ============
  console.log('\n6. 点击发布...');
  const pubResult = await client.eval(`
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
      pubBtn.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
      pubBtn.dispatchEvent(new Event('focus', {bubbles: true}));
      pubBtn.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true}));
      pubBtn.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
      return 'CLICKED: disabled=' + pubBtn.disabled;
    })()
  `);
  console.log('   ' + pubResult);

  console.log('\n7. 等待结果（5秒）...');
  await sleep(5000);

  const finalUrl = await client.getUrl();
  const finalPage = await client.eval(`
    (function(){
      var bodyText = document.body.innerText.substring(0, 500);
      return bodyText;
    })()
  `);
  console.log('   URL:', finalUrl);
  console.log('   页面内容片段:', finalPage.substring(0, 300));

  await client.screenshot('wyy_published.png');

  client.close();
  console.log('\n=== 完成 ===');
}

main().catch(e => { console.error('错误:', e.message); process.exit(1); });
