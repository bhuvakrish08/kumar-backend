const https = require('https');

/**
 * Sends a transactional email using Brevo's official v3 REST API.
 * Uses native Node https so no extra heavyweight dependencies are required.
 *
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} [options.name] - Recipient name
 * @param {string} options.subject - Email subject
 * @param {string} options.htmlContent - Formatted HTML body
 * @returns {Promise<{success: boolean, messageId?: string}>}
 */
async function sendBrevoEmail({ to, name, subject, htmlContent }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'support@kumardacontacts.com';
  const senderName = process.env.BREVO_SENDER_NAME || 'Kumarda Contacts';

  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured in backend environment.');
  }

  const payload = JSON.stringify({
    sender: {
      name: senderName,
      email: senderEmail
    },
    to: [
      {
        email: to,
        name: name || to
      }
    ],
    subject: subject,
    htmlContent: htmlContent
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.brevo.com',
        port: 443,
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': apiKey,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          try {
            const data = rawData ? JSON.parse(rawData) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, messageId: data.messageId });
            } else {
              const errMsg = data.message || `Brevo API responded with status ${res.statusCode}`;
              console.error('Brevo API Error:', res.statusCode, data);
              reject(new Error(errMsg));
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true });
            } else {
              reject(new Error(`Brevo HTTP error ${res.statusCode}: ${rawData}`));
            }
          }
        });
      }
    );

    req.on('error', (err) => {
      console.error('Brevo network request error:', err);
      reject(err);
    });

    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Brevo API request timed out after 15 seconds.'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Builds a modern, executive HTML email template for sending 6-digit OTPs.
 * Clean typography, rounded card design, high-contrast security badge, 2-minute timer.
 */
function buildOtpEmailTemplate(otp, username) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verification Code</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f8fafc; padding: 40px 15px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width: 500px; background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04); overflow: hidden;" cellspacing="0" cellpadding="0">
            <!-- Header Brand -->
            <tr>
              <td style="padding: 36px 36px 20px 36px; text-align: center;">
                <table role="presentation" cellspacing="0" cellpadding="0" align="center" style="margin: 0 auto;">
                  <tr>
                    <td style="width: 52px; height: 52px; background: linear-gradient(135deg, #2563eb, #1d4ed8); border-radius: 14px; text-align: center; vertical-align: middle;">
                      <span style="color: #ffffff; font-size: 26px; font-weight: 800; line-height: 52px; display: inline-block;">K</span>
                    </td>
                  </tr>
                </table>
                <h1 style="color: #0f172a; font-size: 22px; font-weight: 700; margin: 16px 0 4px 0; letter-spacing: -0.3px;">Kumarda Contacts</h1>
                <p style="color: #64748b; font-size: 13px; font-weight: 500; margin: 0; text-transform: uppercase; letter-spacing: 1px;">Security Verification</p>
              </td>
            </tr>

            <!-- Divider -->
            <tr>
              <td style="padding: 0 36px;">
                <div style="height: 1px; background-color: #f1f5f9; width: 100%;"></div>
              </td>
            </tr>

            <!-- Main Content -->
            <tr>
              <td style="padding: 24px 36px 32px 36px;">
                <p style="color: #1e293b; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">
                  Hello${username ? ` <strong>${username}</strong>` : ''},
                </p>
                <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 24px 0;">
                  We received a request to reset your account password. Please use the 6-digit verification code below to proceed:
                </p>

                <!-- OTP Code Display Card -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 auto 24px auto;">
                  <tr>
                    <td align="center" style="background-color: #f0f7ff; border: 2px dashed #93c5fd; border-radius: 14px; padding: 20px 10px;">
                      <div style="font-size: 38px; font-weight: 800; letter-spacing: 10px; color: #1e40af; font-family: 'Courier New', Courier, monospace; margin-left: 10px;">
                        ${otp}
                      </div>
                    </td>
                  </tr>
                </table>

                <!-- Urgency & Expiration Warning Notice -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
                  <tr>
                    <td align="center" style="background-color: #fef2f2; border: 1px solid #fee2e2; border-radius: 10px; padding: 10px 16px;">
                      <span style="color: #dc2626; font-size: 13px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px;">
                        ⏱️ Valid for only 2 minutes (120 seconds).
                      </span>
                    </td>
                  </tr>
                </table>

                <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0;">
                  If you didn't request a password reset, you can safely ignore this email. Your password and account will remain safe.
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background-color: #f8fafc; padding: 20px 36px; text-align: center; border-top: 1px solid #e2e8f0;">
                <p style="color: #94a3b8; font-size: 12px; margin: 0; line-height: 1.4;">
                  © ${new Date().getFullYear()} Kumarda Contacts • Executive Relationship Memory
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

module.exports = {
  sendBrevoEmail,
  buildOtpEmailTemplate
};
