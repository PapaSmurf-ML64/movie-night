// All slash command and interaction handlers
const schedule = require('./schedule');
const tmdb = require('./tmdb');
const media = require('./media');
const { postOrUpdateSchedule, saveScheduleMessageId } = require('./scheduleEmbed');
const { joinConfiguredVoiceChannel } = require('./voice');
const { autoDelete } = require('./util');
const { logBot } = require('./logger');

// At the top, add a map to track pending movie selections
const pendingSelections = new Map();
// At the top, add a map to track pending movie add sessions by user
const pendingAddMovieSessions = new Map();

// Export a function to register all handlers
function registerHandlers(client, config, DEFAULT_VOICE_CHANNEL_ID, DEFAULT_EVENT_TIME) {
  // Helper: send the Movie Night ping message (used by both scheduleRolePing and !testping)
  async function sendMovieNightPing(channel, role, movies, source = '') {
    // Always use the Moviegoers role for pings
    let moviegoersRole = channel.guild.roles.cache.find(r => r.name === 'Moviegoers');
    if (!moviegoersRole) {
      await channel.guild.roles.fetch();
      moviegoersRole = channel.guild.roles.cache.find(r => r.name === 'Moviegoers');
    }
    const roleMention = moviegoersRole ? `<@&${moviegoersRole.id}>` : '@everyone';
    if (!Array.isArray(movies)) movies = movies ? [movies] : [];
    if (movies.length === 0) {
      const sentMsg = await channel.send(`Hello ${roleMention}! Movie night is starting in 5 minutes!`);
      setTimeout(() => { sentMsg.delete().catch(() => {}); }, 60 * 60 * 1000); // 1 hour
      return;
    }
    const header = `Hello ${roleMention}! Movie night is starting in 5 minutes and on the schedule for tonight is:`;
    let sentMsg;
    let first = true;
    for (const movie of movies) {
      let embed = null;
      if (movie && movie.tmdb_id) {
        try {
          const tmdbData = await tmdb.getMovieDetails(movie.tmdb_id);
          embed = {
            color: 0xFFD700,
            title: `${tmdbData.title} (${tmdbData.release_date ? tmdbData.release_date.slice(0,4) : ''})`,
            description: tmdbData.overview || '',
            fields: [
              { name: 'Genres', value: tmdbData.genres && tmdbData.genres.length ? tmdbData.genres.map(g => g.name).join(', ') : 'N/A', inline: true },
              { name: 'User Rating', value: tmdbData.vote_average ? `${tmdbData.vote_average}/10` : 'N/A', inline: true }
            ]
            // footer removed
          };
        } catch {}
      }
      if (first) {
        sentMsg = await channel.send({ content: header, embeds: embed ? [embed] : [] });
        setTimeout(() => { sentMsg.delete().catch(() => {}); }, 60 * 60 * 1000); // 1 hour
        first = false;
      } else if (embed) {
        sentMsg = await channel.send({ embeds: [embed] });
        setTimeout(() => { sentMsg.delete().catch(() => {}); }, 60 * 60 * 1000); // 1 hour
      }
    }
  }

  // Helper: auto-delete a message after 5 minutes (unless it's the schedule message)
  // (autoDelete is imported)

  // Ping Movie Night role 5 minutes before the event
  async function scheduleRolePing() {
    if (global._testPingActive) return; // Prevent scheduled ping if test is active
    const guild = client.guilds.cache.get(process.env.ADMIN_GUILD_ID);
    if (!guild) return;
    let role = guild.roles.cache.find(r => r.name === 'Movie Night');
    if (!role) return;
    let channel = guild.channels.cache.get(config.scheduleChannelId);
    if (!channel) channel = await guild.channels.fetch(config.scheduleChannelId);
    // Find the next event time (next Saturday 8PM EST)
    const now = new Date();
    let nextSaturday = new Date(now);
    nextSaturday.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7));
    nextSaturday.setHours(20, 0, 0, 0); // 8PM
    // Fetch all scheduled movies for that date (double feature support)
    const movies = (await schedule.getUpcomingSchedule(guild.id)).filter(m => m.date === nextSaturday.toISOString().slice(0, 10));
    // ...existing code...
  }

  client.once('ready', async () => {
    scheduleRolePing();
  });

  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (message.content.trim().toLowerCase() === '!testping') {
      const adminRoleId = process.env.ADMIN_ROLE_ID;
      const isAdmin = message.member.roles && (message.member.roles.cache.has(adminRoleId) || message.member.permissions.has('Administrator'));
      if (!isAdmin) {
        const replyMsg = await message.reply('Only administrators can use this command.');
        autoDelete(replyMsg);
        return;
      }
      const guild = message.guild;
      let role = guild.roles.cache.find(r => r.name === 'Movie Night');
      if (!role) {
        const replyMsg = await message.reply('Movie Night role not found.');
        autoDelete(replyMsg);
        return;
      }
      let channel = message.channel;
      // Find the next event time (next Saturday 8PM EST)
      const now = new Date();
      let nextSaturday = new Date(now);
      nextSaturday.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7));
      nextSaturday.setHours(20, 0, 0, 0); // 8PM
      // Fetch all scheduled movies for that date (double feature support)
      const movies = (await schedule.getUpcomingSchedule(guild.id)).filter(m => m.date === nextSaturday.toISOString().slice(0, 10));
      global._testPingActive = true;
      await sendMovieNightPing(channel, role, movies, '!testping');
      setTimeout(() => { global._testPingActive = false; }, 10000); // Reset after 10s
    }
  });

  client.on('interactionCreate', async interaction => {
    console.log('[DEBUG] Received interaction:', interaction.commandName);
    // Log all interactions
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      const userId = interaction.user?.id || 'unknown';
      const guildId = interaction.guild?.id || 'unknown';
      logBot(`Command: ${commandName} by ${userId} in guild ${guildId}`);
    }
    // Handle select menu for movie selection globally
    if (interaction.isSelectMenu() && interaction.customId.startsWith('select_movie_')) {
      const key = `${interaction.user.id}_${interaction.customId}`;
      const pending = pendingSelections.get(key);
      if (pending) {
        const session = pendingAddMovieSessions.get(pending.sessionKey);
        if (!session) {
          await interaction.update({ content: 'This selection is no longer valid or has timed out.', components: [] });
          pendingSelections.delete(key);
          return;
        }
        const idx = parseInt(interaction.values[0], 10);
        const selected = pending.results[idx];
        session.selectedMovies.push(selected);
        session.pendingTitleIdx = pending.selectIdx + 1;
        pendingSelections.delete(key);
        await interaction.update({ content: `Selected: ${selected.title} (${selected.release_date ? selected.release_date.slice(0,4) : 'N/A'})`, components: [] });
        await session.handleNextTitle();
        logBot(`SelectMenu: User ${interaction.user.id} selected movie for session ${pending.sessionKey}`);
        return;
      } else {
        logBot(`SelectMenu: Invalid or expired selection by user ${interaction.user.id}`);
        await interaction.reply({ content: 'This selection is no longer valid or has timed out.', ephemeral: true });
        setTimeout(() => { interaction.deleteReply?.().catch(() => {}); }, 10000);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;
    const guild_id = interaction.guild?.id;
    const adminRoleId = process.env.ADMIN_ROLE_ID;
    const isAdmin = interaction.member.roles && (interaction.member.roles.cache.has(adminRoleId) || interaction.member.permissions.has('Administrator'));
    if (commandName === 'refreshschedule') {
      if (!isAdmin) {
        const replyMsg = await interaction.reply('Only administrators can refresh the schedule.');
        autoDelete(replyMsg);
        return;
      }
      let channel = interaction.channel;
      if (config.scheduleChannelId) {
        try {
          channel = await interaction.guild.channels.fetch(config.scheduleChannelId);
        } catch (err) {
          console.error('[refreshschedule] Failed to fetch schedule channel:', err);
          await interaction.reply({ content: 'Failed to fetch schedule channel. ' + (err.message || err), ephemeral: true });
          return;
        }
      }
      try {
        let msg = await postOrUpdateSchedule(channel, guild_id);
        if (!msg) {
          // If no valid message, post a new embed
          const movies = await schedule.getUpcomingSchedule(guild_id);
          const movieByDate = {};
          movies.forEach(m => {
            if (m.date) {
              if (!movieByDate[m.date]) movieByDate[m.date] = [];
              movieByDate[m.date].push(m.title);
            }
          });
          // Find the next Saturday from today (skip today if after 8PM)
          const now = new Date();
          let nextSaturday = new Date(now);
          nextSaturday.setHours(20, 0, 0, 0); // 8PM
          const day = nextSaturday.getDay();
          if (day === 6 && now < nextSaturday) {
            // Today is Saturday and before 8PM, use today
          } else {
            const daysUntilSaturday = (6 - day + 7) % 7 || 7;
            nextSaturday.setDate(nextSaturday.getDate() + daysUntilSaturday);
          }
          const year = now.getFullYear();
          let saturdays = [];
          let d = new Date(nextSaturday);
          while (d.getFullYear() === year && saturdays.length < 25) {
            saturdays.push(new Date(d));
            d.setDate(d.getDate() + 7);
          }
          const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
          const fields = saturdays.map(date => {
            const dateStr = date.toISOString().slice(0, 10);
            const month = months[date.getMonth()];
            const day = date.getDate();
            const time = "8:00 PM";
            const formatted = `${month} ${day}, ${time}`;
            const titles = movieByDate[dateStr] ? movieByDate[dateStr].join(', ') : '<empty>';
            return { name: formatted, value: titles, inline: true };
          });
          const embed = {
            color: 0xFFD700,
            title: `Upcoming Movie Nights`,
            description: `Here is the upcoming schedule. All times are 8:00 PM.`,
            fields: fields,
            footer: { text: `Schedule through ${year}` }
          };
          try {
            const newMsg = await channel.send({ embeds: [embed] });
            saveScheduleMessageId(newMsg.id);
            const replyMsg = await interaction.reply('Schedule refreshed and new embed posted.');
            autoDelete(replyMsg);
          } catch (err2) {
            console.error('[refreshschedule] Failed to post new schedule embed:', err2);
            const replyMsg = await interaction.reply('Failed to post new schedule embed. ' + (err2.message || err2));
            autoDelete(replyMsg);
          }
        } else {
          saveScheduleMessageId(msg.id);
          const replyMsg = await interaction.reply('Schedule refreshed.');
          autoDelete(replyMsg);
        }
        logBot(`Schedule refreshed by ${interaction.user.id} in guild ${guild_id}`);
      } catch (err) {
        console.error('[refreshschedule] Error refreshing schedule:', err);
        logBot(`Error in refreshschedule by ${interaction.user.id}: ${err.message}`);
        try {
          const replyMsg = await interaction.reply('Failed to refresh schedule. ' + (err.message || err));
          autoDelete(replyMsg);
        } catch (e) {
          // If reply fails, log
          console.error('[refreshschedule] Failed to reply to interaction:', e);
        }
      }
      return;
    }
    if (commandName === 'setchannel') {
      if (!isAdmin) {
        const replyMsg = await interaction.reply('Only administrators can set the schedule channel.');
        autoDelete(replyMsg);
        return;
      }
      const channel = interaction.options.getChannel('channel');
      if (!channel) {
        await interaction.reply({ content: 'Invalid channel.', ephemeral: true });
        return;
      }
      config.scheduleChannelId = channel.id;
      await interaction.reply(`Schedule channel set to <#${channel.id}>.`);
      logBot(`Schedule channel set to ${channel.id} by ${interaction.user.id} in guild ${guild_id}`);
      autoDelete(sentMsg);
      return;
    }
    if (commandName === 'seteventtime') {
      if (!isAdmin) {
        const replyMsg = await interaction.reply('Only administrators can set the event time.');
        autoDelete(replyMsg);
        return;
      }
      const time = interaction.options.getString('time');
      if (!time) {
        await interaction.reply({ content: 'You must provide a time (e.g., Saturday 20:00).', ephemeral: true });
        return;
      }
      config.eventTime = time;
      await interaction.reply(`Event time set to ${time}.`);
      logBot(`Event time set to ${time} by ${interaction.user.id} in guild ${guild_id}`);
      autoDelete(sentMsg);
      return;
    }
    if (commandName === 'setschedulemsg') {
      if (!isAdmin) {
        const replyMsg = await interaction.reply('Only administrators can set the schedule message.');
        autoDelete(replyMsg);
        return;
      }
      const msgId = interaction.options.getString('messageid');
      // Save the new schedule message ID and update in-memory variable
      const { saveScheduleMessageId, setScheduleMessageId } = require('./scheduleEmbed');
      saveScheduleMessageId(msgId);
      setScheduleMessageId(msgId);
      // Reply immediately to avoid Discord timeout
      await interaction.reply(`Schedule message ID set to ${msgId}.`);
      logBot(`Schedule message ID set to ${msgId} by ${interaction.user.id} in guild ${guild_id}`);
      autoDelete(sentMsg);
      // Update the message in the background
      (async () => {
        try {
          let updateChannel = interaction.channel;
          if (config.scheduleChannelId) {
            updateChannel = await interaction.guild.channels.fetch(config.scheduleChannelId);
          }
          const { postOrUpdateSchedule } = require('./scheduleEmbed');
          await postOrUpdateSchedule(updateChannel);
        } catch (err) {
          console.error('[setschedulemsg] Failed to update schedule message after setting ID:', err);
        }
      })();
      return;
    }
    // ...existing or future command handlers...
    if (commandName === 'addmovie') {
      await interaction.deferReply({ ephemeral: false });
      const title = interaction.options.getString('title');
      const date = interaction.options.getString('date');
      const doubleFeature = interaction.options.getBoolean('doublefeature');
      const year = interaction.options.getInteger ? interaction.options.getInteger('year') : undefined;
      if (!title) {
        const replyMsg = await interaction.editReply('You must provide a movie title.');
        setTimeout(() => { replyMsg.delete?.().catch(() => {}); }, 10000);
        return;
      }
      try {
        const titles = doubleFeature ? title.split(',').map(t => t.trim()).filter(Boolean) : [title.trim()];
        // Create a session object for this addmovie interaction
        const sessionKey = `${interaction.user.id}_${interaction.id}`;
        const session = {
          interaction,
          titles,
          selectedMovies: [],
          pendingTitleIdx: 0,
          date,
          guild_id,
          year,
          async handleNextTitle() {
            if (this.pendingTitleIdx >= this.titles.length) {
              // All movies selected, proceed to add
              let scheduleDate = this.date;
              if (!scheduleDate) {
                const now = new Date();
                let nextSaturday = new Date(now);
                nextSaturday.setHours(20, 0, 0, 0);
                const day = nextSaturday.getDay();
                if (!(day === 6 && now < nextSaturday)) {
                  const daysUntilSaturday = (6 - day + 7) % 7 || 7;
                  nextSaturday.setDate(nextSaturday.getDate() + daysUntilSaturday);
                }
                const upcoming = await schedule.getUpcomingSchedule(this.guild_id);
                const takenDates = new Set(upcoming.map(m => m.date));
                let d = new Date(nextSaturday);
                while (takenDates.has(d.toISOString().slice(0, 10))) {
                  d.setDate(d.getDate() + 7);
                }
                scheduleDate = d.toISOString().slice(0, 10);
              }
              const addedIds = [];
              for (let i = 0; i < this.selectedMovies.length; i++) {
                let m = this.selectedMovies[i];
                if (!m.release_date && m.id) {
                  try {
                    const details = await tmdb.getMovieDetails(m.id);
                    m.release_date = details.release_date;
                  } catch {}
                }
                const id = await schedule.addMovie({
                  guild_id: this.guild_id,
                  title: m.title,
                  tmdb_id: m.id,
                  date: scheduleDate,
                  added_by: this.interaction.user.id,
                  release_date: m.release_date
                });
                addedIds.push(id);
              }
              const replyMsg = await this.interaction.editReply(`Movie(s) added to the schedule for ${scheduleDate}.`);
              setTimeout(() => { replyMsg.delete?.().catch(() => {}); }, 10000);
              let channel = this.interaction.channel;
              if (config.scheduleChannelId) {
                try {
                  channel = await this.interaction.guild.channels.fetch(config.scheduleChannelId);
                } catch {}
              }
              await postOrUpdateSchedule(channel, this.guild_id);
              pendingAddMovieSessions.delete(sessionKey);
              logBot(`Schedule updated for guild ${this.guild_id}`);
              return;
            }
            // Handle the next title
            const t = this.titles[this.pendingTitleIdx];
            const results = await tmdb.searchMovie(t, this.year);
            if (!results || results.length === 0) throw new Error(`No TMDB match for "${t}"${this.year ? ` (${this.year})` : ''}`);
            results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
            if (results.length === 1) {
              this.selectedMovies.push(results[0]);
              this.pendingTitleIdx++;
              await this.handleNextTitle();
            } else {
              const selectId = `select_movie_${interaction.id}_${this.pendingTitleIdx}`;
              const options = results.slice(0, 25).map((m, i) => ({
                label: `${m.title} (${m.release_date ? m.release_date.slice(0,4) : 'N/A'})`,
                value: String(i)
              }));
              pendingSelections.set(`${interaction.user.id}_${selectId}`, {
                sessionKey,
                results,
                selectIdx: this.pendingTitleIdx
              });
              await this.interaction.editReply({
                content: `Multiple matches found for "${t}"${this.year ? ` (${this.year})` : ''}. Please select the correct movie:`,
                components: [
                  {
                    type: 1, // ACTION_ROW
                    components: [
                      {
                        type: 3, // SELECT_MENU
                        custom_id: selectId,
                        options
                      }
                    ]
                  }
                ]
              });
              return;
            }
          }
        };
        pendingAddMovieSessions.set(sessionKey, session);
        logBot(`AddMovie: Session started by ${interaction.user.id} in guild ${guild_id} for titles: ${titles.join(', ')}`);
        await session.handleNextTitle();
      } catch (err) {
        const replyMsg = await interaction.editReply(`Failed to add movie: ${err.message || err}`);
        setTimeout(() => { replyMsg.delete?.().catch(() => {}); }, 10000);
        pendingAddMovieSessions.delete(`${interaction.user.id}_${interaction.id}`);
        logBot(`Error in addmovie by ${interaction.user.id}: ${err.message}`);
      }
      return;
    }
    if (commandName === 'rsvp') {
      const { addRSVP } = require('./roles');
      addRSVP(interaction.user.id);
      // Add Moviegoers role to the user (fetch from guild, not cache, for reliability)
      let role = interaction.guild.roles.cache.find(r => r.name === 'Moviegoers');
      if (!role) {
        // Try to fetch all roles if not found in cache
        await interaction.guild.roles.fetch();
        role = interaction.guild.roles.cache.find(r => r.name === 'Moviegoers');
      }
      if (role) {
        try {
          await interaction.member.roles.add(role);
        } catch (err) {
          logBot(`Failed to add Moviegoers role to ${interaction.user.id}: ${err.message}`);
        }
      } else {
        logBot(`Moviegoers role not found in guild ${guild_id}`);
      }
      await interaction.reply({ content: 'You have been added to the **Moviegoers** role and will receive notifications for upcoming events! 🎬', flags: 64 });
      setTimeout(() => { interaction.deleteReply?.().catch(() => {}); }, 10000); // 10 seconds
      logBot(`RSVP: ${interaction.user.id} in guild ${guild_id}`);
      return;
    }
    if (commandName === 'unrsvp') {
      const { removeRSVP } = require('./roles');
      removeRSVP(interaction.user.id);
      // Remove Moviegoers role from the user (fetch from guild, not cache, for reliability)
      let role = interaction.guild.roles.cache.find(r => r.name === 'Moviegoers');
      if (!role) {
        await interaction.guild.roles.fetch();
        role = interaction.guild.roles.cache.find(r => r.name === 'Moviegoers');
      }
      if (role) {
        try {
          await interaction.member.roles.remove(role);
        } catch (err) {
          logBot(`Failed to remove Moviegoers role from ${interaction.user.id}: ${err.message}`);
        }
      } else {
        logBot(`Moviegoers role not found in guild ${guild_id}`);
      }
      await interaction.reply({ content: 'You have been removed from the **Moviegoers** role and will no longer receive notifications.', flags: 64 });
      setTimeout(() => { interaction.deleteReply?.().catch(() => {}); }, 10000); // 10 seconds
      logBot(`UnRSVP: ${interaction.user.id} in guild ${guild_id}`);
      return;
    }
    // ...rest of command handlers...
  });
}

module.exports = { registerHandlers };
