// All slash command and interaction handlers
const schedule = require('./schedule');
const tmdb = require('./tmdb');
const { postOrUpdateSchedule, saveScheduleMessageId, setScheduleMessageId } = require('./scheduleEmbed');
const { autoDelete, getEventSettings, nextEventDate, parseEventTime, formatEventTime, validateEventDate, formatMonthDay } = require('./util');
const { joinConfiguredVoiceChannel, leaveVoiceChannel } = require('./voice');
const { clearWatching } = require('./nickname');
const { handleVoteButton, BUTTON_PREFIX: VOTE_BUTTON_PREFIX } = require('./movieVote');
const { addRSVP, removeRSVP } = require('./roles');
const { logBot } = require('./logger');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { isThreadChannel } = require('./archiveThread');
const { nextFreeEventDate } = require('./scheduleUtils');
const { afterMovieAdded } = require('./integrations');
const { linkPlexUser, unlinkPlexUser } = require('./integrations/playback');

const PING_DELETE_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const VOICE_CHANNEL_TYPE = 2;

// Pending TMDB select-menu choices and /addmovie sessions (expired after SESSION_TTL_MS)
const pendingSelections = new Map();
const pendingAddMovieSessions = new Map();

function expireLater(map, key) {
  setTimeout(() => map.delete(key), SESSION_TTL_MS).unref();
}

async function getOrCreateMoviegoersRole(guild) {
  let role = guild.roles.cache.find(r => r.name === 'Moviegoers');
  if (role) return role;

  await guild.roles.fetch();
  role = guild.roles.cache.find(r => r.name === 'Moviegoers');
  if (role) return role;

  try {
    role = await guild.roles.create({
      name: 'Moviegoers',
      mentionable: true,
      reason: 'Auto-created for Movie Night RSVP notifications',
    });
    logBot(`Created Moviegoers role in guild ${guild.id}`);
    return role;
  } catch (err) {
    logBot(`Failed to create Moviegoers role in guild ${guild.id}: ${err.message}`);
    return null;
  }
}

function isGuildAdmin(member, guild_id) {
  const { adminRoleId } = getGuildConfig(guild_id);
  return Boolean((adminRoleId && member?.roles?.cache?.has(adminRoleId)) || member?.permissions?.has('Administrator'));
}

async function resolveScheduleChannel(guild, fallbackChannel) {
  const { scheduleChannelId } = getGuildConfig(guild.id);
  if (scheduleChannelId) {
    try {
      return guild.channels.cache.get(scheduleChannelId) || await guild.channels.fetch(scheduleChannelId);
    } catch {}
  }
  if (fallbackChannel?.id) setGuildConfig(guild.id, { scheduleChannelId: fallbackChannel.id });
  return fallbackChannel;
}

// Send the Movie Night ping message (used by !testping)
async function sendMovieNightPing(channel, movies) {
  const moviegoersRole = await getOrCreateMoviegoersRole(channel.guild);
  const roleMention = moviegoersRole ? `<@&${moviegoersRole.id}>` : '@everyone';
  const sentMsg = movies.length === 0
    ? await channel.send(`Hello ${roleMention}! Movie night is starting in 5 minutes!`)
    : await channel.send({
      content: `Hello ${roleMention}! Movie night is starting in 5 minutes and on the schedule for tonight is:`,
      embeds: await tmdb.buildMovieEmbeds(movies),
    });
  setTimeout(() => { sentMsg.delete().catch(() => {}); }, PING_DELETE_MS);
}

// Reply helper for ephemeral-ish replies that clean themselves up
async function replyAndDelete(interaction, content) {
  autoDelete(await interaction.reply(content));
}

