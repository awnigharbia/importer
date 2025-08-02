# Importer Microservice

A production-ready TypeScript Node.js microservice for importing videos from various sources and uploading them to Bunny Storage.

## Features

- 🎥 **Multiple Import Sources**
  - Google Drive public links (no authentication required)
  - Direct URL downloads
  - TUS protocol for resumable uploads

- 📦 **Bunny Storage Integration**
  - Streaming uploads to prevent memory issues
  - Automatic CDN URL generation
  - Progress tracking for uploads

- 🔄 **Robust Job Queue System**
  - BullMQ with Redis for reliable job processing
  - Automatic retry with exponential backoff
  - Web dashboard for job monitoring
  - Manual retry option for failed jobs

- 📊 **Monitoring & Alerts**
  - Sentry integration for error tracking
  - Telegram notifications for job status
  - Structured logging with Winston
  - Health check endpoint

- 🛡️ **Production Ready**
  - TypeScript with strict type checking
  - Docker support with multi-stage builds
  - Graceful shutdown handling
  - Rate limiting and security headers

## Quick Start

### Prerequisites

- Node.js 20+
- Redis 7+
- Bunny Storage account

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd importer
```

2. Install dependencies:
```bash
npm install
```

3. Copy the environment file:
```bash
cp .env.example .env
```

4. Configure your environment variables in `.env`:
```env
# Bunny Storage (Required)
BUNNY_STORAGE_ZONE=your-zone
BUNNY_ACCESS_KEY=your-access-key
BUNNY_CDN_URL=https://your-cdn.b-cdn.net

# Redis
REDIS_URL=redis://localhost:6379

# Sentry (Optional)
SENTRY_DSN=your-sentry-dsn

# Telegram (Optional)
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
```

### Development

Run the service in development mode:
```bash
npm run dev
```

### Production

1. Build the TypeScript code:
```bash
npm run build
```

2. Start the service:
```bash
npm start
```

### Docker

Using Docker Compose:
```bash
docker-compose up -d
```

Build and run manually:
```bash
docker build -t importer .
docker run -p 3000:3000 --env-file .env importer
```

## API Documentation

### Start Import Job

```http
POST /api/import
Content-Type: application/json

{
  "url": "https://drive.google.com/file/d/ABC123/view",
  "type": "gdrive",  // Optional: "gdrive" or "direct"
  "fileName": "video.mp4"  // Optional
}
```

### List Jobs

```http
GET /api/jobs?page=1&limit=20&status=completed
```

### Get Job Details

```http
GET /api/jobs/:jobId
```

### Retry Failed Job

```http
POST /api/jobs/:jobId/retry
```

### TUS Upload

Use any TUS client to upload files to `/uploads` endpoint.

## Web Dashboard

Access the job monitoring dashboard at:
```
http://localhost:3000/dashboard
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Client    │────▶│  API Server  │────▶│    Redis    │
└─────────────┘     └──────────────┘     └─────────────┘
                            │                     │
                            ▼                     ▼
                    ┌──────────────┐     ┌─────────────┐
                    │   Workers    │────▶│   BullMQ    │
                    └──────────────┘     └─────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │Bunny Storage │
                    └──────────────┘
```

## Error Handling

- Automatic retry with exponential backoff (max 3 attempts)
- Failed jobs can be manually retried via API or dashboard
- All errors are logged and sent to Sentry (if configured)
- Telegram notifications for critical failures

## Performance Considerations

- Streaming downloads and uploads to handle large files
- Concurrent job processing (configurable concurrency)
- Progress tracking doesn't block the main process
- Temporary files are cleaned up automatically

## Security

- Rate limiting on API endpoints
- Helmet.js for security headers
- Input validation with Zod
- Non-root Docker container
- No sensitive data in logs

## Monitoring

- Health check: `GET /health`
- Metrics available in Bull Board dashboard
- Sentry for error tracking
- Structured JSON logging

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see LICENSE file for details