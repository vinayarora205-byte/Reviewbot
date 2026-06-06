require('dotenv').config();
const cron = require('node-cron');
const twilio = require('twilio');
const supabase = require('./supabase');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;

if (!accountSid || !authToken) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in environment variables');
}

const client = twilio(accountSid, authToken);

/**
 * Process all due SMS jobs once.
 */
async function processPendingJobs() {
  try {
    // 1. Find all pending jobs that are due
    const { data: jobs, error } = await supabase
      .from('sms_jobs')
      .select('*')
      .eq('status', 'pending')
      .lte('send_at', new Date().toISOString());

    if (error) throw error;

    // 2. Nothing to do
    if (!jobs || jobs.length === 0) {
      console.log('Scheduler ran - no pending jobs');
      return;
    }

    // 3. Process each due job
    for (const job of jobs) {
      try {
        await client.messages.create({
          body: job.message_to_send,
          from: fromNumber,
          to: '+91' + job.customer_phone,
        });

        // Success -> mark as sent
        const { error: updateError } = await supabase
          .from('sms_jobs')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', job.id);

        if (updateError) throw updateError;

        console.log(`SMS sent to ${job.customer_phone} for job id ${job.id}`);
      } catch (jobErr) {
        // Failure -> mark as failed
        console.error(`Failed to send SMS for job id ${job.id}:`, jobErr.message);

        const { error: failError } = await supabase
          .from('sms_jobs')
          .update({ status: 'failed' })
          .eq('id', job.id);

        if (failError) {
          console.error(`Failed to update job id ${job.id} to failed:`, failError.message);
        }
      }
    }

    // 4. Done
    console.log(`Scheduler ran - processed ${jobs.length} jobs`);
  } catch (err) {
    console.error('Scheduler error:', err.message);
  }
}

/**
 * Start the cron job. Runs every 2 minutes.
 */
function startScheduler() {
  cron.schedule('*/2 * * * *', processPendingJobs);
}

module.exports = startScheduler;
