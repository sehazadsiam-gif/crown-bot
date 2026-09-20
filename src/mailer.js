import nodemailer from 'nodemailer';

/**
 * Returns a configured nodemailer transporter if SMTP credentials exist in environment variables.
 */
export function getMailTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: {
      rejectUnauthorized: process.env.SMTP_IGNORE_TLS !== 'true'
    }
  });
}

/**
 * Sends account credentials and dedicated bot domain details to a new or existing tenant.
 */
export async function sendTenantCredentialsEmail({
  to,
  businessName,
  tenantName,
  email,
  password,
  loginUrl = 'https://bot.ccadmin.online/chatbotadmin/',
  botUrl = '',
  dedicatedDomain = ''
}) {
  const bName = businessName || tenantName || 'Your Business';
  if (!to || !to.includes('@')) {
    return { sent: false, error: 'No valid recipient email address provided.' };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@ccadmin.online';
  const transporter = getMailTransporter();

  const domainSectionText = dedicatedDomain
    ? `Dedicated Domain: https://${dedicatedDomain}\nDedicated Web Chat: ${botUrl || `https://${dedicatedDomain}/`}`
    : `Dedicated Web Chat: ${botUrl}`;

  const textContent = `Hello ${bName} Team,

Welcome to the CC AI Operations Platform! Your dedicated autonomous intelligence operations center has been provisioned.

==================================================
YOUR ACCOUNT CREDENTIALS
==================================================
Business Name: ${bName}
Login Identifier: ${email}
Temporary Password: ${password}
Operations Portal: ${loginUrl}
${domainSectionText}
==================================================

GETTING STARTED:
1. Open ${loginUrl} and sign in using your credentials above.
2. Update your business profile, menu/catalog, and verified FAQs.
3. Use the Interactive Playground to test your chatbot's responses.
4. Connect your Facebook, Instagram, or WhatsApp channels from the Multi-Channels tab.

If you have any questions or require custom setup assistance, reply directly to this email.

Best regards,
The CC AI Team
`;

  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin:0; padding:20px; background-color:#f1f5f9; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <div style="max-width:580px; margin:0 auto; background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; overflow:hidden; box-shadow:0 4px 14px rgba(0,0,0,0.05);">
      <!-- Header -->
      <div style="background:linear-gradient(135deg, #4f46e5 0%, #6366f1 100%); padding:28px 24px; text-align:center; color:#ffffff;">
        <div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.1em; opacity:0.85; margin-bottom:6px;">Autonomous AI Operations</div>
        <h1 style="margin:0; font-size:22px; font-weight:800; letter-spacing:-0.02em;">Welcome, ${escapeHtml(bName)}!</h1>
      </div>

      <!-- Body -->
      <div style="padding:28px 24px; color:#0f172a;">
        <p style="font-size:14px; line-height:1.6; color:#475569; margin-top:0; margin-bottom:20px;">
          Your dedicated AI operations center and customer conversation engine has been provisioned. You can now access your dashboard to customize business knowledge, monitor orders, and connect social channels.
        </p>

        <!-- Credentials Box -->
        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:18px 20px; margin-bottom:24px;">
          <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#6366f1; margin-bottom:12px;">Your Login Credentials</div>
          
          <table style="width:100%; border-collapse:collapse; font-size:13.5px;">
            <tr>
              <td style="padding:6px 0; color:#64748b; width:130px;">Business Name:</td>
              <td style="padding:6px 0; font-weight:700; color:#0f172a;">${escapeHtml(bName)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#64748b;">Username / Email:</td>
              <td style="padding:6px 0; font-family:ui-monospace, monospace; font-weight:700; color:#4f46e5;">${escapeHtml(email)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#64748b;">Password:</td>
              <td style="padding:6px 0; font-family:ui-monospace, monospace; font-weight:700; color:#0f172a;">${escapeHtml(password)}</td>
            </tr>
            ${dedicatedDomain ? `
            <tr>
              <td style="padding:6px 0; color:#64748b;">Dedicated Domain:</td>
              <td style="padding:6px 0;"><a href="https://${escapeHtml(dedicatedDomain)}" style="color:#4f46e5; text-decoration:none; font-weight:600;">https://${escapeHtml(dedicatedDomain)}</a></td>
            </tr>` : ''}
            ${botUrl ? `
            <tr>
              <td style="padding:6px 0; color:#64748b;">Live Web Chat:</td>
              <td style="padding:6px 0;"><a href="${escapeHtml(botUrl)}" style="color:#059669; text-decoration:none; font-weight:600;">Open Customer Web Chat &rarr;</a></td>
            </tr>` : ''}
          </table>
        </div>

        <!-- Action Button -->
        <div style="text-align:center; margin:24px 0;">
          <a href="${escapeHtml(loginUrl)}" style="display:inline-block; background:linear-gradient(135deg, #4f46e5, #6366f1); color:#ffffff; font-weight:700; font-size:14px; padding:12px 28px; border-radius:8px; text-decoration:none; box-shadow:0 4px 12px rgba(79,70,229,0.3);">
            Access Operations Dashboard &rarr;
          </a>
        </div>

        <!-- Getting Started -->
        <div style="border-top:1px solid #e2e8f0; padding-top:18px; margin-top:24px; font-size:12.5px; color:#64748b; line-height:1.55;">
          <strong style="color:#0f172a;">Quick Start Steps:</strong>
          <ol style="margin:8px 0 0; padding-left:18px;">
            <li>Log in and update your <strong>Services &amp; Catalog</strong> with your current pricing.</li>
            <li>Add common customer questions to <strong>Verified FAQs</strong>.</li>
            <li>Test conversations in real-time in the <strong>AI Playground</strong>.</li>
          </ol>
        </div>
      </div>

      <!-- Footer -->
      <div style="background:#f8fafc; border-top:1px solid #e2e8f0; padding:16px 24px; text-align:center; font-size:11.5px; color:#94a3b8;">
        CC Autonomous AI Platform &bull; Security &amp; Encryption Standard &bull; Dhaka, Bangladesh
      </div>
    </div>
  </body>
  </html>
  `;

  if (!transporter) {
    console.log('\n======================================================');
    console.log(' [SMTP NOTICE] No SMTP configured in environment variables.');
    console.log(` To: ${to}`);
    console.log(` Subject: Welcome to CC AI Operations Center — Your Credentials for ${bName}`);
    console.log(` Credentials: Email=${email}, Password=${password}`);
    console.log(` Login URL: ${loginUrl}`);
    if (dedicatedDomain) console.log(` Dedicated Domain: https://${dedicatedDomain}`);
    console.log(' To send real emails, set SMTP_HOST, SMTP_USER, SMTP_PASS in Coolify.');
    console.log('======================================================\n');
    return {
      sent: false,
      simulated: true,
      recipient: to,
      message: 'Credentials logged. Set SMTP_HOST, SMTP_USER, SMTP_PASS in Coolify to deliver live emails.'
    };
  }

  try {
    const info = await transporter.sendMail({
      from: `"CC AI Operations Center" <${from}>`,
      to,
      subject: `Welcome to CC AI Operations Center — Your Credentials for ${bName}`,
      text: textContent,
      html: htmlContent
    });
    console.log(`[SMTP SUCCESS] Credentials dispatched to ${to} (Message ID: ${info.messageId})`);
    return { sent: true, recipient: to, messageId: info.messageId };
  } catch (err) {
    console.error(`[SMTP ERROR] Failed to send email to ${to}:`, err.message);
    return { sent: false, error: err.message, recipient: to };
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
