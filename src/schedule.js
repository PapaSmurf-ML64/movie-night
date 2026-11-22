// schedule.js: Handles movie schedule storage and retrieval
const sqlite3 = require('sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, '../movie-schedule.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    title TEXT NOT NULL,
    tmdb_id INTEGER,
    date TEXT,
    added_by TEXT,
    status TEXT DEFAULT 'scheduled',
    release_date TEXT
  )`);
  // Every query filters by guild + status and sorts by date
  db.run(`CREATE INDEX IF NOT EXISTS idx_schedule_guild_status_date ON schedule (guild_id, status, date)`);
  // Once-per-event actions already performed (pre-event ping, voice auto-join)
  db.run(`CREATE TABLE IF NOT EXISTS event_flags (
    guild_id TEXT NOT NULL,
    event_date TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (guild_id, event_date, kind)
  )`);
});

const run = (sql, params) => new Promise((resolve, reject) =>
  db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
const all = (sql, params) => new Promise((resolve, reject) =>
  db.all(sql, params, (err, rows) => { err ? reject(err) : resolve(rows); }));

async function addMovie({ guild_id, title, tmdb_id, date, added_by, release_date }) {
  const res = await run(
    `INSERT INTO schedule (guild_id, title, tmdb_id, date, added_by, release_date) VALUES (?, ?, ?, ?, ?, ?)`,
    [guild_id, title, tmdb_id, date, added_by, release_date]
  );
  return res.lastID;
}

const getUpcomingSchedule = guild_id =>
  all(`SELECT * FROM schedule WHERE guild_id = ? AND status = 'scheduled' ORDER BY date ASC`, [guild_id]);

const getArchivedEvents = guild_id =>
  all(`SELECT * FROM schedule WHERE guild_id = ? AND status = 'archived' ORDER BY date DESC`, [guild_id]);

const archiveEvent = (id, watched_date, guild_id) =>
  run(`UPDATE schedule SET status = 'archived', date = ? WHERE id = ? AND guild_id = ?`, [watched_date, id, guild_id]).then(() => {});

const removeMovie = (id, guild_id) =>
  run(`DELETE FROM schedule WHERE id = ? AND guild_id = ?`, [id, guild_id]).then(() => {});

const rescheduleMovie = (id, newDate, guild_id) =>
  run(`UPDATE schedule SET date = ? WHERE id = ? AND guild_id = ?`, [newDate, id, guild_id]).then(() => {});

// True if the guild has any event (scheduled or already archived) on the given date
const hasEventOn = async (guild_id, date) =>
  (await all(`SELECT 1 FROM schedule WHERE guild_id = ? AND date = ? LIMIT 1`, [guild_id, date])).length > 0;

const hasEventFlag = async (guild_id, date, kind) =>
  (await all(`SELECT 1 FROM event_flags WHERE guild_id = ? AND event_date = ? AND kind = ?`, [guild_id, date, kind])).length > 0;

const setEventFlag = (guild_id, date, kind) =>
  run(`INSERT OR IGNORE INTO event_flags (guild_id, event_date, kind) VALUES (?, ?, ?)`, [guild_id, date, kind]);

// Look up one scheduled (not archived) movie by id within a guild
const getScheduledMovie = async (id, guild_id) =>
  (await all(`SELECT * FROM schedule WHERE id = ? AND guild_id = ? AND status = 'scheduled'`, [id, guild_id]))[0] || null;

module.exports = {
  db,
  hasEventFlag,
  setEventFlag,
  getScheduledMovie,
  hasEventOn,
  run,
  all,
  addMovie,
  getUpcomingSchedule,
  archiveEvent,
  removeMovie,
  rescheduleMovie,
  getArchivedEvents,
};
