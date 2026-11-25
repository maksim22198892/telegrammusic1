import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { Pool } from 'pg';

const app = express();
const port = Number(process.env.PORT ?? 3001);
const botToken = process.env.BOT_TOKEN ?? '';
// Render-generated secrets are base64; convert to Telegram's URL-safe allowed alphabet.
const webhookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET ?? '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const telegramApiBaseUrl = (process.env.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org').replace(/\/$/, '');
const configuredChannelId = process.env.TELEGRAM_CHANNEL_ID?.trim() ?? '';
const sessionSecret = process.env.SESSION_SECRET || botToken;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const allowedOrigins = [
  ...(process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((value) => value.trim()).filter(Boolean),
  ...(process.env.RENDER_EXTERNAL_URL ? [process.env.RENDER_EXTERNAL_URL] : [])
];
app.use(cors({ credentials: true, origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin is not allowed by CORS'));
} }));
app.use(express.json({ limit: '256kb' }));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracks (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL DEFAULT '',
      audio_filename TEXT,
      cover_filename TEXT,
      telegram_chat_id TEXT,
      telegram_message_id BIGINT,
      telegram_file_id TEXT,
      telegram_file_unique_id TEXT,
      telegram_cover_file_id TEXT,
      mime_type TEXT NOT NULL DEFAULT 'audio/mpeg',
      cover_mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
      original_file_name TEXT,
      file_size BIGINT,
      duration_seconds INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Safe migration for databases created by the first, local-upload MVP.
  await pool.query(`
    ALTER TABLE tracks ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
    ALTER TABLE tracks ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;
    ALTER TABLE tracks ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;
    ALTER TABLE tracks ADD COLUMN IF NOT EXISTS telegram_file_unique_id TEXT;
    ALTER TABLE tracks ADD COLUMN IF NOT EXISTS telegram_cover_file_id TEXT;
    ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT 'audio/mpeg';
    ALTER TABLE tracks ADD COLUMN IF NOT EXISTS cover_mime_type TEXT NOT NULL DEFAULT 'image/jpeg';
    ALTER TABLE tracks ADD COLUMN IF NOT EXISTS original_file_name TEXT;
    ALTER TABLE tracks ADD COLUMN IF NOT EXISTS file_size BIGINT;
    ALTER TABLE tracks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE UNIQUE INDEX IF NOT EXISTS tracks_telegram_message_unique
      ON tracks (telegram_chat_id, telegram_message_id)
      WHERE telegram_chat_id IS NOT NULL AND telegram_message_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS catalog_source (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      chat_id TEXT NOT NULL,
      chat_title TEXT NOT NULL DEFAULT '',
      chat_username TEXT NOT NULL DEFAULT '',
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // The previous MVP required a local audio filename. Telegram-backed tracks do not.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'tracks' AND column_name = 'audio_filename'
      ) THEN
        ALTER TABLE tracks ALTER COLUMN audio_filename DROP NOT NULL;
      END IF;
    END $$;
  `);
}

type TelegramInitData = { auth_date?: string; hash?: string; [key: string]: string | undefined };
function validateTelegramInitData(initData: string): boolean {
  if (!botToken) return process.env.NODE_ENV !== 'production';
  if (!initData) return false;

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) || !Number.isFinite(authDate)) return false;
  const now = Date.now() / 1000;
  if (now - authDate > 60 * 60 * 24 || authDate - now > 60) return false;

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(calculatedHash, 'hex'), Buffer.from(receivedHash, 'hex'));
}

function signSession(payload: { exp: number; userId?: number }) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function validSession(token: string) {
  if (!sessionSecret || !token.includes('.')) return false;
  const [encoded, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', sessionSecret).update(encoded).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(expected, actual)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { exp?: number };
    return typeof payload.exp === 'number' && payload.exp > Date.now() / 1000;
  } catch { return false; }
}

