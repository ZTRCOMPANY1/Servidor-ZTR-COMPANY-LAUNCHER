const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const onlineLauncher = new Map();
const onlineGames = new Map();

function sha256(text) {
  return crypto.createHash("sha256").update("ZTR-SALT-" + text).digest("hex");
}

function token() {
  return crypto.randomBytes(32).toString("hex");
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      player_name TEXT NOT NULL,
      avatar_url TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      auth_token TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      last_seen TIMESTAMP DEFAULT NOW()
    );
  `);
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    playerName: row.player_name,
    avatarUrl: row.avatar_url || "",
    bio: row.bio || "",
    createdAt: row.created_at ? row.created_at.toISOString?.() || row.created_at : ""
  };
}

async function userByToken(authToken) {
  if (!authToken) return null;
  const result = await pool.query("SELECT * FROM users WHERE auth_token=$1", [authToken]);
  return result.rows[0] || null;
}

function cleanup() {
  const now = Date.now();
  const limit = 30000;

  for (const [user, data] of onlineLauncher) {
    if (now - data.lastSeen > limit) onlineLauncher.delete(user);
  }

  for (const [user, data] of onlineGames) {
    if (now - data.lastSeen > limit) onlineGames.delete(user);
  }
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "ZTR Company Launcher API" });
});

app.post("/auth/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const playerName = String(req.body.playerName || username).trim();

    if (username.length < 3) return res.json({ ok: false, error: "Username muito curto." });
    if (password.length < 4) return res.json({ ok: false, error: "Senha muito curta." });

    const authToken = token();

    const result = await pool.query(
      `INSERT INTO users (username, password_hash, player_name, auth_token)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [username, sha256(password), playerName, authToken]
    );

    res.json({ ok: true, token: authToken, user: publicUser(result.rows[0]) });
  } catch (err) {
    if (String(err.message).includes("duplicate")) {
      return res.json({ ok: false, error: "Esse username já existe." });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
    const user = result.rows[0];

    if (!user || user.password_hash !== sha256(password)) {
      return res.json({ ok: false, error: "Username ou senha incorretos." });
    }

    const authToken = token();

    const updated = await pool.query(
      "UPDATE users SET auth_token=$1, last_seen=NOW() WHERE id=$2 RETURNING *",
      [authToken, user.id]
    );

    res.json({ ok: true, token: authToken, user: publicUser(updated.rows[0]) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/profile/update", async (req, res) => {
  try {
    const user = await userByToken(req.body.token);
    if (!user) return res.json({ ok: false, error: "Token inválido. Faça login novamente." });

    const playerName = String(req.body.playerName || user.player_name).trim();
    const avatarUrl = String(req.body.avatarUrl || "").trim();
    const bio = String(req.body.bio || "").trim();

    const updated = await pool.query(
      "UPDATE users SET player_name=$1, avatar_url=$2, bio=$3 WHERE id=$4 RETURNING *",
      [playerName, avatarUrl, bio, user.id]
    );

    res.json({ ok: true, token: user.auth_token, user: publicUser(updated.rows[0]) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/heartbeat/launcher", async (req, res) => {
  try {
    const user = await userByToken(req.body.token);
    const username = user?.username || req.body.username || "guest";

    if (user) {
      await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [user.id]);
    }

    onlineLauncher.set(username, {
      username,
      playerName: user?.player_name || req.body.playerName || username,
      avatarUrl: user?.avatar_url || req.body.avatarUrl || "",
      bio: user?.bio || req.body.bio || "",
      place: "launcher",
      gameId: "",
      launcherVersion: req.body.launcherVersion || "",
      lastSeen: Date.now()
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/heartbeat/game", async (req, res) => {
  try {
    const user = await userByToken(req.body.token);
    const username = user?.username || req.body.username || "guest";

    onlineGames.set(username, {
      username,
      playerName: user?.player_name || req.body.playerName || username,
      avatarUrl: user?.avatar_url || req.body.avatarUrl || "",
      bio: user?.bio || req.body.bio || "",
      place: "game",
      gameId: req.body.gameId || "",
      launcherVersion: req.body.launcherVersion || "",
      lastSeen: Date.now()
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/offline", async (req, res) => {
  const username = req.body.username || "guest";
  if (req.body.place === "game") onlineGames.delete(username);
  if (req.body.place === "launcher") onlineLauncher.delete(username);
  res.json({ ok: true });
});

app.get("/status", async (req, res) => {
  try {
    cleanup();

    const accountsResult = await pool.query(
      "SELECT id, username, player_name, avatar_url, bio, created_at FROM users ORDER BY id DESC"
    );

    res.json({
      launcherOnline: onlineLauncher.size,
      gameOnline: onlineGames.size,
      launcherUsers: Array.from(onlineLauncher.values()),
      gameUsers: Array.from(onlineGames.values()),
      accounts: accountsResult.rows.map(publicUser)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

initDb().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log("ZTR API online on port " + PORT));
});
