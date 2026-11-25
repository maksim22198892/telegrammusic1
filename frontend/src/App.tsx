import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getAudioUrl, getCoverUrl, getTracks } from './api';
import type { Track } from './types';

type Tab = 'home' | 'search' | 'library';

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const paths: Record<string, ReactNode> = {
    add: <><path d="M12 5v14M5 12h14"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M5.6 9A7 7 0 0 1 18 6l2 2M4 16l2 2a7 7 0 0 0 12.4-3"/></>,
    home: <><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9M9 20v-6h6v6"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></>,
    library: <><path d="M4 5h16M4 10h16M4 15h10M4 20h10"/><path d="M18 15v6l2-1.5 2 1.5v-6"/></>,
    play: <path d="m8 5 12 7-12 7z" fill="currentColor" stroke="none"/>,
    pause: <><path d="M8 5h3v14H8zM15 5h3v14h-3z" fill="currentColor" stroke="none"/></>,
    next: <><path d="m5 5 10 7-10 7z" fill="currentColor" stroke="none"/><path d="M19 5v14"/></>,
    prev: <><path d="m19 5-10 7 10 7z" fill="currentColor" stroke="none"/><path d="M5 5v14"/></>,
    heart: <path d="M20.8 8.8c0 5.1-8.8 10.2-8.8 10.2S3.2 13.9 3.2 8.8A4.7 4.7 0 0 1 12 6.2a4.7 4.7 0 0 1 8.8 2.6Z"/>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
    music: <><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></>,
    shuffle: <><path d="m18 14 3 3-3 3M3 7h2c5 0 8 10 13 10h3M18 4l3 3-3 3M3 17h2c1.8 0 3.2-1.2 4.5-2.8M14.5 9.8C15.6 8.2 16.8 7 18 7h3"/></>,
  };
  return <svg {...common} aria-hidden="true">{paths[name] ?? paths.music}</svg>;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function Cover({ track, className = '' }: { track?: Track; className?: string }) {
  const url = track ? getCoverUrl(track) : '';
  return url ? <img className={`cover ${className}`} src={url} alt={`${track?.title ?? 'Album'} cover`} /> : (
    <div className={`cover cover-placeholder ${className}`}><Icon name="music" size={28}/></div>
  );
}

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [tab, setTab] = useState<Tab>('home');
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('music-favorites') ?? '[]') as string[]; }
    catch { return []; }
  });
  const [current, setCurrent] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const filtered = useMemo(() => {
    const base = tab === 'library' ? tracks.filter((track) => favorites.includes(track.id)) : tracks;
    const needle = query.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((track) => `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(needle));
  }, [tracks, favorites, query, tab]);

  useEffect(() => {
    let active = true;
    const loadCatalog = async () => {
      try {
        const items = await getTracks();
        if (active) { setTracks(items); setError(''); }
      } catch {
        if (active) setError('Не удалось загрузить каталог. Проверь подключение к Telegram и сервер.');
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadCatalog();
    const interval = window.setInterval(() => { void loadCatalog(); }, 30000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  useEffect(() => { localStorage.setItem('music-favorites', JSON.stringify(favorites)); }, [favorites]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    audio.src = getAudioUrl(current);
    audio.load();
    if (playing) void audio.play().catch(() => setPlaying(false));
  }, [current]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }, [playing]);

  const toggleFavorite = (id: string) => setFavorites((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  const playTrack = (track: Track) => {
    if (current?.id === track.id) setPlaying((value) => !value);
    else { setCurrent(track); setPlaying(true); }
  };
  const nextTrack = (direction: 1 | -1) => {
    if (!current || !tracks.length) return;
    const index = tracks.findIndex((track) => track.id === current.id);
    const next = tracks[(index + direction + tracks.length) % tracks.length];
    setCurrent(next); setPlaying(true);
  };

  const currentIsFavorite = current ? favorites.includes(current.id) : false;
  const refreshCatalog = async () => {
    setRefreshing(true);
    try { setTracks(await getTracks()); setError(''); }
    catch { setError('Не удалось загрузить каталог. Проверь подключение к Telegram и сервер.'); }
    finally { setRefreshing(false); }
  };
  const title = tab === 'search' ? 'Поиск' : tab === 'library' ? 'Моя музыка' : 'Слушай своё';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><span className="brand-dot"/>MUSIC</div>
        <button className="add-track-button" onClick={refreshCatalog} disabled={refreshing}><Icon name="refresh" size={15}/><span>{refreshing ? 'Обновляем…' : 'Обновить'}</span></button>
      </header>

      <main className={`main-content ${current ? 'has-player' : ''}`}>
        <section className="hero-copy">
          <p className="eyebrow">TELEGRAM CHANNEL · YOUR MUSIC</p>
          <h1>{title}<span>.</span></h1>
          {tab === 'home' && <p className="subheading">Новые песни из твоего Telegram-канала появляются здесь автоматически.</p>}
        </section>

        {tab === 'search' && (
          <label className="search-field">
            <Icon name="search" size={19}/>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Трек, исполнитель или альбом" autoFocus />
            {query && <button onClick={() => setQuery('')} aria-label="Очистить"><Icon name="close" size={17}/></button>}
          </label>
        )}

        {tab === 'home' && tracks.length > 0 && (
          <section className="featured-section">
            <div className="section-heading"><div><p className="eyebrow">FROM TELEGRAM</p><h2>В твоей библиотеке</h2></div><span className="count-label">{tracks.length} {tracks.length === 1 ? 'ТРЕК' : 'ТРЕКОВ'}</span></div>
            <div className="featured-grid">
              {tracks.slice(0, 2).map((track, index) => (
                <button className={`featured-card featured-${index}`} key={track.id} onClick={() => playTrack(track)}>
                  <Cover track={track}/><span className="featured-overlay"/><span className="featured-info"><small>{index === 0 ? 'RECENTLY ADDED' : 'FROM YOUR LIBRARY'}</small><strong>{track.title}</strong><span>{track.artist}</span></span><span className="featured-play"><Icon name="play" size={18}/></span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="track-section">
          <div className="section-heading"><div><p className="eyebrow">{tab === 'library' ? 'SAVED TRACKS' : tab === 'search' ? 'FIND YOUR SOUND' : 'ALL TRACKS'}</p><h2>{tab === 'library' ? 'Избранное' : tab === 'search' ? 'Результаты' : 'Все треки'}</h2></div>{filtered.length > 0 && <span className="count-label">{filtered.length} TRACKS</span>}</div>
          {loading ? <div className="empty-state"><div className="loading-orbit"/><p>Загружаем музыку…</p></div> : error ? <div className="empty-state"><div className="empty-icon"><Icon name="music" size={25}/></div><h3>Каталог пока недоступен</h3><p>{error}</p></div> : filtered.length === 0 ? (
            <div className="empty-state"><div className="empty-icon"><Icon name={tab === 'library' ? 'heart' : 'music'} size={25}/></div><h3>{tab === 'library' ? 'Здесь пока пусто' : query ? 'Ничего не найдено' : 'Твоя музыка начинается здесь'}</h3><p>{tab === 'library' ? 'Добавляй треки в избранное, чтобы собрать свою коллекцию.' : query ? 'Попробуй изменить поисковый запрос.' : 'Опубликуй аудиофайл в подключённом Telegram-канале — он появится здесь автоматически.'}</p></div>
          ) : (
            <div className="track-list">
              {filtered.map((track, index) => (
                <div className={`track-row ${current?.id === track.id ? 'is-current' : ''}`} key={track.id}>
                  <button className="track-main" onClick={() => playTrack(track)}>
                    <span className="track-index">{current?.id === track.id && playing ? <span className="playing-bars"><i/><i/><i/></span> : String(index + 1).padStart(2, '0')}</span>
                    <Cover track={track} className="track-cover"/>
                    <span className="track-meta"><strong>{track.title}</strong><small>{track.artist}{track.album ? ` · ${track.album}` : ''}</small></span>
                  </button>
                  <span className="track-duration">{track.duration_seconds ? formatTime(track.duration_seconds) : '—'}</span>
                  <button className={`icon-button favorite-button ${favorites.includes(track.id) ? 'is-favorite' : ''}`} onClick={() => toggleFavorite(track.id)} aria-label="В избранное"><Icon name="heart" size={18}/></button>
                  <button className="row-play" onClick={() => playTrack(track)} aria-label="Воспроизвести"><Icon name={current?.id === track.id && playing ? 'pause' : 'play'} size={17}/></button>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {current && (
        <div className="mini-player-wrap">
          <div className="mini-progress"><span style={{ width: `${duration ? (progress / duration) * 100 : 0}%` }}/></div>
          <div className="mini-player">
            <button className="mini-track" onClick={() => setExpanded(true)}><Cover track={current} className="mini-cover"/><span><strong>{current.title}</strong><small>{current.artist}</small></span></button>
            <div className="mini-controls"><button className="icon-button" onClick={() => toggleFavorite(current.id)} aria-label="В избранное"><Icon name="heart" size={18}/></button><button className="play-control" onClick={() => setPlaying((value) => !value)} aria-label={playing ? 'Пауза' : 'Воспроизвести'}><Icon name={playing ? 'pause' : 'play'} size={19}/></button></div>
          </div>
        </div>
      )}

      <nav className="bottom-nav">
        <button className={tab === 'home' ? 'active' : ''} onClick={() => { setTab('home'); setQuery(''); }}><Icon name="home"/><span>Главная</span></button>
        <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}><Icon name="search"/><span>Поиск</span></button>
        <button className={tab === 'library' ? 'active' : ''} onClick={() => { setTab('library'); setQuery(''); }}><Icon name="library"/><span>Моя музыка</span></button>
      </nav>

      {expanded && current && (
        <div className="player-screen">
          <div className="player-top"><button className="icon-button" onClick={() => setExpanded(false)} aria-label="Свернуть"><Icon name="close" size={22}/></button><span>NOW PLAYING</span><button className="icon-button" aria-label="Ещё"><Icon name="more"/></button></div>
          <div className="player-art-wrap"><Cover track={current} className="player-art"/></div>
          <div className="player-track-info"><div><h2>{current.title}</h2><p>{current.artist}</p></div><button className={`icon-button ${currentIsFavorite ? 'is-favorite' : ''}`} onClick={() => toggleFavorite(current.id)} aria-label="В избранное"><Icon name="heart" size={23}/></button></div>
          <div className="timeline"><input type="range" min="0" max={duration || 1} value={Math.min(progress, duration || 1)} onChange={(event) => { const value = Number(event.target.value); if (audioRef.current) audioRef.current.currentTime = value; setProgress(value); }}/><div><span>{formatTime(progress)}</span><span>{formatTime(duration)}</span></div></div>
          <div className="full-controls"><button className="icon-button" aria-label="Перемешать"><Icon name="shuffle" size={21}/></button><button className="icon-button" onClick={() => nextTrack(-1)} aria-label="Предыдущий"><Icon name="prev" size={27}/></button><button className="big-play" onClick={() => setPlaying((value) => !value)} aria-label={playing ? 'Пауза' : 'Воспроизвести'}><Icon name={playing ? 'pause' : 'play'} size={27}/></button><button className="icon-button" onClick={() => nextTrack(1)} aria-label="Следующий"><Icon name="next" size={27}/></button><button className="icon-button" aria-label="Повтор"><span className="repeat-symbol">↻</span></button></div>
        </div>
      )}

      <audio ref={audioRef} onTimeUpdate={(event) => setProgress(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)} onEnded={() => nextTrack(1)} onError={() => setPlaying(false)}/>
    </div>
  );
}
