// api/analyze.js
// Vercel Serverless (CommonJS) handler
// Enterprise-ready audio analysis microservice
// Expects X-Worker-Secret header to match process.env.WORKER_SECRET

const mm = require("music-metadata");
const { PassThrough } = require("stream");

// Helper: base64 -> Buffer
function base64ToBuffer(b64) {
  return Buffer.from(b64, "base64");
}

// Small entropy heuristic (0..1)
function simpleEntropyEstimate(buf) {
  try {
    const freq = new Uint32Array(256);
    for (let i = 0; i < buf.length; i++) freq[buf[i]]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      if (freq[i] > 0) {
        const p = freq[i] / buf.length;
        sum += -p * Math.log2(p);
      }
    }
    const maxEntropy = 8;
    return Math.round((sum / maxEntropy) * 100) / 100;
  } catch (e) {
    return 0;
  }
}

// Simple stable stub fingerprint (not cryptographic)
function fingerprintStub(buf) {
  try {
    const len = buf.length;
    let a = 1469598103934665603n;
    const prime = 1099511628211n;
    // sample up to 1024 bytes spread across buffer
    const sampleCount = Math.min(1024, len);
    for (let i = 0; i < sampleCount; i++) {
      const idx = Math.floor((i * len) / sampleCount);
      a = BigInt.asUintN(64, (a ^ BigInt(buf[idx])) * prime);
    }
    return a.toString(16);
  } catch (e) {
    return null;
  }
}

