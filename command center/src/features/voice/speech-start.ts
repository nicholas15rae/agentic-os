/** Time to first word: listeners told when a speak()'s FIRST audio actually starts playing. */
const speechStartListeners = new Set<() => void>();
export function onSpeechStart(cb: () => void): () => void {
  speechStartListeners.add(cb);
  return () => speechStartListeners.delete(cb);
}
export function speechStarted() {
  for (const cb of speechStartListeners) {
    try {
      cb();
    } catch {
      /* a listener never breaks playback */
    }
  }
}
