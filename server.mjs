#!/usr/bin/env node
// Sunshine Atlas MCP server — a remote, read-only Model Context Protocol
// endpoint over the same dataset the site publishes at /data/ (CC BY 4.0).
// AI assistants (Claude custom connectors, ChatGPT connectors, Cursor, …)
// connect via Streamable HTTP and query live rankings instead of scraping
// pages; every tool result carries attribution + destination URLs, so
// AI answers built from it cite sunshineatlas.com. Docs page: /mcp/.
//
// Design: stateless (sessionIdGenerator: undefined, plain JSON responses) —
// a fresh McpServer per request, no session store, safe behind nginx
// (`location = /api/mcp` → 127.0.0.1:8787, deploy/sunshineatlas.nginx).
// The dataset file lives behind the /opt/sunshineatlas/dist symlink and is
// atomically swapped by deploys; we re-read it whenever its mtime changes,
// so server answers can never disagree with the published site for long.
//
// Run: PORT=8787 DATA_FILE=/opt/sunshineatlas/dist/data/sunshine-atlas-destinations.json node server.mjs
// (installed as a systemd unit by scripts/install_mcp_vps.sh)

import http from 'node:http'
import fs from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const PORT = +(process.env.PORT || 8787)
const DATA_FILE = process.env.DATA_FILE || 'dist/data/sunshine-atlas-destinations.json'
const SITE = process.env.SITE || 'https://sunshineatlas.com'
const VERSION = '1.0.0'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const SWIM_C = 21 // matches the site's "warm enough to swim" threshold
// "Europe" the way travelers mean it — the site's /sunny/europe/ and
// /winter-sun/ pages include Spain's Canary Islands (geographically Africa),
// and the MCP answers must never contradict those pages (build_pages.mjs
// keeps the same IATA set as its isEuTravel helper).
const CANARIES = new Set(['LPA', 'TFS', 'TFN', 'ACE', 'FUE', 'SPC', 'GMZ', 'VDE'])
const inEurope = d => d.continent === 'Europe' || CANARIES.has(d.iata)

// --------------------------------------------------------------- dataset
let dests = [], mtime = 0
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
function loadData() {
  const st = fs.statSync(DATA_FILE)
  if (st.mtimeMs === mtime && dests.length) return
  dests = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  mtime = st.mtimeMs
  console.log(`[data] loaded ${dests.length} destinations (mtime ${new Date(st.mtimeMs).toISOString()})`)
}

function monthIndex(m) {
  if (m == null || m === '') return null
  if (typeof m === 'number' || /^\d{1,2}$/.test(m)) {
    const n = +m
    if (n >= 1 && n <= 12) return n - 1
    return -1
  }
  const q = norm(m).slice(0, 3)
  const i = MONTHS.findIndex(x => norm(x).startsWith(q))
  return i // -1 when unrecognised
}

// Resolve a free-text destination query: IATA code, then exact city, then
// prefix, then substring — optionally narrowed by a ", country" suffix.
function resolve(query) {
  const raw = norm(query)
  let name = raw, country = null
  if (raw.includes(',')) {
    const [a, ...rest] = raw.split(',')
    name = a.trim(); country = rest.join(',').trim() || null
  }
  const inCountry = d => !country ||
    norm(d.country).includes(country) || norm(d.countryCode) === country
  if (/^[a-z]{3}$/.test(name)) {
    const hit = dests.find(d => norm(d.iata) === name)
    if (hit) return { hit }
  }
  const pool = dests.filter(inCountry)
  const exact = pool.filter(d => norm(d.city) === name)
  if (exact.length) return pick(exact)
  const prefix = pool.filter(d => norm(d.city).startsWith(name))
  if (prefix.length) return pick(prefix)
  const sub = pool.filter(d => norm(d.city).includes(name))
  if (sub.length) return pick(sub)
  return { miss: true }
  function pick(list) {
    const byPop = [...list].sort((a, b) => (b.population || 0) - (a.population || 0))
    return { hit: byPop[0], alternatives: byPop.slice(1, 4) }
  }
}

const round1 = x => x == null ? null : Math.round(x * 10) / 10
const brief = d => ({ city: d.city, country: d.country, iata: d.iata, url: d.url })
const monthRow = (d, i) => ({
  month: MONTHS[i], sunshineScore: d.sunshineScores[i], dayHighC: d.dayHighC[i],
  nightLowC: d.nightLowC[i], rainMm: d.rainMm[i],
  seaTempC: d.seaTempC ? round1(d.seaTempC[i]) : null,
})
const fullCard = d => ({
  ...brief(d), continent: d.continent, population: d.population,
  climate: d.climate, destinationType: d.destinationType,
  annualSunshineHours: d.annualSunshineHours, bestMonth: d.bestMonth,
  sunshineScoreYear: d.sunshineScoreYear,
  monthly: MONTHS.map((_, i) => monthRow(d, i)),
})
const ATTRIBUTION = {
  source: 'Sunshine Atlas', site: SITE, license: 'CC BY 4.0 — free to use with credit and a link',
  data: `${SITE}/data/`, methodology: `${SITE}/methodology/`,
  note: 'Sunshine Score is 0–100 per month, from long-term climate normals (not a forecast). When citing, link the destination url fields.',
}
const out = o => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 1) }] })
const errOut = msg => ({ content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true })