// Call Hugging Face (optional)
async function callHuggingFaceAudio(buffer, mimetype) {
  try {
    const hfKey = process.env.HUGGINGFACE_API_KEY || "";
    const model = process.env.AUDIO_MODEL_ID || "";
    if (!hfKey || !model) return { note: "Hugging Face not configured" };

    const url = `https://api-inference.huggingface.co/models/${model}`;
    // prefer multipart/binary (many HF audio endpoints accept raw bytes)
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hfKey}`,
        "Content-Type": mimetype || "application/octet-stream"
      },
      body: buffer
    });

    if (!resp.ok) {
      // fallback to JSON base64 payload
      const txt1 = await resp.text().catch(() => "");
      const b64 = buffer.toString("base64");
      const resp2 = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${hfKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: b64 })
      });
      if (!resp2.ok) {
        const t2 = await resp2.text().catch(() => "");
        return { error: "HF inference failed", status1: resp.status, text1: txt1, status2: resp2.status, text2: t2 };
      }
      const json = await resp2.json().catch(() => null);
      return { raw: json };
    }

    const ctype = resp.headers.get("content-type") || "";
    if (ctype.includes("application/json")) {
      const json = await resp.json().catch(() => null);
      return { raw: json };
    } else {
      const txt = await resp.text().catch(() => null);
      return { raw: txt };
    }
  } catch (e) {
    return { error: "HF call failed", detail: String(e) };
  }
}

// Read raw request body into Buffer (handles streaming)
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const bufs = [];
    req.on("data", (c) => bufs.push(c));
    req.on("end", () => resolve(Buffer.concat(bufs)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  try {
    // Basic health
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, service: "audio-service", version: "1.0.0" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Only POST allowed" });
    }

    // Validate worker secret
    const incoming = (req.headers["x-worker-secret"] || req.headers["X-Worker-Secret"] || "").toString();
    const expected = (process.env.WORKER_SECRET || "").toString();
    if (!expected || incoming !== expected) {
      console.warn("Unauthorized worker secret", { incomingPresent: !!incoming });
      return res.status(401).json({ ok: false, error: "Unauthorized - invalid worker secret" });
    }

    // Accept:
    // 1) application/json { filename, mimetype, data: "<base64>" }
    // 2) multipart/form-data file field "file" (Vercel provides raw req stream)
    // 3) raw binary body with Content-Type header (audio/mpeg, etc.)

    const ct = (req.headers["content-type"] || "").toLowerCase();

    let filename = `upload-${Date.now()}.bin`;
    let mimetype = "application/octet-stream";
    let buffer = null;

    // CASE 1: json with base64
    if (ct.includes("application/json")) {
      let body = req.body;
      // Vercel may parse small JSON automatically, but ensure we have it
      if (!body) {
        try {
          const raw = await readRawBody(req);
          body = raw && raw.length ? JSON.parse(raw.toString("utf8")) : {};
        } catch (e) {
          body = {};
        }
      }
      if (!body || (!body.data && !body.url)) {
        return res.status(400).json({ ok: false, error: "JSON must include `data` (base64) or `url`" });
      }
      if (body.data) {
        buffer = base64ToBuffer(String(body.data));
        filename = body.filename || filename;
        mimetype = body.mimetype || mimetype;
      } else if (body.url) {
        // fetch remote
        const url = String(body.url);
        const fetched = await fetch(url, { redirect: "follow" });
        if (!fetched.ok) return res.status(400).json({ ok: false, error: "Failed to fetch URL", status: fetched.status });
        const ab = await fetched.arrayBuffer();
        buffer = Buffer.from(ab);
        mimetype = fetched.headers.get("content-type") || mimetype;
        filename = body.filename || (new URL(url)).pathname.split("/").pop() || filename;
      }
    }
    // CASE 2: multipart/form-data (attempt to support via raw stream parsing)
    else if (ct.includes("multipart/form-data")) {
      // try to use formidable if present (but avoid heavy install if not)
      // We'll try to parse body raw and find the file part - but easiest is to rely on 'formidable' if installed.
      // If formidable not installed, fallback to reading raw buffer and attempt to parse (less reliable).
      try {
        const formidable = require("formidable");
        const form = new formidable.IncomingForm();
        // convert Node req to promise
        const parseForm = () =>
          new Promise((resolve, reject) => {
            form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
          });
        const { files } = await parseForm();
        const fileKey = Object.keys(files || {})[0];
        if (!fileKey) return res.status(400).json({ ok: false, error: "multipart missing file" });
        const file = files[fileKey];
        const fs = require("fs");
        const data = await fs.promises.readFile(file.path);
        buffer = data;
        filename = file.name || filename;
        mimetype = file.type || mimetype;
      } catch (e) {
        // fallback: read raw body into buffer
        const raw = await readRawBody(req);
        if (!raw || raw.length === 0) return res.status(400).json({ ok: false, error: "No file data found (multipart parse failed)" });
        buffer = raw;
      }
    }
    // CASE 3: raw binary body
    else {
      const raw = await readRawBody(req);
      if (!raw || raw.length === 0) return res.status(400).json({ ok: false, error: "No file provided in request body" });
      buffer = raw;
      mimetype = ct || mimetype;
    }

    // Size guard - Vercel serverless has payload limits; enforce safety
    const MAX_BYTES = parseInt(process.env.MAX_BYTES || String(20 * 1024 * 1024), 10); // default 20MB
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: `File too large (max ${MAX_BYTES} bytes)` });
    }

    // 1) Extract detailed metadata with music-metadata (safe: uses buffer stream)
    let meta = null;
    try {
      const stream = new PassThrough();
      stream.end(buffer);
      meta = await mm.parseStream(stream, { mimeType: mimetype }, { duration: true });
      // mm.parseStream requires you to close the stream on end - already done
      // pick a compact metadata result
      meta = {
        format: meta.format || {},
        common: meta.common || {}
      };
    } catch (e) {
      console.warn("music-metadata parse failed", String(e));
      meta = { error: "metadata parse failed", detail: String(e) };
    }

    // 2) heuristics
    const entropy = simpleEntropyEstimate(buffer);
    const fingerprint = fingerprintStub(buffer);

    // 3) optional HF inference
    let hf = null;
    if (process.env.HUGGINGFACE_API_KEY && process.env.AUDIO_MODEL_ID) {
      try {
        hf = await callHuggingFaceAudio(buffer, mimetype);
      } catch (e) {
        hf = { error: "hf-call-failed", detail: String(e) };
      }
    } else {
      hf = { note: "HF not configured" };
    }

    // 4) composite/trust scoring example (tunable)
    const audioAiScore = Number(hf?.score ?? 0) || 0;
    const heurScore = Number(entropy) || 0;
    const composite = Math.round(((audioAiScore * 0.7) + (heurScore * 0.3)) * 100) / 100;

    const out = {
      filename,
      mimetype,
      size: buffer.length,
      metadata: meta,
      heuristics: { entropy, fingerprint },
      hf,
      trustScore: { composite, breakdown: { ai: audioAiScore, heuristics: heurScore } },
      processedAt: new Date().toISOString()
    };

    // optional: forward to STORAGE_WEBHOOK_URL if configured (non-blocking)
    try {
      const sink = (process.env.STORAGE_WEBHOOK_URL || "").trim();
      if (sink) {
        fetch(sink, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: "audio", result: out, filename }),
          signal: AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined
        }).catch(() => {});
      }
    } catch (e) {
      // ignore forward failures
    }

    return res.status(200).json({ ok: true, result: out });
  } catch (err) {
    console.error("analyze handler error:", String(err), err && err.stack ? err.stack : "");
    // return safe error for caller
    return res.status(500).json({ ok: false, error: "internal", detail: String(err) });
  }
};
