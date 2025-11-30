import fetch from 'node-fetch';
import * as mm from 'music-metadata';

// --- CONFIGURATION ---
// In production, these should be Environment Variables in Vercel
const SCAM_KEYWORDS = ["urgent", "bank", "password", "gift card", "police", "irs", "verify", "transfer"];
const DEEPFAKE_THRESHOLD = 0.85; // 85% confidence triggers alert

export default async function handler(req, res) {
  // 1. Safety Harness: Catch global crashes
  try {
    // 2. CORS Handling
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { mediaUrl } = req.body;
    if (!mediaUrl) return res.status(400).json({ error: 'Missing mediaUrl' });

    console.log(`[AudioForensics] Starting analysis for: ${mediaUrl}`);

    // --- STAGE 1: FETCH BUFFER ---
    // We need the raw file buffer to inspect technical headers
    const audioResp = await fetch(mediaUrl);
    if (!audioResp.ok) throw new Error(`Failed to download audio: ${audioResp.statusText}`);
    
    const arrayBuffer = await audioResp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // --- STAGE 2: TECHNICAL FORENSICS (Metadata) ---
    // extracting deep codec data to find inconsistencies
    let technicalData = {};
    try {
      const metadata = await mm.parseBuffer(buffer, 'audio/mpeg'); // Auto-detects types
      technicalData = {
        format: metadata.format.container,
        codec: metadata.format.codec,
        duration: metadata.format.duration,
        bitrate: metadata.format.bitrate,
        sampleRate: metadata.format.sampleRate,
        channels: metadata.format.numberOfChannels,
        lossless: metadata.format.lossless || false,
        tool: metadata.native?.ID3v2?.TENC?.value || "Unknown" // Encoding tool (often reveals fake generators)
      };
    } catch (e) {
      console.warn("Metadata parsing warning:", e.message);
      technicalData = { error: "Could not parse deep metadata", details: e.message };
    }

    // --- STAGE 3: CONTENT & AI ANALYSIS (Simulation) ---
    // In a real FBI-level tool, you would call Deepgram or OpenAI Whisper here.
    // We will simulate the output of those tools to structure the report correctly.
    
    // SIMULATED TRANSCRIPT (Replace with actual API call to Deepgram)
    const mockTranscript = "Hello this is the IRS calling about an urgent verify transfer."; 
    const detectedKeywords = SCAM_KEYWORDS.filter(word => mockTranscript.toLowerCase().includes(word));

    // SIMULATED AI DETECTION (Replace with ElevenLabs/Resemble AI classifier)
    // Logic: If bitrate is suspiciously low (common in cheap deepfakes), increase risk.
    const isLowQuality = technicalData.bitrate && technicalData.bitrate < 64000;
    const aiProbability = isLowQuality ? 0.75 : 0.15; 

    // --- STAGE 4: BUILD THE FBI REPORT ---
    const riskScore = calculateRisk(technicalData, detectedKeywords, aiProbability);

    const report = {
      service: "audio-forensics-unit",
      status: "complete",
      timestamp: new Date().toISOString(),
      
      // The "FBI Level" Breakdown
      riskAssessment: {
        score: riskScore, // 0-100
        level: riskScore > 80 ? "CRITICAL_THREAT" : riskScore > 50 ? "SUSPICIOUS" : "SAFE",
        flags: [
          ...(detectedKeywords.length > 0 ? [`Scam keywords detected: ${detectedKeywords.join(", ")}`] : []),
          ...(aiProbability > 0.7 ? ["High probability of AI Synthesis"] : []),
          ...(technicalData.duration < 2 ? ["Suspiciously short duration (Robocall signature)"] : [])
        ]
      },

      technicalAnalysis: {
        ...technicalData,
        integrityCheck: technicalData.bitrate > 128000 ? "High Fidelity" : "Degraded/Compressed"
      },

      contentAnalysis: {
        transcript_snippet: mockTranscript, // Only snippets to save bandwidth
        language: "en-US",
        speaker_count: 1, // Diarization result
        sentiment: "Urgent/Aggressive"
      }
    };

    return res.status(200).json(report);

  } catch (error) {
    console.error('[CRITICAL FAILURE]', error);
    return res.status(500).json({ 
      error: 'Forensic Analysis Failed', 
      code: 'INTERNAL_FORENSIC_ERROR',
      message: error.message 
    });
  }
}

// Helper: Scoring Logic
function calculateRisk(meta, keywords, aiProb) {
  let score = 0;
  
  // 1. Content Risk
  if (keywords.length > 0) score += 40;
  
  // 2. AI Risk
  score += (aiProb * 40);

  // 3. Technical Risk
  if (meta.duration && meta.duration < 5) score += 10; // Flash calls
  if (meta.tool !== "Unknown") score += 5; // Software-encoded usually means edited

  return Math.min(Math.round(score), 100);
}
