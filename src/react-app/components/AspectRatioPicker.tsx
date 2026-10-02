import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Check, Crop, X } from 'lucide-react';
import {
  VIDEO_FORMATS,
  MIN_DIMENSION,
  MAX_DIMENSION,
  decimalRatioLabel,
  findFormatBySize,
  isPortraitSize,
  normalizeDimension,
} from '@/react-app/lib/videoFormats';

interface AspectRatioPickerProps {
  open: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onApply: (width: number, height: number) => void;
}

// Modal pemilih rasio/piksel video. Preset umum + ukuran custom (piksel).
// Dimensi yang diterapkan langsung dipakai preview dan ekspor FFmpeg.
export default function AspectRatioPicker({ open, width, height, onClose, onApply }: AspectRatioPickerProps) {
  const [customWidth, setCustomWidth] = useState(String(width));
  const [customHeight, setCustomHeight] = useState(String(height));

  useEffect(() => {
    if (open) {
      setCustomWidth(String(width));
      setCustomHeight(String(height));
    }
  }, [open, width, height]);

  const activePreset = useMemo(() => findFormatBySize(width, height), [width, height]);

  const customW = normalizeDimension(Number(customWidth));
  const customH = normalizeDimension(Number(customHeight));
  const customValid =
    Number.isFinite(Number(customWidth)) &&
    Number.isFinite(Number(customHeight)) &&
    Number(customWidth) >= MIN_DIMENSION &&
    Number(customHeight) >= MIN_DIMENSION &&
    Number(customWidth) <= MAX_DIMENSION &&
    Number(customHeight) <= MAX_DIMENSION;
  const customDiffers = customW !== width || customH !== height;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 rounded-xl border border-zinc-700 w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-zinc-700">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Crop className="w-5 h-5 text-zinc-400" />
            Rasio Video
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-zinc-700 rounded transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-5">
          <div>
            <div className="text-xs text-zinc-400 mb-2">Preset</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {VIDEO_FORMATS.map((format) => {
                const active = activePreset?.id === format.id;
                const portrait = isPortraitSize(format.width, format.height);
                return (
                  <button
                    key={format.id}
                    onClick={() => onApply(format.width, format.height)}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors ${
                      active
                        ? 'border-zinc-400 bg-zinc-700/60'
                        : 'border-zinc-700 bg-zinc-800/60 hover:bg-zinc-700/60'
                    }`}
                  >
                    <span
                      className="shrink-0 border border-zinc-500 bg-zinc-950/60 rounded-sm"
                      style={{ width: portrait ? 18 : 30, height: portrait ? 30 : 18 }}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium flex items-center gap-1.5">
                        {format.label}
                        {active && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                      </span>
                      <span className="block text-[10px] text-zinc-500 truncate">
                        {format.width}×{format.height} · {format.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-400 mb-2">Custom (piksel)</div>
            <div className="flex items-center gap-2">
              <label className="flex-1 space-y-1">
                <span className="text-[10px] text-zinc-500">Lebar</span>
                <input
                  type="number"
                  min={MIN_DIMENSION}
                  max={MAX_DIMENSION}
                  value={customWidth}
                  onChange={(e) => setCustomWidth(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-zinc-500"
                />
              </label>
              <span className="text-zinc-500 mt-4">×</span>
              <label className="flex-1 space-y-1">
                <span className="text-[10px] text-zinc-500">Tinggi</span>
                <input
                  type="number"
                  min={MIN_DIMENSION}
                  max={MAX_DIMENSION}
                  value={customHeight}
                  onChange={(e) => setCustomHeight(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-zinc-500"
                />
              </label>
              <button
                onClick={() => {
                  setCustomWidth(String(normalizeDimension(Number(customHeight))));
                  setCustomHeight(String(normalizeDimension(Number(customWidth))));
                }}
                title="Tukar lebar ↔ tinggi (portrait/landscape)"
                className="mt-4 p-2.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
              >
                <ArrowLeftRight className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-[11px] text-zinc-500">
                {customValid ? (
                  <>
                    {customW}×{customH} piksel · rasio {decimalRatioLabel(customW, customH)}{' '}
                    {(customW % 2 === 0 && customH % 2 === 0) ? '' : '· dibulatkan ke genap'}
                  </>
                ) : (
                  <span className="text-amber-400">
                    Dimensi harus {MIN_DIMENSION}–{MAX_DIMENSION} piksel
                  </span>
                )}
              </span>
              <button
                onClick={() => customValid && onApply(customW, customH)}
                disabled={!customValid || !customDiffers}
                className="px-4 py-2 bg-zinc-600 hover:bg-zinc-500 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
              >
                Terapkan custom
              </button>
            </div>
          </div>

          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Rasio ini mengubah kanvas pratinjau sekaligus dimensi ekspor. Saat ini:{' '}
            <span className="text-zinc-300">
              {width}×{height} ({decimalRatioLabel(width, height)})
            </span>
            . Klip video yang rasionya berbeda akan di-<em>fit</em> ke tengah kanvas.
          </p>
        </div>
      </div>
    </div>
  );
}
