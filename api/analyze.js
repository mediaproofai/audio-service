/**
 * Enterprise-grade Audio Microservice (Vercel Serverless)
 *
 * - No external npm deps (reduces npm install/build errors)
 * - Accepts:
 *    - JSON { data: "<base64>", filename, mimetype }
 *    - JSON { url: "<public-url>" } -> function fetches remote binary
 *    - Raw binary body with audio/* Content-Type
 * - Auth: X-Worker-Secret (header) compared to env WORKER_SECRET (optional)
 * - Optional integration to external microservices via env:
 *    TRANSCRIPTION_URL, AUDIO_FORGERY_URL, STORAGE_WEBHOOK
 *
 * Notes:
 * - Keep this file named `api/analyze.js` so Vercel serves it at /api/analyze
 * - Configure environment variables in Vercel dashboard (Settings > Environment Variables)
 */

const { createHash } = require("crypto");
const { URL } = require("url");
const http = require("http");
const https = require("https");

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB - keep reasonable for serverless
const FETCH_TIMEOUT = 15000; // ms

function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // CORS for cross-origin requests from your frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Worker-Secret");
  res.end(JSON.stringify(body, null, 2));
}

function jsonError(res, status, message, detail) {
  const out = { ok: false, error: message };
  if (detail) out.detail = detail;
  return jsonResponse(res, status, out);
}

function bufferFromBase64(b64) {
  try {
    return Buffer.from(b64, "base64");
  } catch (e) {
    return null;
  }
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function isAudioMime(ctype) {
  if (!ctype) return false;
  return ctype.startsWith("audio/") || ctype.includes("mpeg") || ctype.includes("wav") || ctype.includes("ogg") || ctype.includes("flac");
}

async function fetchWithTimeout(url, timeout = FETCH_TIMEOUT, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request(
        u,
        { method: "GET", headers, timeout },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`fetch failed: ${res.statusCode}`));
            res.resume();
            return;
          }
          const chunks = [];
          let bytes = 0;
          res.on("data", (c) => {
            bytes += c.length;
            if (bytes > MAX_BYTES) {
              req.destroy();
              reject(new Error("remote file too large"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            resolve({ buffer: Buffer.concat(chunks), headers: res.headers });
          });
        }
      );
      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("fetch timeout"));
      });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

/* --------------- Microservice call helper (best-effort) --------------- */
async function callExternalJson(url, payload, headers = {}, timeout = 8000) {
  try {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    return await new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(payload));
      const req = lib.request(
        u,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": data.length,
            ...headers
          },
          timeout
        },
        (resp) => {
          const chunks = [];
          resp.on("data", (d) => chunks.push(d));
          resp.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            try {
              const json = JSON.parse(text);
              resolve(json);
            } catch (e) {
              resolve({ raw: text, status: resp.statusCode });
            }
          });
        }
      );
      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.write(data);
      req.end();
    });
  } catch (e) {
    return { error: String(e) };
  }
}

/* -------------------- Basic heuristic analysis -------------------- */
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
    const maxEntropy = 8;
    return Math.round((sum / maxEntropy) * 100) / 100;
  } catch (e) {
    return 0;
  }
}

function percentZeros(buffer) {
  if (!buffer || buffer.length === 0) return 0;
  let z = 0;
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0) z++;
  return Math.round((z / buffer.length) * 10000) / 100;
}

