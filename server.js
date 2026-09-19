// Servidor del gestor de horarios
// Guarda los datos en data/db.json y sirve la app web en /public

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_BACKUPS = 30; // respaldos diarios conservados
const THEMES = ['indigo', 'emerald', 'amber', 'rose', 'slate', 'dark'];
const DEFAULT_SETTINGS = { company: '', taxId: '', logo: '', theme: 'indigo' };
const ROLES = ['admin', 'editor', 'viewer'];
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 días

// ---------- Utilidades de datos ----------

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!Array.isArray(db.archive)) db.archive = []; // historial de retirados (migración)
      if (!Array.isArray(db.users)) db.users = [];     // usuarios de la app (migración)
      if (!Array.isArray(db.sessions)) db.sessions = []; // sesiones activas (migración)
      return db;
    }
  } catch (e) {
    console.error('Error leyendo la base de datos:', e.message);
  }
  return { people: [], schedule: {}, settings: {}, archive: [], users: [] };
}

function saveDb(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  dailyBackup();
}

// Respaldo automático: una copia por día en data/backups/, se conservan las últimas 30
function dailyBackup() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(BACKUP_DIR, `db-${today}.json`);
    if (fs.existsSync(file)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DB_FILE, file);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > KEEP_BACKUPS) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) {
    console.error('Respaldo diario falló:', e.message);
  }
}

// ---------- Middleware ----------

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Autenticación y autorización ----------

const hashPassword = (password, salt) =>
  crypto.scryptSync(password, salt, 64).toString('hex');

// Crea el usuario inicial solo si aún no existe ninguno (el PRIMERO es admin)
function ensureInitialAdmin() {
  const db = loadDb();
  if (db.users.length) return;
  const salt = crypto.randomBytes(16).toString('hex');
  db.users.push({
    id: 'u' + crypto.randomBytes(6).toString('hex'),
    username: 'admin',
    salt,
    hash: hashPassword('admin123', salt),
    role: 'admin',
    createdAt: new Date().toISOString(),
  });
  saveDb(db);
  console.log('👤 Usuario inicial creado: admin / admin123 — cámbialo en la app.');
}
ensureInitialAdmin();

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt };
}

function findUser(db, username) {
  const q = String(username || '').trim().toLowerCase();
  return db.users.find(u => u.username.toLowerCase() === q);
}

// Middleware: valida el token y adjunta req.user (o responde 401)
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado. Inicia sesión.' });
  const db = loadDb();
  const s = db.sessions.find(x => x.token === token);
  if (!s) return res.status(401).json({ error: 'Sesión inválida. Inicia sesión de nuevo.' });
  if (Date.now() > s.expiresAt) {
    db.sessions = db.sessions.filter(x => x.token !== token);
    saveDb(db);
    return res.status(401).json({ error: 'Sesión expirada. Inicia sesión de nuevo.' });
  }
  const user = db.users.find(u => u.id === s.userId);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado. Inicia sesión de nuevo.' });
  req.user = user;
  req.db = db;
  next();
}

// Autorización por rol: requireRole('admin') o requireRole('admin', 'editor')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No tienes permisos para esta acción' });
    }
    next();
  }
}

// Sesión del propio usuario autenticado
function sessionFor(db, user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ token, userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL });
  db.sessions = db.sessions.filter(s => s.expiresAt > Date.now()); // limpieza de sesiones vencidas
  return token;
}

// ---------- API: Auth ----------

// Crear usuario: solo el admin. El primero se crea solo (ensureInitialAdmin).
app.post('/api/auth/users', requireAuth, requireRole('admin'), (req, res) => {
  const db = req.db;
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = ROLES.includes(req.body.role) ? req.body.role : 'viewer';
  if (!username || username.length < 3) return res.status(400).json({ error: 'El usuario debe tener al menos 3 caracteres' });
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) return res.status(400).json({ error: 'El usuario solo admite letras, números, punto, guion y guion bajo' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  if (findUser(db, username)) return res.status(409).json({ error: 'Ese usuario ya existe' });

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: 'u' + crypto.randomBytes(6).toString('hex'),
    username,
    salt,
    hash: hashPassword(password, salt),
    role,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  saveDb(db);
  res.status(201).json(publicUser(user));
});

// Login: valida credenciales y devuelve un token Bearer válido 30 días
app.post('/api/auth/login', (req, res) => {
  const db = loadDb();
  const user = findUser(db, req.body.username);
  let ok = false;
  if (user) {
    try {
      const attempt = Buffer.from(hashPassword(String(req.body.password || ''), user.salt), 'hex');
      const stored = Buffer.from(user.hash, 'hex');
      ok = attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);
    } catch (_) { ok = false; }
  }
  if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const token = sessionFor(db, user);
  saveDb(db);
  res.json({ token, user: publicUser(user) });
});

