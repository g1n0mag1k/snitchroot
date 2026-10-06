const nodemailer = require('nodemailer');

/**
 * Build a transport from environment variables.
 * Set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS for production (e.g. SendGrid, Postmark).
 * Leave them unset during development — Nodemailer's createTestAccount / Ethereal is used instead
 * and a preview URL is logged so you can inspect the email in a browser.
 */
async function createTransport() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // Dev / test: use Ethereal so nothing real is sent.
  const testAccount = await nodemailer.createTestAccount();
  console.log('📬 Using Ethereal test transport (no real email sent).');
  return nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });
}

/**
 * Format a duration in ms as "Xm Xs".
 */
function duration(startedAt, finishedAt) {
  const ms = new Date(finishedAt) - new Date(startedAt);
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Group broken links by the page they were found on for a more actionable report.
 */
function groupByPage(broken) {
  const map = new Map();
  for (const item of broken) {
    const pages = item.foundOn.length ? item.foundOn : ['(unknown)'];
    for (const page of pages) {
      if (!map.has(page)) map.set(page, []);
      map.get(page).push(item);
    }
  }
  return map;
}

/**
 * Build the plain-text version of the report.
 */
function buildText(siteName, siteUrl, results) {
  const { broken, checked, pagesCrawled, externalChecked, startedAt, finishedAt } = results;
  const lines = [
    `SnitchRoot Report — ${siteName}`,
    '='.repeat(50),
    `Site:    ${siteUrl}`,
    `Scanned: ${new Date(startedAt).toUTCString()}`,
    `Time:    ${duration(startedAt, finishedAt)}`,
    `Pages crawled: ${pagesCrawled}  |  External links checked: ${externalChecked}  |  Total checked: ${checked}`,
    '',
  ];

  if (broken.length === 0) {
    lines.push('✅ No broken links found. Your site is clean!');
    return lines.join('\n');
  }

  lines.push(`🚨 ${broken.length} broken link${broken.length > 1 ? 's' : ''} found:\n`);
  const grouped = groupByPage(broken);

  for (const [page, items] of grouped) {
    lines.push(`Found on: ${page}`);
    for (const item of items) {
      const tag = item.external ? '[external]' : '[internal]';
      lines.push(`  ${tag} ${item.url}  →  ${item.status}`);
    }
    lines.push('');
  }

  lines.push('—');
  lines.push('SnitchRoot — Catches what your website tries to hide');
  lines.push('Manage your sites: https://app.snitchroot.com');
  return lines.join('\n');
}

/**
 * Build the HTML version of the report.
 */
function buildHtml(siteName, siteUrl, results) {
  const { broken, checked, pagesCrawled, externalChecked, startedAt, finishedAt } = results;
  const scanDate = new Date(startedAt).toUTCString();
  const elapsed = duration(startedAt, finishedAt);

  const statusBadge = broken.length === 0
    ? `<span style="background:#16a34a;color:#fff;padding:3px 10px;border-radius:12px;font-size:13px;">✅ All clear</span>`
    : `<span style="background:#dc2626;color:#fff;padding:3px 10px;border-radius:12px;font-size:13px;">🚨 ${broken.length} broken</span>`;

  let brokenSection = '';
  if (broken.length === 0) {
    brokenSection = `
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:20px;text-align:center;margin:24px 0;">
        <p style="color:#15803d;font-size:16px;margin:0;">✅ No broken links found. Your site is clean!</p>
      </div>`;
  } else {
    const grouped = groupByPage(broken);
    let tableRows = '';
    let rowNum = 0;

    for (const [page, items] of grouped) {
      tableRows += `
        <tr>
          <td colspan="3" style="background:#f1f5f9;padding:8px 12px;font-size:12px;color:#64748b;border-top:2px solid #e2e8f0;">
            Found on: <a href="${page}" style="color:#6366f1;">${page}</a>
          </td>
        </tr>`;
      for (const item of items) {
        const rowBg = rowNum++ % 2 === 0 ? '#fff' : '#fafafa';
        const statusColor = item.status === 'UNREACHABLE' ? '#7c3aed' : '#dc2626';
        const tag = item.external
          ? `<span style="background:#fef9c3;color:#854d0e;font-size:11px;padding:1px 6px;border-radius:4px;">external</span>`
          : `<span style="background:#e0e7ff;color:#3730a3;font-size:11px;padding:1px 6px;border-radius:4px;">internal</span>`;
        tableRows += `
          <tr style="background:${rowBg};">
            <td style="padding:10px 12px;font-size:13px;word-break:break-all;">
              <a href="${item.url}" style="color:#1e293b;">${item.url}</a>
            </td>
            <td style="padding:10px 12px;text-align:center;">${tag}</td>
            <td style="padding:10px 12px;text-align:center;font-weight:600;color:${statusColor};">${item.status}</td>
          </tr>`;
      }
    }

    brokenSection = `
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:collapse;overflow:hidden;margin:24px 0;">
        <thead>
          <tr style="background:#1e293b;">
            <th style="padding:10px 12px;text-align:left;color:#fff;font-size:13px;">Broken URL</th>
            <th style="padding:10px 12px;text-align:center;color:#fff;font-size:13px;width:90px;">Type</th>
            <th style="padding:10px 12px;text-align:center;color:#fff;font-size:13px;width:80px;">Status</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;">

        <!-- Header -->
        <tr>
          <td style="background:#1e293b;padding:24px 32px;">
            <table width="100%"><tr>
              <td><span style="color:#fff;font-size:20px;font-weight:700;">SnitchRoot</span>
                  <span style="color:#94a3b8;font-size:13px;margin-left:8px;">site health report</span></td>
              <td align="right">${statusBadge}</td>
            </tr></table>
          </td>
        </tr>

        <!-- Site summary -->
        <tr>
          <td style="padding:24px 32px 0;">
            <h2 style="margin:0 0 4px;font-size:18px;color:#1e293b;">${siteName}</h2>
            <p style="margin:0 0 16px;font-size:13px;color:#64748b;">
              <a href="${siteUrl}" style="color:#6366f1;">${siteUrl}</a>
            </p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#f1f5f9;border-radius:8px;padding:14px 16px;text-align:center;">
                  <div style="font-size:22px;font-weight:700;color:#1e293b;">${checked}</div>
                  <div style="font-size:12px;color:#64748b;">URLs checked</div>
                </td>
                <td width="12"></td>
                <td style="background:#f1f5f9;border-radius:8px;padding:14px 16px;text-align:center;">
                  <div style="font-size:22px;font-weight:700;color:#1e293b;">${pagesCrawled}</div>
                  <div style="font-size:12px;color:#64748b;">Pages crawled</div>
                </td>
                <td width="12"></td>
                <td style="background:#f1f5f9;border-radius:8px;padding:14px 16px;text-align:center;">
                  <div style="font-size:22px;font-weight:700;color:${broken.length > 0 ? '#dc2626' : '#16a34a'};">${broken.length}</div>
                  <div style="font-size:12px;color:#64748b;">Broken links</div>
                </td>
                <td width="12"></td>
                <td style="background:#f1f5f9;border-radius:8px;padding:14px 16px;text-align:center;">
                  <div style="font-size:22px;font-weight:700;color:#1e293b;">${elapsed}</div>
                  <div style="font-size:12px;color:#64748b;">Scan time</div>
                </td>
              </tr>
            </table>
            <p style="font-size:12px;color:#94a3b8;margin:10px 0 0;">Scanned ${scanDate}</p>
          </td>
        </tr>

        <!-- Broken links -->
        <tr><td style="padding:0 32px 8px;">${brokenSection}</td></tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center;">
            <p style="margin:0 0 8px;font-size:12px;color:#94a3b8;">
              <em>Catches what your website tries to hide.</em>
            </p>
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              <a href="https://app.snitchroot.com" style="color:#6366f1;">Manage your sites</a> &nbsp;·&nbsp;
              <a href="https://app.snitchroot.com/unsubscribe" style="color:#6366f1;">Unsubscribe</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Send a broken-link report email.
 *
 * @param {object} opts
 * @param {string}   opts.to         Recipient email address
 * @param {string}   opts.siteName   Human name for the site, e.g. "My Portfolio"
 * @param {string}   opts.siteUrl    The URL that was scanned
 * @param {object}   opts.results    Return value of crawl()
 * @param {string}  [opts.from]      Sender override; defaults to SMTP_FROM env var
 * @returns {Promise<{messageId: string, previewUrl: string|null}>}
 */
async function sendReport({ to, siteName, siteUrl, results, from }) {
  const transport = await createTransport();
  const fromAddr = from || process.env.SMTP_FROM || 'SnitchRoot <reports@snitchroot.com>';
  const brokenCount = results.broken.length;
  const subject = brokenCount === 0
    ? `✅ ${siteName} — all clear (${results.checked} URLs checked)`
    : `🚨 ${siteName} — ${brokenCount} broken link${brokenCount > 1 ? 's' : ''} found`;

  const info = await transport.sendMail({
    from: fromAddr,
    to,
    subject,
    text: buildText(siteName, siteUrl, results),
    html: buildHtml(siteName, siteUrl, results),
  });

  const previewUrl = nodemailer.getTestMessageUrl(info) || null;
  if (previewUrl) {
    console.log(`📬 Preview email: ${previewUrl}`);
  }

  return { messageId: info.messageId, previewUrl };
}

module.exports = { sendReport, buildHtml, buildText };
