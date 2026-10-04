import { Play, Image as ImageIcon, Layers, Move } from 'lucide-react';
import { useRef, useEffect, forwardRef, useImperativeHandle, useMemo, useState, useCallback } from 'react';
import CaptionRenderer from './CaptionRenderer';
import type { CaptionWord, CaptionStyle } from '@/react-app/hooks/useProject';

interface ClipTransform {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  cropTop?: number;
  cropBottom?: number;
  cropLeft?: number;
  cropRight?: number;
}

interface ClipLayer {
  id: string;
  url: string;
  type: 'video' | 'image' | 'audio' | 'caption';
  trackId: string;
  clipTime: number;
  transform?: ClipTransform;
  // Caption-specific data
  captionWords?: CaptionWord[];
  captionStyle?: CaptionStyle;
}

interface VideoPreviewProps {
  layers?: ClipLayer[];
  isPlaying?: boolean;
  // Dimensi kanvas (settings.width/height proyek). Rasio preview mengikuti
  // nilai ini, termasuk ukuran custom dari AspectRatioPicker.
  videoWidth?: number;
  videoHeight?: number;
  onLayerMove?: (layerId: string, x: number, y: number) => void;
  onLayerSelect?: (layerId: string) => void;
  selectedLayerId?: string | null;
  // Caption/text drag: x/y are percentages of the canvas (0-100).
  onCaptionMove?: (layerId: string, xPercent: number, yPercent: number) => void;
  // Preview zoom factor (CSS scale); keeps drag deltas in canvas pixels.
  zoom?: number;
}

export interface VideoPreviewHandle {
  seekTo: (time: number) => void;
  getVideoElement: () => HTMLVideoElement | null;
}

// Helper to build CSS styles from transform
function getTransformStyles(transform?: ClipTransform, zIndex: number = 0, isDragging?: boolean, offsetScale: number = 1): React.CSSProperties {
  const t = transform || {};

  const transforms: string[] = [];

  // Position (translate) — offsets are stored in 650px-reference pixels and
  // scaled to the current canvas so overlays keep their relative position.
  if (t.x || t.y) {
    transforms.push(`translate(${(t.x || 0) * offsetScale}px, ${(t.y || 0) * offsetScale}px)`);
  }

  // Scale
  if (t.scale && t.scale !== 1) {
    transforms.push(`scale(${t.scale})`);
  }

  // Rotation
  if (t.rotation) {
    transforms.push(`rotate(${t.rotation}deg)`);
  }

  // Crop using clip-path
  const cropTop = t.cropTop || 0;
  const cropBottom = t.cropBottom || 0;
  const cropLeft = t.cropLeft || 0;
  const cropRight = t.cropRight || 0;
  const hasClip = cropTop || cropBottom || cropLeft || cropRight;

  return {
    zIndex,
    transform: transforms.length > 0 ? transforms.join(' ') : undefined,
    opacity: t.opacity ?? 1,
    clipPath: hasClip
      ? `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`
      : undefined,
    cursor: isDragging ? 'grabbing' : undefined,
  };
}