function requireTelegramAuth(req: Request, res: Response, next: NextFunction) {
  if (!botToken && process.env.NODE_ENV !== 'production') return next();
  const cookie = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('music_session='));
  const sessionToken = cookie?.slice('music_session='.length) ?? '';
  if (validSession(sessionToken)) return next();
  const initData = req.header('x-telegram-init-data') ?? '';
  if (!validateTelegramInitData(initData)) {
    return res.status(401).json({ error: 'Telegram authorization failed' });
  }
  next();
}

app.post('/api/auth/session', (req, res) => {
  if (!botToken && process.env.NODE_ENV !== 'production') return res.sendStatus(204);
  const initData = req.header('x-telegram-init-data') ?? '';
  if (!validateTelegramInitData(initData) || !sessionSecret) {
    return res.status(401).json({ error: 'Telegram authorization failed' });
  }
  const params = new URLSearchParams(initData);
  let userId: number | undefined;
  try { userId = JSON.parse(params.get('user') ?? '{}').id; } catch { /* user id is optional */ }
  const token = signSession({ exp: Math.floor(Date.now() / 1000) + 60 * 60, userId });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure; SameSite=None' : '; SameSite=Lax';
  res.setHeader('Set-Cookie', `music_session=${token}; HttpOnly; Path=/; Max-Age=3600${secure}`);
  res.sendStatus(204);
});

type TelegramPhotoSize = { file_id: string; file_unique_id?: string; file_size?: number; width?: number; height?: number };
type TelegramMediaFile = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
  duration?: number;
  title?: string;
  performer?: string;
  thumbnail?: TelegramPhotoSize;
  thumb?: TelegramPhotoSize;
};
type TelegramChannelMessage = {
  message_id: number;
  date?: number;
  chat: { id: number | string; title?: string; username?: string; type?: string };
  caption?: string;
  audio?: TelegramMediaFile;
  document?: TelegramMediaFile;
  photo?: TelegramPhotoSize[];
};
type TelegramUpdate = { channel_post?: TelegramChannelMessage; edited_channel_post?: TelegramChannelMessage };
type TelegramApiResult<T> = { ok: boolean; result?: T; description?: string };
type TelegramFileInfo = { file_id: string; file_path?: string; file_size?: number };

async function telegramApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  if (!botToken) throw new Error('BOT_TOKEN is not configured');
  const response = await fetch(`${telegramApiBaseUrl}/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json() as TelegramApiResult<T>;
  if (!response.ok || !result.ok || result.result === undefined) {
    throw new Error(result.description ?? `Telegram API ${method} failed (${response.status})`);
  }
  return result.result;
}

function safeSecretEquals(received: string, expected: string) {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function parseCaption(caption = ''): { title: string; artist: string; album: string } {
  const lines = caption.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? '';
  const pair = /^(.{1,100}?)\s+[—–-]\s+(.{1,120})$/.exec(firstLine);
  const albumLine = lines.find((line) => /^(album|альбом)\s*:/i.test(line));
  return {
    artist: pair?.[1]?.trim() ?? '',
    title: pair?.[2]?.trim() ?? firstLine,
    album: albumLine ? albumLine.replace(/^(album|альбом)\s*:/i, '').trim() : ''
  };
}

function mediaFromMessage(message: TelegramChannelMessage) {
  if (message.audio) return { media: message.audio, mimeType: message.audio.mime_type || 'audio/mpeg' };
  if (message.document) {
    const document = message.document;
    const extension = path.extname(document.file_name ?? '').toLowerCase();
    const audioExtensions = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.flac', '.mp4']);
    if (document.mime_type?.startsWith('audio/') || audioExtensions.has(extension)) {
      const extensionMimeTypes: Record<string, string> = {
        '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
        '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
        '.flac': 'audio/flac', '.mp4': 'video/mp4'
      };
      return { media: document, mimeType: document.mime_type?.startsWith('audio/') ? document.mime_type : (extensionMimeTypes[extension] ?? 'audio/mpeg') };
    }
  }
  return null;
}

async function bindOrCheckChannel(message: TelegramChannelMessage): Promise<boolean> {
  const chatId = String(message.chat.id);
  if (configuredChannelId && configuredChannelId !== chatId) return false;

  const existing = await pool.query<{ chat_id: string }>('SELECT chat_id FROM catalog_source WHERE id = 1');
  if (existing.rowCount) return existing.rows[0].chat_id === chatId;

  await pool.query(
    `INSERT INTO catalog_source (id, chat_id, chat_title, chat_username)
     VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [chatId, message.chat.title ?? '', message.chat.username ?? '']
  );
  const bound = await pool.query<{ chat_id: string }>('SELECT chat_id FROM catalog_source WHERE id = 1');
  const accepted = bound.rowCount > 0 && bound.rows[0].chat_id === chatId;
  if (accepted) console.log(`Telegram music source connected: ${message.chat.title ?? chatId} (${chatId})`);
  return accepted;
}