// ¿Sigo autenticado? El frontend lo usa al cargar la página
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Cerrar sesión: invalida el token actual
app.post('/api/auth/logout', requireAuth, (req, res) => {
  const db = loadDb();
  const header = req.headers.authorization || '';
  const token = header.slice(7);
  db.sessions = db.sessions.filter(s => s.token !== token);
  saveDb(db);
  res.json({ ok: true });
});

// Listar usuarios (solo admin)
app.get('/api/auth/users', requireAuth, requireRole('admin'), (req, res) => {
  res.json(loadDb().users.map(publicUser));
});

// Cambiar rol o contraseña (solo admin)
app.put('/api/auth/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const body = req.body || {};
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) return res.status(400).json({ error: 'Rol no válido' });
    // Nunca dejar la base sin ningún admin
    if (user.role === 'admin' && body.role !== 'admin' && db.users.filter(u => u.role === 'admin').length === 1) {
      return res.status(400).json({ error: 'No puedes quitar el rol al último admin' });
    }
    user.role = body.role;
  }
  if (body.password !== undefined) {
    const password = String(body.password);
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = hashPassword(password, user.salt);
    // Cierra las demás sesiones del usuario (la actual se mantiene)
    const currentToken = (req.headers.authorization || '').slice(7);
    db.sessions = db.sessions.filter(s => s.userId !== user.id || s.token === currentToken);
  }
  saveDb(db);
  res.json(publicUser(user));
});

// Eliminar usuario (solo admin; no puede eliminarse a sí mismo ni al último admin)
app.delete('/api/auth/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario con la sesión activa' });
  if (user.role === 'admin' && db.users.filter(u => u.role === 'admin').length === 1) {
    return res.status(400).json({ error: 'No puedes eliminar al último admin' });
  }
  db.users = db.users.filter(u => u.id !== user.id);
  db.sessions = db.sessions.filter(s => s.userId !== user.id); // se cierran sus sesiones
  saveDb(db);
  res.json({ ok: true });
});

// ---------- API: Personal ----------

app.get('/api/people', requireAuth, (req, res) => {
  const db = req.db; // ya cargada por requireAuth
  res.json(db.people || []);
});

const PERSON_STATUS = ['active', 'suspended', 'retired', 'vacation', 'leave'];

// Crear persona: { name, role, phone }
app.post('/api/people', requireAuth, requireRole('admin', 'editor'), (req, res) => {
  const db = req.db;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });

  const person = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name,
    role: (req.body.role || '').trim(),
    phone: (req.body.phone || '').replace(/[^\d+]/g, ''),
    status: 'active' // active | suspended | retired | vacation | leave
  };
  db.people.push(person);
  saveDb(db);
  res.status(201).json(person);
});

// Editar persona: { name?, role?, phone?, status? }
app.put('/api/people/:id', requireAuth, requireRole('admin', 'editor'), (req, res) => {
  const db = req.db;
  const p = db.people.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Persona no encontrada' });

  if (req.body.name !== undefined) p.name = String(req.body.name).trim() || p.name;
  if (req.body.role !== undefined) p.role = String(req.body.role).trim();
  if (req.body.phone !== undefined) p.phone = String(req.body.phone).replace(/[^\d+]/g, '');
  if (req.body.status !== undefined && PERSON_STATUS.includes(req.body.status)) {
    p.status = req.body.status;
  }
  saveDb(db);
  res.json(p);
});

// Retirar persona: pasa al historial con todos sus turnos guardados (recuperable)
app.delete('/api/people/:id', requireAuth, requireRole('admin'), (req, res) => {
  const db = req.db;
  const idx = db.people.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Persona no encontrada' });
  const person = db.people.splice(idx, 1)[0];

  // Snapshot de todos sus turnos en todas las semanas
  const shiftsHistory = {};
  for (const [week, shifts] of Object.entries(db.schedule || {})) {
    if (shifts[person.id]) shiftsHistory[week] = shifts[person.id];
  }
  db.archive.push({
    ...person,
    status: 'retired',
    retiredAt: new Date().toISOString(),
    shiftsHistory,
  });

  // Quitar sus turnos del horario activo
  for (const week of Object.values(db.schedule || {})) {
    delete week[person.id];
  }
  saveDb(db);
  res.json({ ok: true, retired: person.name, semanasGuardadas: Object.keys(shiftsHistory).length });
});

