import express from "express";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";

const app = express();

const SOURCE_JSON = "https://letsembed.cc/list/hentai.json";
const TMDB_KEY = process.env.TMDB_API_KEY;
const MONGO_URI = process.env.MONGODB_URI;

let client, db;

// --- DB ---
async function getDB() {
  if (!client) {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("mediaCache");
  }
  return db;
}

// --- Helpers ---
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
  return r.json();
}

async function getGenreMap() {
  const db = await getDB();
  const col = db.collection("meta");
  const cached = await col.findOne({ _id: "genres" });
  if (cached && Date.now() - cached.updatedAt < 86400000) return cached.data;

  const [movieRes, tvRes] = await Promise.all([
    fetchJson(`https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_KEY}`),
    fetchJson(`https://api.themoviedb.org/3/genre/tv/list?api_key=${TMDB_KEY}`)
  ]);

  const map = {};
  movieRes.genres.forEach(g => map[g.id] = g.name);
  tvRes.genres.forEach(g => { if (!map[g.id]) map[g.id] = g.name; });

  await col.updateOne(
    { _id: "genres" },
    { $set: { data: map, updatedAt: Date.now() } },
    { upsert: true }
  );
  return map;
}

async function fetchTmdbWithType(id) {
  const m = await fetch(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`);
  if (m.status === 200) return { type: "movie", data: await m.json() };
  const t = await fetch(`https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_KEY}`);
  if (t.status === 200) return { type: "tv", data: await t.json() };
  return null;
}

async function getOrCreateItem(id) {
  const db = await getDB();
  const col = db.collection("items");

  const cached = await col.findOne({ _id: id });
  if (cached && Date.now() - cached.updatedAt < 3600000) return cached;

  const result = await fetchTmdbWithType(id);
  if (!result) {
    return { _id: id, type: "unknown", error: "Not found", updatedAt: Date.now() };
  }

  const { type, data: tmdb } = result;
  const genreMap = await getGenreMap();
  const genres = (tmdb.genres || []).map(g => genreMap[g.id]).filter(Boolean);

  const doc = {
    _id: id,
    type,
    title: tmdb.title || tmdb.name,
    overview: tmdb.overview,
    poster: tmdb.poster_path ? `https://image.tmdb.org/t/p/w500${tmdb.poster_path}` : null,
    backdrop: tmdb.backdrop_path ? `https://image.tmdb.org/t/p/w780${tmdb.backdrop_path}` : null,
    rating: tmdb.vote_average,
    release_date: tmdb.release_date || tmdb.first_air_date,
    genres,
    raw_tmdb: tmdb,
    updatedAt: Date.now()
  };

  await col.updateOne({ _id: id }, { $set: doc }, { upsert: true });
  return doc;
}

async function getSourceIds() {
  const source = await fetchJson(SOURCE_JSON);
  const arr = Array.isArray(source) ? source : Object.values(source);
  return arr.map(x => (typeof x === "object" ? x.id : x)).filter(Boolean);
}

// --- Endpoints ---

// Home: curated sections
app.get("/api/home", async (req, res) => {
  try {
    const ids = await getSourceIds();
    const pick = (n) => ids.sort(() => 0.5 - Math.random()).slice(0, n);

    const sections = {
      trending: await Promise.all(pick(10).map(getOrCreateItem)),
      popular: await Promise.all(pick(10).map(getOrCreateItem)),
      latest: await Promise.all(pick(10).map(getOrCreateItem))
    };

    res.json(sections);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trending (from TMDB directly, cached via items)
app.get("/api/trending", async (req, res) => {
  try {
    const type = req.query.type === "tv" ? "tv" : "movie";
    const page = Number(req.query.page || 1);

    const data = await fetchJson(
      `https://api.themoviedb.org/3/trending/${type}/week?api_key=${TMDB_KEY}&page=${page}`
    );

    const results = await Promise.all(
      data.results.map(x => getOrCreateItem(String(x.id)))
    );

    res.json({ page, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search by title (MongoDB-first, TMDB fallback)
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ results: [] });

    const db = await getDB();
    const col = db.collection("items");

    // text-like regex search in cached docs
    let results = await col.find({
      title: { $regex: q, $options: "i" }
    }).limit(20).toArray();

    // fallback to TMDB if not enough
    if (results.length < 5) {
      const tmdb = await fetchJson(
        `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_KEY}&query=${encodeURIComponent(q)}`
      );
      const more = await Promise.all(
        tmdb.results.map(x => getOrCreateItem(String(x.id)))
      );
      results = [...results, ...more];
    }

    res.json({ query: q, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Details
app.get("/api/details", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const item = await getOrCreateItem(id);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Random
app.get("/api/random", async (req, res) => {
  try {
    const ids = await getSourceIds();
    const id = ids[Math.floor(Math.random() * ids.length)];
    const item = await getOrCreateItem(id);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List (paginated)
app.get("/api/list", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(50, Number(req.query.limit || 20));

    const ids = await getSourceIds();
    const start = (page - 1) * limit;
    const slice = ids.slice(start, start + limit);

    const results = await Promise.all(slice.map(getOrCreateItem));

    res.json({
      page,
      per_page: limit,
      total: ids.length,
      results
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

      // JSON-only embed endpoint
app.get("/api/embed", (req, res) => {
  const { id, season, episode } = req.query;

  if (!id) {
    return res.status(400).json({
      success: false,
      error: "Missing id"
    });
  }

  let path = id;

  // If TV episode, append season/episode
  if (season && episode) {
    path = `${id}/${season}/${episode}`;
  }

  const url = `https://letsembed.cc/embed/hentai/?id=${path}`;

  res.json({
    success: true,
    type: season && episode ? "tv" : "movie",
    tmdb_id: id,
    season: season ? Number(season) : null,
    episode: episode ? Number(episode) : null,
    embed_url: url
  });
});
  

export default app;
      