// Simple admin "set X" commands: option getter, validation, config key and labels
const SETTER_COMMANDS = {
  setchannel: {
    what: 'the schedule channel',
    get: i => i.options.getChannel('channel'),
    valid: c => Boolean(c),
    invalidMsg: 'Invalid channel.',
    key: 'scheduleChannelId',
    label: 'Schedule channel', mention: c => `<#${c.id}>`,
  },
  setvoicechannel: {
    what: 'the default voice channel',
    get: i => i.options.getChannel('channel'),
    valid: c => c?.type === VOICE_CHANNEL_TYPE,
    invalidMsg: 'Please select a valid voice channel.',
    key: 'voiceChannelId',
    label: 'Default voice channel', mention: c => `<#${c.id}>`,
  },
  setadminrole: {
    what: 'the admin role',
    get: i => i.options.getRole('role'),
    valid: r => Boolean(r),
    invalidMsg: 'Please select a valid role.',
    key: 'adminRoleId',
    label: 'Admin role', mention: r => `<@&${r.id}>`,
  },
  setarchivethread: {
    what: 'the archive thread',
    get: i => i.options.getChannel('thread'),
    valid: isThreadChannel,
    invalidMsg: 'Please select a valid thread channel.',
    key: 'archiveThreadId',
    label: 'Archive thread', mention: t => `<#${t.id}>`,
  },
  seteventtime: {
    what: 'the event time',
    get: i => parseEventTime(i.options.getString('time')),
    valid: t => Boolean(t),
    invalidMsg: 'Couldn\'t read that time. Use a weekday and time, e.g. `Saturday 20:00` or `Friday 7:30pm`.',
    key: 'eventTime',
    label: 'Event time', mention: t => formatEventTime(t), value: t => formatEventTime(t),
    // Timestamps in the posted schedule depend on the event time
    after: (interaction, guild_id) => resolveScheduleChannel(interaction.guild, interaction.channel)
      .then(channel => postOrUpdateSchedule(channel, guild_id)),
  },
};

async function handleSetter(interaction, def, guild_id) {
  const target = def.get(interaction);
  if (!def.valid(target)) {
    await interaction.reply({ content: def.invalidMsg, ephemeral: true });
    return;
  }
  const value = def.value ? def.value(target) : target.id;
  setGuildConfig(guild_id, { [def.key]: value });
  await replyAndDelete(interaction, `${def.label} set to ${def.mention(target)}.`);
  logBot(`${def.label} set to ${value} by ${interaction.user.id} in guild ${guild_id}`);
  if (def.after) def.after(interaction, guild_id).catch(err => logBot(`Post-update for ${def.key} failed in guild ${guild_id}: ${err.message}`));
}


function createAddMovieSession(interaction, { sessionKey, titles, date, guild_id, year }) {
  return {
    interaction,
    titles,
    selectedMovies: [],
    pendingTitleIdx: 0,
    async handleNextTitle() {
      // Resolve titles until one needs the user to pick from a menu
      while (this.pendingTitleIdx < this.titles.length) {
        const t = this.titles[this.pendingTitleIdx];
        const results = await tmdb.searchMovie(t, year);
        if (!results || results.length === 0) throw new Error(`No TMDB match for "${t}"${year ? ` (${year})` : ''}`);
        if (results.length === 1) {
          this.selectedMovies.push(results[0]);
          this.pendingTitleIdx++;
          continue;
        }
        results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
        const selectId = `select_movie_${interaction.id}_${this.pendingTitleIdx}`;
        const options = results.slice(0, 25).map((m, i) => ({
          label: `${m.title} (${m.release_date ? m.release_date.slice(0, 4) : 'N/A'})`.slice(0, 97) + (m.title.length > 93 ? '…' : ''),
          value: String(i)
        }));
        const selKey = `${interaction.user.id}_${selectId}`;
        pendingSelections.set(selKey, { sessionKey, results, selectIdx: this.pendingTitleIdx });
        expireLater(pendingSelections, selKey);
        await this.interaction.editReply({
          content: `Multiple matches found for "${t}"${year ? ` (${year})` : ''}. Please select the correct movie:`,
          components: [{ type: 1, components: [{ type: 3, custom_id: selectId, options }] }],
        });
        return;
      }

      // All movies selected: add them
      const scheduleDate = date || await nextFreeEventDate(guild_id);
      // Fill in missing release dates in parallel
      await Promise.all(this.selectedMovies.map(async m => {
        if (!m.release_date && m.id) {
          try { m.release_date = (await tmdb.getMovieDetails(m.id)).release_date; } catch {}
        }
      }));
      for (const m of this.selectedMovies) {
        await schedule.addMovie({
          guild_id,
          title: m.title,
          tmdb_id: m.id,
          date: scheduleDate,
          added_by: this.interaction.user.id,
          release_date: m.release_date
        });
      }
      pendingAddMovieSessions.delete(sessionKey);
      // Plex/Seerr/Radarr: report availability and auto-request missing movies (no-op without integrations)
      const statusLines = (await Promise.all(this.selectedMovies.map(m =>
        afterMovieAdded(guild_id, { tmdb_id: m.id, title: m.title, release_date: m.release_date }).catch(() => '')))).filter(Boolean);
      const replyMsg = await this.interaction.editReply([`Movie(s) added to the schedule for ${scheduleDate}.`, ...statusLines].join('\n'));
      setTimeout(() => { replyMsg.delete?.().catch(() => {}); }, statusLines.length ? 30000 : 10000);
      const channel = await resolveScheduleChannel(this.interaction.guild, this.interaction.channel);
      await postOrUpdateSchedule(channel, guild_id);
      logBot(`Schedule updated for guild ${guild_id}`);
    }
  };
}

