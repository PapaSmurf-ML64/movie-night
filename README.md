# Movie Night Discord Bot

A Discord bot and web dashboard for scheduling movie nights, with optional Plex, Overseerr/Jellyseerr, Radarr and Tautulli integration. Every Discord server (guild) gets its own schedule, settings and integrations.

## Features
- **Schedule** movies with `/addmovie` (TMDB lookup, double features, optional date) or from the dashboard. Movies without a date go on the next free event night.
- **Schedule message**: a single message that the bot keeps up to date. Each date is a Discord timestamp, so every viewer sees the date and time in their own timezone.
- **Reminders**: pings the Moviegoers role 5 minutes before start. The ping is sent once per date and is not repeated after a restart.
- **Voice**: joins the configured voice channel at start time. This only marks the event; the bot does not stream video.
- **RSVP and attendance**: `/rsvp` and `/unrsvp` add or remove the Moviegoers role. Attendance is taken from the voice channel (from 15 minutes before start to 3 hours after) and from Plex playback webhooks.
- **Archiving**: finished movies are archived and posted to an archive thread. With playback webhooks, a movie is archived when it finishes playing. Otherwise it's archived 2 hours after start (6 hours if webhooks are enabled, as a fallback).
- **Dashboard** (Discord login, only for servers you manage): add, move, archive and delete movies, see upcoming dates in your browser's timezone, browse the archive by year, and configure integrations.

## Optional integrations
Each server configures these in the dashboard's **Integrations** section:
- **Plex**: shows whether each scheduled movie is in the library.
- **Overseerr/Jellyseerr** (preferred) or **Radarr**: requests movies that aren't on Plex. Requests happen automatically when a movie is added (this can be turned off) or with the dashboard's Request button.
- **Playback webhooks** (Plex Pass webhooks and/or Tautulli):
  - post "Now playing";
  - set the bot's nickname in that server to `🎬 <title>`, restored when the movie is archived or `/stopevent` is used;
  - count attendance for members who link their Plex username with `/linkplex`;
  - archive each movie when it has been watched.
- **Movie vote** (requires Plex): on an event night with nothing scheduled, the bot posts 5 movies from your Plex library 30 minutes before start. Movies are chosen to match the month or season, skipping anything watched in the last 12 months. The winner is scheduled at start time.

Integration secrets are encrypted in the database. To prevent abuse, integrations can't reach private/LAN addresses unless the server's ID is listed in `INTEGRATIONS_PRIVATE_GUILDS`.

The bot needs the **Change Nickname** permission for the watching nickname. The invite link printed at startup includes it; servers that invited the bot earlier need to grant it manually.

## Setup
1. Clone the repo and run `npm install`.
2. Copy `.env.example` to `.env` and fill in at least `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DASHBOARD_SECRET` and `TMDB_API_KEY`.
3. In the Discord developer portal, add `<dashboard URL>/auth/discord/callback` as an OAuth2 redirect.
4. Run `npm start`. This runs the bot and dashboard in one process (`src/index.js`); use a process manager such as systemd or pm2 in production.
5. Invite the bot with the link printed at startup, then configure each server in Discord:
   `/setchannel`, `/setvoicechannel`, `/setadminrole`, `/setarchivethread`, `/seteventtime` (e.g. `Saturday 8pm`).

Slash commands are registered globally at startup. `npm run refresh-commands` re-registers them without starting the bot.

## Commands
| Command | Who | Purpose |
|---|---|---|
| `/addmovie title [date] [doublefeature] [year]` | Everyone | Add a movie (comma-separate titles for a double feature) |
| `/rsvp`, `/unrsvp` | Everyone | Join or leave the Moviegoers role |
| `/linkplex username`, `/unlinkplex` | Everyone | Link your Plex account for attendance |
| `/reschedulemovie id date` | Admin | Move a movie to another date (IDs are shown on the dashboard) |
| `/startevent`, `/stopevent` | Admin | Join or leave the voice channel manually |
| `/refreshschedule`, `/setschedulemsg messageid` | Admin | Re-post the schedule message, or choose which message to use |
| `/setchannel`, `/setvoicechannel`, `/setadminrole`, `/setarchivethread`, `/seteventtime` | Admin | Server settings |

"Admin" means members with the configured admin role or the Administrator permission. Dates use `YYYY-MM-DD`.

## Environment variables
| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Bot token |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Yes | OAuth2 credentials for dashboard login |
| `DASHBOARD_SECRET` | Yes | Long random string for sessions (`openssl rand -hex 32`); the dashboard won't start with the placeholder |
| `TMDB_API_KEY` | Yes | TheMovieDB API key |
| `DASHBOARD_PORT` | No | Dashboard port (default `3000`) |
| `DASHBOARD_PUBLIC_URL` | No | Public dashboard URL, used when showing webhook URLs |
| `EVENT_TIMEZONE` | No | Timezone event times are interpreted in (default `America/New_York`) |
| `DEFAULT_EVENT_TIME` | No | Event time for new servers (default `Saturday 20:00`) |
| `DEFAULT_SCHEDULE_CHANNEL_ID`, `DEFAULT_VOICE_CHANNEL_ID`, `ADMIN_ROLE_ID` | No | Defaults for new servers |
| `INTEGRATIONS_KEY` | No | Key for encrypting integration secrets (defaults to `DASHBOARD_SECRET`; changing it means re-entering them) |
| `INTEGRATIONS_PRIVATE_GUILDS` | No | Comma-separated server IDs allowed to use private/LAN integration addresses |
| `NODE_ENV` | No | Set to `production` to stop log lines also printing to the console |

## Data files
All of these are ignored by git:
- `movie-schedule.db`: SQLite database holding schedules, archives, RSVPs, attendance, votes and encrypted integration settings.
- `guild-config.json`: per-server settings.
- `.sessions/`: dashboard sessions.
- `*.log`: rotating bot logs.

## License
GNU General Public License v3.0. See [LICENSE](LICENSE).
