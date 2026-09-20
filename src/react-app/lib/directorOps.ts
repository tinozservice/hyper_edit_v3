// Shared shapes for the Director's timeline operations and vault-media placement.
// Filled by Jev on the server (POST /director/route), executed in Home.tsx.

export type TimelineOperation =
  | 'delete'        // remove clip(s)
  | 'split'         // cut clip(s) at a time
  | 'move'          // shift clip(s) earlier/later, to a time, or to another track
  | 'trim_start'    // shorten from the start
  | 'trim_end'      // shorten from the end
  | 'extend_start'  // lengthen at the start (images / within asset bounds)
  | 'extend_end'    // lengthen at the end
  | 'set_duration'  // set an image/overlay clip's length
  | 'scale'         // resize an overlay
  | 'position'      // place an overlay in a corner / center
  | 'seek'          // move the playhead
  | 'play'
  | 'pause'
  | 'clear_track'   // delete every clip on a track
  | 'none';

export type TrackId = 'T1' | 'V3' | 'V2' | 'V1' | 'A1' | 'A2';
export type TrackChoice = TrackId | 'none';
export type SizePreset = 'tiny' | 'small' | 'half' | 'full' | 'none';
export type PositionPreset = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'none';

export interface DirectorTimelineOp {
  operation: TimelineOperation;
  /** 'selected' | 'at_playhead' | 'first' | 'last' | 'all_on_track' | 'everything' | 'clip:<id>' | 'none' */
  target: string;
  /** Track the request talks about (where the clip is). */
  track: TrackChoice;
  /** Destination track for a move. */
  toTrack: TrackChoice;
  direction: 'earlier' | 'later' | 'none';
  size: SizePreset;
  position: PositionPreset;
  /** Relative amount in seconds ("by 2 seconds"), parsed by code. */
  seconds: number | null;
  /** Absolute time in seconds ("to 0:30", "at 12 seconds"), parsed by code. */
  time: number | null;
  /** Explicit scale as a fraction ("30%"), parsed by code. */
  scaleFraction: number | null;
}

export interface VaultPlacement {
  track: TrackChoice;
  size: SizePreset;
  position: PositionPreset;
  time: number | null;
}

export const SIZE_TO_SCALE: Record<Exclude<SizePreset, 'none'>, number> = {
  tiny: 0.12,
  small: 0.2,
  half: 0.5,
  full: 1,
};

// Overlay images anchor at left 50% + x px, top 70% + y px in the preview.
export const POSITION_TO_OFFSET: Record<Exclude<PositionPreset, 'none'>, { x: number; y: number }> = {
  'top-left': { x: -220, y: -270 },
  'top-right': { x: 220, y: -270 },
  'bottom-left': { x: -220, y: 40 },
  'bottom-right': { x: 220, y: 40 },
  center: { x: 0, y: -120 },
};

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
