const router = require('express').Router()
const auth = require('../middleware/auth')
const db = require('../config/db')

// GET /meta/overview?period=last_7d|last_30d|today — dados agregados de todos os clientes
router.get('/overview', auth, async (req, res) => {
  const period = req.query.period || 'last_30d'
  const allowed = ['today', 'last_7d', 'last_30d', 'this_month']
  const date_preset = allowed.includes(period) ? period : 'last_30d'

  try {
    const { rows: agency } = await db.query(
      'SELECT meta_bm_id, meta_access_token FROM agencies WHERE id = $1',
      [req.user.agency_id]
    )
    const ag = agency[0]
    if (!ag?.meta_access_token) {
      return res.status(400).json({ error: 'Token da agência não configurado' })
    }

    const { rows: clients } = await db.query(
      'SELECT id, name, meta_account_id FROM clients WHERE agency_id = $1 AND meta_account_id IS NOT NULL AND meta_account_id != '''\'\ ORDER BY name ASC',
      [req.user.agency_id]
    )

    const { rows: allClients } = await db.query(
      'SELECT COUNT(*) as total FROM clients WHERE agency_id = $1',
      [req.user.agency_id]
    )

    const fields = 'spend,clicks,impressions,actions'
    const results = await Promise.allSettled(
      clients.map(async (client) => {
        const url = `https://graph.facebook.com/v19.0/act_${client.meta_account_id}/insights?fields=${fields}&date_preset=${date_preset}&access_token=${ag.meta_access_token}`
        const resp = await fetch(url)
        const data = await resp.json()
        if (data.error || !data.data?.[0]) return null
        const ins = data.data[0]
        const leads = ins.actions?.find(a => a.action_type === 'lead')?.value || 0
        const spend = parseFloat(ins.spend || 0)
        return {
          id: client.id,
          name: client.name,
          spend,
          clicks: parseInt(ins.clicks || 0),
          impressions: parseInt(ins.impressions || 0),
          leads: parseInt(leads),
          cpl: leads > 0 ? parseFloat((spend / leads).toFixed(2)) : null,
        }
      })
    )

    const clientData = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)

    const totals = clientData.reduce((acc, c) => ({
      spend: acc.spend + c.spend,
      clicks: acc.clicks + c.clicks,
      leads: acc.leads + c.leads,
    }), { spend: 0, clicks: 0, leads: 0 })

    const avgCpl = totals.leads > 0 ? parseFloat((totals.spend / totals.leads).toFixed(2)) : null

    res.json({
      period: date_preset,
      total_clients: parseInt(allClients[0].total),
      active_clients: clientData.length,
      totals: { ...totals, cpl: avgCpl },
      clients: clientData,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao buscar dados da Meta' })
  }
})

// GET /meta/insights/:client_id
router.get('/insights/:client_id', auth, async (req, res) => {
  try {
    const { rows: agency } = await db.query(
      'SELECT meta_access_token FROM agencies WHERE id = $1',
      [req.user.agency_id]
    )
    const agToken = agency[0]?.meta_access_token

    const { rows } = await db.query(
      'SELECT meta_account_id, meta_access_token FROM clients WHERE id = $1 AND agency_id = $2',
      [req.params.client_id, req.user.agency_id]
    )
    const client = rows[0]
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado' })

    const token = client.meta_access_token || agToken
    if (!client.meta_account_id || !token) {
      return res.status(400).json({ error: 'Conta Meta não configurada' })
    }

    const fields = 'spend,clicks,impressions,reach,actions,cpm,cpc'
    const url = `https://graph.facebook.com/v19.0/act_${client.meta_account_id}/insights?fields=${fields}&date_preset=last_30d&access_token=${token}`
    const response = await fetch(url)
    const data = await response.json()

    if (data.error) return res.status(400).json({ error: data.error.message })

    const insights = data.data?.[0] || null
    if (!insights) return res.json({ message: 'Sem dados no período', data: null })

    const leads = insights.actions?.find(a => a.action_type === 'lead')?.value || 0
    const spend = parseFloat(insights.spend || 0)
    const cpl = leads > 0 ? (spend / leads).toFixed(2) : null

    res.json({
      spend, clicks: parseInt(insights.clicks || 0),
      impressions: parseInt(insights.impressions || 0),
      reach: parseInt(insights.reach || 0),
      leads: parseInt(leads), cpl: cpl ? parseFloat(cpl) : null,
      cpm: parseFloat(insights.cpm || 0), cpc: parseFloat(insights.cpc || 0),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao buscar dados da Meta' })
  }
})

// GET /meta/test/:client_id
router.get('/test/:client_id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT meta_account_id, meta_access_token FROM clients WHERE id = $1 AND agency_id = $2',
      [req.params.client_id, req.user.agency_id]
    )
    const client = rows[0]
    if (!client?.meta_account_id || !client?.meta_access_token) {
      return res.status(400).json({ error: 'Credenciais Meta não configuradas' })
    }
    const url = `https://graph.facebook.com/v19.0/act_${client.meta_account_id}?fields=name,account_status&access_token=${client.meta_access_token}`
    const response = await fetch(url)
    const data = await response.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ connected: true, account_name: data.name, status: data.account_status })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao testar conexão' })
  }
})

module.exports = router
