const router = require('express').Router()
const auth = require('../middleware/auth')
const db   = require('../config/db')

const GRAPH = 'https://graph.facebook.com/v19.0'
const ALLOWED_PERIODS = ['today','last_7d','last_30d','this_month']

async function getAgencyToken(agency_id) {
  const { rows } = await db.query(
    'SELECT meta_access_token FROM agencies WHERE id=$1', [agency_id]
  )
  return rows[0]?.meta_access_token || null
}

// GET /traffic/clients — lista clientes com meta_account_id
router.get('/clients', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT id, name, meta_account_id FROM clients WHERE agency_id=$1 AND meta_account_id IS NOT NULL AND meta_account_id<>'' ORDER BY name",
      [req.user.agency_id]
    )
    res.json(rows)
  } catch { res.status(500).json({ error: 'Erro interno' }) }
})

// GET /traffic/campaigns?client_id=X&period=last_30d
router.get('/campaigns', auth, async (req, res) => {
  const { client_id, period = 'last_30d' } = req.query
  const date_preset = ALLOWED_PERIODS.includes(period) ? period : 'last_30d'
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })

    const { rows: clients } = client_id
      ? await db.query("SELECT id, name, meta_account_id FROM clients WHERE id=$1 AND agency_id=$2", [client_id, req.user.agency_id])
      : await db.query("SELECT id, name, meta_account_id FROM clients WHERE agency_id=$1 AND meta_account_id IS NOT NULL AND meta_account_id<>''", [req.user.agency_id])

    const allCampaigns = []

    await Promise.allSettled(clients.map(async client => {
      const fields = 'id,name,status,effective_status,daily_budget,lifetime_budget,objective'
      const insFields = 'spend,clicks,impressions,cpc,ctr,actions'
      const url = `${GRAPH}/act_${client.meta_account_id}/campaigns?fields=${fields},insights.date_preset(${date_preset}){${insFields}}&limit=50&access_token=${token}`
      const r = await fetch(url)
      const data = await r.json()
      if (!data.data) return

      data.data.forEach(c => {
        const ins = c.insights?.data?.[0]
        const leads = ins?.actions?.find(a => a.action_type === 'lead')?.value || 0
        const spend = parseFloat(ins?.spend || 0)
        const clicks = parseInt(ins?.clicks || 0)
        const cpl = leads > 0 ? spend / parseInt(leads) : null
        allCampaigns.push({
          id: c.id,
          name: c.name,
          status: c.status,
          effective_status: c.effective_status,
          daily_budget: c.daily_budget ? parseInt(c.daily_budget) / 100 : null,
          objective: c.objective,
          client_id: client.id,
          client_name: client.name,
          meta_account_id: client.meta_account_id,
          spend, clicks, leads: parseInt(leads), cpl,
          ctr: ins ? parseFloat(ins.ctr || 0) : null,
          cpc: ins ? parseFloat(ins.cpc || 0) : null,
          impressions: ins ? parseInt(ins.impressions || 0) : 0,
        })
      })
    }))

    res.json(allCampaigns.sort((a, b) => b.spend - a.spend))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao buscar campanhas' })
  }
})

// POST /traffic/campaigns/:id/status
// body: { status: 'PAUSED'|'ACTIVE', account_id: '...' }
router.post('/campaigns/:id/status', auth, async (req, res) => {
  const { status, account_id } = req.body
  if (!['PAUSED','ACTIVE'].includes(status)) return res.status(400).json({ error: 'Status inválido' })
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })

    const r = await fetch(`${GRAPH}/${req.params.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `status=${status}&access_token=${token}`
    })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ok: true, status })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar status' })
  }
})

// POST /traffic/campaigns/:id/budget
// body: { daily_budget: 50.00 (BRL), account_id: '...' }
router.post('/campaigns/:id/budget', auth, async (req, res) => {
  const { daily_budget } = req.body
  if (!daily_budget || isNaN(daily_budget)) return res.status(400).json({ error: 'Orçamento inválido' })
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })

    const budgetCents = Math.round(parseFloat(daily_budget) * 100)
    const r = await fetch(`${GRAPH}/${req.params.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `daily_budget=${budgetCents}&access_token=${token}`
    })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ok: true, daily_budget: parseFloat(daily_budget) })
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar orçamento' })
  }
})

