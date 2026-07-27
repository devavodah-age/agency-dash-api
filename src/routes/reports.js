const router = require('express').Router()
const db = require('../config/db')
const auth = require('../middleware/auth')
const Anthropic = require('@anthropic-ai/sdk')
const https = require('https')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const PERIOD_LABELS = {
  today: 'Hoje',
  last_7d: 'Últimos 7 dias',
  last_30d: 'Últimos 30 dias',
  this_month: 'Este mês'
}

// Init: create reports table if it doesn't exist
;(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        agency_id INTEGER,
        client_id INTEGER REFERENCES clients(id),
        title VARCHAR(500),
        period VARCHAR(50),
        metrics JSONB,
        ai_content JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)
    console.log('[reports] DB init OK')
  } catch (err) {
    console.error('[reports] DB init error:', err.message)
  }
})()

// Helper: fetch URL and return parsed JSON
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error('Resposta inválida da API: ' + data.slice(0, 200)))
        }
      })
    }).on('error', reject)
  })
}

const ACTION_LABELS = {
  'purchase': 'Compras realizadas',
  'omni_purchase': 'Compras realizadas',
  'lead': 'Contatos interessados gerados',
  'offsite_conversion.fb_pixel_lead': 'Contatos interessados gerados',
  'onsite_conversion.lead_grouped': 'Contatos interessados gerados',
  'landing_page_view': 'Visitas à página',
  'instagram_profile_visit': 'Visitas ao perfil do Instagram',
  'onsite_conversion.view_content': 'Visualizações de conteúdo',
  'follow': 'Novos seguidores',
  'page_engagement': 'Engajamentos',
  'post_engagement': 'Engajamentos no post',
  'link_click': 'Cliques no link',
  'video_view': 'Visualizações de vídeo',
  'comment': 'Comentários',
}

const ACTION_PRIORITY = [
  'purchase', 'omni_purchase',
  'lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped',
  'landing_page_view',
  'instagram_profile_visit', 'onsite_conversion.view_content',
  'follow', 'link_click',
  'page_engagement', 'post_engagement',
  'video_view', 'comment',
]

// Helper: aggregate Meta campaign data
function aggregateCampaigns(campaigns) {
  let total_spend = 0, total_clicks = 0, total_impressions = 0
  const allActionTotals = {}
  const campaignSummaries = []

  for (const campaign of campaigns) {
    const ins = campaign.insights?.data?.[0] || null
    const spend = ins ? parseFloat(ins.spend || 0) : 0
    const clicks = ins ? parseInt(ins.clicks || 0, 10) : 0
    const impressions = ins ? parseInt(ins.impressions || 0, 10) : 0

    total_spend += spend
    total_clicks += clicks
    total_impressions += impressions

    const campaignActions = {}
    if (ins && Array.isArray(ins.actions)) {
      for (const a of ins.actions) {
        const v = parseInt(a.value || 0, 10)
        campaignActions[a.action_type] = (campaignActions[a.action_type] || 0) + v
        allActionTotals[a.action_type] = (allActionTotals[a.action_type] || 0) + v
      }
    }

    campaignSummaries.push({
      id: campaign.id, name: campaign.name,
      status: campaign.effective_status || campaign.status,
      spend, clicks, impressions, actions: campaignActions
    })
  }

  // Detect primary result type by priority
  let primary_type = null
  for (const t of ACTION_PRIORITY) {
    if ((allActionTotals[t] || 0) > 0) { primary_type = t; break }
  }

  const total_results = primary_type ? (allActionTotals[primary_type] || 0) : 0
  const result_label = primary_type ? (ACTION_LABELS[primary_type] || primary_type) : 'Resultados'
  const cost_per_result = total_results > 0 ? total_spend / total_results : null
  const avg_ctr = total_impressions > 0 ? (total_clicks / total_impressions) * 100 : null

  const top_campaigns = campaignSummaries
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3)
    .map(c => ({
      id: c.id, name: c.name, status: c.status, spend: c.spend, clicks: c.clicks,
      results: primary_type ? (c.actions[primary_type] || 0) : 0,
      cost_per_result: primary_type && c.actions[primary_type] > 0
        ? parseFloat((c.spend / c.actions[primary_type]).toFixed(2)) : null,
    }))

  return {
    total_spend: parseFloat(total_spend.toFixed(2)),
    total_results, result_label,
    cost_per_result: cost_per_result !== null ? parseFloat(cost_per_result.toFixed(2)) : null,
    total_clicks, total_impressions,
    avg_ctr: avg_ctr !== null ? parseFloat(avg_ctr.toFixed(4)) : null,
    top_campaigns,
    // legacy aliases so old reports still render
    total_leads: total_results,
    avg_cpl: cost_per_result !== null ? parseFloat(cost_per_result.toFixed(2)) : null,
  }
}

