/**
 * 网易号登录（playwright-core 直连 CDP，跨域 iframe 逐字输入）
 * 用法: node scripts/login.cjs [--cdp 9222]
 *
 * 登录表单在跨域 iframe (dl.reg.163.com) 内，playwright 可直接 frame 操作。
 * 密码必须 pressSequentially 逐字输入（触发完整事件链，降低风控概率）。
 * 首次登录可能触发二次验证：滑块（yidun_slider，可尝试模拟人手拖动）+ 短信验证码（需用户手机）。
 */
const path = require('path');
const { chromium } = require('playwright-core');

const ACCOUNT = '13414054304@163.com';
const PASSWORD = 'wangyi.939.';
const cdpIdx = process.argv.indexOf('--cdp');
const CDP_PORT = cdpIdx > -1 ? process.argv[cdpIdx + 1] : 9222;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes('163.com')) || context.pages()[0];
  console.log('页面:', page.url());

  // 发布页未登录会 302 到 login.html
  if (!page.url().includes('login')) {
    await page.goto('https://mp.163.com/#/article-publish', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await sleep(4000);
  }
  if (!page.url().includes('login')) {
    console.log('✅ 已有登录态，无需登录');
    browser.close();
    return;
  }

  // 枚举 frame 找登录表单
  await sleep(3000);
  let target = null;
  for (const f of page.frames()) {
    if (await f.locator('input[type="password"]').count() > 0) { target = f; break; }
  }
  if (!target) { console.error('❌ 未找到登录表单 iframe'); process.exit(1); }

  // 账号（页面有多个 input，第一个密码框是隐藏的，必须选可见元素）
  const visInputs = target.locator('input:visible');
  let userInput = null;
  for (let i = 0; i < await visInputs.count(); i++) {
    const tp = await visInputs.nth(i).getAttribute('type');
    if (!['password', 'checkbox', 'radio'].includes(tp)) { userInput = visInputs.nth(i); break; }
  }
  await userInput.click();
  await userInput.fill('');
  await userInput.pressSequentially(ACCOUNT, { delay: 60 });
  console.log('✅ 账号已输入');

  const passInput = target.locator('input[type="password"]:visible').first();
  await passInput.click();
  await passInput.fill('');
  await passInput.pressSequentially(PASSWORD, { delay: 60 });
  console.log('✅ 密码已逐字输入');

  await target.locator('button, a').filter({ hasText: /登\s*录/ }).first().click();
  console.log('已点击登录，等待跳转...');
  await sleep(10000);

  const url = page.url();
  console.log('当前URL:', url);
  if (url.includes('login')) {
    console.log('⚠️ 仍在登录页，可能触发二次验证（滑块/短信验证码），请人工处理或检查截图');
    process.exit(2);
  }
  // 登录后可能进入 account-protect 二次验证页
  if (url.includes('account-protect')) {
    console.log('⚠️ 需要二次验证（滑块+短信验证码，发送到认证手机），需用户配合完成');
    process.exit(3);
  }
  console.log('✅ 登录成功');
  browser.close();
})().catch(e => { console.error('❌ 错误:', e.message); process.exit(1); });
