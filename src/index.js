// Single entry point: Discord bot + web dashboard in one process,
// so the dashboard shares the bot's client, caches and state.
require('dotenv').config();
const { client, refreshScheduleMessage } = require('./bot');
const { startDashboard } = require('./dashboard');

startDashboard(client, { refreshScheduleMessage });
