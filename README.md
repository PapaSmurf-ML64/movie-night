# Movie Night Discord Bot

A robust, open source Discord bot and dashboard for organizing and streaming movie nights from Plex or Jellyfin, with full multi-server (multi-guild) support.

## Features
- Streams movies into a Discord voice channel (Plex/Jellyfin integration, scaffolded)
- **Multi-server support:** Each Discord server (guild) has its own independent schedule and archive
- Schedule management with slash commands (`/addmovie`, `/reschedulemovie`, `/refreshschedule`, `/setschedulemsg`, etc.)
- TheMovieDB API integration for movie verification
- Event archiving to a thread
- RSVP and attendance tracking
- Configurable schedule (default: Saturday 8PM EST, but can be changed)
- Dashboard web interface for admins (Express + EJS)
- Robust schedule message: always posts/updates a single plain text message (not embed), with correct Discord timestamp formatting and time zone handling (DST-aware, UTC)
- Special events and all scheduled dates are always shown in both the dashboard and schedule message
- Admin controls: restrict sensitive commands and dashboard actions to server admins
- Auto-delete utility for ephemeral/test/admin messages
- Modular, maintainable codebase
- Auto-restart on file save (via VS Code task)
- Open source ready: GPLv3 license, documented environment variables, and secure defaults

## Setup
1. Clone this repo and `cd` into the project directory.
2. Copy `.env.example` to `.env` and fill in your Discord bot token, TMDB API key, and other secrets.
3. (Optional) Set `SCHEDULE_MESSAGE_ID` in `.env` to force the bot to always update a specific schedule message.
4. Run `npm install` to install dependencies.
5. Start the bot with `node src/bot.js` or use the provided VS Code task for auto-restart.
6. Start the dashboard with `node src/dashboard.js` (or use a process manager for production).

## Usage
- Use slash commands in Discord to manage the schedule and events. All commands are non-ephemeral and auto-delete after 30 seconds.
- The schedule is always posted/updated as a single plain text message in the configured channel, with all event dates (including special events) and correct time zone formatting.
- Per-server settings are configurable in Discord with `/setchannel`, `/setvoicechannel`, `/setadminrole`, `/seteventtime`, and `/setschedulemsg`.
- The dashboard provides a web interface for viewing/updating the schedule and archives (admin-only). All actions are scoped to the current Discord server.

## Environment Variables
- `DISCORD_TOKEN`: Your Discord bot token
- `DISCORD_CLIENT_ID`: Discord application client ID
- `DISCORD_CLIENT_SECRET`: Discord application client secret
- `DASHBOARD_SECRET`: Session secret for dashboard
- `TMDB_API_KEY`: TheMovieDB API key
- `SCHEDULE_MESSAGE_ID`: (Optional) global fallback schedule message ID (usually set per guild with `/setschedulemsg`)
- `DEFAULT_SCHEDULE_CHANNEL_ID`: (Optional) fallback default for new guilds
- `DEFAULT_VOICE_CHANNEL_ID`: (Optional) fallback default for new guilds
- `DEFAULT_EVENT_TIME`: (Optional) fallback event time for new guilds (default: `Saturday 20:00`)
- `ADMIN_ROLE_ID`: (Optional) fallback admin role for new guilds

## Development
- All bot and dashboard logic is modularized in `src/`
- Schedule message IDs are persisted per guild in `guild-config.json` (with legacy fallback support for `schedule-message-id.txt`)
- Guild settings are persisted in `guild-config.json` and isolated per guild
- SQLite is used for schedule storage (`movie-schedule.db`), with all data stored per-guild (server-specific)
- All sensitive files, logs, and database files are ignored by `.gitignore`
- Dashboard session files are stored in `.sessions/` (gitignored)

## License

This project is licensed under the GNU General Public License v3.0. See the LICENSE file for details.
