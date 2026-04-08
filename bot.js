const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ── Config (env vars for Railway, fallback for local) ────────────────────────
const API_ID = parseInt(process.env.TG_API_ID) || 34160147;
const API_HASH = process.env.TG_API_HASH || '553ab59375c5aaac39983a2c141bd50d';
const PHONE = process.env.TG_PHONE || '+5511911002474';
const SAVED_SESSION = process.env.TG_SESSION || '';
const SESSION_FILE = path.join(__dirname, 'session.txt');
const GROUPS_FILE = path.join(__dirname, 'groups.json');
const PORT = parseInt(process.env.PORT) || 3333;

// ── State ────────────────────────────────────────────────────────────────────
let client = null;
let isConnected = false;
let pendingCode = null;
let pendingPassword = null;
let logs = [];

// Progress tracking for SSE
let progress = { active: false, task: '', current: 0, total: 0, percent: 0, detail: '' };
let sseClients = [];

const KEYWORDS = [
  'afiliados hotmart', 'afiliados kiwify', 'marketing digital',
  'vendas online', 'renda extra', 'empreendedorismo digital',
  'afiliados brasil', 'infoprodutos', 'copywriting', 'trafego pago',
  'negocio digital', 'dinheiro online', 'leads', 'prospeccao', 'vendas b2b',
];

let MESSAGE = `\u{1F525} OPORTUNIDADE - Comissao Recorrente de 35% \u{1F525}

\u{1F4B0} Ganhe dinheiro TODO MES indicando o ZapPro - plataforma que gera leads empresariais e envia mensagens pelo WhatsApp automaticamente.

\u2705 Por que vende MUITO:
\u{1F4CC} Todo vendedor precisa de leads
\u{1F4CC} Resolve uma dor real (prospeccao manual)
\u{1F4CC} 7 dias gratis = conversao facil
\u{1F4CC} Cliente que usa NAO cancela

\u{1F4B8} Quanto voce ganha:
\u{1F4B5} Ticket: R$119 a R$647/mes
\u{1F4B5} Comissao: 35% RECORRENTE
\u{1F4B5} 1 venda Ouro = ~R$125/mes pra voce
\u{1F4B5} 10 vendas = R$1.250/mes PASSIVO
\u{1F4B5} 50 vendas = R$6.250/mes

\u{1F680} Se afilie AGORA (gratis):

\u{1F449} Hotmart: https://affiliate.hotmart.com/affiliate-recruiting/view/0501Z105236308
\u{1F449} Kiwify: https://dashboard.kiwify.com/join/affiliate/wTtmx6Av

\u{1F3AF} Pagina de vendas: https://web-production-40b7d0.up.railway.app/vendas

\u{2753} Duvidas? Me chama no privado!`;

// ── Helpers ──────────────────────────────────────────────────────────────────
function escapeHTML(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function loadGroups() {
  if (fs.existsSync(GROUPS_FILE)) return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
  return [];
}

function saveGroups(groups) {
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2), 'utf8');
}

function loadSession() {
  if (SAVED_SESSION) return SAVED_SESSION;
  if (fs.existsSync(SESSION_FILE)) return fs.readFileSync(SESSION_FILE, 'utf8').trim();
  return '';
}

function saveSession(s) {
  fs.writeFileSync(SESSION_FILE, s, 'utf8');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function updateProgress(task, current, total, detail) {
  progress = { active: true, task, current, total, percent: total > 0 ? Math.round((current / total) * 100) : 0, detail: detail || '' };
  broadcastSSE({ type: 'progress', ...progress });
}

function clearProgress() {
  progress = { active: false, task: '', current: 0, total: 0, percent: 0, detail: '' };
  broadcastSSE({ type: 'progress', ...progress });
}

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

function logFn(msg) {
  const ts = new Date().toLocaleTimeString('pt-BR');
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  broadcastSSE({ type: 'log', entry });
}

function broadcastGroups() {
  const groups = loadGroups();
  const stats = getStats(groups);
  broadcastSSE({ type: 'groups', stats, groups });
}

function getStats(groups) {
  return {
    total: groups.length,
    joined: groups.filter(g => g.joined).length,
    posted: groups.filter(g => g.posted && !g.postError).length,
    forbidden: groups.filter(g => g.postError === 'FORBIDDEN').length,
    pendingJoin: groups.filter(g => !g.joined && g.username).length,
    pendingPost: groups.filter(g => g.joined && !g.posted).length,
    communities: groups.filter(g => g.isCommunity).length,
  };
}

// ── Telegram Client ──────────────────────────────────────────────────────────
async function connectClient(phone) {
  const sessionStr = loadSession();
  const session = new StringSession(sessionStr);
  client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5 });

  await client.start({
    phoneNumber: () => phone || PHONE,
    phoneCode: () => new Promise(resolve => { pendingCode = resolve; }),
    password: () => new Promise(resolve => { pendingPassword = resolve; }),
    onError: (err) => logFn('Erro: ' + err.message),
  });

  const newSession = client.session.save();
  saveSession(newSession);
  isConnected = true;
  logFn('Conectado ao Telegram!');
  broadcastSSE({ type: 'connected', value: true });
}

// Auto-reconnect using saved session (no code needed)
async function autoConnect() {
  const sessionStr = loadSession();
  if (!sessionStr) { logFn('Sem sessao salva. Conecte manualmente.'); return; }

  logFn('Auto-conectando com sessao salva...');
  try {
    const session = new StringSession(sessionStr);
    client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5 });
    await client.connect();
    const me = await client.getMe();
    isConnected = true;
    logFn(`Auto-conectado como ${me.firstName || ''} ${me.lastName || ''} (${me.phone || PHONE})`);
    broadcastSSE({ type: 'connected', value: true });
  } catch (e) {
    logFn('Falha no auto-connect: ' + e.message);
    logFn('Conecte manualmente pela interface.');
  }
}