// POST /traffic/optimize
// body: { client_id (optional), period }
// Chama Claude para analisar campanhas e retornar recomendações
router.post('/optimize', auth, async (req, res) => {
  const { client_id, period = 'last_30d' } = req.body
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY não configurado no servidor' })

  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })

    const date_preset = ALLOWED_PERIODS.includes(period) ? period : 'last_30d'
    const { rows: clients } = client_id
      ? await db.query("SELECT id, name, meta_account_id FROM clients WHERE id=$1 AND agency_id=$2", [client_id, req.user.agency_id])
      : await db.query("SELECT id, name, meta_account_id FROM clients WHERE agency_id=$1 AND meta_account_id IS NOT NULL AND meta_account_id<>''", [req.user.agency_id])

    const campaigns = []
    await Promise.allSettled(clients.map(async client => {
      const fields = 'id,name,status,effective_status,daily_budget,objective'
      const insFields = 'spend,clicks,impressions,cpc,ctr,actions,cost_per_action_type'
      const url = `${GRAPH}/act_${client.meta_account_id}/campaigns?fields=${fields},insights.date_preset(${date_preset}){${insFields}}&limit=50&access_token=${token}`
      const r = await fetch(url)
      const data = await r.json()
      if (!data.data) return
      data.data.forEach(c => {
        const ins = c.insights?.data?.[0]
        const leads = parseInt(ins?.actions?.find(a => a.action_type === 'lead')?.value || 0)
        const spend = parseFloat(ins?.spend || 0)
        campaigns.push({
          id: c.id, name: c.name,
          cliente: client.name,
          status: c.effective_status,
          orcamento_diario: c.daily_budget ? parseInt(c.daily_budget) / 100 : null,
          gasto: spend, cliques: parseInt(ins?.clicks || 0),
          leads, cpl: leads > 0 ? (spend / leads).toFixed(2) : null,
          ctr: ins ? parseFloat(ins.ctr || 0).toFixed(2) : null,
          cpc: ins ? parseFloat(ins.cpc || 0).toFixed(2) : null,
          impressoes: parseInt(ins?.impressions || 0),
        })
      })
    }))

    if (campaigns.length === 0) return res.status(400).json({ error: 'Nenhuma campanha encontrada para analisar' })

    const prompt = `Você é um especialista em tráfego pago no Meta Ads (Facebook/Instagram) para uma agência de marketing digital brasileira.

Analise as seguintes campanhas e retorne recomendações de otimização em JSON.

Dados das campanhas (período: ${date_preset.replace('_',' ')}):
${JSON.stringify(campaigns, null, 2)}

Retorne APENAS um objeto JSON válido (sem markdown, sem explicações) com este formato exato:
{
  "resumo": "string com análise geral em 2-3 frases",
  "recomendacoes": [
    {
      "campaign_id": "string",
      "campaign_name": "string",
      "cliente": "string",
      "acao": "pausar|escalar|reduzir|manter",
      "percentual": null ou número (ex: 20 para +20% no orçamento),
      "motivo": "string explicando o porquê em 1 frase objetiva",
      "prioridade": "alta|media|baixa"
    }
  ]
}

Critérios:
- Pausar: CPL > R$80, CTR < 0.5%, gasto > R$20 sem leads, ou status já PAUSED e performance ruim
- Escalar: CPL < R$30, CTR > 1.5%, leads consistentes — sugira 20-50% de aumento
- Reduzir orçamento: CPL entre R$50-80, poucos leads — sugira 20-30% de redução
- Manter: performance dentro da média
- Campanhas sem gasto ou pausadas sem dados: sugira manter ou revisar criativos`

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      })
    })

    const aiData = await aiResp.json()
    if (aiData.error) return res.status(500).json({ error: aiData.error.message })

    const text = aiData.content[0].text.trim()
    const parsed = JSON.parse(text)
    res.json(parsed)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao gerar otimização: ' + err.message })
  }
})

module.exports = router
