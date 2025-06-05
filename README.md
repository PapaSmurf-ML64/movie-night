# Movie Night Discord Bot

A Discord bot and dashboard for organizing and streaming movie nights from Plex or Jellyfin.

## Features
- Streams movies into a Discord voice channel (Plex/Jellyfin integration, scaffolded)
- Schedule management with slash commands (`/addmovie`, `/removemovie`, `/reschedulemovie`, `/refreshschedule`, `/setschedulemsg`, etc.)
- TheMovieDB API integration for movie verification
- Event archiving to a thread
- RSVP and attendance tracking
- Configurable schedule (default: Saturday 8PM EST, but can be changed)
- Dashboard web interface for admins (Express + EJS)
- Robust schedule message handling: always posts/updates a single message (plain text, not embed)
- Schedule message ID can be set via `.env` (`SCHEDULE_MESSAGE_ID`) for reliability
- Auto-delete utility for ephemeral/test/admin messages
- Modular, maintainable codebase
- Auto-restart on file save (via VS Code task)

## Setup
1. Clone this repo and `cd` into the project directory.
2. Copy `.env.example` to `.env` and fill in your Discord bot token, TMDB API key, and other secrets.
3. (Optional) Set `SCHEDULE_MESSAGE_ID` in `.env` to force the bot to always update a specific schedule message.
4. Run `npm install` to install dependencies.
5. Start the bot with `node src/bot.js` or use the provided VS Code task for auto-restart.
6. (Optional) Start the dashboard with `node src/dashboard.js` (see `.vscode/dashboard-task.json`).

## Usage
- Use slash commands in Discord to manage the schedule and events.
- The schedule is always posted/updated as a single plain text message in the configured channel.
- Admins can set the schedule message ID with `/setschedulemsg` or by setting `SCHEDULE_MESSAGE_ID` in `.env`.
- The dashboard provides a web interface for viewing/updating the schedule and archives (admin-only).

## Environment Variables
- `DISCORD_TOKEN`: Your Discord bot token
- `DISCORD_CLIENT_ID`: Discord application client ID
- `DISCORD_CLIENT_SECRET`: Discord application client secret
- `ADMIN_GUILD_ID`: Discord server (guild) ID
- `ADMIN_ROLE_ID`: Discord role ID for admin access
- `DASHBOARD_SECRET`: Session secret for dashboard
- `TMDB_API_KEY`: TheMovieDB API key
- `SCHEDULE_MESSAGE_ID`: (Optional) Constant schedule message ID to always update

## Development
- All bot logic is modularized in `src/`
- Schedule message ID is persisted in `schedule-message-id.txt` unless overridden by `.env`
- SQLite is used for schedule storage (`movie-schedule.db`)
- All sensitive files are ignored by `.gitignore`

## License
MIT
