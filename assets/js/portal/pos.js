"use strict";

/* Same format rule as Payments::checkRef (the server also refuses a reference already used). */
function refFormatError(method, ref){
  const c = String(ref || "").replace(/[\s-]/g, "").toUpperCase();
  if(method === "gcash" && !/^\d{13}$/.test(c)) return "GCash reference numbers are 13 digits.";
  if(method === "bank" && !/^[A-Z0-9]{6,20}$/.test(c)) return "Enter the 6–20 character reference from your bank's confirmation.";
  return "";
}

/* ===== POINT OF SALE: Walk-In Order + Payment (uses engine.js helpers and globals) ===== */

/* ===== CART OPERATIONS ===== */
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

/* Typed quantity: clamped to 1…stock like the +/− buttons. */
function setCartQty(productId, qty){
  const item = adminState.cart.find(c=>c.productId===productId);
  if(!item) return;
  const p = getProduct(productId), max = p?.stock || 99;
  const n = Math.floor(Number(qty));
  item.qty = Math.max(1, Math.min(Number.isFinite(n) ? n : item.qty, max));
  if(Number.isFinite(n) && n > max) toast(`Only ${max} left in stock.`, "warn");
  refreshCartUI();
}
/* Wire the typed-quantity boxes in a cart list. */
function wireQtyInputs(root){
  root.querySelectorAll("input.qty-val").forEach(inp=>{
    inp.addEventListener("focus", ()=>inp.select());
    inp.addEventListener("input", ()=>{ inp.value = inp.value.replace(/\D/g, "").slice(0, 4); });
    inp.addEventListener("keydown", e=>{ if(e.key==="Enter") inp.blur(); if(e.key==="Escape"){ inp.value=inp.defaultValue; inp.blur(); } });
    inp.addEventListener("change", ()=>setCartQty(inp.dataset.pid, inp.value || inp.defaultValue));
  });
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

/* ===== WALK-IN ORDER: product grid ===== */
function renderPosProducts(){
  const search = ($("#prod-search")?.value||"").toLowerCase();
  const cat    = adminState.catFilter;
  const cats   = ["All", ...new Set(PRODUCTS.filter(p=>!p.archived).map(p=>p.cat))];

  const cf = $("#cat-filter");
  if(cf && !cf.dataset.rendered){
    cf.innerHTML = cats.map(c=>`<button class="tab-btn${c===cat?" active":""}" data-cat="${escHtml(c)}">${escHtml(c)}</button>`).join("");
    cf.dataset.rendered="1";
    cf.querySelectorAll(".tab-btn").forEach(btn=>{
      btn.addEventListener("click",()=>{
        adminState.catFilter=btn.dataset.cat;
        cf.querySelectorAll(".tab-btn").forEach(b=>b.classList.toggle("active",b===btn));
        renderPosProducts();
      });
    });
    $("#prod-search")?.addEventListener("input", renderPosProducts);
  } else if(cf){
    cf.querySelectorAll(".tab-btn").forEach(btn=>btn.classList.toggle("active",btn.dataset.cat===cat));
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
  /* Use imageUrl() so app-root-relative upload paths resolve from this page. */
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
      <label class="qm-label" for="qm-qty">Quantity</label>
      <div class="qm-stepper">
        <button type="button" class="btn btn-ghost qm-step" id="qm-minus" aria-label="Decrease quantity">−</button>
        <input type="number" class="qm-qty" id="qm-qty" inputmode="numeric" value="${initQty}" min="1" max="${p.stock}"/>
        <button type="button" class="btn btn-ghost qm-step" id="qm-plus" aria-label="Increase quantity">+</button>
      </div>
    </div>`,
    confirmLabel: inCart?"Update Order":"Add Order",
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

/* ===== CART PANEL ===== */
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
      /* Cart lines show the same picture as the tile (or the same tinted placeholder) so a wrong tap is easy to spot. */
      const thumbSrc = imageUrl(p);
      const tint = p.cat.includes("Deboned") ? "var(--red)" : "var(--gold)";
      const thumb = thumbSrc
        ? `<img class="cart-item-thumb" src="${escHtml(thumbSrc)}" alt="" loading="lazy">`
        : `<span class="cart-item-thumb cart-item-thumb-ph" aria-hidden="true"
                 style="background:linear-gradient(135deg,${tint}18,${tint}35)">
             <svg viewBox="0 0 24 24" fill="none" stroke="${tint}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
           </span>`;
      /* Two rows: name and price on top with the full width, controls below, thumbnail spanning both. */
      return `<div class="cart-item">
        ${thumb}
        <div class="cart-item-info">
          <div class="cart-item-name" title="${escHtml(p.name)}">${escHtml(p.name)}</div>
          <div class="cart-item-unit">${peso(p.price)} each</div>
        </div>
        <div class="cart-item-controls">
          <div class="qty-stepper">
            <button class="qty-btn" data-delta="-1" data-pid="${p.id}" aria-label="Decrease">−</button>
            <input class="qty-val" type="text" inputmode="numeric" value="${item.qty}" data-pid="${p.id}" aria-label="Quantity of ${escHtml(p.name)}">
            <button class="qty-btn" data-delta="1"  data-pid="${p.id}" aria-label="Increase">+</button>
          </div>
          <div class="cart-item-total">${peso(p.price*item.qty)}</div>
          <button class="cart-item-remove" data-pid="${p.id}" aria-label="Remove ${escHtml(p.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>`;
    }).join("");
    cartEl.querySelectorAll(".qty-btn").forEach(btn=>{
      btn.addEventListener("click",()=>updateCartQty(btn.dataset.pid, +btn.dataset.delta));
    });
    cartEl.querySelectorAll(".cart-item-remove").forEach(btn=>{
      btn.addEventListener("click",()=>removeFromCart(btn.dataset.pid));
    });
    wireQtyInputs(cartEl);
  }

  const totalEl = $("#cart-total"); if(totalEl) totalEl.textContent=peso(total);
  const pcs = items.reduce((n, i) => n + i.qty, 0);
  const qtyEl = $("#cart-qty-sum"); if(qtyEl) qtyEl.textContent = `${pcs} pc${pcs === 1 ? "" : "s"}`;
  const payBtn  = $("#cart-pay-btn");
  const gotoBtn = $("#goto-payment-btn");
  if(payBtn)  payBtn.disabled=items.length===0;
  if(gotoBtn) gotoBtn.disabled=items.length===0;
}

