require('dotenv').config()
const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const rateLimit = require('express-rate-limit')

const app = express()

app.use(helmet())
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }))
app.use(express.json())
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }))

app.use('/auth', require('./routes/auth'))
app.use('/clients', require('./routes/clients'))
app.use('/meta', require('./routes/meta'))
app.use('/settings', require('./routes/settings'))

app.get('/health', (_, res) => res.json({ status: 'ok', app: 'Avodah Agency Dash API' }))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Avodah API rodando na porta ${PORT}`))
