// 飞书长连接控制：飞书消息 → dsh headless / web 端会话 → 飞书回复
// 命令: /sessions /use | /new 任务 | 纯文本=续聊 | /stop | /status | /reset | /help
// 安全: 默认拒绝。config.feishu.allowedChatIds 之外的会话一律忽略；
//       首次绑定发「/start 配对码」，配对码在网关目录 pairing-code.txt（绑定成功后自动删除）。
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import * as Lark from '@larksuiteoapi/node-sdk';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PAGE = 10;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function diskSessionIds(home) {
  const ids = new Set();
  const root = path.join(home, 'sessions');
  let buckets = [];
  try { buckets = fs.readdirSync(root); } catch { return ids; }
  for (const bucket of buckets) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(root, bucket), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || !e.name.startsWith('session-')) continue;
      const dir = path.join(root, bucket, e.name);
      if (fs.existsSync(path.join(dir, 'session.v4.jsonl.zstd')) || fs.existsSync(path.join(dir, 'session.jsonl.zstd'))) ids.add(e.name);
    }
  }
  return ids;
}

// 网页端任务列表用的就是这份投影：标题、目录、最后一次提问时间。
export function listSessions() {
  const home = dshHome();
  let cache = {};
  let archived = new Set();
  try { cache = JSON.parse(fs.readFileSync(path.join(home, 'storages/session_projcache.json'), 'utf8'))?.tables?.sessions || {}; } catch {}
  try { archived = new Set(JSON.parse(fs.readFileSync(path.join(home, 'storages/workspace.json'), 'utf8'))?.global?.archivedSessionIds || []); } catch {}
  const onDisk = diskSessionIds(home);
  const rows = [];
  for (const [id, rec] of Object.entries(cache)) {
    if (!onDisk.has(id) || archived.has(id)) continue;
    const ident = rec.identity || {};
    const r = rec.rows || {};
    const sub = r.subagent?.val;
    if (sub && typeof sub === 'object' && Object.keys(sub).length) continue;
    const meta = r.sessionListMetadata?.val || {};
    if (meta.blank) continue;
    const title = String(r.title?.val || '').replace(/\s+/g, ' ').trim() || '(无标题)';
    rows.push({ id, cwd: ident.cwd || '', title, at: meta.lastPromptAt || ident.createdAt || 0 });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows;
}

function listFolders(rows) {
  const map = new Map();
  for (const s of rows) {
    const cwd = s.cwd || '';
    let folder = map.get(cwd);
    if (!folder) folder = map.set(cwd, { cwd, name: cwd ? path.basename(cwd) : '未分类', count: 0, at: 0 }).get(cwd);
    folder.count += 1;
    if (s.at > folder.at) folder.at = s.at;
  }
  return [...map.values()].sort((a, b) => b.at - a.at);
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatSessionPage(rows, page, query) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const p = Math.min(Math.max(page, 1), pages);
  const slice = rows.slice((p - 1) * PAGE, p * PAGE);
  const lines = slice.map((s, i) => {
    const n = (p - 1) * PAGE + i + 1;
    const title = s.title.length > 36 ? `${s.title.slice(0, 36)}…` : s.title;
    const where = s.cwd ? path.basename(s.cwd) : '?';
    return `${n}. ${title}\n   ${where} · ${fmtTime(s.at)}`;
  });
  const head = query
    ? `历史会话「${query}」${rows.length} 条，第 ${p}/${pages} 页`
    : `历史会话 ${rows.length} 条，第 ${p}/${pages} 页`;
  return [head, ...lines, '', '接续：/use 编号', pages > 1 ? `翻页：/sessions ${p < pages ? p + 1 : 1}` : '', '筛选：/sessions 关键词'].filter(Boolean).join('\n');
}

function taskSummary(state, workdir) {
  const where = state.cwd ? path.basename(state.cwd) : (workdir ? path.basename(workdir) : '-');
  const title = state.pendingNew
    ? '下一条消息将开新会话'
    : (state.title || (state.sessionId ? state.sessionId.slice(0, 18) : '还没选任务'));
  const head = state.running ? '⏳ 执行中' : (state.pendingNew ? '🆕 待开新会话' : '🟢 空闲');
  return `${head}\n**当前任务** ${title}\n目录 ${where}${state.lastTask ? `\n上次 ${String(state.lastTask).slice(0, 80)}` : ''}`;
}

function cardButton(label, value, type = 'default') {
  const text = String(label || '任务').replace(/\s+/g, ' ').trim().slice(0, 28) || '任务';
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    width: 'fill',
    behaviors: [{ type: 'callback', value }],
  };
}

