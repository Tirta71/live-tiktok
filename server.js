const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { WebcastPushConnection } = require("tiktok-live-connector");

const username = "mohammadchairul";
const tiktok = new WebcastPushConnection(username, {
  msToken: "PASTE_MS_TOKEN_DISINI",
});

const app = express();
const server = http.createServer(app);
const io = new Server(server); // tambahkan CORS jika beda origin
app.use(express.static("public"));
app.use(express.json());

// ===== Konfigurasi =====
const MAX_COMMENTS = 5;
const MATCH_WINDOW_MS = 300000; // 5 menit

// ===== Regex klaim =====
const RE_USN_KV = /\b(?:usn|username)\b\s*[:=]?\s*([A-Za-z0-9._-]{3,20})/i;
const RE_AT = /@([A-Za-z0-9._-]{3,20})/;

const gifters = {}; // userId -> { nickname, gifts, coins, comments[], lastGiftTs }

// ===== Utils =====
function extractClaimedUsername(comment) {
  if (!comment) return null;
  const kv = RE_USN_KV.exec(comment);
  if (kv?.[1]) return kv[1];
  const at = RE_AT.exec(comment);
  if (at?.[1]) return at[1];
  return null;
}

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

// ===== Sinkron hapus klaim + reset state di server =====
io.on("connection", (socket) => {
  socket.on("resolve_claim", ({ tiktokId } = {}) => {
    if (!tiktokId) return;
    // reset state user -> gift berikutnya dihitung dari nol
    delete gifters[tiktokId];
    // broadcast agar semua client menghapus kartu klaim tsb
    io.emit("claim_removed", { tiktokId, timestamp: Date.now() });
  });
});

// ===== TikTok connect =====
tiktok
  .connect()
  .then((state) => console.log("✅ Connected to roomId", state.roomId))
  .catch((err) => console.error("❌ Failed:", err));

// ===== Event Gift =====
tiktok.on("gift", (data) => {
  if (data?.repeatEnd === false) return; // abaikan progress

  const userId = data.uniqueId;
  const count = data?.repeatCount || 1;
  const perGiftCoins = data?.diamondCount ?? 0;
  const eventCoins = perGiftCoins * count;

  // broadcast ke UI
  io.emit("gift", {
    tiktokId: userId,
    nickname: data.nickname,
    giftName: data.giftName,
    repeatCount: count,
    diamondCount: perGiftCoins,
    coins: eventCoins,
    timestamp: Date.now(),
  });

  // buat / update state gifters
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
  rec.comments = []; // reset komentar setelah gift
  rec.lastGiftTs = Date.now();
});

// ===== Event Chat =====
tiktok.on("chat", (data) => {
  const userId = data.uniqueId;
  const text = data.comment || "";
  const rec = gifters[userId];
  if (!rec) return; // hanya tanggapi chat dari user yang sudah gift

  // batasi window waktu setelah gift
  if (MATCH_WINDOW_MS > 0 && Date.now() - rec.lastGiftTs > MATCH_WINDOW_MS) {
    return;
  }

  // buffer komentar (maks 5) + broadcast update
  if (rec.comments.length < MAX_COMMENTS) {
    rec.comments.push(text);
    if (rec.comments.length > MAX_COMMENTS) rec.comments.shift();
    io.emit("comments_update", {
      tiktokId: userId,
      nickname: rec.nickname,
      totalGifts: rec.gifts,
      totalCoins: rec.coins,
      comments: [...rec.comments],
      timestamp: Date.now(),
    });
  }

  // deteksi klaim di komentar ini
  const claimed = extractClaimedUsername(text);
  if (claimed) emitClaim({ userId, rec, claimed });
});

// ===== Start server =====
const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 Open http://localhost:${PORT}`));