/* ===== PAYMENT / CHECKOUT ===== */
function renderPayment(){
  const orderReviewCol  = $("#order-review-col");
  const paymentFormCol  = $("#payment-form-col");
  if(!orderReviewCol || !paymentFormCol) return;

  if(!adminState.cart.length){
    /* data-goto instead of an inline onclick. */
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
    const src = imageUrl(p);
    return `<div class="review-item">
      ${src ? `<img class="review-item-thumb" src="${escHtml(src)}" alt="" loading="lazy">` : `<span class="review-item-thumb" aria-hidden="true"></span>`}
      <div class="cart-item-info" style="flex:1">
        <div class="review-item-name">${escHtml(p.name)}</div>
        <div class="review-item-unit">${peso(p.price)} × ${item.qty}</div>
      </div>
      <div class="qty-stepper">
        <button class="qty-btn" data-delta="-1" data-pid="${p.id}">−</button>
        <input class="qty-val" type="text" inputmode="numeric" value="${item.qty}" data-pid="${p.id}" aria-label="Quantity of ${escHtml(p.name)}">
        <button class="qty-btn" data-delta="1"  data-pid="${p.id}">+</button>
      </div>
      <div class="review-item-total">${peso(p.price*item.qty)}</div>
      <button class="cart-item-remove" data-pid="${p.id}" aria-label="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join("");

  orderReviewCol.innerHTML=`
    <div class="panel-header">
      <span class="panel-title">Order Summary</span>
      <span class="badge badge-info">${adminState.cart.reduce((n, i) => n + i.qty, 0)} pcs</span>
    </div>
    <div id="review-items">${reviewItems}</div>
    <div class="billing-row total-row review-total">
      <span>Items total</span>
      <span class="billing-total-val" id="billing-total">${peso(total)}</span>
    </div>
    <!-- Totals + Place Order live beside the form (right column), so the
         cashier never scrolls to finish a sale. -->
    <div class="order-detail-section pay-checkout-box">
    <!-- Filled from pos/quote.php: the discount, VAT, withholding and the amount
         DUE, which is what the cashier tenders against. Starts as the plain
         total so the screen is never blank while the quote is on its way. -->
    <div id="pos-tax-box" style="margin-bottom:16px">
      <div class="billing-row total-row">
        <span>Amount Due</span>
        <span class="billing-total-val">${EbFormat.pesoExact(total)}</span>
      </div>
    </div>

    <button class="btn btn-gold btn-block" id="place-order-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      Place Order
    </button>
    <span class="field-error" id="err-general" style="margin-top:8px;display:block;text-align:center"></span>
    </div>`;

  orderReviewCol.querySelectorAll(".qty-btn").forEach(btn=>{
    btn.addEventListener("click",()=>updateCartQty(btn.dataset.pid, +btn.dataset.delta));
  });
  orderReviewCol.querySelectorAll(".cart-item-remove").forEach(btn=>{
    btn.addEventListener("click",()=>removeFromCart(btn.dataset.pid));
  });
  wireQtyInputs(orderReviewCol);

  /* Place Order is rebuilt with this column every time, so bind it here (wirePaymentForm() is skipped when the form is kept, which left later sales with a dead button). */
  $("#place-order-btn")?.addEventListener("click", ()=> posPlaceOrder?.());

  /* If the cart changes while the form is filled in, keep the entries and just re-quote. */
  if(paymentFormCol.querySelector("#order-type-toggle") && typeof posRefreshQuote === "function"){
    posRefreshQuote();
    return;
  }

  paymentFormCol.innerHTML=`
    <div class="panel-header">
      <span class="panel-title">Payment Details</span>
    </div>

    <section class="order-detail-section pay-sec">
    <div class="order-detail-heading">Order</div>
    <div class="pay-row">
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
    </div>

    <!-- Shown only for a credit sale. A Net 30/60/90 sale creates a debt, and a
         debt has to be owed by somebody: the receivable needs a customer row to
         hang off, and "Walk-In Customer" is not one. Without this the endpoint
         would have to either refuse the sale or open an account belonging to
         nobody. -->
    <div class="field hide" id="retailer-field">
      <label>Retailer Account <span class="muted" style="font-weight:400;font-size:.78rem">(required for Net terms · applies their retailer discount)</span></label>
      <select class="control" id="pay-retailer"><option value="">Select a retailer…</option></select>
      <span class="field-error" id="err-retailer"></span>
      <span class="field-hint" id="retailer-standing"></span>
    </div>

    </section>

    <section class="order-detail-section pay-sec">
    <div class="order-detail-heading">Customer</div>
    <div id="customer-info-fields" class="pay-row">
      <!-- Regular sales only: file the sale under a customer on record (pos/customers.php), so it shows in their
           order history and lifetime spend. Retailers are picked in the Retailer Account field instead. -->
      <div class="field pos-cust-field" id="cust-lookup-field">
        <label>Customer on Record <span class="muted" style="font-weight:400;font-size:.78rem">(optional · adds this sale to their history)</span></label>
        <div class="pos-cust-lookup">
          <input class="control" id="pay-cust-search" placeholder="Search name, email or phone…" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="pay-cust-results"/>
          <div class="pos-cust-results hide" id="pay-cust-results" role="listbox"></div>
        </div>
        <div class="pos-cust-chip hide" id="pay-cust-chip"></div>
        <input type="hidden" id="pay-customer-id"/>
        <span class="field-error" id="err-customer"></span>
      </div>
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
        <!-- Shown when a retailer's saved address filled the field: locked until
             the cashier switches this on, like the saved address at checkout. -->
        <label class="vat-check pos-check addr-edit hide" id="addr-edit-wrap">
          <span class="switch">
            <input type="checkbox" role="switch" id="addr-edit"/>
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </span>
          <span>Deliver to a different address</span>
        </label>
        <span class="field-error" id="err-address"></span>
        <!-- Where the delivery fee is estimated to (api/core/Shipping.php).
             "Detect" reads the province or city from the address typed above. -->
        <label for="pay-dest" style="margin-top:12px">Delivery Destination</label>
        <select class="control" id="pay-dest"><option value="">Detect from address</option></select>
      </div>
    </div>

    </section>

    <section class="order-detail-section pay-sec">
    <div class="order-detail-heading">Payment</div>
    <div class="field">
      <label>Payment Method</label>
      <div class="pay-method-grid" id="pay-method-grid">
        ${buildPayMethodGrid("regular","pickup")}
      </div>
      <input type="hidden" id="pay-method" value="cash"/>
      <span class="field-error" id="err-paymethod"></span>
    </div>

    <div class="field hide" id="ref-num-field">
      <label><span data-ref-label>Reference Number</span> <span style="color:var(--out)">*</span></label>
      <input class="control" id="pay-refnum" maxlength="30" autocomplete="off"/>
      <span class="field-error" id="err-refnum"></span>
    </div>

    <div class="field hide" id="tendered-field">
      <label>Amount Tendered</label>
      <input class="control" type="number" id="pay-tendered" placeholder="${total}" min="${total}"/>
      <div class="change-display hide" id="change-display">
        <span>Change</span><strong id="change-val">${peso(0)}</strong>
      </div>
    </div>
    </section>
`;

  wirePaymentForm(total);
}

/* Credit methods, mirroring Payments::CREDIT; only used to decide what to show, the server re-checks. */
/* Hook to the Senior/PWD reset, so checkout can clear the switch after a sale (null until the payment screen renders). */
let posResetScPwd = null;

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

/* Set by wirePaymentForm(): re-quotes the live form (see renderPayment). */
let posRefreshQuote = null;
/* Set by wirePaymentForm(): places the order with the live form state (bound to Place Order in renderPayment). */
let posPlaceOrder = null;

function wirePaymentForm(total){
  let orderType="pickup", customerType="regular", payMethod="cash", posRef=null;

  /* The amount the cashier tenders against: the plain total, replaced by the server's amount due once the quote arrives (tax maths lives only in api/core/Tax.php). */
  let due = total;
  let scPwdType = "senior";
  let quoteTimer = null, quoteSeq = 0;
  const money = n => EbFormat.pesoExact(n);

  function scPwdPayload(){
    if(customerType !== "regular" || !$("#scpwd-on")?.checked) return null;
    return {
      type: scPwdType,
      id:   $("#scpwd-id")?.value.trim() || "",
      name: $("#scpwd-name")?.value.trim() || "",
    };
  }

  /* Reset the Senior/PWD switch, ID and name after each sale, so the discount never carries over to the next customer. */
  function resetScPwd(){
    const on = $("#scpwd-on");
    if(on) on.checked = false;
    $("#scpwd-details")?.classList.add("hide");
    const id = $("#scpwd-id"), name = $("#scpwd-name");
    if(id)   id.value = "";
    if(name) name.value = "";
    scPwdType = "senior";
    $$("#scpwd-type .order-type-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.scpwd === "senior"));
    /* Clear leftover errors for the now-empty fields. */
    ["err-scpwd", "err-scpwd-id", "err-scpwd-name"].forEach(k => {
      const el = $("#" + k); if(el) el.textContent = "";
    });
  }
  posResetScPwd = resetScPwd;

  function renderTaxBox(t){
    const box = $("#pos-tax-box");
    if(!box) return;
    const row = (label, value, cls="") => `<div class="billing-row ${cls}"><span>${label}</span><span>${value}</span></div>`;
    box.innerHTML =
      row("Subtotal", money(t.grossTotal))
      + (t.scPwdDiscount > 0 ? row(`${scPwdType === "pwd" ? "PWD" : "Senior citizen"} discount`, "− " + money(t.scPwdDiscount)) : "")
      /* VAT breakdown explaining the VAT-inclusive total. */
      + row("VATable Sales", money(t.vatableSales), "vat-sub")
      + row(t.vatAmount > 0 ? `VAT (${+t.vatRate}%)` : "VAT", t.vatAmount > 0 ? money(t.vatAmount) : "VAT-exempt", "vat-sub")
      + (t.vatExemptSales > 0 ? row("VAT-Exempt Sales", money(t.vatExemptSales), "vat-sub") : "")
      + `<div class="vat-note">Prices already include VAT.</div>`
      /* Delivery: our own estimate by distance zone + weight, not an LBC quote. */
      + (orderType === "delivery" && t.shipping ? `<div class="pos-ship">
          ${row("Delivery Destination", t.shipping.destination ? escHtml(t.shipping.destination) : "Enter the address", "vat-sub")}
          ${t.shipping.distanceKm != null ? row("Estimated Distance", `${Math.round(t.shipping.distanceKm).toLocaleString()} km`, "vat-sub") : ""}
          ${row("Total Product Weight", `${(+t.shipping.weightKg).toFixed(2)} kg`, "vat-sub")}
          ${t.shipping.remote ? row("Island / remote area fee", "+ " + money(t.shipping.remoteFee), "vat-sub") : ""}
          ${row("Estimated Delivery Fee", t.shipping.destination ? "+ " + money(t.shipping.fee) : "—")}
          ${t.shipping.destination && t.shipping.eta ? row("Estimated Arrival", escHtml(etaText(t.shipping.eta)), "vat-sub") : ""}
          ${t.shipping.paused ? `<div class="vat-note" style="color:var(--out)">Deliveries to ${escHtml(t.shipping.destination)} are paused right now${t.shipping.remote && t.shipping.remote.note ? ` (${escHtml(t.shipping.remote.note)})` : ""}.</div>`
            : t.shipping.remote ? `<div class="vat-note" style="color:var(--warn)">Island / remote area: may take longer than estimated (boat/flight schedules, weather).</div>` : ""}
        </div>` : "")
      + (t.withholdingTax > 0 ? row(`Retailer discount (${+t.withholdingRate}%)`, "− " + money(t.withholdingTax)) : "")
      /* Retailer has a discount but the sale is under the minimum item count. */
      + (t.termInterest > 0 ? row(`${escHtml(t.termScheme || "Net terms")} interest (${+t.termInterestRate}%)`, "+ " + money(t.termInterest)) : "")
      + (t.discountShortfall ? `<div class="vat-note" style="color:var(--warn)">Add ${t.discountShortfall.short} more item${t.discountShortfall.short === 1 ? "" : "s"} for the ${+t.discountShortfall.rate}% retailer discount (minimum ${t.discountShortfall.minQty} items).</div>` : "")
      + `<div class="billing-row total-row"><span>Amount Due</span><span class="billing-total-val">${money(t.amountDue)}</span></div>`;
  }

  function syncChange(){
    const t=+$("#pay-tendered")?.value||0;
    const change=t-due;
    const cd=$("#change-display"), cv=$("#change-val");
    if(cd){ cd.classList.toggle("hide", !t || change<0); if(cv) cv.textContent=money(Math.max(0,change)); }
  }

  /* Debounced and sequenced so an older, slower response never overwrites the latest figures. */
  function refreshQuote(){
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(async ()=>{
      const seq = ++quoteSeq;
      try {
        const { data } = await EbApi.post("pos/quote.php", {
          items: adminState.cart.map(c => ({ id: c.productId, qty: c.qty })),
          sc_pwd: scPwdPayload(),
          retailer_id: customerType === "retailer" ? ($("#pay-retailer")?.value || null) : null,
          order_type: orderType,
          destination: $("#pay-dest")?.value || "",
          address: $("#pay-address")?.value.trim() || "",
          pay_method: payMethod,
        });
        if(seq !== quoteSeq) return;
        const t = data.tax;
        due = t.amountDue;
        renderTaxBox(t);
        const field = $("#scpwd-field");
        if(field) field.classList.toggle("hide", !data.rules.scPwdEnabled || customerType !== "regular");
        const hint = $("#scpwd-hint");
        if(hint){
          const r = data.rules;
          hint.textContent = t.scPwdCapped
            ? `Weekly limit reached for this ID — discount capped at ${money(t.scPwdDiscount)}.`
            : `${+r.scPwdDiscountRate}% off the amount net of VAT${r.scPwdVatExempt ? ", VAT-exempt" : ""}${r.scPwdWeeklyCap > 0 ? ` · up to ${money(r.scPwdWeeklyCap)} a week per ID` : ""}.`;
          hint.style.color = t.scPwdCapped ? "var(--warn)" : "";
        }
        const tendered=$("#pay-tendered");
        if(tendered){ tendered.placeholder=String(due); tendered.min=String(due); }
        syncChange();
      } catch(err){
        /* A failed preview never blocks the sale, but it is reported. */
        if(seq === quoteSeq) toast("Could not work out the tax preview: " + err.message, "warn");
      }
    }, 200);
  }

  $("#scpwd-on")?.addEventListener("change", ()=>{
    $("#scpwd-details")?.classList.toggle("hide", !$("#scpwd-on").checked);
    refreshQuote();
  });
  $$("#scpwd-type .order-type-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      scPwdType = btn.dataset.scpwd;
      $$("#scpwd-type .order-type-btn").forEach(b=>b.classList.toggle("active", b===btn));
      refreshQuote();
    });
  });
  /* The ID matters to the weekly cap, so it re-quotes; the name does not. */
  $("#scpwd-id")?.addEventListener("input", refreshQuote);
  posRefreshQuote = refreshQuote;
  refreshQuote();

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
      refreshQuote();
    });
  });

  /* Load the delivery destinations once and re-estimate when the address changes. */
  EbApi.get("shipping/rates.php").then(({ data }) => {
    const sel = $("#pay-dest"); if(!sel || !data.destinations) return;
    sel.insertAdjacentHTML("beforeend", data.destinations.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`).join(""));
    if(window.EbSelect) EbSelect.sync(sel);
  }).catch(()=>{});
  $("#pay-dest")?.addEventListener("change", refreshQuote);
  $("#pay-address")?.addEventListener("input", refreshQuote);

  $$("#customer-type-toggle .order-type-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      customerType=btn.dataset.ctype;
      $$("#customer-type-toggle .order-type-btn").forEach(b=>b.classList.toggle("active",b===btn));
      const grid=$("#pay-method-grid");
      grid.innerHTML=buildPayMethodGrid(customerType, orderType);
      payMethod="cash"; $("#pay-method").value="cash";
      wirePayCards();
      /* Choosing Regular clears any retailer selection. */
      syncRetailerField();
      if(customerType!=="retailer"){ const sel=$("#pay-retailer"); if(sel && sel.value){ sel.value=""; fillFromRetailer(); } }
      else { loadRetailers(); pickCustomer(null); }
      $("#cust-lookup-field")?.classList.toggle("hide", customerType !== "regular");
      /* A retailer sale clears the Senior/PWD discount. */
      if(customerType!=="regular") resetScPwd();
      refreshQuote();
    });
  });

  /* Show the account picker based on payment method (credit sales only). */
  function syncRetailerField(){
    const field=$("#retailer-field");
    /* Any retailer sale can name the account (needed for withholding tax). */
    if(field) field.classList.toggle("hide", customerType !== "retailer");
    const err=$("#err-retailer"); if(err) err.textContent="";
    showRetailerStanding();
  }

  /* Fetch retailers once per payment screen, including what each already owes. */
  async function loadRetailers(){
    const sel=$("#pay-retailer");
    if(!sel || sel.dataset.loaded==="1") return;
    try {
      const { data } = await EbApi.get("pos/retailers.php");
      sel.innerHTML = `<option value="">Select a retailer…</option>` +
        data.map(r=>`<option value="${escHtml(r.id)}" data-outstanding="${r.outstanding}" data-overdue="${r.overdue}" data-tier="${escHtml(r.tier || "")}" data-limit="${r.creditLimit ?? ""}" data-left="${r.creditLeft ?? ""}" data-contact="${escHtml(r.contact || "")}" data-address="${escHtml(r.address || "")}">${escHtml(r.name)}</option>`).join("");
      sel.dataset.loaded="1";
      if(!data.length){
        sel.innerHTML = `<option value="">No retailer accounts exist yet</option>`;
      }
    } catch(err){
      /* Say plainly when there are no retailers. */
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
    const tier = opt.dataset.tier
      ? ` ${opt.dataset.tier} tier: ${peso(+opt.dataset.left||0)} of ${peso(+opt.dataset.limit||0)} Net budget left.`
      : "";
    hint.textContent = (owed>0
      ? `Currently owes ${peso(owed)}${late>0?` — ${late} account(s) overdue`:""}.`
      : "No outstanding balance.") + tier;
    hint.style.color = late>0 ? "var(--out)" : "var(--text-muted)";
  }

  /* Picking a retailer fills the customer fields (saved address locked unless "Deliver to a different address"); clearing restores walk-in defaults. */
  function fillFromRetailer(){
    const sel=$("#pay-retailer"), opt=sel?.selectedOptions[0];
    const name=$("#pay-customer-name"), phone=$("#pay-phone"), addr=$("#pay-address");
    const wrap=$("#addr-edit-wrap"), sw=$("#addr-edit");
    const on = customerType==="retailer" && !!sel?.value;
    if(name)  name.value  = on ? opt.textContent : "Walk-In Customer";
    if(phone) phone.value = on ? (opt.dataset.contact || "") : "";
    const saved = on ? (opt.dataset.address || "") : "";
    if(addr){ addr.value = saved; addr.readOnly = !!saved; addr.dataset.saved = saved; }
    if(sw) sw.checked = false;
    wrap?.classList.toggle("hide", !saved);
  }
  $("#addr-edit")?.addEventListener("change", e=>{
    const addr=$("#pay-address"); if(!addr) return;
    addr.readOnly = !e.target.checked;
    if(e.target.checked){ addr.value=""; addr.focus(); }
    else addr.value = addr.dataset.saved || "";
  });

  /* Customer on record: search as the cashier types (2+ characters), pick one to file the sale under them. */
  function pickCustomer(c){
    const idEl=$("#pay-customer-id"), chip=$("#pay-cust-chip"), search=$("#pay-cust-search"), box=$("#pay-cust-results");
    const name=$("#pay-customer-name"), phone=$("#pay-phone"), addr=$("#pay-address");
    const err=$("#err-customer"); if(err) err.textContent="";
    if(!idEl) return;
    const had = !!idEl.value;
    idEl.value = c ? c.id : "";
    box?.classList.add("hide"); search?.setAttribute("aria-expanded","false");
    search?.classList.toggle("hide", !!c);
    if(search) search.value = "";
    chip?.classList.toggle("hide", !c);
    if(c && chip){
      chip.innerHTML = `<span class="pos-cust-av">${escHtml((c.name||"?").trim().charAt(0).toUpperCase())}</span>
        <span class="pos-cust-who"><strong>${escHtml(c.name)}</strong><small>${escHtml([c.email, c.contact].filter(Boolean).join(" · "))}${c.hasAccount ? "" : " · no online account yet"}</small></span>
        <button type="button" class="btn btn-ghost btn-sm" id="pay-cust-clear">Change</button>`;
      $("#pay-cust-clear").addEventListener("click", ()=>{ pickCustomer(null); $("#pay-cust-search")?.focus(); });
      if(name)  name.value  = c.name;
      if(phone && c.contact) phone.value = c.contact;
      if(addr && c.address && !addr.value) addr.value = c.address;
    } else if(had){
      if(name)  name.value  = "Walk-In Customer";
      if(phone) phone.value = "";
    }
    refreshQuote();
  }
  /* Suggestions drop down from the first letter typed (the matching part highlighted); arrow keys and Enter pick one. */
  let custTimer = 0, custSeq = 0, custHits = [], custActive = -1;
  const custBox = () => $("#pay-cust-results");
  const showCustBox = (html, input) => {
    const box = custBox(); box.innerHTML = html; box.classList.remove("hide");
    input.setAttribute("aria-expanded","true");
  };
  const markHit = (text, q) => {
    const s = String(text || ""), i = s.toLowerCase().indexOf(q.toLowerCase());
    return i < 0 ? escHtml(s) : escHtml(s.slice(0, i)) + `<mark>${escHtml(s.slice(i, i + q.length))}</mark>` + escHtml(s.slice(i + q.length));
  };
  const setCustActive = i => {
    const opts = [...custBox().querySelectorAll(".pos-cust-opt")];
    custActive = opts.length ? (i + opts.length) % opts.length : -1;
    opts.forEach((o, k) => o.classList.toggle("active", k === custActive));
    opts[custActive]?.scrollIntoView({ block: "nearest" });
  };
  const custHint = `<div class="pos-cust-none">Start typing a name, email or phone number to see matching customers.</div>`;
  $("#pay-cust-search")?.addEventListener("focus", e=>{ if(!e.target.value.trim()) showCustBox(custHint, e.target); });
  $("#pay-cust-search")?.addEventListener("input", e=>{
    const q = e.target.value.trim();
    clearTimeout(custTimer);
    if(!q){ custHits = []; showCustBox(custHint, e.target); return; }
    showCustBox(`<div class="pos-cust-none">Searching…</div>`, e.target);
    custTimer = setTimeout(async ()=>{
      const seq = ++custSeq;
      try {
        const { data } = await EbApi.get("pos/customers.php", { q });
        if(seq !== custSeq) return;
        custHits = data;
        showCustBox(data.length
          ? data.map((c,i)=>`<button type="button" class="pos-cust-opt" role="option" data-i="${i}">
              <span class="pos-cust-av">${escHtml((c.name||"?").trim().charAt(0).toUpperCase())}</span>
              <span class="pos-cust-who"><strong>${markHit(c.name, q)}</strong><small>${[c.email, c.contact].filter(Boolean).map(x => markHit(x, q)).join(" · ")}</small></span>
            </button>`).join("")
          : `<div class="pos-cust-none">No customer matches “${escHtml(q)}”. Leave it empty for a plain walk-in sale.</div>`, e.target);
        custBox().querySelectorAll(".pos-cust-opt").forEach(b => {
          b.addEventListener("mousedown", ev => ev.preventDefault());
          b.addEventListener("click", ()=> pickCustomer(custHits[+b.dataset.i]));
        });
        setCustActive(0);
      } catch(err){
        showCustBox(`<div class="pos-cust-none">Could not search customers: ${escHtml(err.message)}</div>`, e.target);
      }
    }, 200);
  });
  $("#pay-cust-search")?.addEventListener("keydown", e=>{
    const open = !custBox().classList.contains("hide");
    if(e.key === "ArrowDown" && open){ e.preventDefault(); setCustActive(custActive + 1); }
    else if(e.key === "ArrowUp" && open){ e.preventDefault(); setCustActive(custActive - 1); }
    else if(e.key === "Enter" && open && custHits[custActive]){ e.preventDefault(); pickCustomer(custHits[custActive]); }
    else if(e.key === "Escape"){ custBox().classList.add("hide"); e.target.setAttribute("aria-expanded","false"); }
  });
  document.addEventListener("click", e=>{
    if(!e.target.closest?.(".pos-cust-lookup")) $("#pay-cust-results")?.classList.add("hide");
  });

  $("#pay-retailer")?.addEventListener("change", ()=>{
    const err=$("#err-retailer"); if(err) err.textContent="";
    showRetailerStanding();
    fillFromRetailer();
    refreshQuote();
  });

  const wirePayCards=()=>{
    $$("#pay-method-grid .pay-card").forEach(card=>{
      card.addEventListener("click",()=>{
        payMethod=card.dataset.method;
        $$("#pay-method-grid .pay-card").forEach(c=>c.classList.toggle("selected",c===card));
        $("#pay-method").value=payMethod;
        const refField=$("#ref-num-field");
        /* GCash and bank each have their own reference field and rules (EbUI.splitRefField). */
        (posRef ||= EbUI.splitRefField($("#pay-refnum"), () => payMethod, $("#ref-num-field label"))).refresh();
        refField?.classList.toggle("hide", payMethod!=="gcash" && payMethod!=="bank");
        const tenderedField=$("#tendered-field");
        tenderedField?.classList.toggle("hide", payMethod!=="cash");
        if(payMethod==="cash") { const t=$("#pay-tendered"); if(t) t.placeholder=String(due); }
        syncRetailerField();
        if(customerType==="retailer") loadRetailers();
        /* A Net term adds interest to the amount due, so re-quote. */
        refreshQuote();
      });
    });
  };
  wirePayCards();

  $("#pay-tendered")?.addEventListener("input", syncChange);

  /* Reads the live form state at click time; placeOrder() disables the button during the request, preventing double sales. */
  posPlaceOrder = () => placeOrder(orderType, customerType, payMethod, due, $("#pay-retailer")?.value || null, scPwdPayload());
}

