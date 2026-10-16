/**
 * 网易号文章发布（playwright-core 直连 CDP，2026-09-27 全流程实测通过）
 *
 * 用法:
 *   node scripts/publish.cjs <title.txt> <body.txt> [--keyword "婚车租车" --tags "婚庆用车,婚庆婚车车队"] [--publish] [--cdp 9222]
 *
 *   - 不带 --publish: 填充内容+插图+截图预览，不点发布（草稿会自动保存到草稿箱）
 *   - 配图默认 3 张（按标签从素材库自动挑）；也可手动指定：
 *       node scripts/publish.cjs t.txt b.txt --image a.jpg --image b.jpg --image c.jpg
 *     或兼容旧用法：把图片路径作为位置参数（可多个）跟在 body 之后
 *   - --no-image 不配图；--image-top N 改张数（网易要求正文必须有图，否则不能发布）
 *   - 插图：CDP 原生拖拽（Input.dispatchDragEvent + files 本地路径，isTrusted=true）。
 *     ⚠️ 旧「合成 DragEvent('drop')」方案已被新编辑器证伪（事件可达但不处理，2026-10-13）
 *   - 封面选"自动"（平台自动取正文图；单图/大图的上传按钮弹原生文件对话框，网页端无法自动化）
 *   - 点发布可能被「您的账号未上线，暂不支持发布」拦截（账号状态限制）——内容与封面
 *     已自动保存在草稿箱，账号上线后打开草稿直接点发布即可（脚本 exit 2 并提示）
 *
 * 依赖:
 *   - playwright-core（路径由 ../../isolated-browser/scripts/pathkit.js 运行时探测，
 *     也可设 OPENCLAW_NODE_MODULES / NODE_PATH 覆盖）
 *   - 隔离 Chrome 已启动且 CDP 可连（见 SKILL.md 启动方法，profile 默认 ~/.chrome_qclaw_wyy）
 *   - 账号已登录且已实名认证（未实名时发布按钮点了没反应）
 */
const fs = require('fs');
const path = require('path');

function loadChromium() {
  // 首选：公共解析器（不写死用户名 / 盘符 / 版本号）
  try {
    return require(path.resolve(__dirname, '..', '..', 'isolated-browser', 'scripts', 'pathkit.js')).chromium();
  } catch (e) { /* 回退本地探测 */ }
  const os = require('os');
  const cands = [
    process.env.OPENCLAW_NODE_MODULES,
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules'),
  ].filter(Boolean);
  for (const c of cands) {
    try { return require(path.join(c, 'playwright-core')).chromium; } catch (e) { /* next */ }
  }
  return require('playwright-core').chromium;
}

const chromium = loadChromium();

const ARGV = process.argv.slice(2);
const POS = [];
const FL = { publish: false, noImage: false, cdp: null, keyword: null, tags: null, top: null, dir: null, images: [] };
for (let i = 0; i < ARGV.length; i++) {
  const a = ARGV[i];
  if (a === '--publish') { FL.publish = true; continue; }
  if (a === '--no-image') { FL.noImage = true; continue; }
  if (a === '--cdp') { FL.cdp = ARGV[++i]; continue; }
  if (a === '--keyword') { FL.keyword = ARGV[++i]; continue; }
  if (a === '--tags') { FL.tags = ARGV[++i]; continue; }
  if (a === '--image-top') { FL.top = ARGV[++i]; continue; }
  if (a === '--image-dir') { FL.dir = ARGV[++i]; continue; }
  if (a === '--image') { FL.images.push(ARGV[++i]); continue; }
  if (a.startsWith('--')) continue;
  POS.push(a);
}
const titleFile = POS[0], bodyFile = POS[1];
const posImages = POS.slice(2);            // 兼容旧用法：位置参数直接传图
const DO_PUBLISH = FL.publish;
const CDP_PORT = FL.cdp || process.env.ISOB_CDP_PORT || 9222;

if (!titleFile || !bodyFile) {
  console.error('用法: node publish.cjs <title.txt> <body.txt> [image...] [--image x.jpg ...] [--keyword k --tags "a,b"] [--publish] [--cdp 9222]');
  process.exit(1);
}
const TITLE = fs.readFileSync(titleFile, 'utf8').trim();
const BODY = fs.readFileSync(bodyFile, 'utf8').replace(/\r\n/g, '\n').trim();

// 配图：显式（--image / 位置参数）优先；否则按「标签 → 素材库」自动挑 Top-N（默认 3 张）
const { planImages } = require(path.resolve(__dirname, '..', '..', 'isolated-browser', 'scripts', 'post_images.js'));
const plan = planImages({
  explicit: FL.images.concat(posImages), noImage: FL.noImage, keyword: FL.keyword || TITLE, tags: FL.tags,
  top: FL.top, dir: FL.dir, paraCount: BODY.split(/\n\s*\n/).filter(Boolean).length,
});
const IMAGES = plan.images;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** CDP 原生截图（page.screenshot 在本页会 30s 超时，必须走 Page.captureScreenshot） */
async function cdpShot(page, file) {
  const c = await page.context().newCDPSession(page);
  const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  await c.detach().catch(() => {});
}

