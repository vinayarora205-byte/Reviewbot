require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment variables');
}

// Node.js 20 has no native WebSocket; provide one for Supabase Realtime.
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: {
    transport: ws,
  },
});

module.exports = supabase;
