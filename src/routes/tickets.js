const router = require('express').Router()
const db = require('../config/db')
const auth = require('../middleware/auth')

// Init: create ticket_messages table and add missing columns to tickets
;(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ticket_messages (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
        sender_type VARCHAR(10) NOT NULL,
        sender_name VARCHAR(255),
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)

    await db.query(`
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'aberto'
    `)

    await db.query(`
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
    `)

    console.log('[tickets] DB init OK')
  } catch (err) {
    console.error('[tickets] DB init error:', err.message)
  }
})()

// GET /tickets — list all tickets for this agency
router.get('/', auth, async (req, res) => {
  try {
    const { agency_id } = req.user

    const { rows } = await db.query(
      `
      SELECT
        t.id,
        t.subject,
        t.status,
        t.created_at,
        c.name AS client_name,
        cu.name AS client_user_name,
        cu.email AS client_user_email,
        (
          SELECT MAX(tm.created_at)
          FROM ticket_messages tm
          WHERE tm.ticket_id = t.id
        ) AS last_message_at,
        (
          SELECT COUNT(*)
          FROM ticket_messages tm
          WHERE tm.ticket_id = t.id
            AND tm.sender_type = 'client'
        ) AS unread_count
      FROM tickets t
      JOIN clients c ON c.id = t.client_id
      LEFT JOIN client_users cu ON cu.id = t.client_user_id
      WHERE c.agency_id = $1
      ORDER BY t.created_at DESC
      `,
      [agency_id]
    )

    // Build status summary
    const statusCount = { aberto: 0, em_andamento: 0, resolvido: 0 }
    for (const row of rows) {
      if (statusCount[row.status] !== undefined) {
        statusCount[row.status]++
      }
    }

    res.json({ tickets: rows, status_count: statusCount })
  } catch (err) {
    console.error('[GET /tickets]', err)
    res.status(500).json({ error: 'Erro interno' })
  }
})

// GET /tickets/:id — get single ticket with full message thread
router.get('/:id', auth, async (req, res) => {
  try {
    const { agency_id } = req.user
    const ticketId = parseInt(req.params.id, 10)

    // Fetch ticket, ensuring it belongs to this agency
    const { rows: ticketRows } = await db.query(
      `
      SELECT
        t.id,
        t.subject,
        t.message AS original_message,
        t.status,
        t.created_at,
        t.updated_at,
        c.name AS client_name,
        c.id AS client_id,
        cu.name AS client_user_name,
        cu.email AS client_user_email
      FROM tickets t
      JOIN clients c ON c.id = t.client_id
      LEFT JOIN client_users cu ON cu.id = t.client_user_id
      WHERE t.id = $1
        AND c.agency_id = $2
      `,
      [ticketId, agency_id]
    )

    if (ticketRows.length === 0) {
      return res.status(404).json({ error: 'Ticket não encontrado' })
    }

    const ticket = ticketRows[0]

    // Fetch message thread
    const { rows: messages } = await db.query(
      `
      SELECT
        id,
        sender_type,
        sender_name,
        message,
        created_at
      FROM ticket_messages
      WHERE ticket_id = $1
      ORDER BY created_at ASC
      `,
      [ticketId]
    )

    res.json({ ticket, messages })
  } catch (err) {
    console.error('[GET /tickets/:id]', err)
    res.status(500).json({ error: 'Erro interno' })
  }
})

// POST /tickets/:id/messages — agency sends a reply
router.post('/:id/messages', auth, async (req, res) => {
  try {
    const { agency_id } = req.user
    const ticketId = parseInt(req.params.id, 10)
    const { message } = req.body

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Mensagem é obrigatória' })
    }

    // Verify ticket belongs to this agency
    const { rows: ticketRows } = await db.query(
      `
      SELECT t.id, t.status
      FROM tickets t
      JOIN clients c ON c.id = t.client_id
      WHERE t.id = $1
        AND c.agency_id = $2
      `,
      [ticketId, agency_id]
    )

    if (ticketRows.length === 0) {
      return res.status(404).json({ error: 'Ticket não encontrado' })
    }

    const ticket = ticketRows[0]

    // Insert agency message
    const { rows: newMessage } = await db.query(
      `
      INSERT INTO ticket_messages (ticket_id, sender_type, sender_name, message)
      VALUES ($1, 'agency', 'Agência', $2)
      RETURNING id, sender_type, sender_name, message, created_at
      `,
      [ticketId, message.trim()]
    )

    // Update ticket status to 'em_andamento' if it was 'aberto', and bump updated_at
    const newStatus = ticket.status === 'aberto' ? 'em_andamento' : ticket.status
    await db.query(
      `
      UPDATE tickets
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      `,
      [newStatus, ticketId]
    )

    res.status(201).json({ message: newMessage[0], ticket_status: newStatus })
  } catch (err) {
    console.error('[POST /tickets/:id/messages]', err)
    res.status(500).json({ error: 'Erro interno' })
  }
})

// PATCH /tickets/:id/status — update ticket status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { agency_id } = req.user
    const ticketId = parseInt(req.params.id, 10)
    const { status } = req.body

    const validStatuses = ['aberto', 'em_andamento', 'resolvido']
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Status inválido. Use um de: ${validStatuses.join(', ')}`
      })
    }

    // Verify ticket belongs to this agency
    const { rows: ticketRows } = await db.query(
      `
      SELECT t.id
      FROM tickets t
      JOIN clients c ON c.id = t.client_id
      WHERE t.id = $1
        AND c.agency_id = $2
      `,
      [ticketId, agency_id]
    )

    if (ticketRows.length === 0) {
      return res.status(404).json({ error: 'Ticket não encontrado' })
    }

    const { rows: updated } = await db.query(
      `
      UPDATE tickets
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, status, updated_at
      `,
      [status, ticketId]
    )

    res.json({ ticket: updated[0] })
  } catch (err) {
    console.error('[PATCH /tickets/:id/status]', err)
    res.status(500).json({ error: 'Erro interno' })
  }
})

module.exports = router
