// Server-rendered operations dashboard — a single self-contained HTML page.
// Zero dependencies, zero CDNs: all CSS/JS is inline so it works air-gapped and
// adds nothing to the supply chain. The page is a static shell; live data comes
// from GET /dashboard/data, polled every ~5s by the inline script below.
//
// NOTE: the script deliberately avoids JS template literals so this file can be
// one TS template literal without any escaping games.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kira ledger — live ops</title>
<style>
  :root {
    --bg: #0d1117; --panel: #11161d; --border: #2a313a;
    --text: #c9d1d9; --muted: #8b949e; --head: #e6edf3;
    --green: #3fb950; --red: #f85149; --amber: #d29922; --blue: #58a6ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: var(--bg); color: var(--text);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 16px; margin: 0; color: var(--head); letter-spacing: 1px; }
  h1 .sub { color: var(--muted); font-weight: normal; letter-spacing: 0; }
  #meta { margin-left: auto; color: var(--muted); font-size: 12px; }
  #meta .err { color: var(--red); }
  .badge { padding: 1px 8px; border-radius: 10px; border: 1px solid var(--border); }
  .badge.ok  { color: var(--green); border-color: var(--green); }
  .badge.bad { color: var(--red);   border-color: var(--red); }
  section { background: var(--panel); border: 1px solid var(--border);
            border-radius: 6px; padding: 14px 16px; margin-bottom: 16px; }
  h2 { font-size: 12px; margin: 0 0 10px; color: var(--muted);
       text-transform: uppercase; letter-spacing: 2px; }
  h3 { font-size: 12px; margin: 14px 0 6px; color: var(--blue); font-weight: normal; }
  .tblwrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 12px 4px 0; border-bottom: 1px solid var(--border);
           white-space: nowrap; }
  th { color: var(--muted); font-weight: normal; font-size: 11px; text-transform: uppercase; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); }
  .ok  { color: var(--green); }
  .bad { color: var(--red); font-weight: bold; }
  .st-pending   { color: var(--amber); }
  .st-confirmed { color: var(--green); }
  .st-failed    { color: var(--red); }
  .kind { color: var(--blue); }
  .stats { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
  .stat .v { font-size: 18px; color: var(--head); }
  .stat .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  footer { color: var(--muted); font-size: 11px; margin-top: 8px; }
</style>
</head>
<body>
<header>
  <h1>KIRA LEDGER <span class="sub">/ live operations</span></h1>
  <div id="meta">connecting&hellip;</div>
</header>

<section>
  <h2>Balances &amp; live reconciliation</h2>
  <div id="balances" class="muted">loading&hellip;</div>
  <footer>guard = spend_guards reservation counter (available + pending) &middot;
    ledger &Sigma; = balance derived from SUM(entries) &middot;
    recon asserts guard == ledger &Sigma; on every refresh &middot;
    external mirrors are reconciled against chain truth, not guards</footer>
</section>

<section>
  <h2>Itemized fees</h2>
  <div id="fees" class="muted">loading&hellip;</div>
</section>

<section>
  <h2>Transfers</h2>
  <div id="transfers" class="muted">loading&hellip;</div>
</section>

<section id="sec-routing" hidden>
  <h2>Routing / outbound</h2>
  <div id="routing"></div>
</section>

<noscript>This dashboard needs JavaScript to poll /dashboard/data.</noscript>

<script>
(function () {
  'use strict';

  // Display decimals per currency. Raw integer minor units are always preserved
  // in the cell's title attribute — formatting is presentation only.
  var DP = { USD: 2, USDC: 6, USDT: 6 };

  function esc(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Integer minor units (string) -> grouped decimal string. Pure string math:
  // no parseFloat/Number, so amounts beyond 2^53 render exactly.
  function fmt(minor, currency) {
    if (minor === null || minor === undefined) return '&mdash;';
    var s = String(minor);
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    if (!/^[0-9]+$/.test(s)) return esc(String(minor));
    var dp = Object.prototype.hasOwnProperty.call(DP, currency) ? DP[currency] : 2;
    while (s.length < dp + 1) s = '0' + s;
    var i = s.slice(0, s.length - dp);
    var f = dp > 0 ? '.' + s.slice(s.length - dp) : '';
    i = i.replace(/\\B(?=([0-9]{3})+(?![0-9]))/g, ',');
    return (neg ? '-' : '') + i + f;
  }

  function amountCell(minor, currency, extra) {
    return '<td class="num' + (extra ? ' ' + extra : '') + '" title="' +
      esc(minor) + ' minor units">' + fmt(minor, currency) + '</td>';
  }

  function ts(x) {
    try { return new Date(x).toISOString().replace('T', ' ').slice(0, 19) + 'Z'; }
    catch (e) { return esc(x); }
  }

  function table(headers, rows) {
    var h = '<div class="tblwrap"><table><thead><tr>';
    for (var i = 0; i < headers.length; i++) h += '<th>' + headers[i] + '</th>';
    h += '</tr></thead><tbody>';
    h += rows.length ? rows.join('')
                     : '<tr><td class="muted" colspan="' + headers.length + '">no rows yet</td></tr>';
    return h + '</tbody></table></div>';
  }

  function shortId(id) { return '<span title="' + esc(id) + '">' + esc(String(id).slice(0, 8)) + '</span>'; }

  function renderBalances(rows) {
    var body = rows.map(function (r) {
      var recon;
      if (!r.tracked) recon = '<td class="muted">n/a &middot; chain-recon</td>';
      else if (r.reconOk) recon = '<td class="ok">&#10003; guard == &Sigma;(entries)</td>';
      else recon = '<td class="bad">&#10007; MISMATCH</td>';
      return '<tr><td>' + esc(r.name) + '</td>' +
        '<td class="kind">' + esc(r.kind) + '</td>' +
        '<td>' + esc(r.currency) + '</td>' +
        amountCell(r.available, r.currency) +
        amountCell(r.pending, r.currency) +
        amountCell(r.guardTotal, r.currency) +
        amountCell(r.ledger, r.currency) +
        recon + '</tr>';
    });
    document.getElementById('balances').innerHTML = table(
      ['account', 'kind', 'ccy', 'available', 'pending', 'guard total', 'ledger &Sigma;(entries)', 'recon'],
      body
    );
  }

  function renderFees(fees) {
    var html = '';
    if (fees.totals.length) {
      html += '<div class="stats">' + fees.totals.map(function (t) {
        return '<div class="stat"><div class="v" title="' + esc(t.totalMinor) + ' minor units">' +
          fmt(t.totalMinor, t.currency) + ' ' + esc(t.currency) + '</div>' +
          '<div class="l">' + esc(t.accountName) + ' &middot; ' + esc(t.entryCount) + ' entries</div></div>';
      }).join('') + '</div>';
    }
    html += table(['entry', 'transfer', 'via', 'fee', 'ccy', 'account', 'at'],
      fees.recent.map(function (e) {
        return '<tr><td class="muted">#' + esc(e.entryId) + '</td>' +
          '<td>' + shortId(e.transferId) + '</td>' +
          '<td class="kind">' + esc(e.transferKind) + '</td>' +
          amountCell(e.amountMinor, e.currency) +
          '<td>' + esc(e.currency) + '</td>' +
          '<td>' + esc(e.accountName) + '</td>' +
          '<td class="muted">' + ts(e.createdAt) + '</td></tr>';
      }));
    document.getElementById('fees').innerHTML = html;
  }

  function renderTransfers(rows) {
    document.getElementById('transfers').innerHTML = table(
      ['id', 'kind', 'status', 'gross', 'ccy', 'created'],
      rows.map(function (t) {
        return '<tr><td>' + shortId(t.id) + '</td>' +
          '<td class="kind">' + esc(t.kind) + '</td>' +
          '<td class="st-' + esc(t.status) + '">&#9679; ' + esc(t.status) + '</td>' +
          amountCell(t.grossMinor, t.currency) +
          '<td>' + esc(t.currency || '') + '</td>' +
          '<td class="muted">' + ts(t.createdAt) + '</td></tr>';
      }));
  }

  // Routing tables (migration 004) are rendered generically from whatever
  // columns exist — the section stays hidden until those tables appear.
  function renderRouting(tables) {
    var sec = document.getElementById('sec-routing');
    if (!tables || !tables.length) { sec.hidden = true; return; }
    sec.hidden = false;
    document.getElementById('routing').innerHTML = tables.map(function (t) {
      var heads = t.columns.map(esc);
      var rows = t.rows.map(function (r) {
        return '<tr>' + t.columns.map(function (c) {
          var v = r[c];
          return '<td>' + (v === null || v === undefined ? '<span class="muted">&empty;</span>' : esc(v)) + '</td>';
        }).join('') + '</tr>';
      });
      return '<h3>' + esc(t.table) + '</h3>' + table(heads, rows);
    }).join('');
  }

  function renderMeta(data) {
    var tracked = data.balances.filter(function (b) { return b.tracked; });
    var bad = tracked.filter(function (b) { return !b.reconOk; }).length;
    var badge = bad === 0
      ? '<span class="badge ok">recon &#10003; ' + tracked.length + '/' + tracked.length + '</span>'
      : '<span class="badge bad">recon &#10007; ' + bad + ' mismatch</span>';
    document.getElementById('meta').innerHTML =
      badge + ' &nbsp; refreshed ' + ts(data.generatedAt) + ' &middot; every 5s';
  }

  function refresh() {
    fetch('/dashboard/data')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        renderMeta(data);
        renderBalances(data.balances);
        renderFees(data.fees);
        renderTransfers(data.transfers);
        renderRouting(data.routing);
      })
      .catch(function (err) {
        document.getElementById('meta').innerHTML =
          '<span class="err">refresh failed: ' + esc(err.message) + ' (retrying)</span>';
      });
  }

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`;
