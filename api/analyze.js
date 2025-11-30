// api/analyze.js
// Audio analysis microservice handler (Node serverless, @vercel/node compatible)
// Accepts JSON { data: "<base64>" } or { url } or raw binary.
// Provides metadata, simple audio heuristics, and optional ML call to external API.

const DEFAULT_MAX_BYTES = 40 * 1024 * 1024; // 40MB for audio

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-worker-secret"
  };
}
function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(JSON.stringify(body, null, 2));
}
function jsonError(res, status, message, detail) {
  const out = { ok: false, error: message };
  if (detail) out.detail = detail;
  return jsonResponse(res, status, out);
}
function parseBase64(b64) {
  try {
    const m = b64.match(/^data:(.+);base64,(.*)$/);
    if (m) b64 = m[2];
    return Buffer.from(b64, "base64");
  } catch (e) { return null; }
}
function detectMimeFromBuffer(buf) {
  if (!buf || buf.length < 12) return "application/octet-stream";
  if (buf.slice(0,4).toString() === "RIFF" && buf.slice(8,12).toString() === "WAVE") return "audio/wav";
  if (buf.slice(0,3).toString() === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (buf.slice(0,4).toString() === "fLaC") return "audio/flac";
  return "application/octet-stream";
}
function entropyEstimate(buf) {
  if (!buf || buf.length === 0) return 0;
  const freq = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) freq[buf[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    if (!freq[i]) continue;
    const p = freq[i] / buf.length;
    sum += -p * Math.log2(p);
  }
  return Number((sum / 8).toFixed(3));
}
function pHashStub(buf) {
  try {
    let s = 2166136261 >>> 0;
    for (let i = 0; i < Math.min(buf.length, 8192); i += 4) {
      s = Math.imul(s ^ buf[i], 16777619) >>> 0;
    }
    return ("00000000" + (s >>> 0).toString(16)).slice(-8);
  } catch (e) { return null; }
}
async function safeFetch(url, opts = {}) {
  try {
    const controller = new AbortController();
    const timeout = opts.timeout || 20000;
    const t = setTimeout(() => controller.abort(), timeout);
    const r = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(t);
    return r;
  } catch (e) { return null; }
}

// Optional remote audio ML call (AssemblyAI / custom API)
async function callRemoteAudioAnalysis(buffer, mimeType) {
  try {
    const remoteUrl = String(process.env.AUDIO_ANALYSIS_URL || "").trim();
    const key = String(process.env.AUDIO_ANALYSIS_API_KEY || "").trim();
    if (!remoteUrl) return null;

    // Example: POST base64 to remote API
    const base64 = buffer.toString("base64");
    const body = JSON.stringify({ data: base64, mimetype: mimeType });

    const resp = await safeFetch(remoteUrl, {
      method: "POST",
      headers: key ? { "Content-Type": "application/json", Authorization: `Bearer ${key}` } : { "Content-Type": "application/json" },
      body,
      timeout: 45000
    });
    if (!resp) return null;
    const txt = await resp.text().catch(() => null);
    try { return txt ? JSON.parse(txt) : null; } catch (e) { return { raw: txt }; }
  } catch (e) { return null; }
}

// Auth helpers (same pattern)
function isAuthRequired() {
  try { return String(process.env.ADMIN_API_KEYS || "").trim().length > 0; } catch (e) { return false; }
}
function validateApiKey(key) {
  if (!key) return false;
  const raw = String(process.env.ADMIN_API_KEYS || "").trim();
  const allowed = raw.split(",").map(s => s.trim()).filter(Boolean);
  return allowed.includes(key);
}

// Main handler
module.exports = async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders()); res.end(); return; }

    if (isAuthRequired()) {
      const key = req.headers["x-api-key"] || req.headers["authorization"];
      if (!validateApiKey(key)) return jsonError(res, 401, "Unauthorized: missing or invalid x-api-key");
    }

    if (req.method === "GET") {
      return jsonResponse(res, 200, { ok: true, service: "MediaProof Audio", version: "enterprise-1.0", timestamp: new Date().toISOString() });
    }

    if (req.method !== "POST") return jsonError(res, 405, "Only POST allowed");

    let buf = null;
    let contentType = (req.headers["content-type"] || "").toLowerCase();

    if (req.body && Buffer.isBuffer(req.body)) {
      buf = req.body;
    } else if (contentType.includes("application/json")) {
      let body = req.body;
      if (!body) {
        body = await new Promise(resolve => {
          let d = "";
          req.on("data", c => d += c);
          req.on("end", () => resolve(d ? JSON.parse(d) : {}));
          req.on("error", () => resolve({}));
        }).catch(() => ({}));
      }
      if (body.data) {
        buf = parseBase64(String(body.data));
        contentType = body.mimetype || contentType || detectMimeFromBuffer(buf);
      } else if (body.url) {
        const fetched = await safeFetch(String(body.url));
        if (!fetched || !fetched.ok) return jsonError(res, 400, "Failed to fetch remote url");
        const ab = await fetched.arrayBuffer().catch(() => null);
        if (!ab) return jsonError(res, 400, "Failed to read remote content");
        buf = Buffer.from(ab);
        contentType = fetched.headers.get("content-type") || detectMimeFromBuffer(buf);
      } else {
        return jsonError(res, 400, "JSON must include `data` (base64) or `url`");
      }
    } else {
      const chunks = [];
      await new Promise(resolve => {
        req.on("data", c => chunks.push(c));
        req.on("end", resolve);
        req.on("error", resolve);
      });
      if (chunks.length) buf = Buffer.concat(chunks);
      contentType = contentType || detectMimeFromBuffer(buf);
    }

    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return jsonError(res, 400, "No file data found");
    if (buf.length > (parseInt(process.env.MAX_BYTES || DEFAULT_MAX_BYTES))) return jsonError(res, 413, "File too large");

    // Basic metadata
    const crypto = require("crypto");
    const metadata = {
      byteLength: buf.length,
      mimeType: contentType || detectMimeFromBuffer(buf),
      filename: (req.body && req.body.filename) || null,
      sha256: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)
    };

    // Quick heuristics
    const heuristics = {
      entropy: entropyEstimate(buf),
      pHash: pHashStub(buf),
      mimeGuess: detectMimeFromBuffer(buf),
      // WAV parsing (header detection)
      audio: null
    };

    if (metadata.mimeType === "audio/wav") {
      // Parse WAV header minimally to extract sample rate, channels, duration (approx)
      try {
        // WAV: bytes 22-23 channels (uint16le), 24-27 sampleRate (uint32le), 40-43 dataSize (uint32le)
        const channels = buf.readUInt16LE(22);
        const sampleRate = buf.readUInt32LE(24);
        const byteRate = buf.readUInt32LE(28);
        const dataSize = buf.readUInt32LE(40);
        const duration = dataSize / byteRate;
        heuristics.audio = { channels, sampleRate, byteRate, dataSize, duration: Number(duration.toFixed(3)) };
      } catch (e) {
        heuristics.audio = null;
      }
    } else if (metadata.mimeType === "audio/mpeg") {
      // rough estimate: mp3 frame-based parsing is complex; provide size-only
      heuristics.audio = { note: "mp3 detected; detailed parsing not implemented", size: buf.length };
    }

    // Optional remote ML analysis
    let remote = null;
    const remoteRes = await callRemoteAudioAnalysis(buf, metadata.mimeType).catch(() => null);
    if (remoteRes) remote = remoteRes;

    // Composite scoring example
    const aiProb = (remote && (remote.score || remote.probability)) ? Number(remote.score || remote.probability) : 0;
    const composite = Math.round(((aiProb * 0.7) + (heuristics.entropy * 0.25)) * 100) / 100;

    const result = { metadata, heuristics, remote, trustScore: { composite, breakdown: { ai: aiProb, entropy: heuristics.entropy } }, processedAt: new Date().toISOString() };

    // optional sink
    try {
      const sink = String(process.env.STORAGE_WEBHOOK_URL || "").trim();
      if (sink) {
        fetch(sink, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "audio", result, timestamp: new Date().toISOString() }) }).catch(() => {});
      }
    } catch (e) {}

    return jsonResponse(res, 200, { ok: true, result });
  } catch (err) {
    console.error("audio analyze error:", err);
    return jsonError(res, 500, "internal", String(err));
  }
};
