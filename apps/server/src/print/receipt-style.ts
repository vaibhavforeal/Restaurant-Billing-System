/** Self-contained: receipts print offline without loading fonts, images or scripts. */
export const RECEIPT_CSS = `
  @page{size:A4 portrait;margin:14mm;
    @bottom-right{content:"Page " counter(page) " of " counter(pages);font:9px Arial,sans-serif;color:#71717a}
  }
  *{box-sizing:border-box}
  body{margin:0;background:#f1f2f4;color:#18181b;font:14px/1.5 Arial,Helvetica,sans-serif;font-variant-numeric:tabular-nums}
  .bill{max-width:780px;margin:24px auto;padding:36px 40px;background:#fff;border:1px solid #dedee2;box-shadow:0 4px 24px #18181b08}
  .bill-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;padding-bottom:24px;border-bottom:3px solid #18181b}
  h1{font-size:29px;line-height:1.15;letter-spacing:-.7px;margin:0 0 10px;overflow-wrap:anywhere}
  p{margin:0}.address{white-space:pre-wrap;font-size:12px;color:#52525b;overflow-wrap:anywhere}
  .registration{display:flex;flex-wrap:wrap;gap:4px 18px;margin-top:12px;font-size:11px;overflow-wrap:anywhere}
  .bill-identity{text-align:right;min-width:120px}
  .eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:1.8px;color:#52525b;font-weight:700}
  .bill-number{font-size:22px;font-weight:700;margin:5px 0 9px;line-height:1.2}
  .status{display:inline-block;border:1px solid #18181b;border-radius:3px;padding:3px 9px;font-size:10px;font-weight:700;letter-spacing:1px}
  .bill-meta{display:grid;grid-template-columns:1.35fr 1fr 1fr;gap:16px;margin:0;padding:18px 0;border-bottom:1px solid #d4d4d8}
  .bill-meta div{min-width:0}.bill-meta dt{font-size:10px;color:#71717a;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
  .bill-meta dd{margin:0;font-size:12px;font-weight:600;overflow-wrap:anywhere}
  table{width:100%;border-collapse:collapse}th,td{text-align:right;vertical-align:top}th{font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}
  .items{margin-top:18px;table-layout:fixed}.items th{padding:10px 0;border-block:1px solid #18181b}
  .items td{padding:13px 0;border-bottom:1px solid #e4e4e7;font-size:12px}
  .items th:first-child,.items td:first-child{width:5%;text-align:left;color:#71717a}
  .items th:nth-child(2),.items td:nth-child(2){width:44%;text-align:left;padding-right:12px;overflow-wrap:anywhere}
  .items th:nth-child(3),.items td:nth-child(3){width:9%}
  .items th:nth-child(4),.items td:nth-child(4){width:20%;padding-inline:8px}
  .items th:last-child,.items td:last-child{width:22%}
  .item-name{font-weight:600}.item-tax{display:block;color:#71717a;font-size:10px;margin-top:3px}.amount{white-space:nowrap}
  .item-count{display:flex;justify-content:space-between;gap:12px;padding:9px 0;font-size:10px;color:#52525b}
  .summary{display:grid;grid-template-columns:minmax(0,1fr) minmax(230px,.9fr);gap:36px;margin-top:22px;align-items:start}
  .section-title{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;margin:0 0 12px}
  .taxes{font-size:11px}.taxes th{font-size:9px;padding:7px 0;border-bottom:1px solid #a1a1aa;letter-spacing:0}
  .taxes td{padding:8px 0;border-bottom:1px solid #e4e4e7}.taxes th:first-child,.taxes td:first-child{text-align:left}
  .tax-note{font-size:10px;color:#52525b;margin-top:9px}
  .totals td{padding:5px 0;font-size:12px}.totals td:first-child{text-align:left;padding-right:12px;color:#52525b}
  .totals .grand-total td{padding:14px 0 12px;border-block:2px solid #18181b;font-size:23px;font-weight:700;color:#18181b;vertical-align:middle}
  .totals .grand-total td:first-child{font-size:12px;text-transform:uppercase;letter-spacing:1px}
  .discount-note{font-size:10px;color:#52525b;margin-top:10px;overflow-wrap:anywhere}
  .payments{margin-top:26px;padding-top:16px;border-top:1px solid #d4d4d8;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:start}
  .payment-methods{display:flex;flex-wrap:wrap;gap:7px 18px;font-size:12px}.payment-methods span{white-space:nowrap}.payment-methods b{font-size:10px;letter-spacing:.4px;margin-right:6px}
  .payment-state{text-align:right}.payment-state strong{display:block;font-size:12px}.payment-state span{font-size:11px;color:#52525b}
  .upi-payment{display:flex;align-items:center;gap:20px;margin-top:20px;padding-top:16px;border-top:1px solid #d4d4d8;break-inside:avoid}
  .upi-qr{width:38mm;flex:0 0 38mm;background:#fff}.upi-qr svg{display:block;width:100%;height:auto}
  .upi-payment>div:last-child{min-width:0;overflow-wrap:anywhere}.upi-payment .section-title{margin-bottom:5px}
  .upi-amount{font-size:22px;font-weight:700}.upi-id{font-size:12px}
  footer{margin-top:28px;border-top:1px dashed #a1a1aa;padding-top:18px;text-align:center;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
  .summary,.payments,footer,.bill-header,.bill-meta,tr{break-inside:avoid}thead{display:table-header-group}
  @media screen and (max-width:600px){
    body{background:#fff}.bill{margin:0;padding:22px 16px;border:0;box-shadow:none}
    .bill-header{gap:16px;padding-bottom:18px}h1{font-size:23px}.bill-number{font-size:19px}.bill-identity{min-width:100px}
    .bill-meta{gap:10px;grid-template-columns:1.3fr 1fr}.bill-meta div:last-child{grid-column:1/-1}
    .items td{font-size:11px}.items th{font-size:9px}.items th:nth-child(2),.items td:nth-child(2){padding-right:6px}
    .items th:nth-child(4),.items td:nth-child(4){padding-inline:3px}
    .summary{grid-template-columns:minmax(0,1fr);gap:22px}.totals .grand-total td{font-size:24px}.totals .grand-total td:first-child{font-size:12px}
    .payments{gap:14px}.registration{display:grid;gap:4px}
  }
  @media print{
    body{background:#fff;font-size:10pt}.bill{margin:0;padding:0;max-width:none;border:0;box-shadow:none}
    h1{font-size:25pt}.items td{padding:10px 0}.summary{margin-top:18px}.status{color:#000}
  }
`;
