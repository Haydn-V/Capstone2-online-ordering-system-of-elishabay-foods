"use strict";
/* ============================================================
   POINT OF SALE — Walk-In Order + Payment
   Ported from the former CashierModule. Reuses engine.js's shared helpers
   ($, $$, peso, escHtml, fmtDate, fmtDateTime, toast, openModal,
   closeModal, stockInfo, getProduct, payMethodLabel, PRODUCTS,
   ORDERS, adminState) — nothing redefined here.
   ============================================================ */

/* ============================================================
   CART OPERATIONS
   ============================================================ */
function addToCart(productId, qty){
  const existing = adminState.cart.find(c=>c.productId===productId);
  if(existing){ existing.qty = qty; }
  else { adminState.cart.push({productId, qty}); }
  refreshCartUI();
}

function updateCartQty(productId, delta){
  const item = adminState.cart.find(c=>c.productId===productId);
  if(!item) return;
  const p = getProduct(productId);
  item.qty = Math.max(1, Math.min(item.qty + delta, p?.stock || 99));
  refreshCartUI();
}

function removeFromCart(productId){
  adminState.cart = adminState.cart.filter(c=>c.productId!==productId);
  refreshCartUI();
}

function computeTotal(){
  return adminState.cart.reduce((sum,item)=>{
    const p = getProduct(item.productId);
    return sum + (p ? p.price * item.qty : 0);
  },0);
}

function refreshCartUI(){
  renderCart();
  renderPosProducts();
  updateCartBadge();
  if(adminState.currentModule==="pos-payment") renderPayment();
}

function updateCartBadge(){
  const total = adminState.cart.reduce((s,c)=>s+c.qty,0);
  const badge = $("#cart-item-count");
  if(badge){ badge.textContent=total; badge.classList.toggle("hide", total===0); }
}

/* ============================================================
   WALK-IN ORDER — Product grid
   ============================================================ */
function renderPosProducts(){
  const search = ($("#prod-search")?.value||"").toLowerCase();
  const cat    = adminState.catFilter;
  const cats   = ["All", ...new Set(PRODUCTS.filter(p=>!p.archived).map(p=>p.cat))];

  const cf = $("#cat-filter");
  if(cf && !cf.dataset.rendered){
    cf.innerHTML = cats.map(c=>`<button class="cat-btn${c===cat?" active":""}" data-cat="${escHtml(c)}">${escHtml(c)}</button>`).join("");
    cf.dataset.rendered="1";
    cf.querySelectorAll(".cat-btn").forEach(btn=>{
      btn.addEventListener("click",()=>{
        adminState.catFilter=btn.dataset.cat;
        cf.querySelectorAll(".cat-btn").forEach(b=>b.classList.toggle("active",b===btn));
        renderPosProducts();
      });
    });
    $("#prod-search")?.addEventListener("input", renderPosProducts);
  } else if(cf){
    cf.querySelectorAll(".cat-btn").forEach(btn=>btn.classList.toggle("active",btn.dataset.cat===cat));
  }

  const filtered = PRODUCTS.filter(p=>{
    if(p.archived) return false;
    if(cat!=="All" && p.cat!==cat) return false;
    if(search && !p.name.toLowerCase().includes(search)) return false;
    return true;
  });

  const grid = $("#products-grid");
  grid.innerHTML = filtered.map(p=>createPosProductTile(p)).join("") ||
    `<div style="padding:40px;text-align:center;color:var(--text-muted)">No products found.</div>`;

  grid.querySelectorAll(".product-tile:not(.oos)").forEach(tile=>{
    tile.addEventListener("click",()=>openAddModal(tile.dataset.pid));
    tile.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" ") openAddModal(tile.dataset.pid); });
  });
}

