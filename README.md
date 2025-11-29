# MediaProof — Audio Microservice (Vercel)

This is the audio microservice for MediaProof. It accepts audio uploads (base64 JSON, multipart, or raw binary) and returns metadata, heuristics, optional HF inference, and a composite trust score.

## Endpoints

- `POST /api/analyze` — analyze audio
  - Headers:
    - `Content-Type`: `application/json` or `multipart/form-data` or audio mime type
    - `X-Worker-Secret`: **required** — must match `WORKER_SECRET` configured in Vercel
  - Body (JSON example):
    ```json
    {
      "filename": "clip.mp3",
      "mimetype": "audio/mpeg",
      "data": "<base64-encoded-audio>"
    }
    ```

## Deployment (Vercel)

1. Push this repo to GitHub.
2. Import the repo into Vercel.
3. Add the following Environment Variables in Vercel (Project → Settings → Environment Variables):
   - `WORKER_SECRET` — shared secret between Cloudflare Worker and this service
   - `HUGGINGFACE_API_KEY` — optional
   - `AUDIO_MODEL_ID` — optional Hugging Face model id
   - `STORAGE_WEBHOOK_URL` — optional webhook to persist results
4. Deploy.

## Testing

Using curl (base64 JSON):
```bash
DATA=$(base64 -w 0 ./clip.mp3)
curl -X POST https://<your-project>.vercel.app/api/analyze \
 -H "Content-Type: application/json" \
 -H "X-Worker-Secret: <your-secret>" \
 -d "{\"filename\":\"clip.mp3\",\"mimetype\":\"audio/mpeg\",\"data\":\"$DATA\"}"
