// Outbound HTTP for integrations, with SSRF protection.
// Any server admin can enter a URL, so by default the bot refuses to call private/LAN/loopback
// addresses (otherwise it could be used to probe the host's network). Guilds listed in
// INTEGRATIONS_PRIVATE_GUILDS (comma-separated IDs, e.g. the bot owner's) may use private addresses.
const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_MS = 8000;

function privateGuilds() {
  return new Set((process.env.INTEGRATIONS_PRIVATE_GUILDS || '').split(',').map(s => s.trim()).filter(Boolean));
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||            // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);    // CGNAT (incl. Tailscale)
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

// Normalize and validate a user-entered base URL; returns { url } or { error }
function normalizeBaseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { url: '' };
  let u;
  try { u = new URL(raw); } catch { return { error: `"${raw}" isn't a valid URL (include http:// or https://).` }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { error: 'Only http:// and https:// URLs are allowed.' };
  if (u.username || u.password) return { error: 'Don\'t put credentials in the URL; use the API key/token field.' };
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

async function assertAllowedHost(guildId, url) {
  if (privateGuilds().has(guildId)) return;
  const { hostname } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
  if (addrs.some(isPrivateAddress)) {
    throw new Error(`${hostname} is a private/local address. Use a public URL, or ask the bot owner to allow private addresses for this server.`);
  }
}

// fetch JSON from an integration; throws Error with a readable message on failure
async function fetchJson(guildId, url, { method = 'GET', headers = {}, body } = {}) {
  await assertAllowedHost(guildId, url);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', // a redirect could point somewhere the host check didn't approve
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'Timed out connecting.' : `Couldn't connect (${e.cause?.code || e.message}).`);
  }
  if (res.status === 401 || res.status === 403) throw new Error('Unauthorized: check the API key/token.');
  if (!res.ok) throw new Error(`Server returned HTTP ${res.status}.`);
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { throw new Error('Unexpected (non-JSON) response; check the URL.'); }
}

module.exports = { fetchJson, normalizeBaseUrl };
