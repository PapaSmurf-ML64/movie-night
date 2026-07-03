require('dotenv').config();
const express = require('express');
const path = require('path');
const schedule = require('./schedule');
const methodOverride = require('method-override');
const { buildScheduleMappings } = require('./scheduleUtils');
const roles = require('./roles');
const rfs = require('rotating-file-stream');
const { getGuildConfig } = require('./guildConfig');
const { resolveArchiveThread } = require('./archiveThread');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride('_method'));

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || 'changeme';
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

app.use(session({ 
  secret: DASHBOARD_SECRET, 
  resave: false, 
  saveUninitialized: false, 
  cookie: { 
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax',
    secure: false // Set to true if using HTTPS
  },
  store: new (require('session-file-store')(session))({ path: './.sessions', retries: 1 })
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: DISCORD_CLIENT_ID,
  clientSecret: DISCORD_CLIENT_SECRET,
  callbackURL: '/auth/discord/callback',
  scope: ['identify', 'guilds', 'guilds.members.read']
}, (accessToken, refreshToken, profile, done) => {
  process.nextTick(() => done(null, profile));
}));

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
  res.redirect('/');
});
app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// Only allow access to dashboard if user is an admin in the Discord server
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

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
  { name: '/seteventtime', description: 'Set the default event time format for this server.' },
  { name: '/reschedulemovie', description: 'Move a scheduled movie to a different date.' },
  { name: '/rsvp', description: 'RSVP for movie night and receive notifications.' },
  { name: '/unrsvp', description: 'Remove your RSVP/notification role for movie nights.' },
  { name: '/setschedulemsg', description: 'Pin schedule updates to a specific message ID in the schedule channel.' },
];

function hasAdminPermission(permissions) {
  try {
    return (BigInt(permissions || '0') & ADMIN_PERMISSION) === ADMIN_PERMISSION;
  } catch {
    return false;
  }
}

function hasManageGuildPermission(permissions) {
  try {
    return (BigInt(permissions || '0') & MANAGE_GUILD_PERMISSION) === MANAGE_GUILD_PERMISSION;
  } catch {
    return false;
  }
}

function getGuildsUserCanManage(user) {
  return Array.isArray(user?.guilds) ? user.guilds : [];
}

async function filterGuildsBotIsIn(guilds) {
  if (!Array.isArray(guilds) || guilds.length === 0) return [];
  if (!process.env.DISCORD_TOKEN) return [];

  const checks = await Promise.all(guilds.map(async guild => {
    try {
      const url = `https://discord.com/api/v10/guilds/${guild.id}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
      });
      return res.ok ? guild : null;
    } catch {
      return null;
    }
  }));

  return checks.filter(Boolean);
}

async function getDashboardGuilds(user) {
  const report = await getDashboardGuildAccessReport(user);
  return report.included;
}

async function getDashboardGuildAccessReport(user) {
  const userGuilds = getGuildsUserCanManage(user);
  const included = [];
  const excluded = [];

  if (!process.env.DISCORD_TOKEN) {
    return {
      included,
      excluded: userGuilds.map(g => ({ guild: g, reason: 'missing_bot_token' })),
    };
  }

  const checks = await Promise.all(userGuilds.map(async guild => {
    try {
      const guildUrl = `https://discord.com/api/v10/guilds/${guild.id}`;
      const guildRes = await fetch(guildUrl, {
        headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
      });
      if (!guildRes.ok) {
        return { guild, included: false, reason: 'bot_not_in_server' };
      }

      if (hasAdminPermission(guild.permissions) || hasManageGuildPermission(guild.permissions)) {
        return { guild, included: true };
      }

      const guildConfig = getGuildConfig(guild.id);
      if (!guildConfig.adminRoleId) {
        return { guild, included: false, reason: 'no_admin_permission_and_no_admin_role_configured' };
      }

      const memberUrl = `https://discord.com/api/v10/guilds/${guild.id}/members/${user.id}`;
      const memberRes = await fetch(memberUrl, {
        headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
      });
      if (!memberRes.ok) {
        return { guild, included: false, reason: 'member_lookup_failed' };
      }

      const memberData = await memberRes.json();
      if (!Array.isArray(memberData.roles)) {
        return { guild, included: false, reason: 'member_lookup_failed' };
      }

      if (memberData.roles.includes(guildConfig.adminRoleId)) {
        return { guild, included: true };
      }

      return { guild, included: false, reason: 'missing_configured_admin_role' };
    } catch {
      return { guild, included: false, reason: 'validation_error' };
    }
  }));

  checks.forEach(result => {
    if (result.included) {
      included.push(result.guild);
    } else {
      excluded.push({ guild: result.guild, reason: result.reason });
    }
  });

  return { included, excluded };
}

function pickGuildId(req, manageableGuilds) {
  if (!manageableGuilds.length) return null;
  const requested = req.query.guild_id || req.body?.guild_id;
  if (requested && manageableGuilds.some(g => g.id === requested)) {
    return requested;
  }
  return manageableGuilds[0].id;
}

