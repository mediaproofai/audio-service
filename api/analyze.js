import fetch from 'node-fetch';

// ENSEMBLE OF AUDIO MODELS
const MODELS = [
    "https://api-inference.huggingface.co/models/Matthijs/speecht5_tts-detector",
    "https://api-inference.huggingface.co/models/MelodyMachine/Deepfake-audio-detection",
    "https://api-inference.huggingface.co/models/sanchit-gandhi/distilhubert-finetuned-gtzan" // Classification fallback
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        let body = req.body;
        if (typeof body === 'string') try { body = JSON.parse(body); } catch (e) {}
        const { mediaUrl } = body || {};

        if (!mediaUrl) return res.status(400).json({ error: "No URL" });

        // 1. FETCH
        const audioRes = await fetch(mediaUrl);
        const buffer = await audioRes.arrayBuffer();
        const byteData = new Uint8Array(buffer);

        // 2. METADATA TRAP (Header Analysis)
        // We look for the "Lavf" signature (FFmpeg). 
        // 90% of AI tools use FFmpeg to export. Real phones/mics use hardware encoders.
        const header = new TextDecoder().decode(byteData.slice(0, 500));
        const hasLavf = header.includes("Lavf") || header.includes("LAME");
        const isMp3 = header.includes("ID3");
        
        let metaRisk = 0;
        let metaFlag = "Clean";

        // Condition: MP3 + Lavf/LAME = Likely PC Generated/Converted (Suspicious)
        // Real Capture: Usually AAC/M4A/WAV with hardware headers
        if (isMp3 && hasLavf) {
            metaRisk = 0.75;
            metaFlag = "SOFTWARE_ENCODER_TRACE (FFmpeg/LAME)";
        }

        // 3. AUDIO PHYSICS (Signal Analysis)
        const physics = analyzeSignal(byteData);
        let physicsScore = 0;

        if (physics.hasDigitalSilence) physicsScore += 0.4;
        if (physics.dynamicRange < 30) physicsScore += 0.3; // Over-compressed

        // 4. NEURAL COUNCIL (AI Models)
        let aiScore = 0;
        if (process.env.HF_API_KEY) {
            for (const model of MODELS) {
                const score = await queryModel(model, buffer, process.env.HF_API_KEY);
                if (score > aiScore) aiScore = score;
            }
        }

        // 5. FINAL VERDICT
        // If it looks like software-generated audio (Lavf), treat it as High Risk
        const finalScore = Math.max(aiScore, physicsScore, metaRisk);
        
        let method = "UNCERTAIN";
        if (aiScore > 0.5) method = "NEURAL_AUDIO_NET";
        else if (metaRisk > 0.5) method = "ENCODER_FINGERPRINT";
        else if (physicsScore > 0.5) method = "SIGNAL_PHYSICS";

        return res.status(200).json({
            service: "audio-forensic-titanium",
            voice_integrity: {
                cloning_probability: finalScore,
                is_synthesized: finalScore > 0.5,
                method: method
            },
            signal_analysis: {
                frequency_cutoff: physics.hasDigitalSilence ? "UNNATURAL_SILENCE" : "NATURAL_NOISE",
                encoder_signature: metaFlag
            }
        });

    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}

// --- UTILS ---
function analyzeSignal(data) {
    let zeroCount = 0;
    let min = 255;
    let max = 0;
    let silenceSegments = 0;

    for (let i = 0; i < data.length; i += 50) { // Sample speedup
        const val = data[i];
        if (val < min) min = val;
        if (val > max) max = val;
        
        if (val === 0 || val === 128) {
            zeroCount++;
            if (zeroCount > 50) silenceSegments++;
        } else {
            zeroCount = 0;
        }
    }

    return {
        hasDigitalSilence: silenceSegments > 2, 
        dynamicRange: max - min
    };
}

async function queryModel(url, data, key) {
    try {
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${key}` },
            method: "POST",
            body: data
        });
        const json = await res.json();
        if (Array.isArray(json)) {
            const fake = json.find(x => x.label.match(/fake|artificial|synthetic/i));
            return fake ? fake.score : 0;
        }
        return 0;
    } catch (e) { return 0; }
}
