// audio-service/api/analyze.js
const fetch = require('node-fetch');
const fs = require('fs');

function bufFromBase64(b64) { return Buffer.from(b64, 'base64'); }

async function callHFAudio(base64) {
  const token = String(globalThis["HUGGINGFACE_API_KEY"] || "").trim();
  if (!token) return { error: 'HUGGINGFACE_API_KEY not configured' };
  // Replace with HF audio model id you want
  const MODEL_ID = 'microsoft/wavlm-base-sv'; // example — replace with appropriate audio model
  const url = `https://api-inference.huggingface.co/models/${MODEL_ID}`;
  try {
    const resp = await fetch(url, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, body: JSON.stringify({ inputs: base64 }) });
    if (!resp.ok) { const txt = await resp.text().catch(()=>null); return { error: 'HF audio call failed', detail: txt }; }
    return await resp.json().catch(()=>({ raw: null }));
  } catch (e) { return { error: String(e) }; }
}

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = req.body;
  if (!body) return res.status(400).json({ error: 'Missing body' });
  let base64;
  if (body.data) base64 = body.data;
  else if (body.url) {
    try {
      const r = await fetch(body.url);
      if (!r.ok) return res.status(400).json({ error: 'Failed to fetch URL' });
      const buf = Buffer.from(await r.arrayBuffer());
      base64 = buf.toString('base64');
    } catch (e) { return res.status(400).json({ error: 'Failed to fetch url' }); }
  } else return res.status(400).json({ error: 'Provide data or url' });

  // call HF
  const hfResp = await callHFAudio(base64);
  // naive score extraction — depends on model
  let score = null;
  if (hfResp && hfResp.prediction) score = hfResp.prediction.score || null;
  // return HF raw for now
  return res.status(200).json({ score, details: hfResp });
};
