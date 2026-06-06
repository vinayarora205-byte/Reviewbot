require('dotenv').config();
const express = require('express');

// Start the Telegram bot (polling mode)
require('./bot');

// Start the SMS scheduler (Twilio + node-cron)
const startScheduler = require('./services/scheduler');

// Supabase client for the test route
const supabase = require('./services/supabase');

const app = express();

const PORT = process.env.PORT || 3000;

// Parse JSON request bodies
app.use(express.json());

// Serve the client dashboard (public/index.html) at /
app.use(express.static('public'));

// Dashboard API routes
app.use('/api', require('./routes/dashboard'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Test route: schedules an SMS 1 minute from now so Twilio can be verified
// without waiting for a real delay. Example:
//   /test-sms?phone=9876543210&name=John
app.get('/test-sms', async (req, res) => {
  try {
    const { phone, name } = req.query;

    if (!phone) {
      return res.status(400).json({ error: 'Missing required query param: phone' });
    }

    const customerName = name || 'Test Customer';
    const sendAt = new Date(Date.now() + 60 * 1000); // 1 minute from now

    const { data, error } = await supabase
      .from('sms_jobs')
      .insert({
        customer_name: customerName,
        customer_phone: phone,
        message_to_send: `Test SMS for ${customerName}. Your review system is working!`,
        send_at: sendAt.toISOString(),
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      message: 'Test SMS job scheduled. It will be sent within ~2 minutes by the scheduler.',
      job_id: data.id,
      send_at: data.send_at,
      to: '+91' + phone,
    });
  } catch (err) {
    console.error('test-sms error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
  startScheduler();
  console.log('SMS scheduler started');
});

// Make binding failures loud instead of silent
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `❌ Port ${PORT} is already in use. Another instance is probably still running. ` +
        `Stop it (see README / kill the old node process) and try again.`
    );
  } else {
    console.error('❌ Server error:', err);
  }
  process.exit(1);
});

// Never let a stray bot/scheduler error silently kill the process
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
