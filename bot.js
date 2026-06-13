const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

// ============================================
// CONFIGURAÇÕES
// ============================================
const CONFIG = {
  serverHost: 'healtzcraft.com',
  serverPort: 25565,
  httpPort: 3000,
  botsCount: 3,
  botInterval: 8000,
  commandDelay: 5000,
  maxReconnectAttempts: 5,
  reconnectBackoff: 2000,
};

const bots = new Map();
let botIdCounter = 0;

// ============================================
// EXPRESS + SOCKET.IO
// ============================================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static('public'));

// ============================================
// API ENDPOINTS
// ============================================

// GET: Listar todos os bots
app.get('/api/bots', (req, res) => {
  const botsList = Array.from(bots.values()).map(b => ({
    id: b.id,
    nome: b.nome,
    status: b.status,
    server: b.server,
    port: b.port,
    version: b.version,
    autoSequence: b.autoSequence,
    commandsCount: b.commands ? b.commands.length : 0,
    captchaPending: b.captchaPending || false,
    captchaAttempts: b.captchaAttempts || 0,
    health: b.bot?.health || 20,
    food: b.bot?.food || 20,
    position: b.bot?.entity?.position || null,
  }));
  res.json(botsList);
});

// GET: Detalhes de um bot
app.get('/api/bot/:id', (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot não encontrado' });
  res.json({
    id: bot.id,
    nome: bot.nome,
    status: bot.status,
    server: bot.server,
    port: bot.port,
    version: bot.version,
    autoSequence: bot.autoSequence,
    commands: bot.commands || [],
    commandsCount: (bot.commands || []).length,
    captchaPending: bot.captchaPending,
    logs: bot.logs || [],
  });
});

// POST: Criar novo bot
app.post('/api/bot/create', (req, res) => {
  const { nome, server, port, senha, version, autoSequence } = req.body;
  if (!nome || !server) return res.status(400).json({ error: 'Nome e servidor obrigatórios' });

  const botId = String(botIdCounter++);
  const botData = {
    id: botId,
    nome,
    server,
    port: port || 25565,
    senha: senha || '',
    version: version || 'false',
    autoSequence: autoSequence || true,
    commands: [],
    status: 'offline',
    captchaPending: false,
    captchaAttempts: 0,
    bot: null,
    logs: [],
    reconnectAttempts: 0,
  };

  bots.set(botId, botData);
  io.emit('botCreated', { id: botId, nome });
  res.json({ success: true, id: botId });
});

// POST: Iniciar bot
app.post('/api/bot/:id/start', (req, res) => {
  const botData = bots.get(req.params.id);
  if (!botData) return res.status(404).json({ error: 'Bot não encontrado' });
  if (botData.status === 'online' || botData.status === 'connecting') {
    return res.json({ success: false, error: 'Bot já está ativo' });
  }

  createBot(req.params.id);
  res.json({ success: true });
});

// POST: Parar bot
app.post('/api/bot/:id/stop', (req, res) => {
  const botData = bots.get(req.params.id);
  if (!botData) return res.status(404).json({ error: 'Bot não encontrado' });
  if (botData.bot) {
    botData.bot.quit();
  }
  botData.status = 'offline';
  botData.bot = null;
  io.emit('botStatus', { id: req.params.id, status: 'offline' });
  res.json({ success: true });
});

// POST: Toggle auto sequence
app.post('/api/bot/:id/toggleAuto', (req, res) => {
  const botData = bots.get(req.params.id);
  if (!botData) return res.status(404).json({ error: 'Bot não encontrado' });
  botData.autoSequence = !botData.autoSequence;
  io.emit('botUpdated', { id: req.params.id, autoSequence: botData.autoSequence });
  res.json({ success: true });
});

// POST: Salvar comandos
app.post('/api/bot/:id/commands', (req, res) => {
  const botData = bots.get(req.params.id);
  if (!botData) return res.status(404).json({ error: 'Bot não encontrado' });
  const { commands } = req.body;
  botData.commands = Array.isArray(commands) ? commands : [];
  io.emit('botUpdated', { id: req.params.id, commandsCount: botData.commands.length });
  res.json({ success: true });
});

