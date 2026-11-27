/** A context the audio device dropped never plays again: Android reroutes audio when the mic opens,
 * and Chrome then fires `error` ("…error from the audio device or the WebAudio renderer"). `broken`
 * is set by the owner's `error` listener; `interrupted` is the newer explicit state. */
export function contextIsDead(c: AudioContext, broken: boolean): boolean {
  return broken || c.state === "closed" || (c.state as string) === "interrupted";
}
