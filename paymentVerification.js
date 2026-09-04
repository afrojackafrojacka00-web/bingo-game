'use strict';

// ---------------------------------------------------------------------------
// Ethiopian payment verification (CBE + Telebirr)
//
// IMPORTANT: these hit the same public "view my receipt" endpoints the banks'
// own SMS links point to. They are NOT official, documented, or supported
// APIs — CBE / Ethio Telecom can change the URL, the page layout, or start
// blocking automated requests at any time without notice, and Telebirr in
// particular is known to throttle or block requests coming from outside
// Ethiopia (most PaaS hosts — Render, Railway, Vercel, etc. — are outside
// Ethiopia).
//
// Because of that, every function here is designed to FAIL SAFE: if
// anything is uncertain (network error, page didn't parse, amount doesn't
// match, receiver doesn't match), it returns { verified: false, reason }
// instead of throwing, so the caller can fall back to manual admin review
// instead of ever crediting a balance on a guess.
// ---------------------------------------------------------------------------


const { PDFParse } = require('pdf-parse');
const cheerio = require('cheerio');

const FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        const detail = err.cause ? (err.cause.code || err.cause.message || String(err.cause)) : err.message;
        throw new Error(`${err.message} [${detail}]`);
    } finally {
        clearTimeout(timer);
    }
}

