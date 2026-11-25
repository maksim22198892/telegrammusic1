export type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
  audioUrl: string;
  duration_seconds: number | null;
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        ready: () => void;
        expand: () => void;
        setHeaderColor?: (color: string) => void;
        setBackgroundColor?: (color: string) => void;
        BackButton?: { hide: () => void };
      };
    };
  }
}
