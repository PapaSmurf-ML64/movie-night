// tmdb.js: Handles TheMovieDB API lookups
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

// Movie details rarely change; cache them so pings/adds don't refetch
const detailsCache = new Map();
const DETAILS_TTL = 24 * 60 * 60 * 1000;

async function searchMovie(title, year) {
  let url = `${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
  if (year) url += `&year=${encodeURIComponent(year)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('TMDB search failed');
  const data = await res.json();
  return data.results;
}

async function getMovieDetails(id) {
  const hit = detailsCache.get(id);
  if (hit && Date.now() - hit.at < DETAILS_TTL) return hit.data;
  const res = await fetch(`${TMDB_BASE}/movie/${id}?api_key=${TMDB_API_KEY}`);
  if (!res.ok) throw new Error('TMDB details failed');
  const data = await res.json();
  detailsCache.set(id, { data, at: Date.now() });
  return data;
}

// Build Discord embeds for a list of scheduled movies (fetched in parallel; failures skipped)
async function buildMovieEmbeds(movies) {
  const embeds = await Promise.all(movies.map(async movie => {
    if (!movie?.tmdb_id) return null;
    try {
      const d = await getMovieDetails(movie.tmdb_id);
      return {
        color: 0xFFD700,
        title: `${d.title} (${d.release_date ? d.release_date.slice(0, 4) : ''})`,
        description: d.overview || '',
        fields: [
          { name: 'Genres', value: d.genres?.length ? d.genres.map(g => g.name).join(', ') : 'N/A', inline: true },
          { name: 'User Rating', value: d.vote_average ? `${d.vote_average}/10` : 'N/A', inline: true },
        ],
      };
    } catch {
      return null;
    }
  }));
  return embeds.filter(Boolean);
}

module.exports = {
  searchMovie,
  getMovieDetails,
  buildMovieEmbeds,
};
