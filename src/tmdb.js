// tmdb.js: Handles TheMovieDB API lookups
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

async function searchMovie(title) {
  const url = `${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('TMDB search failed');
  const data = await res.json();
  return data.results;
}

async function getMovieDetails(id) {
  const url = `${TMDB_BASE}/movie/${id}?api_key=${TMDB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('TMDB details failed');
  return await res.json();
}

module.exports = {
  searchMovie,
  getMovieDetails,
};
