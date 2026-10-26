// 把这一台机器自己的飞书应用写进 config.json，并检查机器人是否真能用。
// 不会创建飞书应用。应用必须由已登录 open.feishu.cn 的人在浏览器里建。
// 每台机器用自己的 App ID / App Secret，不要抄别的机器。
//
//   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx node setup-feishu-bot.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Lark from '@larksuiteoapi/node-sdk';

const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = new URL('./config.json', import.meta.url);
const appId = (process.env.FEISHU_APP_ID || '').trim();
const appSecret = (process.env.FEISHU_APP_SECRET || '').trim();

const need = ['im:message', 'im:message:send_as_bot'];

function die(code, text) {
  console.error(text);
  process.exit(code);
}

if (!appId || !appSecret) {
  die(2, [
    '缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET。脚本不会创建飞书应用。',
    '先让已登录 https://open.feishu.cn 的人新建一个只给这台机器用的企业自建应用，再把凭证传进来：',
    '  FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx node setup-feishu-bot.js',
    '不要复用别的机器的 App ID。',
  ].join('\n'));
}
if (!/^cli_[a-zA-Z0-9]+$/.test(appId)) die(2, 'FEISHU_APP_ID 必须以 cli_ 开头');

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
cfg.feishu = {
  ...(cfg.feishu || {}),
  appId,
  appSecret,
  allowedChatIds: Array.isArray(cfg.feishu?.allowedChatIds) ? cfg.feishu.allowedChatIds : [],
};
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 1) + '\n');
console.log('已写入', path.join(root, 'config.json'), '的 feishu.appId（Secret 不打印）');

const client = new Lark.Client({ appId, appSecret }, { loggerLevel: Lark.LoggerLevel.error });

let bot;
try {
  const res = await client.request({ method: 'GET', url: 'https://open.feishu.cn/open-apis/bot/v3/info' });
  bot = res?.data?.bot || res?.bot || res?.data;
} catch (e) {
  die(1, `凭证无效或网络失败：${e?.response?.data?.msg || e.message}`);
}

const scopes = [];
let pageToken;
for (let i = 0; i < 20; i++) {
  const res = await client.application.scope.list({
    params: { page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) },
  });
  const body = res?.data?.data || res?.data || {};
  scopes.push(...(body.scopes || []));
  if (!body.has_more) break;
  pageToken = body.page_token;
}
const granted = new Set(scopes.filter(s => s.grant_status === 1 && s.scope_type === 'tenant').map(s => s.scope_name));
const missing = need.filter(name => !granted.has(name));

console.log('机器人', bot?.app_name || '(无名)', 'activate_status=', bot?.activate_status);
console.log('已授权', [...granted].join(', ') || '(无)');

if (bot?.activate_status !== 2 || missing.length) {
  die(3, [
    bot?.activate_status !== 2 ? '机器人未启用。在开放平台给这个应用添加「机器人」能力，并发布版本。' : '',
    missing.length ? `已发布版本里还没有这些权限：${missing.join(', ')}` : '',
    `开通并发布： https://open.feishu.cn/app/${appId}/auth`,
    '事件订阅脚本查不到。还要在「事件与回调」里确认：',
    '  订阅方式 = 使用长连接接收事件（保存时本机网关必须已经连上）',
    '  事件 im.message.receive_v1',
    '  回调 card.action.trigger',
    '改完必须再发一版，等管理员通过后重新运行本脚本，退出码变成 0 再重启网关。',
  ].filter(Boolean).join('\n'));
}

console.log('凭证和权限可用。下一步：重启网关，让用户在飞书里发「菜单」。');
console.log('事件订阅是否生效，要看重启后的 gateway.log 有没有「长连接已启动」，以及用户能不能看到按钮。');
