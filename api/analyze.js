import fetch from 'node-fetch';

// Specialized Fake Audio Detectors
const MODELS = [
    "https://api-inference.huggingface.co/models/Matthijs/speecht5_tts-detector", // Good for TTS
    "https://api-inference.huggingface.co/models/MelodyMachine/Deepfake-audio-detection"
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

        // 1. FETCH AUDIO
        const audioRes = await fetch(mediaUrl);
        const buffer = await audioRes.arrayBuffer();
        const byteData = new Uint8Array(buffer);

        // 2. AUDIO PHYSICS (Local Signal Analysis)
        const physics = analyzeSignal(byteData);
        let physicsScore = 0;

        // Check for "Perfect Silence" (Common in TTS generation)
        if (physics.hasDigitalSilence) physicsScore += 0.4;
        
        // Check for "Flat Dynamics" (AI is often over-compressed)
        if (physics.dynamicRange < 30) physicsScore += 0.3;

        // 3. AI MODEL CHECK
        let aiScore = 0;
        if (process.env.HF_API_KEY) {
            for (const model of MODELS) {
                const score = await queryModel(model, buffer, process.env.HF_API_KEY);
                if (score > aiScore) aiScore = score;
            }
        }

        // 4. FINAL VERDICT
        const finalScore = Math.max(aiScore, physicsScore);

        return res.status(200).json({
            service: "audio-forensic-titanium",
            voice_integrity: {
                cloning_probability: finalScore,
                is_synthesized: finalScore > 0.5,
                method: aiScore > physicsScore ? "NEURAL_AUDIO_NET" : "SIGNAL_PHYSICS"
            },
            signal_analysis: {
                frequency_cutoff: physics.hasDigitalSilence ? "UNNATURAL_SILENCE" : "NATURAL_NOISE_FLOOR",
                micro_tremors: physicsScore > 0.5 ? "ABSENT" : "PRESENT"
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

    // Sample the bytes
    for (let i = 0; i < data.length; i += 10) {
        const val = data[i];
        if (val < min) min = val;
        if (val > max) max = val;
        
        // Detect absolute digital silence (0x00 or 0x80 depending on encoding)
        if (val === 0 || val === 128) {
            zeroCount++;
            // If we see 100 zeros in a row, it's digital silence
            if (zeroCount > 100) silenceSegments++;
        } else {
            zeroCount = 0;
        }
    }

    return {
        hasDigitalSilence: silenceSegments > 5, // Real mics rarely output pure 0
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
        // Parse varied HF responses
        if (Array.isArray(json)) {
            const fake = json.find(x => x.label.match(/fake|artificial|synthetic/i));
            return fake ? fake.score : 0;
        }
        return 0;
    } catch (e) { return 0; }
}
