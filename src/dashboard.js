// Web dashboard. Runs inside the bot process (see index.js) so it shares the Discord client and live state.
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const rfs = require('rotating-file-stream');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const schedule = require('./schedule');
const tmdb = require('./tmdb');
const roles = require('./roles');
const { buildScheduleMappings, nextFreeEventDate } = require('./scheduleUtils');
const { getEventSettings, upcomingEventDates, todayStr, validateEventDate, eventStart } = require('./util');
const { getGuildConfig } = require('./guildConfig');
const { resolveArchiveThread } = require('./archiveThread');
const Busboy = require('busboy');
const integrations = require('./integrations');
const integrationStore = require('./integrations/store');
const { normalizeBaseUrl } = require('./integrations/http');
const { testPlex } = require('./integrations/plex');
const { testSeerr } = require('./integrations/seerr');
const { testRadarr } = require('./integrations/radarr');
const playback = require('./integrations/playback');
const { clearWatchingIfArchived } = require('./nickname');

// Set by startDashboard(): the bot's Discord client and a schedule-message refresher
let client = null;
let refreshScheduleMessage = async () => {};

const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET;
const PLACEHOLDER_SECRETS = new Set(['', 'changeme', 'your_dashboard_secret_here']);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
// Trust X-Forwarded-* only from a reverse proxy on this machine, so secure cookies work behind nginx/caddy
app.set('trust proxy', 'loopback');
app.use(express.static(path.join(__dirname, '../public'), { maxAge: '1h' }));

// ---- Playback webhooks (no session/CSRF: authenticated by the per-guild secret in the URL) ----
async function webhookGuild(req, res, enabledKey) {
  const { guildId, token } = req.params;
  if (!/^\d{5,25}$/.test(guildId)) { res.status(404).end(); return null; }
  const config = await integrationStore.getIntegrations(guildId);
  if (!integrationStore.tokenMatches(config, token)) { res.status(404).end(); return null; }
  if (!config[enabledKey]) { res.status(409).send('This webhook is disabled in the dashboard.'); return null; }
  return config;
}

async function applyPlaybackEvent(guildId, event, res) {
  if (!event) return res.status(204).end();
  try {
    const result = await playback.handlePlaybackEvent(guildId, event);
    if (result.handled) logDashboard(`Webhook ${event.source} ${event.action} for guild ${guildId}: ${result.action} ${result.movie}`);
    res.status(200).json(result);
  } catch (e) {
    logDashboard(`Webhook ${event.source} failed for guild ${guildId}: ${e.message}`);
    res.status(500).json({ error: 'failed' });
  }
}

// Plex sends multipart/form-data with a JSON "payload" field (plus an optional thumbnail we ignore)
app.post('/webhooks/plex/:guildId/:token', async (req, res) => {
  const config = await webhookGuild(req, res, 'plexWebhooks');
  if (!config) return req.resume();
  let payload = null;
  try {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 0, fieldSize: 256 * 1024, fields: 5 } });
    bb.on('field', (name, value) => { if (name === 'payload') payload = value; });
    bb.on('file', (name, stream) => stream.resume());
    await new Promise((resolve, reject) => { bb.on('close', resolve); bb.on('error', reject); req.pipe(bb); });
    payload = JSON.parse(payload);
  } catch {
    return res.status(400).send('Bad Plex payload');
  }
  applyPlaybackEvent(req.params.guildId, playback.fromPlexPayload(payload, config.plex.machineId), res);
});

app.post('/webhooks/tautulli/:guildId/:token', express.json({ limit: '64kb' }), async (req, res) => {
  const config = await webhookGuild(req, res, 'tautulliWebhooks');
  if (!config) return;
  applyPlaybackEvent(req.params.guildId, playback.fromTautulliPayload(req.body), res);
});

app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: DASHBOARD_SECRET || 'unset',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax',
    httpOnly: true,
    secure: 'auto', // secure when the request arrived over HTTPS
  },
  store: new (require('session-file-store')(session))({ path: './.sessions', retries: 1 })
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: '/auth/discord/callback',
  scope: ['identify', 'guilds', 'guilds.members.read']
}, (accessToken, refreshToken, profile, done) => {
  process.nextTick(() => done(null, profile));
}));

