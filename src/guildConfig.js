const fs = require('fs');
const path = require('path');

const configFile = path.join(__dirname, '../guild-config.json');

// The bot and dashboard run as separate processes sharing this file,
// so the cache is invalidated whenever the file's mtime changes.
let cache = null;
let cacheMtime = 0;

function fileMtime() {
  try { return fs.statSync(configFile).mtimeMs; } catch { return 0; }
}

function loadAllConfigs() {
  const mtime = fileMtime();
  if (cache && mtime === cacheMtime) return cache;
  cacheMtime = mtime;
  try {
    const parsed = mtime ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : null;
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = cache || {};
  }
  return cache;
}

function saveAllConfigs() {
  try {
    fs.writeFileSync(configFile, JSON.stringify(cache, null, 2), 'utf8');
    cacheMtime = fileMtime();
  } catch {}
}

function getDefaultConfig() {
  return {
    scheduleChannelId: process.env.DEFAULT_SCHEDULE_CHANNEL_ID || null,
    voiceChannelId: process.env.DEFAULT_VOICE_CHANNEL_ID || null,
    eventTime: process.env.DEFAULT_EVENT_TIME || 'Saturday 20:00',
    adminRoleId: process.env.ADMIN_ROLE_ID || null,
    scheduleMessageId: process.env.SCHEDULE_MESSAGE_ID || null,
    archiveThreadId: null,
  };
}

function getGuildConfig(guildId) {
  if (!guildId) return getDefaultConfig();
  const guildConfig = loadAllConfigs()[guildId];
  return { ...getDefaultConfig(), ...(guildConfig && typeof guildConfig === 'object' ? guildConfig : {}) };
}

function setGuildConfig(guildId, partial) {
  if (!guildId || !partial || typeof partial !== 'object') return getGuildConfig(guildId);
  const next = { ...getGuildConfig(guildId), ...partial };
  loadAllConfigs()[guildId] = next;
  saveAllConfigs();
  return next;
}

module.exports = {
  configFile,
  getGuildConfig,
  setGuildConfig,
};
