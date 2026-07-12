'use strict'

const express = require('express')
const { v4: uuidv4 } = require('uuid')
const { BeraClient } = require('bera-baileys')
const path = require('path')
const fs = require('fs')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000
const SESSIONS_DIR = path.join(__dirname, 'sessions')
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// In-memory registry: sessionId -> { client, status, code, error }
// status: connecting -> code-ready -> connected  (or -> error / disconnected / logged-out)
const sessions = new Map()

// Basic in-memory rate limiting so this endpoint can't be hammered to spin up
// unlimited WhatsApp sessions. Fine for a single Render instance; if you scale
// to multiple instances, swap this for a shared store (Redis, etc).
const attempts = new Map() // ip -> [timestamps]
const MAX_ATTEMPTS = 5
const WINDOW_MS = 10 * 60 * 1000

function rateLimited(ip) {
  const now = Date.now()
  const list = (attempts.get(ip) || []).filter(t => now - t < WINDOW_MS)
  list.push(now)
  attempts.set(ip, list)
  return list.length > MAX_ATTEMPTS
}

function normalizePhone(raw) {
  return String(raw || '').replace(/[^\d]/g, '')
}

async function cleanupSession(sessionId) {
  const entry = sessions.get(sessionId)
  if (!entry) return false
  try {
    if (entry.client) await entry.client.stop()
  } catch (_) {
    // ignore shutdown errors
  }
  sessions.delete(sessionId)
  return true
}

// ── API ──────────────────────────────────────────────────────────────────────

app.post('/api/pair', async (req, res) => {
  const ip = req.ip
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many pairing attempts. Try again later.' })
  }

  const phoneNumber = normalizePhone(req.body.phoneNumber)
  if (!phoneNumber || phoneNumber.length < 8 || phoneNumber.length > 15) {
    return res.status(400).json({
      error: 'Enter a valid phone number with country code, digits only (e.g. 12025550123).',
    })
  }

  const sessionId = uuidv4()
  const sessionPath = path.join(SESSIONS_DIR, sessionId)

  const entry = { status: 'connecting', code: null, error: null, client: null }
  sessions.set(sessionId, entry)

  try {
    const client = new BeraClient({
      sessionPath,
      pairingCode: true,
      phoneNumber,
      qrWeb: false,
      printQR: false,
      antiBan: true,
    })
    entry.client = client

    client.on('pairing-code', code => {
      entry.code = code
      entry.status = 'code-ready'
    })

    client.on('ready', () => {
      entry.status = 'connected'
    })

    client.on('disconnected', ({ reason, willReconnect }) => {
      if (!willReconnect) {
        entry.status = 'disconnected'
        entry.error = reason ? String(reason) : 'Disconnected'
      }
    })

    client.on('logout', () => {
      entry.status = 'logged-out'
    })

    await client.start()
    res.json({ sessionId })
  } catch (err) {
    entry.status = 'error'
    entry.error = err && err.message ? err.message : 'Failed to start pairing session'
    res.status(500).json({ error: entry.error })
  }

  // Auto-expire abandoned sessions after 10 minutes so processes/creds don't pile up.
  setTimeout(() => {
    const e = sessions.get(sessionId)
    if (e && e.status !== 'connected') {
      cleanupSession(sessionId)
    }
  }, 10 * 60 * 1000)
})

app.get('/api/status/:sessionId', (req, res) => {
  const entry = sessions.get(req.params.sessionId)
  if (!entry) return res.status(404).json({ error: 'Unknown or expired session' })
  res.json({
    status: entry.status,
    code: entry.code,
    error: entry.error,
  })
})

app.post('/api/cancel/:sessionId', async (req, res) => {
  const ok = await cleanupSession(req.params.sessionId)
  if (!ok) return res.status(404).json({ error: 'Unknown session' })
  res.json({ ok: true })
})

