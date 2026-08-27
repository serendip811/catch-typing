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
      if (socket.current !== ws) return
      setStatus('online')
      if (initialMessage) ws.send(JSON.stringify(initialMessage))
    }
    ws.onclose = () => {
      if (socket.current !== ws) return
      socket.current = null
      setStatus('offline')
    }
    ws.onerror = () => {
      if (socket.current === ws) setStatus('offline')
    }
    ws.onmessage = (event) => {
      if (socket.current !== ws) return
      try { handler.current(JSON.parse(event.data) as ServerMessage) } catch { /* ignore malformed frames */ }
    }
  }, [])

  const disconnect = useCallback(() => {
    const ws = socket.current
    socket.current = null
    ws?.close()
    setStatus('idle')
  }, [])

  useEffect(() => () => {
    const ws = socket.current
    socket.current = null
    ws?.close()
  }, [])

  const send = useCallback((message: ClientMessage) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false
    socket.current.send(JSON.stringify(message))
    return true
  }, [])

  return { status, connect, disconnect, send }
}
