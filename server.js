// dsh-remote-gateway — 手机/公网访问 DSH 的带密码网关 + 飞书控制
// 链路: 手机 → ali:17888 (frps) → frp隧道 → 本机 frpc → 127.0.0.1:8765 → 127.0.0.1:3080 (DSH web)
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { startFeishu } from './feishu.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const UP = new URL(CFG.upstream || 'http://127.0.0.1:3080');
const PORT = CFG.port || 8765;
const COOKIE = CFG.cookieName || 'dshauth';

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- 密码校验 (scrypt) ---------- */
function verifyPassword(pw) {
  try {
    const [saltHex, hashHex] = String(CFG.passwordScrypt).split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const ref = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(String(pw), salt, ref.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(got, ref);
  } catch { return false; }
}

/* ---------- 登录凭证 (HMAC 签名 cookie, 30天) ---------- */
const SECRET = Buffer.from(CFG.sessionSecret, 'hex');
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken() {
  const body = 'u1.' + (Date.now() + (CFG.sessionDays || 30) * 864e5);
  return body + '.' + sign(body);
}
function checkToken(t) {
  if (!t) return false;
  const i = t.lastIndexOf('.');
  if (i < 0) return false;
  const body = t.slice(0, i), sig = t.slice(i + 1);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(body)))) return false;
  } catch { return false; }
  return Date.now() < Number(body.split('.')[1]);
}
const parseCookies = h => Object.fromEntries(String(h || '').split(';').map(s => {
  const i = s.indexOf('='); return i < 0 ? ['', ''] : [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}).filter(([k]) => k));

/* ---------- 登录限速: 每 IP 每分钟 8 次 ---------- */
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); attempts.set(ip, list);
  if (attempts.size > 1000) attempts.clear();
  return list.length > 8;
}

