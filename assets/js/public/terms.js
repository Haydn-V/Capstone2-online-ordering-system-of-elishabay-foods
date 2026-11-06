/* Terms and Conditions for the storefront: the customer terms (Create Account) and the Retail Partner terms
   (B2B application), shown in a reader that closes only with its X, the Close button or Esc.
   Loaded on demand: import("./terms.js") from site.js, import("../assets/js/public/terms.js") from a page. */

const UPDATED = "October 18, 2026";
const COMPANY = "Juris Bay Foods, Inc.";
const ADDRESS = "148 Brgy. Mangin, Dagupan City, Pangasinan";
const EMAIL   = "hello@jurisbayfoods.ph";
const PHONE   = "+63 917 000 0000";

const sec = (n, title, body) => `<section class="tc-sec" id="tc-s${n}" data-title="${title}"><h3><span class="tc-num">${n}</span>${title}</h3>${body}</section>`;

/* Customer terms: everyone who creates an account. */
const CUSTOMER = `
  <p class="tc-lead">These terms apply when you create an Elisha Bay account and order from our store. By ticking the box on the
  Create Account form you agree to them. Elisha Bay is operated by ${COMPANY}, ${ADDRESS}.</p>
  ${sec(1, "Eligibility and your account", `<ul>
    <li>You must be <strong>at least 18 years old</strong>, or have the consent of a parent or guardian who agrees to these terms for you.</li>
    <li>One account per person. Give your real name, contact number and address so we can fulfil your orders.</li>
    <li>Keep your password private. You are responsible for orders placed from your account.</li>
    <li>After several wrong passwords, sign-in pauses for a few minutes to protect your account.</li></ul>`)}
  ${sec(2, "Products and prices", `<ul>
    <li>Prices are in Philippine pesos (₱) and already include 12% VAT where it applies.</li>
    <li>Stock shown is live. Items in an order that is still waiting for confirmation are held for that customer.</li>
    <li>Product photos are for illustration; packaging may vary slightly.</li></ul>`)}
  ${sec(3, "Orders", `<ul>
    <li>An order is confirmed only when our staff <strong>accept</strong> it. You will see its status in My Orders.</li>
    <li>You may cancel your own order while it is still <strong>Pending</strong>.</li>
    <li>We may cancel an order if a product runs out, the payment cannot be verified, or the details are incomplete. Any amount you paid for a cancelled order is refunded.</li></ul>`)}
  ${sec(4, "Payment", `<ul>
    <li><strong>GCash and bank transfer:</strong> upload your proof of payment at checkout. Staff verify it before accepting the order.</li>
    <li><strong>Cash:</strong> for pickup orders only, paid when you collect the order.</li>
    <li>A fake or altered proof of payment cancels the order and may close the account.</li></ul>`)}
  ${sec(5, "Pickup and delivery", `<ul>
    <li>The delivery fee is our own estimate from Dagupan City, based on distance and the weight of your order. It is not an official courier quotation.</li>
    <li>For pickup, bring your order ID. Please collect the order promptly, as our products are perishable.</li>
    <li>Make sure the delivery address and contact number are correct; failed deliveries caused by wrong details may be charged again.</li></ul>`)}
  ${sec(6, "Returns and refunds", `<ul>
    <li>You may request a return within <strong>24 hours</strong> after your order is marked Completed, from My Orders.</li>
    <li>Because our products are food, returns are accepted only for items that arrived <strong>damaged, spoiled, expired or wrong</strong>. A change of mind is not a reason for return.</li>
    <li>Attach a clear photo of the product and describe the problem. Staff review each request and may approve or refuse it with a reason.</li>
    <li>Approved returns are refunded for the affected items, using the method staff confirm with you.</li></ul>`)}
  ${sec(7, "Product reviews", `<ul>
    <li>You can rate each product once per completed order, and edit that rating later.</li>
    <li>Reviews must be honest and respectful. We may hide reviews that are abusive, false or unrelated to the product.</li></ul>`)}
  ${sec(8, "Food safety and storage", `<ul>
    <li>Follow the storage instructions and the expiry date on each pack.</li>
    <li>Check the ingredients and nutrition information for allergens before buying and eating.</li>
    <li>We are not responsible for spoilage caused by improper storage after the order is handed over or delivered.</li></ul>`)}
  ${sec(9, "Your privacy (Data Privacy Act of 2012, RA 10173)", `<ul>
    <li>We collect your name, email, contact number, address, order history and payment proof images.</li>
    <li>We use them only to process, deliver and support your orders, issue invoices, and keep your account secure. We do not sell your data.</li>
    <li>Payment proof and return photos are kept for verification and records only.</li>
    <li>You may ask to see, correct or delete your personal data by contacting us below. Some records must be kept for tax and accounting rules.</li></ul>`)}
  ${sec(10, "Liability, changes and contact", `<ul>
    <li>Our liability for an order is limited to the amount you paid for it.</li>
    <li>We may update these terms. The date at the top shows the latest version; changes apply to orders placed after the update.</li>
    <li>Questions: <strong>${EMAIL}</strong> · ${PHONE} · ${ADDRESS}.</li></ul>`)}`;

