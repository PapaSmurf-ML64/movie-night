// Utility to build movieByDate, addedByByDate, and userMap for dashboard and schedule message
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function buildScheduleMappings(upcoming, discordToken) {
  // Build movieByDate and addedByByDate
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
  // Fetch usernames for all unique added_by IDs
  let userMap = {};
  const userIds = Array.from(new Set(Object.values(addedByByDate).flat().filter(Boolean)));
  if (userIds.length > 0 && discordToken) {
    const promises = userIds.map(async id => {
      try {
        const res = await fetch(`https://discord.com/api/v10/users/${id}`,
          { headers: { Authorization: `Bot ${discordToken}` } });
        if (!res.ok) return null;
        const data = await res.json();
        return { id, username: data.username + (data.discriminator && data.discriminator !== '0' ? '#' + data.discriminator : '') };
      } catch { return null; }
    });
    const results = await Promise.all(promises);
    results.forEach(u => { if (u) userMap[u.id] = u.username; });
  }
  return { movieByDate, addedByByDate, userMap };
}

module.exports = { buildScheduleMappings };
