import express from "express";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";

const app = express();

const SOURCE_JSON = "https://letsembed.cc/list/hentai.json";
const TMDB_KEY = process.env.TMDB_API_KEY;
const MONGO_URI = process.env.MONGODB_URI;

let client;
let db;

async function getDB() {
  if (!client) {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("mediaCache");
  }
  return db;
}

// Get or cache TMDB data
async function getOrCreateItem(id) {
  const database = await getDB();
  const col = database.collection("items");

  const cached = await col.findOne({ _id: id });
  if (cached && Date.now() - cached.updatedAt < 3600000) {
    return cached;
  }

  let type = "movie";
  let tmdb = null;

  const movieRes = await fetch(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`);
  if (movieRes.status === 200) {
    tmdb = await movieRes.json();
    type = "movie";
  } else {
    const tvRes = await fetch(`https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_KEY}`);
    if (tvRes.status === 200) {
      tmdb = await tvRes.json();
      type = "tv";
    }
  }

  if (!tmdb) return null;

  const doc = {
    _id: id,
    type,
    title: tmdb.title || tmdb.name,
    overview: tmdb.overview,
    poster: tmdb.poster_path ? `https://image.tmdb.org/t/p/w500${tmdb.poster_path}` : null,
    backdrop: tmdb.backdrop_path ? `https://image.tmdb.org/t/p/w780${tmdb.backdrop_path}` : null,
    rating: tmdb.vote_average,
    release_date: tmdb.release_date || tmdb.first_air_date,
    genres: (tmdb.genres || []).map(g => g.name),
    updatedAt: Date.now()
  };

  await col.updateOne({ _id: id }, { $set: doc }, { upsert: true });

  return doc;
}

// Load source IDs
async function getSourceList() {
  const raw = await fetch(SOURCE_JSON).then(r => r.json());

  if (Array.isArray(raw)) return raw;
  if (raw.items) return raw.items;
  return Object.values(raw);
}

// HOME endpoint
app.get("/api/home", async (req, res) => {
  try {
    const page = Number(req.query.page || 1);
    const limit = 20;

    const list = await getSourceList();
    const start = (page - 1) * limit;
    const slice = list.slice(start, start + limit);

    const results = await Promise.all(
      slice.map(async (item) => {
        const id = String(item.id || item);
        return await getOrCreateItem(id);
      })
    );

    res.json({ page, results: results.filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// TRENDING endpoint
app.get("/api/trending", async (req, res) => {
  try {
    const list = await getSourceList();
    const shuffled = list.sort(() => 0.5 - Math.random()).slice(0, 20);

    const results = await Promise.all(
      shuffled.map(async (item) => {
        const id = String(item.id || item);
        return await getOrCreateItem(id);
      })
    );

    res.json({ results: results.filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SEARCH endpoint
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toLowerCase();
    if (!q) return res.json({ results: [] });

    const database = await getDB();
    const col = database.collection("items");

    const results = await col
      .find({ title: { $regex: q, $options: "i" } })
      .limit(20)
      .toArray();

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DETAILS endpoint
app.get("/api/details", async (req, res) => {
  try {
    const id = String(req.query.id);
    if (!id) return res.status(400).json({ error: "Missing id" });

    const data = await getOrCreateItem(id);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// EMBED endpoint (JSON only)
app.get("/api/embed", (req, res) => {
  const { id, season, episode } = req.query;
  if (!id) return res.status(400).json({ success: false });

  let path = id;
  if (season && episode) {
    path = `${id}/${season}/${episode}`;
  }

  res.json({
    success: true,
    id,
    type: season && episode ? "tv" : "movie",
    embed_url: `https://letsembed.cc/embed/hentai/?id=${path}`
  });
});

export default app;
