import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientMessage, ServerMessage } from './protocol'
import { configuredWsUrl } from './protocol'

type Status = 'idle' | 'connecting' | 'online' | 'offline'

export function useGameSocket(onMessage: (message: ServerMessage) => void) {
  const [status, setStatus] = useState<Status>('idle')
  const socket = useRef<WebSocket | null>(null)
  const handler = useRef(onMessage)
  handler.current = onMessage

  const connect = useCallback((initialMessage?: ClientMessage) => {
    socket.current?.close()
    setStatus('connecting')
    const ws = new WebSocket(configuredWsUrl)
    socket.current = ws
    ws.onopen = () => {
      setStatus('online')
      if (initialMessage) ws.send(JSON.stringify(initialMessage))
    }
    ws.onclose = () => setStatus('offline')
    ws.onerror = () => setStatus('offline')
    ws.onmessage = (event) => {
      try { handler.current(JSON.parse(event.data) as ServerMessage) } catch { /* ignore malformed frames */ }
    }
  }, [])

  useEffect(() => () => socket.current?.close(), [])

  const send = useCallback((message: ClientMessage) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false
    socket.current.send(JSON.stringify(message))
    return true
  }, [])

  return { status, connect, send }
}
