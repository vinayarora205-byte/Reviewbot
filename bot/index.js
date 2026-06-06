require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const supabase = require('../services/supabase');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN in environment variables');
}

// Polling mode (not webhook)
const bot = new TelegramBot(token, { polling: true });

// Temporary in-memory store of pending jobs awaiting YES/NO confirmation.
// key = telegram_user_id (string), value = { name, phone }
const pendingJobs = new Map();

/**
 * Extract a customer name and a 10-digit phone number from a free-text message.
 * Phone: any sequence of 10 digits, ignoring spaces, dashes, dots and parentheses.
 * Name: the message with digits and separators stripped out, then trimmed.
 */
function parseJob(text) {
  const digitsOnly = text.replace(/[\s\-().]/g, '');
  const phoneMatch = digitsOnly.match(/\d{10}/);
  const phone = phoneMatch ? phoneMatch[0] : null;

  const name = text
    .replace(/\d/g, '')        // remove all digits (the phone number)
    .replace(/[,\-]/g, ' ')    // turn separators into spaces
    .replace(/\s+/g, ' ')      // collapse whitespace
    .trim();

  return { name, phone };
}

// ---------------------------------------------------------------------------
// 1. REGISTRATION  — /start <CODE>
// ---------------------------------------------------------------------------
async function handleRegistration(msg, code) {
  const chatId = msg.chat.id;
  const telegramUserId = String(msg.from.id);
  const firstName = msg.from.first_name || '';

  try {
    // Look up the client by the registration code (clients.id)
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', code)
      .maybeSingle();

    if (clientError) throw clientError;

    if (!client) {
      await bot.sendMessage(
        chatId,
        '❌ Invalid code. Ask your manager for the correct registration code.'
      );
      return;
    }

    // Already registered?
    const { data: existing, error: existingError } = await supabase
      .from('employees')
      .select('*')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing) {
      await bot.sendMessage(
        chatId,
        `You are already registered with ${client.business_name}. Just send me customer name and phone number after each job.`
      );
      return;
    }

    // Register the new employee
    const { error: insertError } = await supabase.from('employees').insert({
      telegram_user_id: telegramUserId,
      client_id: client.id,
      employee_name: firstName,
    });

    if (insertError) throw insertError;

    await bot.sendMessage(
      chatId,
      `✅ Welcome! You are now registered as a ${client.business_name} technician. After every job just send me the customer name and phone number like this: John Smith, 9876543210`
    );
  } catch (err) {
    console.error('Registration error:', err);
    await bot.sendMessage(
      chatId,
      'Something went wrong while registering. Please try again in a moment.'
    );
  }
}

// ---------------------------------------------------------------------------
// 3. CONFIRMATION — YES / NO for a pending job
// ---------------------------------------------------------------------------
async function handleConfirmation(msg, answer) {
  const chatId = msg.chat.id;
  const telegramUserId = String(msg.from.id);
  const pending = pendingJobs.get(telegramUserId);

  try {
    if (answer === 'NO') {
      pendingJobs.delete(telegramUserId);
      await bot.sendMessage(
        chatId,
        'Cancelled. Send me the customer details again whenever you are ready.'
      );
      return;
    }

    // answer === 'YES'
    // Look up the employee to get their client_id
    const { data: employee, error: employeeError } = await supabase
      .from('employees')
      .select('*')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();

    if (employeeError) throw employeeError;

    if (!employee) {
      pendingJobs.delete(telegramUserId);
      await bot.sendMessage(
        chatId,
        'Please register first. Ask your manager for the registration code and send /start YOUR-CODE'
      );
      return;
    }

    // Look up the full client settings
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', employee.client_id)
      .maybeSingle();

    if (clientError) throw clientError;

    if (!client) {
      pendingJobs.delete(telegramUserId);
      await bot.sendMessage(
        chatId,
        'Your business profile could not be found. Please contact your manager.'
      );
      return;
    }

    // Build the SMS body from the template
    const message = (client.sms_template || '')
      .replace(/{{name}}/g, pending.name)
      .replace(/{{business}}/g, client.business_name || '')
      .replace(/{{maps_link}}/g, client.google_maps_url || '');

    // send_at = now + delay_hours
    const delayHours = client.delay_hours != null ? client.delay_hours : 2;
    const sendAt = new Date(Date.now() + delayHours * 60 * 60 * 1000);

    const { error: jobError } = await supabase.from('sms_jobs').insert({
      client_id: employee.client_id,
      customer_name: pending.name,
      customer_phone: pending.phone,
      message_to_send: message,
      send_at: sendAt.toISOString(),
      status: 'pending',
    });

    if (jobError) throw jobError;

    pendingJobs.delete(telegramUserId);

    await bot.sendMessage(
      chatId,
      `✅ Done! Review request for ${pending.name} scheduled. They will receive an SMS in ${delayHours} hour(s).`
    );
  } catch (err) {
    console.error('Confirmation error:', err);
    await bot.sendMessage(
      chatId,
      'Something went wrong while scheduling the review request. Please try again.'
    );
  }
}

// ---------------------------------------------------------------------------
// 2. JOB SUBMISSION — a registered employee sends customer name + phone
// ---------------------------------------------------------------------------
async function handleJobSubmission(msg) {
  const chatId = msg.chat.id;
  const telegramUserId = String(msg.from.id);

  try {
    // Must be a registered employee
    const { data: employee, error: employeeError } = await supabase
      .from('employees')
      .select('*')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();

    if (employeeError) throw employeeError;

    if (!employee) {
      await bot.sendMessage(
        chatId,
        'Please register first. Ask your manager for the registration code and send /start YOUR-CODE'
      );
      return;
    }

    const { name, phone } = parseJob(msg.text);

    if (!phone) {
      await bot.sendMessage(
        chatId,
        'I could not find a phone number in your message. Please send it like this: John Smith, 9876543210'
      );
      return;
    }

    // Stash the pending job for confirmation
    pendingJobs.set(telegramUserId, { name, phone });

    await bot.sendMessage(
      chatId,
      `Please confirm:\n👤 Customer: ${name}\n📱 Phone: ${phone}\n\nReply YES to send review request or NO to cancel.`
    );
  } catch (err) {
    console.error('Job submission error:', err);
    await bot.sendMessage(
      chatId,
      'Something went wrong. Please try sending the customer details again.'
    );
  }
}

// ---------------------------------------------------------------------------
// Main message router
// ---------------------------------------------------------------------------
bot.on('message', async (msg) => {
  try {
    if (!msg.text) return; // ignore non-text messages

    const text = msg.text.trim();
    const telegramUserId = String(msg.from.id);

    // 1. Registration: /start <CODE>
    if (text.startsWith('/start')) {
      const match = text.match(/^\/start\s+(\S+)/);
      if (!match) {
        await bot.sendMessage(
          msg.chat.id,
          '❌ Invalid code. Ask your manager for the correct registration code.'
        );
        return;
      }
      await handleRegistration(msg, match[1]);
      return;
    }

    // 3. Confirmation: YES / NO when a job is pending
    const upper = text.toUpperCase();
    if ((upper === 'YES' || upper === 'NO') && pendingJobs.has(telegramUserId)) {
      await handleConfirmation(msg, upper);
      return;
    }

    // 2. Otherwise treat as a job submission
    await handleJobSubmission(msg);
  } catch (err) {
    console.error('Message handler error:', err);
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('Telegram bot started in polling mode.');

module.exports = bot;
