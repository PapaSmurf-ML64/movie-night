// schedule.js: Handles movie schedule storage and retrieval
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, '../movie-schedule.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    tmdb_id INTEGER,
    date TEXT,
    added_by TEXT,
    status TEXT DEFAULT 'scheduled'
  )`);
});

function addMovie({ title, tmdb_id, date, added_by }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO schedule (title, tmdb_id, date, added_by) VALUES (?, ?, ?, ?)`,
      [title, tmdb_id, date, added_by],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function getUpcomingSchedule() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM schedule WHERE status = 'scheduled' ORDER BY date ASC`,
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });
}

function archiveEvent(id, watched_date) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE schedule SET status = 'archived', date = ? WHERE id = ?`,
      [watched_date, id],
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function removeMovie(id) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM schedule WHERE id = ?`,
      [id],
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function rescheduleMovie(id, newDate) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE schedule SET date = ? WHERE id = ?`,
      [newDate, id],
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function getArchivedEvents() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM schedule WHERE status = 'archived' ORDER BY date DESC`,
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
