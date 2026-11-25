import type { Track } from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';
const telegramInitData = window.Telegram?.WebApp?.initData ?? '';
let sessionPromise: Promise<void> | null = null;

async function ensureSession() {
  if (!sessionPromise) {
    sessionPromise = fetch(`${API_BASE}/api/auth/session`, {
      method: 'POST', credentials: 'include',
      headers: telegramInitData ? { 'x-telegram-init-data': telegramInitData } : {}
    }).then((response) => { if (!response.ok) throw new Error('Telegram authorization failed'); });
  }
  return sessionPromise;
}

async function request<T>(path: string): Promise<T> {
  await ensureSession();
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: telegramInitData ? { 'x-telegram-init-data': telegramInitData } : {}
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json() as Promise<T>;
}

export function getTracks() {
  return request<Track[]>('/api/tracks');
}

export function getAudioUrl(track: Track) {
  return `${API_BASE}${track.audioUrl}`;
}

export function getCoverUrl(track: Track) {
  return track.coverUrl ? `${API_BASE}${track.coverUrl}` : '';
}