function createPosProductTile(p){
  const si     = stockInfo(p);
  const inCart = adminState.cart.find(c=>c.productId===p.id);
  const oos    = p.stock===0;
  const stripColor = p.cat.includes("Deboned")?"var(--red)":"var(--gold)";
  /* imageUrl(), not p.image directly. The stored value is now
     /uploads/products/….webp — application-root-relative — and this page lives
     at /elishabay/portal/cashier/, so a raw src would resolve to the web root
     and 404. That mismatch, in the opposite direction, is the whole of defect
     3.2. One resolver, every screen (decision I6). */
  const imgSrc  = imageUrl(p);
  const imgZone = imgSrc
    ? `<div class="tile-img"><img src="${escHtml(imgSrc)}" alt="${escHtml(p.name)}" loading="lazy"></div>`
    : `<div class="tile-img" style="background:linear-gradient(135deg,${stripColor}18,${stripColor}35)">
        <div class="tile-img-placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="${stripColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        </div>
       </div>`;
  return `<div class="product-tile${oos?" oos":""}${inCart?" in-cart":""}" data-pid="${p.id}" role="listitem" ${oos?"":"tabindex='0'"}>
    ${imgZone}
    <div class="tile-strip" style="background:${stripColor}"></div>
    <div class="tile-body">
      <div class="tile-cat">${escHtml(p.cat)}</div>
      <div class="tile-name">${escHtml(p.name)}</div>
      <div class="tile-footer">
        <span class="tile-price">${peso(p.price)}</span>
        <span class="badge ${si.cls}" style="font-size:.6rem">${oos?"Out":p.stock+" left"}</span>
      </div>
      ${inCart?`<div class="tile-in-cart"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px"><path d="M20 6 9 17l-5-5"/></svg> In order: ${inCart.qty}</div>`:""}
    </div>
  </div>`;
}

function openAddModal(productId){
  const p = getProduct(productId);
  if(!p||p.stock===0) return;
  const inCart = adminState.cart.find(c=>c.productId===productId);
  const initQty = inCart?.qty||1;
  openModal({
    title: p.name,
    body: `<div style="text-align:center;padding:6px 0 18px">
      <div style="font-size:.78rem;color:var(--text-muted);margin-bottom:4px">${escHtml(p.cat)}</div>
      <div style="font-family:var(--font-number);font-size:1.9rem;font-weight:800;color:var(--gold);font-variant-numeric:lining-nums tabular-nums;letter-spacing:-.01em">${peso(p.price)}</div>
      <div style="font-size:.78rem;color:var(--text-muted);margin-top:4px">${p.stock} units available</div>
    </div>
    <div class="field">
      <label style="text-align:center;display:block">Quantity</label>
      <div style="display:flex;align-items:center;gap:12px;justify-content:center;margin-top:8px">
        <button type="button" class="btn btn-ghost btn-sm" id="qm-minus" style="border-radius:50%;width:36px;height:36px;padding:0;font-size:1.2rem">−</button>
        <input type="number" id="qm-qty" style="width:70px;text-align:center;font-size:1.2rem;font-weight:700;padding:8px;border:1.5px solid var(--border-lift);border-radius:var(--r-md);background:var(--surface);color:var(--text)" value="${initQty}" min="1" max="${p.stock}"/>
        <button type="button" class="btn btn-ghost btn-sm" id="qm-plus" style="border-radius:50%;width:36px;height:36px;padding:0;font-size:1.2rem">+</button>
      </div>
    </div>`,
    confirmLabel: inCart?"Update Order":"Add to Order",
    confirmClass:"btn-gold",
    onConfirm(){
      const qty=parseInt($("#qm-qty").value)||1;
      if(qty<1||qty>p.stock){ toast(`Qty must be 1–${p.stock}.`,"warn"); return; }
      addToCart(productId, qty);
      closeModal();
      toast(`${p.name} ×${qty} added to order.`,"ok");
    }
  });
  setTimeout(()=>{
    $("#qm-minus")?.addEventListener("click",()=>{ const i=$("#qm-qty"); i.value=Math.max(1,+i.value-1); });
    $("#qm-plus")?.addEventListener("click",()=>{ const i=$("#qm-qty"); i.value=Math.min(p.stock,+i.value+1); });
  },50);
}

/* ============================================================
   CART PANEL
   ============================================================ */
function renderCart(){
  const items = adminState.cart;
  const total = computeTotal();
  const badge = $("#cart-items-badge");
  if(badge) badge.textContent = items.length===1?"1 item":`${items.length} items`;

  const cartEl = $("#cart-items");
  if(!items.length){
    cartEl.innerHTML=`<div class="cart-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
      <p>No items yet.<br>Click a product to add.</p>
    </div>`;
  } else {
    cartEl.innerHTML=items.map(item=>{
      const p=getProduct(item.productId);
      if(!p) return "";
      return `<div class="cart-item">
        <div class="cart-item-info">
          <div class="cart-item-name">${escHtml(p.name)}</div>
          <div class="cart-item-unit">${peso(p.price)} each</div>
        </div>
        <div class="qty-stepper">
          <button class="qty-btn" data-delta="-1" data-pid="${p.id}" aria-label="Decrease">−</button>
          <span class="qty-val">${item.qty}</span>
          <button class="qty-btn" data-delta="1"  data-pid="${p.id}" aria-label="Increase">+</button>
        </div>
        <div class="cart-item-total">${peso(p.price*item.qty)}</div>
        <button class="cart-item-remove" data-pid="${p.id}" aria-label="Remove ${escHtml(p.name)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
    }).join("");
    cartEl.querySelectorAll(".qty-btn").forEach(btn=>{
      btn.addEventListener("click",()=>updateCartQty(btn.dataset.pid, +btn.dataset.delta));
    });
    cartEl.querySelectorAll(".cart-item-remove").forEach(btn=>{
      btn.addEventListener("click",()=>removeFromCart(btn.dataset.pid));
    });
  }

  const totalEl = $("#cart-total"); if(totalEl) totalEl.textContent=peso(total);
  const payBtn  = $("#cart-pay-btn");
  const gotoBtn = $("#goto-payment-btn");
  if(payBtn)  payBtn.disabled=items.length===0;
  if(gotoBtn) gotoBtn.disabled=items.length===0;
}

