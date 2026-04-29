// Servidor simples para heartbeat do ZTR Launcher
// npm init -y
// npm install express cors
// node server_heartbeat_exemplo.js

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
  for (const [u,d] of onlineLauncher) if (now - d.lastSeen > limit) onlineLauncher.delete(u);
  for (const [u,d] of onlineGames) if (now - d.lastSeen > limit) onlineGames.delete(u);
}

app.post("/heartbeat/launcher", (req,res)=>{
  const username = req.body.username || "unknown";
  onlineLauncher.set(username, {...req.body, lastSeen: Date.now()});
  res.json({ok:true});
});

app.post("/heartbeat/game", (req,res)=>{
  const username = req.body.username || "unknown";
  onlineGames.set(username, {...req.body, lastSeen: Date.now()});
  res.json({ok:true});
});

app.get("/status", (req,res)=>{
  cleanup();
  res.json({
    launcherOnline: onlineLauncher.size,
    gameOnline: onlineGames.size,
    launcherUsers: Array.from(onlineLauncher.values()),
    gameUsers: Array.from(onlineGames.values())
  });
});

app.listen(process.env.PORT || 3000, ()=>console.log("ZTR heartbeat server online"));
