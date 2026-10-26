#!/usr/bin/env node
// 修改网关访问密码: node change-password.js <新密码>
import crypto from 'node:crypto';
import fs from 'node:fs';
const pw = process.argv[2];
if (!pw || pw.length < 6) { console.error('用法: node change-password.js <至少6位新密码>'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
cfg.passwordScrypt = salt.toString('hex') + ':' + hash.toString('hex');
fs.writeFileSync('config.json', JSON.stringify(cfg, null, 1));
fs.chmodSync('config.json', 0o600);
console.log('✅ 密码已更新。重启网关后生效: launchctl kickstart -k gui/501/local.dsh.remote.gateway');
