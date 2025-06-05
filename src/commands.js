// All slash command and interaction handlers
const schedule = require('./schedule');
const tmdb = require('./tmdb');
const media = require('./media');
const { postOrUpdateSchedule, saveScheduleMessageId } = require('./scheduleEmbed');
const { joinConfiguredVoiceChannel } = require('./voice');
const { autoDelete } = require('./util');

// Export a function to register all handlers
function registerHandlers(client, config, DEFAULT_VOICE_CHANNEL_ID, DEFAULT_EVENT_TIME) {
  // Helper: auto-delete a message after 5 minutes (unless it's the schedule message)
  // (autoDelete is imported)

  // Ping Movie Night role 5 minutes before the event
  async function scheduleRolePing() {
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
    const msUntilEvent = nextSaturday.getTime() - now.getTime();
    const msUntilPing = msUntilEvent - 5 * 60 * 1000; // 5 minutes before
    if (msUntilPing > 0) {
      setTimeout(async () => {
        // Fetch the next scheduled movie for that date
        const movies = await schedule.getUpcomingSchedule();
        let movie = null;
        const dateStr = nextSaturday.toISOString().slice(0, 10);
        for (const m of movies) {
          if (m.date === dateStr) {
            movie = m;
            break;
          }
        }
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
        if (embed) {
          const sentMsg = await channel.send({ content: `${role} Movie Night starts in 5 minutes!`, embeds: [embed] });
          autoDelete(sentMsg);
        } else {
          const sentMsg = await channel.send(`${role} Movie Night starts in 5 minutes!`);
          autoDelete(sentMsg);
        }
        // Schedule the next ping for the following week
        scheduleRolePing();
      }, msUntilPing);
    } else {
      // If the event is less than 5 minutes away, schedule for next week
      setTimeout(scheduleRolePing, 7 * 24 * 60 * 60 * 1000);
    }
  }

  client.once('ready', async () => {
    scheduleRolePing();
  });

  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (message.content.trim().toLowerCase() === '!testping') {
      // Only allow admins to use this command
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
      // Fetch the next scheduled movie for that date
      const movies = await schedule.getUpcomingSchedule();
      let movie = null;
      const dateStr = nextSaturday.toISOString().slice(0, 10);
      for (const m of movies) {
        if (m.date === dateStr) {
          movie = m;
          break;
        }
      }
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
      if (embed) {
        const sentMsg = await channel.send({ content: `${role} Movie Night starts in 5 minutes!`, embeds: [embed] });
        autoDelete(sentMsg);
      } else {
        const sentMsg = await channel.send(`${role} Movie Night starts in 5 minutes!`);
        autoDelete(sentMsg);
      }
    }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;
    if (commandName === 'refreshschedule') {
      // Only allow admins to refresh the schedule
      if (!interaction.member.permissions.has('Administrator')) {
        await interaction.reply({ content: 'Only administrators can refresh the schedule.', ephemeral: true });
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
        let msg = await postOrUpdateSchedule(channel);
        if (!msg) {
          // If no valid message, post a new embed
          const movies = await schedule.getUpcomingSchedule();
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
            await interaction.reply({ content: 'Schedule refreshed and new embed posted.', ephemeral: true });
          } catch (err2) {
            console.error('[refreshschedule] Failed to post new schedule embed:', err2);
            await interaction.reply({ content: 'Failed to post new schedule embed. ' + (err2.message || err2), ephemeral: true });
          }
        } else {
          saveScheduleMessageId(msg.id);
          await interaction.reply({ content: 'Schedule refreshed.', ephemeral: true });
        }
      } catch (err) {
        console.error('[refreshschedule] Error refreshing schedule:', err);
        try {
          await interaction.reply({ content: 'Failed to refresh schedule. ' + (err.message || err), ephemeral: true });
        } catch (e) {
          // If reply fails, log
          console.error('[refreshschedule] Failed to reply to interaction:', e);
        }
      }
      return;
    }
    if (commandName === 'setschedulemsg') {
      if (!interaction.member.permissions.has('Administrator')) {
        await interaction.reply({ content: 'Only administrators can set the schedule message.', ephemeral: true });
        return;
      }
      const msgId = interaction.options.getString('messageid');
      // Save the new schedule message ID and update in-memory variable
      const { saveScheduleMessageId, setScheduleMessageId } = require('./scheduleEmbed');
      saveScheduleMessageId(msgId);
      setScheduleMessageId(msgId);
      // Reply immediately to avoid Discord timeout
      await interaction.reply({ content: `Schedule message ID set to ${msgId}.`, ephemeral: true });
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
  });
}

module.exports = { registerHandlers };
