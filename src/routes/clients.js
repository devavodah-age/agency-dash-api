const router = require('express').Router()
const auth = require('../middleware/auth')
const db = require('../config/db')

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

router.post('/', auth, async (req, res) => {
  const { name, email, meta_account_id: raw_id } = req.body
  const meta_account_id = raw_id ? raw_id.replace(/^act_/, '') : ''
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

router.put('/:id', auth, async (req, res) => {
  const { name, email, meta_account_id: raw_id } = req.body
  const meta_account_id = raw_id ? raw_id.replace(/^act_/, '') : ''
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

// POST /clients/:id/link-user — link a client_user (by email) to this client
router.post('/:id/link-user', auth, async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' })
  try {
    const clientCheck = await db.query(
      'SELECT id FROM clients WHERE id=$1 AND agency_id=$2',
      [req.params.id, req.user.agency_id]
    )
    if (!clientCheck.rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' })

    const userCheck = await db.query('SELECT id FROM client_users WHERE email=$1', [email])
    if (!userCheck.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado. Peça ao cliente para criar a conta primeiro.' })

    await db.query('UPDATE client_users SET client_id=$1 WHERE email=$2', [req.params.id, email])
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro interno' })
  }
})

// GET /clients/:id/linked-users — list users linked to this client
router.get('/:id/linked-users', auth, async (req, res) => {
  try {
    const clientCheck = await db.query(
      'SELECT id FROM clients WHERE id=$1 AND agency_id=$2',
      [req.params.id, req.user.agency_id]
    )
    if (!clientCheck.rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' })

    const { rows } = await db.query(
      'SELECT id, name, email, created_at FROM client_users WHERE client_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    )
    res.json(rows)
  } catch {
    res.status(500).json({ error: 'Erro interno' })
  }
})

module.exports = router
