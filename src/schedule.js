// schedule.js: Handles movie schedule storage and retrieval
const sqlite3 = require('sqlite3').verbose();
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
    status TEXT DEFAULT 'scheduled'
  )`);
});

function addMovie({ guild_id, title, tmdb_id, date, added_by }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO schedule (guild_id, title, tmdb_id, date, added_by) VALUES (?, ?, ?, ?, ?)`,
      [guild_id, title, tmdb_id, date, added_by],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function getUpcomingSchedule(guild_id) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM schedule WHERE guild_id = ? AND status = 'scheduled' ORDER BY date ASC`,
      [guild_id],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });
}

function archiveEvent(id, watched_date, guild_id) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE schedule SET status = 'archived', date = ? WHERE id = ? AND guild_id = ?`,
      [watched_date, id, guild_id],
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function removeMovie(id, guild_id) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM schedule WHERE id = ? AND guild_id = ?`,
      [id, guild_id],
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function rescheduleMovie(id, newDate, guild_id) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE schedule SET date = ? WHERE id = ? AND guild_id = ?`,
      [newDate, id, guild_id],
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function getArchivedEvents(guild_id) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM schedule WHERE guild_id = ? AND status = 'archived' ORDER BY date DESC`,
      [guild_id],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });
}

module.exports = {
  addMovie,
  getUpcomingSchedule,
  archiveEvent,
  removeMovie,
  rescheduleMovie,
  getArchivedEvents,
};