function buttonRow(items) {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: items.map(([label, value, type]) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [cardButton(label, value, type)],
    })),
  };
}

export function menuCard(state, workdir) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: 'DSH' }, template: state.running ? 'orange' : 'blue' },
    body: {
      elements: [
        { tag: 'markdown', content: taskSummary(state, workdir) },
        buttonRow([
          ['当前任务', { cmd: 'status' }, 'primary'],
          ['对话记录', { cmd: 'history', page: 1 }, 'primary'],
        ]),
        buttonRow([
          ['选择任务', { cmd: 'sessions', page: 1 }, 'default'],
          ['新增会话', { cmd: 'sessions', page: 1, mode: 'new' }, 'primary'],
        ]),
        buttonRow([
          ['停止', { cmd: 'stop' }, 'danger'],
          ['清空会话', { cmd: 'reset' }, 'default'],
        ]),
      ],
    },
  };
}

export function folderCard(rows, page = 1, mode = 'open') {
  const folders = listFolders(rows);
  const pages = Math.max(1, Math.ceil(folders.length / PAGE) || 1);
  const p = Math.min(Math.max(page, 1), pages);
  const slice = folders.slice((p - 1) * PAGE, p * PAGE);
  const creating = mode === 'new';
  const elements = [
    { tag: 'markdown', content: creating
      ? `选一个文件夹。下一条消息会在里面开新会话。第 ${p}/${pages} 页`
      : `先选任务文件夹。第 ${p}/${pages} 页，共 ${folders.length} 个、${rows.length} 条任务` },
    ...slice.map(f => cardButton(
      creating ? `新建 · ${f.name}` : `${f.name} · ${f.count}`,
      creating ? { cmd: 'new', cwd: f.cwd } : { cmd: 'folder', cwd: f.cwd, page: 1 },
      creating ? 'primary' : 'default',
    )),
  ];
  const nav = [];
  if (p > 1) nav.push(['上一页', { cmd: 'sessions', page: p - 1, mode }, 'default']);
  if (p < pages) nav.push(['下一页', { cmd: 'sessions', page: p + 1, mode }, 'default']);
  nav.push(['返回', { cmd: 'menu' }, 'primary']);
  for (let i = 0; i < nav.length; i += 2) elements.push(buttonRow(nav.slice(i, i + 2)));
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: creating ? '新增会话' : '任务文件夹' }, template: creating ? 'green' : 'turquoise' },
    body: { elements },
  };
}

export function sessionCard(rows, page = 1, cwd = '') {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE) || 1);
  const p = Math.min(Math.max(page, 1), pages);
  const slice = rows.slice((p - 1) * PAGE, p * PAGE);
  const name = cwd ? path.basename(cwd) : (rows[0]?.cwd ? path.basename(rows[0].cwd) : '任务');
  const elements = [
    { tag: 'markdown', content: `**${name}** · 点一条就接续，或在此新开。第 ${p}/${pages} 页，共 ${rows.length} 个` },
    cardButton('在此新增会话', { cmd: 'new', cwd }, 'primary'),
    ...slice.map(s => cardButton(s.title, { cmd: 'use', id: s.id })),
  ];
  const nav = [];
  if (p > 1) nav.push(['上一页', { cmd: 'folder', cwd, page: p - 1 }, 'default']);
  if (p < pages) nav.push(['下一页', { cmd: 'folder', cwd, page: p + 1 }, 'default']);
  nav.push(['文件夹', { cmd: 'sessions', page: 1 }, 'primary']);
  for (let i = 0; i < nav.length; i += 2) elements.push(buttonRow(nav.slice(i, i + 2)));
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: name }, template: 'turquoise' },
    body: { elements },
  };
}

