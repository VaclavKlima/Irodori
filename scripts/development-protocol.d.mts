import type { Socket } from 'node:net'
export function readDevelopmentMessages(
  socket: Socket,
  receive: (message: Record<string, unknown>) => void,
): void
export function sendDevelopmentMessage(socket: Socket, message: Record<string, unknown>): void
