#!/usr/bin/env node
// 初始化 config.json：node setup.js <访问密码>
// 已存在 config.json 时拒绝覆盖（改密码请用 change-password.js）
import crypto from 'node:crypto';
import fs from 'node:fs';

const pw = process.argv[2];
if (!pw || pw.length < 6) { console.error('用法: node setup.js <至少6位访问密码>'); process.exit(1); }
if (fs.existsSync('config.json')) { console.error('❌ config.json 已存在，不覆盖。改密码用: node change-password.js <新密码>'); process.exit(1); }

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
const cfg = {
  port: 8765,
  upstream: 'http://127.0.0.1:3080',
  cookieName: 'dshauth',
  sessionDays: 30,
  passwordScrypt: salt.toString('hex') + ':' + hash.toString('hex'),
  sessionSecret: crypto.randomBytes(32).toString('hex'),
  dshBin: 'dsh',
  workdir: process.cwd(),
  headlessPatch: 'headless-patch.yml',
  maxTaskMinutes: 20,
  feishu: { appId: '', appSecret: '', allowedChatIds: [] },
};
fs.writeFileSync('config.json', JSON.stringify(cfg, null, 1));
fs.chmodSync('config.json', 0o600);
console.log('✅ config.json 已生成（0600）。接下来:');
console.log('   1. 编辑 config.json: workdir 改成你的工作目录');
console.log('   2. 飞书开放平台建应用，把 appId/appSecret 填进 feishu 字段');
console.log('   3. 想自定义 headless 模型: cp headless-patch.example.yml headless-patch.yml');
console.log('   4. 启动: node server.js');