function cardActionResponse(toast, card) {
  const body = { toast: { type: toast.type || 'info', content: String(toast.content || '').slice(0, 180) } };
  if (card) body.card = { type: 'raw', data: card };
  return body;
}

function textOf(parts) {
  return (parts || []).filter(p => p && p.type === 'text').map(p => p.text).join('\n').trim();
}

function clip(text, n = 700) {
  const s = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// 一轮 = 你的一句 + 这句之后、下一句之前的最后一条助手正文。中间的工具碎句不展开。
function dialogueRounds(sessionId) {
  const rounds = [];
  let user = null;
  let assistant = '';
  const flush = () => {
    if (!user && !assistant) return;
    rounds.push({ user, assistant });
    user = null;
    assistant = '';
  };
  for (const event of readSessionEvents(sessionId)) {
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const text = textOf(event.data.content);
      if (!text) continue;
      if (user || assistant) flush();
      user = { text, time: event.time };
    } else if (event.type === 'assistant/message') {
      const text = assistantText(event);
      if (text) assistant = text;
    }
  }
  flush();
  return rounds;
}

const HISTORY_PAGE = 3;

export function historyCard(state, rounds, page = 1) {
  const pages = Math.max(1, Math.ceil(rounds.length / HISTORY_PAGE) || 1);
  const p = Math.min(Math.max(page, 1), pages);
  const end = rounds.length - (p - 1) * HISTORY_PAGE;
  const start = Math.max(0, end - HISTORY_PAGE);
  const slice = rounds.slice(start, end);
  const title = state.title || '当前任务';
  const elements = [{
    tag: 'markdown',
    content: rounds.length
      ? `**${title}**\n共 ${rounds.length} 轮，第 ${p}/${pages} 页。第 1 页是最近的。`
      : `**${title}**\n这条任务还没有来回对话。`,
  }];
  for (const round of slice) {
    const bits = [];
    if (round.user) bits.push(`**你** ${fmtTime(round.user.time)}\n${clip(round.user.text)}`);
    if (round.assistant) bits.push(`**DSH**\n${clip(round.assistant)}`);
    if (bits.length) elements.push({ tag: 'markdown', content: bits.join('\n\n') });
  }
  const nav = [];
  if (p < pages) nav.push(['更早', { cmd: 'history', page: p + 1 }, 'default']);
  if (p > 1) nav.push(['更新', { cmd: 'history', page: p - 1 }, 'default']);
  nav.push(['返回', { cmd: 'menu' }, 'primary']);
  for (let i = 0; i < nav.length; i += 2) elements.push(buttonRow(nav.slice(i, i + 2)));
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '对话记录' }, template: 'violet' },
    body: { elements },
  };
}

function sessionLog(sessionId) {
  const root = path.join(dshHome(), 'sessions');
  let buckets = [];
  try { buckets = fs.readdirSync(root); } catch { return ''; }
  for (const bucket of buckets) {
    const dir = path.join(root, bucket, sessionId);
    const v4 = path.join(dir, 'session.v4.jsonl.zstd');
    if (fs.existsSync(v4)) return v4;
    const older = path.join(dir, 'session.jsonl.zstd');
    if (fs.existsSync(older)) return older;
  }
  return '';
}

const ZSTD_BINS = ['/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', 'zstd'];

