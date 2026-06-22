import dns from 'node:dns'
import net from 'node:net'

const dnsHosts = ['imap.gmail.com', 'gmail.com', 'registry.npmjs.org', 'ai-relay.chainbot.io', 'localhost']
const tcpTargets: Array<[string, number]> = [
  ['imap.gmail.com', 993],
  ['gmail.com', 443],
  ['registry.npmjs.org', 443],
  ['ai-relay.chainbot.io', 443],
  ['8.8.8.8', 53],
  ['1.1.1.1', 443],
  ['127.0.0.1', 5180],
]

function lookup(host: string) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, addresses) => {
      resolve({
        host,
        ok: !err,
        ...(err ? { code: (err as NodeJS.ErrnoException).code, message: err.message } : {}),
        ...(!err ? { addresses: addresses.slice(0, 3) } : {}),
      })
    })
  })
}

function connect(host: string, port: number) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 5000 })
    const done = (payload: Record<string, unknown>) => {
      resolve({ host, port, ...payload })
      socket.destroy()
    }
    socket.once('connect', () => done({ ok: true }))
    socket.once('timeout', () => done({ ok: false, error: 'timeout' }))
    socket.once('error', (err: NodeJS.ErrnoException) => done({ ok: false, code: err.code, message: err.message }))
  })
}

async function main() {
  const dnsResults = []
  for (const host of dnsHosts) dnsResults.push(await lookup(host))

  const tcpResults = []
  for (const [host, port] of tcpTargets) tcpResults.push(await connect(host, port))

  const proxyEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => /^(ALL_PROXY|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|npm_config_proxy|npm_config_https_proxy)$/i.test(key))
      .map(([key]) => [key, '<set>']),
  )

  console.log(JSON.stringify({ dns: dnsResults, tcp: tcpResults, proxyEnv }, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }, null, 2))
  process.exit(1)
})
