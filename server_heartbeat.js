const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const onlineLauncher = new Map();
const onlineGames = new Map();

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

app.post("/heartbeat/launcher", (req, res) => {
  const username = req.body.username || "unknown-" + Math.random();
  onlineLauncher.set(username, { ...req.body, lastSeen: Date.now() });
  res.json({ ok: true });
});

app.post("/heartbeat/game", (req, res) => {
  const username = req.body.username || "unknown-" + Math.random();
  onlineGames.set(username, { ...req.body, lastSeen: Date.now() });
  res.json({ ok: true });
});

app.get("/status", (req, res) => {
  cleanup();

  res.json({
    launcherOnline: onlineLauncher.size,
    gameOnline: onlineGames.size,
    launcherUsers: Array.from(onlineLauncher.values()),
    gameUsers: Array.from(onlineGames.values())
  });
});

app.listen(process.env.PORT || 3000, () => {
  console.log("ZTR heartbeat server online");
});
