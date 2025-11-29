export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const body = await readJson(req);
    const { audioUrl } = body;

    if (!audioUrl) {
      return res.status(400).json({ error: "audioUrl is required" });
    }

    return res.status(200).json({
      success: true,
      analysis: {
        audioQualityScore: Math.random() * 100,
        detectedIssues: ["noise", "distortion", "frequency anomalies"],
        audioUrl
      }
    });

  } catch (error) {
    console.error("AUDIO ERROR:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}
