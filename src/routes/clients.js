const router = require('express').Router()
const auth = require('../middleware/auth')
const db = require('../config/db')

// GET /clients
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM clients WHERE agency_id = $1 ORDER BY name ASC',
      [req.user.agency_id]
    )
    res.json(rows)
  } catch {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// POST /clients
router.post('/', auth, async (req, res) => {
  const { name, email, meta_account_id } = req.body
  if (!name) return res.status(400).json({ error: 'Nome é obrigatório' })

  try {
    const { rows } = await db.query(
      'INSERT INTO clients (name, email, meta_account_id, agency_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, email, meta_account_id, req.user.agency_id]
    )
    res.status(201).json(rows[0])
  } catch {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// GET /clients/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM clients WHERE id = $1 AND agency_id = $2',
      [req.params.id, req.user.agency_id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' })
    res.json(rows[0])
  } catch {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// PUT /clients/:id
router.put('/:id', auth, async (req, res) => {
  const { name, email, meta_account_id } = req.body
  try {
    const { rows } = await db.query(
      'UPDATE clients SET name=$1, email=$2, meta_account_id=$3, updated_at=NOW() WHERE id=$4 AND agency_id=$5 RETURNING *',
      [name, email, meta_account_id, req.params.id, req.user.agency_id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' })
    res.json(rows[0])
  } catch {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// DELETE /clients/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM clients WHERE id=$1 AND agency_id=$2',
      [req.params.id, req.user.agency_id]
    )
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Erro interno' })
  }
})

module.exports = router
