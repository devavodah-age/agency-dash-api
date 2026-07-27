const cron = require('node-cron')
const nodemailer = require('nodemailer')
const db = require('../config/db')
const Anthropic = require('@anthropic-ai/sdk')
const https = require('https')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const GRAPH = 'https://graph.facebook.com/v19.0'
const PERIOD_LABELS = {
  today: 'Hoje', last_7d: 'Últimos 7 dias',
  last_30d: 'Últimos 30 dias', this_month: 'Este mês'
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch(e) { reject(e) } })
    }).on('error', reject)
  })
}

function fmtBRL(v) {
  if (!v && v !== 0) return '—'
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 })
}

async function generateReport(client, token, period) {
  const date_preset = period || 'last_7d'
  const ins = 'spend,clicks,impressions,cpc,ctr,actions'
  const fields = `id,name,status,effective_status,daily_budget,insights.date_preset(${date_preset}){${ins}}`
  const url = `${GRAPH}/act_${client.meta_account_id}/campaigns?fields=${fields}&limit=50&access_token=${token}`
  const data = await fetchJson(url)

  if (!data.data || data.error) throw new Error(data.error?.message || 'Erro ao buscar campanhas')

  let total_spend = 0, total_leads = 0, total_clicks = 0, total_impressions = 0
  const campaign_data = []

  data.data.forEach(c => {
    const i = c.insights?.data?.[0]
    if (!i) return
    const leads = parseInt(i.actions?.find(a => a.action_type === 'lead')?.value || 0)
    const spend = parseFloat(i.spend || 0)
    total_spend += spend; total_leads += leads
    total_clicks += parseInt(i.clicks || 0)
    total_impressions += parseInt(i.impressions || 0)
    campaign_data.push({ id: c.id, name: c.name, status: c.effective_status, spend, leads,
      cpl: leads > 0 ? spend/leads : null, ctr: parseFloat(i.ctr||0) })
  })

  const top_campaigns = campaign_data.sort((a,b) => b.spend - a.spend).slice(0,3)
  const avg_cpl = total_leads > 0 ? total_spend / total_leads : null
  const avg_ctr = campaign_data.length > 0
    ? campaign_data.reduce((s,c) => s + (c.ctr||0), 0) / campaign_data.length : 0
  const metrics = { total_spend, total_leads, total_clicks, total_impressions, avg_cpl, avg_ctr, top_campaigns }

  const prompt = `Você é um consultor de marketing que ajuda donos de negócio a entender os resultados das suas campanhas no Meta (Facebook e Instagram). Escreva de forma simples, direta e amigável — como se estivesse explicando pessoalmente para alguém que não é especialista em marketing digital.

Cliente: ${client.name}
Período: ${PERIOD_LABELS[date_preset] || date_preset}

Resultados do período:
- Valor investido nos anúncios: ${fmtBRL(total_spend)}
- Contatos interessados gerados (leads): ${total_leads}
- Custo médio por contato: ${avg_cpl ? fmtBRL(avg_cpl) : '—'}
- Pessoas que clicaram nos anúncios: ${total_clicks}
- Vezes que os anúncios foram exibidos: ${total_impressions}
- Taxa de cliques (a cada 100 exibições, quantas pessoas clicaram): ${avg_ctr.toFixed(2)}%
- Campanhas com mais investimento: ${JSON.stringify(top_campaigns.map(c => ({ nome: c.name, gasto: fmtBRL(c.spend), contatos: c.leads, custo_por_contato: c.cpl ? fmtBRL(c.cpl) : '—' })))}

Regras obrigatórias:
- Não use siglas como CTR, CPM, CPC, ROAS sem explicar com palavras simples
- Quando mencionar "leads", chame de "contatos interessados" ou "pessoas que demonstraram interesse"
- Use o valor investido para contextualizar o custo-benefício
- Seja encorajador e honesto ao mesmo tempo
- Escreva em português brasileiro, tom amigável e profissional

Retorne APENAS um JSON válido (sem markdown) com:
{
  "manchete": "uma frase curta e impactante com o principal resultado (ex: '47 novos contatos gerados em 7 dias')",
  "resumo_executivo": "2-3 frases explicando o desempenho de forma que qualquer cliente entenda, sem jargão técnico",
  "destaques": ["ponto positivo 1 em linguagem simples", "ponto positivo 2", "ponto positivo 3"],
  "recomendacoes": ["sugestão prática e clara 1", "sugestão prática e clara 2", "sugestão prática e clara 3"],
  "conclusao": "uma frase de fechamento encorajadora"
}`

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  })

  let ai_content = {}
  try {
    const raw = resp.content[0].text.replace(/```json|```/g, '').trim()
    ai_content = JSON.parse(raw)
  } catch { ai_content = { resumo_executivo: resp.content[0].text } }

  const period_label = PERIOD_LABELS[date_preset] || date_preset
  const title = `Relatório ${client.name} – ${period_label}`

  const { rows } = await db.query(
    'INSERT INTO reports (agency_id, client_id, title, period, metrics, ai_content) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [client.agency_id, client.id, title, date_preset, JSON.stringify(metrics), JSON.stringify(ai_content)]
  )
  return { ...rows[0], client_name: client.name, metrics, ai_content, period_label }
}