async function saveChannelTrack(message: TelegramChannelMessage) {
  const selected = mediaFromMessage(message);
  if (!selected) return;
  const { media, mimeType } = selected;
  const caption = parseCaption(message.caption ?? '');
  const originalFileName = media.file_name ?? '';
  const fileTitle = originalFileName ? path.basename(originalFileName, path.extname(originalFileName)) : '';
  const title = media.title?.trim() || caption.title || fileTitle || `Track ${message.message_id}`;
  const artist = media.performer?.trim() || caption.artist || 'Неизвестный исполнитель';
  const cover = media.thumbnail ?? media.thumb ?? message.photo?.[message.photo.length - 1];

  await pool.query(
    `INSERT INTO tracks (
       title, artist, album, telegram_chat_id, telegram_message_id,
       telegram_file_id, telegram_file_unique_id, telegram_cover_file_id,
       mime_type, cover_mime_type, original_file_name, file_size,
       duration_seconds, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               to_timestamp($14), NOW())
     ON CONFLICT (telegram_chat_id, telegram_message_id)
       WHERE telegram_chat_id IS NOT NULL AND telegram_message_id IS NOT NULL
     DO UPDATE SET
       title = EXCLUDED.title,
       artist = EXCLUDED.artist,
       album = EXCLUDED.album,
       telegram_file_id = EXCLUDED.telegram_file_id,
       telegram_file_unique_id = EXCLUDED.telegram_file_unique_id,
       telegram_cover_file_id = EXCLUDED.telegram_cover_file_id,
       mime_type = EXCLUDED.mime_type,
       cover_mime_type = EXCLUDED.cover_mime_type,
       original_file_name = EXCLUDED.original_file_name,
       file_size = EXCLUDED.file_size,
       duration_seconds = EXCLUDED.duration_seconds,
       updated_at = NOW()`,
    [
      title.slice(0, 250), artist.slice(0, 200), caption.album.slice(0, 200),
      String(message.chat.id), message.message_id, media.file_id, media.file_unique_id,
      cover?.file_id ?? null, mimeType, 'image/jpeg', originalFileName || null,
      media.file_size ?? null, media.duration ?? null,
      message.date ?? Math.floor(Date.now() / 1000)
    ]
  );
}

app.post('/api/telegram/webhook', async (req, res, next) => {
  if (!botToken || !webhookSecret) return res.status(503).json({ error: 'Telegram webhook is not configured' });
  const receivedSecret = req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!safeSecretEquals(receivedSecret, webhookSecret)) return res.sendStatus(401);

  try {
    const update = req.body as TelegramUpdate;
    const message = update.channel_post ?? update.edited_channel_post;
    if (!message) return res.sendStatus(200);
    if (!await bindOrCheckChannel(message)) return res.sendStatus(200);
    await saveChannelTrack(message);
    res.sendStatus(200);
  } catch (error) { next(error); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, telegramConfigured: Boolean(botToken && webhookSecret) }));

