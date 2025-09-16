const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { WebcastPushConnection } = require("tiktok-live-connector");
const mysql = require("mysql2");

// ===== TikTok Config =====
const username = "mohammadchairul"; // ganti sesuai username TikTok
const tiktok = new WebcastPushConnection(username, {
  msToken: "PASTE_MS_TOKEN_DISINI", // ambil dari cookie TikTok
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(express.json());

// ===== MySQL Connection =====
const db = mysql.createConnection({
  host: "localhost",
  user: "root", // ganti sesuai setting MySQL
  password: "", // isi password MySQL kamu
  database: "spin_wheel",
});

db.connect((err) => {
  if (err) {
    console.error("❌ MySQL connection error:", err);
  } else {
    console.log("✅ MySQL Connected");
  }
});

// ===== Konfigurasi =====
const MAX_COMMENTS = 5;
const MATCH_WINDOW_MS = 300000; // 5 menit
const gifters = {};

const SPIN_DURATION_MS = 11000;
const SPIN_COOLDOWN_MS = 7000;

let spinQueue = [];
let spinning = false;

// ===== Cache untuk anti-duplikat =====
const lastInserts = new Set();
function makeKey(username, prize) {
  return `${username}|${prize}`;
}

// ===== Emit Claim ke Client =====
function emitClaim({ userId, rec, claimed }) {
  const payload = {
    tiktokId: userId,
    nickname: rec?.nickname || "Anon",
    claimedUsername: claimed,
    totalGifts: rec?.gifts ?? 0,
    totalCoins: rec?.coins ?? 0,
    lastComments: [...(rec?.comments ?? [])],
    timestamp: Date.now(),
  };
  io.emit("claim", payload);
}

// ===== Simpan Winner =====
function saveWinner(username, prize, spin = 1, sx = 0) {
  const key = makeKey(username, prize);

  // cegah duplikat dalam 3 detik terakhir
  if (lastInserts.has(key)) {
    console.log(`⚠️ Duplikat dicegah: ${username} → ${prize}`);
    return;
  }
  lastInserts.add(key);
  setTimeout(() => lastInserts.delete(key), 3000);

  const sql = `
    INSERT INTO winners (username, prize, total_spin, total_sx, status)
    VALUES (?, ?, ?, ?, 'pending')
  `;
  db.query(sql, [username, prize, spin, sx], (err) => {
    if (err) {
      console.error("❌ Gagal simpan ke DB:", err);
    } else {
      console.log(`✅ Winner tersimpan: ${username} → ${prize}`);
    }
  });
}

// ===== Spin Queue Processor =====
function processQueue() {
  if (spinning || spinQueue.length === 0) return;

  spinning = true;
  const { nickname, tiktokId, coins, spinIndex } = spinQueue.shift();

  io.emit("wheel_spin", { nickname, tiktokId, coins, spinIndex });

  setTimeout(() => {
    spinning = false;
    processQueue();
  }, SPIN_DURATION_MS + SPIN_COOLDOWN_MS);
}

// ===== Socket.IO =====
io.on("connection", (socket) => {
  console.log("🔌 Client connected");

  // hasil spin dari client
  socket.on("winner_result", (data) => {
    // data = { username, prize, spin, sx }
    console.log("➡️ Terima winner_result:", data);
    saveWinner(data.username, data.prize, data.spin, data.sx);
    io.emit("winner_saved", data);
  });

  // manual spin tester
  socket.on("manual_spin", ({ username }) => {
    io.emit("wheel_spin", { nickname: username, tiktokId: username });
  });

  // hapus klaim
  socket.on("resolve_claim", ({ tiktokId } = {}) => {
    if (!tiktokId) return;
    delete gifters[tiktokId];
    io.emit("claim_removed", { tiktokId, timestamp: Date.now() });
  });
});

// ===== TikTok Connect =====
tiktok
  .connect()
  .then((state) => console.log("✅ Connected to roomId", state.roomId))
  .catch((err) => console.error("❌ Failed:", err));

// ===== Event Gift =====
tiktok.on("gift", (data) => {
  if (data?.repeatEnd === false) return;

  const userId = data.uniqueId;
  const count = data?.repeatCount || 1;
  const perGiftCoins = data?.diamondCount ?? 0;
  const eventCoins = perGiftCoins * count;

  if (!gifters[userId]) {
    gifters[userId] = {
      nickname: data.nickname,
      gifts: 0,
      coins: 0,
      comments: [],
      lastGiftTs: Date.now(),
    };
  }

  const rec = gifters[userId];
  rec.nickname = data.nickname;
  rec.gifts += count;
  rec.coins += eventCoins;
  rec.lastGiftTs = Date.now();

  emitClaim({
    userId,
    rec,
    claimed: rec.comments[rec.comments.length - 1] || rec.nickname,
  });

  // hitung spin (1 coin = 1 spin)
  const spins = Math.floor(eventCoins / 30);
  if (spins > 0) {
    for (let i = 0; i < spins; i++) {
      spinQueue.push({
        nickname: data.nickname,
        tiktokId: userId,
        coins: eventCoins,
        spinIndex: i + 1,
      });
    }
    processQueue();
  }
});

// ===== Event Chat =====
tiktok.on("chat", (data) => {
  const userId = data.uniqueId;
  const text = data.comment || "";
  const rec = gifters[userId];
  if (!rec) return;

  if (MATCH_WINDOW_MS > 0 && Date.now() - rec.lastGiftTs > MATCH_WINDOW_MS) {
    return;
  }

  rec.comments.push(text);
  if (rec.comments.length > MAX_COMMENTS) rec.comments.shift();

  emitClaim({
    userId,
    rec,
    claimed: text || rec.nickname,
  });
});

// ===== Routes =====
app.get("/wheel", (req, res) => {
  res.sendFile(__dirname + "/public/wheel.html");
});

app.get("/riwayat", (req, res) => {
  res.sendFile(__dirname + "/public/riwayat.html");
});

app.get("/api/winners", (req, res) => {
  const sql = `
    SELECT 
      MAX(id) AS id,                
      username,
      GROUP_CONCAT(DISTINCT username_roblox SEPARATOR ', ') AS username_roblox, -- gabung semua roblox
      GROUP_CONCAT(prize ORDER BY created_at SEPARATOR ', ') AS prizes,         -- gabung hadiah
      COUNT(*) AS total_spin,
      SUM(total_sx) AS total_sx,
      MAX(created_at) AS last_win,
      status
    FROM winners
    GROUP BY username, status
    ORDER BY last_win DESC
  `;
  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: err });
    res.json(rows);
  });
});

