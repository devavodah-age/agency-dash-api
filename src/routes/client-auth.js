const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const db = require('../config/db')

// POST /client-auth/register
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body
  if (!name || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos' })
  try {
    const exists = await db.query('SELECT id FROM client_users WHERE email=$1', [email])
    if (exists.rows[0]) return res.status(409).json({ error: 'E-mail já cadastrado' })
    const hash = await bcrypt.hash(password, 10)
    const { rows } = await db.query(
      'INSERT INTO client_users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email, client_id',
      [name, email, hash]
    )
    const user = rows[0]
    const token = jwt.sign({ id: user.id, role: 'client', client_id: user.client_id }, process.env.JWT_SECRET, { expiresIn: '7d' })
    res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email, client_id: user.client_id } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro interno' })
  }
})

// POST /client-auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body
  try {
    const { rows } = await db.query('SELECT * FROM client_users WHERE email=$1', [email])
    const user = rows[0]
    if (!user) return res.status(401).json({ error: 'Email ou senha incorretos' })
    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) return res.status(401).json({ error: 'Email ou senha incorretos' })
    const token = jwt.sign({ id: user.id, role: 'client', client_id: user.client_id }, process.env.JWT_SECRET, { expiresIn: '7d' })
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, client_id: user.client_id } })
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// GET /client-auth/me
router.get('/me', async (req, res) => {
  const auth = req.headers.authorization
  if (!auth) return res.status(401).json({ error: 'Sem token' })
  try {
    const payload = jwt.verify(auth.replace('Bearer ', ''), process.env.JWT_SECRET)
    if (payload.role !== 'client') return res.status(403).json({ error: 'Acesso negado' })
    const { rows } = await db.query('SELECT id, name, email, client_id FROM client_users WHERE id=$1', [payload.id])
    res.json(rows[0])
  } catch {
    res.status(401).json({ error: 'Token inválido' })
  }
})

module.exports = router