// ---- CSRF: per-session token, required on every POST ----
function csrfToken(req) {
  return (req.session.csrfToken ||= crypto.randomBytes(24).toString('hex'));
}

app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const expected = req.session?.csrfToken;
  const given = req.body?._csrf;
  const ok = expected && typeof given === 'string' && given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) {
    logDashboard(`Rejected POST ${req.path}: bad CSRF token (user: ${req.user?.id || 'unknown'})`);
    return res.status(403).send('Invalid or expired form. Go back, refresh the page and try again.');
  }
  next();
});

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  res.redirect('/login');
}

app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
  res.redirect('/');
});
app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

const ADMIN_PERMISSION = 0x8n;
const MANAGE_GUILD_PERMISSION = 0x20n;
const BOT_COMMANDS = [
  { name: '/addmovie', description: 'Add one or more movies to the schedule, with optional date and year.' },
  { name: '/startevent', description: 'Start the next scheduled movie event.' },
  { name: '/stopevent', description: 'Stop the current movie event.' },
  { name: '/refreshschedule', description: 'Refresh the posted schedule message in the configured channel.' },
  { name: '/setchannel', description: 'Set which text channel the schedule is posted into for this server.' },
  { name: '/setvoicechannel', description: 'Set the default voice channel used for event auto-start.' },
  { name: '/setadminrole', description: 'Set the role allowed to manage restricted admin commands for this server.' },
  { name: '/setarchivethread', description: 'Set an existing thread for archived event posts.' },
  { name: '/seteventtime', description: 'Set the regular event day and time for this server (e.g. Saturday 20:00).' },
  { name: '/reschedulemovie', description: 'Move a scheduled movie (by the # ID shown below) to a different date.' },
  { name: '/rsvp', description: 'RSVP for movie night and receive notifications.' },
  { name: '/unrsvp', description: 'Remove your RSVP/notification role for movie nights.' },
  { name: '/setschedulemsg', description: 'Pin schedule updates to a specific message ID in the schedule channel.' },
  { name: '/linkplex', description: 'Link your Plex username so watching on Plex counts toward attendance.' },
  { name: '/unlinkplex', description: 'Unlink your Plex username.' },
];


function hasPermission(permissions, flag) {
  try {
    return (BigInt(permissions || '0') & flag) === flag;
  } catch {
    return false;
  }
}

// Short-lived per-user cache of which servers they can manage
const ACCESS_TTL = 60 * 1000;
const accessCache = new Map(); // userId -> { report, at }

async function checkGuildAccess(user, guild) {
  try {
    const botGuild = client.guilds.cache.get(guild.id);
    if (!botGuild) {
      return { guild, included: false, reason: 'bot_not_in_server' };
    }
    if (hasPermission(guild.permissions, ADMIN_PERMISSION) || hasPermission(guild.permissions, MANAGE_GUILD_PERMISSION)) {
      return { guild, included: true };
    }
    const { adminRoleId } = getGuildConfig(guild.id);
    if (!adminRoleId) {
      return { guild, included: false, reason: 'no_admin_permission_and_no_admin_role_configured' };
    }
    const member = await botGuild.members.fetch(user.id).catch(() => null);
    if (!member) {
      return { guild, included: false, reason: 'member_lookup_failed' };
    }
    return member.roles.cache.has(adminRoleId)
      ? { guild, included: true }
      : { guild, included: false, reason: 'missing_configured_admin_role' };
  } catch {
    return { guild, included: false, reason: 'validation_error' };
  }
}

async function getDashboardGuildAccessReport(user) {
  const userGuilds = Array.isArray(user?.guilds) ? user.guilds : [];
  if (!client?.isReady()) {
    return { included: [], excluded: userGuilds.map(g => ({ guild: g, reason: 'bot_not_ready' })) };
  }
  const hit = accessCache.get(user.id);
  if (hit && Date.now() - hit.at < ACCESS_TTL) return hit.report;

  const checks = await Promise.all(userGuilds.map(guild => checkGuildAccess(user, guild)));
  const report = {
    included: checks.filter(c => c.included).map(c => c.guild),
    excluded: checks.filter(c => !c.included).map(c => ({ guild: c.guild, reason: c.reason })),
  };
  accessCache.set(user.id, { report, at: Date.now() });
  return report;
}

async function getDashboardGuilds(user) {
  return (await getDashboardGuildAccessReport(user)).included;
}