/* ===== PLACE ORDER + RECEIPT ===== */
function genTxnId(){
  const today = dAgo(0);
  const d = today.replace(/-/g,"");
  const n = String(ORDERS.filter(o=>o.date.startsWith(today)).length+1).padStart(3,"0");
  return `TXN-${d}-${n}`;
}

/* Send the cart to api/pos/checkout.php, which prices every line from the database and saves order and stock together; total is only used for the pre-submit cash check. */
async function placeOrder(orderType, customerType, payMethod, total, retailerId, scPwd = null){
  const name     = $("#pay-customer-name")?.value.trim()||"Walk-In Customer";
  const phone    = $("#pay-phone")?.value.trim()||"";
  const address  = $("#pay-address")?.value.trim()||"";
  const refNum   = $("#pay-refnum")?.value.trim()||"";
  const tendered = +($("#pay-tendered")?.value)||0;

  $("#err-address").textContent="";
  $("#err-refnum").textContent="";
  $("#pay-refnum")?.classList.remove("is-invalid");
  $("#err-general").textContent="";
  const errRetailer = $("#err-retailer");
  if(errRetailer) errRetailer.textContent="";
  ["#err-scpwd", "#err-scpwd-id", "#err-scpwd-name"].forEach(s=>{ const e=$(s); if(e) e.textContent=""; });

  if(!adminState.cart.length){ toast("The cart is empty.","warn"); return; }

  /* Quick client-side checks; the server checks everything again. */
  if(orderType==="delivery" && !address){ if($("#err-address")) $("#err-address").textContent="Delivery address required."; return; }
  if((payMethod==="gcash"||payMethod==="bank") && !refNum){ if($("#err-refnum")) $("#err-refnum").textContent="Reference number required."; return; }
  if((payMethod==="gcash"||payMethod==="bank") && refFormatError(payMethod, refNum)){
    if($("#err-refnum")) $("#err-refnum").textContent=refFormatError(payMethod, refNum);
    $("#pay-refnum")?.classList.add("is-invalid");
    ($("#pay-refnum")?._ebRef ? $("#pay-refnum")._ebRef.focus() : $("#pay-refnum")?.focus());
    return;
  }
  if(isCreditMethod(payMethod) && !retailerId){
    if(errRetailer) errRetailer.textContent="Choose which retailer this credit sale is for.";
    return;
  }
  if(scPwd && (!scPwd.id || !scPwd.name)){
    if(!scPwd.id)   { const e=$("#err-scpwd-id");   if(e) e.textContent="Enter the ID number on their card."; }
    if(!scPwd.name) { const e=$("#err-scpwd-name"); if(e) e.textContent="Enter the name on the ID."; }
    return;
  }
  /* total is the amount due from the last quote. */
  if(payMethod==="cash" && tendered < total && tendered !== 0){ toast(`Amount tendered must be at least ${EbFormat.pesoExact(total)}.`,"warn"); return; }

  /* place-order-btn is the real control. */
  const btn = $("#place-order-btn");
  const restore = EbUI.busy(btn, "Placing…");

  let order;
  try {
    const { data } = await EbApi.post("pos/checkout.php", {
      /* Send only ids and quantities; prices are the server's business. */
      items: adminState.cart.map(c => ({ id: c.productId, qty: c.qty })),
      order_type: orderType,
      customer_type: customerType,
      pay_method: payMethod,
      customer_name: name,
      contact: phone || null,
      address: address || null,
      destination: $("#pay-dest")?.value || "",
      ref_num: refNum || null,
      tendered: tendered || 0,
      /* Send the retailer id for any retailer sale; the server re-checks it. */
      retailer_id: customerType === "retailer" ? (retailerId || null) : null,
      /* A regular sale filed under a customer on record; the server re-checks it. */
      customer_id: customerType === "regular" ? ($("#pay-customer-id")?.value || null) : null,
      /* Senior/PWD details or null; the server applies the discount. */
      sc_pwd: scPwd,
    });
    order = data;
  } catch(err){
    /* Show every field error (known ones next to their input, others in the general line) and keep the cart for a retry, so a refusal is never silent. */
    if(err.isValidation){
      const fieldTargets = {
        address:     "#err-address",
        ref_num:     "#err-refnum",
        retailer_id: "#err-retailer",
        customer_id: "#err-customer",
        sc_pwd:      "#err-scpwd",
        sc_pwd_id:   "#err-scpwd-id",
        sc_pwd_name: "#err-scpwd-name",
      };
      const leftover = [];
      Object.entries(err.fields).forEach(([field, msg])=>{
        const sel = fieldTargets[field];
        const el  = sel ? $(sel) : null;
        if(el) el.textContent = msg;
        else leftover.push(msg);
      });
      if(leftover.length) $("#err-general").textContent = leftover.join(" ");
      /* The reference box: outline it and put the cursor there (e.g. a reference already used). */
      if(err.fields.ref_num){
        $("#pay-refnum")?.classList.add("is-invalid");
        ($("#pay-refnum")?._ebRef ? $("#pay-refnum")._ebRef.focus() : $("#pay-refnum")?.focus());
      }
      /* The toast names the actual problem; a validation error with no fields still has a message. */
      toast(leftover[0] || Object.values(err.fields)[0] || err.message, "err");
    } else {
      $("#err-general").textContent = err.message;
      toast(err.message, "err");
    }
    return;
  } finally {
    restore();
  }

  /* Only now clear the cart and reload stock from the database. */
  adminState.cart = [];
  /* Reset the Senior/PWD switch via the hook (see resetScPwd()). */
  if(typeof posResetScPwd === "function") posResetScPwd();
  updateCartBadge();
  await loadCatalog();
  await loadOrders();

  /* Build the Sales Invoice once for both screen and print. */
  const invoice = EbInvoice.fromOrder(order);
  EbInvoice.ensureStyles();
  openModal({
    title:"Order Placed — Sales Invoice",
    body: buildReceipt(order, invoice),
    confirmLabel:"Print",
    confirmClass:"btn-ghost",
    cancelLabel:"Close",
    large:true,
    onConfirm(){ EbInvoice.print(invoice); }
  });
  toast(`Order ${order.id} placed successfully.`,"ok");
  if(adminState.currentModule === "pos-payment") navigate("pos");
}

function buildReceipt(o, invoice = EbInvoice.fromOrder(o)){
  /* Till notes (cash, change, reference, due date) shown above the invoice but never printed. */
  const notes = [];
  if(o.payMethod === "cash" && o.tendered){
    notes.push(`Tendered <b>${peso(o.tendered)}</b>`, `Change <b>${peso(o.change)}</b>`);
  }
  if(o.refNum) notes.push(`Ref # <b>${escHtml(o.refNum)}</b>`);
  if(isCreditMethod(o.payMethod)){
    /* Use the server's due date, else count from today. */
    const due = (o.creditAccount && o.creditAccount.dueDate)
      || addDays(dAgo(0), {net30:30, net60:60, net90:90}[o.payMethod]);
    notes.push(`${escHtml(payMethodLabel(o.payMethod))} — due <b>${fmtDate(due)}</b>`);
  }
  return `${notes.length ? `<div class="invoice-till-note">${notes.join('<span aria-hidden="true">·</span>')}</div>` : ""}
    ${EbInvoice.render(invoice)}`;
}

/* ===== POS MODULE ENTRY POINTS (called from navigate()'s renders map) ===== */
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