app.get('/api/tracks', requireTelegramAuth, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, artist, album, duration_seconds, created_at, telegram_cover_file_id
       FROM tracks WHERE telegram_file_id IS NOT NULL
       ORDER BY created_at DESC, id DESC`
    );
    res.json(result.rows.map((track) => ({
      ...track,
      id: String(track.id),
      coverUrl: track.telegram_cover_file_id ? `/api/tracks/${track.id}/cover` : null,
      audioUrl: `/api/tracks/${track.id}/audio`
    })));
  } catch (error) { next(error); }
});

function streamLocalFile(req: Request, res: Response, filePath: string, mimeType: string) {
  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', 'inline');
  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return res.sendStatus(416);
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start >= stat.size || start > end) {
    return res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
  }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

async function streamTelegramFile(req: Request, res: Response, fileId: string, mimeType: string) {
  const file = await telegramApi<TelegramFileInfo>('getFile', { file_id: fileId });
  if (!file.file_path) throw new Error('Telegram getFile did not return file_path');
  if (path.isAbsolute(file.file_path)) {
    if (!fs.existsSync(file.file_path)) {
      return res.status(503).json({ error: 'Локальный Bot API Server вернул путь к файлу, но этот путь недоступен backend. Подключи общий volume для файлов.' });
    }
    return streamLocalFile(req, res, file.file_path, mimeType);
  }

  const encodedPath = file.file_path.split('/').map(encodeURIComponent).join('/');
  const upstreamUrl = `${telegramApiBaseUrl}/file/bot${botToken}/${encodedPath}`;
  const headers: Record<string, string> = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await fetch(upstreamUrl, { headers });
  if (!upstream.ok && upstream.status !== 206) {
    return res.status(upstream.status).json({ error: `Telegram file download failed (${upstream.status})` });
  }

  res.status(upstream.status);
  const upstreamType = upstream.headers.get('content-type') || '';
  res.setHeader('Content-Type', upstreamType && upstreamType !== 'application/octet-stream' ? upstreamType : mimeType);
  res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', 'inline');
  for (const header of ['content-length', 'content-range']) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  if (!upstream.body) return res.end();
  const stream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

app.get('/api/tracks/:id/audio', requireTelegramAuth, async (req, res, next) => {
  try {
    const result = await pool.query<{ telegram_file_id: string; mime_type: string }>(
      'SELECT telegram_file_id, mime_type FROM tracks WHERE id = $1 AND telegram_file_id IS NOT NULL',
      [req.params.id]
    );
    if (!result.rowCount) return res.sendStatus(404);
    await streamTelegramFile(req, res, result.rows[0].telegram_file_id, result.rows[0].mime_type || 'audio/mpeg');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Telegram file error';
    if (/file is too big|file_too_big/i.test(message)) {
      return res.status(413).json({ error: 'Telegram Bot API не скачивает файлы больше 20 МБ. Для больших треков подключи Local Bot API Server.' });
    }
    next(error);
  }
});

app.get('/api/tracks/:id/cover', requireTelegramAuth, async (req, res, next) => {
  try {
    const result = await pool.query<{ telegram_cover_file_id: string | null; cover_mime_type: string }>(
      'SELECT telegram_cover_file_id, cover_mime_type FROM tracks WHERE id = $1',
      [req.params.id]
    );
    if (!result.rowCount || !result.rows[0].telegram_cover_file_id) return res.sendStatus(404);
    await streamTelegramFile(req, res, result.rows[0].telegram_cover_file_id, result.rows[0].cover_mime_type || 'image/jpeg');
  } catch (error) { next(error); }
});

// In Replit and production, serve the built React app from the same HTTPS origin
// as the API. This keeps Mini App, API, and Telegram webhook on one public URL.
const frontendDist = path.resolve(process.cwd(), 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  console.error(error);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: message });
});

initializeDatabase().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Telegram Music listening on port ${port}`);
    // Render assigns the public HTTPS URL automatically. Register the Telegram webhook
    // at startup so deployment does not require shell access or a separate CLI command.
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL
      || (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/api/telegram/webhook` : '');
    if (botToken && webhookSecret && webhookUrl) {
      telegramApi<boolean>('setWebhook', {
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ['channel_post', 'edited_channel_post'],
        drop_pending_updates: false
      }).then(() => {
        console.log(`Telegram webhook registered: ${webhookUrl}`);
      }).catch((error) => {
        console.error('Could not register Telegram webhook:', error);
      });
    }
  });
}).catch((error) => {
  console.error('Could not initialize database:', error);
  process.exit(1);
});