(async () => {
  console.log('=== 网易号发布 ===');
  console.log(`标题(${TITLE.length}字) 正文(${BODY.length}字) 配图:${IMAGES.length}张 模式:${DO_PUBLISH ? '发布' : '预览'}`);

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

  // 5. 插入正文配图 —— CDP 原生拖拽（Input.dispatchDragEvent + files 本地路径）。
  //    ⚠️ 合成 DragEvent('drop') 已证伪：事件能到达编辑器（types=['Files']）但编辑器不处理
  //    （defaultPrevented=false、不触发上传），2026-10-13 实测；CDP 真实拖拽 isTrusted=true 有效。
  if (IMAGES.length) {
    console.log(`[配图] ${IMAGES.length} 张（来源 ${plan.source}）`);
    if (plan.detail) plan.detail.chosen.forEach((c, i) => console.log(`  ${i + 1}) 图${c.number} ${c.name || ''} → ${c.image}`));
    const client = await page.context().newCDPSession(page);
    let failCnt = 0;
    for (let k = 0; k < IMAGES.length; k++) {
      const img = IMAGES[k];
      if (!fs.existsSync(img)) { console.error('配图不存在:', img); process.exit(5); }
      // 聚焦 + 光标到末尾；落点优先取光标实际 rect。
      // ⚠️ 坑：编辑器 rect.top+300 公式在页面滚动后会落到视口顶部工具栏区（甚至负值）导致 drop 无效
      await page.locator('.public-DraftEditor-content').click().catch(() => {});
      await page.keyboard.press('Control+End');
      await sleep(800);
      const pt = await page.evaluate(() => {
        const sel = window.getSelection();
        if (sel.rangeCount) {
          const r = sel.getRangeAt(0).getBoundingClientRect();
          if (r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        const er = document.querySelector('.public-DraftEditor-content').getBoundingClientRect();
        return { x: Math.round(er.left + er.width / 2), y: Math.round(Math.min(Math.max(er.top + 100, 150), window.innerHeight - 100)) };
      });
      const before = await page.evaluate(() => document.querySelectorAll('.public-DraftEditor-content img').length);
      const data = { items: [], files: [path.resolve(img)], dragOperationsMask: 1 };
      await client.send('Input.setInterceptDrags', { enabled: true });
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await client.send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data });
        await sleep(500);
      }
      let ok = false;
      for (let i = 0; i < 12; i++) {
        await sleep(2000);
        const n = await page.evaluate(() => document.querySelectorAll('.public-DraftEditor-content img').length);
        if (n > before) { ok = true; break; }
      }
      console.log(`  配图 ${k + 1}/${IMAGES.length} cdp-drop ${ok ? 'OK' : 'FAIL（未确认）'}`);
      if (!ok) failCnt++;
    }
    const imgs = await page.evaluate(() => document.querySelectorAll('.public-DraftEditor-content img').length);
    console.log('正文图片数:', imgs);
    await client.detach().catch(() => {});
    if (failCnt > 0) {
      const shotDir = path.join(__dirname, '..', '.workspace');
      fs.mkdirSync(shotDir, { recursive: true });
      await cdpShot(page, path.join(shotDir, 'wyy_imgfail.png')).catch(() => {});
      console.error(`❌ ${failCnt} 张插图未确认；正文必须有图才能发布`);
      process.exit(5);
    }
  }

  // 6. 封面设为自动（单图/三图/大图需手动上传，网页端自动化会弹原生对话框卡死页面）
  const radio = page.locator('input[type="radio"][value="auto"]');
  if (await radio.count()) {
    await radio.evaluate(el => el.click()).catch(() => {});
    console.log('封面: 自动');
    await sleep(1500);
  }

  const shotDir = path.join(__dirname, '..', '.workspace');
  fs.mkdirSync(shotDir, { recursive: true });
  await cdpShot(page, path.join(shotDir, 'wyy_preview.png')).catch(() => {});

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

  // 结果判定（URL 不变 + 弹窗提示 = 被拦；成功 = URL 跳转或出现"发布成功"）
  const flag = await page.evaluate(() => {
    const t = document.body.innerText || '';
    return {
      offLine: t.includes('未上线') || t.includes('暂不支持发布'),
      realname: t.includes('请先通过实名认证'),
      success: /发布成功/.test(t) || !/article-publish/.test(location.href),
    };
  });
  console.log('URL:', page.url());
  if (flag.success) {
    console.log('✅ 发布成功');
  } else if (flag.offLine) {
    console.log('❌ 「您的账号未上线，暂不支持发布」——账号状态限制（2026-10-13 实测）。内容、配图、封面已自动保存在草稿箱，账号上线后打开草稿直接点发布即可。');
    process.exitCode = 2;
  } else if (flag.realname) {
    console.log('❌ 被实名认证拦截：需在手机端"网易新闻"App（我的→创作中心→去实名认证）完成实名后再发布');
    process.exitCode = 2;
  } else {
    console.log('⚠️ 未见成功标志，请查看 .workspace/wyy_preview.png 确认结果');
  }
  browser.close();
})().catch(e => { console.error('❌ 错误:', e.message); process.exit(1); });
