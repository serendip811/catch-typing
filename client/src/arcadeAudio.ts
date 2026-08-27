export type ArcadeSound = 'success' | 'miss' | 'claimed'

let context: AudioContext | null = null

export function playArcadeSound(kind: ArcadeSound, enabled: boolean): void {
  if (!enabled || typeof AudioContext === 'undefined') return
  context ??= new AudioContext()
  const now = context.currentTime
  const master = context.createGain()
  master.gain.setValueAtTime(0.0001, now)
  master.gain.exponentialRampToValueAtTime(0.16, now + 0.008)
  master.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'success' ? 0.24 : 0.18))
  master.connect(context.destination)

  const notes = kind === 'success' ? [523.25, 783.99] : kind === 'claimed' ? [330, 247] : [155, 116]
  notes.forEach((frequency, index) => {
    const oscillator = context!.createOscillator()
    const gain = context!.createGain()
    oscillator.type = kind === 'success' ? 'square' : kind === 'claimed' ? 'triangle' : 'sawtooth'
    oscillator.frequency.setValueAtTime(frequency, now + index * 0.055)
    if (kind === 'miss') oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.72, now + 0.15)
    gain.gain.setValueAtTime(index === 0 ? 0.75 : 0.5, now + index * 0.055)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16 + index * 0.04)
    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start(now + index * 0.055)
    oscillator.stop(now + 0.2 + index * 0.06)
  })
}
