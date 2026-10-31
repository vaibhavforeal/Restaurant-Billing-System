// The owner control panel's page. The script and styles are served from /owner/app.js and /owner/app.css so the page can run
// under a strict Content-Security-Policy (no inline script or style). Restaurant data is only ever inserted as text nodes.

export const ownerPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MasalaPOS owner panel</title><link rel="stylesheet" href="/owner/app.css"></head>
<body><header><h1>MasalaPOS owner panel</h1><button id="logout" type="button" hidden>Sign out</button></header>
<main id="app"><p>Loading…</p></main>
<script src="/owner/app.js"></script></body></html>`;

export const OWNER_STYLE = `
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,sans-serif;color:#1d1c1a;background:#f5f4f1}
header{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:#1d1c1a;color:#fff}
header h1{font-size:18px;margin:0}main{max-width:1100px;margin:0 auto;padding:20px}
button,input,select{font:inherit}button{cursor:pointer;padding:6px 12px;border:1px solid #c9c4bb;border-radius:6px;background:#fff}
button.primary{background:#1d1c1a;color:#fff;border-color:#1d1c1a}button:disabled{opacity:.5;cursor:default}
input,select{padding:6px 8px;border:1px solid #c9c4bb;border-radius:6px;background:#fff}
.login{max-width:360px;margin:40px auto;display:grid;gap:10px;background:#fff;padding:24px;border-radius:10px}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:16px}.toolbar input{flex:1}
.card{background:#fff;border-radius:10px;padding:16px;margin-bottom:16px;box-shadow:0 1px 3px rgb(0 0 0/6%)}
.card-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}.card-head input{min-width:220px;font-weight:600}
.meta{color:#6b665f;font-size:13px}.badge{padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#ece9e3}
.badge.ok{background:#e3f4e8;color:#1e6b3a}.badge.warn{background:#fdf1dc;color:#8a5a00}.badge.bad{background:#fbe3e5;color:#9b1c2a}
table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #eee;vertical-align:middle}
th.group{padding-top:12px;color:#6b665f;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td.state{font-weight:600}td.state.on{color:#1e6b3a}td.state.off{color:#9b1c2a}
.actions{display:flex;gap:8px;align-items:center;margin-top:12px}[role=alert]{color:#9b1c2a}[role=status]{color:#1e6b3a}
details{margin-top:10px}details li{font-size:13px}`;

export const OWNER_SCRIPT = `(function(){
"use strict";
var app=document.getElementById("app"),logoutButton=document.getElementById("logout"),data=null,query="",notices={};
var GROUPS=[["addon","Add-ons"],["service","Service modules"],["backoffice","Back-office modules"]];
function el(tag,text,cls){var n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n}
function day(ms){return ms?new Date(ms).toLocaleDateString():"—"}
async function api(path,method,body){
  var res=await fetch(path,{method:method||"GET",headers:body?{"content-type":"application/json"}:{},body:body?JSON.stringify(body):undefined,credentials:"same-origin"});
  var json=await res.json().catch(function(){return{}});
  if(res.status===401&&path!=="/owner/api/login"){showLogin();throw new Error("Sign in again")}
  if(!res.ok)throw new Error(json.error||"Request failed");return json}
function showLogin(message){
  logoutButton.hidden=true;app.replaceChildren();
  var form=el("form",null,"login"),label=el("label","Owner password"),input=el("input"),button=el("button","Sign in","primary"),error=el("p");
  input.type="password";input.autocomplete="current-password";input.required=true;label.append(input);error.setAttribute("role","alert");if(message)error.textContent=message;
  form.append(el("h2","Sign in"),label,button,error);app.append(form);input.focus();
  form.addEventListener("submit",async function(e){e.preventDefault();button.disabled=true;error.textContent="";
    try{await api("/owner/api/login","POST",{password:input.value});await load()}catch(err){error.textContent=err.message;button.disabled=false}});
}
async function load(){data=await api("/owner/api/restaurants");logoutButton.hidden=false;render()}
function render(){
  app.replaceChildren();
  var bar=el("div",null,"toolbar"),search=el("input"),count=el("span",null,"meta");
  search.type="search";search.placeholder="Search by name, email or installation id";search.value=query;
  search.addEventListener("input",function(){query=search.value;renderList(list,count)});
  bar.append(search,count);var list=el("div");app.append(bar,list);renderList(list,count);
}
function renderList(list,count){
  var q=query.trim().toLowerCase();
  var shown=data.restaurants.filter(function(r){return!q||[r.displayName,r.contactEmail,r.installationId].some(function(v){return v&&v.toLowerCase().indexOf(q)>=0})});
  count.textContent=shown.length+" of "+data.restaurants.length+" restaurants";list.replaceChildren();
  if(!data.restaurants.length)list.append(el("p","No restaurants yet. A restaurant appears here the first time its MasalaPOS connects.","meta"));
  shown.forEach(function(r){list.append(card(r))});
}
function licenceBadge(l){
  if(!l)return el("span","No licence yet","badge");
  var b=el("span",(l.plan==="pro"?"Pro":"Basic")+(l.trial?" trial":"")+" · "+(l.state==="active"?"active until "+day(l.expiresAt):l.state==="grace"?"in grace until "+day(l.graceUntil):"expired "+day(l.graceUntil)),"badge "+(l.state==="active"?"ok":l.state==="grace"?"warn":"bad"));
  return b}
function card(r){
  var box=el("section",null,"card"),head=el("div",null,"card-head"),name=el("input");
  name.value=r.displayName||"";name.placeholder="Restaurant name";name.setAttribute("aria-label","Restaurant name");
  head.append(name,licenceBadge(r.licence));
  if(r.licence)head.append(el("span",r.licence.delivered?"Restaurant has the latest settings":"Waiting for the restaurant to check in (revision "+r.licence.revision+")","badge "+(r.licence.delivered?"ok":"warn")));
  box.append(head,el("p",(r.contactEmail||"No email")+" · installation "+r.installationId+" · joined "+day(r.createdAt),"meta"));
  var plan=r.licence?r.licence.plan:"pro",table=el("table"),selects={};
  var tr=el("tr");["Module","In "+(plan==="pro"?"Pro":"Basic")+" plan","Owner decision","Result"].forEach(function(h){tr.append(el("th",h))});table.append(tr);
  GROUPS.forEach(function(g){
    var gr=el("tr"),gh=el("th",g[1],"group");gh.colSpan=4;gr.append(gh);table.append(gr);
    data.modules.filter(function(m){return m.group===g[0]}).forEach(function(m){
      var row=el("tr"),nameCell=el("td"),sel=el("select"),result=el("td",null,"state");
      nameCell.append(el("strong",m.name));if(m.dependsOn.length)nameCell.append(el("div","Needs "+m.dependsOn.map(function(d){var x=data.modules.find(function(y){return y.id===d});return x?x.name:d}).join(", "),"meta"));
      [["","Follow the plan"],["allow","Allow"],["block","Block"]].forEach(function(o){var op=el("option",o[1]);op.value=o[0];sel.append(op)});
      sel.value=r.overrides[m.id]===true?"allow":r.overrides[m.id]===false?"block":"";sel.setAttribute("aria-label",m.name+" for "+(r.displayName||r.installationId));
      function show(){var on=sel.value==="allow"||(sel.value===""&&m.plans[plan]);result.textContent=on?"Allowed":"Not allowed";result.className="state "+(on?"on":"off")}
      sel.addEventListener("change",show);show();selects[m.id]=sel;
      row.append(nameCell,el("td",m.plans[plan]?"Included":"Not included"),(function(){var td=el("td");td.append(sel);return td})(),result);table.append(row);
    });
  });
  box.append(table);
  var actions=el("div",null,"actions"),save=el("button","Save","primary"),status=el("span");status.setAttribute("role","status");
  if(notices[r.installationId])status.textContent=notices[r.installationId];actions.append(save,status);box.append(actions);
  save.addEventListener("click",async function(){
    var modules={};Object.keys(selects).forEach(function(id){var v=selects[id].value,next=v==="allow"?true:v==="block"?false:null,before=r.overrides[id]===undefined?null:r.overrides[id];if(next!==before)modules[id]=next});
    save.disabled=true;delete notices[r.installationId];status.setAttribute("role","status");status.textContent="Saving…";
    try{var out=await api("/owner/api/restaurants/"+r.installationId,"PATCH",{displayName:name.value.trim()||null,modules:modules,expectedUpdatedAt:r.updatedAt});
      notices[r.installationId]=out.issuedRevision?"Saved. Licence revision "+out.issuedRevision+" is ready; the restaurant gets it within an hour, or straight away when they press Check now.":Object.keys(modules).length?"Saved. The restaurant has no current licence, so its next licence will include this.":"Saved.";
      data.restaurants[data.restaurants.indexOf(r)]=out.restaurant;render();
    }catch(err){status.setAttribute("role","alert");status.textContent=err.message;save.disabled=false}
  });
  var history=el("details");history.append(el("summary","Change history"));
  history.addEventListener("toggle",async function(){if(!history.open||history.dataset.loaded)return;
    try{var out=await api("/owner/api/restaurants/"+r.installationId+"/events");var ul=el("ul");
      out.events.forEach(function(e){var m=data.modules.find(function(x){return x.id===e.moduleId});ul.append(el("li",new Date(e.at).toLocaleString()+" · "+(m?m.name:e.moduleId)+": "+(e.allowed===null?"follow the plan":e.allowed?"allowed":"blocked")+(e.revision?" · licence revision "+e.revision:"")))});
      if(!out.events.length)ul.append(el("li","No changes yet."));history.append(ul);history.dataset.loaded="1"}catch(err){history.append(el("p",err.message))}});
  box.append(history);return box;
}
logoutButton.addEventListener("click",async function(){try{await api("/owner/api/logout","POST",{})}catch(e){}showLogin()});
load().catch(function(err){if(err.message!=="Sign in again")showLogin(err.message)});
})();`;
