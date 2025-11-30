// api/analyze.js  (Audio microservice)
// Paste into your audio-service repo under /api/analyze.js
// Node.js serverless (CommonJS). No special runtime config.

const crypto = require("crypto");
const { URL } = require("url");

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB

function jsonResponse(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-worker-secret");
  res.statusCode = status;
  res.end(JSON.stringify(body, null, 2));
}

function jsonError(res, status, message, detail) {
  const out = { ok: false, error: message };
  if (detail) out.detail = String(detail);
  return jsonResponse(res, status, out);
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function simpleEntropyEstimate(buffer) {
  try {
    const freq = new Uint32Array(256);
    for (let i = 0; i < buffer.length; i++) freq[buffer[i]]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      if (freq[i] > 0) {
        const p = freq[i] / buffer.length;
        sum += -p * Math.log2(p);
      }
    }
    return Math.round((sum / 8) * 100) / 100;
  } catch (e) {
    return 0;
  }
}

function base64FromBuffer(buf) {
  return Buffer.from(buf).toString("base64");
}

async function safeFetchJson(url, opts = {}, timeout = 15_000) {
  if (typeof fetch === "function") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      const txt = await resp.text().catch(() => "");
      try {
        return { ok: resp.ok, status: resp.status, json: txt ? JSON.parse(txt) : null, text: txt };
      } catch {
        return { ok: resp.ok, status: resp.status, json: null, text: txt };
      }
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  } else {
    return { ok: false, error: "fetch unavailable" };
  }
}

async function callExternalAudio(payload) {
  const url = String(process.env.AUDIO_BACKEND_URL || "").trim();
  if (!url) return null;
  const headers = { "Content-Type": "application/json" };
  const workerSecret = String(process.env.WORKER_SECRET || "").trim();
  if (workerSecret) headers["X-Worker-Secret"] = workerSecret;
  const resp = await safeFetchJson(url, { method: "POST", headers, body: JSON.stringify(payload) }, 20000);
  return resp;
}

async function readRequestBody(req) {
  if (req.body) return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on("data", (d) => {
      chunks.push(d);
      len += d.length;
      if (len > MAX_BYTES + 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks, len)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return jsonResponse(res, 204, null);
    if (req.method !== "POST" && req.method !== "GET") return jsonError(res, 405, "Only POST allowed");

    if (req.method === "GET") {
      return jsonResponse(res, 200, { ok: true, service: "audio-service", version: "enterprise-1.0" });
    }

    const contentType = (req.headers["content-type"] || "").toLowerCase();

    let buffer = null;
    let filename = `upload-${Date.now()}`;
    let mimetype = "audio/*";

    if (contentType.includes("application/json")) {
      const raw = await readRequestBody(req);
      let body = raw;
      try {
        if (Buffer.isBuffer(raw)) body = JSON.parse(raw.toString("utf8"));
      } catch (e) {
        return jsonError(res, 400, "Invalid JSON body", e.message);
      }
      if (!body) return jsonError(res, 400, "Empty JSON body");
      if (body.url) {
        if (typeof fetch !== "function") return jsonError(res, 500, "Server fetch not available");
        const r = await fetch(String(body.url), { method: "GET" }).catch((e) => ({ ok: false, error: String(e) }));
        if (!r || !r.ok) return jsonError(res, 400, "Failed to fetch remote url", r && (r.status || r.error));
        const ab = await r.arrayBuffer().catch(() => null);
        if (!ab) return jsonError(res, 400, "Failed to read remote content");
        buffer = Buffer.from(ab);
        mimetype = r.headers.get("content-type") || mimetype;
        try {
          filename = (new URL(body.url)).pathname.split("/").pop() || filename;
        } catch {}
      } else if (body.data) {
        try {
          buffer = Buffer.from(String(body.data), "base64");
        } catch (e) {
          return jsonError(res, 400, "Invalid base64 data");
        }
        filename = body.filename || filename;
        mimetype = body.mimetype || mimetype;
      } else {
        return jsonError(res, 400, "JSON must include `data` (base64) or `url`");
      }
    } else {
      const raw = await readRequestBody(req).catch((e) => null);
      if (!raw || raw.length === 0) return jsonError(res, 400, "No file provided");
      buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      mimetype = contentType || mimetype;
    }

    if (!buffer) return jsonError(res, 400, "No file data found");
    if (buffer.length > MAX_BYTES) return jsonError(res, 413, `File too large (max ${MAX_BYTES} bytes)`);

    // Metadata
    const metadata = {
      filename,
      mimetype,
      size: buffer.length,
      sha256: sha256Hex(buffer)
    };

    // Heuristics
    const heuristics = {
      entropy: simpleEntropyEstimate(buffer),
      // audio-specific placeholder signals
      zeroByteRatio: (() => {
        let z = 0;
        for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0) z++;
        return Math.round((z / buffer.length) * 100) / 100;
      })()
    };

    // Call any configured audio model / microservice (enterprise-grade)
    let audioReport = null;
    try {
      const payload = { filename, mimetype, sha256: metadata.sha256, data: base64FromBuffer(buffer) };
      const ext = await callExternalAudio(payload);
      audioReport = ext;
    } catch (e) {
      audioReport = { error: String(e) };
    }

    // Local quick checks (non-invasive)
    const quick = {
      isLikelySpeech: (function guessSpeech(buf) {
        // heuristic: many non-zero bytes + moderate entropy -> likely speech
        const entropy = heuristics.entropy;
        const zeroRatio = heuristics.zeroByteRatio;
        return entropy > 3 && zeroRatio < 0.7;
      })(),
      likelyFormat: (() => {
        // naive: check magic bytes
        if (buffer.slice(0,4).toString("ascii").includes("RIFF")) return "wav";
        if (buffer.slice(0,3).toString("ascii") === "ID3") return "mp3";
        if (buffer.slice(0,4).toString("ascii").includes("fLaC")) return "flac";
        return "unknown";
      })()
    };

    const report = {
      ok: true,
      metadata,
      heuristics,
      quick,
      audioReport,
      processedAt: new Date().toISOString()
    };

    // Optional store
    try {
      const sink = String(process.env.STORAGE_WEBHOOK_URL || "").trim();
      if (sink) {
        (async () => {
          try {
            await fetch(sink, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "audio", metadata, report, timestamp: new Date().toISOString() })
            });
          } catch (_) {}
        })();
      }
    } catch (_) {}

    return jsonResponse(res, 200, report);
  } catch (err) {
    console.error("audio/analyze error:", err && err.stack ? err.stack : String(err));
    return jsonError(res, 500, "Internal Server Error", String(err));
  }
};
