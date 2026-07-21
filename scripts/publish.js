/**
 * wyy-publisher/scripts/publish.js
 * 网易号文章发布主脚本
 * 
 * 用法:
 *   node publish.js "文章标题" "正文内容" [封面模式]
 * 
 * 封面模式: threeImg(默认), custom, bigImg, auto
 */
const path = require('path');
const {
  CDPClient, discoverChromePort, sleep,
  fillTitle, fillBody, getBodyLength,
  clickPublish, setCoverMode, checkAccountStatus
} = require('./lib');

const TITLE = process.argv[2] || '资源有限';
const BODY = process.argv[3] || `在资源有限的条件下，如何做出最优决策，是每个人都会面临的课题。

资源有限，并不意味着无路可走。相反，它往往倒逼我们去思考：什么是真正重要的？什么可以舍弃？什么必须坚持？

经济学的基本假设告诉我们，资源是稀缺的，选择是有代价的。这个道理看似简单，应用起来却需要深刻的自我认知和清晰的优先级判断。

面对有限的时间、金钱、精力，我们真正需要做的，不是贪多求全，而是精准聚焦。把有限资源投入到最核心的目标上，往往比分散用力更能产生突破性结果。

资源的边界，往往也是思维的边界。打破局限的第一步，是承认局限的存在。接受"资源有限"这个事实，才能在此基础上做出最理性的规划和行动。

每一个伟大的成就，都始于对有限资源的创造性运用。越是资源有限，越需要我们深入思考本质，找到那条最高效的路径。

时间不可储存，注意力不可复制，机会稍纵即逝。在有限中寻求无限，是一种智慧，更是一种能力。`;

const COVER_MODE = process.argv[4] || 'threeImg';

async function main() {
  console.log('======================================');
  console.log('   网易号文章发布');
  console.log('======================================\n');
  console.log(`标题: ${TITLE}`);
  console.log(`正文字数: ${BODY.length}`);
  console.log(`封面模式: ${COVER_MODE}\n`);

  // 1. 连接 Chrome CDP
  console.log('[1/6] 连接 Chrome CDP...');
  const info = await discoverChromePort();
  if (!info) {
    console.error('❌ 未找到 Chrome CDP，请先启动带 --remote-debugging-port=9222 的 Chrome');
    process.exit(1);
  }
  const client = new CDPClient(info.wsUrl);
  await client.connect();
  console.log(`   ✅ 已连接 (port=${info.port})\n`);

  // 2. 确认在发布页
  console.log('[2/6] 确认发布页...');
  const url = await client.getUrl();
  if (!url.includes('mp.163.com')) {
    console.error(`❌ 当前不在网易号页面: ${url}`);
    client.close();
    process.exit(1);
  }
  console.log(`   URL: ${url}\n`);

  // 3. 检查账号状态
  console.log('[3/6] 检查账号状态...');
  const status = await checkAccountStatus(client);
  console.log(`   账号状态: ${status}`);
  if (status === 'ACCOUNT_AUDITING') {
    console.error('❌ 账号正在审核中，暂不能发布文章');
    client.close();
    process.exit(1);
  }
  if (status === 'ACCOUNT_REJECTED') {
    console.error('❌ 账号审核未通过');
    client.close();
    process.exit(1);
  }
  console.log('');

  // 4. 填标题
  console.log('[4/6] 填入标题...');
  const titleResult = await fillTitle(client, TITLE);
  console.log(`   ${titleResult}`);

  // 5. 填正文
  console.log('\n[5/6] 填入正文...');
  const bodyResult = await fillBody(client, BODY);
  console.log(`   ${bodyResult}`);

  // 验证正文字数
  await sleep(500);
  const bodyLen = await getBodyLength(client);
  console.log(`   实际字数: ${bodyLen}`);
  if (bodyLen < 50) {
    console.warn('⚠️ 正文注入可能失败，字数异常');
  }
  if (bodyLen < 250) {
    console.warn('⚠️ 正文少于250字，不会被分发到头条');
  }

  // 截图确认
  await client.screenshot(path.join(__dirname, '..', '..', 'wyy_publish_preview.png'));
  console.log('   📸 已截图: wyy_publish_preview.png');

  // 6. 发布
  console.log('\n[6/6] 点击发布...');
  const pubResult = await clickPublish(client);
  console.log(`   ${pubResult}`);

  console.log('\n   等待发布结果（8秒）...');
  await sleep(8000);

  const finalUrl = await client.getUrl();
  const finalBody = await client.getBodyText(400);
  await client.screenshot(path.join(__dirname, '..', '..', 'wyy_publish_result.png'));

  console.log('\n======================================');
  console.log('发布结果');
  console.log('======================================');
  console.log(`URL: ${finalUrl}`);
  console.log(`页面内容片段:\n${finalBody.substring(0, 300)}`);
  console.log('📸 已截图: wyy_publish_result.png');
  console.log('======================================');

  client.close();
}

main().catch(e => {
  console.error('❌ 错误:', e.message);
  process.exit(1);
});
