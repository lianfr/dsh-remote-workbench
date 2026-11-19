import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile, mkdir, appendFile, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const SSH_DIR = join(homedir(), '.ssh')
const CONFIG_PATH = join(SSH_DIR, 'config')

function isOutside(root, target) {
  const rel = relative(root, target)
  return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)
}

export async function readHosts() {
  const sshRoot = await realpath(SSH_DIR).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!sshRoot) return []
  const hosts = []
  const visited = new Set()
  let current = []
  async function visit(file) {
    if (visited.size >= 256) return
    const actual = await realpath(file).catch(() => null)
    if (!actual || visited.has(actual)) return
    if (isOutside(sshRoot, actual)) return
    visited.add(actual)
    const text = await readFile(actual, 'utf8')
    for (const sourceLine of text.split(/\r?\n/)) {
      const line = sourceLine.replace(/\s+#.*$/, '').trim()
      if (!line) continue
      const match = line.match(/^(\S+)\s+(.*)$/)
      if (!match) continue
      const directive = match[1].toLowerCase()
      if (directive === 'include') {
        for (const rawPattern of match[2].split(/\s+/)) {
          const pattern = rawPattern.replace(/^~(?=\/|$)/, homedir())
          const absolute = isAbsolute(pattern) ? pattern : resolve(SSH_DIR, pattern)
          const directory = await realpath(dirname(absolute)).catch(() => null)
          if (!directory) continue
          if (isOutside(sshRoot, directory)) continue
          const name = basename(absolute)
          const matcher = new RegExp('^' + [...name].map((char) => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('') + '$')
          const candidates = /[*?]/.test(name) ? (await readdir(directory)).filter((entry) => matcher.test(entry)) : [name]
          for (const entry of candidates.sort()) await visit(join(directory, entry))
        }
        continue
      }
      if (directive === 'host') {
        current = []
        for (const alias of match[2].split(/\s+/)) {
          if (!alias || /[*?!]/.test(alias)) continue
          const host = { id: alias, hostName: alias, user: '', port: 22 }
          current.push(host)
          hosts.push(host)
        }
      } else if (current.length) {
        for (const host of current) {
          if (directive === 'hostname') host.hostName = match[2]
          if (directive === 'user') host.user = match[2]
          if (directive === 'port' && /^\d+$/.test(match[2])) host.port = Number(match[2])
        }
      }
    }
  }
  await visit(CONFIG_PATH)
  return hosts.filter((host, index) => hosts.findIndex((item) => item.id.toLowerCase() === host.id.toLowerCase()) === index)
}

export async function saveHost(input) {
  const alias = clean(input.alias, 'alias', 64)
  const hostName = clean(input.hostName, 'host', 253)
  const user = clean(input.user, 'user', 64)
  const port = input.port === undefined || input.port === null || input.port === '' ? 22 : Number(input.port)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) throw new Error('别名只允许字母、数字、点、下划线和连字符')
  if (!/^[A-Za-z0-9_.:%+-]+$/.test(hostName)) throw new Error('主机名格式无效')
  if (!/^[A-Za-z0-9_.-]+$/.test(user)) throw new Error('SSH 用户名格式无效')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间')
  const hosts = await readHosts()
  if (hosts.some((host) => host.id.toLowerCase() === alias.toLowerCase())) throw new Error('SSH 配置中已存在此别名')
  await mkdir(SSH_DIR, { recursive: true, mode: 0o700 })
  const block = `\nHost ${alias}\n  HostName ${hostName}\n  User ${user}\n  Port ${port}\n`
  await appendFile(CONFIG_PATH, block, { encoding: 'utf8', mode: 0o600, flag: 'a' })
  return { id: alias, hostName, user, port, saved: true }
}

export function createSshPool(source) {
  const workers = new Map()
  const disconnected = new Set()
  let nextId = 0
  function start(alias, via = null) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(alias))) throw new Error('无效的 SSH 主机别名')
    const key = via ? `${via.jump}|${via.name || alias}|${via.port}|${via.user}|${alias}` : alias
    const route = via ? ['-J', via.jump, '-p', String(via.port), '-l', via.user, alias] : [alias]
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', ...route, 'python3', '-u', '-c', shellQuote(source)], { stdio: ['pipe', 'pipe', 'pipe'] })
    const worker = { child, pending: new Map(), stderr: '' }
    workers.set(key, worker)
    const fail = (error) => {
      if (workers.get(key) === worker) workers.delete(key)
      for (const item of worker.pending.values()) { clearTimeout(item.timer); item.reject(error) }
      worker.pending.clear()
    }
    worker.fail = fail
    child.stderr.on('data', chunk => { worker.stderr = (worker.stderr + chunk).slice(-32768) })
    child.stdin.on('error', error => fail(new Error('SSH 连接已中断：' + error.message)))
    child.on('error', error => fail(new Error(error.code === 'ENOENT' ? '本机未找到 OpenSSH ssh 命令' : error.message)))
    child.on('close', () => fail(new Error((worker.stderr.trim() || 'SSH 连接已中断').slice(0, 500))))
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      let response
      try { response = JSON.parse(line) } catch { child.kill(); fail(new Error('远程主机返回了无法识别的数据')); return }
      const item = worker.pending.get(response.id)
      if (!item) return
      worker.pending.delete(response.id); clearTimeout(item.timer)
      response.ok ? item.resolve(response.value) : item.reject(new Error(response.error || '远程操作失败'))
    })
    return worker
  }
  return {
    connect(alias) { disconnected.delete(alias) },
    disconnect(alias) {
      disconnected.add(alias)
      this.closeVia(alias)
      const worker = workers.get(alias)
      if (worker) { worker.fail(new Error('SSH 连接已断开')); worker.child.kill() }
    },
    closeVia(jump, keep = []) {
      for (const [key, worker] of workers) {
        if (key.startsWith(jump + '|') && !keep.includes(key.split('|')[1] + ':' + key.split('|')[2])) {
          worker.fail(new Error('已停止节点监控')); worker.child.kill()
        }
      }
    },
    request(alias, payload, timeout = 25000, via = null) {
      if (disconnected.has(via?.jump || alias)) return Promise.reject(new Error('SSH 连接已断开，请重新选择服务器'))
      const key = via ? `${via.jump}|${via.name || alias}|${via.port}|${via.user}|${alias}` : alias
      const worker = workers.get(key) || start(alias, via)
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.child.kill(); }, timeout)
        worker.pending.set(id, { resolve, reject, timer })
        worker.child.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
      })
    },
    dispose() { for (const worker of workers.values()) worker.child.kill(); workers.clear() },
  }
}

function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'" }

function clean(value, label, max) {
  const result = String(value || '').trim()
  if (!result || result.length > max || /[\r\n\0]/.test(result)) throw new Error(`无效的 ${label}`)
  return result
}