/* ========================= Request handler ========================= */
module.exports = async function handler(req, res) {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Worker-Secret");
      return res.end();
    }

    // Only POST for analysis
    if (req.method !== "POST") return jsonError(res, 405, "Only POST allowed");

    // Auth (optional). If WORKER_SECRET is set in env, require it.
    try {
      const workerSecret = (process.env.WORKER_SECRET || "").trim();
      if (workerSecret) {
        const headerKey = (req.headers["x-worker-secret"] || req.headers["x-worker-secret".toLowerCase()] || req.headers["authorization"] || "").trim();
        if (!headerKey) return jsonError(res, 401, "Unauthorized: missing X-Worker-Secret");
        // allow "Bearer <key>" or raw key
        const provided = headerKey.startsWith("Bearer ") ? headerKey.slice(7).trim() : headerKey;
        if (provided !== workerSecret) return jsonError(res, 401, "Unauthorized: invalid secret");
      }
    } catch (e) {
      // If any error, deny access
      return jsonError(res, 401, "Unauthorized");
    }

    // Read content-type
    const ctype = (req.headers["content-type"] || "").toLowerCase();

    // Prepare variables
    let buffer = null;
    let filename = `upload-${Date.now()}.bin`;
    let mimetype = "application/octet-stream";

    // If JSON body with base64 or url
    if (ctype.includes("application/json")) {
      // read json body
      const raw = await new Promise((resolve, reject) => {
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => resolve(d));
        req.on("error", reject);
      }).catch(() => null);

      if (!raw) return jsonError(res, 400, "Empty JSON body");
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch (e) {
        return jsonError(res, 400, "Invalid JSON");
      }

      // Accept base64 'data' OR 'url'
      if (body.data) {
        const b = bufferFromBase64(String(body.data));
        if (!b) return jsonError(res, 400, "Invalid base64 data");
        buffer = b;
        if (body.filename) filename = String(body.filename);
        if (body.mimetype) mimetype = String(body.mimetype);
      } else if (body.url) {
        try {
          const fetched = await fetchWithTimeout(String(body.url), FETCH_TIMEOUT);
          if (!fetched || !fetched.buffer) return jsonError(res, 400, "Failed to fetch remote url");
          buffer = fetched.buffer;
          mimetype = (fetched.headers && fetched.headers["content-type"]) || mimetype;
          filename = body.filename || (new URL(body.url)).pathname.split("/").pop() || filename;
        } catch (e) {
          return jsonError(res, 400, "Failed to fetch URL", String(e));
        }
      } else {
        return jsonError(res, 400, "JSON must include 'data' (base64) or 'url'");
      }
    } else if (ctype && (ctype.startsWith("audio/") || ctype.startsWith("application/octet-stream") || ctype.includes("mpeg") || ctype.includes("wav"))) {
      // Raw binary upload
      buffer = await new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        req.on("data", (c) => {
          bytes += c.length;
          if (bytes > MAX_BYTES) {
            req.destroy();
            reject(new Error("file too large"));
            return;
          }
          chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      }).catch((e) => {
        return jsonError(res, 400, "Failed to read binary body", String(e));
      });
      mimetype = ctype || mimetype;
    } else {
      // Unknown content type: attempt to read raw body and fail gracefully
      const maybe = await new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        req.on("data", (c) => {
          bytes += c.length;
          if (bytes > MAX_BYTES) {
            req.destroy();
            reject(new Error("file too large"));
            return;
          }
          chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      }).catch(() => null);

      if (!maybe || maybe.length === 0) return jsonError(res, 400, "Unsupported content-type or empty body");
      buffer = maybe;
    }

    // Validation
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return jsonError(res, 400, "No audio data found");
    if (buffer.length > MAX_BYTES) return jsonError(res, 413, `Payload too large (max ${MAX_BYTES} bytes)`);

    // Basic metadata heuristics
    const metadata = {
      filename,
      mimetype,
      size: buffer.length,
      sha256: sha256Hex(buffer),
      entropy: simpleEntropyEstimate(buffer),
      percentZeros: percentZeros(buffer)
    };

    // Best-effort: attempt to call an external transcription / forgery API if configured
    const transcriptionUrl = (process.env.TRANSCRIPTION_URL || "").trim();
    const forgeryUrl = (process.env.AUDIO_FORGERY_URL || "").trim();
    const workerSecretHeader = (process.env.WORKER_SECRET || "").trim();

    let transcription = null;
    let forgery = null;

    // Provide a base64 payload for external services (if they expect JSON)
    const base64Data = buffer.toString("base64");
    const externalHeaders = {};
    if (workerSecretHeader) externalHeaders["X-Worker-Secret"] = workerSecretHeader;

    if (transcriptionUrl) {
      try {
        transcription = await callExternalJson(transcriptionUrl, { filename, mimetype, data: base64Data }, externalHeaders, 12_000);
      } catch (e) {
        transcription = { error: String(e) };
      }
    }

    if (forgeryUrl) {
      try {
        forgery = await callExternalJson(forgeryUrl, { filename, mimetype, data: base64Data }, externalHeaders, 12_000);
      } catch (e) {
        forgery = { error: String(e) };
      }
    }

    // Compose a trust score (example weighting)
    const aiScore = (forgery && (Number(forgery.score) || 0)) || 0;
    const entropyScore = metadata.entropy || 0;
    const sizeFactor = Math.min(1, buffer.length / (2 * 1024 * 1024)); // small scaling factor
    const compositeTrust = Math.round(((aiScore * 0.65) + (entropyScore * 0.25) + (sizeFactor * 10 * 0.1)) * 100) / 100;

    const report = {
      ok: true,
      service: "audio-microservice",
      timestamp: new Date().toISOString(),
      metadata,
      analysis: {
        transcription: transcription || { note: "TRANSCRIPTION_URL not configured" },
        forgery: forgery || { note: "AUDIO_FORGERY_URL not configured" }
      },
      trustScore: {
        composite: compositeTrust,
        breakdown: { aiScore, entropy: entropyScore, sizeFactor }
      }
    };

    // Optional best-effort forward to STORAGE_WEBHOOK for retention/analytics
    const storageSink = (process.env.STORAGE_WEBHOOK || "").trim();
    if (storageSink) {
      // fire-and-forget
      callExternalJson(storageSink, { metadata, reportTime: new Date().toISOString() }, externalHeaders).catch(() => {});
    }

    return jsonResponse(res, 200, report);
  } catch (err) {
    console.error("audio analyze error:", err && err.stack ? err.stack : String(err));
    return jsonError(res, 500, "Internal Server Error", String(err));
  }
};
