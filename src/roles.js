// RSVP/attendance tracking, persisted per guild in SQLite
const { db, run, all } = require('./schedule');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS rsvps (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    guild_id TEXT NOT NULL,
    event_date TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, event_date, user_id)
  )`);
});

const addRSVP = (guild_id, user_id) =>
  run(`INSERT OR IGNORE INTO rsvps (guild_id, user_id) VALUES (?, ?)`, [guild_id, user_id]);

const removeRSVP = (guild_id, user_id) =>
  run(`DELETE FROM rsvps WHERE guild_id = ? AND user_id = ?`, [guild_id, user_id]);

const getRSVPs = async guild_id =>
  (await all(`SELECT user_id FROM rsvps WHERE guild_id = ?`, [guild_id])).map(r => r.user_id);

const addAttendance = (guild_id, event_date, user_id) =>
  run(`INSERT OR IGNORE INTO attendance (guild_id, event_date, user_id) VALUES (?, ?, ?)`, [guild_id, event_date, user_id]);

// Attendance for the most recent event that has any recorded: { date, users }
async function getLatestAttendance(guild_id) {
  const rows = await all(
    `SELECT event_date, user_id FROM attendance
     WHERE guild_id = ? AND event_date = (SELECT MAX(event_date) FROM attendance WHERE guild_id = ?)`,
    [guild_id, guild_id]
  );
  return { date: rows[0]?.event_date || null, users: rows.map(r => r.user_id) };
}

module.exports = {
  addRSVP,
  removeRSVP,
  getRSVPs,
  addAttendance,
  getLatestAttendance,
};
