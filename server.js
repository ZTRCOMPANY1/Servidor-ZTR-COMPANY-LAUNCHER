const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const ADMIN_KEY = process.env.ADMIN_KEY || "troque-essa-senha";
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

function adminOk(req) {
  return req.headers["x-admin-key"] === ADMIN_KEY || req.query.key === ADMIN_KEY || req.body?.key === ADMIN_KEY;
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
      banned BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      last_seen TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS achievements (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      unlocked_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, game_id, achievement_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

function achievementInfo(id) {
  const map = {
    first_launch_: ["Primeira partida", "Iniciou o jogo pela primeira vez."],
    one_hour_: ["1 hora jogada", "Jogou pelo menos 1 hora."],
    ten_hours_: ["10 horas jogadas", "Jogou pelo menos 10 horas."]
  };

  for (const prefix of Object.keys(map)) {
    if (id.startsWith(prefix)) return { title: map[prefix][0], description: map[prefix][1] };
  }
  return { title: id, description: "Conquista desbloqueada." };
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    playerName: row.player_name,
    avatarUrl: row.avatar_url || "",
    bio: row.bio || "",
    banned: !!row.banned,
    createdAt: row.created_at ? row.created_at.toISOString?.() || row.created_at : "",
    lastSeen: row.last_seen ? row.last_seen.toISOString?.() || row.last_seen : ""
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
  for (const [user, data] of onlineLauncher) if (now - data.lastSeen > limit) onlineLauncher.delete(user);
  for (const [user, data] of onlineGames) if (now - data.lastSeen > limit) onlineGames.delete(user);
}

app.get("/", (req, res) => res.json({ ok: true, service: "ZTR Company Launcher API" }));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

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
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [username, sha256(password), playerName, authToken]
    );

    res.json({ ok: true, token: authToken, user: publicUser(result.rows[0]) });
  } catch (err) {
    if (String(err.message).includes("duplicate")) return res.json({ ok: false, error: "Esse username já existe." });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
    const user = result.rows[0];

    if (!user || user.password_hash !== sha256(password)) return res.json({ ok: false, error: "Username ou senha incorretos." });
    if (user.banned) return res.json({ ok: false, error: "Conta banida." });

    const authToken = token();
    const updated = await pool.query("UPDATE users SET auth_token=$1, last_seen=NOW() WHERE id=$2 RETURNING *", [authToken, user.id]);
    res.json({ ok: true, token: authToken, user: publicUser(updated.rows[0]) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/profile/update", async (req, res) => {
  try {
    const user = await userByToken(req.body.token);
    if (!user) return res.json({ ok: false, error: "Token inválido." });
    if (user.banned) return res.json({ ok: false, error: "Conta banida." });

    const updated = await pool.query(
      "UPDATE users SET player_name=$1, avatar_url=$2, bio=$3 WHERE id=$4 RETURNING *",
      [String(req.body.playerName || user.player_name), String(req.body.avatarUrl || ""), String(req.body.bio || ""), user.id]
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
    if (user?.banned) return res.json({ ok: false, error: "Conta banida." });

    if (user) await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [user.id]);
    onlineLauncher.set(username, {
      username,
      playerName: user?.player_name || req.body.playerName || username,
      avatarUrl: user?.avatar_url || req.body.avatarUrl || "",
      bio: user?.bio || req.body.bio || "",
      place: "launcher",
      gameId: "",
      gameName: "",
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
    if (user?.banned) return res.json({ ok: false, error: "Conta banida." });

    onlineGames.set(username, {
      username,
      playerName: user?.player_name || req.body.playerName || username,
      avatarUrl: user?.avatar_url || req.body.avatarUrl || "",
      bio: user?.bio || req.body.bio || "",
      place: "game",
      gameId: req.body.gameId || "",
      gameName: req.body.gameName || req.body.gameId || "",
      launcherVersion: req.body.launcherVersion || "",
      lastSeen: Date.now()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/offline", async (req, res) => {
  try {
    const user = await userByToken(req.body.token);
    const username = user?.username || req.body.username || "guest";
    if (req.body.place === "game") onlineGames.delete(username);
    if (req.body.place === "launcher") onlineLauncher.delete(username);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/achievements/unlock", async (req, res) => {
  try {
    const user = await userByToken(req.body.token);
    if (!user) return res.json({ ok: false, error: "Token inválido." });
    if (user.banned) return res.json({ ok: false, error: "Conta banida." });

    const gameId = String(req.body.gameId || "");
    const achievementId = String(req.body.achievementId || "");
    const info = achievementInfo(achievementId);

    await pool.query(
      `INSERT INTO achievements (user_id, game_id, achievement_id, title, description)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, game_id, achievement_id) DO NOTHING`,
      [user.id, gameId, achievementId, info.title, info.description]
    );

    res.json({ ok: true, title: info.title, description: info.description });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/achievements/my", async (req, res) => {
  try {
    const user = await userByToken(req.query.token);
    if (!user) return res.json({ ok: false, error: "Token inválido." });

    const result = await pool.query(
      "SELECT game_id, achievement_id, title, description, unlocked_at FROM achievements WHERE user_id=$1 ORDER BY unlocked_at DESC",
      [user.id]
    );

    res.json({
      ok: true,
      achievements: result.rows.map(r => ({
        gameId: r.game_id,
        achievementId: r.achievement_id,
        title: r.title,
        description: r.description,
        unlockedAt: r.unlocked_at
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/status", async (req, res) => {
  try {
    cleanup();
    const accountsResult = await pool.query("SELECT id, username, player_name, avatar_url, bio, banned, created_at, last_seen FROM users ORDER BY id DESC");
    const achievementCount = await pool.query("SELECT COUNT(*)::int AS total FROM achievements");
    const notifications = await pool.query("SELECT id, title, message, created_at FROM admin_notifications ORDER BY id DESC LIMIT 10");

    res.json({
      launcherOnline: onlineLauncher.size,
      gameOnline: onlineGames.size,
      launcherUsers: Array.from(onlineLauncher.values()),
      gameUsers: Array.from(onlineGames.values()),
      accounts: accountsResult.rows.map(publicUser),
      achievementTotal: achievementCount.rows[0].total,
      notifications: notifications.rows,
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ADMIN
app.get("/admin/stats", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "Admin key inválida." });
  cleanup();
  const users = await pool.query("SELECT COUNT(*)::int AS total FROM users");
  const banned = await pool.query("SELECT COUNT(*)::int AS total FROM users WHERE banned=true");
  const achievements = await pool.query("SELECT COUNT(*)::int AS total FROM achievements");
  res.json({
    ok: true,
    users: users.rows[0].total,
    banned: banned.rows[0].total,
    achievements: achievements.rows[0].total,
    launcherOnline: onlineLauncher.size,
    gameOnline: onlineGames.size
  });
});

app.get("/admin/users", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "Admin key inválida." });
  const result = await pool.query("SELECT id, username, player_name, avatar_url, bio, banned, created_at, last_seen FROM users ORDER BY id DESC");
  res.json({ ok: true, users: result.rows.map(publicUser) });
});

app.post("/admin/ban", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "Admin key inválida." });
  const username = String(req.body.username || "").toLowerCase();
  const banned = !!req.body.banned;
  const result = await pool.query("UPDATE users SET banned=$1 WHERE username=$2 RETURNING *", [banned, username]);
  onlineLauncher.delete(username);
  onlineGames.delete(username);
  res.json({ ok: true, user: result.rows[0] ? publicUser(result.rows[0]) : null });
});

app.post("/admin/notify", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "Admin key inválida." });
  const title = String(req.body.title || "Aviso ZTR");
  const message = String(req.body.message || "");
  await pool.query("INSERT INTO admin_notifications (title, message) VALUES ($1,$2)", [title, message]);
  res.json({ ok: true });
});

app.get("/admin/achievements", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "Admin key inválida." });
  const result = await pool.query(`
    SELECT u.username, u.player_name, a.game_id, a.achievement_id, a.title, a.unlocked_at
    FROM achievements a
    JOIN users u ON u.id = a.user_id
    ORDER BY a.unlocked_at DESC
    LIMIT 200
  `);
  res.json({ ok: true, achievements: result.rows });
});

initDb().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log("ZTR API online on port " + PORT));
}).catch(err => {
  console.error(err);
  process.exit(1);
});
