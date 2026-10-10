export const RECONNECT_COPY = "Open ForkFlow once while connected to the internet, then try again.";
export const SUCCESS_COPY = "Payment received. Return to ForkFlow and press Check for renewal.";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
label{display:block;margin-top:1rem;font-weight:600}select,input,button{font:inherit;width:100%;padding:.6rem;margin-top:.25rem;box-sizing:border-box}
button{margin-top:1.5rem;cursor:pointer}[role=alert]{color:#b00020}[role=status]{font-weight:600}`;

// Reads the installation id from the form's data attribute, so nothing user-supplied is ever placed inside script text.
const SCRIPT = `(function(){
var form=document.getElementById("checkout"),button=document.getElementById("pay"),errorBox=document.getElementById("error"),done=document.getElementById("done");
form.addEventListener("submit",async function(event){
event.preventDefault();errorBox.textContent="";button.disabled=true;
try{
var email=form.elements.email.value;
var response=await fetch("/v1/subscriptions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({installationId:form.dataset.installation,plan:form.elements.plan.value,period:form.elements.period.value,email:email})});
if(!response.ok)throw new Error("create failed");
var created=await response.json();
new Razorpay({key:created.keyId,subscription_id:created.subscriptionId,prefill:{email:email},
handler:function(){form.hidden=true;done.hidden=false;},
modal:{ondismiss:function(){button.disabled=false;}}}).open();
}catch(e){errorBox.textContent="Something went wrong starting the payment. Please try again.";button.disabled=false;}
});
})();`;

const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Subscribe to ForkFlow</title><style>${STYLE}</style></head>
<body><main><h1>Subscribe to ForkFlow</h1>
${body}
</main></body></html>`;

export function subscribePage(installationId: string, known: boolean): string {
  if (!known) return page(`<p role="alert">${escapeHtml(RECONNECT_COPY)}</p>`);
  return page(`<form id="checkout" data-installation="${escapeHtml(installationId)}">
<label for="plan">Plan</label>
<select id="plan" name="plan"><option value="basic">Basic</option><option value="pro" selected>Pro</option></select>
<label for="period">Billing period</label>
<select id="period" name="period"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
<label for="email">Email for receipts</label>
<input id="email" name="email" type="email" autocomplete="email" required>
<button id="pay" type="submit">Continue to payment</button>
<p id="error" role="alert"></p>
</form>
<p id="done" role="status" hidden>${escapeHtml(SUCCESS_COPY)}</p>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>${SCRIPT}</script>`);
}
