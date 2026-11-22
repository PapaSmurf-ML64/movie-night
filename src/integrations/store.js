// Per-guild integration settings (Plex, Seerr, Radarr, playback webhooks).
// Stored in SQLite (not guild-config.json) and encrypted with AES-256-GCM, since they hold API keys.
const crypto = require('crypto');
const { db, run, all } = require('../schedule');

db.run(`CREATE TABLE IF NOT EXISTS guild_integrations (
  guild_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
)`);

// Key: INTEGRATIONS_KEY if set, else derived from DASHBOARD_SECRET.
// Changing whichever one is used makes saved integrations unreadable (they'd need re-entering).
function encryptionKey() {
  const secret = process.env.INTEGRATIONS_KEY || process.env.DASHBOARD_SECRET;
  if (!secret) throw new Error('Set INTEGRATIONS_KEY (or DASHBOARD_SECRET) in .env to store integration settings.');
  return crypto.createHash('sha256').update(`movie-night-integrations:${secret}`).digest();
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}

function decrypt(text) {
  const [iv, tag, data] = text.split('.').map(s => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

const DEFAULTS = {
  plex: { url: '', token: '', machineId: '', serverName: '' },
  seerr: { url: '', apiKey: '' },
  radarr: { url: '', apiKey: '', qualityProfileId: null, rootFolder: '' },
  autoRequest: true,       // request missing movies automatically when they're added
  webhookToken: '',        // secret in this guild's webhook URLs
  plexWebhooks: false,     // Plex Pass webhooks enabled
  tautulliWebhooks: false, // Tautulli webhooks enabled
  voteWhenEmpty: false,    // nothing scheduled at ping time: vote between 5 Plex movies
  voteTheme: 'month',      // 'month' | 'season'
};

const cache = new Map();

async function getIntegrations(guildId) {
  if (cache.has(guildId)) return cache.get(guildId);
  const row = (await all(`SELECT data FROM guild_integrations WHERE guild_id = ?`, [guildId]))[0];
  let stored = {};
  if (row) {
    try { stored = decrypt(row.data); } catch { stored = {}; } // wrong key: treat as unconfigured
  }
  const merged = {
    ...DEFAULTS, ...stored,
    plex: { ...DEFAULTS.plex, ...stored.plex },
    seerr: { ...DEFAULTS.seerr, ...stored.seerr },
    radarr: { ...DEFAULTS.radarr, ...stored.radarr },
  };
  if (!merged.webhookToken) {
    // Persist immediately so webhook URLs stay stable across restarts
    merged.webhookToken = crypto.randomBytes(24).toString('hex');
    return saveIntegrations(guildId, merged);
  }
  cache.set(guildId, merged);
  return merged;
}

async function saveIntegrations(guildId, next) {
  await run(`INSERT INTO guild_integrations (guild_id, data) VALUES (?, ?)
             ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data`, [guildId, encrypt(next)]);
  cache.set(guildId, next);
  return next;
}

const isPlexConfigured = i => Boolean(i.plex.url && i.plex.token);
const isSeerrConfigured = i => Boolean(i.seerr.url && i.seerr.apiKey);
const isRadarrConfigured = i => Boolean(i.radarr.url && i.radarr.apiKey);

// Constant-time webhook token check
function tokenMatches(i, given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(i.webhookToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  getIntegrations,
  saveIntegrations,
  isPlexConfigured,
  isSeerrConfigured,
  isRadarrConfigured,
  tokenMatches,
};