app.post("/api/updateRoblox/:id", (req, res) => {
  const { usernameRoblox } = req.body;
  const id = req.params.id;

  db.query(
    "UPDATE winners SET username_roblox = ? WHERE id = ?",
    [usernameRoblox, id],
    (err, result) => {
      if (err) {
        console.error("❌ DB Error:", err);
        return res.status(500).json({ success: false, error: err.message });
      }
      res.json({ success: true, updated: result.affectedRows > 0 });
    }
  );
});

app.post("/api/claim/:id", (req, res) => {
  const id = req.params.id;

  // 1. Cari username dari id yang diklik
  db.query("SELECT username FROM winners WHERE id = ?", [id], (err, rows) => {
    if (err) {
      console.error("❌ Select Error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
    if (rows.length === 0) {
      return res.json({ success: false, error: "ID tidak ditemukan" });
    }

    const username = rows[0].username;

    // 2. Update semua row pending dengan username sama
    db.query(
      "UPDATE winners SET status = 'selesai' WHERE username = ? AND status = 'pending'",
      [username],
      (err2, result) => {
        if (err2) {
          console.error("❌ Claim Error:", err2);
          return res.status(500).json({ success: false, error: err2.message });
        }
        console.log(
          `✅ Claim sukses: ${result.affectedRows} row untuk username ${username}`
        );
        res.json({ success: true, claimed: result.affectedRows });
      }
    );
  });
});

// ===== Start Server =====
const PORT = 3000;
server.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
