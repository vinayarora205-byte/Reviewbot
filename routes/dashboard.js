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

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------
const adminSessions = new Set(); // set of valid admin tokens

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD is not set — the admin panel will reject all logins.');
}

// Default SMS template used when an admin leaves the template blank.
const DEFAULT_SMS_TEMPLATE =
  'Hi {{name}}, thank you for choosing {{business}}! How was your service today? Please leave us a review: {{maps_link}}';

function issueAdminToken() {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.add(token);
  return token;
}

// Admin auth middleware: requires a valid admin Bearer token
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
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

// ===========================================================================
// ADMIN ROUTES
// ===========================================================================

// ---------------------------------------------------------------------------
// POST /api/admin/login
// ---------------------------------------------------------------------------
router.post('/admin/login', (req, res) => {
  try {
    const { password } = req.body || {};
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      return res
        .status(500)
        .json({ success: false, message: 'Admin panel is not configured' });
    }

    if (!password || password !== adminPassword) {
      return res.status(401).json({ success: false, message: 'Invalid admin password' });
    }

    const token = issueAdminToken();
    res.json({ success: true, token });
  } catch (err) {
    console.error('Admin login error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/logout  (optional)
// ---------------------------------------------------------------------------
router.post('/admin/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token) adminSessions.delete(token);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/admin/create-client
// ---------------------------------------------------------------------------
router.post('/admin/create-client', requireAdmin, async (req, res) => {
  try {
    const { business_name, password, sms_template, delay_hours, google_maps_url } =
      req.body || {};

    if (!business_name || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'Business name and password are required' });
    }

    // Generate a unique CA-#### id (retry on collision)
    let clientId = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = 'CA-' + Math.floor(1000 + Math.random() * 9000);
      const { data: existing, error: checkError } = await supabase
        .from('clients')
        .select('id')
        .eq('id', candidate)
        .maybeSingle();
      if (checkError) throw checkError;
      if (!existing) {
        clientId = candidate;
        break;
      }
    }

    if (!clientId) {
      return res
        .status(500)
        .json({ success: false, message: 'Could not generate a unique client ID, try again' });
    }

    const { error: insertError } = await supabase.from('clients').insert({
      id: clientId,
      business_name,
      dashboard_password: password,
      sms_template: sms_template && sms_template.trim() ? sms_template : DEFAULT_SMS_TEMPLATE,
      delay_hours: delay_hours != null ? delay_hours : 2,
      google_maps_url: google_maps_url || null,
    });

    if (insertError) throw insertError;

    res.json({
      success: true,
      client_id: clientId,
      business_name,
      password,
    });
  } catch (err) {
    console.error('Create client error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/clients
// ---------------------------------------------------------------------------
router.get('/admin/clients', requireAdmin, async (req, res) => {
  try {
    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, business_name, sms_template, delay_hours, google_maps_url, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(clients || []);
  } catch (err) {
    console.error('List clients error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/delete-client/:id
// ---------------------------------------------------------------------------
router.delete('/admin/delete-client/:id', requireAdmin, async (req, res) => {
  try {
    const clientId = req.params.id;

    // Remove dependent rows first, then the client
    const jobsDel = await supabase.from('sms_jobs').delete().eq('client_id', clientId);
    if (jobsDel.error) throw jobsDel.error;

    const empDel = await supabase.from('employees').delete().eq('client_id', clientId);
    if (empDel.error) throw empDel.error;

    const clientDel = await supabase.from('clients').delete().eq('id', clientId);
    if (clientDel.error) throw clientDel.error;

    res.json({ success: true });
  } catch (err) {
    console.error('Delete client error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