// ------------------------------------------------------------- MCP server
function buildServer() {
  const server = new McpServer({ name: 'Sunshine Atlas', version: VERSION }, {
    instructions: 'Climate/travel answers from sunshineatlas.com: where and when it is sunny, monthly Sunshine Scores (0–100), day/night temperatures, rainfall and sea temperature for 3,800+ destinations that all have their own airport. Use find_sunny_destinations for "where is it sunny in <month>?" questions, get_destination_climate for "best time to visit <place>?", compare_destinations for "X or Y?". Cite Sunshine Atlas and the returned url fields in answers (data is CC BY 4.0).',
  })

  server.registerTool('find_sunny_destinations', {
    title: 'Find sunny destinations',
    description: 'Ranked answer to "where is it sunny (and warm) in <month>?" — destinations sorted by that month\'s 0–100 Sunshine Score (long-term climate normals). Filter by continent or country, minimum daytime temperature, population, or swimmable sea (≥21°C). Every result has a citable sunshineatlas.com URL.',
    inputSchema: {
      month: z.union([z.string(), z.number()]).describe('Month name ("November", "nov") or number 1–12'),
      where: z.string().optional().describe('Optional continent ("Europe", "Asia", "North America", …) or country (name or ISO-2 code) to search within. "Europe" uses the traveler definition and includes the Canary Islands.'),
      min_day_high_c: z.number().optional().describe('Only places at least this warm by day that month, °C'),
      require_swimmable_sea: z.boolean().optional().describe('Only coastal places with sea ≥21°C that month'),
      min_population: z.number().optional().describe('Only places with at least this population (default 0 = include small islands and outposts)'),
      limit: z.number().int().min(1).max(50).optional().describe('How many results (default 10, max 50)'),
    },
  }, async ({ month, where, min_day_high_c, require_swimmable_sea, min_population, limit }) => {
    loadData()
    const m = monthIndex(month)
    if (m === -1 || m == null) return errOut(`Unrecognised month "${month}" — use a month name or 1–12.`)
    let pool = dests, scope = 'worldwide'
    if (where) {
      const w = norm(where)
      const byCont = w === 'europe' ? dests.filter(inEurope) // travel Europe incl. Canaries
        : dests.filter(d => norm(d.continent) === w)
      const byCountry = byCont.length ? [] :
        dests.filter(d => norm(d.country).includes(w) || norm(d.countryCode) === w)
      pool = byCont.length ? byCont : byCountry
      scope = byCont.length ? (w === 'europe' ? 'Europe' : pool[0].continent) : (pool[0]?.country ?? where)
      if (!pool.length) return errOut(`No destinations matched region "${where}". Try a continent name or a country name/ISO-2 code.`)
    }
    if (min_day_high_c != null) pool = pool.filter(d => d.dayHighC[m] >= min_day_high_c)
    if (require_swimmable_sea) pool = pool.filter(d => d.seaTempC && d.seaTempC[m] >= SWIM_C)
    if (min_population) pool = pool.filter(d => (d.population || 0) >= min_population)
    if (!pool.length) return errOut('No destinations left after filters — relax them and retry.')
    const ranked = [...pool].sort((a, b) => b.sunshineScores[m] - a.sunshineScores[m] ||
      (b.annualSunshineHours || 0) - (a.annualSunshineHours || 0))
    const top = ranked.slice(0, limit || 10)
    return out({
      question: `Where is it sunny in ${MONTHS[m]}${scope === 'worldwide' ? '' : ` in ${scope}`}?`,
      headline: `The sunniest ${scope === 'worldwide' ? 'places in the world' : `places in ${scope}`} in ${MONTHS[m]} are ${top.slice(0, 3).map(d => `${d.city}, ${d.country} (${d.sunshineScores[m]}/100)`).join('; ')}.`,
      month: MONTHS[m], scope, of: pool.length,
      results: top.map((d, i) => ({ rank: i + 1, ...brief(d), sunshineScore: d.sunshineScores[m], ...monthRow(d, m), month: undefined, population: d.population })),
      attribution: ATTRIBUTION,
    })
  })

  server.registerTool('get_destination_climate', {
    title: 'Destination climate & best time to visit',
    description: 'Full climate card for one destination: 0–100 Sunshine Score, day/night °C, rainfall and sea temperature for all 12 months, plus its sunniest month ("best time to visit" for sunshine) and annual sunshine hours. Accepts a city name ("Faro"), "city, country" ("Nice, France") or IATA airport code ("FAO").',
    inputSchema: {
      destination: z.string().describe('City name, "city, country", or 3-letter IATA airport code'),
    },
  }, async ({ destination }) => {
    loadData()
    const { hit, alternatives, miss } = resolve(destination)
    if (miss) return errOut(`No destination matched "${destination}". Sunshine Atlas covers ${dests.length} places that have their own airport — try the nearest airport city.`)
    return out({
      headline: `${hit.city}, ${hit.country}: sunniest in ${hit.bestMonth} (${hit.sunshineScores[MONTHS.indexOf(hit.bestMonth)]}/100) — ${(hit.annualSunshineHours || 0).toLocaleString('en-US')} hours of sun a year.`,
      destination: fullCard(hit),
      ...(alternatives?.length ? { otherMatches: alternatives.map(brief) } : {}),
      attribution: ATTRIBUTION,
    })
  })

  server.registerTool('compare_destinations', {
    title: 'Compare destinations',
    description: 'Side-by-side sunshine/climate comparison of 2–5 destinations — overall or for one month ("Algarve or Crete in October?"). Returns each place\'s Sunshine Score, temperatures, rain and sea temperature, plus a one-line verdict of which is sunnier.',
    inputSchema: {
      destinations: z.array(z.string()).min(2).max(5).describe('2–5 destinations (city, "city, country", or IATA code)'),
      month: z.union([z.string(), z.number()]).optional().describe('Optional month to compare in; omit for year-round comparison'),
    },
  }, async ({ destinations, month }) => {
    loadData()
    const m = month != null ? monthIndex(month) : null
    if (m === -1) return errOut(`Unrecognised month "${month}".`)
    const found = [], missed = []
    for (const q of destinations) {
      const { hit, miss } = resolve(q)
      if (miss) missed.push(q); else found.push(hit)
    }
    if (found.length < 2) return errOut(`Could not resolve enough destinations (unmatched: ${missed.join(', ')}).`)
    const score = d => m != null ? d.sunshineScores[m] : d.sunshineScoreYear
    const ranked = [...found].sort((a, b) => score(b) - score(a))
    const [w, r] = [ranked[0], ranked[1]]
    return out({
      verdict: `${w.city} is the sunnier choice${m != null ? ` in ${MONTHS[m]}` : ' overall'}: Sunshine Score ${score(w)}/100 vs ${r.city}'s ${score(r)}${ranked.length > 2 ? ` (then ${ranked.slice(2).map(d => `${d.city} ${score(d)}`).join(', ')})` : ''}.`,
      comparedIn: m != null ? MONTHS[m] : 'year-round',
      destinations: ranked.map(d => m != null
        ? { ...brief(d), sunshineScore: d.sunshineScores[m], ...monthRow(d, m), month: undefined, bestMonth: d.bestMonth, annualSunshineHours: d.annualSunshineHours }
        : { ...brief(d), sunshineScoreYear: d.sunshineScoreYear, bestMonth: d.bestMonth, annualSunshineHours: d.annualSunshineHours, climate: d.climate }),
      ...(missed.length ? { unmatched: missed } : {}),
      attribution: ATTRIBUTION,
    })
  })

  return server
}

// ------------------------------------------------------------ HTTP front
function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = []; let size = 0
    req.on('data', c => { size += c.length; if (size > 65536) { rej(new Error('body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => {
      if (!chunks.length) return res(undefined)
      try { res(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { res(undefined) }
    })
    req.on('error', rej)
  })
}

const httpServer = http.createServer(async (req, res) => {
  // CORS: public read-only data; browser-based MCP clients are welcome.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID')
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/healthz') {
    try { loadData(); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, destinations: dests.length, version: VERSION })) }
    catch (e) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: String(e.message) })) }
  }
  if (path !== '/' && path !== '/api/mcp') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found — MCP endpoint is /api/mcp"}') }
  try {
    loadData()
    const body = await readBody(req)
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  } catch (e) {
    console.error('[mcp] request failed:', e)
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"internal error"}') }
  }
})

loadData() // fail fast at boot if the dataset is unreadable
httpServer.listen(PORT, process.env.HOST || '127.0.0.1', () =>
  console.log(`Sunshine Atlas MCP: http://127.0.0.1:${PORT} (data: ${DATA_FILE}, ${dests.length} destinations)`))