// GET /reports — list saved reports for this agency
router.get('/', auth, async (req, res) => {
  try {
    const { agency_id } = req.user

    const { rows } = await db.query(
      `
      SELECT
        r.id,
        r.title,
        c.name AS client_name,
        r.period,
        r.created_at,
        LEFT(r.ai_content->>'resumo_executivo', 200) AS summary
      FROM reports r
      JOIN clients c ON c.id = r.client_id
      WHERE r.agency_id = $1
      ORDER BY r.created_at DESC
      `,
      [agency_id]
    )

    res.json(rows)
  } catch (err) {
    console.error('[GET /reports]', err)
    res.status(500).json({ error: 'Erro interno' })
  }
})

// POST /reports/generate — generate a new report
router.post('/generate', auth, async (req, res) => {
  try {
    const { agency_id } = req.user
    const { client_id, period } = req.body

    if (!client_id || !period) {
      return res.status(400).json({ error: 'client_id e period são obrigatórios' })
    }

    if (!PERIOD_LABELS[period]) {
      return res.status(400).json({
        error: `Period inválido. Use um de: ${Object.keys(PERIOD_LABELS).join(', ')}`
      })
    }

    // 1. Fetch agency meta_access_token
    const { rows: agencyRows } = await db.query(
      'SELECT meta_access_token FROM agencies WHERE id = $1',
      [agency_id]
    )

    if (agencyRows.length === 0 || !agencyRows[0].meta_access_token) {
      return res.status(400).json({ error: 'Token Meta não configurado para esta agência' })
    }

    const meta_access_token = agencyRows[0].meta_access_token

    // 2. Fetch client meta_account_id and name
    const { rows: clientRows } = await db.query(
      'SELECT id, name, meta_account_id FROM clients WHERE id = $1 AND agency_id = $2',
      [client_id, agency_id]
    )

    if (clientRows.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado' })
    }

    const client = clientRows[0]

    if (!client.meta_account_id) {
      return res.status(400).json({ error: 'meta_account_id não configurado para este cliente' })
    }

    // 3. Call Meta Graph API
    const metaUrl =
      `https://graph.facebook.com/v19.0/act_${client.meta_account_id}/campaigns` +
      `?fields=id,name,status,effective_status,daily_budget,insights.date_preset(${period}){spend,clicks,impressions,cpc,ctr,actions}` +
      `&limit=50` +
      `&access_token=${meta_access_token}`

    const metaData = await fetchJson(metaUrl)

    if (metaData.error) {
      console.error('[reports] Meta API error:', metaData.error)
      return res.status(502).json({
        error: 'Erro ao buscar dados da Meta API',
        detail: metaData.error.message
      })
    }

    const campaigns = metaData.data || []

    // 4. Process/aggregate the data
    const metrics = aggregateCampaigns(campaigns)

    // 5. Call Claude API to generate report narrative
    const claudePrompt = JSON.stringify({
      cliente: client.name,
      periodo: PERIOD_LABELS[period],
      total_investido: metrics.total_spend,
      tipo_resultado_principal: metrics.result_label,
      total_resultados: metrics.total_results,
      custo_por_resultado: metrics.cost_per_result,
      total_cliques: metrics.total_clicks,
      total_impressoes: metrics.total_impressions,
      taxa_de_cliques: metrics.avg_ctr ? `${(metrics.avg_ctr).toFixed(2)}%` : null,
      top_campanhas: metrics.top_campaigns.map(c => ({
        nome: c.name,
        valor_investido: `R$ ${c.spend.toFixed(2).replace('.',',')}`,
        resultados: c.results,
        custo_por_resultado: c.cost_per_result ? `R$ ${c.cost_per_result.toFixed(2).replace('.',',')}` : '—',
      }))
    }, null, 2)

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system:
        'Você é um consultor de marketing que ajuda donos de negócio a entender os resultados das suas campanhas. ' +
        'Escreva de forma simples e amigável, sem jargão técnico. ' +
        'Sempre responda com JSON válido, sem markdown, sem texto adicional.',
      messages: [
        {
          role: 'user',
          content:
            `Com base nos dados abaixo, gere um relatório em português para o cliente, escrito de forma simples para que qualquer pessoa entenda — sem termos técnicos como CTR, CPM, CPC ou ROAS sem explicação. ` +
            `Quando mencionar "leads", chame de "contatos interessados". Use tom amigável e encorajador. ` +
            `Responda SOMENTE com um JSON válido contendo exatamente estas chaves: ` +
            `"manchete" (string: uma frase curta com o principal resultado, ex: "47 novos contatos em 7 dias"), ` +
            `"resumo_executivo" (string: 2-3 frases explicando o desempenho sem jargão), ` +
            `"destaques" (array com 3 strings em linguagem simples e positiva), ` +
            `"recomendacoes" (array com 3 sugestões práticas e claras), ` +
            `"conclusao" (string: 1 frase encorajadora de fechamento). ` +
            `\n\nDados:\n${claudePrompt}`
        }
      ]
    })

    let ai_content
    try {
      const rawText = claudeResponse.content[0].text.trim()
      // Strip markdown code fences if model wraps them
      const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      ai_content = JSON.parse(jsonText)
    } catch (parseErr) {
      console.error('[reports] Claude response parse error:', parseErr.message)
      return res.status(502).json({ error: 'Resposta inválida do Claude API' })
    }

    // 6. Save report to DB
    const period_label = PERIOD_LABELS[period]
    const title = `Relatório ${client.name} – ${period_label}`

    const { rows: savedReport } = await db.query(
      `
      INSERT INTO reports (agency_id, client_id, title, period, metrics, ai_content)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, agency_id, client_id, title, period, metrics, ai_content, created_at
      `,
      [agency_id, client_id, title, period, JSON.stringify(metrics), JSON.stringify(ai_content)]
    )

    // 7. Return full report object
    res.status(201).json({
      ...savedReport[0],
      client_name: client.name
    })
  } catch (err) {
    console.error('[POST /reports/generate]', err)
    res.status(500).json({ error: 'Erro interno' })
  }
})

