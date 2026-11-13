import { createRemoteHostService } from './host/service.js'

export const name = 'dsh-remote-workbench'
export const inject = []

export function apply(ctx) {
  const service = createRemoteHostService()
  ctx.effect(() => () => service.dispose(), 'remote-host: SSH connections')
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: '/api/dshRemoteHost/call',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let rpcId = ''
        try {
          const envelope = await request.json()
          if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string') throw new Error('无效的请求格式')
          rpcId = envelope.rpcId
          const body = envelope.payload?.args
          const result = await service.call(body?.op, body?.payload || {})
          return jsonResponse({ type: 'server-response', rpcId, result: { ok: true, value: result } })
        } catch (error) {
          return jsonResponse({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'remote-host/error', message: safeError(error), details: {} } } })
        }
      },
    }), 'remote-host: API route')
  })
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } })
}

function safeError(error) {
  const message = String(error?.message || error || 'Unknown error')
  return message.replace(/\s+/g, ' ').slice(0, 500)
}
