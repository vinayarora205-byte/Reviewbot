require('dotenv').config();
const readline = require('readline');
const supabase = require('./services/supabase');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Promisified question helper
function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// Generate a client ID like "CA-1234" (4 random digits)
function generateClientId() {
  const digits = Math.floor(1000 + Math.random() * 9000); // 1000 - 9999
  return `CA-${digits}`;
}

async function main() {
  try {
    const businessName = await ask('Enter business name: ');
    const dashboardPassword = await ask('Enter dashboard password: ');

    const clientId = generateClientId();

    // Insert the client. Omitting sms_template / delay_hours / created_at lets
    // the database apply their default values.
    const { error } = await supabase.from('clients').insert({
      id: clientId,
      business_name: businessName,
      dashboard_password: dashboardPassword,
    });

    if (error) throw error;

    console.log(
      `\n✅ Client created!\n` +
        `Client ID: ${clientId}\n` +
        `Password: ${dashboardPassword}\n` +
        `Telegram registration code: /start ${clientId}\n` +
        `Share this with your employees.`
    );
  } catch (err) {
    console.error('\n❌ Failed to create client:', err.message);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
