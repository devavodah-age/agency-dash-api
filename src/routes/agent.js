const router = require('express').Router()
const db = require('../config/db')
const auth = require('../middleware/auth')
const { runAgent, runAgentForClient } = require('../agent')

// GET /agent/config — list all clients with agent config
router.get('/config', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, email, meta_account_id,
        auto_report_enabled, report_email, report_period, last_report_sent_at
       FROM clients WHERE agency_id=$1 ORDER BY name ASC`,
      [req.user.agency_id]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /agent/config/:client_id — update agent config for a client
router.put('/config/:client_id', auth, async (req, res) => {
  const { auto_report_enabled, report_email, report_period } = req.body
  try {
    const { rows } = await db.query(
      `UPDATE clients SET
        auto_report_enabled = COALESCE($1, auto_report_enabled),
        report_email = COALESCE($2, report_email),
        report_period = COALESCE($3, report_period)
       WHERE id=$4 AND agency_id=$5 RETURNING *`,
      [auto_report_enabled, report_email, report_period, req.params.client_id, req.user.agency_id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' })
    res.json(rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /agent/run — manually trigger agent for all or one client
router.post('/run', auth, async (req, res) => {
  const { client_id } = req.body
  try {
    if (client_id) {
      // Run for specific client
      const { rows: cRows } = await db.query(
        'SELECT c.*, a.meta_access_token as token FROM clients c JOIN agencies a ON a.id=c.agency_id WHERE c.id=$1 AND c.agency_id=$2',
        [client_id, req.user.agency_id]
      )
      if (!cRows[0]) return res.status(404).json({ error: 'Cliente não encontrado' })
      const client = cRows[0]
      const result = await runAgentForClient(client, client.token)
      return res.json([{ client: client.name, ...result }])
    }
    const results = await runAgent(req.user.agency_id)
    res.json(results)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