const VideoPreview = forwardRef<VideoPreviewHandle, VideoPreviewProps>(({
  layers = [],
  isPlaying = false,
  videoWidth = 1920,
  videoHeight = 1080,
  onLayerMove,
  onLayerSelect,
  selectedLayerId,
  onCaptionMove,
  zoom = 1,
}, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadedSrcRef = useRef<string | null>(null);
  const overlayVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const [draggingLayer, setDraggingLayer] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; layerX: number; layerY: number } | null>(null);
  const [draggingCaption, setDraggingCaption] = useState<{
    id: string;
    startX: number;
    startY: number;
    startPctX: number;
    startPctY: number;
    rect: DOMRect;
  } | null>(null);
  // Canvas height, so caption text scales with the preview panel (the export
  // scales fontSize from a 650px reference too).
  const [canvasHeight, setCanvasHeight] = useState(0);

  // Find the base video layer (V1) for audio/playback control
  const foundBaseLayer = layers.find(l => l.trackId === 'V1' && l.type === 'video');
  const baseLayerId = foundBaseLayer?.id;
  const baseLayerUrl = foundBaseLayer?.url;
  const baseLayerClipTime = foundBaseLayer?.clipTime;

  // Memoize to prevent effect triggers when only caption layers change
  const baseVideoLayer = useMemo(() => {
    return foundBaseLayer;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseLayerId, baseLayerUrl]);

  // Get all layers sorted by track for rendering (V1 at bottom, then V2/V3, then T1/T2 text on top)
  const sortedLayers = useMemo(() => {
    const getTrackOrder = (trackId: string) => {
      if (trackId === 'V1') return 0;
      if (trackId === 'V2') return 1;
      if (trackId === 'V3') return 2;
      if (trackId === 'T1') return 10; // Text/caption track 1
      if (trackId === 'T2') return 11; // Text/caption track 2 (above T1)
      if (trackId.startsWith('T')) return 11; // Other text tracks on top
      return 5; // Other tracks in between
    };
    return [...layers].sort((a, b) => getTrackOrder(a.trackId) - getTrackOrder(b.trackId));
  }, [layers]);

  // Track the canvas height (layout px, unaffected by CSS zoom) so caption
  // text stays proportional to the canvas when the panel is resized.
  const hasLayers = layers.length > 0;
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height || 0;
      if (height > 0) setCanvasHeight(height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasLayers]);
  const captionFontScale = canvasHeight > 0 ? canvasHeight / 650 : 1;
  // Same reference scale for overlay offsets (stored as 650px-reference px).
  const offsetScale = captionFontScale;

  useImperativeHandle(ref, () => ({
    seekTo: (time: number) => {
      if (videoRef.current) videoRef.current.currentTime = time;
    },
    getVideoElement: () => videoRef.current,
  }));

  // Reload video when source URL changes (e.g., after dead air removal)
  // Using stable key + manual load() preserves the audio permission from user gesture
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !baseLayerUrl) return;
    if (loadedSrcRef.current !== baseLayerUrl) {
      if (loadedSrcRef.current) {
        console.log('[VideoPreview] Source changed, reloading video with audio');
        console.log('[VideoPreview] Old:', loadedSrcRef.current?.slice(-60));
        console.log('[VideoPreview] New:', baseLayerUrl.slice(-60));
      }
      video.src = baseLayerUrl;
      video.load();
      loadedSrcRef.current = baseLayerUrl;
    }
  }, [baseLayerUrl]);

  // Seek control for base video (only when paused/scrubbing)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || baseLayerClipTime === undefined) return;
    if (isPlaying) return;

    if (Math.abs(video.currentTime - baseLayerClipTime) > 0.1) {
      video.currentTime = baseLayerClipTime;
    }
  }, [baseLayerClipTime, isPlaying]);

  // Play/pause control for base video
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      console.log('[VideoPreview] Playing base video:', { src: video.src?.slice(-60), muted: video.muted, volume: video.volume, readyState: video.readyState, networkState: video.networkState });
      video.play().catch((err) => {
        console.error('[VideoPreview] Play failed:', err.name, err.message);
      });
    } else {
      video.pause();
    }
  }, [isPlaying]);

  // Play/pause control for overlay videos (V2, V3, etc.)
  useEffect(() => {
    overlayVideoRefs.current.forEach((video) => {
      if (isPlaying) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });
  }, [isPlaying]);

  // Sync overlay video and audio seeking when scrubbing
  useEffect(() => {
    if (isPlaying) return; // Don't interfere during playback

    // Find overlay video and audio layers and sync their time
    const overlayMediaLayers = layers.filter(
      l => (l.type === 'video' && l.trackId !== 'V1') || l.type === 'audio'
    );

    overlayMediaLayers.forEach((layer) => {
      const mediaEl = overlayVideoRefs.current.get(layer.id);
      if (mediaEl && layer.clipTime !== undefined) {
        if (Math.abs(mediaEl.currentTime - layer.clipTime) > 0.1) {
          mediaEl.currentTime = layer.clipTime;
        }
      }
    });
  }, [layers, isPlaying]);

  // Seek on load
  const handleLoaded = () => {
    if (videoRef.current && baseLayerClipTime !== undefined) {
      videoRef.current.currentTime = baseLayerClipTime;
    }
  };

  // Handle mouse down on draggable layer
  const handleLayerMouseDown = useCallback((e: React.MouseEvent, layer: ClipLayer) => {
    // Only allow dragging non-V1 layers (overlays)
    if (layer.trackId === 'V1') return;
    if (e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    setDraggingLayer(layer.id);
    setDragStart({
      x: e.clientX,
      y: e.clientY,
      layerX: layer.transform?.x || 0,
      layerY: layer.transform?.y || 0,
    });

    // Select this layer
    onLayerSelect?.(layer.id);
  }, [onLayerSelect]);

  // Handle mouse down on a caption/text layer: drag to place it freely
  const handleCaptionMouseDown = useCallback((e: React.MouseEvent, layer: ClipLayer) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onLayerSelect?.(layer.id);

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDraggingCaption({
      id: layer.id,
      startX: e.clientX,
      startY: e.clientY,
      startPctX: layer.captionStyle?.positionX ?? 50,
      startPctY: layer.captionStyle?.positionY ?? 50,
      rect,
    });
  }, [onLayerSelect]);

  // Caption drag: convert pixel deltas to canvas percentages
  useEffect(() => {
    if (!draggingCaption) return;
    const handleMouseMove = (e: MouseEvent) => {
      const dx = ((e.clientX - draggingCaption.startX) / draggingCaption.rect.width) * 100;
      const dy = ((e.clientY - draggingCaption.startY) / draggingCaption.rect.height) * 100;
      const x = Math.min(100, Math.max(0, draggingCaption.startPctX + dx));
      const y = Math.min(100, Math.max(0, draggingCaption.startPctY + dy));
      onCaptionMove?.(draggingCaption.id, x, y);
    };
    const handleMouseUp = () => setDraggingCaption(null);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingCaption, onCaptionMove]);

  // Handle mouse move for dragging
  useEffect(() => {
    if (!draggingLayer || !dragStart) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Deltas are screen pixels; divide by zoom (CSS scale) and by the
      // 650px-reference scale so stored offsets stay canvas-relative.
      const deltaX = (e.clientX - dragStart.x) / (zoom * offsetScale);
      const deltaY = (e.clientY - dragStart.y) / (zoom * offsetScale);

      const newX = dragStart.layerX + deltaX;
      const newY = dragStart.layerY + deltaY;

      onLayerMove?.(draggingLayer, newX, newY);
    };

    const handleMouseUp = () => {
      setDraggingLayer(null);
      setDragStart(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingLayer, dragStart, onLayerMove, zoom, offsetScale]);

  // Canvas di-fit ke tinggi panel (ResizableVerticalPanel) sambil menjaga
  // rasio width/height proyek, termasuk dimensi custom.
  const videoFitClass = 'object-contain';
  const containerClass = 'h-full max-h-full w-auto';
  const containerStyle: React.CSSProperties = { aspectRatio: `${videoWidth} / ${videoHeight}` };

  // Separate base video from overlay layers to prevent re-render issues.
  // Must stay before the early return so hook order never changes.
  const overlayLayers = useMemo(() =>
    sortedLayers.filter(l => !(l.trackId === 'V1' && l.type === 'video')),
    [sortedLayers]
  );

  if (layers.length === 0) {
    return (
      <div
        className={`relative ${containerClass} bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10 flex items-center justify-center`}
        style={containerStyle}
      >
        <div className="text-center text-zinc-600">
          <Play className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No media to display</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      // `isolate` membuat stacking context sendiri untuk kanvas. Tanpa ini,
      // z-index layer di dalam kanvas (mis. gambar overlay `baseZIndex + 100`)
      // ikut berkompetisi di level halaman dan bisa menutupi modal `z-50`
      // seperti AspectRatioPicker. Dengan isolate, layer kanvas tidak akan
      // pernah keluar di atas dialog.
      className={`relative isolate ${containerClass} bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10`}
      style={containerStyle}
    >
      {/* Base video layer (V1) - rendered separately for stability */}
      {foundBaseLayer && (
        <video
          key="base-video"
          ref={videoRef}
          src={foundBaseLayer.url}
          className={`absolute inset-0 w-full h-full ${videoFitClass}`}
          style={{ zIndex: 1 }}
          playsInline
          preload="auto"
          onLoadedData={handleLoaded}
        />
      )}

      {/* Render overlay layers (V2+, images, captions) */}
      {overlayLayers.map((layer, index) => {
        const isOverlay = layer.trackId !== 'V1';
        const isDragging = draggingLayer === layer.id;
        const isSelected = selectedLayerId === layer.id;
        const styles = getTransformStyles(layer.transform, index + 2, isDragging, offsetScale);

        if (layer.type === 'video') {
          return (
            <video
              key={`${layer.id}-${layer.url}`}
              ref={(el) => {
                if (el) {
                  overlayVideoRefs.current.set(layer.id, el);
                } else {
                  overlayVideoRefs.current.delete(layer.id);
                }
              }}
              src={layer.url}
              className={`absolute inset-0 w-full h-full ${videoFitClass} cursor-grab active:cursor-grabbing ${
                isSelected ? 'ring-2 ring-zinc-500 ring-offset-2 ring-offset-black' : ''
              }`}
              style={styles}
              playsInline
              preload="auto"
              muted
              onLoadedData={(e) => {
                // Seek to correct time when loaded
                const video = e.currentTarget;
                if (layer.clipTime !== undefined) {
                  video.currentTime = layer.clipTime;
                }
                // Auto-play if timeline is playing
                if (isPlaying) {
                  video.play().catch(() => {});
                }
              }}
              onMouseDown={(e) => handleLayerMouseDown(e, layer)}
            />
          );
        }

        if (layer.type === 'image') {
          // For overlay images (V2, V3), use explicit sizing instead of fill-then-scale
          if (isOverlay) {
            const scale = layer.transform?.scale || 0.2;
            const xOffset = layer.transform?.x || 0;
            const yOffset = layer.transform?.y || 0;
            const baseZIndex = (styles.zIndex as number) || 0;

            return (
              <div
                key={layer.id}
                className="absolute cursor-grab active:cursor-grabbing"
                style={{
                  width: `${scale * 100}%`,
                  top: `calc(70% + ${yOffset * offsetScale}px)`,
                  left: `calc(50% + ${xOffset * offsetScale}px)`,
                  transform: 'translateX(-50%)',
                  zIndex: baseZIndex + 100,
                  opacity: layer.transform?.opacity ?? 1,
                }}
                onMouseDown={(e) => handleLayerMouseDown(e, layer)}
              >
                <img
                  src={layer.url}
                  alt="Layer"
                  className="w-full h-auto rounded-lg shadow-lg pointer-events-none"
                  draggable={false}
                />
                {/* Selection indicator */}
                {isSelected && (
                  <div className="absolute inset-0 ring-2 ring-zinc-500 rounded-lg pointer-events-none" />
                )}
                {/* Drag handle indicator */}
                {!isDragging && (
                  <div className="absolute top-2 right-2 p-1.5 bg-black/60 rounded text-white/70 pointer-events-none">
                    <Move className="w-3 h-3" />
                  </div>
                )}
              </div>
            );
          }

          // For V1 images (full background), use the original fill approach
          return (
            <div
              key={layer.id}
              className="absolute inset-0 w-full h-full"
              style={{ ...styles, pointerEvents: 'none' }}
            >
              <img
                src={layer.url}
                alt="Layer"
                className="w-full h-full object-contain pointer-events-none"
                draggable={false}
              />
            </div>
          );
        }

        if (layer.type === 'caption' && layer.captionWords && layer.captionStyle) {
          return (
            <CaptionRenderer
              key={layer.id}
              words={layer.captionWords}
              style={layer.captionStyle}
              currentTime={layer.clipTime}
              isSelected={isSelected}
              onDragStart={(e) => handleCaptionMouseDown(e, layer)}
              fontScale={captionFontScale}
            />
          );
        }

        // Audio layers - invisible but play audio synced to timeline
        if (layer.type === 'audio') {
          return (
            <audio
              key={`audio-${layer.id}`}
              ref={(el) => {
                if (el) {
                  overlayVideoRefs.current.set(layer.id, el as unknown as HTMLVideoElement);
                } else {
                  overlayVideoRefs.current.delete(layer.id);
                }
              }}
              src={layer.url}
              preload="auto"
              onLoadedData={(e) => {
                const audio = e.currentTarget;
                if (layer.clipTime !== undefined) {
                  audio.currentTime = layer.clipTime;
                }
                if (isPlaying) {
                  audio.play().catch(() => {});
                }
              }}
              style={{ display: 'none' }}
            />
          );
        }

        return null;
      })}

      {/* Layer count indicator */}
      {layers.length > 1 && (
        <div className="absolute top-3 left-3 text-xs text-white/60 bg-black/50 px-2 py-1 rounded flex items-center gap-1 z-50">
          <Layers className="w-3 h-3" />
          <span>{layers.length} layers</span>
        </div>
      )}

      {/* Type indicator */}
      <div className="absolute bottom-3 right-3 text-xs text-white/60 bg-black/50 px-2 py-1 rounded flex items-center gap-1 z-50">
        {baseVideoLayer ? <Play className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
        <span>{baseVideoLayer ? 'video' : layers[0]?.type}</span>
      </div>

      {/* Dragging indicator */}
      {draggingLayer && (
        <div className="absolute bottom-3 left-3 text-xs text-zinc-400 bg-black/70 px-2 py-1 rounded z-50">
          Dragging...
        </div>
      )}
    </div>
  );
});

export default VideoPreview;