/* Retail Partner terms: the B2B application, on top of the customer terms. */
const PARTNER = `
  <p class="tc-lead">These terms apply to approved Retail Partners, in addition to the customer Terms and Conditions. By ticking the
  box on the partnership application you agree to them.</p>
  ${sec(1, "Partnership approval", `<ul>
    <li>Applications are reviewed by our staff. A valid <strong>BIR TIN</strong> and correct business details are required.</li>
    <li>We may approve or reject an application. A rejected applicant is told the reason and may keep ordering as a regular customer.</li>
    <li>Partner status may be withdrawn for repeated late payment, false information or misuse of the account.</li></ul>`)}
  ${sec(2, "Net 30 / 60 / 90 credit terms", `<ul>
    <li>Partners may choose Net 30, Net 60 or Net 90 at checkout, and pay the balance by its due date from the Payment Schemes page.</li>
    <li>A balance still unpaid after its due date is charged a <strong>penalty</strong> at the rate set by Elisha Bay (shown on your Payment Schemes page).</li>
    <li>While any balance is overdue, new orders on Net terms are paused; you can still order with cash, GCash or bank transfer.</li>
    <li>Payments you send are counted only after our staff verify them.</li></ul>`)}
  ${sec(3, "Tier credit budget", `<ul>
    <li>Each partner is placed in a tier: <strong>Bronze, Silver or Gold</strong>. The tier sets your credit budget — the most you may owe on Net terms at one time.</li>
    <li>A new Net order is refused if your unpaid Net balances plus that order would go above the budget. Paying your balances frees the budget again.</li>
    <li>New partners usually start at Bronze. Elisha Bay may move a partner to another tier, and may change the budget of each tier; changes apply to your next Net order.</li></ul>`)}
  ${sec(4, "Retailer discount", `<ul>
    <li>Some partners receive a retailer discount, shown on the order when it applies.</li>
    <li>The discount applies only when the order meets the <strong>minimum number of items</strong> set by Elisha Bay; smaller orders are charged the regular price.</li>
    <li>Elisha Bay may change or withdraw the discount and the minimum at any time; changes apply to orders placed afterwards.</li></ul>`)}`;

const DOCS = {
  customer: { title: "Terms and Conditions", body: CUSTOMER },
  partner:  { title: "Retail Partner Terms", body: PARTNER },
};

