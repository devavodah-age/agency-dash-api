const router = require('express').Router()
const auth = require('../middleware/auth')
const db   = require('../config/db')

const GRAPH = 'https://graph.facebook.com/v19.0'
const ALLOWED_PERIODS = ['today','last_7d','last_30d','this_month']

// Higher priority types win when multiple actions exist
const ACTION_PRIORITY = [
  'purchase', 'omni_purchase',
  'lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped',
  'landing_page_view',
  'instagram_profile_visit', 'onsite_conversion.view_content',
  'follow', 'link_click',
  'omni_post_engagement', 'page_engagement', 'post_engagement',
  'video_view', 'comment', 'like',
]

// Types that are aggregated totals and should not be primary (they double-count)
const SKIP_TYPES = new Set([
  'omni_initiated_checkout', 'omni_add_to_cart',
])

function getPrimaryResult(actions, reach) {
  if (Array.isArray(actions) && actions.length) {
    const map = {}
    for (const a of actions) {
      if (!SKIP_TYPES.has(a.action_type)) {
        map[a.action_type] = parseInt(a.value || 0, 10)
      }
    }
    // 1st: try known priority types
    for (const t of ACTION_PRIORITY) {
      if ((map[t] || 0) > 0) return { results: map[t], result_type: t }
    }
    // 2nd: any action with value > 0 (catch-all for unknown types)
    let best = null
    for (const [type, val] of Object.entries(map)) {
      if (val > 0 && (!best || val > best.val)) best = { type, val }
    }
    if (best) return { results: best.val, result_type: best.type }
  }
  // 3rd: reach as fallback for awareness campaigns
  if (reach && parseInt(reach) > 0) return { results: parseInt(reach), result_type: 'reach' }
  return { results: 0, result_type: null }
}

async function getAgencyToken(agency_id) {
  const { rows } = await db.query('SELECT meta_access_token FROM agencies WHERE id=$1', [agency_id])
  return rows[0]?.meta_access_token || null
}

async function getClients(agency_id, client_id) {
  if (client_id) {
    const { rows } = await db.query(
      "SELECT id, name, meta_account_id FROM clients WHERE id=$1 AND agency_id=$2", [client_id, agency_id]
    )
    return rows
  }
  const { rows } = await db.query(
    "SELECT id, name, meta_account_id FROM clients WHERE agency_id=$1 AND meta_account_id IS NOT NULL AND meta_account_id<>'' ORDER BY name",
    [agency_id]
  )
  return rows
}

// GET /traffic/clients
router.get('/clients', auth, async (req, res) => {
  try {
    const clients = await getClients(req.user.agency_id)
    res.json(clients)
  } catch { res.status(500).json({ error: 'Erro interno' }) }
})

// GET /traffic/campaigns?client_id=X&period=last_30d
router.get('/campaigns', auth, async (req, res) => {
  const { client_id, period = 'last_30d' } = req.query
  const date_preset = ALLOWED_PERIODS.includes(period) ? period : 'last_30d'
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })
    const clients = await getClients(req.user.agency_id, client_id)
    const all = []
    await Promise.allSettled(clients.map(async client => {
      const fields = 'id,name,status,effective_status,daily_budget,lifetime_budget,objective'
      const ins = 'spend,clicks,impressions,cpc,ctr,reach,actions'
      const url = `${GRAPH}/act_${client.meta_account_id}/campaigns?fields=${fields},insights.date_preset(${date_preset}){${ins}}&limit=50&access_token=${token}`
      const r = await fetch(url); const data = await r.json()
      if (!data.data) return
      data.data.forEach(c => {
        const i = c.insights?.data?.[0]
        const { results, result_type } = getPrimaryResult(i?.actions, i?.reach)
        const spend = parseFloat(i?.spend || 0)
        all.push({
          id: c.id, name: c.name, status: c.status, effective_status: c.effective_status,
          daily_budget: c.daily_budget ? parseInt(c.daily_budget) / 100 : null,
          objective: c.objective, client_id: client.id, client_name: client.name,
          meta_account_id: client.meta_account_id,
          spend, clicks: parseInt(i?.clicks || 0),
          results, result_type,
          cost_per_result: results > 0 ? parseFloat((spend / results).toFixed(2)) : null,
          leads: results, cpl: results > 0 ? parseFloat((spend / results).toFixed(2)) : null,
          ctr: i ? parseFloat(i.ctr || 0) : null,
          cpc: i ? parseFloat(i.cpc || 0) : null,
          impressions: i ? parseInt(i.impressions || 0) : 0,
        })
      })
    }))
    res.json(all.sort((a, b) => b.spend - a.spend))
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao buscar campanhas' }) }
})