// ── Search Groups (with batch size param) ────────────────────────────────────
async function searchGroups(batchSize) {
  if (!isConnected) { logFn('Nao conectado!'); return 0; }
  const groups = loadGroups();
  const existingIds = new Set(groups.map(g => String(g.id)));
  let count = 0;
  const total = KEYWORDS.length;

  logFn(`Iniciando busca... (${total} keywords, batch de ${batchSize} por keyword)`);

  for (let i = 0; i < total; i++) {
    const kw = KEYWORDS[i];
    updateProgress('Buscando grupos', i + 1, total, `"${kw}"`);
    logFn(`Buscando [${i+1}/${total}]: "${kw}" (limit ${batchSize})`);
    try {
      const result = await client.invoke(new Api.contacts.Search({ q: kw, limit: batchSize }));
      for (const chat of result.chats) {
        const isMegagroup = chat.className === 'Channel' && chat.megagroup;
        const isCommunity = chat.className === 'Channel' && !chat.megagroup && !chat.broadcast;
        const isBroadcast = chat.className === 'Channel' && chat.broadcast;

        if (isBroadcast) continue;

        if ((isMegagroup || isCommunity) && !existingIds.has(String(chat.id))) {
          groups.push({
            id: String(chat.id),
            title: chat.title,
            username: chat.username || null,
            participants: chat.participantsCount || 0,
            keyword: kw,
            joined: false,
            posted: false,
            isCommunity: !!isCommunity,
            foundAt: new Date().toISOString(),
          });
          existingIds.add(String(chat.id));
          count++;
          logFn(`  + ${chat.title} (${chat.participantsCount || '?'} membros)${isCommunity ? ' [COMUNIDADE]' : ''}`);
        }
      }
      await sleep(rand(8000, 15000));
    } catch (e) {
      logFn(`  Erro: ${e.message}`);
      if (e.message.includes('FLOOD')) { logFn('FLOOD! Parando busca.'); break; }
      await sleep(5000);
    }
  }
  saveGroups(groups);
  clearProgress();
  broadcastGroups();
  logFn(`Busca finalizada. ${count} novos grupos. Total: ${groups.length}`);
  return count;
}

// ── Join Groups ──────────────────────────────────────────────────────────────
async function joinGroups(limit) {
  if (!isConnected) { logFn('Nao conectado!'); return 0; }
  const groups = loadGroups();
  const pending = groups.filter(g => !g.joined && g.username);
  const batch = pending.slice(0, limit);
  let count = 0;

  logFn(`Entrando em grupos... (${pending.length} pendentes, limite ${limit})`);

  for (let i = 0; i < batch.length; i++) {
    const g = batch[i];
    updateProgress('Entrando em grupos', i + 1, batch.length, g.title);
    logFn(`Entrando: ${g.title} (@${g.username})`);
    try {
      await client.invoke(new Api.channels.JoinChannel({ channel: g.username }));
      g.joined = true;
      g.joinedAt = new Date().toISOString();
      count++;
      logFn('  OK');
      saveGroups(groups);
      broadcastGroups();
      const delay = rand(30000, 60000);
      logFn(`  Aguardando ${Math.round(delay/1000)}s...`);
      await sleep(delay);
    } catch (e) {
      logFn(`  Erro: ${e.message}`);
      if (e.message.includes('FLOOD')) { logFn('FLOOD! Parando.'); break; }
      if (e.message.includes('CHANNELS_TOO_MUCH')) { logFn('Limite de canais!'); break; }
      await sleep(10000);
    }
  }
  saveGroups(groups);
  clearProgress();
  broadcastGroups();
  logFn(`Entrou em ${count} grupos.`);
  return count;
}