function readSessionEvents(sessionId) {
  const file = sessionLog(sessionId);
  if (!file) throw new Error('找不到会话日志');
  let last = '读会话日志失败';
  for (const bin of ZSTD_BINS) {
    const raw = spawnSync(bin, ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (raw.error) { last = raw.error.message; continue; }
    if (raw.status !== 0) { last = String(raw.stderr || 'zstd 失败').slice(0, 200); continue; }
    const events = [];
    for (const line of String(raw.stdout || '').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch {}
    }
    return events;
  }
  throw new Error(last);
}

// headless 的一次性运行器不包含任何 agent preset，带预设的历史会话必须交给 dsh web。
function sessionPreset(sessionId) {
  let preset = '';
  for (const event of readSessionEvents(sessionId)) {
    if (event.type === 'session' && event.agentPreset) preset = event.agentPreset;
    if (event.type === 'agent-preset/selected' && event.data?.agentPreset) preset = event.data.agentPreset;
  }
  return preset;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function upstreamCookie(authority) {
  const text = fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8');
  const lines = text.split('\n');
  const i = lines.findIndex(l => l.trim().startsWith('client-connection/browser-session:'));
  let secret = '';
  for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
    const m = lines[j]?.match(/^\s+secret:\s*([A-Za-z0-9_-]+)\s*$/);
    if (m) { secret = m[1]; break; }
  }
  if (!secret) throw new Error('没有读到 dsh web 的浏览器密钥');
  const name = 'dsh-auth-' + b64url(crypto.createHash('sha256').update(authority).digest());
  const payload = { version: 1, authority, issuedAt: Date.now(), expiresAt: Date.now() + 30 * 864e5 };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(body).digest());
  return `${name}=v1.${body}.${sig}`;
}

async function dshRpc(CFG, method, args) {
  const upstream = new URL(CFG.upstream || 'http://127.0.0.1:3080');
  const rpcId = crypto.randomUUID();
  const res = await fetch(new URL(`/api/${method}`, upstream), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: upstreamCookie(upstream.host) },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`DSH web HTTP ${res.status}`);
  return json.result;
}

function assistantText(event) {
  const parts = event?.data?.message?.content || [];
  return parts.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
}

function textsOrError(answer, reason) {
  const err = reason.error?.message || reason.kind || '失败';
  return answer && answer !== '(完成，无文本输出)' ? `${answer}\n\n❌ ${err}` : `❌ ${err}`;
}

