// Main-process client for the detector daemon's Unix socket.
//
// The daemon is launchd-managed (see `edison-detectord service install`); this
// connects to its socket and speaks newline-delimited JSON: one Reply per
// Request (FIFO, since the daemon serialises requests per connection), plus
// unsolicited Event pushes. Events are re-emitted via the 'event' EventEmitter
// channel for the quarantine/discovery UI to subscribe to.

import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'

import { detectordSocketPath } from './binary'
import {
  isEvent,
  isReply,
  type AgentInfo,
  type Choice,
  type DetectordEvent,
  type Reply,
  type Request,
  type SecretOutcome,
  type ServerConfig,
  type ServerView,
  type Status
} from './protocol'

/** A daemon Reply that carried an { reply: 'error' } becomes a thrown Error. */
export class DetectordError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'DetectordError'
  }
}

type Pending = { resolve: (r: Reply) => void; reject: (e: Error) => void }

export class DetectordClient extends EventEmitter {
  private socket: Socket | null = null
  private buf = ''
  private readonly pending: Pending[] = []
  private connecting: Promise<void> | null = null

  constructor(private readonly socketPath: string = detectordSocketPath()) {
    super()
  }

  /** Connect (idempotent). Rejects if the daemon socket isn't there. */
  connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve()
    if (this.connecting) return this.connecting

    this.connecting = new Promise<void>((resolve, reject) => {
      // A new byte stream must start clean; never inherit a partial frame left
      // in the buffer by a previous (abruptly closed) connection.
      this.buf = ''
      const sock = createConnection(this.socketPath)
      sock.setEncoding('utf8')
      sock.once('connect', () => {
        this.socket = sock
        this.connecting = null
        resolve()
      })
      sock.once('error', (err) => {
        this.connecting = null
        reject(err)
      })
      sock.on('data', (chunk: string) => this.onData(chunk))
      sock.on('close', () => this.onClose())
    })
    return this.connecting
  }

  disconnect(): void {
    this.socket?.destroy()
    this.socket = null
  }

  /** Send a request and await its reply. */
  async request(req: Request): Promise<Reply> {
    await this.connect()
    return new Promise<Reply>((resolve, reject) => {
      this.pending.push({ resolve, reject })
      this.socket!.write(JSON.stringify(req) + '\n')
    })
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        continue // ignore malformed line
      }
      if (isEvent(msg)) {
        this.emit('event', msg as DetectordEvent)
      } else if (isReply(msg)) {
        this.pending.shift()?.resolve(msg as Reply)
      }
    }
  }

  private onClose(): void {
    this.socket = null
    // Drop any partial frame from the dead stream so a reconnect doesn't prepend
    // it to the next reply (which would corrupt + drop that reply, hanging its
    // request until the following disconnect).
    this.buf = ''
    const err = new DetectordError('daemon socket closed')
    while (this.pending.length) this.pending.shift()!.reject(err)
  }

  // ── typed convenience wrappers ────────────────────────────────────────────

  private async expect(req: Request): Promise<Reply> {
    const reply = await this.request(req)
    if (reply.reply === 'error') throw new DetectordError(reply.message)
    return reply
  }

  async status(refresh = false): Promise<Status> {
    const r = await this.expect({ op: 'status', refresh })
    if (r.reply !== 'status') throw new DetectordError(`unexpected reply ${r.reply}`)
    return r
  }

  async listAgents(): Promise<AgentInfo[]> {
    const r = await this.expect({ op: 'list_agents' })
    if (r.reply !== 'agents') throw new DetectordError(`unexpected reply ${r.reply}`)
    return r.agents
  }

  async listServers(): Promise<ServerView[]> {
    const r = await this.expect({ op: 'list_servers' })
    if (r.reply !== 'servers') throw new DetectordError(`unexpected reply ${r.reply}`)
    return r.servers
  }

  async enroll(input: {
    url: string
    key: string
    mcpUrl?: string
    agents?: string[]
    secret?: string
    /** false = detect-only (no edison-watch install / hooks). */
    install?: boolean
    /** Arm auto-quarantine. Set true only once onboarding is complete. */
    armed?: boolean
  }): Promise<Status> {
    const r = await this.expect({
      op: 'enroll',
      url: input.url,
      key: input.key,
      mcp_url: input.mcpUrl,
      agents: input.agents,
      secret: input.secret,
      install: input.install,
      armed: input.armed
    })
    if (r.reply !== 'status') throw new DetectordError(`unexpected reply ${r.reply}`)
    return r
  }

  async disposition(
    name: string,
    choice: Choice,
    agent?: string,
    rename?: string,
    submitConfig?: ServerConfig
  ): Promise<void> {
    await this.expect({ op: 'disposition', name, agent, choice, rename, submit_config: submitConfig })
  }

  async verifySecret(key: string): Promise<SecretOutcome> {
    const r = await this.expect({ op: 'verify_secret', key })
    if (r.reply !== 'secret') throw new DetectordError(`unexpected reply ${r.reply}`)
    return r
  }

  async resetSecret(key: string): Promise<SecretOutcome> {
    const r = await this.expect({ op: 'reset_secret', key, confirm: true })
    if (r.reply !== 'secret') throw new DetectordError(`unexpected reply ${r.reply}`)
    return r
  }

  async unenroll(): Promise<void> {
    await this.expect({ op: 'unenroll' })
  }

  onEvent(cb: (ev: DetectordEvent) => void): this {
    return this.on('event', cb)
  }
}
