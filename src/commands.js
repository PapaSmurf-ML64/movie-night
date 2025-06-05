// All slash command and interaction handlers
const schedule = require('./schedule');
const tmdb = require('./tmdb');
const media = require('./media');
const { postOrUpdateSchedule, saveScheduleMessageId } = require('./scheduleEmbed');
const { joinConfiguredVoiceChannel } = require('./voice');
const { autoDelete } = require('./util');

// Export a function to register all handlers
function registerHandlers(client, config, DEFAULT_VOICE_CHANNEL_ID, DEFAULT_EVENT_TIME) {
  // Helper: send the Movie Night ping message (used by both scheduleRolePing and !testping)
  async function sendMovieNightPing(channel, role, movies, source = '') {
    if (!Array.isArray(movies)) movies = movies ? [movies] : [];
    if (movies.length === 0) {
      // No movie scheduled, just send the ping
      const sentMsg = await channel.send(`${role} Hello moviegoers! Movie night is starting in 5 minutes!`);
      setTimeout(() => { sentMsg.delete().catch(() => {}); }, 60 * 60 * 1000); // 1 hour
      return;
    }
    // Send the ping message with the first embed
    const header = `${role} Hello moviegoers! Movie night is starting in 5 minutes and on the schedule for tonight is:`;
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
            ],
            footer: { text: 'Movie Night starts in 5 minutes!' }
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
      if (!message.member.permissions.has('Administrator')) {
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
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;
    const guild_id = interaction.guild?.id;
    if (commandName === 'refreshschedule') {
      if (!interaction.member.permissions.has('Administrator')) {
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
            await interaction.reply('Schedule refreshed and new embed posted.');
            autoDelete(sentMsg);
          } catch (err2) {
            console.error('[refreshschedule] Failed to post new schedule embed:', err2);
            await interaction.reply('Failed to post new schedule embed. ' + (err2.message || err2));
            autoDelete(sentMsg);
          }
        } else {
          saveScheduleMessageId(msg.id);
          await interaction.reply('Schedule refreshed.');
          autoDelete(sentMsg);
        }
      } catch (err) {
        console.error('[refreshschedule] Error refreshing schedule:', err);
        try {
          await interaction.reply('Failed to refresh schedule. ' + (err.message || err));
          autoDelete(sentMsg);
        } catch (e) {
          // If reply fails, log
          console.error('[refreshschedule] Failed to reply to interaction:', e);
        }
      }
      return;
    }
    if (commandName === 'setchannel') {
      if (!interaction.member.permissions.has('Administrator')) {
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
      autoDelete(sentMsg);
      return;
    }
    if (commandName === 'seteventtime') {
      if (!interaction.member.permissions.has('Administrator')) {
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
      autoDelete(sentMsg);
      return;
    }
    if (commandName === 'setschedulemsg') {
      if (!interaction.member.permissions.has('Administrator')) {
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
      // Remove ephemeral: always reply non-ephemeral and auto-delete after 30s
      await interaction.deferReply({ ephemeral: false });
      const title = interaction.options.getString('title');
      const date = interaction.options.getString('date');
      const doubleFeature = interaction.options.getBoolean('doublefeature');
      if (!title) {
        const replyMsg = await interaction.editReply('You must provide a movie title.');
        setTimeout(() => { replyMsg.delete?.().catch(() => {}); }, 30000);
        return;
      }
      try {
        // Support comma-separated titles for double feature
        const titles = doubleFeature ? title.split(',').map(t => t.trim()).filter(Boolean) : [title.trim()];
        const tmdbResults = await Promise.all(titles.map(t => tmdb.searchMovie(t)));
        const movies = tmdbResults.map((results, i) => {
          if (!results || results.length === 0) throw new Error(`No TMDB match for "${titles[i]}"`);
          return results[0];
        });
        // Determine date to schedule
        let scheduleDate = date;
        if (!scheduleDate) {
          // Find next available Saturday (skip today if after 8PM)
          const now = new Date();
          let nextSaturday = new Date(now);
          nextSaturday.setHours(20, 0, 0, 0);
          const day = nextSaturday.getDay();
          if (!(day === 6 && now < nextSaturday)) {
            const daysUntilSaturday = (6 - day + 7) % 7 || 7;
            nextSaturday.setDate(nextSaturday.getDate() + daysUntilSaturday);
          }
          // Find first Saturday with <empty> slot
          const upcoming = await schedule.getUpcomingSchedule(guild_id);
          const takenDates = new Set(upcoming.map(m => m.date));
          let d = new Date(nextSaturday);
          while (takenDates.has(d.toISOString().slice(0, 10))) {
            d.setDate(d.getDate() + 7);
          }
          scheduleDate = d.toISOString().slice(0, 10);
        }
        // Add each movie (for double feature, same date)
        const addedIds = [];
        for (let i = 0; i < movies.length; i++) {
          const m = movies[i];
          const id = await schedule.addMovie({
            guild_id,
            title: m.title,
            tmdb_id: m.id,
            date: scheduleDate,
            added_by: interaction.user.id
          });
          addedIds.push(id);
        }
        const replyMsg = await interaction.editReply(`Movie(s) added to the schedule for ${scheduleDate}.`);
        setTimeout(() => { replyMsg.delete?.().catch(() => {}); }, 30000);
        // Optionally update the schedule message
        let channel = interaction.channel;
        if (config.scheduleChannelId) {
          try {
            channel = await interaction.guild.channels.fetch(config.scheduleChannelId);
          } catch {}
        }
        await postOrUpdateSchedule(channel, guild_id);
      } catch (err) {
        const replyMsg = await interaction.editReply(`Failed to add movie: ${err.message || err}`);
        setTimeout(() => { replyMsg.delete?.().catch(() => {}); }, 30000);
      }
      return;
    }
    if (commandName === 'startevent') {
      await interaction.reply({ content: 'Start event command not yet implemented.', ephemeral: true });
      return;
    }
    if (commandName === 'stopevent') {
      await interaction.reply({ content: 'Stop event command not yet implemented.', ephemeral: true });
      return;
    }
  });
}

module.exports = { registerHandlers };
