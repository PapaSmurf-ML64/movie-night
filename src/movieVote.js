// "Nothing scheduled" fallback: 30 minutes before start, offer 5 themed movies from the server's Plex library and let
// members vote with buttons until start time. The winner is added to the schedule like any other movie.
const { DateTime } = require('luxon');
const { db, run, all } = require('./schedule');
const schedule = require('./schedule');
const tmdb = require('./tmdb');
const store = require('./integrations/store');
const { listPlexMovies } = require('./integrations/plex');
const { logBot } = require('./logger');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS movie_votes (
    guild_id TEXT NOT NULL,
    event_date TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    options TEXT NOT NULL,      -- JSON [{ title, year, tmdbId, genres, summary }]
    closes_at INTEGER NOT NULL, -- unix seconds
    theme TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    PRIMARY KEY (guild_id, event_date)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS movie_vote_ballots (
    guild_id TEXT NOT NULL,
    event_date TEXT NOT NULL,
    user_id TEXT NOT NULL,
    choice INTEGER NOT NULL,
    PRIMARY KEY (guild_id, event_date, user_id)
  )`);
});

const OPTION_COUNT = 5;
const RECENT_MONTHS = 12;
const BUTTON_PREFIX = 'mnvote';

// ---- Themes: Plex genres + words to look for in the title/summary ----
const MONTH_THEMES = {
  1: { name: 'New Year, new worlds', genres: ['Science Fiction', 'Adventure'], words: ['new year', 'future', 'space'] },
  2: { name: 'Valentine\'s month', genres: ['Romance'], words: ['valentine', 'love', 'romance', 'wedding'] },
  3: { name: 'Spring fantasy', genres: ['Fantasy', 'Animation'], words: ['magic', 'luck', 'irish', 'spring'] },
  4: { name: 'April laughs', genres: ['Comedy'], words: ['prank', 'fool', 'spring'] },
  5: { name: 'Blockbuster season', genres: ['Action', 'Adventure'], words: ['hero', 'mission'] },
  6: { name: 'Summer adventure', genres: ['Adventure', 'Family'], words: ['summer', 'beach', 'road trip'] },
  7: { name: 'Summer blockbusters', genres: ['Action', 'Science Fiction'], words: ['summer', 'independence', 'fireworks', 'alien'] },
  8: { name: 'Last days of summer', genres: ['Comedy', 'Adventure'], words: ['summer', 'camp', 'vacation', 'beach'] },
  9: { name: 'Back to school', genres: ['Drama', 'Mystery'], words: ['school', 'college', 'teacher', 'autumn', 'fall'] },
  10: { name: 'Halloween', genres: ['Horror', 'Thriller'], words: ['halloween', 'haunted', 'ghost', 'witch', 'vampire', 'zombie', 'monster', 'demon'] },
  11: { name: 'Thanksgiving & family', genres: ['Family', 'Drama'], words: ['thanksgiving', 'family', 'home', 'harvest', 'feast'] },
  12: { name: 'Holiday season', genres: ['Family'], words: ['christmas', 'santa', 'holiday', 'elf', 'snow', 'winter', 'reindeer', 'grinch'] },
};
const SEASON_THEMES = {
  winter: { name: 'Winter', genres: ['Family', 'Fantasy'], words: ['christmas', 'holiday', 'snow', 'winter', 'santa', 'ice', 'cold'] },
  spring: { name: 'Spring', genres: ['Romance', 'Comedy', 'Fantasy'], words: ['spring', 'love', 'garden', 'wedding'] },
  summer: { name: 'Summer', genres: ['Action', 'Adventure'], words: ['summer', 'beach', 'vacation', 'road trip', 'camp'] },
  fall: { name: 'Fall', genres: ['Horror', 'Thriller', 'Mystery'], words: ['halloween', 'haunted', 'ghost', 'autumn', 'fall', 'witch'] },
};
const SEASON_OF_MONTH = { 12: 'winter', 1: 'winter', 2: 'winter', 3: 'spring', 4: 'spring', 5: 'spring', 6: 'summer', 7: 'summer', 8: 'summer', 9: 'fall', 10: 'fall', 11: 'fall' };

function themeFor(date, mode) {
  const month = DateTime.fromISO(date).month;
  return mode === 'season' ? SEASON_THEMES[SEASON_OF_MONTH[month]] : MONTH_THEMES[month];
}

// Score how well a movie fits a theme: keyword hits weigh more than genre matches
function themeScore(movie, theme) {
  const text = `${movie.title} ${movie.summary}`.toLowerCase();
  const wordHits = theme.words.filter(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text)).length;
  const genreHits = movie.genres.filter(g => theme.genres.includes(g)).length;
  return wordHits * 2 + genreHits;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pick 5 movies from Plex: themed first (skipping ones watched in the last year), random fill if short
async function pickCandidates(guildId, date, mode) {
  const i = await store.getIntegrations(guildId);
  const library = await listPlexMovies(guildId, i.plex);
  const cutoff = DateTime.fromISO(date).minus({ months: RECENT_MONTHS }).toISODate();
  const recent = await all(`SELECT tmdb_id, title FROM schedule WHERE guild_id = ? AND status = 'archived' AND date >= ?`, [guildId, cutoff]);
  const recentIds = new Set(recent.map(r => String(r.tmdb_id)));
  const recentTitles = new Set(recent.map(r => r.title.toLowerCase()));
  const pool = library.filter(m => !recentIds.has(String(m.tmdbId)) && !recentTitles.has(m.title.toLowerCase()));

  const theme = themeFor(date, mode);
  const themed = shuffle(pool.map(m => ({ m, s: themeScore(m, theme) })).filter(x => x.s > 0))
    .sort((a, b) => b.s - a.s)
    // keep some variety: choose among the top 15 matches rather than always the same top 5
    .slice(0, OPTION_COUNT * 3);
  const picks = shuffle(themed).slice(0, OPTION_COUNT).map(x => x.m);
  const fill = shuffle(pool.filter(m => !picks.includes(m))).slice(0, OPTION_COUNT - picks.length);
  return { theme, options: [...picks, ...fill] };
}

// ---- Discord message rendering ----
function voteMessage(vote, counts, closed = false, winnerIdx = null) {
  const total = counts.reduce((a, b) => a + b, 0);
  const lines = vote.options.map((o, idx) => {
    const mark = closed && idx === winnerIdx ? '🏆 ' : `${idx + 1}. `;
    return `${mark}**${o.title}**${o.year ? ` (${o.year})` : ''} — ${counts[idx]} vote${counts[idx] === 1 ? '' : 's'}`;
  });
  const embed = {
    color: 0xFFD700,
    title: closed ? 'Voting closed' : `Tonight's vote${vote.theme ? `: ${vote.theme}` : ''}`,
    description: lines.join('\n'),
    footer: { text: closed ? `${total} vote${total === 1 ? '' : 's'} cast` : 'One vote each; click again to change it.' },
  };
  if (!closed) embed.fields = [{ name: 'Voting ends', value: `<t:${vote.closes_at}:R>`, inline: true }];
  const components = closed ? [] : [{
    type: 1,
    components: vote.options.map((o, idx) => ({
      type: 2, style: 1,
      custom_id: `${BUTTON_PREFIX}|${vote.event_date}|${idx}`,
      label: `${idx + 1}. ${o.title}`.slice(0, 80),
    })),
  }];
  return { embeds: [embed], components };
}