async function handleMovieSelect(interaction) {
  const key = `${interaction.user.id}_${interaction.customId}`;
  const pending = pendingSelections.get(key);
  pendingSelections.delete(key);
  const session = pending && pendingAddMovieSessions.get(pending.sessionKey);
  if (!session) {
    logBot(`SelectMenu: Invalid or expired selection by user ${interaction.user.id}`);
    await interaction.update({ content: 'This selection is no longer valid or has timed out.', components: [] });
    return;
  }
  const selected = pending.results[parseInt(interaction.values[0], 10)];
  session.selectedMovies.push(selected);
  session.pendingTitleIdx = pending.selectIdx + 1;
  await interaction.update({ content: `Selected: ${selected.title} (${selected.release_date ? selected.release_date.slice(0, 4) : 'N/A'})`, components: [] });
  logBot(`SelectMenu: User ${interaction.user.id} selected movie for session ${pending.sessionKey}`);
  try {
    await session.handleNextTitle();
  } catch (err) {
    pendingAddMovieSessions.delete(pending.sessionKey);
    await session.interaction.editReply(`Failed to add movie: ${err.message || err}`).catch(() => {});
    logBot(`Error in addmovie selection by ${interaction.user.id}: ${err.message}`);
  }
}

async function handleAddMovie(interaction, guild_id) {
  await interaction.deferReply();
  const title = interaction.options.getString('title');
  const date = interaction.options.getString('date');
  const doubleFeature = interaction.options.getBoolean('doublefeature');
  const year = interaction.options.getInteger('year') ?? undefined;
  const sessionKey = `${interaction.user.id}_${interaction.id}`;
  const dateError = date && validateEventDate(date, getEventSettings(guild_id));
  if (dateError) {
    const replyMsg = await interaction.editReply(`Failed to add movie: ${dateError}`);
    setTimeout(() => { replyMsg.delete?.().catch(() => {}); }, 10000);
    return;
  }
  try {
    const titles = doubleFeature ? title.split(',').map(t => t.trim()).filter(Boolean) : [title.trim()];
    const session = createAddMovieSession(interaction, { sessionKey, titles, date, guild_id, year });
    pendingAddMovieSessions.set(sessionKey, session);
    expireLater(pendingAddMovieSessions, sessionKey);
    logBot(`AddMovie: Session started by ${interaction.user.id} in guild ${guild_id} for titles: ${titles.join(', ')}`);
    await session.handleNextTitle();
  } catch (err) {
    pendingAddMovieSessions.delete(sessionKey);
    const replyMsg = await interaction.editReply(`Failed to add movie: ${err.message || err}`);
    setTimeout(() => { replyMsg.delete?.().catch(() => {}); }, 10000);
    logBot(`Error in addmovie by ${interaction.user.id}: ${err.message}`);
  }
}

