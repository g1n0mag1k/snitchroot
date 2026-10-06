require('dotenv').config();
const express = require('express');
const path = require('path');
const api = require('./src/api');
const { loadSitesFromDB } = require('./src/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', api);
app.get(/^(?!\/api).*$/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`SnitchRoot running on port ${PORT}`);
  if (!process.env.STRIPE_SECRET_KEY) console.warn('⚠️  STRIPE_SECRET_KEY not set');
  if (!process.env.SMTP_HOST) console.log('📬 No SMTP_HOST — using Ethereal (dev mode)');
  await loadSitesFromDB();
});

module.exports = app;
