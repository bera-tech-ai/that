'use strict'

const express = require('express')
const { v4: uuidv4 } = require('uuid')
const { BeraClient } = require('bera-baileys')
const path = require('path')
const fs = require('fs')

const app = express()
app.use(express.urlencoded({ extended: true })) // parses regular HTML form posts

const PORT = process.env.PORT || 3000
const SESSIONS_DIR = path.join(__dirname, 'sessions')
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// sessionId -> { client, status, code, error }
const sessions = new Map()

function normalizePhone(raw) {
  return String(raw || '').replace(/[^\d]/g, '')
}

function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
  :root { --green:#25d366; --dark:#0b141a; --panel:#111b21; --muted:#8696a0; --border:#263238; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--dark); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #e9edef; padding: 24px;
  }
  .card { width: 100%; max-width: 400px; background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 32px 28px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p.sub { color: var(--muted); font-size: 14px; margin: 0 0 24px; line-height: 1.5; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input[type="text"] {
    width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border);
    background: #1a252b; color: #e9edef; font-size: 16px; outline: none;
  }
  input[type="text"]:focus { border-color: var(--green); }
  button {
    width: 100%; margin-top: 18px; padding: 12px 14px; border: none; border-radius: 10px;
    background: var(--green); color: #06210f; font-weight: 600; font-size: 15px; cursor: pointer;
  }
  .status { margin-top: 20px; font-size: 13px; color: var(--muted); text-align: center; }
  .code { font-size: 30px; font-weight: 700; letter-spacing: 4px; color: var(--green); background: #0e1a12; border: 1px dashed var(--green); border-radius: 10px; padding: 16px; margin-bottom: 10px; text-align: center; }
  .steps { text-align: left; font-size: 13px; color: var(--muted); line-height: 1.6; margin-top: 12px; }
  .error { color: #f2777a; font-size: 13px; text-align: center; margin-top: 12px; }
  .check { font-size: 40px; text-align: center; }
  a.link { color: var(--green); }
</style>
</head>
<body>
  <div class="card">${bodyHtml}</div>
</body>
</html>`
}

// ── Home page: plain HTML form, normal POST (no JS) ───────────────────────────
app.get('/', (req, res) => {
  res.send(layout('Link WhatsApp', `
    <h1>Link your WhatsApp</h1>
    <p class="sub">Enter your number with country code (no + or spaces) to get an 8-character pairing code.</p>
    <form method="POST" action="/pair">
      <label for="phone">Phone number</label>
      <input type="text" id="phone" name="phoneNumber" placeholder="254116763755" required />
      <button type="submit">Get pairing code</button>
    </form>
  `))
})

// ── Handle form submit, start pairing, redirect to status page ──────────────
app.post('/pair', async (req, res) => {
  const phoneNumber = normalizePhone(req.body.phoneNumber)
  if (!phoneNumber || phoneNumber.length < 8 || phoneNumber.length > 15) {
    return res.send(layout('Link WhatsApp', `
      <h1>Link your WhatsApp</h1>
      <div class="error">Enter a valid phone number with country code, digits only.</div>
      <p class="sub"><a class="link" href="/">Try again</a></p>
    `))
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
    client.on('ready', () => { entry.status = 'connected' })
    client.on('disconnected', ({ reason, willReconnect }) => {
      if (!willReconnect) {
        entry.status = 'disconnected'
        entry.error = reason ? String(reason) : 'Disconnected'
      }
    })
    client.on('logout', () => { entry.status = 'logged-out' })

    await client.start()
  } catch (err) {
    entry.status = 'error'
    entry.error = err && err.message ? err.message : 'Failed to start pairing session'
  }

  setTimeout(() => {
    const e = sessions.get(sessionId)
    if (e && e.status !== 'connected') {
      try { if (e.client) e.client.stop() } catch (_) {}
      sessions.delete(sessionId)
    }
  }, 10 * 60 * 1000)

  res.redirect(`/status/${sessionId}`)
})

// ── Status page: server-rendered, auto-refreshes itself every 2s ────────────
app.get('/status/:id', (req, res) => {
  const entry = sessions.get(req.params.id)

  if (!entry) {
    return res.send(layout('Session expired', `
      <h1>Session expired</h1>
      <p class="sub"><a class="link" href="/">Start over</a></p>
    `))
  }

  if (entry.status === 'connecting') {
    res.set('Refresh', '2')
    return res.send(layout('Connecting...', `
      <h1>Connecting...</h1>
      <div class="status">Requesting your pairing code, one moment.</div>
    `))
  }

  if (entry.status === 'code-ready') {
    res.set('Refresh', '5')
    return res.send(layout('Your pairing code', `
      <h1>Your pairing code</h1>
      <div class="code">${entry.code}</div>
      <div class="steps">
        1. Open WhatsApp on your phone<br/>
        2. Go to Settings &rarr; Linked Devices<br/>
        3. Tap "Link a device", then "Link with phone number instead"<br/>
        4. Enter the code above
      </div>
      <div class="status">This page refreshes automatically once you're linked.</div>
    `))
  }

  if (entry.status === 'connected') {
    return res.send(layout('Connected', `
      <div class="check">✅</div>
      <h1>Connected!</h1>
      <p class="sub">This WhatsApp number is now linked.</p>
    `))
  }

  // error / disconnected / logged-out
  return res.send(layout('Pairing failed', `
    <h1>Pairing failed</h1>
    <div class="error">${entry.error || 'Something went wrong.'}</div>
    <p class="sub"><a class="link" href="/">Try again</a></p>
  `))
})

app.listen(PORT, () => {
  console.log(`Pairing site running on port ${PORT}`)
})