function buildEmailHtml(report, client) {
  const m = report.metrics || {}
  const ai = report.ai_content || {}
  const period = report.period_label || report.period

  const topTable = (m.top_campaigns || []).map(c => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:13px">${c.name}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:600">R$ ${Number(c.spend||0).toFixed(2).replace('.',',')}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:13px">${c.leads||0}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:13px">${c.cpl ? 'R$ '+Number(c.cpl).toFixed(2).replace('.',',') : '—'}</td>
    </tr>`).join('')

  const destaques = (ai.destaques || []).map(d => `<li style="margin-bottom:8px;line-height:1.6">${d}</li>`).join('')
  const recs = (ai.recomendacoes || []).map(r => `<li style="margin-bottom:8px;line-height:1.6">${r}</li>`).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${report.title}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">

  <!-- Header -->
  <tr><td style="background:#0d0d0d;padding:28px 36px">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">Agência Avodah</p>
    <h1 style="margin:0;font-size:22px;color:#fff;font-weight:700">${report.title}</h1>
    <p style="margin:8px 0 0;font-size:13px;color:rgba(255,255,255,0.4)">${period} · Gerado automaticamente</p>
  </td></tr>

  <!-- Metrics -->
  <tr><td style="padding:28px 36px 0">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="25%" style="padding:4px">
          <div style="background:#f9f9f9;border-radius:10px;padding:16px;text-align:center">
            <p style="margin:0;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px">Investimento</p>
            <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#111">R$ ${Number(m.total_spend||0).toFixed(2).replace('.',',')}</p>
          </div>
        </td>
        <td width="25%" style="padding:4px">
          <div style="background:#f9f9f9;border-radius:10px;padding:16px;text-align:center">
            <p style="margin:0;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px">Leads</p>
            <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#111">${m.total_leads||0}</p>
          </div>
        </td>
        <td width="25%" style="padding:4px">
          <div style="background:#f9f9f9;border-radius:10px;padding:16px;text-align:center">
            <p style="margin:0;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px">CPL Médio</p>
            <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#111">${m.avg_cpl ? 'R$ '+Number(m.avg_cpl).toFixed(2).replace('.',',') : '—'}</p>
          </div>
        </td>
        <td width="25%" style="padding:4px">
          <div style="background:#f9f9f9;border-radius:10px;padding:16px;text-align:center">
            <p style="margin:0;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px">Cliques</p>
            <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#111">${Number(m.total_clicks||0).toLocaleString('pt-BR')}</p>
          </div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- AI Content -->
  ${ai.resumo_executivo ? `
  <tr><td style="padding:24px 36px 0">
    <div style="background:#f5f0ff;border-radius:10px;padding:20px;border-left:4px solid #7c3aed">
      <p style="margin:0 0 10px;font-size:11px;color:#7c3aed;font-weight:700;text-transform:uppercase;letter-spacing:1px">Resumo Executivo</p>
      <p style="margin:0;font-size:14px;color:#333;line-height:1.7">${ai.resumo_executivo}</p>
    </div>
  </td></tr>` : ''}

  ${destaques ? `
  <tr><td style="padding:20px 36px 0">
    <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:1px">✓ Destaques</p>
    <ul style="margin:0;padding-left:20px;color:#333">${destaques}</ul>
  </td></tr>` : ''}

  ${recs ? `
  <tr><td style="padding:20px 36px 0">
    <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#d97706;text-transform:uppercase;letter-spacing:1px">→ Recomendações</p>
    <ul style="margin:0;padding-left:20px;color:#333">${recs}</ul>
  </td></tr>` : ''}

  <!-- Top Campaigns -->
  ${topTable ? `
  <tr><td style="padding:20px 36px 0">
    <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:1px">Campanhas em Destaque</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr style="background:#f5f5f5">
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#888">Campanha</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#888">Gasto</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#888">Leads</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#888">CPL</th>
      </tr>
      ${topTable}
    </table>
  </td></tr>` : ''}

  ${ai.conclusao ? `
  <tr><td style="padding:20px 36px 0">
    <p style="margin:0;font-size:13px;color:#666;font-style:italic;line-height:1.7;border-top:1px solid #f0f0f0;padding-top:20px">"${ai.conclusao}"</p>
  </td></tr>` : ''}

  <!-- Footer -->
  <tr><td style="padding:28px 36px;border-top:1px solid #f0f0f0;margin-top:24px">
    <p style="margin:0;font-size:11px;color:#aaa;text-align:center">
      Relatório gerado automaticamente pela <strong>Agência Avodah</strong><br>
      Este relatório é confidencial e destinado exclusivamente a ${client.name}
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`
}

async function sendReportEmail(client, report, recipientEmail) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  })

  await transporter.sendMail({
    from: `"Agência Avodah" <${process.env.GMAIL_USER}>`,
    to: recipientEmail,
    subject: `📊 ${report.title}`,
    html: buildEmailHtml(report, client)
  })
}