// GET /traffic/adsets?client_id=X&period=last_30d
router.get('/adsets', auth, async (req, res) => {
  const { client_id, period = 'last_30d' } = req.query
  const date_preset = ALLOWED_PERIODS.includes(period) ? period : 'last_30d'
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })
    const clients = await getClients(req.user.agency_id, client_id)
    const all = []
    await Promise.allSettled(clients.map(async client => {
      const fields = 'id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id,campaign{name},optimization_goal,billing_event'
      const ins = 'spend,clicks,impressions,cpc,ctr,reach,actions'
      const url = `${GRAPH}/act_${client.meta_account_id}/adsets?fields=${fields},insights.date_preset(${date_preset}){${ins}}&limit=100&access_token=${token}`
      const r = await fetch(url); const data = await r.json()
      if (!data.data) return
      data.data.forEach(s => {
        const i = s.insights?.data?.[0]
        const { results, result_type } = getPrimaryResult(i?.actions, i?.reach)
        const spend = parseFloat(i?.spend || 0)
        all.push({
          id: s.id, name: s.name, status: s.status, effective_status: s.effective_status,
          daily_budget: s.daily_budget ? parseInt(s.daily_budget) / 100 : null,
          campaign_id: s.campaign_id, campaign_name: s.campaign?.name || '',
          optimization_goal: s.optimization_goal,
          client_id: client.id, client_name: client.name,
          meta_account_id: client.meta_account_id,
          spend, clicks: parseInt(i?.clicks || 0),
          results, result_type,
          cost_per_result: results > 0 ? parseFloat((spend / results).toFixed(2)) : null,
          leads: results, cpl: results > 0 ? parseFloat((spend / results).toFixed(2)) : null,
          ctr: i ? parseFloat(i.ctr || 0) : null,
          cpc: i ? parseFloat(i.cpc || 0) : null,
          impressions: i ? parseInt(i.impressions || 0) : 0,
        })
      })
    }))
    res.json(all.sort((a, b) => b.spend - a.spend))
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao buscar conjuntos' }) }
})

// GET /traffic/ads?client_id=X&period=last_30d
router.get('/ads', auth, async (req, res) => {
  const { client_id, period = 'last_30d' } = req.query
  const date_preset = ALLOWED_PERIODS.includes(period) ? period : 'last_30d'
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })
    const clients = await getClients(req.user.agency_id, client_id)
    const all = []
    await Promise.allSettled(clients.map(async client => {
      const fields = 'id,name,status,effective_status,adset_id,adset{name},campaign_id,campaign{name}'
      const ins = 'spend,clicks,impressions,cpc,ctr,reach,actions'
      const url = `${GRAPH}/act_${client.meta_account_id}/ads?fields=${fields},insights.date_preset(${date_preset}){${ins}}&limit=100&access_token=${token}`
      const r = await fetch(url); const data = await r.json()
      if (!data.data) return
      data.data.forEach(ad => {
        const i = ad.insights?.data?.[0]
        const { results, result_type } = getPrimaryResult(i?.actions, i?.reach)
        const spend = parseFloat(i?.spend || 0)
        all.push({
          id: ad.id, name: ad.name, status: ad.status, effective_status: ad.effective_status,
          adset_id: ad.adset_id, adset_name: ad.adset?.name || '',
          campaign_id: ad.campaign_id, campaign_name: ad.campaign?.name || '',
          client_id: client.id, client_name: client.name,
          spend, clicks: parseInt(i?.clicks || 0),
          results, result_type,
          cost_per_result: results > 0 ? parseFloat((spend / results).toFixed(2)) : null,
          leads: results, cpl: results > 0 ? parseFloat((spend / results).toFixed(2)) : null,
          ctr: i ? parseFloat(i.ctr || 0) : null,
          cpc: i ? parseFloat(i.cpc || 0) : null,
          impressions: i ? parseInt(i.impressions || 0) : 0,
        })
      })
    }))
    res.json(all.sort((a, b) => b.spend - a.spend))
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao buscar anúncios' }) }
})

// POST /traffic/campaigns/:id/status
router.post('/campaigns/:id/status', auth, async (req, res) => {
  const { status } = req.body
  if (!['PAUSED','ACTIVE'].includes(status)) return res.status(400).json({ error: 'Status inválido' })
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })
    const r = await fetch(`${GRAPH}/${req.params.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `status=${status}&access_token=${token}`
    })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ok: true, status })
  } catch { res.status(500).json({ error: 'Erro ao atualizar status' }) }
})

// POST /traffic/adsets/:id/status
router.post('/adsets/:id/status', auth, async (req, res) => {
  const { status } = req.body
  if (!['PAUSED','ACTIVE'].includes(status)) return res.status(400).json({ error: 'Status inválido' })
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })
    const r = await fetch(`${GRAPH}/${req.params.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `status=${status}&access_token=${token}`
    })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ok: true, status })
  } catch { res.status(500).json({ error: 'Erro ao atualizar status' }) }
})