async function getVote(guildId, date) {
  const row = (await all(`SELECT * FROM movie_votes WHERE guild_id = ? AND event_date = ?`, [guildId, date]))[0];
  return row ? { ...row, options: JSON.parse(row.options) } : null;
}

async function tally(vote) {
  const rows = await all(`SELECT choice, COUNT(*) AS n FROM movie_vote_ballots WHERE guild_id = ? AND event_date = ? GROUP BY choice`, [vote.guild_id, vote.event_date]);
  const counts = vote.options.map(() => 0);
  rows.forEach(r => { if (counts[r.choice] !== undefined) counts[r.choice] = r.n; });
  return counts;
}

// Start a vote for `date` in `channel`. Returns true if posted (false if disabled/not enough movies).
async function startVote(guild, channel, date, closesAt, roleMention) {
  const i = await store.getIntegrations(guild.id);
  if (!i.voteWhenEmpty || !store.isPlexConfigured(i)) return false;
  if (await getVote(guild.id, date)) return true; // already started (e.g. before a restart)
  const { theme, options } = await pickCandidates(guild.id, date, i.voteTheme);
  if (options.length < 2) {
    logBot(`Movie vote skipped for guild ${guild.id}: fewer than 2 eligible Plex movies`);
    return false;
  }
  const stored = options.map(o => ({ title: o.title, year: o.year, tmdbId: o.tmdbId, genres: o.genres.slice(0, 3) }));
  const vote = { guild_id: guild.id, event_date: date, channel_id: channel.id, options: stored, closes_at: closesAt.toUnixInteger(), theme: theme.name };
  await run(`INSERT INTO movie_votes (guild_id, event_date, channel_id, options, closes_at, theme) VALUES (?, ?, ?, ?, ?, ?)`,
    [guild.id, date, channel.id, JSON.stringify(stored), vote.closes_at, theme.name]);
  const msg = await channel.send({
    content: `${roleMention} Nothing's on the schedule for tonight's movie night (starts <t:${vote.closes_at}:R>). Vote for what we watch!`,
    ...voteMessage(vote, stored.map(() => 0)),
  });
  await run(`UPDATE movie_votes SET message_id = ? WHERE guild_id = ? AND event_date = ?`, [msg.id, guild.id, date]);
  logBot(`Movie vote started for guild ${guild.id} on ${date}: ${stored.map(o => o.title).join(', ')}`);
  return true;
}

