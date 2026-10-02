// Format/rasio video untuk timeline & ekspor.
//
// `settings.width/height` di useProject adalah satu-satunya sumber kebenaran
// untuk dimensi ekspor; label di sini hanya untuk tampilan (ikon Timeline,
// tooltip, badge). Dimensi custom (bukan preset) tetap didukung dan diberi
// label "W×H".

export interface VideoFormat {
  id: string;
  label: string;
  width: number;
  height: number;
  hint: string;
}

export const VIDEO_FORMATS: VideoFormat[] = [
  { id: '16:9', label: '16:9', width: 1920, height: 1080, hint: 'Landscape / YouTube' },
  { id: '9:16', label: '9:16', width: 1080, height: 1920, hint: 'TikTok / Reels / Shorts' },
  { id: '4:3', label: '4:3', width: 1440, height: 1080, hint: 'Klasik / presentasi' },
  { id: '3:4', label: '3:4', width: 1080, height: 1440, hint: 'Portrait 4:3' },
  { id: '1:1', label: '1:1', width: 1080, height: 1080, hint: 'Feed persegi' },
  { id: '21:9', label: '21:9', width: 2560, height: 1080, hint: 'Cinematic ultrawide' },
  { id: '9:21', label: '9:21', width: 1080, height: 2520, hint: 'Ultra portrait' },
];

export const MIN_DIMENSION = 16;
export const MAX_DIMENSION = 7680;

// H.264 dengan yuv420p membutuhkan dimensi genap — bulatkan ke bawah ke
// bilangan genap terdekat agar render FFmpeg tidak gagal.
export function normalizeDimension(value: number): number {
  const clamped = Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.round(value) || 0));
  return clamped % 2 === 0 ? clamped : clamped - 1;
}

export function findFormatBySize(width: number, height: number): VideoFormat | undefined {
  return VIDEO_FORMATS.find((f) => f.width === width && f.height === height);
}

export function formatSizeLabel(width: number, height: number): string {
  const preset = findFormatBySize(width, height);
  return preset ? preset.label : `${width}×${height}`;
}

export function isPortraitSize(width: number, height: number): boolean {
  return height > width;
}

// Rasio desimal untuk tampilan, mis. 1920x1080 → "1.78:1".
export function decimalRatioLabel(width: number, height: number): string {
  if (!width || !height) return '-';
  const ratio = width / height;
  return `${ratio.toFixed(2)}:1`;
}