export async function startFeishu(CFG, log) {
  const f = CFG.feishu || {};
  if (!f.appId || !f.appSecret) {
    log('[feishu] config.json 里没填 appId/appSecret，飞书控制未启动（其余功能不受影响）');
    return;
  }

  const stateFile = path.join(__dirname, 'feishu-state.json');
  const state = { sessionId: '', lastTask: '', running: false };
  try { Object.assign(state, JSON.parse(fs.readFileSync(stateFile, 'utf8'))); } catch {}
  const save = () => { try { fs.writeFileSync(stateFile, JSON.stringify({ ...state, running: state.running }, null, 1)); } catch {} };

  const CONFIG_FILE = path.join(__dirname, 'config.json');
  const PAIRING_FILE = path.join(__dirname, 'pairing-code.txt');

  // 未绑定会话的配对码：首次生成到 pairing-code.txt（0600），绑定成功后删除
  function ensurePairingCode() {
    try {
      const saved = fs.readFileSync(PAIRING_FILE, 'utf8').trim().toLowerCase();
      if (/^[0-9a-f]{6,32}$/.test(saved)) return saved;
    } catch {}
    const code = crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(PAIRING_FILE, code + '\n', { mode: 0o600 });
    log('[feishu] 生成配对码 →', PAIRING_FILE);
    return code;
  }

  // 把新 chat_id 写进 config.json 的 feishu.allowedChatIds（持久化，重启后仍生效）
  function bindChat(chatId) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cfg.feishu = cfg.feishu || {};
      if (!Array.isArray(cfg.feishu.allowedChatIds)) cfg.feishu.allowedChatIds = [];
      if (!cfg.feishu.allowedChatIds.includes(chatId)) cfg.feishu.allowedChatIds.push(chatId);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 1));
      fs.chmodSync(CONFIG_FILE, 0o600);
      try { fs.unlinkSync(PAIRING_FILE); } catch {}
    } catch (e) { log('[feishu] 写入绑定配置失败:', e.message); }
  }

  let child = null;
  const client = new Lark.Client({ appId: f.appId, appSecret: f.appSecret }, { loggerLevel: 'info' });

  const seen = new Set(); // 飞书可能重推事件
  const chunk = (t, n = 3800) => (t.length <= n ? [t] : t.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) || [t]);

  async function reply(messageId, text) {
    if (!messageId) {
      log('[feishu] 回复失败: 事件里没有 message_id');
      return;
    }
    for (const part of chunk(String(text || '(空)'))) {
      try {
        await client.im.v1.message.reply({
          path: { message_id: messageId },
          data: { content: JSON.stringify({ text: part }), msg_type: 'text' },
        });
      } catch (e) { log('[feishu] 回复失败:', e?.response?.data?.msg || e?.message); }
    }
  }

  async function replyCard(messageId, card) {
    if (!messageId) return;
    try {
      await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card), msg_type: 'interactive' },
      });
    } catch (e) { log('[feishu] 卡片发送失败:', e?.response?.data?.msg || e?.message); }
  }

  function bindSession(hit) {
    if (!hit) return '没有这个会话';
    if (hit.cwd && !fs.existsSync(hit.cwd)) return `目录不存在，不能接续：${hit.cwd}`;
    state.sessionId = hit.id;
    state.cwd = hit.cwd || '';
    state.title = hit.title || '';
    state.pendingNew = false;
    save();
    return '';
  }

  function runTask(text, { fresh = false } = {}) {
    if (fresh) state.preset = '';
    if (!fresh && state.sessionId) {
      try {
        const preset = sessionPreset(state.sessionId);
        state.preset = preset;
        save();
        if (preset) return runViaWeb(text);
      } catch (e) {
        log('[feishu] 读会话预设失败:', e.message);
        return `❌ 读不了这个会话的日志，没有改走 headless。\n${e.message}`;
      }
    }
    return runHeadless(text, { fresh });
  }

  async function runViaWeb(text) {
    const sessionId = state.sessionId;
    log('[feishu] 交给网页端:', state.preset, sessionId, text.slice(0, 60));
    let baseline = 0;
    try {
      baseline = readSessionEvents(sessionId).reduce((m, e) => Math.max(m, e.seq || 0), 0);
    } catch (e) {
      return `❌ ${e.message}`;
    }
    state.running = true; state.viaWeb = true; state.lastTask = text.slice(0, 200); save();
    let admitted;
    try {
      admitted = await dshRpc(CFG, 'session/prompt', {
        request: {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: 'Asia/Shanghai',
        },
      });
    } catch (e) {
      state.running = false; state.viaWeb = false; save();
      return `❌ 网页端没接上: ${e.message}`;
    }
    if (!admitted?.ok) {
      state.running = false; state.viaWeb = false; save();
      return `❌ ${admitted?.error?.message || '网页端拒绝了这条消息'}`;
    }
    const deadline = Date.now() + (CFG.maxTaskMinutes || 20) * 60000;
    while (Date.now() < deadline) {
      if (!state.running) { state.viaWeb = false; save(); return '🛑 已停止'; }
      await new Promise(r => setTimeout(r, 2000));
      let events = [];
      try { events = readSessionEvents(sessionId); } catch { continue; }
      const ended = [...events].reverse().find(e => e.type === 'turn/end' && (e.seq || 0) > baseline);
      if (!ended) continue;
      const reason = ended.data?.reason || {};
      const answer = events.filter(e => e.type === 'assistant/message' && (e.seq || 0) > baseline).map(assistantText).filter(Boolean).at(-1) || '(完成，无文本输出)';
      state.running = false; state.viaWeb = false; save();
      if (reason.kind === 'completed' || reason.kind === 'max-tokens') return answer;
      if (reason.kind === 'aborted') return `🛑 已停止\n${answer}`;
      return textsOrError(answer, reason);
    }
    state.running = false; state.viaWeb = false; save();
    return `❌ 超过 ${CFG.maxTaskMinutes || 20} 分钟还没结束。网页端可能仍在跑，或在等审批。`;
  }

  function runHeadless(text, { fresh = false } = {}) {
    return new Promise(resolve => {
      const args = ['--profile', 'headless', '--patch', CFG.headlessPatch || path.join(__dirname, 'headless-patch.yml'), '--json'];
      if (fresh) state.title = '';
      if (!fresh && state.sessionId) args.push('--session-id', state.sessionId);
      args.push(text);
      log('[feishu] 启动任务:', fresh ? '(新会话)' : `(${state.sessionId})`, text.slice(0, 60));

      let sessionId = state.sessionId, finalText = '', errTail = '';
      child = spawn(CFG.dshBin || 'dsh', args, {
        cwd: state.cwd || CFG.workdir || process.cwd(),
        env: { ...process.env, PATH: `${process.env.PATH}:${os.homedir()}/.npm-global/bin:${os.homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin` },
      });
      state.running = true; state.lastTask = text.slice(0, 200); save();

      const timer = setTimeout(() => {
        log('[feishu] 任务超时，强杀');
        try { child.kill('SIGKILL'); } catch {}
      }, (CFG.maxTaskMinutes || 20) * 60000);

      let buf = '';
      child.stdout.on('data', d => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const e = JSON.parse(line);
            if (e.type === 'session' && e.sessionId) { sessionId = e.sessionId; state.sessionId = e.sessionId; save(); }
            if (e.type === 'final') finalText = e.text || '';
          } catch {}
        }
      });
      child.stderr.on('data', d => { errTail = (errTail + d).slice(-400); });
      child.on('error', e => { clearTimeout(timer); state.running = false; child = null; save(); resolve(`❌ 无法启动 dsh: ${e.message}`); });
      child.on('close', code => {
        clearTimeout(timer); state.running = false; child = null; save();
        if (finalText) return resolve(finalText);
        if (code === 0) return resolve('(完成，无文本输出)');
        resolve(`❌ 任务失败 (exit ${code})\n${errTail.split('\n').slice(-3).join('\n')}`);
      });
    });
  }

  const ed = new Lark.EventDispatcher({});
  ed.register({
    'im.message.receive_v1': async data => {
      try {
        log('[feishu] 事件进入:', JSON.stringify(data).slice(0, 300));
        const msg = data?.message;
        if (!msg || msg.message_type !== 'text') return;
        if (seen.has(msg.message_id)) return;
        seen.add(msg.message_id); if (seen.size > 200) seen.clear();

        const text = (() => { try { return JSON.parse(msg.content || '{}').text?.trim() || ''; } catch { return ''; } })();
        if (!text) return;
        const allowed = Array.isArray(f.allowedChatIds) ? f.allowedChatIds : [];
        if (!allowed.includes(msg.chat_id)) {
          // 默认拒绝：白名单外只接受「/start 配对码」完成绑定，其余一律静默忽略
          const m = text.match(/^\/start\s+([0-9a-fA-F]{6,32})\s*$/);
          if (m && m[1].toLowerCase() === ensurePairingCode()) {
            bindChat(msg.chat_id);
            f.allowedChatIds = [...allowed, msg.chat_id];
            log('[feishu] 新会话已绑定', msg.chat_id);
            return reply(msg.message_id, '✅ 已绑定到这台网关，直接发任务或 /help 看命令');
          }
          log('[feishu] 拒绝未绑定会话', msg.chat_id, '（配对: 发 /start 配对码，码在网关目录 pairing-code.txt）');
          return;
        }
        log('[feishu] 收到消息:', msg.message_id, text.slice(0, 80));
        state.chatId = msg.chat_id || state.chatId;

        if (text === '/help' || text === '/menu' || text === '菜单') {
          return replyCard(msg.message_id, menuCard(state, CFG.workdir));
        }
        if (text === '/sessions' || text.startsWith('/sessions ') || text === '选择任务' || text === '新增会话' || text === '/new') {
          const creating = text === '新增会话' || text === '/new';
          const arg = text.startsWith('/sessions') ? text.slice('/sessions'.length).trim() : '';
          const all = listSessions();
          let rows = all;
          let page = 1;
          if (/^\d+$/.test(arg)) page = Number(arg);
          else if (arg) {
            const q = arg.toLowerCase();
            rows = all.filter(s => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
          }
          if (!rows.length) return reply(msg.message_id, arg ? `没有匹配「${arg}」的会话` : '没有可接续的历史会话');
          state.listed = rows;
          save();
          return replyCard(msg.message_id, folderCard(rows, page, creating ? 'new' : 'open'));
        }
        if (text === '/status' || text === '当前任务') {
          return replyCard(msg.message_id, menuCard(state, CFG.workdir));
        }
        if (text === '/history' || text === '对话记录') {
          if (!state.sessionId) return reply(msg.message_id, '还没选任务。先点选择任务。');
          try {
            return replyCard(msg.message_id, historyCard(state, dialogueRounds(state.sessionId), 1));
          } catch (e) {
            return reply(msg.message_id, `读对话失败：${e.message}`);
          }
        }
        if (text === '/stop') {
          if (!state.running) return reply(msg.message_id, '当前没有在跑的任务');
          state.running = false;
          if (state.viaWeb && state.sessionId) {
            dshRpc(CFG, 'session/cancel', { request: { sessionId: state.sessionId } }).catch(e => log('[feishu] 停止网页端失败:', e.message));
          }
          try { child?.kill('SIGKILL'); } catch {}
          return reply(msg.message_id, '🛑 已发送强停');
        }
        if (text === '/reset') {
          state.sessionId = ''; state.cwd = ''; state.title = ''; state.preset = ''; state.pendingNew = false; save();
          return reply(msg.message_id, '🔄 会话已清空，下条消息将开新会话');
        }
        if (text.startsWith('/use ')) {
          if (state.running) return reply(msg.message_id, '⏳ 已有任务在跑，先点停止再切换会话');
          const arg = text.slice(5).trim();
          const listed = Array.isArray(state.listed) ? state.listed : [];
          let hit;
          if (/^\d+$/.test(arg)) hit = listed[Number(arg) - 1];
          else {
            const hits = listSessions().filter(s => s.id === arg || (arg.length >= 12 && s.id.startsWith(arg)));
            if (hits.length > 1) return reply(msg.message_id, `匹配到 ${hits.length} 条，请用选择任务里的按钮`);
            hit = hits[0];
          }
          const err = bindSession(hit);
          if (err) return reply(msg.message_id, err);
          return replyCard(msg.message_id, menuCard(state, CFG.workdir));
        }
        if (state.running) return reply(msg.message_id, '⏳ 已有任务在跑：/status 查看，/stop 强停');

        const pending = !!state.pendingNew;
        const fresh = text.startsWith('/new ') || pending;
        const task = text.startsWith('/new ') ? text.slice(5).trim() : text;
        if (!task) return reply(msg.message_id, '先点新增会话并选文件夹，再发任务内容');
        if (pending) state.pendingNew = false;

        await reply(msg.message_id, fresh ? `🚀 新任务已启动（完成后回结果）:\n${task.slice(0, 500)}` : `▶️ 已提交（会话 ${state.sessionId || '新开'}），完成后回结果`);
        const result = await runTask(task, { fresh });
        await reply(msg.message_id, result);
      } catch (e) {
        log('[feishu] 处理异常:', e?.message || e);
      }
    },
    'card.action.trigger': async data => {
      try {
        log('[feishu] 卡片:', JSON.stringify(data).slice(0, 400));
        const action = data?.action || data?.event?.action || {};
        let value = action.value || {};
        if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = {}; } }
        const cmd = value.cmd;
        if (cmd === 'menu' || cmd === 'status') {
          return cardActionResponse({ type: 'info', content: cmd === 'status' ? '已刷新当前任务' : '菜单' }, menuCard(state, CFG.workdir));
        }
        if (cmd === 'history') {
          if (!state.sessionId) return cardActionResponse({ type: 'error', content: '还没选任务' }, menuCard(state, CFG.workdir));
          try {
            const rounds = dialogueRounds(state.sessionId);
            const page = Number(value.page) || 1;
            return cardActionResponse({ type: 'info', content: rounds.length ? `共 ${rounds.length} 轮` : '还没有对话' }, historyCard(state, rounds, page));
          } catch (e) {
            return cardActionResponse({ type: 'error', content: String(e.message || e).slice(0, 80) });
          }
        }
        if (cmd === 'sessions') {
          const rows = listSessions();
          state.listed = rows;
          const mode = value.mode === 'new' ? 'new' : 'open';
          if (mode === 'open') state.pendingNew = false;
          save();
          if (!rows.length) return cardActionResponse({ type: 'error', content: '没有可接续的历史会话' }, menuCard(state, CFG.workdir));
          const folders = listFolders(rows);
          return cardActionResponse({ type: 'info', content: mode === 'new' ? '选文件夹以开新会话' : `${folders.length} 个文件夹` }, folderCard(rows, Number(value.page) || 1, mode));
        }
        if (cmd === 'new') {
          if (state.running) return cardActionResponse({ type: 'warning', content: '有任务在跑，先点停止' });
          const cwd = value.cwd || CFG.workdir || '';
          if (cwd && !fs.existsSync(cwd)) return cardActionResponse({ type: 'error', content: '目录不存在' });
          state.sessionId = '';
          state.preset = '';
          state.title = '';
          state.cwd = cwd;
          state.pendingNew = true;
          save();
          const name = cwd ? path.basename(cwd) : '默认目录';
          return cardActionResponse({ type: 'success', content: `下一条消息将在 ${name} 开新会话` }, menuCard(state, CFG.workdir));
        }
        if (cmd === 'folder') {
          const cwd = value.cwd || '';
          const rows = listSessions().filter(s => (s.cwd || '') === cwd);
          state.listed = rows;
          save();
          if (!rows.length) return cardActionResponse({ type: 'error', content: '这个文件夹里没有任务' }, folderCard(listSessions(), 1));
          const name = cwd ? path.basename(cwd) : '未分类';
          return cardActionResponse({ type: 'info', content: `${name} · ${rows.length} 条` }, sessionCard(rows, Number(value.page) || 1, cwd));
        }
        if (cmd === 'use') {
          if (state.running) return cardActionResponse({ type: 'warning', content: '有任务在跑，先点停止' });
          const hit = listSessions().find(s => s.id === value.id);
          const err = bindSession(hit);
          if (err) return cardActionResponse({ type: 'error', content: err.slice(0, 80) });
          return cardActionResponse({ type: 'success', content: `已接续 ${String(hit.title).slice(0, 24)}` }, menuCard(state, CFG.workdir));
        }
        if (cmd === 'stop') {
          if (!state.running) return cardActionResponse({ type: 'info', content: '当前没有在跑的任务' }, menuCard(state, CFG.workdir));
          state.running = false;
          if (state.viaWeb && state.sessionId) {
            dshRpc(CFG, 'session/cancel', { request: { sessionId: state.sessionId } }).catch(e => log('[feishu] 停止网页端失败:', e.message));
          }
          try { child?.kill('SIGKILL'); } catch {}
          return cardActionResponse({ type: 'success', content: '已发送强停' }, menuCard(state, CFG.workdir));
        }
        if (cmd === 'reset') {
          state.sessionId = ''; state.cwd = ''; state.title = ''; state.preset = ''; state.pendingNew = false; save();
          return cardActionResponse({ type: 'success', content: '会话已清空' }, menuCard(state, CFG.workdir));
        }
        return cardActionResponse({ type: 'error', content: '不认识这个按钮' });
      } catch (e) {
        log('[feishu] 卡片处理异常:', e?.message || e);
        return cardActionResponse({ type: 'error', content: String(e?.message || e).slice(0, 80) });
      }
    },
  });

  const ws = new Lark.WSClient({ appId: f.appId, appSecret: f.appSecret }, { loggerLevel: 'info' });
  await ws.start({ eventDispatcher: ed });
  log('[feishu] 长连接已启动（无需公网回调地址）');
  const chatId = state.chatId;
  save();
  if (!chatId) {
    log('尚未绑定会话：在飞书给机器人发「/start 配对码」完成绑定（码在 pairing-code.txt）');
    return;
  }
  try {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(menuCard(state, CFG.workdir)) },
    });
    log('[feishu] 已发出按钮菜单');
  } catch (e) { log('[feishu] 菜单发送失败:', e?.response?.data?.msg || e?.message); }
}
