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

// Helper: aggregate Meta campaign data
function aggregateCampaigns(campaigns) {
  let total_spend = 0
  let total_leads = 0
  let total_clicks = 0
  let total_impressions = 0

  const campaignSummaries = []

  for (const campaign of campaigns) {
    const insights = campaign.insights && campaign.insights.data && campaign.insights.data[0]
      ? campaign.insights.data[0]
      : null

    const spend = insights ? parseFloat(insights.spend || 0) : 0
    const clicks = insights ? parseInt(insights.clicks || 0, 10) : 0
    const impressions = insights ? parseInt(insights.impressions || 0, 10) : 0

    let leads = 0
    if (insights && Array.isArray(insights.actions)) {
      const leadAction = insights.actions.find(
        (a) => a.action_type === 'lead' || a.action_type === 'offsite_conversion.fb_pixel_lead'
      )
      if (leadAction) leads = parseInt(leadAction.value || 0, 10)
    }

    total_spend += spend
    total_leads += leads
    total_clicks += clicks
    total_impressions += impressions

    campaignSummaries.push({
      id: campaign.id,
      name: campaign.name,
      status: campaign.effective_status || campaign.status,
      spend,
      clicks,
      impressions,
      leads
    })
  }

  const avg_cpl = total_leads > 0 ? total_spend / total_leads : null
  const avg_ctr = total_impressions > 0 ? (total_clicks / total_impressions) * 100 : null

  // Top 3 by spend
  const top_campaigns = campaignSummaries
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3)

  return {
    total_spend: parseFloat(total_spend.toFixed(2)),
    total_leads,
    total_clicks,
    total_impressions,
    avg_cpl: avg_cpl !== null ? parseFloat(avg_cpl.toFixed(2)) : null,
    avg_ctr: avg_ctr !== null ? parseFloat(avg_ctr.toFixed(4)) : null,
    top_campaigns
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
      total_leads: metrics.total_leads,
      total_cliques: metrics.total_clicks,
      total_impressoes: metrics.total_impressions,
      custo_por_lead: metrics.avg_cpl,
      ctr_medio: metrics.avg_ctr,
      top_campanhas: metrics.top_campaigns
    }, null, 2)

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system:
        'Você é um analista de marketing digital de uma agência brasileira. ' +
        'Sempre responda com JSON válido, sem markdown, sem texto adicional.',
      messages: [
        {
          role: 'user',
          content:
            `Com base nos dados abaixo, gere um relatório de performance profissional em português. ` +
            `Responda SOMENTE com um JSON válido contendo exatamente estas chaves: ` +
            `"resumo_executivo" (string com 2-3 frases), ` +
            `"destaques" (array com 3 strings em formato bullet point), ` +
            `"recomendacoes" (array com 3 strings em formato bullet point), ` +
            `"conclusao" (string com 1 frase). ` +
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