/* ============================================================
   PAYMENT / CHECKOUT
   ============================================================ */
function renderPayment(){
  const orderReviewCol  = $("#order-review-col");
  const paymentFormCol  = $("#payment-form-col");
  if(!orderReviewCol || !paymentFormCol) return;

  if(!adminState.cart.length){
    /* data-goto, not onclick. The inline handler this replaces lived inside a
       template string, so a grep of the .html files could never see it — and it
       depended on navigate() being a global, which breaks silently the moment
       this file becomes a module. */
    orderReviewCol.innerHTML=`<div style="text-align:center;padding:40px;color:var(--text-muted)">
      <p>No items in order.</p>
      <button class="btn btn-gold" style="margin-top:16px" data-goto="pos">← Add Products</button>
    </div>`;
    orderReviewCol.querySelector("[data-goto]")
      ?.addEventListener("click", ()=> navigate("pos"));
    paymentFormCol.innerHTML="";
    return;
  }

  const total = computeTotal();
  const reviewItems = adminState.cart.map(item=>{
    const p=getProduct(item.productId); if(!p) return "";
    return `<div class="review-item">
      <div class="cart-item-info" style="flex:1">
        <div class="review-item-name">${escHtml(p.name)}</div>
        <div class="review-item-unit">${peso(p.price)} × ${item.qty}</div>
      </div>
      <div class="qty-stepper">
        <button class="qty-btn" data-delta="-1" data-pid="${p.id}">−</button>
        <span class="qty-val">${item.qty}</span>
        <button class="qty-btn" data-delta="1"  data-pid="${p.id}">+</button>
      </div>
      <div class="review-item-total">${peso(p.price*item.qty)}</div>
      <button class="cart-item-remove" data-pid="${p.id}" aria-label="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join("");

  orderReviewCol.innerHTML=`
    <div class="panel-header"><span class="panel-title">Order Summary</span></div>
    <div id="review-items">${reviewItems}</div>
    <div class="billing-row total-row" style="margin-top:12px">
      <span>Total</span>
      <span class="billing-total-val" id="billing-total">${peso(total)}</span>
    </div>`;

  orderReviewCol.querySelectorAll(".qty-btn").forEach(btn=>{
    btn.addEventListener("click",()=>updateCartQty(btn.dataset.pid, +btn.dataset.delta));
  });
  orderReviewCol.querySelectorAll(".cart-item-remove").forEach(btn=>{
    btn.addEventListener("click",()=>removeFromCart(btn.dataset.pid));
  });

  paymentFormCol.innerHTML=`
    <div class="panel-header"><span class="panel-title">Payment Details</span></div>

    <div class="field">
      <label>Order Type</label>
      <div class="order-type-toggle" id="order-type-toggle">
        <button type="button" class="order-type-btn active" data-type="pickup">Pickup</button>
        <button type="button" class="order-type-btn" data-type="delivery">Delivery</button>
      </div>
      <span class="field-hint" id="order-type-hint">Pickup → status: Completed immediately</span>
    </div>

    <div class="field" id="customer-type-field">
      <label>Customer Type</label>
      <div class="order-type-toggle" id="customer-type-toggle">
        <button type="button" class="order-type-btn active" data-ctype="regular">Regular</button>
        <button type="button" class="order-type-btn" data-ctype="retailer">Retailer</button>
      </div>
    </div>

    <!-- Shown only for a credit sale. A Net 30/60/90 sale creates a debt, and a
         debt has to be owed by somebody: the receivable needs a customer row to
         hang off, and "Walk-In Customer" is not one. Without this the endpoint
         would have to either refuse the sale or open an account belonging to
         nobody. -->
    <div class="field hide" id="retailer-field">
      <label>Retailer Account <span class="muted" style="font-weight:400;font-size:.78rem">(required for credit terms)</span></label>
      <select class="control" id="pay-retailer"><option value="">Select a retailer…</option></select>
      <span class="field-error" id="err-retailer"></span>
      <span class="field-hint" id="retailer-standing"></span>
    </div>

    <div id="customer-info-fields">
      <div class="field">
        <label>Customer Name <span class="muted" style="font-weight:400;font-size:.78rem" id="name-req-hint">(optional)</span></label>
        <input class="control" id="pay-customer-name" placeholder="Walk-In Customer" value="Walk-In Customer"/>
      </div>
      <div class="field">
        <label>Phone <span class="muted" style="font-weight:400;font-size:.78rem" id="phone-req-hint">(optional)</span></label>
        <input class="control" id="pay-phone" placeholder="+63 9XX XXX XXXX"/>
      </div>
      <div class="field hide" id="address-field">
        <label>Delivery Address <span style="color:var(--out)">*</span></label>
        <input class="control" id="pay-address" placeholder="Street, City"/>
        <span class="field-error" id="err-address"></span>
      </div>
    </div>

    <div class="field">
      <label>Payment Method</label>
      <div class="pay-method-grid" id="pay-method-grid">
        ${buildPayMethodGrid("regular","pickup")}
      </div>
      <input type="hidden" id="pay-method" value="cash"/>
      <span class="field-error" id="err-paymethod"></span>
    </div>

    <div class="field hide" id="ref-num-field">
      <label>Reference Number <span style="color:var(--out)">*</span></label>
      <input class="control" id="pay-refnum" placeholder="e.g. GC-20260617-0001"/>
      <span class="field-error" id="err-refnum"></span>
    </div>

    <div class="field hide" id="tendered-field">
      <label>Amount Tendered</label>
      <input class="control" type="number" id="pay-tendered" placeholder="${total}" min="${total}"/>
      <div class="change-display hide" id="change-display">
        <span>Change</span><strong id="change-val">${peso(0)}</strong>
      </div>
    </div>

    <div class="billing-row total-row" style="margin-bottom:16px">
      <span>Order Total</span>
      <span class="billing-total-val">${peso(total)}</span>
    </div>

    <button class="btn btn-gold btn-block" id="place-order-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      Place Order
    </button>
    <span class="field-error" id="err-general" style="margin-top:8px;display:block;text-align:center"></span>`;

  wirePaymentForm(total);
}

/* The credit methods, mirroring Payments::CREDIT in api/core/Payments.php.

   Two lists in two languages is exactly what broke this: the grid below offered
   net30/net60/net90 while pos/checkout.php accepted only cash/gcash/bank, so a
   credit sale returned 422 and — because placeOrder() had no branch for a
   `pay_method` field error — displayed nothing at all. The server is the
   authority; this list decides only what to RENDER, and every value in it is
   re-checked there. */
const POS_CREDIT_METHODS = ["net30", "net60", "net90"];
function isCreditMethod(m){ return POS_CREDIT_METHODS.includes(m); }

function buildPayMethodGrid(ctype, orderType){
  const methods=[
    {id:"cash",  label:"Cash",          icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01"/><path d="M18 12h.01"/></svg>'},
    {id:"gcash", label:"GCash",         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>'},
    {id:"bank",  label:"Bank Transfer", icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>'},
  ];
  if(ctype==="retailer"){
    methods.push(
      {id:"net30",label:"Net 30",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'},
      {id:"net60",label:"Net 60",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'},
      {id:"net90",label:"Net 90",icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'},
    );
  }
  return methods.map(m=>`<button type="button" class="pay-card${m.id==="cash"?" selected":""}" data-method="${m.id}">
    ${m.icon}<span>${m.label}</span>
  </button>`).join("");
}

function wirePaymentForm(total){
  let orderType="pickup", customerType="regular", payMethod="cash";

  $$("#order-type-toggle .order-type-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      orderType=btn.dataset.type;
      $$("#order-type-toggle .order-type-btn").forEach(b=>b.classList.toggle("active",b===btn));
      const hint=$("#order-type-hint");
      if(hint) hint.textContent=orderType==="pickup"?"Pickup → status: Completed immediately":"Delivery → status: Accepted (awaiting fulfillment)";
      const addrField=$("#address-field");
      if(addrField) addrField.classList.toggle("hide", orderType!=="delivery");
      const nameHint=$("#name-req-hint"), phoneHint=$("#phone-req-hint");
      if(nameHint) nameHint.textContent=orderType==="delivery"?"(required)":"(optional)";
      if(phoneHint) phoneHint.textContent=orderType==="delivery"?"(required)":"(optional)";
    });
  });

  $$("#customer-type-toggle .order-type-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      customerType=btn.dataset.ctype;
      $$("#customer-type-toggle .order-type-btn").forEach(b=>b.classList.toggle("active",b===btn));
      const grid=$("#pay-method-grid");
      grid.innerHTML=buildPayMethodGrid(customerType, orderType);
      payMethod="cash"; $("#pay-method").value="cash";
      wirePayCards();
      /* Selecting Regular clears any retailer choice, so switching back and
         forth cannot leave a credit sale pointed at a stale account. */
      syncRetailerField();
      if(customerType!=="retailer"){ const sel=$("#pay-retailer"); if(sel) sel.value=""; }
      else loadRetailers();
    });
  });

  /* The picker is only relevant to a credit sale. Shown by payment method
     rather than by customer type: a retailer paying cash is an ordinary sale
     and should not be made to pick an account. */
  function syncRetailerField(){
    const field=$("#retailer-field");
    if(field) field.classList.toggle("hide", !isCreditMethod(payMethod));
    const err=$("#err-retailer"); if(err) err.textContent="";
    showRetailerStanding();
  }

  /* Fetched once per payment screen. pos/retailers.php returns id, name and
     what the retailer already owes — deciding whether to extend more credit is
     a person's call, and not showing them the number is how it stops being
     one. */
  async function loadRetailers(){
    const sel=$("#pay-retailer");
    if(!sel || sel.dataset.loaded==="1") return;
    try {
      const { data } = await EbApi.get("pos/retailers.php");
      sel.innerHTML = `<option value="">Select a retailer…</option>` +
        data.map(r=>`<option value="${escHtml(r.id)}" data-outstanding="${r.outstanding}" data-overdue="${r.overdue}">${escHtml(r.name)}</option>`).join("");
      sel.dataset.loaded="1";
      if(!data.length){
        sel.innerHTML = `<option value="">No retailer accounts exist yet</option>`;
      }
    } catch(err){
      /* Said out loud. A picker that silently stays empty is how the cashier
         concludes the feature is broken and stops using it. */
      sel.innerHTML = `<option value="">Could not load retailers</option>`;
      toast("Could not load the retailer list: " + err.message, "err");
    }
  }

  function showRetailerStanding(){
    const sel=$("#pay-retailer"), hint=$("#retailer-standing");
    if(!sel || !hint) return;
    const opt=sel.selectedOptions[0];
    if(!opt || !sel.value){ hint.textContent=""; return; }
    const owed=+opt.dataset.outstanding||0, late=+opt.dataset.overdue||0;
    hint.textContent = owed>0
      ? `Currently owes ${peso(owed)}${late>0?` — ${late} account(s) overdue`:""}`
      : "No outstanding balance.";
    hint.style.color = late>0 ? "var(--out)" : "var(--text-muted)";
  }

  $("#pay-retailer")?.addEventListener("change", ()=>{
    const err=$("#err-retailer"); if(err) err.textContent="";
    showRetailerStanding();
  });

  const wirePayCards=()=>{
    $$("#pay-method-grid .pay-card").forEach(card=>{
      card.addEventListener("click",()=>{
        payMethod=card.dataset.method;
        $$("#pay-method-grid .pay-card").forEach(c=>c.classList.toggle("selected",c===card));
        $("#pay-method").value=payMethod;
        const refField=$("#ref-num-field");
        refField?.classList.toggle("hide", payMethod!=="gcash" && payMethod!=="bank");
        const tenderedField=$("#tendered-field");
        tenderedField?.classList.toggle("hide", payMethod!=="cash");
        if(payMethod==="cash") { const t=$("#pay-tendered"); if(t) t.placeholder=String(total); }
        syncRetailerField();
        if(isCreditMethod(payMethod)) loadRetailers();
      });
    });
  };
  wirePayCards();

  $("#pay-tendered")?.addEventListener("input",()=>{
    const t=+$("#pay-tendered").value||0;
    const change=t-total;
    const cd=$("#change-display"), cv=$("#change-val");
    if(cd){ cd.classList.toggle("hide", change<0); if(cv) cv.textContent=peso(Math.max(0,change)); }
  });

  /* async so the button can be disabled for the duration — a double-click here
     used to be capable of ringing up two sales. */
  $("#place-order-btn")?.addEventListener("click", async ()=> {
    await placeOrder(orderType, customerType, payMethod, total, $("#pay-retailer")?.value || null);
  });
}

/* ============================================================
   PLACE ORDER + RECEIPT
   ============================================================ */
function genTxnId(){
  const today = dAgo(0);
  const d = today.replace(/-/g,"");
  const n = String(ORDERS.filter(o=>o.date.startsWith(today)).length+1).padStart(3,"0");
  return `TXN-${d}-${n}`;
}

/* Sends the cart to the server and shows the receipt it returns.

   WHAT CHANGED AND WHY
   --------------------
   This used to compute the total in the browser, decrement p.stock in a loop,
   unshift the order onto an array and call it done. Three problems, in order of
   seriousness:

     1. The amount charged was decided by code running on the till's own
        machine. api/pos/checkout.php now prices every line from products.price
        and ignores anything the client says a thing costs.
     2. Stock moved in memory only, so it was correct until the next refresh
        and then silently wasn't.
     3. Order and stock could not be kept consistent — there was no transaction
        to be consistent within. They are now written together or not at all.

   The `total` argument is still accepted so the existing call sites do not have
   to change, but it is used only for the pre-submit cash check; the receipt
   shows the server's figure.
*/
async function placeOrder(orderType, customerType, payMethod, total, retailerId){
  const name     = $("#pay-customer-name")?.value.trim()||"Walk-In Customer";
  const phone    = $("#pay-phone")?.value.trim()||"";
  const address  = $("#pay-address")?.value.trim()||"";
  const refNum   = $("#pay-refnum")?.value.trim()||"";
  const tendered = +($("#pay-tendered")?.value)||0;

  $("#err-address").textContent="";
  $("#err-refnum").textContent="";
  $("#err-general").textContent="";
  const errRetailer = $("#err-retailer");
  if(errRetailer) errRetailer.textContent="";

  if(!adminState.cart.length){ toast("The cart is empty.","warn"); return; }

  /* Kept client-side too: catching these before the round trip is faster for
     the cashier. The server checks all of them again regardless. */
  if(orderType==="delivery" && !address){ if($("#err-address")) $("#err-address").textContent="Delivery address required."; return; }
  if((payMethod==="gcash"||payMethod==="bank") && !refNum){ if($("#err-refnum")) $("#err-refnum").textContent="Reference number required."; return; }
  if(isCreditMethod(payMethod) && !retailerId){
    if(errRetailer) errRetailer.textContent="Choose which retailer this credit sale is for.";
    return;
  }
  if(payMethod==="cash" && tendered < total && tendered !== 0){ toast(`Amount tendered must be at least ${peso(total)}.`,"warn"); return; }

  /* #place-order-btn is the real control (built at pos.js:323). The dead
     `$("#pay-confirm-btn") ||` branch that used to lead this line matched
     nothing — harmless here because of the fallback, but it is the same shape
     as the dangling id that made batch registration silently do nothing. */
  const btn = $("#place-order-btn");
  const restore = EbUI.busy(btn, "Placing…");

  let order;
  try {
    const { data } = await EbApi.post("pos/checkout.php", {
      /* Ids and quantities only. Prices are the server's business. */
      items: adminState.cart.map(c => ({ id: c.productId, qty: c.qty })),
      order_type: orderType,
      customer_type: customerType,
      pay_method: payMethod,
      customer_name: name,
      contact: phone || null,
      address: address || null,
      ref_num: refNum || null,
      tendered: tendered || 0,
      /* Only sent for a credit sale. The server re-reads the customer row and
         checks the status itself — this is a selection, not an assertion. */
      retailer_id: isCreditMethod(payMethod) ? retailerId : null,
    });
    order = data;
  } catch(err){
    /* Out of stock, archived product, short cash — all reported plainly, and
       the cart is left intact so the cashier can adjust and retry.

       THIS BLOCK WAS THE SILENT FAILURE.
       ----------------------------------
       It listed four field names and fell back to a toast only when
       `err.fields` was EMPTY. A 422 naming any other field — `pay_method`, for
       one — matched no branch, was not empty, and so produced nothing: no
       inline error, no toast, no console entry. The cashier pressed Place
       Order and watched the button do nothing.

       That is how a server-side refusal became "the payment does not appear in
       Payment History". The order was never written, and nothing said so.

       Every field error is now shown. Known fields go against their input;
       anything unrecognised goes to the general line rather than being
       dropped. A field this screen has never heard of is exactly the case that
       must not be silent. */
    if(err.isValidation){
      const fieldTargets = {
        address:     "#err-address",
        ref_num:     "#err-refnum",
        retailer_id: "#err-retailer",
      };
      const leftover = [];
      Object.entries(err.fields).forEach(([field, msg])=>{
        const sel = fieldTargets[field];
        const el  = sel ? $(sel) : null;
        if(el) el.textContent = msg;
        else leftover.push(msg);
      });
      if(leftover.length) $("#err-general").textContent = leftover.join(" ");
      /* A validation error with no fields at all still has a message. */
      toast(Object.keys(err.fields).length ? (leftover[0] || err.message) : err.message, "err");
    } else {
      $("#err-general").textContent = err.message;
      toast(err.message, "err");
    }
    return;
  } finally {
    restore();
  }

  /* Only now is the sale real: clear the cart and refresh stock from the
     database rather than assuming what it became. */
  adminState.cart = [];
  updateCartBadge();
  await loadCatalog();
  await loadOrders();

  openModal({
    title:"Order Placed — Receipt",
    body: buildReceipt({
      ...order,
      /* buildReceipt reads these names. */
      method: payMethodLabel(order.payMethod),
      contact: order.contact,
      cashTendered: order.tendered,
      date: order.datetime,
      items: order.items,
    }),
    confirmLabel:"Print",
    confirmClass:"btn-ghost",
    cancelLabel:"Close",
    large:true,
    onConfirm(){ window.print(); }
  });
  toast(`Order ${order.id} placed successfully.`,"ok");
  if(adminState.currentModule === "pos-payment") navigate("pos");
}

function buildReceipt(o){
  const dueMap={net30:30,net60:60,net90:90};
  const dueDays=dueMap[o.payMethod];
  let dueDate="";
  if(dueDays){
    /* Counted from today's real date. dAgo(0) used to be a constant, which
       made every NET-30 receipt say "due 17 July 2026" forever. */
    dueDate=` — Due: ${fmtDate(addDays(dAgo(0), dueDays))}`;
  }
  const itemLines=o.items.map(item=>`
    <div class="receipt-line item-line">
      <span class="l">${escHtml(item.name)} ×${item.qty}</span>
      <span class="r">${peso(item.price*item.qty)}</span>
    </div>`).join("");

  return `<div class="receipt">
    <div class="receipt-header">
      <div class="receipt-brand">Elisha Bay</div>
      <div class="receipt-sub">Juris Bay Foods, Inc.</div>
      <div class="receipt-sub">148 Brgy. Mangin, Dagupan City, Pangasinan</div>
      <div class="receipt-txn">TXN: ${escHtml(o.id)}</div>
    </div>
    <div class="receipt-line"><span>Date</span><span>${fmtDateTime(o.date)}</span></div>
    <div class="receipt-line"><span>Cashier</span><span>${escHtml(o.cashier)}</span></div>
    <div class="receipt-line"><span>Customer</span><span>${escHtml(o.customer)}</span></div>
    ${(o.contact||o.phone)?`<div class="receipt-line"><span>Phone</span><span>${escHtml(o.contact||o.phone)}</span></div>`:""}
    ${o.address?`<div class="receipt-line"><span>Address</span><span>${escHtml(o.address)}</span></div>`:""}
    <div class="receipt-line"><span>Order Type</span><span>${o.orderType}</span></div>
    <div class="receipt-line"><span>Status</span><span>${o.status}</span></div>
    <hr class="receipt-divider"/>
    ${itemLines}
    <hr class="receipt-divider"/>
    <div class="receipt-total-row">
      <span>TOTAL</span><span>${peso(o.total)}</span>
    </div>
    <hr class="receipt-divider"/>
    <div class="receipt-line"><span>Payment</span><span>${payMethodLabel(o.payMethod)}${dueDate}</span></div>
    ${o.refNum?`<div class="receipt-line"><span>Ref #</span><span>${escHtml(o.refNum)}</span></div>`:""}
    ${o.payMethod==="cash"&&o.cashTendered?`<div class="receipt-line"><span>Tendered</span><span>${peso(o.cashTendered)}</span></div><div class="receipt-line" style="font-weight:700"><span>Change</span><span>${peso(o.change)}</span></div>`:""}
    <div class="receipt-footer">
      Thank you for choosing Elisha Bay!<br>
      <em>"Every Mouthful is Delightful"</em>
    </div>
  </div>`;
}

/* ============================================================
   POS MODULE ENTRY POINTS (called from navigate()'s renders map)
   ============================================================ */
function renderPos(){
  renderPosProducts();
  renderCart();
  $("#clear-cart-btn").onclick = ()=>{
    if(!adminState.cart.length) return;
    openModal({
      title:"Clear Order",
      body:"<p>Remove all items from the current order?</p>",
      confirmLabel:"Clear", confirmClass:"btn-ghost-danger",
      onConfirm(){ adminState.cart=[]; refreshCartUI(); closeModal(); toast("Order cleared.","warn"); }
    });
  };
  $("#goto-payment-btn").onclick = ()=>{ if(adminState.cart.length) navigate("pos-payment"); };
  $("#cart-pay-btn").onclick     = ()=>{ if(adminState.cart.length) navigate("pos-payment"); };
}