// POST /traffic/ads/:id/status
router.post('/ads/:id/status', auth, async (req, res) => {
  const { status } = req.body
  if (!['PAUSED','ACTIVE'].includes(status)) return res.status(400).json({ error: 'Status inválido' })
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })
    const r = await fetch(`${GRAPH}/${req.params.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `status=${status}&access_token=${token}`
    })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ok: true, status })
  } catch { res.status(500).json({ error: 'Erro ao atualizar status' }) }
})

// POST /traffic/campaigns/:id/budget
router.post('/campaigns/:id/budget', auth, async (req, res) => {
  const { daily_budget } = req.body
  if (!daily_budget || isNaN(daily_budget)) return res.status(400).json({ error: 'Orçamento inválido' })
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })
    const budgetCents = Math.round(parseFloat(daily_budget) * 100)
    const r = await fetch(`${GRAPH}/${req.params.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `daily_budget=${budgetCents}&access_token=${token}`
    })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ok: true, daily_budget: parseFloat(daily_budget) })
  } catch { res.status(500).json({ error: 'Erro ao atualizar orçamento' }) }
})

// POST /traffic/adsets/:id/budget
router.post('/adsets/:id/budget', auth, async (req, res) => {
  const { daily_budget } = req.body
  if (!daily_budget || isNaN(daily_budget)) return res.status(400).json({ error: 'Orçamento inválido' })
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })
    const budgetCents = Math.round(parseFloat(daily_budget) * 100)
    const r = await fetch(`${GRAPH}/${req.params.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `daily_budget=${budgetCents}&access_token=${token}`
    })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ok: true, daily_budget: parseFloat(daily_budget) })
  } catch { res.status(500).json({ error: 'Erro ao atualizar orçamento' }) }
})

// POST /traffic/optimize
router.post('/optimize', auth, async (req, res) => {
  const { client_id, period = 'last_30d' } = req.body
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY não configurado' })
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })
    const date_preset = ALLOWED_PERIODS.includes(period) ? period : 'last_30d'
    const clients = await getClients(req.user.agency_id, client_id)
    const campaigns = []
    await Promise.allSettled(clients.map(async client => {
      const fields = 'id,name,status,effective_status,daily_budget,objective'
      const ins = 'spend,clicks,impressions,cpc,ctr,reach,actions'
      const url = `${GRAPH}/act_${client.meta_account_id}/campaigns?fields=${fields},insights.date_preset(${date_preset}){${ins}}&limit=50&access_token=${token}`
      const r = await fetch(url); const data = await r.json()
      if (!data.data) return
      data.data.forEach(c => {
        const i = c.insights?.data?.[0]
        const leads = parseInt(i?.actions?.find(a => a.action_type === 'lead')?.value || 0)
        const spend = parseFloat(i?.spend || 0)
        campaigns.push({
          id: c.id, name: c.name, cliente: client.name,
          status: c.effective_status,
          orcamento_diario: c.daily_budget ? parseInt(c.daily_budget) / 100 : null,
          gasto: spend, cliques: parseInt(i?.clicks || 0), leads,
          cpl: leads > 0 ? (spend / leads).toFixed(2) : null,
          ctr: i ? parseFloat(i.ctr || 0).toFixed(2) : null,
          cpc: i ? parseFloat(i.cpc || 0).toFixed(2) : null,
        })
      })
    }))
    if (!campaigns.length) return res.status(400).json({ error: 'Nenhuma campanha para analisar' })
    const prompt = `Você é especialista em tráfego pago Meta Ads para agência de marketing digital brasileira.

Analise estas campanhas e retorne recomendações em JSON (sem markdown):
${JSON.stringify(campaigns, null, 2)}

Formato exato:
{"resumo":"string 2-3 frases","recomendacoes":[{"campaign_id":"string","campaign_name":"string","cliente":"string","acao":"pausar|escalar|reduzir|manter","percentual":null,"motivo":"string 1 frase","prioridade":"alta|media|baixa"}]}

Critérios: pausar se CPL>R$80 ou CTR<0.5% com gasto>R$20 sem leads; escalar se CPL<R$30 e CTR>1.5%; reduzir se CPL R$50-80; manter se performance OK.`

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2048, messages: [{ role: 'user', content: prompt }] })
    })
    const aiData = await aiResp.json()
    if (aiData.error) return res.status(500).json({ error: aiData.error.message })
    res.json(JSON.parse(aiData.content[0].text.trim()))
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao gerar otimização: ' + err.message }) }
})


// GET /traffic/ads/:id/thumbnail
router.get('/ads/:id/thumbnail', auth, async (req, res) => {
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })
    const r = await fetch(`${GRAPH}/${req.params.id}?fields=creative{thumbnail_url}&access_token=${token}`)
    const data = await r.json()
    res.json({ thumbnail_url: data.creative?.thumbnail_url || null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /traffic/ads/:id/preview?format=MOBILE_FEED_STANDARD
router.get('/ads/:id/preview', auth, async (req, res) => {
  const format = req.query.format || 'MOBILE_FEED_STANDARD'
  try {
    const token = await getAgencyToken(req.user.agency_id)
    if (!token) return res.status(400).json({ error: 'Token Meta não configurado' })
    const url = `${GRAPH}/${req.params.id}/previews?ad_format=${format}&access_token=${token}`
    const r = await fetch(url)
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    const preview = data.data?.[0]
    if (!preview) return res.status(404).json({ error: 'Prévia não disponível' })
    res.json({ body: preview.body })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao buscar prévia' })
  }
})

module.exports = router

