const router = require('express').Router()
const auth = require('../middleware/auth')
const db = require('../config/db')

// GET /settings/meta — busca credenciais Meta da agência
router.get('/meta', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT meta_bm_id, meta_access_token FROM agencies WHERE id = $1',
      [req.user.agency_id]
    )
    const agency = rows[0]
    res.json({
      meta_bm_id: agency?.meta_bm_id || '',
      has_token: !!agency?.meta_access_token
    })
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// PUT /settings/meta — salva credenciais Meta da agência
router.put('/meta', auth, async (req, res) => {
  const { meta_bm_id, meta_access_token } = req.body
  if (!meta_bm_id || !meta_access_token) {
    return res.status(400).json({ error: 'BM ID e Token são obrigatórios' })
  }
  try {
    await db.query(
      'UPDATE agencies SET meta_bm_id = $1, meta_access_token = $2 WHERE id = $3',
      [meta_bm_id, meta_access_token, req.user.agency_id]
    )
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// GET /settings/meta/test — testa token da BM
router.get('/meta/test', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT meta_bm_id, meta_access_token FROM agencies WHERE id = $1',
      [req.user.agency_id]
    )
    const agency = rows[0]
    if (!agency?.meta_bm_id || !agency?.meta_access_token) {
      return res.status(400).json({ error: 'Credenciais não configuradas' })
    }

    const url = `https://graph.facebook.com/v19.0/${agency.meta_bm_id}?fields=name,id&access_token=${agency.meta_access_token}`
    const response = await fetch(url)
    const data = await response.json()

    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ connected: true, bm_name: data.name, bm_id: data.id })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao testar conexão' })
  }
})

module.exports = router