// ── Check Write Permission ───────────────────────────────────────────────────
async function checkWritePermission(entity) {
  try {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
    const chat = full.chats.find(c => c.defaultBannedRights);
    if (chat && chat.defaultBannedRights && chat.defaultBannedRights.sendMessages) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

// ── Leave Group ──────────────────────────────────────────────────────────────
async function leaveGroup(g) {
  try {
    const entity = await client.getEntity(g.username || Number(g.id));
    await client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
    g.left = true;
    g.leftAt = new Date().toISOString();
    logFn(`  Saiu de: ${g.title}`);
  } catch (e) {
    logFn(`  Erro ao sair: ${e.message}`);
  }
}

// ── Post to Groups (anti-duplicate + permission check) ───────────────────────
async function postGroups(limit) {
  if (!isConnected) { logFn('Nao conectado!'); return 0; }
  const groups = loadGroups();
  const ready = groups.filter(g => g.joined && !g.posted);
  const batch = ready.slice(0, limit);
  let count = 0;

  logFn(`Postando em grupos... (${ready.length} prontos, limite ${limit})`);

  for (let i = 0; i < batch.length; i++) {
    const g = batch[i];
    updateProgress('Postando em grupos', i + 1, batch.length, g.title);
    logFn(`Postando em: ${g.title}`);
    try {
      const entity = await client.getEntity(g.username || Number(g.id));

      const canWrite = await checkWritePermission(entity);
      if (!canWrite) {
        logFn(`  Sem permissao de escrita. Saindo do grupo...`);
        g.posted = true;
        g.postError = 'FORBIDDEN';
        await leaveGroup(g);
        saveGroups(groups);
        broadcastGroups();
        continue;
      }

      await client.sendMessage(entity, { message: MESSAGE });
      g.posted = true;
      g.postedAt = new Date().toISOString();
      count++;
      logFn('  OK');
      saveGroups(groups);
      broadcastGroups();
      const delay = rand(60000, 120000);
      logFn(`  Aguardando ${Math.round(delay/1000)}s...`);
      await sleep(delay);
    } catch (e) {
      logFn(`  Erro: ${e.message}`);
      if (e.message.includes('FLOOD')) { logFn('FLOOD! Parando.'); break; }
      if (e.message.includes('FORBIDDEN') || e.message.includes('CHAT_WRITE') || e.message.includes('CHAT_SEND')) {
        logFn('  Sem permissao. Saindo do grupo...');
        g.posted = true;
        g.postError = 'FORBIDDEN';
        await leaveGroup(g);
      }
      await sleep(10000);
    }
  }
  saveGroups(groups);
  clearProgress();
  broadcastGroups();
  logFn(`Postou em ${count} grupos.`);
  return count;
}

// ── Cleanup forbidden groups (auto-sair) ─────────────────────────────────────
async function cleanupForbidden() {
  if (!isConnected) { logFn('Nao conectado!'); return 0; }
  const groups = loadGroups();
  const forbidden = groups.filter(g => g.postError === 'FORBIDDEN' && g.joined && !g.left);
  let count = 0;

  logFn(`Limpando ${forbidden.length} grupos sem permissao...`);
  for (let i = 0; i < forbidden.length; i++) {
    const g = forbidden[i];
    updateProgress('Saindo de grupos sem permissao', i + 1, forbidden.length, g.title);
    await leaveGroup(g);
    count++;
    await sleep(rand(3000, 6000));
  }
  saveGroups(groups);
  clearProgress();
  broadcastGroups();
  logFn(`Saiu de ${count} grupos.`);
  return count;
}

// ── Repost (anti-duplicate: only repost if last post > N days) ───────────────
async function repostGroups(limit, minDays) {
  if (!isConnected) { logFn('Nao conectado!'); return 0; }
  const groups = loadGroups();
  const now = Date.now();
  const minMs = minDays * 24 * 60 * 60 * 1000;
  const eligible = groups.filter(g => {
    if (!g.joined || g.postError || g.left) return false;
    if (!g.postedAt) return false;
    return (now - new Date(g.postedAt).getTime()) > minMs;
  });
  const batch = eligible.slice(0, limit);
  let count = 0;

  logFn(`Repostando... (${eligible.length} elegiveis com >${minDays} dias, limite ${limit})`);

  for (let i = 0; i < batch.length; i++) {
    const g = batch[i];
    updateProgress('Repostando em grupos', i + 1, batch.length, g.title);
    logFn(`Repostando em: ${g.title} (ultimo post: ${g.postedAt})`);
    try {
      const entity = await client.getEntity(g.username || Number(g.id));
      await client.sendMessage(entity, { message: MESSAGE });
      g.postedAt = new Date().toISOString();
      count++;
      logFn('  OK');
      saveGroups(groups);
      broadcastGroups();
      const delay = rand(60000, 120000);
      logFn(`  Aguardando ${Math.round(delay/1000)}s...`);
      await sleep(delay);
    } catch (e) {
      logFn(`  Erro: ${e.message}`);
      if (e.message.includes('FLOOD')) { logFn('FLOOD! Parando.'); break; }
      if (e.message.includes('FORBIDDEN') || e.message.includes('CHAT_WRITE') || e.message.includes('CHAT_SEND')) {
        g.postError = 'FORBIDDEN';
        await leaveGroup(g);
      }
      await sleep(10000);
    }
  }
  saveGroups(groups);
  clearProgress();
  broadcastGroups();
  logFn(`Repostou em ${count} grupos.`);
  return count;
}

// ── Express Server ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// SSE endpoint for real-time updates
app.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('\n');
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

app.get('/', (req, res) => {
  const groups = loadGroups();
  const stats = getStats(groups);
  res.send(buildHTML(stats, groups));
});

app.post('/connect', async (req, res) => {
  const phone = req.body.phone || '+5511911002474';
  logFn('Iniciando conexao com ' + phone);
  connectClient(phone);
  res.json({ ok: true, msg: 'Aguardando codigo do Telegram...' });
});

app.post('/code', (req, res) => {
  if (pendingCode) { pendingCode(req.body.code); pendingCode = null; }
  res.json({ ok: true });
});

app.post('/password', (req, res) => {
  if (pendingPassword) { pendingPassword(req.body.password); pendingPassword = null; }
  res.json({ ok: true });
});

app.post('/search', async (req, res) => {
  const batchSize = parseInt(req.body.batchSize) || 20;
  res.json({ ok: true, msg: 'Busca iniciada...' });
  const n = await searchGroups(batchSize);
  broadcastSSE({ type: 'searchDone', found: n });
});

app.post('/join', async (req, res) => {
  const limit = parseInt(req.body.limit) || 5;
  res.json({ ok: true, msg: 'Entrando nos grupos...' });
  const n = await joinGroups(limit);
  broadcastSSE({ type: 'joinDone', joined: n });
});

app.post('/post', async (req, res) => {
  const limit = parseInt(req.body.limit) || 5;
  res.json({ ok: true, msg: 'Postando nos grupos...' });
  const n = await postGroups(limit);
  broadcastSSE({ type: 'postDone', posted: n });
});

app.post('/repost', async (req, res) => {
  const limit = parseInt(req.body.limit) || 5;
  const minDays = parseInt(req.body.minDays) || 7;
  res.json({ ok: true, msg: 'Repostando...' });
  const n = await repostGroups(limit, minDays);
  broadcastSSE({ type: 'repostDone', reposted: n });
});

app.post('/cleanup', async (req, res) => {
  res.json({ ok: true, msg: 'Limpando grupos sem permissao...' });
  const n = await cleanupForbidden();
  broadcastSSE({ type: 'cleanupDone', left: n });
});

app.post('/message', (req, res) => {
  MESSAGE = req.body.message || MESSAGE;
  logFn('Mensagem atualizada.');
  res.json({ ok: true });
});

app.get('/status', (req, res) => {
  const groups = loadGroups();
  res.json({
    connected: isConnected,
    waitingCode: !!pendingCode,
    waitingPassword: !!pendingPassword,
    groups: getStats(groups),
    progress,
    logs: logs.slice(-50),
  });
});

app.get('/groups', (req, res) => res.json(loadGroups()));

// Manual actions on individual groups
app.post('/group/:id/leave', async (req, res) => {
  if (!isConnected) return res.json({ ok: false, msg: 'Nao conectado' });
  const groups = loadGroups();
  const g = groups.find(x => x.id === req.params.id);
  if (!g) return res.json({ ok: false, msg: 'Grupo nao encontrado' });
  await leaveGroup(g);
  saveGroups(groups);
  broadcastGroups();
  res.json({ ok: true });
});

app.post('/group/:id/post', async (req, res) => {
  if (!isConnected) return res.json({ ok: false, msg: 'Nao conectado' });
  const groups = loadGroups();
  const g = groups.find(x => x.id === req.params.id);
  if (!g) return res.json({ ok: false, msg: 'Grupo nao encontrado' });
  try {
    const entity = await client.getEntity(g.username || Number(g.id));
    await client.sendMessage(entity, { message: MESSAGE });
    g.posted = true;
    g.postedAt = new Date().toISOString();
    g.postError = undefined;
    saveGroups(groups);
    broadcastGroups();
    logFn(`Postou manualmente em: ${g.title}`);
    res.json({ ok: true });
  } catch (e) {
    logFn(`Erro ao postar em ${g.title}: ${e.message}`);
    res.json({ ok: false, msg: e.message });
  }
});

app.post('/group/:id/join', async (req, res) => {
  if (!isConnected) return res.json({ ok: false, msg: 'Nao conectado' });
  const groups = loadGroups();
  const g = groups.find(x => x.id === req.params.id);
  if (!g || !g.username) return res.json({ ok: false, msg: 'Grupo nao encontrado ou sem username' });
  try {
    await client.invoke(new Api.channels.JoinChannel({ channel: g.username }));
    g.joined = true;
    g.joinedAt = new Date().toISOString();
    saveGroups(groups);
    broadcastGroups();
    logFn(`Entrou manualmente em: ${g.title}`);
    res.json({ ok: true });
  } catch (e) {
    logFn(`Erro ao entrar em ${g.title}: ${e.message}`);
    res.json({ ok: false, msg: e.message });
  }
});

// Batch actions on multiple groups
app.post('/batch', async (req, res) => {
  const { ids, action } = req.body;
  if (!ids || !Array.isArray(ids) || !action) return res.json({ ok: false, msg: 'ids[] e action obrigatorios' });
  if (!isConnected && action !== 'delete') return res.json({ ok: false, msg: 'Nao conectado' });

  res.json({ ok: true, msg: `Executando ${action} em ${ids.length} grupos...` });

  let groups = loadGroups();
  const targets = groups.filter(g => ids.includes(g.id));
  let count = 0;

  for (let i = 0; i < targets.length; i++) {
    const g = targets[i];
    updateProgress(`Batch ${action}`, i + 1, targets.length, g.title);

    if (action === 'join') {
      if (g.joined || !g.username) continue;
      try {
        await client.invoke(new Api.channels.JoinChannel({ channel: g.username }));
        g.joined = true;
        g.joinedAt = new Date().toISOString();
        count++;
        logFn(`  Entrou: ${g.title}`);
        saveGroups(groups);
        broadcastGroups();
        await sleep(rand(30000, 60000));
      } catch (e) {
        logFn(`  Erro ${g.title}: ${e.message}`);
        if (e.message.includes('FLOOD')) break;
        if (e.message.includes('CHANNELS_TOO_MUCH')) break;
        await sleep(10000);
      }
    } else if (action === 'post') {
      if (!g.joined || g.left) continue;
      try {
        const entity = await client.getEntity(g.username || Number(g.id));
        await client.sendMessage(entity, { message: MESSAGE });
        g.posted = true;
        g.postedAt = new Date().toISOString();
        g.postError = undefined;
        count++;
        logFn(`  Postou: ${g.title}`);
        saveGroups(groups);
        broadcastGroups();
        await sleep(rand(60000, 120000));
      } catch (e) {
        logFn(`  Erro ${g.title}: ${e.message}`);
        if (e.message.includes('FLOOD')) break;
        if (e.message.includes('FORBIDDEN') || e.message.includes('CHAT_WRITE') || e.message.includes('CHAT_SEND')) {
          g.posted = true;
          g.postError = 'FORBIDDEN';
          await leaveGroup(g);
        }
        await sleep(10000);
      }
    } else if (action === 'leave') {
      if (!g.joined || g.left) continue;
      await leaveGroup(g);
      count++;
      await sleep(rand(3000, 6000));
    } else if (action === 'delete') {
      groups = groups.filter(x => x.id !== g.id);
      count++;
    }
  }

  saveGroups(groups);
  clearProgress();
  broadcastGroups();
  logFn(`Batch ${action} finalizado: ${count} de ${targets.length}`);
  broadcastSSE({ type: 'batchDone', action, count });
});

app.delete('/group/:id', (req, res) => {
  let groups = loadGroups();
  groups = groups.filter(g => g.id !== req.params.id);
  saveGroups(groups);
  broadcastGroups();
  res.json({ ok: true });
});

// ── HTML ─────────────────────────────────────────────────────────────────────
function buildHTML(stats, groups) {
  const escapedMsg = escapeHTML(MESSAGE);

  // Build groups HTML server-side with proper escaping
  const groupsDataAttr = Buffer.from(JSON.stringify(groups)).toString('base64');

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ZapPro - Bot Telegram</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#0a0f1a;color:#f9fafb;padding:16px}
h1{font-size:22px;font-weight:800;margin-bottom:4px}h1 em{color:#22c55e;font-style:normal}
.subtitle{color:#6b7280;font-size:13px;margin-bottom:16px}

/* Layout split */
.layout{display:grid;grid-template-columns:1fr 380px;gap:16px;max-width:1400px;margin:0 auto}
@media(max-width:900px){.layout{grid-template-columns:1fr}}
.col-left{min-width:0}
.col-right{display:flex;flex-direction:column;gap:12px}

.card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:16px;margin-bottom:12px}
.card h2{font-size:15px;font-weight:700;margin-bottom:10px;color:#22c55e}

.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}
@media(max-width:600px){.stats{grid-template-columns:repeat(2,1fr)}}
.stat{background:#1f2937;border-radius:10px;padding:12px;text-align:center}
.stat-val{font-size:24px;font-weight:800;color:#22c55e}
.stat-lbl{font-size:11px;color:#6b7280;margin-top:2px}

.btn{padding:8px 16px;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s;margin:3px}
.btn-green{background:#22c55e;color:#000}.btn-green:hover{background:#16a34a}
.btn-blue{background:#3b82f6;color:#fff}.btn-blue:hover{background:#2563eb}
.btn-orange{background:#f59e0b;color:#000}.btn-orange:hover{background:#d97706}
.btn-red{background:#ef4444;color:#fff}.btn-red:hover{background:#dc2626}
.btn-gray{background:#374151;color:#f9fafb}.btn-gray:hover{background:#4b5563}
.btn-sm{padding:4px 10px;font-size:11px;margin:2px}
.btn:disabled{opacity:.5;cursor:not-allowed}

input,textarea,select{padding:8px 10px;border:1px solid #374151;border-radius:8px;background:#1f2937;color:#f9fafb;font-family:inherit;font-size:13px;margin-bottom:6px}
input,select{width:100%}
textarea{width:100%;min-height:100px;resize:vertical}

.log-box{background:#0a0f1a;border:1px solid #1f2937;border-radius:8px;padding:10px;max-height:300px;overflow-y:auto;font-family:monospace;font-size:11px;color:#9ca3af;line-height:1.5}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
.status-dot.on{background:#22c55e}.status-dot.off{background:#ef4444}

/* Progress bar */
.progress-wrap{display:none;margin:8px auto 0;max-width:1400px}
.progress-wrap.active{display:block}
.progress-bar-outer{background:#1f2937;border-radius:8px;height:28px;overflow:hidden;position:relative}
.progress-bar-inner{background:linear-gradient(90deg,#22c55e,#3b82f6);height:100%;transition:width .3s;border-radius:8px}
.progress-text{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:12px;font-weight:700;color:#fff;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.progress-detail{font-size:11px;color:#9ca3af;margin-top:4px}

/* Groups list */
.groups-list{max-height:calc(100vh - 200px);overflow-y:auto;padding-right:4px}
.group-item{background:#1f2937;border:1px solid #374151;border-radius:8px;padding:10px 12px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;gap:8px;transition:border-color .15s}
.group-item:hover{border-color:#4b5563}
.group-info{flex:1;min-width:0}
.group-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.group-meta{font-size:11px;color:#6b7280;margin-top:2px}
.group-badges{display:flex;gap:4px;margin-top:3px;flex-wrap:wrap}
.badge{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600}
.badge-joined{background:#22c55e22;color:#22c55e}
.badge-posted{background:#3b82f622;color:#3b82f6}
.badge-forbidden{background:#ef444422;color:#ef4444}
.badge-community{background:#a855f722;color:#a855f7}
.badge-left{background:#6b728022;color:#6b7280}
.badge-pending{background:#f59e0b22;color:#f59e0b}
.group-actions{display:flex;gap:2px;flex-shrink:0}

.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.inline-input{display:flex;gap:6px;align-items:center;margin-bottom:8px}
.inline-input label{font-size:12px;color:#9ca3af;white-space:nowrap}
.inline-input input{width:80px;margin-bottom:0}

/* Filters */
.filters{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.filter-btn{padding:4px 12px;border:1px solid #374151;border-radius:6px;background:transparent;color:#9ca3af;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s}
.filter-btn.active{background:#22c55e;color:#000;border-color:#22c55e}
.filter-btn:hover{border-color:#22c55e}

.conn-row{display:flex;gap:8px;align-items:end}
.conn-row input{flex:1;margin-bottom:0}

/* Selection toolbar */
.select-bar{display:none;align-items:center;gap:8px;padding:8px 12px;background:#1e3a5f;border:1px solid #3b82f6;border-radius:8px;margin-bottom:10px}
.select-bar.active{display:flex}
.select-bar .count{font-size:13px;font-weight:700;color:#93c5fd;margin-right:auto}
.cb-wrap{display:flex;align-items:center;justify-content:center;width:20px;flex-shrink:0}
.cb-wrap input[type=checkbox]{width:16px;height:16px;accent-color:#22c55e;cursor:pointer;margin:0}
</style></head><body>

<div style="max-width:1400px;margin:0 auto">
<h1><em>ZapPro</em> - Bot Telegram</h1>
<p class="subtitle">Automacao de busca de grupos e recrutamento de afiliados</p>

<div class="stats">
  <div class="stat"><div class="stat-val" id="s-total">${stats.total}</div><div class="stat-lbl">Encontrados</div></div>
  <div class="stat"><div class="stat-val" id="s-joined">${stats.joined}</div><div class="stat-lbl">Entrou</div></div>
  <div class="stat"><div class="stat-val" id="s-posted">${stats.posted}</div><div class="stat-lbl">Postou</div></div>
  <div class="stat"><div class="stat-val" id="s-forbidden">${stats.forbidden}</div><div class="stat-lbl">Sem permissao</div></div>
</div>

<!-- Progress bar -->
<div class="progress-wrap" id="progress-wrap">
  <div class="progress-bar-outer">
    <div class="progress-bar-inner" id="progress-bar" style="width:0%"></div>
    <div class="progress-text" id="progress-text">0%</div>
  </div>
  <div class="progress-detail" id="progress-detail"></div>
</div>
</div>

<div class="layout">
<!-- LEFT: Groups list -->
<div class="col-left">
  <div class="card" style="margin-bottom:0">
    <h2>Grupos (<span id="groups-count">${stats.total}</span>)</h2>
    <div class="filters" id="filters">
      <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">Todos</button>
      <button class="filter-btn" data-filter="pending" onclick="setFilter('pending')">Pendentes</button>
      <button class="filter-btn" data-filter="joined" onclick="setFilter('joined')">Entrou</button>
      <button class="filter-btn" data-filter="posted" onclick="setFilter('posted')">Postou</button>
      <button class="filter-btn" data-filter="forbidden" onclick="setFilter('forbidden')">Sem permissao</button>
      <button class="filter-btn" data-filter="community" onclick="setFilter('community')">Comunidades</button>
    </div>
    <!-- Select all + batch actions bar -->
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <div class="cb-wrap"><input type="checkbox" id="select-all" onchange="toggleSelectAll(this.checked)"/></div>
      <label for="select-all" style="font-size:12px;color:#9ca3af;cursor:pointer;user-select:none">Selecionar todos</label>
    </div>
    <div class="select-bar" id="select-bar">
      <span class="count" id="select-count">0 selecionados</span>
      <button class="btn btn-orange btn-sm" onclick="batchAction('join')">Entrar</button>
      <button class="btn btn-green btn-sm" onclick="batchAction('post')">Postar</button>
      <button class="btn btn-red btn-sm" onclick="batchAction('leave')">Sair</button>
      <button class="btn btn-gray btn-sm" onclick="batchAction('delete')">Remover</button>
      <button class="btn btn-sm" style="background:transparent;color:#9ca3af" onclick="clearSelection()">Limpar</button>
    </div>
    <div class="groups-list" id="groups-list"></div>
  </div>
</div>

<!-- RIGHT: Controls -->
<div class="col-right">
  <!-- Connect -->
  <div class="card">
    <h2>Conexao</h2>
    <div class="conn-row">
      <input id="phone" value="+5511911002474" placeholder="+55..."/>
      <button class="btn btn-green" onclick="doConnect()">Conectar</button>
    </div>
    <div id="code-area" style="display:none;margin-top:8px">
      <div class="conn-row"><input id="code" placeholder="Codigo do Telegram"/><button class="btn btn-blue" onclick="sendCode()">OK</button></div>
    </div>
    <div id="pw-area" style="display:none;margin-top:8px">
      <div class="conn-row"><input id="password" type="password" placeholder="Senha 2FA"/><button class="btn btn-blue" onclick="sendPw()">OK</button></div>
    </div>
    <p id="conn-status" style="margin-top:6px;font-size:12px"><span class="status-dot off"></span>Desconectado</p>
  </div>

  <!-- Search -->
  <div class="card">
    <h2>Buscar Grupos</h2>
    <div class="inline-input">
      <label>Resultados por keyword:</label>
      <input id="batch-size" type="number" value="20" min="5" max="100"/>
    </div>
    <button class="btn btn-blue" onclick="doSearch()" id="btn-search">Buscar grupos</button>
  </div>

  <!-- Join -->
  <div class="card">
    <h2>Entrar nos Grupos</h2>
    <div class="inline-input">
      <label>Quantidade:</label>
      <input id="join-limit" type="number" value="5" min="1" max="50"/>
    </div>
    <button class="btn btn-orange" onclick="doJoin()" id="btn-join">Entrar</button>
  </div>

  <!-- Post -->
  <div class="card">
    <h2>Postar Mensagem</h2>
    <div class="inline-input">
      <label>Quantidade:</label>
      <input id="post-limit" type="number" value="5" min="1" max="50"/>
    </div>
    <div class="actions" style="margin-top:0">
      <button class="btn btn-green" onclick="doPost()" id="btn-post">Postar</button>
      <button class="btn btn-gray" onclick="doRepost()" id="btn-repost">Repostar (&gt;7d)</button>
      <button class="btn btn-red btn-sm" onclick="doCleanup()">Sair dos FORBIDDEN</button>
    </div>
  </div>

  <!-- Autopilot -->
  <div class="card" id="autopilot-card">
    <h2>Autopilot</h2>
    <div style="font-size:12px;color:#9ca3af;margin-bottom:10px">Entra em grupos e posta automaticamente ao longo do dia</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">
      <div><label style="font-size:11px;color:#6b7280">Grupos/dia</label><input id="ap-target" type="number" value="15" min="1" max="50" class="input" style="width:100%"/></div>
      <div><label style="font-size:11px;color:#6b7280">Inicio</label><input id="ap-start" type="number" value="10" min="0" max="23" class="input" style="width:100%"/></div>
      <div><label style="font-size:11px;color:#6b7280">Fim</label><input id="ap-end" type="number" value="23" min="1" max="24" class="input" style="width:100%"/></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <button class="btn btn-green" id="ap-start-btn" onclick="startAutopilot()">Ativar Autopilot</button>
      <button class="btn btn-red" id="ap-stop-btn" onclick="stopAutopilot()" style="display:none">Parar</button>
      <span id="ap-status" style="font-size:12px;color:#6b7280"></span>
    </div>
    <div id="ap-info" style="margin-top:8px;font-size:12px;display:none;padding:8px;background:#1f2937;border-radius:8px">
      <span style="color:#22c55e;font-weight:700">● ATIVO</span> —
      Entrou: <strong id="ap-joined">0</strong> |
      Postou: <strong id="ap-posted">0</strong> |
      Meta: <strong id="ap-daily">15</strong>/dia
    </div>
  </div>

  <!-- Log -->
  <div class="card">
    <h2>Log</h2>
    <div class="log-box" id="logbox">Aguardando...</div>
  </div>
</div>
</div>

<!-- Message (full width below layout) -->
<div style="max-width:1400px;margin:16px auto 0">
  <div class="card">
    <h2>Mensagem de Divulgacao</h2>
    <textarea id="msg" style="min-height:320px;font-size:14px;line-height:1.6">${escapedMsg}</textarea>
    <button class="btn btn-gray" onclick="saveMsg()">Salvar mensagem</button>
  </div>
</div>

<script>
var $=function(id){return document.getElementById(id)};
var allGroups = JSON.parse(atob('${groupsDataAttr}'));
var currentFilter = 'all';
var selectedIds = new Set();

// ── SSE ──
var evtSource = new EventSource('/events');
evtSource.onmessage = function(e) {
  try {
    var d = JSON.parse(e.data);
    if (d.type === 'progress') handleProgress(d);
    if (d.type === 'log') appendLog(d.entry);
    if (d.type === 'groups') { allGroups = d.groups; updateStats(d.stats); renderGroups(); }
    if (d.type === 'connected') { $('conn-status').textContent = 'Conectado'; }
    if (d.type === 'searchDone' || d.type === 'joinDone' || d.type === 'postDone' || d.type === 'repostDone' || d.type === 'cleanupDone' || d.type === 'batchDone') {
      enableButtons();
    }
  } catch(err) {}
};

function handleProgress(d) {
  var wrap = $('progress-wrap');
  if (!d.active) { wrap.classList.remove('active'); return; }
  wrap.classList.add('active');
  $('progress-bar').style.width = d.percent + '%';
  $('progress-text').textContent = d.task + ' ' + d.percent + '% (' + d.current + '/' + d.total + ')';
  $('progress-detail').textContent = d.detail;
}

function appendLog(entry) {
  var box = $('logbox');
  if (box.textContent === 'Aguardando...') box.textContent = '';
  box.textContent += entry + '\\n';
  box.scrollTop = box.scrollHeight;
}

function updateStats(s) {
  $('s-total').textContent = s.total;
  $('s-joined').textContent = s.joined;
  $('s-posted').textContent = s.posted;
  $('s-forbidden').textContent = s.forbidden;
  $('groups-count').textContent = s.total;
}

// ── API calls ──
function api(u, b) {
  return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(function(r){return r.json()});
}

function disableButtons() {
  var btns = document.querySelectorAll('.btn-green,.btn-blue,.btn-orange');
  for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
}
function enableButtons() {
  var btns = document.querySelectorAll('.btn');
  for (var i = 0; i < btns.length; i++) btns[i].disabled = false;
}

function doConnect() { api('/connect', { phone: $('phone').value }); $('code-area').style.display = 'block'; }
function sendCode() { api('/code', { code: $('code').value }); $('code-area').style.display = 'none'; }
function sendPw() { api('/password', { password: $('password').value }); $('pw-area').style.display = 'none'; }

function doSearch() { disableButtons(); api('/search', { batchSize: parseInt($('batch-size').value) || 20 }); }
function doJoin() { disableButtons(); api('/join', { limit: parseInt($('join-limit').value) || 5 }); }
function doPost() { disableButtons(); api('/post', { limit: parseInt($('post-limit').value) || 5 }); }
function doRepost() { disableButtons(); api('/repost', { limit: parseInt($('post-limit').value) || 5, minDays: 7 }); }
function doCleanup() { disableButtons(); api('/cleanup', {}); }
function saveMsg() { api('/message', { message: $('msg').value }); }

// ── Selection & Batch ──
function toggleSelectAll(checked) {
  var filtered = filterGroups(allGroups);
  selectedIds = checked ? new Set(filtered.map(function(g){return g.id})) : new Set();
  updateSelectBar();
  renderGroups();
}

function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
  updateSelectBar();
  var allCb = $('select-all');
  var filtered = filterGroups(allGroups);
  allCb.checked = filtered.length > 0 && filtered.every(function(g){return selectedIds.has(g.id)});
}

function updateSelectBar() {
  var bar = $('select-bar');
  var count = selectedIds.size;
  if (count > 0) {
    bar.classList.add('active');
    $('select-count').textContent = count + ' selecionado' + (count > 1 ? 's' : '');
  } else {
    bar.classList.remove('active');
  }
}

function clearSelection() {
  selectedIds = new Set();
  $('select-all').checked = false;
  updateSelectBar();
  renderGroups();
}

function batchAction(action) {
  if (selectedIds.size === 0) return;
  var label = {join:'Entrar em',post:'Postar em',leave:'Sair de',delete:'Remover'}[action] || action;
  if (!confirm(label + ' ' + selectedIds.size + ' grupos?')) return;
  disableButtons();
  api('/batch', { ids: Array.from(selectedIds), action: action });
  clearSelection();
}

// ── Individual group actions ──
function groupAction(id, action) {
  if (action === 'delete') {
    if (!confirm('Remover grupo da lista?')) return;
    fetch('/group/' + id, { method: 'DELETE' }).then(function(r){return r.json()}).then(function(d){
      if (!d.ok) alert('Erro: ' + (d.msg || 'falha'));
    });
  } else {
    api('/group/' + id + '/' + action, {}).then(function(d){
      if (!d.ok) alert('Erro: ' + (d.msg || 'falha'));
    });
  }
}

// ── Groups rendering (safe, no innerHTML with user data) ──
function setFilter(f) {
  currentFilter = f;
  var btns = document.querySelectorAll('.filter-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', btns[i].dataset.filter === f);
  }
  renderGroups();
}

function filterGroups(groups) {
  switch (currentFilter) {
    case 'pending': return groups.filter(function(g){return !g.joined});
    case 'joined': return groups.filter(function(g){return g.joined && !g.posted});
    case 'posted': return groups.filter(function(g){return g.posted && !g.postError});
    case 'forbidden': return groups.filter(function(g){return g.postError === 'FORBIDDEN'});
    case 'community': return groups.filter(function(g){return g.isCommunity});
    default: return groups;
  }
}

function createGroupElement(g) {
  var item = document.createElement('div');
  item.className = 'group-item';

  var cbWrap = document.createElement('div');
  cbWrap.className = 'cb-wrap';
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = selectedIds.has(g.id);
  cb.onchange = function(){ toggleSelect(g.id) };
  cbWrap.appendChild(cb);
  item.appendChild(cbWrap);

  var info = document.createElement('div');
  info.className = 'group-info';

  var title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = g.title || '';

  var meta = document.createElement('div');
  meta.className = 'group-meta';
  var metaText = (g.participants ? g.participants + ' membros' : '?') + ' | ' + g.keyword;
  if (g.postedAt) metaText += ' | postou ' + new Date(g.postedAt).toLocaleDateString('pt-BR');
  meta.textContent = metaText;

  var badges = document.createElement('div');
  badges.className = 'group-badges';

  if (g.isCommunity) { var b = document.createElement('span'); b.className = 'badge badge-community'; b.textContent = 'Comunidade'; badges.appendChild(b); }
  if (g.left) { var b = document.createElement('span'); b.className = 'badge badge-left'; b.textContent = 'Saiu'; badges.appendChild(b); }
  else if (g.postError === 'FORBIDDEN') { var b = document.createElement('span'); b.className = 'badge badge-forbidden'; b.textContent = 'Sem permissao'; badges.appendChild(b); }
  else if (g.posted) { var b = document.createElement('span'); b.className = 'badge badge-posted'; b.textContent = 'Postou'; badges.appendChild(b); }
  else if (g.joined) { var b = document.createElement('span'); b.className = 'badge badge-joined'; b.textContent = 'Entrou'; badges.appendChild(b); }
  else { var b = document.createElement('span'); b.className = 'badge badge-pending'; b.textContent = 'Pendente'; badges.appendChild(b); }

  info.appendChild(title);
  info.appendChild(meta);
  info.appendChild(badges);

  var actions = document.createElement('div');
  actions.className = 'group-actions';

  if (!g.joined && g.username && !g.left) {
    var btn = document.createElement('button');
    btn.className = 'btn btn-orange btn-sm';
    btn.textContent = 'Entrar';
    btn.onclick = function(){groupAction(g.id,'join')};
    actions.appendChild(btn);
  }
  if (g.joined && !g.left) {
    var btn2 = document.createElement('button');
    btn2.className = 'btn btn-green btn-sm';
    btn2.textContent = 'Postar';
    btn2.onclick = function(){groupAction(g.id,'post')};
    actions.appendChild(btn2);

    var btn3 = document.createElement('button');
    btn3.className = 'btn btn-red btn-sm';
    btn3.textContent = 'Sair';
    btn3.onclick = function(){groupAction(g.id,'leave')};
    actions.appendChild(btn3);
  }

  var btnDel = document.createElement('button');
  btnDel.className = 'btn btn-gray btn-sm';
  btnDel.textContent = 'X';
  btnDel.title = 'Remover da lista';
  btnDel.onclick = function(){groupAction(g.id,'delete')};
  actions.appendChild(btnDel);

  item.appendChild(info);
  item.appendChild(actions);
  return item;
}

function renderGroups() {
  var filtered = filterGroups(allGroups);
  var container = $('groups-list');
  container.textContent = '';

  if (filtered.length === 0) {
    var p = document.createElement('p');
    p.style.cssText = 'color:#6b7280;font-size:13px;padding:20px;text-align:center';
    p.textContent = 'Nenhum grupo neste filtro';
    container.appendChild(p);
    return;
  }

  for (var i = 0; i < filtered.length; i++) {
    container.appendChild(createGroupElement(filtered[i]));
  }
}

// ── Init ──
renderGroups();

// Fallback polling (if SSE disconnects)
setInterval(function() {
  if (evtSource.readyState === 2) {
    fetch('/status').then(function(r){return r.json()}).then(function(d) {
      updateStats(d.groups);
      if (d.connected) $('conn-status').textContent = 'Conectado';
      if (d.waitingCode) $('code-area').style.display = 'block';
      if (d.waitingPassword) $('pw-area').style.display = 'block';
      if (!d.progress.active) enableButtons();
    }).catch(function(){});
  }
}, 5000);
</script></body></html>`;
}

// ── Autopilot Mode ──────────────────────────────────────────────────────────
let autopilot = { active: false, dailyTarget: 15, startHour: 10, endHour: 23, joined: 0, posted: 0, searched: false };

async function autopilotTick() {
  if (!autopilot.active || !isConnected) return;

  const now = new Date();
  const hour = now.getHours();

  // Fora do horario ativo
  if (hour < autopilot.startHour || hour >= autopilot.endHour) {
    // Reset contadores a meia-noite
    if (hour === 0 && autopilot.joined > 0) {
      autopilot.joined = 0;
      autopilot.posted = 0;
      autopilot.searched = false;
      logFn('[Autopilot] Contadores resetados para novo dia.');
    }
    return;
  }

  // Ja atingiu meta do dia
  if (autopilot.joined >= autopilot.dailyTarget) return;

  // Busca novos grupos 1x por dia (no inicio)
  if (!autopilot.searched) {
    logFn('[Autopilot] Buscando novos grupos...');
    await searchGroups(10);
    autopilot.searched = true;
    broadcastSSE({ type: 'autopilot', ...autopilot });
    return; // Proximo tick faz join
  }

  const groups = loadGroups();
  const pendingJoin = groups.filter(g => !g.joined && g.username);
  const pendingPost = groups.filter(g => g.joined && !g.posted && !g.left);

  // Prioridade 1: postar nos que ja entrou mas nao postou
  if (pendingPost.length > 0) {
    const g = pendingPost[0];
    logFn(`[Autopilot] Postando em: ${g.title}`);
    try {
      const entity = await client.getEntity(g.username || Number(g.id));
      const canWrite = await checkWritePermission(entity);
      if (!canWrite) {
        g.posted = true;
        g.postError = 'FORBIDDEN';
        await leaveGroup(g);
        saveGroups(groups);
        broadcastGroups();
        return;
      }
      await client.sendMessage(entity, { message: MESSAGE });
      g.posted = true;
      g.postedAt = new Date().toISOString();
      autopilot.posted++;
      logFn(`[Autopilot] Postou em ${g.title} (${autopilot.posted} hoje)`);
      saveGroups(groups);
      broadcastGroups();
      broadcastSSE({ type: 'autopilot', ...autopilot });
    } catch (e) {
      logFn(`[Autopilot] Erro ao postar: ${e.message}`);
      if (e.message.includes('FORBIDDEN') || e.message.includes('CHAT_WRITE') || e.message.includes('CHAT_SEND')) {
        g.posted = true;
        g.postError = 'FORBIDDEN';
        await leaveGroup(g);
        saveGroups(groups);
        broadcastGroups();
      }
    }
    return;
  }

  // Prioridade 2: entrar em grupo novo
  if (pendingJoin.length > 0) {
    const g = pendingJoin[0];
    logFn(`[Autopilot] Entrando em: ${g.title} (@${g.username})`);
    try {
      await client.invoke(new Api.channels.JoinChannel({ channel: g.username }));
      g.joined = true;
      g.joinedAt = new Date().toISOString();
      autopilot.joined++;
      logFn(`[Autopilot] Entrou em ${g.title} (${autopilot.joined}/${autopilot.dailyTarget} hoje)`);
      saveGroups(groups);
      broadcastGroups();
      broadcastSSE({ type: 'autopilot', ...autopilot });
    } catch (e) {
      logFn(`[Autopilot] Erro ao entrar: ${e.message}`);
      if (e.message.includes('CHANNELS_TOO_MUCH')) {
        logFn('[Autopilot] Limite de canais do Telegram atingido!');
        autopilot.active = false;
      }
    }
    return;
  }

  // Sem grupos pendentes — busca mais
  logFn('[Autopilot] Sem grupos pendentes. Buscando mais...');
  autopilot.searched = false;
}

// Calcula intervalo entre acoes baseado no horario
function getAutopilotInterval() {
  const totalMinutes = (autopilot.endHour - autopilot.startHour) * 60; // 780 min
  // Cada grupo = entrar + postar = 2 ações, entao target * 2
  const actionsPerDay = autopilot.dailyTarget * 2;
  const intervalMin = Math.floor(totalMinutes / actionsPerDay);
  return Math.max(intervalMin, 5) * 60 * 1000; // minimo 5 min, em ms
}

let autopilotTimer = null;

function startAutopilot() {
  if (autopilotTimer) clearInterval(autopilotTimer);
  autopilot.active = true;
  autopilot.joined = 0;
  autopilot.posted = 0;
  autopilot.searched = false;
  const interval = getAutopilotInterval();
  logFn(`[Autopilot] ATIVADO — ${autopilot.dailyTarget} grupos/dia, ${autopilot.startHour}h-${autopilot.endHour}h, intervalo ~${Math.round(interval/60000)}min`);
  autopilotTimer = setInterval(() => autopilotTick().catch(e => logFn(`[Autopilot] Erro: ${e.message}`)), interval);
  // Executa primeiro tick imediatamente
  autopilotTick().catch(e => logFn(`[Autopilot] Erro: ${e.message}`));
  broadcastSSE({ type: 'autopilot', ...autopilot });
}

function stopAutopilot() {
  autopilot.active = false;
  if (autopilotTimer) { clearInterval(autopilotTimer); autopilotTimer = null; }
  logFn('[Autopilot] DESATIVADO');
  broadcastSSE({ type: 'autopilot', ...autopilot });
}

app.post('/autopilot/start', (req, res) => {
  const target = parseInt(req.body.target) || 15;
  const startH = parseInt(req.body.startHour) || 10;
  const endH = parseInt(req.body.endHour) || 23;
  autopilot.dailyTarget = target;
  autopilot.startHour = startH;
  autopilot.endHour = endH;
  startAutopilot();
  res.json({ ok: true, autopilot });
});

app.post('/autopilot/stop', (req, res) => {
  stopAutopilot();
  res.json({ ok: true });
});

app.get('/autopilot/status', (req, res) => {
  res.json(autopilot);
});


app.listen(PORT, function() {
  logFn('Bot rodando em http://localhost:' + PORT);
  console.log('\n  Abra no navegador: http://localhost:' + PORT + '\n');
  // Auto-connect on startup if session exists
  autoConnect();
  // Self-ping to keep Render free tier awake (every 14 min)
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(function() {
      require('https').get(process.env.RENDER_EXTERNAL_URL + '/status', function(){});
    }, 14 * 60 * 1000);
    logFn('Self-ping ativo (Render)');
  }
});