// Map user IDs to display names via the bot's (cached) user lookups
async function resolveUsernames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const users = await Promise.all(unique.map(id => client.users.fetch(id).catch(() => null)));
  const map = {};
  users.forEach(u => {
    if (u) map[u.id] = u.username + (u.discriminator && u.discriminator !== '0' ? '#' + u.discriminator : '');
  });
  return map;
}

function pickGuildId(req, manageableGuilds) {
  if (!manageableGuilds.length) return null;
  const requested = req.query.guild_id || req.body?.guild_id;
  if (requested && manageableGuilds.some(g => g.id === requested)) {
    return requested;
  }
  return manageableGuilds[0].id;
}

// Resolve the selected guild for an admin request (null if the user can't manage any)
async function getAuthorizedGuild(req) {
  const manageableGuilds = await getDashboardGuilds(req.user);
  return { manageableGuilds, guild_id: pickGuildId(req, manageableGuilds) };
}

// Middleware for changes: the posted guild_id must be one the user manages (no fallback to another server)
async function requireManagedGuild(req, res, next) {
  const manageableGuilds = await getDashboardGuilds(req.user);
  const requested = req.body?.guild_id || req.query.guild_id;
  if (!requested || !manageableGuilds.some(g => g.id === requested)) {
    return req.path.startsWith('/api/') ? res.status(403).json({ error: 'Forbidden' }) : res.status(403).send('Forbidden');
  }
  req.guildId = requested;
  next();
}

// Flash message shown once on the next dashboard load, then back to the dashboard
function done(req, res, type, message) {
  req.session.flash = { type, message };
  // Save before redirecting, or the next page load can race the (file-backed) session write
  req.session.save(() => res.redirect(`/?guild_id=${req.guildId}`));
}

// Re-render the Discord schedule message in the background after a change
function syncSchedule(guildId) {
  refreshScheduleMessage(guildId).catch(e => logDashboard(`Failed to refresh schedule message for ${guildId}: ${e.message}`));
}

const logStream = rfs.createStream('dashboard.log', {
  interval: '1d', // rotate daily
  path: path.join(__dirname, '..'),
  maxFiles: 14
});
function logDashboard(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  logStream.write(line);
}

app.get('/', ensureAuthenticated, async (req, res) => {
  const { manageableGuilds, guild_id } = await getAuthorizedGuild(req);
  if (!guild_id) {
    return res.status(403).send('You must be an admin for the selected Discord server to access this dashboard.');
  }
  // Get all scheduled and archived movies
  const [upcoming, archived, rsvps, latestAttendance] = await Promise.all([
    schedule.getUpcomingSchedule(guild_id),
    schedule.getArchivedEvents(guild_id),
    roles.getRSVPs(guild_id),
    roles.getLatestAttendance(guild_id),
  ]);
  // Regular event dates for the coming weeks, plus any special-event dates from the database
  const settings = getEventSettings(guild_id);
  const allDates = Array.from(new Set([
    ...upcomingEventDates(settings),
    ...upcoming.map(m => m.date).filter(Boolean),
  ])).sort();
  const { dashboardSchedule } = await buildScheduleMappings(upcoming);
  const attendance = latestAttendance.users;
  const userMap = await resolveUsernames([...upcoming.map(m => m.added_by), ...rsvps, ...attendance]);
  const dashboardByDate = Object.fromEntries(allDates.map(d => [d, []]));
  dashboardSchedule.forEach(m => { if (m.date) dashboardByDate[m.date].push(m); });
  // Exact start instant per date; the browser formats it in the viewer's own timezone
  const eventTimes = Object.fromEntries(allDates.map(d => {
    const start = eventStart(d, settings);
    return [d, { iso: start.toISO(), fallback: start.toFormat("cccc, LLLL d, yyyy '·' h:mm a ZZZZ") }];
  }));
  const nextStart = eventStart(upcomingEventDates(settings, 1)[0], settings);
  // Plex/Seerr/Radarr availability per scheduled movie (cached; null when no integrations)
  const availability = Object.fromEntries(await Promise.all(upcoming.map(async m =>
    [m.id, await integrations.getAvailability(guild_id, m).catch(() => null)])));
  const integrationView = await integrationsForView(req, guild_id);
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('dashboard', {
    dashboardByDate,
    allDates,
    archived,
    user: req.user,
    rsvps,
    attendance,
    attendanceDate: latestAttendance.date,
    eventWeekday: settings.weekday,
    eventTimes,
    eventWeekdayName: nextStart.toFormat('cccc'),
    // Recurring label, e.g. "Saturdays at 8:00 PM EST" (re-localized in the browser)
    eventTimeLabel: { iso: nextStart.toISO(), fallback: nextStart.toFormat("cccc's at' h:mm a ZZZZ") },
    today: todayStr(settings),
    userMap,
    botCommands: BOT_COMMANDS,
    guilds: manageableGuilds,
    selectedGuildId: guild_id,
    csrfToken: csrfToken(req),
    flash,
    availability,
    integrations: integrationView,
  });
  logDashboard(`Route: / by ${req.user?.id || 'unknown'}`);
});

