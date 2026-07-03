const fs = require('fs');
const path = require('path');

const configFile = path.join(__dirname, '../guild-config.json');

let cache = null;

function loadAllConfigs() {
  if (cache) return cache;
  try {
    if (fs.existsSync(configFile)) {
      const raw = fs.readFileSync(configFile, 'utf8');
      cache = JSON.parse(raw);
      if (cache && typeof cache === 'object') return cache;
    }
  } catch {}
  cache = {};
  return cache;
}

function saveAllConfigs() {
  try {
    fs.writeFileSync(configFile, JSON.stringify(loadAllConfigs(), null, 2), 'utf8');
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
  const all = loadAllConfigs();
  const defaults = getDefaultConfig();
  const guildConfig = all[guildId] && typeof all[guildId] === 'object' ? all[guildId] : {};
  return { ...defaults, ...guildConfig };
}

function setGuildConfig(guildId, partial) {
  if (!guildId || !partial || typeof partial !== 'object') return getGuildConfig(guildId);
  const all = loadAllConfigs();
  const next = { ...getGuildConfig(guildId), ...partial };
  all[guildId] = next;
  saveAllConfigs();
  return next;
}

function listConfiguredGuildIds() {
  return Object.keys(loadAllConfigs());
}

module.exports = {
  configFile,
  getGuildConfig,
  setGuildConfig,
  listConfiguredGuildIds,
};
