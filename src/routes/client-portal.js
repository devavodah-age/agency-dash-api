const router = require('express').Router()
const jwt = require('jsonwebtoken')
const db = require('../config/db')

const WHATSAPP = '5575983330720'
const SUPPORT_EMAIL = 'devavodah@gmail.com'

// Middleware de auth cliente
const clientAuth = (req, res, next) => {
  const auth = req.headers.authorization
  if (!auth) return res.status(401).json({ error: 'Sem token' })
  try {
    const payload = jwt.verify(auth.replace('Bearer ', ''), process.env.JWT_SECRET)
    if (payload.role !== 'client') return res.status(403).json({ error: 'Acesso negado' })
    req.clientUser = payload
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido' })
  }
}

// GET /client-portal/metrics
router.get('/metrics', clientAuth, async (req, res) => {
  const { client_id } = req.clientUser
  if (!client_id) return res.status(400).json({ error: 'Conta não vinculada. Aguarde a agência vincular seu acesso.' })

  try {
    const { rows: agRows } = await db.query(
      'SELECT a.meta_access_token FROM agencies a JOIN clients c ON c.agency_id = a.id WHERE c.id = $1',
      [client_id]
    )
    const { rows: cRows } = await db.query('SELECT * FROM clients WHERE id=$1', [client_id])
    const client = cRows[0]
    const token = agRows[0]?.meta_access_token

    if (!client?.meta_account_id || !token) {
      return res.json({ spend: 0, clicks: 0, leads: 0, cpl: null, linked: false })
    }

    const allowed = ['today', 'last_7d', 'last_30d', 'this_month']
    const period = allowed.includes(req.query.period) ? req.query.period : 'last_30d'
    const fields = 'spend,clicks,impressions,actions'
    const url = `https://graph.facebook.com/v19.0/act_${client.meta_account_id}/insights?fields=${fields}&date_preset=${period}&access_token=${token}`
    const resp = await fetch(url)
    const data = await resp.json()

    if (data.error || !data.data?.[0]) return res.json({ spend: 0, clicks: 0, leads: 0, cpl: null, linked: true })

    const ins = data.data[0]
    const leadsAction = ins.actions?.find(a => a.action_type === 'lead')
    const leads = leadsAction ? parseInt(leadsAction.value) : 0
    const spend = parseFloat(ins.spend || 0)

    res.json({
      linked: true,
      client_name: client.name,
      period,
      spend,
      clicks: parseInt(ins.clicks || 0),
      impressions: parseInt(ins.impressions || 0),
      leads,
      cpl: leads > 0 ? parseFloat((spend / leads).toFixed(2)) : null,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao buscar métricas' })
  }
})

// GET /client-portal/tickets
router.get('/tickets', clientAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM tickets WHERE client_user_id=$1 ORDER BY created_at DESC',
      [req.clientUser.id]
    )
    res.json(rows)
  } catch {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// POST /client-portal/tickets
router.post('/tickets', clientAuth, async (req, res) => {
  const { subject, message } = req.body
  if (!subject || !message) return res.status(400).json({ error: 'Preencha todos os campos' })
  try {
    const { rows } = await db.query(
      'INSERT INTO tickets (client_id, client_user_id, subject, message) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.clientUser.client_id, req.clientUser.id, subject, message]
    )
    res.status(201).json({ ticket: rows[0], whatsapp: WHATSAPP, email: SUPPORT_EMAIL })
  } catch {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// GET /client-portal/support-info
router.get('/support-info', clientAuth, (req, res) => {
  res.json({ whatsapp: WHATSAPP, email: SUPPORT_EMAIL })
})

module.exports = router