async function runAgentForClient(client, token) {
  console.log(`[agent] Processando cliente: ${client.name}`)
  try {
    const period = client.report_period || 'last_7d'
    const report = await generateReport(client, token, period)

    const email = client.report_email || client.email
    if (!email) {
      console.log(`[agent] ${client.name}: sem email configurado, pulando envio`)
      return { ok: false, reason: 'no_email' }
    }

    await sendReportEmail(client, report, email)
    await db.query('UPDATE clients SET last_report_sent_at=NOW() WHERE id=$1', [client.id])
    console.log(`[agent] ${client.name}: relatório enviado para ${email}`)
    return { ok: true, report_id: report.id }
  } catch (err) {
    console.error(`[agent] Erro para ${client.name}:`, err.message)
    return { ok: false, reason: err.message }
  }
}

async function runAgent(agency_id) {
  console.log('[agent] Iniciando ciclo...', new Date().toISOString())
  try {
    // Get all clients with auto_report enabled for this agency (or all agencies if not specified)
    const query = agency_id
      ? 'SELECT c.*, a.meta_access_token as token FROM clients c JOIN agencies a ON a.id=c.agency_id WHERE c.agency_id=$1 AND c.auto_report_enabled=true AND c.meta_account_id IS NOT NULL AND c.meta_account_id != \'\''
      : 'SELECT c.*, a.meta_access_token as token FROM clients c JOIN agencies a ON a.id=c.agency_id WHERE c.auto_report_enabled=true AND c.meta_account_id IS NOT NULL AND c.meta_account_id != \'\''
    const params = agency_id ? [agency_id] : []
    const { rows: clients } = await db.query(query, params)

    console.log(`[agent] ${clients.length} cliente(s) com relatório automático ativo`)
    const results = []
    for (const client of clients) {
      const result = await runAgentForClient(client, client.token)
      results.push({ client: client.name, ...result })
    }
    return results
  } catch (err) {
    console.error('[agent] Erro geral:', err.message)
    return []
  }
}

// Initialize DB columns
async function initDb() {
  try {
    await db.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS auto_report_enabled BOOLEAN DEFAULT false`)
    await db.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS report_email VARCHAR(255)`)
    await db.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS report_period VARCHAR(20) DEFAULT 'last_7d'`)
    await db.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_report_sent_at TIMESTAMP`)
    console.log('[agent] DB colunas OK')
  } catch (err) {
    console.error('[agent] DB init error:', err.message)
  }
}

// Start scheduler
function startAgent() {
  initDb()
  // Every day at 8:00 AM (BRT = UTC-3, so 11:00 UTC)
  const schedule = process.env.AGENT_CRON || '0 11 * * *'
  cron.schedule(schedule, () => {
    console.log('[agent] Cron disparado:', new Date().toISOString())
    runAgent()
  }, { timezone: 'America/Sao_Paulo' })
  console.log(`[agent] Agente iniciado. Cron: ${schedule}`)
}

module.exports = { startAgent, runAgent, runAgentForClient, generateReport }
