/**
 * 网易号文章发布（playwright-core 直连 CDP，2026-09-27 全流程实测通过）
 *
 * 用法:
 *   node scripts/publish.cjs <title.txt> <body.txt> [image.jpg] [--publish] [--cdp 9222]
 *
 *   - 不带 --publish: 填充内容+插图+截图预览，不点发布（草稿会自动保存到草稿箱）
 *   - image.jpg: 插入正文配图（网易要求正文必须有图，否则不能发布）
 *   - 封面自动选"自动"模式（网页端无法自动化上传封面，会弹原生文件对话框）
 *
 * 依赖:
 *   - playwright-core（NODE_PATH 指向 ~/.workbuddy/binaries/node/workspace/node_modules）
 *   - 隔离 Chrome 已启动且 CDP 可连（见 SKILL.md 启动方法，profile ~/.chrome_qclaw_wyy）
 *   - 账号已登录且已实名认证（未实名时发布按钮点了没反应）
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const [, , titleFile, bodyFile, imgFile, ...rest] = process.argv;
const DO_PUBLISH = rest.includes('--publish');
const cdpIdx = rest.indexOf('--cdp');
const CDP_PORT = cdpIdx > -1 ? rest[cdpIdx + 1] : 9222;

if (!titleFile || !bodyFile) {
  console.error('用法: node publish.cjs <title.txt> <body.txt> [image.jpg] [--publish] [--cdp 9222]');
  process.exit(1);
}
const TITLE = fs.readFileSync(titleFile, 'utf8').trim();
const BODY = fs.readFileSync(bodyFile, 'utf8').replace(/\r\n/g, '\n').trim();
const IMG_B64 = imgFile && fs.existsSync(imgFile) ? fs.readFileSync(imgFile).toString('base64') : null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('=== 网易号发布 ===');
  console.log(`标题(${TITLE.length}字) 正文(${BODY.length}字) 配图:${imgFile || '无'} 模式:${DO_PUBLISH ? '发布' : '预览'}`);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0] || await browser.newContext();

  // 1. 找到/打开发布页（SPA 内部跳转优先用菜单点击，goto hash 有时不生效）
  let page = context.pages().find(p => p.url().includes('mp.163.com'));
  if (!page) {
    page = await context.newPage();
    await page.goto('https://mp.163.com/#/article-publish', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else if (!page.url().includes('article-publish')) {
    await page.goto('https://mp.163.com/#/article-publish', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  }
  await sleep(6000);
  console.log('URL:', page.url());

  // 2. 状态检查
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (page.url().includes('login') || bodyText.includes('扫码登录') || bodyText.includes('密码登录')) {
    console.error('❌ 未登录，请先运行 scripts/login.cjs');
    process.exit(3);
  }
  if (bodyText.includes('正在审核中')) { console.error('❌ 账号审核中，不能发布'); process.exit(2); }

  // 3. 填标题（React setter）
  const t = await page.evaluate((title) => {
    const ta = document.querySelector('textarea.netease-textarea');
    if (!ta) return 'TITLE_NF';
    ta.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, title);
    ['input', 'change', 'blur'].forEach(e => ta.dispatchEvent(new Event(e, { bubbles: true })));
    return 'OK';
  }, TITLE);
  console.log('标题:', t);
  if (t === 'TITLE_NF') process.exit(4);

  // 4. 填正文 —— 必须用 paste 事件！appendChild/innerHTML 均无效（字数显示0）
  await page.locator('.public-DraftEditor-content').click();
  await page.keyboard.press('Control+End');
  await sleep(500);
  const b = await page.evaluate((text) => {
    const editor = document.querySelector('.public-DraftEditor-content');
    if (!editor) return 'EDITOR_NF';
    editor.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return 'OK';
  }, BODY);
  console.log('正文粘贴:', b);
  await sleep(2000);
  const words = await page.evaluate(() => (document.body.innerText.match(/共(\d+)字/) || [])[1] || '?');
  console.log('字数统计:', words);
  if (words === '0' || words === '?') console.warn('⚠️ 正文可能注入失败');

  // 5. 插入正文配图 —— DataTransfer drop 事件（页面上唯一的 file input 是"导入文档"，不能用它传图）
  if (IMG_B64) {
    await page.keyboard.press('Control+End');
    const drop = await page.evaluate((base64) => {
      const editor = document.querySelector('.public-DraftEditor-content');
      if (!editor) return 'EDITOR_NF';
      const bin = atob(base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], 'image.jpg', { type: 'image/jpeg' }));
      editor.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return 'OK';
    }, IMG_B64);
    console.log('配图 drop:', drop);
    await sleep(6000);
    const imgs = await page.evaluate(() => document.querySelectorAll('.public-DraftEditor-content img').length);
    console.log('正文图片数:', imgs);
  }

  // 6. 封面设为自动（单图/三图/大图需手动上传，网页端自动化会弹原生对话框卡死页面）
  const radio = page.locator('input[type="radio"][value="auto"]');
  if (await radio.count()) {
    await radio.evaluate(el => el.click()).catch(() => {});
    console.log('封面: 自动');
    await sleep(1500);
  }

  await page.screenshot({ path: path.join(__dirname, '..', 'wyy_preview.png') }).catch(() => {});

  // 7. 发布
  if (!DO_PUBLISH) {
    console.log('\n预览模式结束（草稿已自动保存）。加 --publish 正式发布。');
    browser.close();
    return;
  }
  const pubBtn = page.locator('button:visible', { hasText: /^发布$/ }).first();
  await pubBtn.click({ timeout: 10000 }).catch(e => console.log('发布点击失败:', e.message.split('\n')[0]));
  console.log('已点击发布，等待结果...');
  await sleep(8000);

  // 发布无反应 = 页面顶部"请先通过实名认证再发布内容"（手机端网易新闻App实名，网页端无法代办）
  const realname = await page.evaluate(() => document.body.innerText.includes('请先通过实名认证'));
  const finalUrl = page.url();
  console.log('URL:', finalUrl);
  console.log(realname ? '❌ 被实名认证拦截：需在手机端"网易新闻"App（我的→创作中心→去实名认证）完成实名后再发布' : '✅ 未被实名认证拦截，请查看截图确认发布结果');
  browser.close();
})().catch(e => { console.error('❌ 错误:', e.message); process.exit(1); });