// ---------- API: Historial (personal retirado) ----------

app.get('/api/archive', requireAuth, (req, res) => {
  const db = req.db;
  res.json((db.archive || []).map(({ shiftsHistory, ...rest }) => ({
    ...rest,
    weeks: Object.keys(shiftsHistory || {}).length,
  })));
});

// Reintegrar: vuelve al personal activo con status activo y recupera sus turnos
app.post('/api/archive/:id/reinstate', requireAuth, requireRole('admin', 'editor'), (req, res) => {
  const db = req.db;
  const idx = db.archive.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No está en el historial' });
  const entry = db.archive.splice(idx, 1)[0];
  const { shiftsHistory, retiredAt, ...person } = entry;
  person.status = 'active';
  db.people.push(person);

  db.schedule = db.schedule || {};
  for (const [week, days] of Object.entries(shiftsHistory || {})) {
    db.schedule[week] = db.schedule[week] || {};
    db.schedule[week][person.id] = days;
  }
  saveDb(db);
  res.json({ ok: true, person });
});

// ---------- API: Horario ----------

// Estructura: schedule[weekKey][personId] = { "0": "08:00-16:00", ... "6": "..." }
// weekKey = año-Wsemana, ej: "2026-W38"

// Obtener semana: /api/schedule?week=2026-W38 (el frontend siempre envía week)
app.get('/api/schedule', requireAuth, (req, res) => {
  const week = req.query.week;
  if (!week) return res.status(400).json({ error: 'Falta el parámetro week' });
  const db = req.db;
  res.json({ week, shifts: (db.schedule && db.schedule[week]) || {} });
});

// Guardar semana: { week, shifts: { personId: { "0": "08:00-16:00", ... } } }
app.put('/api/schedule', requireAuth, requireRole('admin', 'editor'), (req, res) => {
  const { week, shifts } = req.body || {};
  if (!week || typeof shifts !== 'object' || shifts === null) {
    return res.status(400).json({ error: 'Faltan datos (week, shifts)' });
  }
  const db = req.db;
  db.schedule = db.schedule || {};
  db.schedule[week] = shifts;
  saveDb(db);
  res.json({ ok: true, week });
});

// ---------- Configuración ----------

app.get('/api/settings', requireAuth, (req, res) => {
  const db = req.db;
  res.json(Object.assign({}, DEFAULT_SETTINGS, db.settings || {}));
});

// Acepta cambios parciales: solo actualiza los campos enviados
app.put('/api/settings', requireAuth, requireRole('admin', 'editor'), (req, res) => {
  const db = req.db;
  const body = req.body || {};
  const prev = Object.assign({}, DEFAULT_SETTINGS, db.settings || {});
  db.settings = {
    company: body.company !== undefined ? String(body.company).trim().slice(0, 60) : prev.company,
    taxId: body.taxId !== undefined ? String(body.taxId).trim().slice(0, 40) : prev.taxId,
    logo: body.logo !== undefined ? String(body.logo).slice(0, 300000) : prev.logo, // dataURL ~máx 2 MB
    theme: THEMES.includes(body.theme) ? body.theme : prev.theme,
  };
  saveDb(db);
  res.json(db.settings);
});

// ---------- Respaldo ----------

app.get('/api/backup', requireAuth, requireRole('admin'), (req, res) => {
  const db = req.db;
  const { sessions, ...safeDb } = db; // los tokens de sesión no se exportan
  res.setHeader('Content-Disposition', 'attachment; filename="horario-respaldo.json"');
  res.json(safeDb);
});

// Restaurar respaldo: enviar el JSON completo como body.
// Si el respaldo es viejo (sin historial), se conserva el historial actual.
app.post('/api/restore', requireAuth, requireRole('admin'), (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.people) || typeof body.schedule !== 'object') {
    return res.status(400).json({ error: 'Archivo de respaldo no válido' });
  }
  if (!Array.isArray(body.archive)) body.archive = req.db.archive || [];
  // La autenticación nunca se pisa con un respaldo viejo: se conservan usuarios y sesiones actuales
  body.users = req.db.users || [];
  body.sessions = req.db.sessions || [];
  saveDb(body);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`✅ Gestor de horarios corriendo en http://localhost:${PORT}`);
  console.log(`   Desde el celular: http://IP-DE-TU-PC:${PORT}`);
});
