const router = require('express').Router()
const auth = require('../middleware/auth')
const db = require('../config/db')

// GET /meta/insights/:client_id — busca dados da Meta Ads para um cliente
router.get('/insights/:client_id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT meta_account_id, meta_access_token FROM clients WHERE id = $1 AND agency_id = $2',
      [req.params.client_id, req.user.agency_id]
    )

    const client = rows[0]
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado' })
    if (!client.meta_account_id || !client.meta_access_token) {
      return res.status(400).json({ error: 'Conta Meta não configurada para este cliente' })
    }

    const { meta_account_id, meta_access_token } = client
    const fields = 'spend,clicks,impressions,reach,actions,cpm,cpc'
    const url = `https://graph.facebook.com/v19.0/act_${meta_account_id}/insights?fields=${fields}&date_preset=last_30d&access_token=${meta_access_token}`

    const response = await fetch(url)
    const data = await response.json()

    if (data.error) {
      return res.status(400).json({ error: data.error.message })
    }

    const insights = data.data?.[0] || null
    if (!insights) return res.json({ message: 'Sem dados no período', data: null })

    const leads = insights.actions?.find(a => a.action_type === 'lead')?.value || 0
    const spend = parseFloat(insights.spend || 0)
    const cpl = leads > 0 ? (spend / leads).toFixed(2) : null

    res.json({
      spend,
      clicks: parseInt(insights.clicks || 0),
      impressions: parseInt(insights.impressions || 0),
      reach: parseInt(insights.reach || 0),
      leads: parseInt(leads),
      cpl: cpl ? parseFloat(cpl) : null,
      cpm: parseFloat(insights.cpm || 0),
      cpc: parseFloat(insights.cpc || 0),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao buscar dados da Meta' })
  }
})

// GET /meta/test/:client_id — testa conexão com a Meta
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
