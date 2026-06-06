const express = require('express');
const crypto = require('crypto');
const supabase = require('../services/supabase');

const router = express.Router();

// ---------------------------------------------------------------------------
// In-memory session store: token -> client_id
// (lightweight; tokens are lost on server restart, which just forces re-login)
// ---------------------------------------------------------------------------
const sessions = new Map();

function issueToken(clientId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, clientId);
  return token;
}

// Auth middleware: requires a valid Bearer token whose client matches :client_id
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const clientId = sessions.get(token);

  // Token must belong to the client being requested
  if (req.params.client_id && clientId !== req.params.client_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  req.authClientId = clientId;
  next();
}

// ---------------------------------------------------------------------------
// POST /api/login
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { client_id, password } = req.body || {};

    if (!client_id || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'Client ID and password are required' });
    }

    const { data: client, error } = await supabase
      .from('clients')
      .select('id, business_name, sms_template, delay_hours, google_maps_url')
      .eq('id', client_id)
      .eq('dashboard_password', password)
      .maybeSingle();

    if (error) throw error;

    if (!client) {
      return res
        .status(401)
        .json({ success: false, message: 'Invalid Client ID or password' });
    }

    const token = issueToken(client.id);
    res.json({ success: true, token, client });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/logout  (optional — invalidates a token)
// ---------------------------------------------------------------------------
router.post('/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token) sessions.delete(token);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /api/stats/:client_id
// ---------------------------------------------------------------------------
router.get('/stats/:client_id', requireAuth, async (req, res) => {
  try {
    const clientId = req.params.client_id;

    // Helper: count rows for this client with optional extra filters
    const countJobs = async (build) => {
      let query = supabase
        .from('sms_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', clientId);
      if (build) query = build(query);
      const { count, error } = await query;
      if (error) throw error;
      return count || 0;
    };

    // Start of the current calendar month (UTC)
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();

    const [total, sent, pending, failed, thisMonth] = await Promise.all([
      countJobs(),
      countJobs((q) => q.eq('status', 'sent')),
      countJobs((q) => q.eq('status', 'pending')),
      countJobs((q) => q.eq('status', 'failed')),
      countJobs((q) => q.gte('created_at', monthStart)),
    ]);

    res.json({
      total,
      sent,
      pending,
      failed,
      this_month: thisMonth,
    });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/jobs/:client_id
// ---------------------------------------------------------------------------
router.get('/jobs/:client_id', requireAuth, async (req, res) => {
  try {
    const clientId = req.params.client_id;

    const { data: jobs, error } = await supabase
      .from('sms_jobs')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(jobs || []);
  } catch (err) {
    console.error('Jobs error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/settings/:client_id
// ---------------------------------------------------------------------------
router.post('/settings/:client_id', requireAuth, async (req, res) => {
  try {
    const clientId = req.params.client_id;
    const { sms_template, delay_hours, google_maps_url } = req.body || {};

    const { error } = await supabase
      .from('clients')
      .update({
        sms_template,
        delay_hours,
        google_maps_url,
      })
      .eq('id', clientId);

    if (error) throw error;

    res.json({ success: true, message: 'Settings saved' });
  } catch (err) {
    console.error('Settings error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
