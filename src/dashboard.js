require('dotenv').config();
const express = require('express');
const path = require('path');
const schedule = require('./schedule');
const methodOverride = require('method-override');

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
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
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
const ADMIN_GUILD_ID = process.env.ADMIN_GUILD_ID;
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID;

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function isAdmin(user) {
  // Use Discord API to check if user has admin role in the configured guild
  if (!ADMIN_GUILD_ID || !ADMIN_ROLE_ID) return false;
  if (!process.env.DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN is missing in .env');
    return false;
  }
  const url = `https://discord.com/api/v10/guilds/${ADMIN_GUILD_ID}/members/${user.id}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
  });
  if (!res.ok) {
    console.error('Failed to fetch member info from Discord API:', await res.text());
    return false;
  }
  const data = await res.json();
  if (!data.roles) {
    console.error('No roles found for user:', data);
    return false;
  }
  return data.roles.includes(ADMIN_ROLE_ID);
}

app.get('/', ensureAuthenticated, async (req, res) => {
  if (!(await isAdmin(req.user))) {
    return res.status(403).send('You must be a Discord server admin to access this dashboard.');
  }
  // Get all scheduled movies and build a map by date
  const upcoming = await schedule.getUpcomingSchedule();
  // Find the next Saturday from today (skip today if after 8PM)
  const now = new Date();
  let nextSaturday = new Date(now);
  nextSaturday.setHours(20, 0, 0, 0); // 8PM
  const day = nextSaturday.getDay();
  if (day === 6 && now < nextSaturday) {
    // Today is Saturday and before 8PM, use today
  } else {
    // Otherwise, find the next Saturday
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
  // Build dashboard schedule list to match Discord
  // Support multiple movies per date (double feature)
  const movieByDate = {};
  const addedByByDate = {};
  upcoming.forEach(m => {
    if (m.date) {
      if (!movieByDate[m.date]) movieByDate[m.date] = [];
      if (!addedByByDate[m.date]) addedByByDate[m.date] = [];
      movieByDate[m.date].push(m.title);
      addedByByDate[m.date].push(m.added_by || '');
    }
  });
  const dashboardSchedule = saturdays.map(date => {
    const dateStr = date.toISOString().slice(0, 10);
    const titles = movieByDate[dateStr] ? movieByDate[dateStr].join(', ') : '<empty>';
    const addedBys = addedByByDate[dateStr] ? addedByByDate[dateStr].join(', ') : '';
    return {
      date: dateStr,
      title: titles,
      added_by: addedBys
    };
  });
  const archived = await schedule.getArchivedEvents();
  // Get RSVP and attendance from bot
  let rsvps = [];
  let attendance = [];
  let userMap = {};
  try {
    const bot = require('./bot');
    rsvps = bot.getRSVPs ? bot.getRSVPs() : [];
    attendance = bot.getAttendance ? bot.getAttendance() : [];
    // Fetch usernames for RSVP/attendance lists
    if (rsvps.length > 0 || attendance.length > 0) {
      const userIds = Array.from(new Set([...rsvps, ...attendance]));
      const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
      const promises = userIds.map(async id => {
        try {
          const res = await fetch(`https://discord.com/api/v10/users/${id}`, {
            headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
          });
          if (!res.ok) return null;
          const data = await res.json();
          return { id, username: data.username + (data.discriminator && data.discriminator !== '0' ? '#' + data.discriminator : '') };
        } catch {
          return null;
        }
      });
      const results = await Promise.all(promises);
      results.forEach(u => { if (u) userMap[u.id] = u.username; });
    }
  } catch {}
  res.render('dashboard', { dashboardSchedule, archived, user: req.user, rsvps, attendance, userMap });
});

// Delete an archived event
app.post('/delete-archived/:id', ensureAuthenticated, async (req, res) => {
  if (!(await isAdmin(req.user))) return res.status(403).send('Forbidden');
  const id = req.params.id;
  await schedule.removeMovie(id);
  res.redirect('/');
});

// Archive a movie (set status to archived and set date to next available Saturday, and sync with Discord)
app.post('/archive/:id', ensureAuthenticated, async (req, res) => {
  if (!(await isAdmin(req.user))) return res.status(403).send('Forbidden');
  const id = req.params.id;
  // Find the movie info
  const upcoming = await schedule.getUpcomingSchedule();
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
  await schedule.archiveEvent(id, archiveDate);

  // Discord sync: post to archive thread
  try {
    const { Client, GatewayIntentBits, ChannelType, ThreadAutoArchiveDuration } = require('discord.js');
    const client = require('./bot').client || global._dashboardBotClient;
    if (client && client.isReady()) {
      const guild = await client.guilds.fetch(process.env.ADMIN_GUILD_ID);
      let channel = guild.channels.cache.get(process.env.DEFAULT_SCHEDULE_CHANNEL_ID);
      if (!channel) channel = await guild.channels.fetch(process.env.DEFAULT_SCHEDULE_CHANNEL_ID);
      // Get or create archive thread (reuse bot logic)
      const threadName = 'Archived Events';
      let thread = channel.threads.cache.find(t => t.name === threadName && t.type === ChannelType.PublicThread);
      if (!thread) {
        thread = await channel.threads.create({
          name: threadName,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          reason: 'Archive completed movie events',
        });
      }
      await thread.send(`**${movie.title}** was watched on ${archiveDate}.`);
    }
  } catch (e) {
    // Ignore Discord sync errors for dashboard
  }
  res.redirect('/');
});

// TODO: Add routes for add/remove/reschedule/config

const PORT = process.env.DASHBOARD_PORT || 3000;
app.listen(PORT, () => {
  console.log(`Web dashboard running at http://localhost:${PORT}`);
});
