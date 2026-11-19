/**
 * Re-export shim (P4): the speech duck moved to `media-duck.ts` (local WASAPI session duck first,
 * Spotify Web API as the fallback). Kept so existing imports and test mocks of this path still work.
 */
export {
  CEILING_PAD_MS,
  COMMAND_HOLD_CAP_MS,
  COMMAND_RESTORE_CAP_MS,
  COOLDOWN_MS,
  FADE_DOWN_MS,
  FADE_UP_MS,
  PAUSE_WAIT_CAP_MS,
  TRANSCRIBE_WAIT_CAP_MS,
  UNDUCK_RETRY_MS,
  duckOnSpeech,
  duckOnTrigger,
  inCooldown,
  musicPlayingHere,
  restoreAfterPause,
  restoreDuck,
  scheduleRestore,
  settleCommand,
  settleNoise,
} from "./media-duck";
