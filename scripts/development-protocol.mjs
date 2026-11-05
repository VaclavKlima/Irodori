// Private newline-delimited messages. This transport has no renderer or photo API surface.
export function readDevelopmentMessages(socket, receive) {
  let buffered = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffered += chunk
    if (Buffer.byteLength(buffered) > 8192) return socket.destroy()
    for (;;) {
      const end = buffered.indexOf('\n')
      if (end < 0) return
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      try {
        const message = JSON.parse(line)
        if (!message || typeof message !== 'object' || Array.isArray(message))
          return socket.destroy()
        receive(message)
      } catch {
        socket.destroy()
        return
      }
    }
  })
}

export function sendDevelopmentMessage(socket, message) {
  if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(message) + '\n')
}