async function handleRefreshSchedule(interaction, guild_id) {
  const channel = await resolveScheduleChannel(interaction.guild, interaction.channel);
  try {
    const msg = await postOrUpdateSchedule(channel, guild_id);
    saveScheduleMessageId(msg.id, guild_id);
    await replyAndDelete(interaction, 'Schedule refreshed.');
    logBot(`Schedule refreshed by ${interaction.user.id} in guild ${guild_id}`);
  } catch (err) {
    console.error('[refreshschedule] Error refreshing schedule:', err);
    logBot(`Error in refreshschedule by ${interaction.user.id}: ${err.message}`);
    await replyAndDelete(interaction, 'Failed to refresh schedule. ' + (err.message || err)).catch(() => {});
  }
}

async function handleSetScheduleMsg(interaction, guild_id) {
  const msgId = interaction.options.getString('messageid');
  saveScheduleMessageId(msgId, guild_id);
  setScheduleMessageId(msgId, guild_id);
  // Reply immediately to avoid Discord timeout, then update the message in the background
  await replyAndDelete(interaction, `Schedule message ID set to ${msgId}.`);
  logBot(`Schedule message ID set to ${msgId} by ${interaction.user.id} in guild ${guild_id}`);
  resolveScheduleChannel(interaction.guild, interaction.channel)
    .then(channel => postOrUpdateSchedule(channel, guild_id))
    .catch(err => console.error('[setschedulemsg] Failed to update schedule message after setting ID:', err));
}

async function handleRoleToggle(interaction, guild_id, join) {
  await (join ? addRSVP : removeRSVP)(guild_id, interaction.user.id);
  const role = await getOrCreateMoviegoersRole(interaction.guild);
  if (role) {
    try {
      await (join ? interaction.member.roles.add(role) : interaction.member.roles.remove(role));
    } catch (err) {
      logBot(`Failed to ${join ? 'add' : 'remove'} Moviegoers role ${join ? 'to' : 'from'} ${interaction.user.id}: ${err.message}`);
    }
  } else {
    logBot(`Moviegoers role not found in guild ${guild_id}`);
  }
  await interaction.reply({
    content: join
      ? 'You have been added to the **Moviegoers** role and will receive notifications for upcoming events! 🎬'
      : 'You have been removed from the **Moviegoers** role and will no longer receive notifications.',
    flags: 64,
  });
  setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 10000);
  logBot(`${join ? 'RSVP' : 'UnRSVP'}: ${interaction.user.id} in guild ${guild_id}`);
}

async function handleRescheduleMovie(interaction, guild_id) {
  const id = interaction.options.getInteger('id');
  const date = interaction.options.getString('date').trim();
  const dateError = validateEventDate(date, getEventSettings(guild_id));
  if (dateError) {
    await interaction.reply({ content: dateError, ephemeral: true });
    return;
  }
  const movie = await schedule.getScheduledMovie(id, guild_id);
  if (!movie) {
    await interaction.reply({ content: `No scheduled movie with ID ${id}. (IDs are shown on the dashboard.)`, ephemeral: true });
    return;
  }
  await schedule.rescheduleMovie(id, date, guild_id);
  await replyAndDelete(interaction, `Moved **${movie.title}** from ${movie.date || 'unscheduled'} to ${formatMonthDay(date)} (${date}).`);
  logBot(`Rescheduled movie ${id} from ${movie.date} to ${date} by ${interaction.user.id} in guild ${guild_id}`);
  resolveScheduleChannel(interaction.guild, interaction.channel)
    .then(channel => postOrUpdateSchedule(channel, guild_id))
    .catch(err => logBot(`Failed to update schedule after reschedule in guild ${guild_id}: ${err.message}`));
}

async function handleStartEvent(interaction, guild_id) {
  // Configured event channel, else whatever voice channel the admin is sitting in
  const channelId = getGuildConfig(guild_id).voiceChannelId || interaction.member?.voice?.channelId;
  if (!channelId) {
    await interaction.reply({ content: 'No voice channel configured. Use `/setvoicechannel` or join a voice channel first.', ephemeral: true });
    return;
  }
  await interaction.deferReply(); // joining can take longer than Discord's 3s reply window
  try {
    await joinConfiguredVoiceChannel(interaction.guild, channelId);
    autoDelete(await interaction.editReply(`Movie night started in <#${channelId}>. 🍿`));
    logBot(`Event started manually by ${interaction.user.id} in guild ${guild_id}`);
  } catch (err) {
    autoDelete(await interaction.editReply(`Couldn't join the voice channel: ${err.message}`));
    logBot(`startevent failed in guild ${guild_id}: ${err.message}`);
  }
}