/* ---------- 登录页 ---------- */
const LOGIN_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>DSH 远程入口</title><style>
*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
background:radial-gradient(1200px 600px at 20% -10%,#1b2a6b 0%,transparent 60%),
radial-gradient(900px 500px at 110% 110%,#3b0f5e 0%,transparent 55%),#05060f;
font-family:-apple-system,'PingFang SC',sans-serif;color:#e8ecff;padding:24px}
.card{width:100%;max-width:380px;padding:34px 28px;border-radius:22px;
background:rgba(255,255,255,.055);border:1px solid rgba(140,120,255,.25);
box-shadow:0 0 45px rgba(108,80,255,.28),inset 0 1px 0 rgba(255,255,255,.09);
backdrop-filter:blur(18px)}
h1{font-size:20px;letter-spacing:.5px;text-align:center;
background:linear-gradient(90deg,#7dd3fc,#c084fc,#f0abfc);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{text-align:center;font-size:12px;color:#8b93c7;margin:10px 0 26px}
input{width:100%;padding:14px 16px;border-radius:14px;border:1px solid rgba(140,120,255,.35);
background:rgba(10,12,30,.6);color:#fff;font-size:16px;outline:none}
input:focus{border-color:#a78bfa;box-shadow:0 0 18px rgba(167,139,250,.35)}
button{width:100%;margin-top:16px;padding:14px;border:none;border-radius:14px;font-size:16px;font-weight:600;color:#fff;
background:linear-gradient(135deg,#6d5cff,#b249ff);box-shadow:0 6px 22px rgba(124,77,255,.45);cursor:pointer}
button:active{transform:scale(.98)}
.err{margin-top:14px;text-align:center;color:#ff8080;font-size:13px;display:${'block'}}
</style></head><body><form class="card" method="POST" action="/login">
<h1>⚡ DSH 远程入口</h1><div class="sub">DeepSeek Harness · 安全网关</div>
<input name="pw" type="password" inputmode="text" autocomplete="current-password" placeholder="访问密码" autofocus>
<button>进入</button>${''}
</form></body></html>`;

/* ---------- 上游自签 cookie（DSH web 浏览器认证） ----------
 * dsh web 的 cookie = dsh-auth-<b64url(sha256(authority))> = v1.<b64url(payload)>.<b64url(hmacsha256(secret,payload))>
 * secret 持久存在 ~/.dsh/.credentials.yaml 的 client-connection/browser-session，
 * authority = 上游看到的 Host 头（我们固定为 127.0.0.1:3080），所以网关可以自己签。 */
function loadUpstreamSecret() {
  try {
    const text = fs.readFileSync(CFG.dshCredentials || path.join(process.env.HOME || '', '.dsh', '.credentials.yaml'), 'utf8');
    const lines = text.split('\n');
    const i = lines.findIndex(l => l.trim().startsWith('client-connection/browser-session:'));
    if (i >= 0) {
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const m = lines[j].match(/^\s+secret:\s*([A-Za-z0-9_-]+)\s*$/);
        if (m) return m[1];
      }
    }
  } catch {}
  return null;
}
const UP_AUTHORITY = UP.host; // "127.0.0.1:3080"
const UP_COOKIE_NAME = 'dsh-auth-' + crypto.createHash('sha256').update(UP_AUTHORITY).digest().toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function mintUpstreamCookie() {
  if (!upSecret) return '';
  const payload = { version: 1, authority: UP_AUTHORITY, issuedAt: Date.now(), expiresAt: Date.now() + 30 * 864e5 };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const key = Buffer.from(upSecret, 'base64'); // HMAC key = 解码后的 32 字节原始 secret
  const sig = crypto.createHmac('sha256', key).update(body).digest().toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `${UP_COOKIE_NAME}=v1.${body}.${sig}`;
}
const upSecret = loadUpstreamSecret();
if (!upSecret) log('⚠️ 未读到上游 dsh web 的 browser-session secret，代理会被上游 401 拦截');

/* ---------- 反代 DSH ---------- */
function cleanHeaders(req, opts = {}) {
  const h = { ...req.headers };
  delete h.cookie; delete h['x-forwarded-for'];
  h.host = UP.host;                       // 让上游认为是本机访问
  if (h.origin) h.origin = `http://${UP.host}`;
  if (h.referer) h.referer = `http://${UP.host}/`;
  // HTML 文档请求不要压缩：我们要注入 viewport，避免动压缩字节（资源文件照常压缩）
  if (opts.stripAcceptEncoding || (req.method === 'GET' && /text\/html/i.test(String(req.headers.accept || '')))) {
    delete h['accept-encoding'];
  }
  const upCookie = mintUpstreamCookie();
  if (upCookie) h.cookie = upCookie;
  h['x-forwarded-for'] = req.socket.remoteAddress || '';
  return h;
}
function proxy(req, res) {
  const preq = http.request({
    host: UP.hostname, port: UP.port, path: req.url, method: req.method,
    headers: cleanHeaders(req),
  }, pres => {
    if (pres.statusCode === 401) log('⚠️ 上游返回401：browser-session secret 可能已轮换，重启网关试试 (launchctl kickstart -k gui/501/local.dsh.remote.gateway)');
    const h = { ...pres.headers };
    const ct = String(h['content-type'] || '');
    if (pres.statusCode === 200 && ct.includes('text/html')) {
      const chunks = [];
      pres.on('data', c => chunks.push(c));
      pres.on('end', () => {
        let body = Buffer.concat(chunks);
        // 万一上游仍返回了压缩的 HTML：解压→注入→按原编码压回去
        const enc = String(h['content-encoding'] || '').toLowerCase();
        if (enc && enc !== 'identity') {
          try {
            let raw = enc === 'br' ? zlib.brotliDecompressSync(body)
              : enc === 'gzip' ? zlib.gunzipSync(body)
              : zlib.inflateSync(body);
            raw = injectViewport(raw);
            body = enc === 'br' ? zlib.brotliCompressSync(raw)
              : enc === 'gzip' ? zlib.gzipSync(raw)
              : zlib.deflateSync(raw);
          } catch (e) {
            log('HTML解压失败，原样透传:', e.message);
            res.writeHead(pres.statusCode, h);
            res.end(Buffer.concat(chunks));
            return;
          }
        } else {
          body = injectViewport(body);
        }
        h['content-length'] = body.length;
        res.writeHead(pres.statusCode, h);
        res.end(body);
      });
    } else {
      res.writeHead(pres.statusCode, h);
      pres.pipe(res);
    }
  });
  preq.on('error', e => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('上游 DSH 不在线: ' + e.message);
  });
  req.pipe(preq);
}
function injectViewport(htmlBuf) {
  let html = htmlBuf.toString('utf8');
  if (!/<meta[^>]+viewport/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i,
      '<head$1><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
  }
  return Buffer.from(html, 'utf8');
}

/* ---------- 读取 body ---------- */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const cs = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else cs.push(c); });
    req.on('end', () => resolve(Buffer.concat(cs)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const ip = req.socket.remoteAddress || 'x';
    const ck = parseCookies(req.headers.cookie)[COOKIE];

    if (u.pathname === '/__health') { res.writeHead(200); res.end('ok'); return; }

    if (u.pathname === '/login') {
      if (req.method === 'POST') {
        if (tooMany(ip)) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); res.end('尝试太频繁，稍后再试'); return; }
        const body = (await readBody(req)).toString();
        const pw = new URLSearchParams(body).get('pw') || '';
        if (verifyPassword(pw)) {
          res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${makeToken()}; Max-Age=${(CFG.sessionDays || 30) * 86400}; Path=/; HttpOnly; SameSite=Lax`, Location: '/' });
          res.end(); log('登录成功 from', ip);
        } else {
          log('密码错误 from', ip);
          res.writeHead(302, { Location: '/login?e=1' }); res.end();
        }
        return;
      }
      if (checkToken(ck)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(LOGIN_HTML); return;
    }

    if (u.pathname === '/logout') {
      res.writeHead(302, { 'Set-Cookie': `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`, Location: '/login' });
      res.end(); return;
    }

    if (!checkToken(ck)) {
      const wantsHtml = String(req.headers.accept || '').includes('text/html');
      if (wantsHtml && req.method === 'GET') { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('401 未登录（浏览器打开会自动跳登录页）'); return;
    }

    proxy(req, res);
  } catch (e) {
    log('请求处理异常:', e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('gateway error: ' + e.message);
  }
});

/* ---------- WebSocket 透传（登录后才能连） ---------- */
server.on('upgrade', (req, socket, head) => {
  const ck = parseCookies(req.headers.cookie)[COOKIE];
  if (!checkToken(ck)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy(); return;
  }
  const t = net.connect(UP.port, UP.hostname, () => {
    const lines = [`GET ${req.url} HTTP/1.1`];
    const h = cleanHeaders(req);
    for (const [k, v] of Object.entries(h)) {
      if (k === 'upgrade' || k === 'connection') continue; // 手写，避免被 node 归一化
      lines.push(`${k}: ${v}`);
    }
    // 原样保留握手必需头
    lines.push(`Upgrade: ${req.headers.upgrade}`, `Connection: Upgrade`);
    t.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) t.write(head);
    socket.pipe(t); t.pipe(socket);
  });
  t.on('error', () => socket.destroy());
  socket.on('error', () => t.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  log(`网关已启动 http://127.0.0.1:${PORT} → ${UP.origin}`);
  startFeishu(CFG, log).catch(e => log('[feishu] 启动失败:', e?.message || e));
});