function css(){
  if(document.getElementById("eb-terms-css")) return;
  const s = document.createElement("style");
  s.id = "eb-terms-css";
  s.textContent = `
    .tc-overlay{position:fixed;inset:0;z-index:10050;display:grid;place-items:center;padding:16px;background:rgba(15,12,4,.55);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
    .tc-box{width:min(760px,100%);max-height:min(88vh,920px);display:flex;flex-direction:column;border-radius:22px;overflow:hidden;
      background:var(--surface,#fff);color:var(--text,#1e1a0e);box-shadow:0 24px 60px rgba(0,0,0,.3)}
    .tc-head{display:flex;align-items:center;gap:14px;padding:20px 22px;border-bottom:1px solid var(--border,rgba(0,0,0,.1));
      background:linear-gradient(135deg,rgba(232,163,23,.14),transparent 70%)}
    .tc-head-ic{flex:none;width:44px;height:44px;border-radius:14px;display:grid;place-items:center;color:#fff;background:var(--gold,#E8A317);box-shadow:0 6px 14px rgba(232,163,23,.35)}
    .tc-head-ic svg{width:22px;height:22px}
    .tc-head-text{flex:1;min-width:0}
    .tc-head h2{margin:0;font-size:1.35rem;line-height:1.2}
    .tc-head small{display:block;margin-top:4px;font-size:.76rem;color:var(--text-muted,#777)}
    .tc-x{flex:none;width:38px;height:38px;border-radius:50%;border:1px solid var(--border,rgba(0,0,0,.12));background:var(--bg-tint,#f4f1ea);color:var(--text-muted,#555);cursor:pointer;font-size:1rem;line-height:1;font-family:system-ui,sans-serif}
    .tc-body{overflow-y:auto;padding:18px 22px 10px;font-size:.88rem;line-height:1.6;scroll-behavior:smooth}
    .tc-lead{margin:0 0 16px;padding:12px 14px;border-radius:12px;color:var(--text-muted,#555);background:var(--bg-tint,rgba(0,0,0,.035));border-left:3px solid var(--gold,#E8A317)}
    .tc-sec{margin-bottom:12px;padding:14px 16px;border:1px solid var(--border,rgba(0,0,0,.08));border-radius:14px;scroll-margin-top:8px}
    .tc-sec h3{display:flex;align-items:center;gap:12px;margin:0 0 8px;font-size:1rem;line-height:1.3}
    .tc-num{flex:none;width:28px;height:28px;border-radius:50%;display:inline-grid;place-items:center;
      font:800 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1e1a0e;background:var(--gold,#E8A317)}
    .tc-sec ul{margin:0;padding:0;list-style:none}
    .tc-sec li{position:relative;margin:5px 0;padding-left:18px}
    .tc-sec li::before{content:"";position:absolute;left:3px;top:.62em;width:6px;height:6px;border-radius:50%;background:var(--gold,#E8A317)}
    .tc-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 22px;border-top:1px solid var(--border,rgba(0,0,0,.1))}
    .tc-foot small{font-size:.74rem;color:var(--text-muted,#777)}
    .tc-ok{border:0;border-radius:999px;padding:11px 24px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;font-size:.8rem;cursor:pointer;background:var(--gold,#E8A317);color:#1e1a0e}
    .tc-agree{display:flex;align-items:flex-start;gap:10px;margin:6px 0 4px;font-size:.84rem;line-height:1.45;cursor:pointer}
    .tc-agree input{flex:none;width:18px;height:18px;margin-top:2px;accent-color:var(--gold,#E8A317);cursor:pointer}
    .tc-agree a{color:var(--gold-ink,#9A6B0C);font-weight:700;text-decoration:underline}
    @media (max-width:560px){.tc-sec{padding:12px}.tc-head{padding:16px}}`;
  document.head.appendChild(s);
}

/** Open a document ("customer" or "partner"); "Got it" also ticks the matching agree box when one is given. */
export function openTerms(kind, agreeBox = null){
  const doc = DOCS[kind] || DOCS.customer;
  css();
  const prev = document.activeElement;
  const ov = document.createElement("div");
  ov.className = "tc-overlay";
  ov.innerHTML = `<div class="tc-box" role="dialog" aria-modal="true" aria-labelledby="tc-title">
      <div class="tc-head">
        <span class="tc-head-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg></span>
        <div class="tc-head-text"><h2 id="tc-title">${doc.title}</h2><small>Last updated ${UPDATED} · ${COMPANY}</small></div>
        <button type="button" class="tc-x" aria-label="Close">✕</button></div>
      <div class="tc-body">${doc.body}</div>
      <div class="tc-foot"><small>Questions? ${EMAIL}</small><button type="button" class="tc-ok">${agreeBox ? "I agree" : "Close"}</button></div>
    </div>`;
  /* Outside clicks never close it (the system-wide popup rule); only ✕, the button or Esc. */
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  const onKey = e => { if(e.key === "Escape"){ e.stopPropagation(); close(); } };
  ov.querySelector(".tc-x").onclick = close;
  ov.querySelector(".tc-ok").onclick = () => {
    if(agreeBox && !agreeBox.checked){ agreeBox.checked = true; agreeBox.dispatchEvent(new Event("change", { bubbles: true })); }
    close();
  };
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(ov);
  ov.querySelector(".tc-ok").focus();
}

/** The agree checkbox markup; `kind` picks the wording and which document its link opens. */
export function agreeHtml(kind, id){
  return kind === "partner"
    ? `<label class="tc-agree"><input type="checkbox" id="${id}"/><span>I have read and agree to the <a href="#" data-terms="partner">Retail Partner Terms</a> on behalf of my business.</span></label>`
    : `<label class="tc-agree"><input type="checkbox" id="${id}"/><span>I am at least 18 years old (or have my parent or guardian's consent) and I agree to the <a href="#" data-terms="customer">Terms and Conditions</a>, including how my personal data is used.</span></label>`;
}

/** Wire every [data-terms] link inside root to open its document, ticking the nearby box on "I agree". */
export function wireTermsLinks(root){
  css();
  root.querySelectorAll("[data-terms]").forEach(a => a.addEventListener("click", e => {
    e.preventDefault();
    openTerms(a.dataset.terms, a.closest(".tc-agree")?.querySelector("input"));
  }));
}