async function handleStopEvent(interaction, guild_id) {
  const left = leaveVoiceChannel(guild_id);
  await clearWatching(interaction.guild);
  await replyAndDelete(interaction, left ? 'Movie night ended. Thanks for watching! 🎬' : 'There\'s no event running right now.');
  if (left) logBot(`Event stopped by ${interaction.user.id} in guild ${guild_id}`);
}

const ADMIN_COMMANDS = {
  reschedulemovie: { what: 'reschedule movies', run: handleRescheduleMovie },
  startevent: { what: 'start events', run: handleStartEvent },
  stopevent: { what: 'stop events', run: handleStopEvent },
  refreshschedule: { what: 'refresh the schedule', run: handleRefreshSchedule },
  setschedulemsg: { what: 'set the schedule message', run: handleSetScheduleMsg },
  ...Object.fromEntries(Object.entries(SETTER_COMMANDS).map(([name, def]) =>
    [name, { what: `set ${def.what}`, run: (i, g) => handleSetter(i, def, g) }])),
};

async function handleLinkPlex(interaction, guild_id) {
  const username = interaction.options.getString('username').trim();
  if (!username || username.length > 100) {
    await interaction.reply({ content: 'Please give your Plex username.', ephemeral: true });
    return;
  }
  await linkPlexUser(guild_id, username, interaction.user.id);
  await interaction.reply({ content: `Linked Plex account **${username}** to you. Watching movie night on Plex will now count toward attendance.`, ephemeral: true });
  logBot(`Linked Plex user ${username} to ${interaction.user.id} in guild ${guild_id}`);
}

async function handleUnlinkPlex(interaction, guild_id) {
  await unlinkPlexUser(guild_id, interaction.user.id);
  await interaction.reply({ content: 'Unlinked your Plex account.', ephemeral: true });
}

const OPEN_COMMANDS = {
  linkplex: handleLinkPlex,
  unlinkplex: handleUnlinkPlex,
  addmovie: handleAddMovie,
  rsvp: (i, g) => handleRoleToggle(i, g, true),
  unrsvp: (i, g) => handleRoleToggle(i, g, false),
};

function registerHandlers(client) {
  client.on('messageCreate', async message => {
    if (message.author.bot || message.content.trim().toLowerCase() !== '!testping') return;
    if (!isGuildAdmin(message.member, message.guild?.id)) {
      autoDelete(await message.reply('Only administrators can use this command.'));
      return;
    }
    // Movies for the next regular event date (double feature support)
    const date = nextEventDate(getEventSettings(message.guild.id));
    const movies = (await schedule.getUpcomingSchedule(message.guild.id)).filter(m => m.date === date);
    await sendMovieNightPing(message.channel, movies);
  });

  client.on('interactionCreate', async interaction => {
    if (interaction.isButton() && interaction.customId.startsWith(`${VOTE_BUTTON_PREFIX}|`)) {
      await handleVoteButton(interaction).catch(err => logBot(`Vote button error: ${err.message}`));
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_movie_')) {
      await handleMovieSelect(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const guild_id = interaction.guild?.id;
    logBot(`Command: ${commandName} by ${interaction.user.id} in guild ${guild_id || 'unknown'}`);

    const admin = ADMIN_COMMANDS[commandName];
    if (admin) {
      if (!isGuildAdmin(interaction.member, guild_id)) {
        await replyAndDelete(interaction, `Only administrators can ${admin.what}.`);
        return;
      }
      await admin.run(interaction, guild_id);
      return;
    }
    const open = OPEN_COMMANDS[commandName];
    if (open) await open(interaction, guild_id);
  });
}

module.exports = { registerHandlers };
