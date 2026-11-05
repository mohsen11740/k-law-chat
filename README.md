# K-Law Chat

Independent Persian legal chat service for K-Law.

## Separation boundary

- Own Cloudflare Worker: `k-law-chat`
- Own API route: `POST /api/chat`
- Own secret: `ONEAI_API_KEY`
- No D1 binding and no runtime dependency on the K-Law AI website, Student, Lawyer, or Dictionary Workers.
- Conversation history is supplied by the client and is not persisted by this Worker.
- Streaming responses are passed through from 1AI.

## Required Worker secret

Set `ONEAI_API_KEY` in the Cloudflare Worker secrets for `k-law-chat`.

Optional variable:
- `ALLOWED_ORIGIN`: exact browser origin allowed to call the API after the chat UI is deployed to its own domain.

## API

- `GET /health`
- `POST /api/chat`

Request body:

```json
{
  "messages": [
    {"role": "user", "content": "پرسش حقوقی"}
  ],
  "stream": true
}
```

This initial independent service covers text chat only. File analysis, audio transcription, and Unity-precedent lookup must be migrated as separately tested capabilities before their existing buttons are switched over. The existing K-Law website remains unchanged during this migration.
