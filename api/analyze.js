
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const { imageUrl } = req.body;
    if (!imageUrl) {
      return res.status(400).json({ error: "imageUrl is required" });
    }

    const results = {
      forensicScore: Math.random() * 100,
      detectedManipulations: [
        "noise inconsistencies",
        "jpeg ghost analysis",
        "lighting mismatch"
      ],
      imageUrl
    };

    return res.status(200).json({
      success: true,
      analysis: results
    });

  } catch (err) {
    console.error("ANALYZE ERROR:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