function parseAmount(raw) {
    if (!raw) return null;
    const cleaned = String(raw).replace(/[,\sA-Za-z]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
}

function amountsMatch(a, b, tolerance = 0.01) {
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

// ---------------------------------------------------------------------------
// CBE
// ---------------------------------------------------------------------------
// CBE's receipt lookup (the link the "View Receipt" SMS points to) only
// returns a real PDF when the transaction reference is paired with the
// correct last-8-digits of ONE of the two account numbers on the transfer.
// We don't know the sender's account, but we DO know our own receiving CBE
// accounts (the payment_methods table), so we try each active CBE account
// we own — whichever one resolves successfully IS by definition the account
// that got paid. That resolution behavior is what proves the money landed
// in one of our accounts; we don't need a separate receiver check for CBE.

async function fetchCbeReceiptText(transactionRef, accountSuffix8) {
    const id = `${transactionRef}${accountSuffix8}`;
    const url = `https://apps.cbe.com.et:100/?id=${encodeURIComponent(id)}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
    // A failed lookup usually comes back as a small HTML/error page instead
    // of a PDF — PDFParse throws on that, which the caller treats as "no match".
    const parser = new PDFParse({ data: buf });
    try {
        const result = await parser.getText();
        return result.text.replace(/\s+/g, ' ').trim();
    } finally {
        await parser.destroy();
    }
}

function parseCbeText(text) {
    const get = (re) => {
        const m = text.match(re);
        return m ? m[1].trim() : null;
    };
    return {
        // CBE references are consistently 12 chars (e.g. "FT25256K8CHK"); a
        // fixed length avoids the capture group swallowing the next label's
        // text when the PDF has no space between them.
        reference: get(/Reference No\.?\s*\(VAT Invoice No\)\s*([A-Z0-9]{12})/),
        // "Transferred Amount" is what actually lands in our account — NOT
        // "Total amount debited from customers account", which also includes
        // the sender's service fee/VAT.
        amount: parseAmount(get(/Transferred Amount\s*([\d,]+\.\d{2})/i)),
        payer: get(/\bPayer\s*([A-Z .'-]+?)\s*Account/i),
        date: get(/Payment Date\s*&?\s*Time\s*([0-9/,: APM]+?)(?:Reference|$)/i)
    };
}

/**
 * @param {string} transactionId       Reference the user typed, e.g. "FT26093JCD32"
 * @param {number} expectedAmount      Amount the user says they sent
 * @param {string[]} ourAccountNumbers Full CBE account numbers from payment_methods
 */
async function verifyCbeDeposit({ transactionId, expectedAmount, ourAccountNumbers, ourTelebirrNumbers = [] }) {
    const ref = String(transactionId).trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9]{8,20}$/.test(ref)) {
        return { verified: false, reason: "That doesn't look like a valid CBE transaction reference." };
    }
        const suffixSources = [...(ourAccountNumbers || []), ...ourTelebirrNumbers];
    if (!suffixSources.length) {
        return { verified: false, reason: 'No active accounts are configured to verify against.' };
    }

    const attempts = [];
    for (const accountNumber of suffixSources) {
        const suffix = String(accountNumber).replace(/\D/g, '').slice(-8);
        if (suffix.length < 8) continue;
        try {
            const text = await fetchCbeReceiptText(ref, suffix);
            const parsed = parseCbeText(text);
            if (!parsed.amount) {
                attempts.push(`${suffix}: receipt page did not contain a readable amount`);
                continue;
            }
            if (!amountsMatch(parsed.amount, Number(expectedAmount))) {
                return {
                    verified: false,
                    reason: `CBE receipt found, but the amount on it is ${parsed.amount} ETB, not the ${expectedAmount} ETB entered.`,
                    parsed
                };
            }
            return { verified: true, parsed, matchedAccount: accountNumber };
        } catch (err) {
            attempts.push(`${suffix}: ${err.message}`);
        }
    }
    return {
        verified: false,
        reason: `Could not find a matching CBE receipt for reference ${ref}. (${attempts.join('; ')})`
    };
}

// ---------------------------------------------------------------------------
// Telebirr
// ---------------------------------------------------------------------------
// Telebirr's receipt page is plain HTML, not a documented API, its layout is
// known to vary by transaction type (wallet-to-wallet vs. wallet-to-bank),
// and it appears to block/slow requests from outside Ethiopia. Treat this as
// the least reliable of the two — expect it to fall back to manual review
// more often than CBE, and re-test the label list below against a real
// receipt if it stops matching.

async function fetchTelebirrReceiptHtml(transactionId) {
    const url = `https://transactioninfo.ethiotelecom.et/receipt/${encodeURIComponent(transactionId)}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
}

function parseTelebirrHtml(html) {
    const $ = cheerio.load(html);
    // Collect every visible text node rather than relying on exact CSS
    // selectors/classes, since Telebirr's markup differs by transfer type
    // and changes over time. Receipts render as label/value pairs in one of
    // two shapes: "Label: Value" inside a single cell, or "Label" and
    // "Value" as two consecutive cells — findValue() below handles both.
    const rows = [];
    $('td, th, div, span, li, p').each((_, el) => {
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        if (t) rows.push(t);
    });

    const normalize = (s) => s.toLowerCase().replace(/[:\-]+$/, '').trim();

    const findValue = (labels) => {
        const normLabels = labels.map(normalize);
        for (let i = 0; i < rows.length; i++) {
            for (const label of labels) {
                const m = rows[i].match(new RegExp('^' + label + '\\s*[:\\-]\\s*(.+)$', 'i'));
                if (m && m[1].trim()) return m[1].trim();
            }
            if (normLabels.includes(normalize(rows[i])) && rows[i + 1]) return rows[i + 1];
        }
        return null;
    };

    const amountRaw = findValue(['Settled Amount', 'Total Paid Amount', 'Transaction Amount', 'Amount']);
    const status = findValue(['Transaction Status', 'Status']);
    const receiverName = findValue(['Receiver Name', 'Credited Party name', 'Credited Party Name', 'Receiver']);
    const receiverPhone = findValue(['Receiver Phone', 'Credited Party Account', 'To Account']);

    return { amount: parseAmount(amountRaw), status, receiverName, receiverPhone, fullText: rows.join(' | ') };
}

/**
 * @param {string} transactionId
 * @param {number} expectedAmount
 * @param {{number:string,name:string}[]} ourAccounts  active telebirr payment_methods rows
 */
async function verifyTelebirrDeposit({ transactionId, expectedAmount, ourAccounts, ourCbeAccounts = [] }) {
    const ref = String(transactionId).trim();
    if (!/^[A-Za-z0-9]{6,20}$/.test(ref)) {
        return { verified: false, reason: "That doesn't look like a valid Telebirr transaction number." };
    }

    let html;
    try {
        html = await fetchTelebirrReceiptHtml(ref);
    } catch (err) {
        return {
            verified: false,
            reason: `Could not reach Telebirr to verify (${err.message}). This can happen if the server hosting this app is outside Ethiopia.`
        };
    }

    const parsed = parseTelebirrHtml(html);
    if (!parsed.amount) {
        return { verified: false, reason: 'Could not read an amount off the Telebirr receipt page — the page layout may have changed.', parsed };
    }
    if (parsed.status && !/complete|success/i.test(parsed.status)) {
        return { verified: false, reason: `Telebirr shows this transaction as "${parsed.status}", not completed.`, parsed };
    }
    if (!amountsMatch(parsed.amount, Number(expectedAmount))) {
        return { verified: false, reason: `Telebirr receipt found, but the amount on it is ${parsed.amount} ETB, not the ${expectedAmount} ETB entered.`, parsed };
    }

    // Confirm the money actually landed in one of OUR numbers — otherwise a
    // user could submit the reference of any real Telebirr transaction (say,
    // a payment to a friend) as long as the amount happens to match.
        const targets = (ourAccounts || []).map(a => ({
        number: String(a.number).replace(/\D/g, '').slice(-9),
        name: String(a.name).toLowerCase()
    })).concat((ourCbeAccounts || []).map(a => ({
        number: String(a.number).replace(/\D/g, '').slice(-8),
        name: String(a.name).toLowerCase()
    })));
    const receiverPhoneDigits = parsed.receiverPhone ? String(parsed.receiverPhone).replace(/\D/g, '').slice(-9) : '';
    const receiverNameLower = (parsed.receiverName || '').toLowerCase();

    const matchesUs = targets.some(t =>
        (receiverPhoneDigits && t.number && receiverPhoneDigits === t.number) ||
        (t.name && receiverNameLower && receiverNameLower.includes(t.name))
    );

    if (!matchesUs) {
        return {
            verified: false,
            reason: `Telebirr receipt found, but the receiver ("${parsed.receiverName || parsed.receiverPhone || 'unknown'}") doesn't match any configured Telebirr account.`,
            parsed
        };
    }

    return { verified: true, parsed };
}

async function verifyDeposit({ transactionId, expectedAmount, cbeAccounts = [], telebirrAccounts = [] }) {
    const [cbeResult, tbResult] = await Promise.all([
        verifyCbeDeposit({
            transactionId, expectedAmount,
            ourAccountNumbers: cbeAccounts.map(a => a.number),
            ourTelebirrNumbers: telebirrAccounts.map(a => a.number)
        }),
        verifyTelebirrDeposit({
            transactionId, expectedAmount,
            ourAccounts: telebirrAccounts,
            ourCbeAccounts: cbeAccounts
        })
    ]);
    if (cbeResult.verified) return cbeResult;
    if (tbResult.verified) return tbResult;
    return { verified: false, reason: `Not verified on CBE (${cbeResult.reason}) or Telebirr (${tbResult.reason}).` };
}

module.exports = { verifyCbeDeposit, verifyTelebirrDeposit, verifyDeposit };