async function isAdmin(user, guildId, availableGuilds) {
  if (!guildId) return false;
  const manageableGuilds = Array.isArray(availableGuilds) ? availableGuilds : await getDashboardGuilds(user);
  return manageableGuilds.some(g => g.id === guildId);
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
  const guildAccess = await getDashboardGuildAccessReport(req.user);
  const manageableGuilds = guildAccess.included;
  const guild_id = pickGuildId(req, manageableGuilds);
  if (!guild_id || !(await isAdmin(req.user, guild_id, manageableGuilds))) {
    return res.status(403).send('You must be an admin for the selected Discord server to access this dashboard.');
  }
  // Get all scheduled movies and build a map by date
  const upcoming = await schedule.getUpcomingSchedule(guild_id);
  // Find the next Saturday from today (skip today if after 8PM)
  const now = new Date();
  let nextSaturday = new Date(now);
  nextSaturday.setHours(20, 0, 0, 0); // 8PM
  const day = nextSaturday.getDay();
  if (!(day === 6 && now < nextSaturday)) {
    const daysUntilSaturday = (6 - day + 7) % 7 || 7;
    nextSaturday.setDate(nextSaturday.getDate() + daysUntilSaturday);
  }
  // Build a list of all Saturdays (8PM) until the end of the year
  const year = now.getFullYear();
  let saturdays = [];
  let d = new Date(nextSaturday);
  while (d.getFullYear() === year) {
    saturdays.push(new Date(d));
    d.setDate(d.getDate() + 7);
  }
  // Add all special event dates (non-Saturdays) from the database
  const allDatesSet = new Set(saturdays.map(date => date.toISOString().slice(0, 10)));
  upcoming.forEach(m => {
    if (m.date && !allDatesSet.has(m.date)) {
      allDatesSet.add(m.date);
    }
  });
  const allDates = Array.from(allDatesSet).sort();
  // Build movieByDate, addedByByDate, userMap
  const { userMap } = await buildScheduleMappings(upcoming, process.env.DISCORD_TOKEN);
  const mappings = await buildScheduleMappings(upcoming, process.env.DISCORD_TOKEN);
  const dashboardSchedule = mappings.dashboardSchedule;
  const archived = await schedule.getArchivedEvents(guild_id);
  // Fetch RSVP and attendance lists
  const rsvps = roles.getRSVPs ? roles.getRSVPs() : [];
  const attendance = roles.getAttendance ? roles.getAttendance() : [];
  // Build a mapping of date -> movies for dashboard (include unscheduled)
  const dashboardByDate = {};
  allDates.forEach(dateStr => {
    dashboardByDate[dateStr] = dashboardSchedule.filter(m => m.date === dateStr);
  });
  // Render the dashboard with the schedule data
  res.render('dashboard', {
    dashboardSchedule,
    dashboardByDate,
    allDates,
    archived,
    user: req.user,
    rsvps,
    attendance,
    userMap,
    upcoming,
    botCommands: BOT_COMMANDS,
    guilds: manageableGuilds,
    selectedGuildId: guild_id,
  });
  logDashboard(`Route: / by ${req.user?.id || 'unknown'}`);
});

// Delete an archived event
app.post('/delete-archived/:id', ensureAuthenticated, async (req, res) => {
  const manageableGuilds = await getDashboardGuilds(req.user);
  const guild_id = pickGuildId(req, manageableGuilds);
  if (!guild_id || !(await isAdmin(req.user, guild_id, manageableGuilds))) return res.status(403).send('Forbidden');
  const id = req.params.id;
  await schedule.removeMovie(id, guild_id);
  res.redirect(`/?guild_id=${guild_id}`);
  logDashboard(`Deleted archived event ${id} by ${req.user.id}`);
});

// Add a route to handle /delete-archived with no id (show error)
app.post('/delete-archived', ensureAuthenticated, (req, res) => {
  logDashboard(`Attempted delete-archived with no ID by ${req.user?.id || 'unknown'}`);
  res.status(400).send('Missing archived event ID.');
});

// Archive a movie (set status to archived and set date to next available Saturday, and sync with Discord)
app.post('/archive/:id', ensureAuthenticated, async (req, res) => {
  const manageableGuilds = await getDashboardGuilds(req.user);
  const guild_id = pickGuildId(req, manageableGuilds);
  if (!guild_id || !(await isAdmin(req.user, guild_id, manageableGuilds))) return res.status(403).send('Forbidden');
  const id = req.params.id;
  // Find the movie info
  const upcoming = await schedule.getUpcomingSchedule(guild_id);
  const movie = upcoming.find(m => m.id == id);
  if (!movie) return res.status(404).send('Movie not found');
  // Calculate next available Saturday at 8PM EST (sync with bot logic)
  const now = new Date();
  let nextSaturday = new Date(now);
  nextSaturday.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7));
  nextSaturday.setHours(20, 0, 0, 0); // 8PM
  // If this movie is not the first, add weeks
  const index = upcoming.findIndex(m => m.id == id);
  if (index > 0) {
    nextSaturday.setDate(nextSaturday.getDate() + (index * 7));
  }
  const archiveDate = nextSaturday.toISOString().slice(0, 10);
  await schedule.archiveEvent(id, archiveDate, guild_id);

  // Discord sync: post to archive thread
  try {
    const { Client, GatewayIntentBits } = require('discord.js');
    const client = require('./bot').client || global._dashboardBotClient;
    const guildConfig = getGuildConfig(guild_id);
    if (client && client.isReady()) {
      const guild = await client.guilds.fetch(guild_id);
      const thread = await resolveArchiveThread(guild, guildConfig);
      await thread.send(`**${movie.title}** was watched on ${archiveDate}.`);
    }
  } catch (e) {
    // Ignore Discord sync errors for dashboard
  }
  res.redirect(`/?guild_id=${guild_id}`);
  logDashboard(`Archived event ${id} to ${archiveDate} by ${req.user.id}`);
});

// Error handler for uncaught errors in routes
app.use((err, req, res, next) => {
  logDashboard(`Error: ${err.message} (user: ${req.user?.id || 'unknown'})`);
  res.status(500).send('Internal server error.');
});

// TODO: Add routes for add/remove/reschedule/config

const PORT = process.env.DASHBOARD_PORT || 3000;
app.listen(PORT, () => {
  console.log(`Web dashboard running at http://localhost:${PORT}`);
  logDashboard('Dashboard started');
});
