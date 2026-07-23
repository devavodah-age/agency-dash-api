const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const db = require('../config/db')

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios' })
  }

  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email])
    const user = rows[0]
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, agency_id: user.agency_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    )

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    })
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// POST /auth/register
router.post('/register', async (req, res) => {
  const { name, email, password, agency_id } = req.body

if (!name || !email || !password || !agency_id) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' })
  }

  try {
    const exists = await db.query('SELECT id FROM users WHERE email = $1', [email])
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Email já cadastrado' })
    }

    const password_hash = await bcrypt.hash(password, 10)
    const { rows } = await db.query(
      'INSERT INTO users (agency_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role',
      [agency_id, name, email, password_hash, 'manager']
    )

    res.status(201).json({ message: 'Usuário criado com sucesso', user: rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// GET /auth/me
router.get('/me', require('../middleware/auth'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, email, role, created_at FROM users WHERE id = $1',
      [req.user.id]
    )
    res.json(rows[0])
  } catch {
    res.status(500).json({ error: 'Erro interno' })
  }
})

module.exports = router