// Integration settings for the template: never includes secrets, only whether they're saved
async function integrationsForView(req, guildId) {
  const i = await integrationStore.getIntegrations(guildId);
  const base = (process.env.DASHBOARD_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return {
    plex: { url: i.plex.url, hasToken: Boolean(i.plex.token), serverName: i.plex.serverName, connected: Boolean(i.plex.machineId) },
    seerr: { url: i.seerr.url, hasKey: Boolean(i.seerr.apiKey) },
    radarr: { url: i.radarr.url, hasKey: Boolean(i.radarr.apiKey), qualityProfileId: i.radarr.qualityProfileId, rootFolder: i.radarr.rootFolder },
    autoRequest: i.autoRequest,
    plexWebhooks: i.plexWebhooks,
    tautulliWebhooks: i.tautulliWebhooks,
    voteWhenEmpty: i.voteWhenEmpty,
    voteTheme: i.voteTheme,
    plexWebhookUrl: `${base}/webhooks/plex/${guildId}/${i.webhookToken}`,
    tautulliWebhookUrl: `${base}/webhooks/tautulli/${guildId}/${i.webhookToken}`,
    tautulliTemplate: playback.TAUTULLI_TEMPLATE,
    canRequest: integrationStore.isSeerrConfigured(i) || integrationStore.isRadarrConfigured(i),
  };
}

// Build the next config from the integrations form; blank secret fields keep the saved value.
// Returns { next, error }.
function integrationsFromForm(body, current) {
  const next = structuredClone(current);
  for (const [kind, secretField, secretKey] of [['plex', 'plex_token', 'token'], ['seerr', 'seerr_key', 'apiKey'], ['radarr', 'radarr_key', 'apiKey']]) {
    const { url, error } = normalizeBaseUrl(body[`${kind}_url`]);
    if (error) return { error: `${kind[0].toUpperCase()}${kind.slice(1)}: ${error}` };
    if (!url) {
      // Clearing the URL removes the integration (and its secret)
      next[kind] = { ...next[kind], url: '', [secretKey]: '' };
      continue;
    }
    if (url !== next[kind].url && kind === 'plex') next.plex.machineId = '';
    next[kind].url = url;
    const secret = String(body[secretField] || '').trim();
    if (secret) next[kind][secretKey] = secret;
  }
  if (body.radarr_profile !== undefined) next.radarr.qualityProfileId = body.radarr_profile ? Number(body.radarr_profile) : null;
  if (body.radarr_root !== undefined) next.radarr.rootFolder = String(body.radarr_root || '');
  next.autoRequest = body.auto_request === 'on';
  next.plexWebhooks = body.plex_webhooks === 'on';
  next.tautulliWebhooks = body.tautulli_webhooks === 'on';
  next.voteWhenEmpty = body.vote_when_empty === 'on';
  next.voteTheme = body.vote_theme === 'season' ? 'season' : 'month';
  return { next };
}

// Save integration settings (tests Plex to record its server identity for webhook verification)
app.post('/integrations', ensureAuthenticated, requireManagedGuild, async (req, res) => {
  const current = await integrationStore.getIntegrations(req.guildId);
  const { next, error } = integrationsFromForm(req.body, current);
  if (error) return done(req, res, 'error', error);
  const notes = [];
  if (integrationStore.isPlexConfigured(next) && !next.plex.machineId) {
    try {
      const info = await testPlex(req.guildId, next.plex);
      next.plex.machineId = info.machineId;
      next.plex.serverName = info.serverName;
    } catch (e) {
      notes.push(`Plex: ${e.message}`);
    }
  }
  if (integrationStore.isRadarrConfigured(next) && !integrationStore.isSeerrConfigured(next) && (!next.radarr.qualityProfileId || !next.radarr.rootFolder)) {
    notes.push('Radarr: use "Test" to pick a quality profile and root folder, or requests will fail.');
  }
  if (next.voteWhenEmpty && !integrationStore.isPlexConfigured(next)) notes.push('Movie vote: needs Plex set up to pick movies.');
  if (next.plexWebhooks && !integrationStore.isPlexConfigured(next)) notes.push('Plex webhooks: also set up the Plex server so events can be verified.');
  await integrationStore.saveIntegrations(req.guildId, next);
  logDashboard(`Integrations updated for ${req.guildId} by ${req.user.id}`);
  done(req, res, notes.length ? 'error' : 'ok', notes.length ? `Saved, but: ${notes.join(' ')}` : 'Integrations saved.');
});

// Test a connection using the form's current values (blank secret = saved one). JSON response.
app.post('/api/integrations/test', ensureAuthenticated, requireManagedGuild, async (req, res) => {
  const kind = req.body.kind;
  const testers = { plex: testPlex, seerr: testSeerr, radarr: testRadarr };
  if (!testers[kind]) return res.status(400).json({ ok: false, error: 'Unknown integration' });
  const { next, error } = integrationsFromForm(req.body, await integrationStore.getIntegrations(req.guildId));
  if (error) return res.json({ ok: false, error });
  const cfg = next[kind];
  if (!cfg.url) return res.json({ ok: false, error: 'Enter a URL first.' });
  if (!(cfg.token || cfg.apiKey)) return res.json({ ok: false, error: 'Enter the token / API key first.' });
  try {
    res.json({ ok: true, ...(await testers[kind](req.guildId, cfg)) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// New webhook secret (invalidates the old Plex/Tautulli URLs)
app.post('/integrations/regenerate-webhook', ensureAuthenticated, requireManagedGuild, async (req, res) => {
  const current = await integrationStore.getIntegrations(req.guildId);
  await integrationStore.saveIntegrations(req.guildId, { ...current, webhookToken: crypto.randomBytes(24).toString('hex') });
  logDashboard(`Webhook token regenerated for ${req.guildId} by ${req.user.id}`);
  done(req, res, 'ok', 'New webhook URLs generated. Update them in Plex/Tautulli.');
});

// Request a scheduled movie in Seerr/Radarr
app.post('/movies/:id/request', ensureAuthenticated, requireManagedGuild, async (req, res) => {
  const movie = await schedule.getScheduledMovie(req.params.id, req.guildId);
  if (!movie) return done(req, res, 'error', 'That movie is no longer on the schedule.');
  const result = await integrations.requestMovie(req.guildId, movie);
  done(req, res, result.ok ? 'ok' : 'error', result.message);
});

// TMDB search for the "Add a movie" form (JSON)
app.get('/api/search', ensureAuthenticated, requireManagedGuild, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : undefined;
  if (!q) return res.json({ results: [] });
  try {
    const results = (await tmdb.searchMovie(q, year)) || [];
    results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    res.json({
      results: results.slice(0, 10).map(m => ({
        id: m.id,
        title: m.title,
        year: m.release_date ? m.release_date.slice(0, 4) : '',
      })),
    });
  } catch (e) {
    res.status(502).json({ error: 'TMDB search failed' });
  }
});

// Add a movie by TMDB id (date optional: defaults to the next free regular date)
app.post('/movies', ensureAuthenticated, requireManagedGuild, async (req, res) => {
  const tmdbId = Number(req.body.tmdb_id);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return done(req, res, 'error', 'Pick a movie from the search results.');
  const date = String(req.body.date || '').trim();
  const dateError = date && validateEventDate(date, getEventSettings(req.guildId));
  if (dateError) return done(req, res, 'error', dateError);
  let details;
  try {
    details = await tmdb.getMovieDetails(tmdbId);
  } catch {
    return done(req, res, 'error', 'Couldn\'t load that movie from TMDB. Try again.');
  }
  const scheduleDate = date || await nextFreeEventDate(req.guildId);
  await schedule.addMovie({
    guild_id: req.guildId,
    title: details.title,
    tmdb_id: tmdbId,
    date: scheduleDate,
    added_by: req.user.id,
    release_date: details.release_date,
  });
  syncSchedule(req.guildId);
  logDashboard(`Added ${details.title} (${tmdbId}) on ${scheduleDate} by ${req.user.id}`);
  const status = await integrations.afterMovieAdded(req.guildId, { tmdb_id: tmdbId, title: details.title, release_date: details.release_date }).catch(() => '');
  done(req, res, 'ok', `Added ${details.title} on ${scheduleDate}.${status ? ' ' + status : ''}`);
});

// Move a scheduled movie to another date
app.post('/movies/:id/reschedule', ensureAuthenticated, requireManagedGuild, async (req, res) => {
  const movie = await schedule.getScheduledMovie(req.params.id, req.guildId);
  if (!movie) return done(req, res, 'error', 'That movie is no longer on the schedule.');
  const date = String(req.body.date || '').trim();
  const dateError = validateEventDate(date, getEventSettings(req.guildId));
  if (dateError) return done(req, res, 'error', dateError);
  if (date === movie.date) return done(req, res, 'ok', `${movie.title} is already on ${date}.`);
  await schedule.rescheduleMovie(movie.id, date, req.guildId);
  syncSchedule(req.guildId);
  logDashboard(`Rescheduled ${movie.id} from ${movie.date} to ${date} by ${req.user.id}`);
  done(req, res, 'ok', `Moved ${movie.title} to ${date}.`);
});

// Archive a scheduled movie (watched date: its scheduled date, or today if archived early)
app.post('/movies/:id/archive', ensureAuthenticated, requireManagedGuild, async (req, res) => {
  const movie = await schedule.getScheduledMovie(req.params.id, req.guildId);
  if (!movie) return done(req, res, 'error', 'That movie is no longer on the schedule.');
  const today = todayStr(getEventSettings(req.guildId));
  const archiveDate = movie.date && movie.date <= today ? movie.date : today;
  await schedule.archiveEvent(movie.id, archiveDate, req.guildId);
  syncSchedule(req.guildId);

  // Discord sync: post to the archive thread (creates it if needed)
  const guild = client.guilds.cache.get(req.guildId);
  if (guild) {
    resolveArchiveThread(guild, getGuildConfig(req.guildId))
      .then(thread => thread.send(`**${movie.title}** was watched on ${archiveDate}.`))
      .catch(e => logDashboard(`Failed to post archive message for ${movie.id}: ${e.message}`));
  }
  if (guild) clearWatchingIfArchived(guild, [movie.id]).catch(() => {});
  logDashboard(`Archived ${movie.id} to ${archiveDate} by ${req.user.id}`);
  done(req, res, 'ok', `Archived ${movie.title}.`);
});

// Delete a movie (scheduled or archived)
app.post('/movies/:id/delete', ensureAuthenticated, requireManagedGuild, async (req, res) => {
  await schedule.removeMovie(req.params.id, req.guildId);
  syncSchedule(req.guildId);
  logDashboard(`Deleted ${req.params.id} by ${req.user.id}`);
  done(req, res, 'ok', 'Deleted.');
});

// Error handler for uncaught errors in routes
app.use((err, req, res, next) => {
  logDashboard(`Error: ${err.message} (user: ${req.user?.id || 'unknown'})`);
  res.status(500).send('Internal server error.');
});

function startDashboard(discordClient, options = {}) {
  if (PLACEHOLDER_SECRETS.has(DASHBOARD_SECRET || '')) {
    throw new Error('DASHBOARD_SECRET is not set in .env. Set it to a long random string (e.g. `openssl rand -hex 32`).');
  }
  client = discordClient;
  if (options.refreshScheduleMessage) refreshScheduleMessage = options.refreshScheduleMessage;
  const PORT = process.env.DASHBOARD_PORT || 3000;
  return app.listen(PORT, () => {
    console.log(`Web dashboard running at http://localhost:${PORT}`);
    logDashboard('Dashboard started');
  });
}

module.exports = { startDashboard };

if (require.main === module) {
  console.error('The dashboard now runs inside the bot process. Start everything with: npm start (node src/index.js)');
  process.exit(1);
}
