# Movie Night Discord Bot

A Discord bot for organizing and streaming movie nights from Plex or Jellyfin. Features include:
- Streaming movies into a voice channel
- Schedule management with slash commands
- TheMovieDB API integration for movie verification
- Event archiving to a thread
- Configurable schedule (default: Saturday 8PM EST)

## Setup
1. Create a `.env` file with your Discord bot token and API keys.
2. Run `npm install` to install dependencies.
3. Start the bot with `node src/bot.js` (to be created).

## Features
- Add movies to the schedule with `/addmovie`
- Start, stop, and refresh events with slash commands
- Archive completed events

## Coming Soon
- Full implementation of all features described above.