// GET /reports/:id — get single report
router.get('/:id', auth, async (req, res) => {
  try {
    const { agency_id } = req.user
    const reportId = parseInt(req.params.id, 10)

    const { rows } = await db.query(
      `
      SELECT
        r.id,
        r.title,
        r.period,
        r.metrics,
        r.ai_content,
        r.created_at,
        c.name AS client_name,
        c.id AS client_id
      FROM reports r
      JOIN clients c ON c.id = r.client_id
      WHERE r.id = $1
        AND r.agency_id = $2
      `,
      [reportId, agency_id]
    )

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Relatório não encontrado' })
    }

    res.json(rows[0])
  } catch (err) {
    console.error('[GET /reports/:id]', err)
    res.status(500).json({ error: 'Erro interno' })
  }
})

// DELETE /reports/:id — delete a report
router.delete('/:id', auth, async (req, res) => {
  try {
    const { agency_id } = req.user
    const reportId = parseInt(req.params.id, 10)

    const { rowCount } = await db.query(
      'DELETE FROM reports WHERE id = $1 AND agency_id = $2',
      [reportId, agency_id]
    )

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Relatório não encontrado' })
    }

    res.json({ message: 'Relatório excluído com sucesso' })
  } catch (err) {
    console.error('[DELETE /reports/:id]', err)
    res.status(500).json({ error: 'Erro interno' })
  }
})

module.exports = router