// Button click: record/replace the user's ballot and refresh the counts
async function handleVoteButton(interaction) {
  const [, date, idxStr] = interaction.customId.split('|');
  const vote = await getVote(interaction.guildId, date);
  const idx = Number(idxStr);
  if (!vote || vote.status !== 'open' || Date.now() / 1000 >= vote.closes_at) {
    await interaction.reply({ content: 'This vote has closed.', ephemeral: true });
    return;
  }
  if (!vote.options[idx]) return;
  await run(`INSERT INTO movie_vote_ballots (guild_id, event_date, user_id, choice) VALUES (?, ?, ?, ?)
             ON CONFLICT(guild_id, event_date, user_id) DO UPDATE SET choice = excluded.choice`,
  [vote.guild_id, date, interaction.user.id, idx]);
  await interaction.update(voteMessage(vote, await tally(vote)));
  await interaction.followUp({ content: `You voted for **${vote.options[idx].title}**.`, ephemeral: true });
}

// Close votes whose time has come: pick the winner, schedule it, announce it.
// Returns the closed votes' dates (so the caller can refresh the schedule message).
async function closeDueVotes(guild, roleMention) {
  const due = await all(`SELECT * FROM movie_votes WHERE guild_id = ? AND status = 'open' AND closes_at <= ?`, [guild.id, Math.floor(Date.now() / 1000)]);
  const closed = [];
  for (const row of due) {
    const vote = { ...row, options: JSON.parse(row.options) };
    await run(`UPDATE movie_votes SET status = 'closed' WHERE guild_id = ? AND event_date = ?`, [guild.id, vote.event_date]);
    const counts = await tally(vote);
    const best = Math.max(...counts);
    const tied = counts.map((c, idx) => (c === best ? idx : -1)).filter(idx => idx >= 0);
    const winnerIdx = tied[Math.floor(Math.random() * tied.length)];
    const winner = vote.options[winnerIdx];

    let tmdbId = winner.tmdbId;
    let releaseDate = winner.year ? `${winner.year}-01-01` : null;
    try {
      if (!tmdbId) tmdbId = (await tmdb.searchMovie(winner.title, winner.year))?.[0]?.id || null;
      if (tmdbId) releaseDate = (await tmdb.getMovieDetails(tmdbId)).release_date || releaseDate;
    } catch {}
    await schedule.addMovie({ guild_id: guild.id, title: winner.title, tmdb_id: tmdbId, date: vote.event_date, added_by: null, release_date: releaseDate });

    const how = best === 0 ? 'No votes were cast, so I picked at random.' : tied.length > 1 ? 'It was a tie, so I broke it at random.' : '';
    try {
      const channel = await guild.channels.fetch(vote.channel_id);
      if (vote.message_id) {
        const msg = await channel.messages.fetch(vote.message_id).catch(() => null);
        if (msg) await msg.edit(voteMessage(vote, counts, true, winnerIdx));
      }
      await channel.send(`${roleMention} The votes are in! Tonight's movie is **${winner.title}**${winner.year ? ` (${winner.year})` : ''}. ${how}`.trim());
    } catch (e) {
      logBot(`Failed to announce vote result for guild ${guild.id}: ${e.message}`);
    }
    logBot(`Movie vote closed for guild ${guild.id} on ${vote.event_date}: ${winner.title} (${counts.join('/')})`);
    closed.push(vote.event_date);
  }
  return closed;
}

module.exports = { startVote, handleVoteButton, closeDueVotes, BUTTON_PREFIX };
