const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/pdf-BgXZH-bt.js","assets/vendor-CZK9ZUC8.js"])))=>i.map(i=>d[i]);
import{_ as pt}from"./vendor-CZK9ZUC8.js";import{a as O,k as ut,m as H}from"./index-DlySs6zn.js";import"./alert-AlKuj1Cq.js";import"./ui-TmT_FclV.js";const V={paperSize:"80",copies:1,showLogo:!0,showBusinessName:!0,showAddress:!0,showPhone:!0,showEmail:!1,showTin:!0,showVrn:!0,showSerial:!1,showCashier:!0,showCustomer:!0,showCustomerPhone:!0,showDiscount:!0,showPaymentMethod:!0,showTax:!1,taxRate:18,showFooter:!0,showPoweredBy:!0,headerText:"",footerText:"Asante kwa kununua. Karibu tena!",website:"",social:""},ht={receiptTitle:"RISITI",receiptNo:"Namba ya Risiti",date:"Tarehe",cashier:"Muuzaji",customer:"Mteja",phone:"Simu",item:"BIDHAA",qty:"IDADI",price:"BEI",amount:"JUMLA",subtotal:"Jumla",discount:"Punguzo",netOfTax:"Bila VAT",vat:"VAT",totalInclVat:"JUMLA (pamoja na VAT)",grandTotal:"JUMLA KUU",payment:"Malipo",paid:"Imelipwa",balance:"DENI LA SALIO",change:"Chenji",dueDate:"Tarehe ya Malipo",bank:"Benki",reference:"Kumbukumbu",notes:"Maelezo",reprint:"*** MARA YA PILI — REPRINT ***",thankYou:"ASANTE KWA KUNUNUA",welcomeAgain:"KARIBU TENA",poweredBy:"Imewekwa na",offline:"RISITI YA OFFLINE — namba itatolewa mtandaoni",items:"bidhaa"},ft={en:H,sw:ut};function k(t,a){let n="sw";try{n=localStorage.getItem("app_lang")||"sw"}catch{}return(ft[n]||H)[t]||H[t]||a||t}function R(t,a){const n={...ht};for(const e of Object.keys(n))n[e]=k(`receipt.${e}`,n[e]);if(typeof a!="function")return n;for(const e of Object.keys(n)){const o=a(`receipt.${e}`);o&&o!==`receipt.${e}`&&(n[e]=o)}return n}function A(t){const a={...V,...t||{}};return a.paperSize=a.paperSize==="58"?"58":"80",a.copies=Math.min(5,Math.max(1,parseInt(a.copies)||1)),a.taxRate=Math.max(0,Math.min(100,parseFloat(a.taxRate)||0)),a}const r=t=>String(t??"").replace(/[&<>"']/g,a=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[a]),h=t=>new Intl.NumberFormat("en-US",{maximumFractionDigits:0}).format(Math.round(Number(t)||0)),S=t=>{const a=Number(t)||0;return Number.isInteger(a)?String(a):String(parseFloat(a.toFixed(3)))},wt={cash:"CASH",lipa_namba:"LIPA NAMBA",bank:"BANK",card:"CARD",debt:"CREDIT / DENI",credit:"CREDIT / DENI",mixed:"MIXED"};function D(t,a){const n=wt[String(t||"").toLowerCase()]||String(t||"CASH").toUpperCase();return String(t).toLowerCase()==="bank"&&a?`${n} · ${a}`:n}async function L(t){const a=await O.get(`/receipts/${t}`);if(!a.data?.success)throw new Error(a.data?.error||k("receipt.notFound"));return a.data.data.receipt}async function bt(t){const a=await O.get("/receipts/settings",{params:{shopId:t}});return a.data?.success?A(a.data.data.settings):{...V}}async function I(t){return(await O.post(`/receipts/${t}/printed`)).data?.data||{printCount:1,isReprint:!1}}function et(t,a){const n=t.shop||{},e=[];return a.showAddress&&n.address&&e.push(r(n.address)),a.showPhone&&n.phone&&e.push(`${r(n.phone)}`),a.showEmail&&n.email&&e.push(r(n.email)),a.showTin&&n.tinNumber&&e.push(`TIN: ${r(n.tinNumber)}`),a.showVrn&&n.vrnNumber&&e.push(`VRN: ${r(n.vrnNumber)}`),a.showSerial&&n.serialNumber&&e.push(`SN: ${r(n.serialNumber)}`),a.website&&e.push(r(a.website)),a.headerText&&e.push(r(a.headerText)),e}function gt(t,a,n){const e=t.items||[];return a.paperSize==="58"?e.map(s=>`
      <div class="it">
        <div class="it-name">${r(s.name)}${s.dimensionLabel?` <span class="muted">(${r(s.dimensionLabel)})</span>`:""}</div>
        <div class="it-row">
          <span class="muted"><span class="b">${S(s.quantity)}${s.unitType?` ${r(s.unitType)}`:""}</span> x ${h(s.unitPrice)}</span>
          <span class="b">${h(s.total)}</span>
        </div>
      </div>`).join(""):`
    <table class="items">
      <thead>
        <tr>
          <th class="l">${r(n.item)}</th>
          <th class="r">${r(n.qty)}</th>
          <th class="r">${r(n.price)}</th>
          <th class="r">${r(n.amount)}</th>
        </tr>
      </thead>
      <tbody>
        ${e.map(s=>`
          <tr>
            <td class="l">${r(s.name)}${s.dimensionLabel?`<br><span class="muted">${r(s.dimensionLabel)}</span>`:""}</td>
            <td class="r qty">${S(s.quantity)}</td>
            <td class="r">${h(s.unitPrice)}</td>
            <td class="r b">${h(s.total)}</td>
          </tr>`).join("")}
      </tbody>
    </table>`}function $t(t,a,n){const e=t.totals||{},o=[],s=u=>`<span>${h(u)}</span>`;return o.push(`<div class="row"><span>${r(n.subtotal)}</span>${s(e.subtotal)}</div>`),a.showDiscount&&Number(e.discount)>0&&o.push(`<div class="row"><span>${r(n.discount)}</span><span>-${h(e.discount)}</span></div>`),a.showTax&&Number(e.taxRate)>0&&Number(e.vatAmount)>0&&(o.push(`<div class="row muted"><span>${r(n.netOfTax)}</span>${s(e.netOfTax)}</div>`),o.push(`<div class="row muted"><span>${r(n.vat)} ${S(e.taxRate)}%</span>${s(e.vatAmount)}</div>`)),o.push(`<div class="row total"><span>${r(n.grandTotal)}</span>${s(e.total)}</div>`),o.join("")}function vt(t,a,n){const e=t.sale||{},o=t.totals||{},s=[],u=String(e.paymentMethod||"cash").toLowerCase(),d=u==="debt"||u==="credit",m=Number(o.balanceDue)>.5||d;if(a.showPaymentMethod&&(s.push(`<div class="row"><span>${r(n.payment)}</span><span class="b">${r(D(e.paymentMethod,e.bankName))}</span></div>`),e.paymentReference&&s.push(`<div class="row"><span>${r(n.reference)}</span><span>${r(e.paymentReference)}</span></div>`)),s.push(`<div class="row"><span>${r(n.paid)}</span>${`<span>${h(o.amountPaid)}</span>`}</div>`),!d&&Number(e.changeDue)>0&&s.push(`<div class="row"><span>${r(n.change)}</span><span>${h(e.changeDue)}</span></div>`),m&&(s.push(`<div class="row debt"><span>${r(n.balance)}</span><span>${h(o.balanceDue)}</span></div>`),e.dueDate&&s.push(`<div class="row"><span>${r(n.dueDate)}</span><span>${String(e.dueDate).slice(0,10)}</span></div>`)),Array.isArray(t.payments)&&t.payments.length>1)for(const l of t.payments)s.push(`<div class="row muted"><span>${r(D(l.method))}${l.reference?` · ${r(l.reference)}`:""}</span><span>${h(l.amount)}</span></div>`);return s.join("")}function E(t){const a=t?.sale||{};return String(a.customerName||a.customerCompany||"").trim()}function G(t){const a=String(t.footerText||"").trim();return{footerText:a,showThanks:!/asante|thank/i.test(a),showWelcome:!/karibu|welcome/i.test(a)}}async function J(t,a,n={}){const e=A(a),o={...R(),...n.labels||{}},s=t.sale||{},u=t.shop||{},d=e.paperSize==="58",m=d?58:80,l=d?2.5:3,w=s.createdAt?new Date(s.createdAt):new Date,$=w.toLocaleDateString("en-GB"),f=w.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}),C=et(t,e),z=E(t),_=e.showCustomer&&!!z,i=Math.max(1,parseInt(e.copies)||1),c=G(e),B=`
  <div class="receipt">
    ${n.reprint||Number(t.print?.printCount)>0&&n.wasPrinted?`<div class="reprint">${r(o.reprint)}</div>`:""}
    ${n.offline?`<div class="reprint">${r(o.offline)}</div>`:""}

    <div class="head">
      ${e.showLogo&&u.logo?`<img class="logo" src="${r(u.logo)}" alt="" />`:""}
      ${e.showBusinessName?`<div class="biz">${r(u.businessName||u.name||"")}</div>`:""}
      ${u.branchName?`<div class="small">${r(u.branchName)}</div>`:""}
      ${C.map(g=>`<div class="small">${g}</div>`).join("")}
    </div>

    <div class="sep"></div>
    <div class="title">${r(o.receiptTitle)}</div>
    <div class="sep"></div>

    <div class="meta">
      <div class="row"><span>${r(o.receiptNo)}</span><span class="b">${r(t.receiptNumber||"-")}</span></div>
      <div class="row"><span>${r(o.date)}</span><span>${$} ${f}</span></div>
      ${e.showCashier&&s.sellerName?`<div class="row"><span>${r(o.cashier)}</span><span>${r(s.sellerName)}</span></div>`:""}
      ${_?`<div class="row"><span>${r(o.customer)}</span><span>${r(z)}</span></div>`:""}
      ${e.showCustomerPhone&&s.customerPhone?`<div class="row"><span>${r(o.phone)}</span><span>${r(s.customerPhone)}</span></div>`:""}
      ${s.customerTin?`<div class="row"><span>TIN</span><span>${r(s.customerTin)}</span></div>`:""}
    </div>

    <div class="sep"></div>
    ${gt(t,e,o)}
    <div class="sep"></div>
    ${$t(t,e,o)}
    <div class="sep"></div>
    ${vt(t,e,o)}
    ${s.notes?`<div class="sep"></div><div class="small">${r(o.notes)}: ${r(s.notes)}</div>`:""}
    <div class="sep"></div>

    ${e.showFooter?`
      <div class="foot">
        ${c.footerText?`<div class="thanks">${r(c.footerText)}</div>`:""}
        ${c.showThanks?`<div class="b">${r(o.thankYou)}</div>`:""}
        ${c.showWelcome?`<div>${r(o.welcomeAgain)}</div>`:""}
        ${u.invoiceFooter?`<div class="small">${r(u.invoiceFooter)}</div>`:""}
        ${e.social?`<div class="small">${r(e.social)}</div>`:""}
        ${e.showPoweredBy?`<div class="tiny">${r(o.poweredBy)} ALFEAN ENTERPRISES</div>`:""}
      </div>`:""}
  </div>`,y=Array.from({length:i},(g,N)=>`<div class="copy${N<i-1?" brk":""}">${B}</div>`).join("");return`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${r(t.receiptNumber||k("receipt.title"))}</title>
<style>
  @page { size: ${m}mm auto; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { color: #000; font-family: ui-monospace, "Courier New", Menlo, Consolas, monospace; font-size: ${d?"10.5px":"11.5px"}; line-height: 1.35; }
  .sheet { width: ${m}mm; padding: ${l}mm 0; margin: 0 auto; background: #fff; }
  .copy.brk { page-break-after: always; break-after: page; }
  .receipt { padding: 0 ${l}mm; }
  .b { font-weight: 700; }
  .muted { color: #333; }
  .small { font-size: ${d?"9.5px":"10px"}; text-align: center; word-break: break-word; }
  .tiny { font-size: ${d?"8.5px":"9px"}; text-align: center; color: #333; word-break: break-all; }
  .head { text-align: center; margin-bottom: 2mm; }
  .head .small { text-align: center; }
  .logo { max-width: ${d?"28mm":"34mm"}; max-height: 16mm; object-fit: contain; margin: 0 auto 1.5mm; display: block; filter: grayscale(1) contrast(1.1); }
  .biz { font-family: Arial, "Helvetica Neue", sans-serif; font-weight: 800; font-size: ${d?"15px":"17px"}; letter-spacing: .2px; text-transform: uppercase; }
  .sep { border-top: 1px dashed #000; margin: 1.6mm 0; }
  .title { text-align: center; font-weight: 800; letter-spacing: 3px; font-size: ${d?"12px":"13px"}; }
  .row { display: flex; align-items: baseline; justify-content: space-between; gap: 2mm; flex-wrap: wrap; }
  .row > span:first-child { flex: 0 0 auto; white-space: nowrap; }
  .row > span:last-child { flex: 1 1 auto; min-width: 0; text-align: right; word-break: break-word; overflow-wrap: anywhere; }
  .meta .row { row-gap: 0.4mm; }
  .meta .row > span:first-child { text-transform: uppercase; letter-spacing: .2px; font-size: .92em; }
  .row.total { font-weight: 800; font-size: ${d?"13px":"14px"}; border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 1.2mm 0; margin: 1mm 0; }
  .row.debt { font-weight: 800; }
  .items { width: 100%; border-collapse: collapse; }
  .items th { font-size: ${d?"9px":"10px"}; text-transform: uppercase; border-bottom: 1px solid #000; padding: 0.8mm 0; }
  .items tbody td { padding: 1mm 0; vertical-align: top; word-break: break-word; border-bottom: 1px dotted #777; }
  .items tbody tr:last-child td { border-bottom: none; }
  .items .l { text-align: left; }
  .items .r { text-align: right; white-space: nowrap; padding-left: 1.5mm; }
  .items .qty { font-weight: 700; }
  .it { padding: 0.6mm 0; border-bottom: 1px dotted #999; }
  .it:last-child { border-bottom: none; }
  .it-name { word-break: break-word; }
  .it-row { display: flex; justify-content: space-between; gap: 2mm; margin-top: 0.2mm; }
  .foot { text-align: center; margin-top: 1.5mm; }
  .foot .thanks { font-weight: 700; margin-bottom: 0.6mm; }
  .reprint { text-align: center; font-weight: 800; border: 1px solid #000; padding: 0.8mm; margin-bottom: 1.5mm; letter-spacing: 1px; font-size: ${d?"9.5px":"10.5px"}; }
  @media screen {
    body { background: #e9edf1; padding: 18px 12px; }
    .sheet { background: #fff; box-shadow: 0 6px 26px rgba(15,23,42,.18); border-radius: 6px; padding-top: 6mm; padding-bottom: 6mm; max-width: 100%; }
  }
</style>
</head>
<body>
  <div class="sheet">${y}</div>
</body>
</html>`}function xt(t,{onDone:a}={}){const n=document.createElement("iframe");n.setAttribute("aria-hidden","true"),n.style.position="fixed",n.style.right="0",n.style.bottom="0",n.style.width="0",n.style.height="0",n.style.border="0",n.srcdoc=t;let e=!1;const o=()=>{if(!e){e=!0;try{n.contentWindow.focus(),n.contentWindow.print()}catch(s){console.error("[Receipt] print failed:",s)}typeof a=="function"&&a(),setTimeout(()=>{try{document.body.removeChild(n)}catch{}},6e4)}};n.onload=()=>setTimeout(o,250),document.body.appendChild(n),setTimeout(o,1500)}async function K(t,a,n={}){const e=await J(t,a,n);if(typeof window<"u"&&window.__JB_NATIVE_APP__){try{await M(t,a,n)}catch(o){console.error("[Receipt] native PDF fallback failed:",o)}return typeof n.onDone=="function"&&n.onDone(),e}return xt(e,n),e}async function nt(t,a,n={}){const e=await J(t,a,n);if(typeof window<"u"&&window.__JB_NATIVE_APP__){try{await M(t,a,n)}catch(s){console.error("[Receipt] native PDF preview failed:",s)}return e}const o=window.open("","_blank");if(!o)throw new Error(k("receipt.popupBlocked"));return o.document.open(),o.document.write(e),o.document.close(),e}async function Y(t,a,n={}){const{jsPDF:e}=await pt(async()=>{const{jsPDF:p}=await import("./pdf-BgXZH-bt.js").then(b=>b.b);return{jsPDF:p}},__vite__mapDeps([0,1])),o=A(a),s={...R(),...n.labels||{}},u=o.paperSize==="58",d=u?58:80,m=u?3:4,l=d-m*2,w=t.sale||{},$=t.shop||{},f=t.totals||{},C=u?3.4:3.8,_=60+(t.items||[]).reduce((p,b)=>p+1+Math.ceil(String(b.name||"").length/(u?24:30)),0)*C+110,i=new e({unit:"mm",format:[d,Math.min(1500,Math.max(80,_))]});let c=m;const B=(p,b,x=8,v="normal",T="left")=>{i.setFontSize(x),i.setFont("helvetica",v),i.text(String(p??""),b,c,{align:T})},y=(p,b=8,x="normal",v=.8)=>{B(p,d/2,b,x,"center"),c+=b*.42+v},g=(p,b,{size:x=8,bold:v=!1,gap:T=.6}={})=>{const P=String(p??""),q=String(b??""),U=x*.42;i.setFontSize(x),i.setFont("helvetica","normal");const ct=i.getTextWidth(P);i.setFont("helvetica",v?"bold":"normal");const lt=i.getTextWidth(q);if(ct+lt+2<=l){i.setFont("helvetica","normal"),i.text(P,m,c),i.setFont("helvetica",v?"bold":"normal"),i.text(q,d-m,c,{align:"right"}),c+=U+T;return}i.setFont("helvetica","normal"),i.text(P,m,c),c+=U+.2,i.setFont("helvetica",v?"bold":"normal");const dt=i.splitTextToSize(q,l-2);for(const mt of dt)i.text(mt,d-m,c,{align:"right"}),c+=U;c+=T},N=(p=3)=>{i.setDrawColor(0),i.setLineDashPattern([.6,.6],0),i.line(m,c,d-m,c),i.setLineDashPattern([],0),c+=p},F=(p,b=8,x="normal",v="center")=>{i.setFontSize(b),i.setFont("helvetica",x);const T=i.splitTextToSize(String(p),l);for(const P of T)i.text(P,v==="center"?d/2:m,c,{align:v}),c+=b*.42};if(o.showLogo&&$.logo)try{const p=String($.logo).match(/^data:image\/(png|jpe?g|webp)/i);if(p){const b=p[1].toLowerCase().startsWith("jp")?"JPEG":p[1].toUpperCase();i.addImage($.logo,b,d/2-(u?9:11),c,u?18:22,u?12:14),c+=u?14:16}}catch{}o.showBusinessName&&y($.businessName||$.name||"",u?11:12.5,"bold",.4),$.branchName&&y($.branchName,7.5,"normal",.2);for(const p of et(t,o))String(p).startsWith("TIN")||String(p).startsWith("VRN")||String(p).startsWith("SN")?y(p,7.5,"normal",.2):F(p,7.5,"normal","center");N(),y(s.receiptTitle,u?10:11,"bold",.5),N(),g(s.receiptNo,t.receiptNumber||"-",{bold:!0});const Q=w.createdAt?new Date(w.createdAt):new Date;g(s.date,`${Q.toLocaleDateString("en-GB")} ${Q.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}`),o.showCashier&&w.sellerName&&g(s.cashier,w.sellerName);const X=E(t);if(o.showCustomer&&X&&g(s.customer,X),o.showCustomerPhone&&w.customerPhone&&g(s.phone,w.customerPhone),N(),u)for(const p of t.items||[]){i.setFontSize(7.8),i.setFont("helvetica","normal"),i.splitTextToSize(p.name||"",l).forEach(T=>{i.text(T,m,c),c+=3.1});const x=`${S(p.quantity)}${p.unitType?" "+p.unitType:""}`;i.setFont("helvetica","bold"),i.text(x,m,c);const v=i.getTextWidth(x);i.setFont("helvetica","normal"),i.text(` x ${h(p.unitPrice)}`,m+v,c),i.setFont("helvetica","bold"),i.text(h(p.total),d-m,c,{align:"right"}),c+=3.8}else{i.setFontSize(7.5),i.setFont("helvetica","bold"),i.text(s.item,m,c),i.text(s.qty,m+l*.58,c,{align:"right"}),i.text(s.price,m+l*.8,c,{align:"right"}),i.text(s.amount,d-m,c,{align:"right"}),c+=3.2,i.setLineDashPattern([.6,.6],0),i.line(m,c,d-m,c),i.setLineDashPattern([],0),c+=3;for(const p of t.items||[]){const b=i.splitTextToSize(p.name||"",l*.52);i.setFontSize(7.5),i.setFont("helvetica","normal"),b.forEach((x,v)=>i.text(x,m,c+v*3)),i.setFont("helvetica","bold"),i.text(S(p.quantity),m+l*.58,c,{align:"right"}),i.setFont("helvetica","normal"),i.text(h(p.unitPrice),m+l*.8,c,{align:"right"}),i.setFont("helvetica","bold"),i.text(h(p.total),d-m,c,{align:"right"}),c+=Math.max(3.4,b.length*3)+1.5}}N(),g(s.subtotal,h(f.subtotal)),o.showDiscount&&Number(f.discount)>0&&g(s.discount,`-${h(f.discount)}`),o.showTax&&Number(f.taxRate)>0&&Number(f.vatAmount)>0&&(g(s.netOfTax,h(f.netOfTax),{size:7.5}),g(`${s.vat} ${S(f.taxRate)}%`,h(f.vatAmount),{size:7.5})),N();const it=u?9.5:10.5,W=String(s.grandTotal||""),j=h(f.total);i.setFontSize(it),i.setFont("helvetica","bold");const rt=i.getTextWidth(W)+i.getTextWidth(j)+3<=l;i.setLineWidth(.4),i.line(m,c,d-m,c),c+=3,rt?(i.text(W,m,c),i.text(j,d-m,c,{align:"right"}),c+=1.8):(i.text(W,m,c),c+=3.6,i.text(j,d-m,c,{align:"right"}),c+=1.6),i.line(m,c,d-m,c),c+=2.6,i.setLineWidth(.2);const Z=String(w.paymentMethod||"cash").toLowerCase(),tt=Z==="debt"||Z==="credit";if(o.showPaymentMethod&&g(s.payment,D(w.paymentMethod,w.bankName),{bold:!0}),g(s.paid,h(f.amountPaid)),!tt&&Number(w.changeDue)>0&&g(s.change,h(w.changeDue)),(tt||Number(f.balanceDue)>.5)&&(g(s.balance,h(f.balanceDue),{bold:!0}),w.dueDate&&g(s.dueDate,String(w.dueDate).slice(0,10))),w.notes&&(N(),F(`${s.notes}: ${w.notes}`,7.5,"normal","left")),N(),o.showFooter){const p=G(o);p.footerText&&y(p.footerText,8,"bold",.4),p.showThanks&&y(s.thankYou,8.5,"bold",.2),p.showWelcome&&y(s.welcomeAgain,8,"normal",.2),$.invoiceFooter&&F($.invoiceFooter,7,"normal","center"),o.social&&F(o.social,7,"normal","center"),o.showPoweredBy&&y(`${s.poweredBy} ALFEAN ENTERPRISES`,6.5,"italic",.2)}return i}async function M(t,a,n={}){const e=await Y(t,a,n),o=`risiti-${t.receiptNumber||Date.now()}.pdf`.replace(/[^\w.-]+/g,"-");return e.save(o),e}function yt(t){const a=String(t||"").replace(/[^0-9]/g,"");return a?a.startsWith("0")?`255${a.slice(1)}`:a.startsWith("255")?a:a.length===9&&/^[67]/.test(a)?`255${a}`:a:""}function at(t,a,n={}){const e=A(a),o={...R(),...n.labels||{}},s=t.sale||{},u=t.shop||{},d=t.totals||{},m=[],l=(f="")=>m.push(f);l(`*${u.businessName||u.name||"RISITI"}*`),e.showAddress&&u.address&&l(u.address),e.showPhone&&u.phone&&l(u.phone),l(""),l(`*${o.receiptTitle} ${t.receiptNumber||""}*`);const w=s.createdAt?new Date(s.createdAt):new Date;l(`${o.date}: ${w.toLocaleDateString("en-GB")} ${w.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}`),e.showCashier&&s.sellerName&&l(`${o.cashier}: ${s.sellerName}`);const $=E(t);e.showCustomer&&$&&l(`${o.customer}: ${$}`),e.showCustomerPhone&&s.customerPhone&&l(`${o.phone}: ${s.customerPhone}`),l(""),l(`*${o.item}*`);for(const f of t.items||[])l(`${f.name}${f.dimensionLabel?` (${f.dimensionLabel})`:""}`),l(`   ${S(f.quantity)} x ${h(f.unitPrice)} = ${h(f.total)}`);if(l(""),l(`${o.subtotal}: ${h(d.subtotal)}`),e.showDiscount&&Number(d.discount)>0&&l(`${o.discount}: -${h(d.discount)}`),e.showTax&&Number(d.vatAmount)>0&&l(`${o.vat} ${S(d.taxRate)}%: ${h(d.vatAmount)}`),l(`*${o.grandTotal}: ${h(d.total)}*`),e.showPaymentMethod&&l(`${o.payment}: ${D(s.paymentMethod,s.bankName)}`),l(`${o.paid}: ${h(d.amountPaid)}`),(Number(d.balanceDue)>.5||["debt","credit"].includes(String(s.paymentMethod).toLowerCase()))&&l(`*${o.balance}: ${h(d.balanceDue)}*`),e.showFooter){const f=G(e);l(""),f.footerText&&l(`_${f.footerText}_`),f.showThanks&&l(`_${o.thankYou}_`),f.showWelcome&&l(`_${o.welcomeAgain}_`)}return e.showPoweredBy&&(l(""),l(`${o.poweredBy} ALFEAN ENTERPRISES`)),m.join(`
`).replace(/\n{3,}/g,`

`).trim()}async function ot(t,a,n={}){const e=A(a),o={...R(),...n.labels||{}},s=at(t,e,{labels:o}),u=yt(n.phone||t?.sale?.customerPhone||""),d=`Risiti ${t?.receiptNumber||""}`.trim();if(typeof navigator<"u"&&typeof navigator.share=="function"&&typeof File<"u")try{const l=await Y(t,e,n),w=new File([l.output("blob")],`risiti-${t?.receiptNumber||Date.now()}.pdf`,{type:"application/pdf"});if(typeof navigator.canShare!="function"||navigator.canShare({files:[w]}))return await navigator.share({title:d,text:s,files:[w]}),{shared:!0,via:"native-pdf"}}catch(l){if(l?.name==="AbortError")return{shared:!1,cancelled:!0}}const m=u?`https://wa.me/${u}?text=${encodeURIComponent(s)}`:`https://wa.me/?text=${encodeURIComponent(s)}`;return typeof window<"u"&&window.open(m,"_blank","noopener"),{shared:!0,via:"whatsapp-link"}}async function Nt(t,a={}){const n=await L(t);a.record&&await I(t).catch(()=>null);const e=await ot(n,n.settings,a);return{receipt:n,result:e}}async function Tt(t,a={}){const n=await L(t);let e=null;a.record!==!1&&(e=await I(t).catch(()=>null));const o=!!(e?.isReprint||Number(n.print?.printCount)>0);return await K(n,n.settings,{...a,reprint:o,wasPrinted:o}),{receipt:n,printInfo:e,isReprint:o}}async function St(t,a={}){const n=await L(t);return a.record&&await I(t).catch(()=>null),await M(n,n.settings,a),n}async function At(t,a={}){const n=await L(t);return await nt(n,n.settings,a),n}function st(t,a){const n=(t.items||[]).map(e=>({name:e.productName||e.name||"",quantity:e.quantity||1,unitType:e.unitType||"",unitPrice:e.unitPrice||0,dimensionLabel:e.dimensionLabel||"",total:e.totalPrice??(e.quantity||1)*(e.unitPrice||0)}));return{receiptNumber:t.receiptNumber||"",verificationUrl:"",sale:{createdAt:t.date||new Date().toISOString(),sellerName:t.sellerName||"",paymentMethod:t.paymentMethod||"cash",customerName:t.customerName||"",customerPhone:t.customerPhone||"",bankName:t.bankName||"",changeDue:t.changeDue||0,notes:t.notes||""},items:n,totals:{subtotal:t.subtotal??n.reduce((e,o)=>e+(Number(o.quantity)||0)*(Number(o.unitPrice)||0),0),discount:t.discount||0,total:t.totalAmount||0,amountPaid:t.amountPaid||0,balanceDue:Math.max(0,(t.totalAmount||0)-(t.amountPaid||0)),taxRate:0,vatAmount:0},shop:t.shop||{},settings:A(a),print:{printCount:0}}}async function Pt(t,a,n){const e=st(t,a);return await K(e,e.settings,{labels:n,offline:t.offline}),e}const kt={DEFAULT_RECEIPT_SETTINGS:V,normalizeSettings:A,getReceiptLabels:R,buildReceiptHTML:J,printReceipt:K,openReceiptPreview:nt,buildReceiptPDF:Y,downloadReceiptPDF:M,fetchReceipt:L,fetchReceiptSettings:bt,markReceiptPrinted:I,printSaleReceipt:Tt,downloadSaleReceiptPDF:St,openSaleReceipt:At,printLocalReceipt:Pt,buildLocalReceipt:st,buildReceiptText:at,shareReceipt:ot,shareSaleReceiptWhatsApp:Nt,buyerName:E,paymentLabel:D,fmtMoney:h};export{V as DEFAULT_RECEIPT_SETTINGS,st as buildLocalReceipt,J as buildReceiptHTML,Y as buildReceiptPDF,at as buildReceiptText,E as buyerName,kt as default,M as downloadReceiptPDF,St as downloadSaleReceiptPDF,L as fetchReceipt,bt as fetchReceiptSettings,h as fmtMoney,R as getReceiptLabels,I as markReceiptPrinted,A as normalizeSettings,nt as openReceiptPreview,At as openSaleReceipt,D as paymentLabel,Pt as printLocalReceipt,K as printReceipt,Tt as printSaleReceipt,ot as shareReceipt,Nt as shareSaleReceiptWhatsApp,k as translateReceipt};