// ── Frontend (inlined so this is a single deployable file) ────────────────────

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Link WhatsApp</title>
<style>
  :root {
    --green: #25d366;
    --dark: #0b141a;
    --panel: #111b21;
    --muted: #8696a0;
    --border: #263238;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--dark);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #e9edef;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 400px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 32px 28px;
  }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p.sub { color: var(--muted); font-size: 14px; margin: 0 0 24px; line-height: 1.5; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input[type="text"] {
    width: 100%;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: #1a252b;
    color: #e9edef;
    font-size: 16px;
    outline: none;
  }
  input[type="text"]:focus { border-color: var(--green); }
  button {
    width: 100%;
    margin-top: 18px;
    padding: 12px 14px;
    border: none;
    border-radius: 10px;
    background: var(--green);
    color: #06210f;
    font-weight: 600;
    font-size: 15px;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .status { margin-top: 20px; font-size: 13px; color: var(--muted); text-align: center; min-height: 18px; }
  .code-box { display: none; margin-top: 20px; text-align: center; }
  .code {
    font-size: 30px;
    font-weight: 700;
    letter-spacing: 4px;
    color: var(--green);
    background: #0e1a12;
    border: 1px dashed var(--green);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 10px;
  }
  .steps { text-align: left; font-size: 13px; color: var(--muted); line-height: 1.6; margin-top: 12px; }
  .connected { display: none; text-align: center; }
  .connected .check { font-size: 40px; }
  .error { color: #f2777a; font-size: 13px; text-align: center; margin-top: 12px; display: none; }
</style>
</head>
<body>
  <div class="card">
    <div id="formView">
      <h1>Link your WhatsApp</h1>
      <p class="sub">Enter your number with country code (no + or spaces) to get an 8‑character pairing code.</p>
      <label for="phone">Phone number</label>
      <input type="text" id="phone" placeholder="12025550123" inputmode="numeric" />
      <button id="submitBtn">Get pairing code</button>
      <div class="status" id="status"></div>
      <div class="error" id="error"></div>
    </div>

    <div class="code-box" id="codeBox">
      <h1>Your pairing code</h1>
      <div class="code" id="codeText">--------</div>
      <div class="steps">
        1. Open WhatsApp on your phone<br/>
        2. Go to Settings &rarr; Linked Devices<br/>
        3. Tap "Link a device", then "Link with phone number instead"<br/>
        4. Enter the code above
      </div>
      <div class="status" id="codeStatus">Waiting for you to enter the code...</div>
    </div>

    <div class="connected" id="connectedView">
      <div class="check">✅</div>
      <h1>Connected!</h1>
      <p class="sub">This WhatsApp number is now linked.</p>
    </div>
  </div>

<script>
  const formView = document.getElementById('formView')
  const codeBox = document.getElementById('codeBox')
  const connectedView = document.getElementById('connectedView')
  const statusEl = document.getElementById('status')
  const errorEl = document.getElementById('error')
  const codeTextEl = document.getElementById('codeText')
  const submitBtn = document.getElementById('submitBtn')
  const phoneInput = document.getElementById('phone')

  let pollTimer = null

  async function startPairing() {
    errorEl.style.display = 'none'
    const phoneNumber = phoneInput.value.trim()
    if (!phoneNumber) return

    submitBtn.disabled = true
    statusEl.textContent = 'Requesting pairing code...'

    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to start pairing')
      pollStatus(data.sessionId)
    } catch (err) {
      submitBtn.disabled = false
      statusEl.textContent = ''
      errorEl.textContent = err.message
      errorEl.style.display = 'block'
    }
  }

  function pollStatus(sessionId) {
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/status/' + sessionId)
        const data = await res.json()

        if (!res.ok) {
          clearInterval(pollTimer)
          errorEl.textContent = data.error || 'Session expired'
          errorEl.style.display = 'block'
          submitBtn.disabled = false
          return
        }

        if (data.status === 'code-ready' && data.code) {
          formView.style.display = 'none'
          codeBox.style.display = 'block'
          codeTextEl.textContent = data.code
        }

        if (data.status === 'connected') {
          clearInterval(pollTimer)
          codeBox.style.display = 'none'
          formView.style.display = 'none'
          connectedView.style.display = 'block'
        }

        if (data.status === 'error' || data.status === 'disconnected' || data.status === 'logged-out') {
          clearInterval(pollTimer)
          codeBox.style.display = 'none'
          formView.style.display = 'block'
          submitBtn.disabled = false
          errorEl.textContent = data.error || 'Pairing failed. Try again.'
          errorEl.style.display = 'block'
        }
      } catch (_) {
        // transient network hiccup, keep polling
      }
    }, 2000)
  }

  submitBtn.addEventListener('click', startPairing)
  phoneInput.addEventListener('keydown', e => { if (e.key === 'Enter') startPairing() })
</script>
</body>
</html>`

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.send(HTML_PAGE)
})

app.listen(PORT, () => {
  console.log(`Pairing site running on port ${PORT}`)
})
