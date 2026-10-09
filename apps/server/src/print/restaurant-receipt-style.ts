/** Compact restaurant receipt, inspired by a conventional counter bill.
 * System fonts and inline styles keep preview/PDF printing entirely offline.
 * Credit notes retain their own A4 stylesheet.
 */
export const RESTAURANT_RECEIPT_CSS = `
  @page{size:A4 portrait;margin:14mm;
    @bottom-right{content:"Page " counter(page) " of " counter(pages);font:9px Arial,sans-serif;color:#555}
  }
  *{box-sizing:border-box}
  body{margin:0;background:#f1f2f4;color:#111;font:14px/1.4 "Lucida Console","Courier New",monospace;font-variant-numeric:tabular-nums}
  .bill{width:100%;max-width:440px;margin:24px auto;padding:16px 18px;background:#fff;border:1px solid #e0e0e0}
  p,h1,h2,dl,dd{margin:0}
  .bill-header{text-align:center;overflow-wrap:anywhere}
  h1{font-size:20px;line-height:1.15;text-transform:uppercase;letter-spacing:.2px;margin-bottom:5px}
  .address{white-space:pre-wrap}
  .registration span{display:block}
  .bill-header h2{margin:20px 0 24px;font-size:15px;letter-spacing:.4px}
  .supply-note{display:block;margin-top:5px;font-size:10px;font-weight:400;line-height:1.35;font-style:normal;letter-spacing:0;text-transform:none}
  .bill-meta>div{display:flex;align-items:baseline;gap:8px;min-width:0;margin:2px 0}
  .bill-meta dt{flex:0 0 auto}.bill-meta dt::after{content:" :"}
  .bill-meta dd{flex:1;min-width:0;overflow-wrap:anywhere}
  .bill-meta .date{margin-bottom:12px}
  .status{float:right;font-size:11px;font-weight:700;line-height:1.8}
  .currency-note{text-align:right;font-size:10px;margin:10px 0 4px}
  table{width:100%;border-collapse:collapse;table-layout:fixed}
  th,td{vertical-align:top;text-align:right;overflow-wrap:anywhere}
  .items th{border-block:1px dotted #555;padding:6px 0;font-size:14px}
  .items td{padding:6px 0;font-size:14px}
  .items th:first-child,.items td:first-child{width:45%;text-align:left;padding-right:10px}
  .items th:nth-child(2),.items td:nth-child(2){width:9%}
  .items th:nth-child(3),.items td:nth-child(3){width:22%;padding-inline:5px}
  .items th:last-child,.items td:last-child{width:24%}
  .items tbody tr:last-child td{padding-bottom:10px}
  .totals td{padding:3px 0}.totals td:first-child{width:60%;text-align:left;padding-right:10px}
  .totals .subtotal td{border-top:1px dotted #555;padding-top:7px;padding-bottom:7px;font-weight:700}
  .quantity{font-size:11px;font-weight:400;margin-left:8px;white-space:nowrap}
  .totals .tax-note{padding:6px 0 3px;font-size:10px}
  .taxable td,.tax td{font-size:11px}.tax small{font-size:inherit}
  .totals .grand-total td{padding:9px 0;border-block:2px dotted #555;font-size:19px;font-weight:700;vertical-align:middle}
  .totals .grand-total td:first-child{width:auto;font-size:16px}
  .payments{padding-top:8px}.payments dl>div{display:flex;justify-content:space-between;gap:12px;margin:3px 0}
  .payments dt{min-width:0;overflow-wrap:anywhere}.payments dd{text-align:right;overflow-wrap:anywhere}
  .payment-state{text-align:right;font-size:12px;margin-top:9px;overflow-wrap:anywhere}
  .tax-note,.discount-note{font-size:10px}.discount-note{margin-top:10px;overflow-wrap:anywhere}
  .upi-payment{text-align:center;margin-top:16px;padding-top:12px;border-top:1px dotted #555;break-inside:avoid}
  .upi-payment h2{font-size:13px}.upi-amount{font-size:19px;font-weight:700}
  .upi-qr{width:38mm;max-width:100%;margin:6px auto;background:#fff}.upi-qr svg{display:block;width:100%;height:auto}
  .upi-id{font-size:12px;overflow-wrap:anywhere}
  footer{margin-top:16px;padding-top:12px;border-top:1px dotted #555;text-align:center;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
  .summary,.payments,footer,.bill-header,.bill-meta,tr{break-inside:avoid}
  thead{display:table-header-group}
  /* Each style uses the same financial markup and locally available fonts. */
  .bill--modern{font-family:Arial,Helvetica,sans-serif;line-height:1.45}
  .bill--modern .bill-header{text-align:left;border-top:5px solid #111;padding-top:14px}
  .bill--modern h1{font-size:27px;letter-spacing:-.8px;text-transform:none;line-height:1.05;margin-bottom:10px}
  .bill--modern .address,.bill--modern .registration{font-size:12px}
  .bill--modern .bill-header h2{font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:18px 0 16px;padding-top:12px;border-top:1px solid #111}
  .bill--modern .bill-meta{font-size:12px}.bill--modern .bill-meta .date{margin-bottom:6px}
  .bill--modern .bill-meta dt{width:92px;font-weight:700}.bill--modern .bill-meta dt::after{content:""}
  .bill--modern .status{font-size:10px;letter-spacing:.4px}
  .bill--modern .items th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-block:2px solid #111;padding:9px 0}
  .bill--modern .items td{padding:9px 0;border-bottom:1px solid #ddd}
  .bill--modern .totals .subtotal td{border-top:1px solid #111}
  .bill--modern .totals .grand-total td{border-block:3px solid #111;font-size:25px;padding:10px 0;letter-spacing:-.6px}
  .bill--modern .totals .grand-total td:first-child{font-size:14px;letter-spacing:1px}
  .bill--modern footer,.bill--modern .upi-payment{border-top:1px solid #111}

  .bill--heritage{font-family:Georgia,"Times New Roman",serif;font-size:15px;line-height:1.4}
  .bill--heritage .bill-header{border-top:4px double #111;padding-top:16px}
  .bill--heritage h1{font-size:28px;text-transform:none;font-weight:400;letter-spacing:-.5px;line-height:1.1;margin-bottom:9px}
  .bill--heritage .address{font-size:13px}.bill--heritage .registration{font:10px/1.6 Arial,sans-serif;margin-top:6px;letter-spacing:.3px}
  .bill--heritage .bill-header h2{font-size:14px;font-style:italic;font-weight:400;letter-spacing:1px;border-block:4px double #111;margin:17px 0;padding:7px 0}
  .bill--heritage .bill-meta{font-size:13px}.bill--heritage .bill-meta .date{margin-bottom:6px}
  .bill--heritage .bill-meta dt{font-style:italic}.bill--heritage .status{font:700 10px/1.8 Arial,sans-serif}
  .bill--heritage .items th{font-size:13px;font-style:italic;border-block:1px solid #111}
  .bill--heritage .items td{font-size:14px;padding:7px 0}
  /* Georgia only has old-style figures; amounts, quantities and dates use lining figures so they read cleanly. */
  .bill--heritage .items td:not(:first-child),.bill--heritage .totals td,.bill--heritage .bill-meta dd,.bill--heritage .upi-amount{font-family:"Times New Roman",Times,serif;font-variant-numeric:lining-nums tabular-nums}
  .bill--heritage .totals .subtotal td{border-top:1px solid #111}
  .bill--heritage .totals .grand-total td{border-block:4px double #111;font-size:23px;font-weight:400;padding:9px 0}
  .bill--heritage .totals .grand-total td:first-child{font-size:15px;letter-spacing:1px}
  .bill--heritage .payment-state{font:700 11px/1.5 Arial,sans-serif;letter-spacing:.5px}
  .bill--heritage footer{font-style:italic;border-top:4px double #111;font-size:13px}
  .bill--heritage .upi-payment{border-top:1px solid #111}

  .bill--compact{font-family:Tahoma,Verdana,Arial,sans-serif;font-size:12px;line-height:1.3}
  .bill--compact .bill-header{text-align:left}
  .bill--compact h1{font-size:19px;letter-spacing:-.4px;margin-bottom:5px}
  .bill--compact .address,.bill--compact .registration{font-size:11px}
  .bill--compact .bill-header h2{font-size:10px;text-transform:uppercase;letter-spacing:1px;margin:9px 0;padding:6px 0;border-block:1px solid #111}
  .bill--compact .bill-meta{font-size:11px}.bill--compact .bill-meta .date{margin-bottom:2px}
  .bill--compact .bill-meta dt{font-weight:700}.bill--compact .status{font-size:9px}
  .bill--compact .currency-note{font-size:9px;margin:7px 0 3px}
  .bill--compact .items th{font-size:11px;border-block:1px solid #111;padding:4px 0}
  .bill--compact .items td{font-size:12px;padding:4px 0}
  .bill--compact .items tbody tr:last-child td{padding-bottom:6px}
  .bill--compact .totals td{padding:2px 0}
  .bill--compact .totals .subtotal td{padding:5px 0;border-top:1px solid #111}
  .bill--compact .totals .grand-total td{border-block:2px solid #111;padding:6px 0;font-size:19px}
  .bill--compact .totals .grand-total td:first-child{font-size:13px}
  .bill--compact .payments{padding-top:4px}.bill--compact .payment-state{font-size:11px;margin-top:5px}
  .bill--compact footer{font-size:10px;margin-top:10px;padding-top:8px;border-top:1px solid #111}
  .bill--compact .discount-note{margin-top:7px}.bill--compact .upi-payment{margin-top:10px;padding-top:8px;border-top:1px solid #111}
  @media screen and (max-width:480px){
    body{background:#fff}.bill{margin:0 auto;padding:20px 12px;border:0}
  }
  @media screen and (max-width:360px){
    body{font-size:12px}.items th,.items td{font-size:12px}.items th:first-child,.items td:first-child{width:32%;padding-right:6px}
    .items th:nth-child(2),.items td:nth-child(2){width:10%}
    .items th:nth-child(3),.items td:nth-child(3){width:28%;padding-inline:3px}.items th:last-child,.items td:last-child{width:30%}
    .totals .grand-total td{font-size:16px}
  }
  @media print{
    body{background:#fff}.bill{margin:0 auto;padding:0;max-width:110mm;border:0}
  }
`;