// POST: Enviar comando/mensagem
app.post('/api/bot/:id/say', (req, res) => {
  const botData = bots.get(req.params.id);
  if (!botData) return res.status(404).json({ error: 'Bot não encontrado' });
  if (!botData.bot || botData.status !== 'online') {
    return res.json({ success: false, error: 'Bot não está online' });
  }

  const { message } = req.body;
  try {
    botData.bot.chat(message);
    addBotLog(botData, `→ Enviado: ${message}`, 'info');
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST: Start All
app.post('/api/bots/startAll', (req, res) => {
  Array.from(bots.values())
    .filter(b => b.status === 'offline')
    .forEach((b, i) => {
      setTimeout(() => createBot(b.id), i * CONFIG.botInterval);
    });
  res.json({ success: true });
});

// POST: Stop All
app.post('/api/bots/stopAll', (req, res) => {
  Array.from(bots.values()).forEach(b => {
    if (b.bot) b.bot.quit();
    b.status = 'offline';
    b.bot = null;
  });
  io.emit('allBotsStopped');
  res.json({ success: true });
});

// ============================================
// BOT CREATION & MANAGEMENT
// ============================================

function randomDelay(min, max) {
  return min + Math.random() * (max - min);
}

function simulateRealisticBehavior(bot) {
  try {
    bot.loadPlugin(pathfinder);
    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);
  } catch (e) {}

  setInterval(() => {
    if (!bot.entity || !bot.entity.onGround) return;
    if (Math.random() > 0.7) {
      const actions = [
        () => bot.look(Math.random() * Math.PI * 2, Math.random() * Math.PI - Math.PI / 2),
        () => {
          bot.setControlState('forward', true);
          setTimeout(() => bot.setControlState('forward', false), 500);
        },
        () => bot.swingArm(),
      ];
      actions[Math.floor(Math.random() * actions.length)]();
    }
  }, 3000 + Math.random() * 5000);
}

class CommandScheduler {
  constructor(bot, botData) {
    this.bot = bot;
    this.botData = botData;
    this.queue = [];
    this.executing = false;
  }

  add(command, delay = 0) {
    this.queue.push({ command, delay });
    return this;
  }

  async execute() {
    this.executing = true;
    for (const { command, delay } of this.queue) {
      if (!this.bot.entity) break;
      const actualDelay = delay + randomDelay(-500, 500);
      await new Promise(resolve => setTimeout(resolve, actualDelay));
      try {
        this.bot.chat(command);
        addBotLog(this.botData, `→ ${command}`, 'info');
      } catch (err) {
        addBotLog(this.botData, `❌ Erro: ${err.message}`, 'err');
      }
    }
    this.executing = false;
  }
}

async function createBot(botId) {
  const botData = bots.get(botId);
  if (!botData) return;

  const username = `Bot${botId}_${Math.random().toString(36).substring(7)}`;
  botData.status = 'connecting';
  botData.reconnectAttempts = 0;
  io.emit('botStatus', { id: botId, nome: botData.nome, status: 'connecting' });
  addBotLog(botData, `🤖 Conectando como ${username}...`, 'info');

  const bot = mineflayer.createBot({
    host: botData.server,
    port: botData.port,
    username: username,
    version: botData.version === 'false' ? false : botData.version,
    hideErrors: false,
    checkTimeoutInterval: 30 * 1000,
    keepalive: true,
  });

  botData.bot = bot;

  // ============ EVENTOS ============

  bot.on('login', () => {
    addBotLog(botData, '✅ Login realizado', 'ok');
  });

  bot.on('spawn', () => {
    botData.status = 'online';
    io.emit('botStatus', { id: botId, nome: botData.nome, status: 'online' });
    addBotLog(botData, '🎮 Bot entrou no servidor!', 'ok');

    simulateRealisticBehavior(bot);

    if (botData.autoSequence && botData.commands.length > 0) {
      setTimeout(() => {
        addBotLog(botData, '⏳ Iniciando comandos automáticos...', 'info');
        const scheduler = new CommandScheduler(bot, botData);
        botData.commands.forEach((cmd, i) => {
          scheduler.add(cmd, i === 0 ? 0 : 5000);
        });
        scheduler.execute();
      }, 2000);
    }
  });

  bot.on('message', (message) => {
    const msgStr = message.toString();
    const lower = msgStr.toLowerCase();
    addBotLog(botData, `💬 ${msgStr}`, 'info');

    if (lower.includes('captcha') || lower.includes('verify') || lower.includes('human')) {
      handleCaptcha(botData, bot);
    }
  });

  bot.on('resourcePack', (pack) => {
    addBotLog(botData, '📦 Aceitando resource pack...', 'info');
    try {
      bot.acceptResourcePack(pack);
    } catch (e) {}
  });

  bot.on('error', (err) => {
    addBotLog(botData, `❌ Erro: ${err.message}`, 'err');
  });

  bot.on('kicked', (reason) => {
    addBotLog(botData, `⚠️  Kickado: ${reason}`, 'warn');
    scheduleReconnect(botId, 0);
  });

  bot.on('end', () => {
    addBotLog(botData, '🔌 Desconectado', 'warn');
    if (botData.status !== 'offline') {
      scheduleReconnect(botId, 0);
    }
  });

  bot.on('health', () => {
    if (bot.health <= 0) {
      addBotLog(botData, '💀 Bot morreu!', 'warn');
    }
  });

  bot.on('disconnect', (packet) => {
    const reason = packet.reason?.text || packet.reason || 'desconexão';
    if (reason.toLowerCase().includes('bot') || reason.toLowerCase().includes('anti')) {
      addBotLog(botData, `🚫 Anti-bot: ${reason}`, 'err');
      scheduleReconnect(botId, 0);
    }
  });
}

function handleCaptcha(botData, bot) {
  botData.captchaPending = true;
  botData.captchaAttempts = (botData.captchaAttempts || 0) + 1;
  io.emit('captchaWaiting', { id: botData.id, nome: botData.nome, attempts: botData.captchaAttempts });
  addBotLog(botData, `⚠️  CAPTCHA detectado (tentativa ${botData.captchaAttempts}/3)`, 'warn');

  if (botData.captchaAttempts >= 3) {
    addBotLog(botData, '❌ Máximo de tentativas de captcha atingido!', 'err');
  }
}

function scheduleReconnect(botId, attempt = 0) {
  const botData = bots.get(botId);
  if (!botData) return;

  if (attempt >= CONFIG.maxReconnectAttempts) {
    botData.status = 'offline';
    addBotLog(botData, '❌ Máximo de reconexões atingido', 'err');
    io.emit('botStatus', { id: botId, nome: botData.nome, status: 'offline' });
    return;
  }

  const backoff = CONFIG.reconnectBackoff * Math.pow(2, attempt);
  addBotLog(botData, `⏱️  Reconectando em ${backoff}ms (tentativa ${attempt + 1}/${CONFIG.maxReconnectAttempts})`, 'info');

  setTimeout(() => {
    createBot(botId);
  }, backoff);
}

function addBotLog(botData, message, type = 'info') {
  if (!botData.logs) botData.logs = [];
  const timestamp = new Date().toLocaleTimeString('pt-BR');
  botData.logs.push({ timestamp, message, type });
  if (botData.logs.length > 100) botData.logs.shift();
  io.emit('botLog', { id: botData.id, log: { timestamp, message, type } });
}

// ============================================
// SOCKET.IO
// ============================================

io.on('connection', (socket) => {
  console.log(`[SOCKET] Cliente conectado: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`[SOCKET] Cliente desconectado: ${socket.id}`);
  });

  socket.on('botCommand', ({ botId, command }) => {
    const botData = bots.get(botId);
    if (botData && botData.bot && botData.status === 'online') {
      botData.bot.chat(command);
      addBotLog(botData, `→ ${command}`, 'info');
    }
  });
});

// ============================================
// SERVIDOR HTTP
// ============================================

server.listen(CONFIG.httpPort, () => {
  console.log(`
╔═══════════════════════════════════════╗
║     BOTCRAFT ULTIMATE v4.0            ║
║     Dashboard Ativa                   ║
╚═══════════════════════════════════════╝
[HTTP] Dashboard: http://localhost:${CONFIG.httpPort}
[WS]   Socket.IO: ws://localhost:${CONFIG.httpPort}
[INFO] Aguardando conexões...
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Encerrando...');
  Array.from(bots.values()).forEach(b => {
    if (b.bot) b.bot.quit();
  });
  server.close();
  process.exit(0);
});

// Health check
setInterval(() => {
  const active = Array.from(bots.values()).filter(b => b.status === 'online').length;
  const total = bots.size;
  console.log(`[HEALTH] ${active}/${total} bots online`);
}, 30000);

module.exports = { app, server, io, bots };
