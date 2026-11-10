/* Attorney dashboard: review requests, place and resize the stamp, approve, check payments */
(() => {
  const { $, api, esc, bytes, date, copy } = window.HL;
  const PDFJS = "/vendor/pdfjs-3.11.174/";
  const icon = (id, style = "") => `<svg class="icon"${style ? ` style="${style}"` : ""}><use href="/assets/icons.svg#${id}"/></svg>`;
  const STATUS = {
    pending: "To review",
    awaiting_payment: "Awaiting payment",
    payment_review: "Check payment",
    completed: "Completed",
    rejected: "Declined",
  };
  const FILTERS = ["all", "pending", "awaiting_payment", "payment_review", "completed", "rejected"];
  const PRESETS = [
    "The image is not clear enough to read. Please upload a sharper scan or photo.",
    "Some pages are missing. Please upload every page of the document.",
    "This document cannot be attested online. Please visit the office with the original.",
  ];
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const els = {
    login: $("#loginView"),
    desk: $("#deskView"),
    bar: $("#barActions"),
    queue: $("#queue"),
    filters: $("#filters"),
    search: $("#search"),
    detail: $("#detail"),
    toast: $("#toast"),
  };
  let session = null;
  let items = [];
  let filter = "all";
  let current = null;
  let editor = null;

  /* ---------- Toast ---------- */
  let toastTimer;
  function toast(msg, bad = false) {
    els.toast.textContent = msg;
    els.toast.classList.toggle("is-bad", bad);
    els.toast.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("is-on"), 3600);
  }

  /* ---------- Session ---------- */
  async function call(path, opts) {
    try {
      return await api(path, opts);
    } catch (err) {
      if (err.status === 401) {
        session = { signedIn: false, configured: true };
        showLogin();
      }
      throw err;
    }
  }

  async function boot() {
    try {
      session = await api("/api/admin/session");
    } catch {
      session = { signedIn: false, configured: true };
    }
    if (!session.signedIn) return showLogin();
    els.login.hidden = true;
    els.desk.hidden = false;
    els.bar.hidden = false;
    await loadList();
    route();
  }

  function showLogin() {
    if (editor) editor.destroy();
    editor = null;
    els.desk.hidden = true;
    els.bar.hidden = true;
    els.login.hidden = false;
    const err = $("#loginError");
    if (session && !session.configured) {
      err.textContent = "The dashboard password has not been set up yet. Add ADMIN_PASSWORD (8+ characters) to the server's .env file and restart it.";
      err.hidden = false;
    }
    $("#loginForm").password.focus();
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const err = $("#loginError");
    const btn = form.querySelector("button");
    err.hidden = true;
    btn.disabled = true;
    try {
      await api("/api/admin/login", { method: "POST", json: { password: form.password.value } });
      form.reset();
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  $("#logoutBtn").addEventListener("click", async () => {
    await api("/api/admin/logout", { method: "POST" }).catch(() => {});
    history.replaceState(null, "", location.pathname);
    current = null;
    session = { signedIn: false, configured: true };
    showLogin();
  });

  $("#refreshBtn").addEventListener("click", async () => {
    await refresh();
    toast("Up to date");
  });

  async function refresh() {
    await loadList();
    if (current && !(editor && editor.dirty)) await open(current.id, true);
  }

  /* ---------- Stamp image ---------- */
  const stampDialog = $("#stampDialog");
  const stampForm = $("#stampForm");
  let stampFile = null;
  function openStampDialog() {
    stampFile = null;
    stampForm.reset();
    $("#stampError").hidden = true;
    $("#stampFileName").innerHTML = "Choose the stamp <u>PNG</u>";
    $("#stampSave").textContent = session.stampInstalled ? "Replace stamp" : "Upload stamp";
    $("#stampCurrent").innerHTML = session.stampInstalled
      ? `<div class="stamp-current"><img src="/api/admin/stamp.png?white=0&t=${Date.now()}" alt="Current stamp" /><span>Current stamp</span></div>`
      : `<p class="alert">${icon("x")}<span>No stamp uploaded yet. Upload it before approving your first document.</span></p>`;
    stampDialog.showModal();
  }
  $("#stampBtn").addEventListener("click", openStampDialog);
  stampDialog.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]") || e.target === stampDialog) stampDialog.close();
  });
  stampForm.stamp.addEventListener("change", () => {
    stampFile = stampForm.stamp.files[0] || null;
    if (stampFile) $("#stampFileName").textContent = `${stampFile.name} (${bytes(stampFile.size)})`;
  });
  stampForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#stampError");
    if (!stampFile) {
      err.textContent = "Please choose the stamp PNG first.";
      err.hidden = false;
      return;
    }
    const data = new FormData();
    data.append("stamp", stampFile, stampFile.name);
    const btn = $("#stampSave");
    btn.disabled = true;
    try {
      const res = await call("/api/admin/stamp", { method: "POST", body: data });
      session.stampInstalled = true;
      stampDialog.close();
      toast(res.warning || "Stamp saved. It will be used for new attestations.", Boolean(res.warning));
      if (current) renderDetail(current);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- Request list ---------- */
  async function loadList() {
    const before = items.filter((i) => i.status === "pending").length;
    items = await call("/api/admin/requests");
    const pending = items.filter((i) => i.status === "pending").length;
    if (session.listLoaded && pending > before) toast(`New request received (${plural(pending, "document")} to review)`);
    session.listLoaded = true;
    document.title = `${pending ? `(${pending}) ` : ""}Attestation Desk | HL Attorney at Law`;
    renderList();
  }

  const badge = (r) =>
    r.revoked ? `<span class="badge badge--revoked">Withdrawn</span>` : `<span class="badge badge--${r.status}">${STATUS[r.status]}</span>`;

  function renderList() {
    const count = (f) => (f === "all" ? items.length : items.filter((i) => i.status === f).length);
    els.filters.innerHTML = FILTERS.map(
      (f) =>
        `<button type="button" role="tab" data-filter="${f}" class="${f === filter ? "is-active" : ""}" aria-selected="${f === filter}">${f === "all" ? "All" : STATUS[f]} <b>${count(f)}</b></button>`
    ).join("");
    const q = els.search.value.trim().toLowerCase();
    const shown = items.filter(
      (i) =>
        (filter === "all" || i.status === filter) &&
        (!q || [i.name, i.email, i.ref, i.title].some((v) => String(v).toLowerCase().includes(q)))
    );
    els.queue.innerHTML = shown.length
      ? shown
          .map(
            (i) => `<li class="queue__item ${current && current.id === i.id ? "is-active" : ""}" data-id="${i.id}" tabindex="0">
              <div class="queue__row"><span class="queue__name">${esc(i.name)}</span>${badge(i)}</div>
              <span class="queue__title">${esc(i.title)}</span>
              <span class="queue__meta">${esc(i.ref)} · ${date(i.createdAt, true)} · ${plural(i.pages, "page")}</span>
            </li>`
          )
          .join("")
      : `<li class="queue__empty">${items.length ? "No requests match." : "No attestation requests yet.<br>New submissions will appear here."}</li>`;
  }

  els.filters.addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    filter = b.dataset.filter;
    renderList();
  });
  els.search.addEventListener("input", renderList);
  els.queue.addEventListener("click", (e) => {
    const li = e.target.closest("[data-id]");
    if (li) location.hash = li.dataset.id;
  });
  els.queue.addEventListener("keydown", (e) => {
    const li = e.target.closest("[data-id]");
    if (li && e.key === "Enter") location.hash = li.dataset.id;
  });

  /* ---------- Routing ---------- */
  addEventListener("hashchange", route);
  function route() {
    if (!session || !session.signedIn) return;
    const id = location.hash.slice(1);
    if (id) return open(id);
    if (editor) editor.destroy();
    editor = null;
    current = null;
    els.desk.classList.remove("has-detail");
    els.detail.innerHTML = `<div class="detail__empty"><div><img src="/assets/logo.png" alt="" /><p>Select a request to review it.</p></div></div>`;
    renderList();
  }

  async function open(id, keepScroll = false) {
    try {
      current = await call(`/api/admin/requests/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err.status !== 401) {
        toast(err.message, true);
        history.replaceState(null, "", location.pathname);
        route();
      }
      return;
    }
    els.desk.classList.add("has-detail");
    renderList();
    renderDetail(current);
    if (!keepScroll) {
      els.detail.scrollTop = 0;
      if (matchMedia("(max-width: 980px)").matches) scrollTo(0, 0);
    }
  }

  /* ---------- Detail ---------- */
  const money = (r) => `${r.review.currency} ${Number(r.review.fee).toFixed(2)}`;

  function renderDetail(r) {
    if (editor) editor.destroy();
    editor = null;
    const base = `/api/admin/requests/${r.id}`;
    const attested = Boolean(r.review && r.review.attestedAt);
    const editable = ["pending", "awaiting_payment"].includes(r.status);

    let html = `<div class="detail__inner">
      <div class="detail__head">
        <div>
          <button class="btn btn--quiet btn--sm back" type="button" data-action="back">${icon("arrow-right", "transform:rotate(180deg)")}All requests</button>
          <h1>${esc(r.document.title)}</h1>
          <p>${badge(r)}<span>${esc(r.ref)}</span><span>Submitted ${date(r.createdAt, true)}</span><span>${plural(r.document.pages, "page")}</span></p>
        </div>
        ${
          attested
            ? `<div class="links">
                <a class="chip-link" href="${base}/attested" target="_blank" rel="noopener">${icon("file-text")}<span>Open attested PDF</span></a>
                <a class="chip-link" href="${base}/attested?download=1">${icon("download")}<span>Download</span></a>
              </div>`
            : ""
        }
      </div>`;

    if (r.status === "rejected") {
      html += `<div class="box"><h2>Declined</h2><p class="note" style="margin:0">${esc(r.review.rejectReason)}</p></div>`;
    }
    if (attested) {
      const waiting = {
        awaiting_payment: "Waiting for the client to pay and upload the slip.",
        payment_review: "The client uploaded a slip. Please check it below.",
        completed: r.downloads ? `Downloaded ${plural(r.downloads, "time")}.` : "Ready. The client has not downloaded it yet.",
      }[r.status];
      html += `<div class="box"><h2>Attested copy</h2>
        <dl class="kv">
          <div><dt>Status</dt><dd>${esc(waiting || "")}</dd></div>
          <div><dt>Attested on</dt><dd>${esc(r.review.attestedDate)}</dd></div>
          <div><dt>Fee</dt><dd>${r.review.fee > 0 ? esc(money(r)) : "No fee"}</dd></div>
          <div><dt>Pages stamped</dt><dd>${r.review.placements.map((p) => p.page + 1).join(", ")}</dd></div>
          <div><dt>Verification</dt><dd><a href="/attest?ref=${encodeURIComponent(r.ref)}#verify" target="_blank" rel="noopener" style="color:var(--red)">${esc(r.ref)}</a></dd></div>
        </dl></div>`;
    }
    if (r.payment && r.payment.slip) html += paymentHtml(r, base);
    if (editable) html += editorHtml(r);
    html += `<div class="grid-2">${clientHtml(r)}${linkHtml(r)}</div>`;
    html += `<div class="grid-2">${filesHtml(r, base)}${historyHtml(r)}</div>`;
    html += dangerHtml(r, attested);
    html += `</div>`;
    els.detail.innerHTML = html;
    if (editable) editor = createEditor(r);
  }

  function paymentHtml(r, base) {
    const slip = r.payment.slip;
    const confirmed = Boolean(r.payment.confirmedAt);
    const label = confirmed
      ? `<span class="badge badge--completed">Confirmed</span>`
      : r.status === "payment_review"
        ? `<span class="badge badge--payment_review">Needs your check</span>`
        : "";
    const canAct = ["payment_review", "completed"].includes(r.status);
    return `<div class="box"><h2>Payment slip ${label}</h2>
      <dl class="kv">
        <div><dt>Amount due</dt><dd>${esc(money(r))}</dd></div>
        <div><dt>Uploaded</dt><dd>${date(slip.uploadedAt, true)}</dd></div>
        <div><dt>File</dt><dd>${esc(slip.name)} (${bytes(slip.size)})</dd></div>
      </dl>
      ${
        slip.kind === "pdf"
          ? `<div class="links"><a class="chip-link" href="${base}/slip" target="_blank" rel="noopener">${icon("file-text")}<span>Open slip (PDF)</span></a></div>`
          : `<a href="${base}/slip" target="_blank" rel="noopener"><img class="slip-preview" src="${base}/slip?v=${encodeURIComponent(slip.stored)}" alt="Payment slip" /></a>`
      }
      ${
        canAct
          ? `<div class="links" style="margin-top:16px">
              ${confirmed ? "" : `<button class="btn btn--green btn--sm" type="button" data-action="confirm-payment">${icon("check")}Payment received</button>`}
              <button class="btn btn--danger btn--sm" type="button" data-action="reject-payment">Slip not accepted…</button>
            </div>
            ${
              r.status === "completed" && !confirmed
                ? `<p class="hint" style="margin-top:10px">The client can already download the attested copy. If this payment is not in your account, choose “Slip not accepted”: the download is locked and the client is asked for a new slip.</p>`
                : ""
            }`
          : ""
      }
      ${r.payment.previousSlips && r.payment.previousSlips.length ? `<p class="hint" style="margin-top:10px">This slip replaced ${plural(r.payment.previousSlips.length, "earlier upload")}.</p>` : ""}
    </div>`;
  }

  function editorHtml(r) {
    const pending = r.status === "pending";
    const fee = r.review && r.review.fee !== undefined ? r.review.fee : session.defaultFee || "";
    const inner = `<div class="editor">
      <div class="viewer" id="viewer"><p class="viewer__msg">Loading document…</p></div>
      <div class="tools">
        <div class="box">
          <div class="pager">
            <button class="icon-btn" type="button" id="prevPage" aria-label="Previous page">${icon("arrow-right", "transform:rotate(180deg)")}</button>
            <b id="pageLabel">Page 1</b>
            <button class="icon-btn" type="button" id="nextPage" aria-label="Next page">${icon("arrow-right")}</button>
          </div>
          <div class="dots" id="dots"></div>
        </div>
        <div class="box" style="display:grid;gap:12px">
          <label class="toggle"><span>Stamp this page</span><input type="checkbox" id="stampHere" /></label>
          <div class="range"><div><span>Stamp size</span><span id="sizeLabel"></span></div><input type="range" id="size" min="8" max="80" step="1" aria-label="Stamp size" /></div>
          <button class="btn btn--quiet btn--block" type="button" id="applyAll">Use this position on every page</button>
          <label class="toggle"><span>White background</span><input type="checkbox" id="whiteBg" ${r.review && r.review.white === false ? "" : "checked"} /></label>
          <p class="hint">Drag the stamp to move it and drag a corner to resize it. Arrow keys nudge it, + and − change its size.</p>
        </div>
        <div class="box" style="display:grid;gap:12px">
          <label class="field"><span>Attestation fee</span><span class="fee"><span>${esc(session.currency)}</span><input id="fee" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(fee)}" /></span></label>
          <p class="hint">${pending ? "The client is emailed this amount with your bank details. Enter 0 to let them download without paying." : "Changes replace the attested PDF and update the client's payment page."}</p>
          ${
            pending
              ? `<button class="btn btn--primary btn--block" type="button" id="approveBtn">${icon("stamp")}Approve &amp; send to client</button>
                 <button class="btn btn--danger btn--block" type="button" id="declineToggle">Decline…</button>
                 <div class="decline" id="declineBox" hidden>
                   <div class="presets">${PRESETS.map((p) => `<button type="button">${esc(p)}</button>`).join("")}</div>
                   <textarea id="declineReason" rows="3" maxlength="1000" placeholder="Reason shown to the client"></textarea>
                   <button class="btn btn--danger btn--block" type="button" id="declineBtn">Decline &amp; notify client</button>
                 </div>`
              : `<label class="toggle"><span>Email the client again</span><input type="checkbox" id="notifyAgain" /></label>
                 <button class="btn btn--primary btn--block" type="button" id="approveBtn">${icon("stamp")}Update attested copy</button>`
          }
        </div>
      </div>
    </div>`;
    return pending
      ? `<div class="box"><h2>Place the attestation stamp</h2>${inner}</div>`
      : `<details class="box" id="editorDetails"><summary style="cursor:pointer;font-weight:600;color:var(--ink)">Adjust the stamp or fee</summary><div style="margin-top:16px">${inner}</div></details>`;
  }

  function clientHtml(r) {
    const c = r.client;
    let phone = c.phone.replace(/\D/g, "");
    if (phone.length === 7) phone = `960${phone}`;
    return `<div class="box"><h2>Client</h2>
      <dl class="kv">
        <div><dt>Name</dt><dd>${esc(c.name)}</dd></div>
        <div><dt>Email</dt><dd><a href="mailto:${esc(c.email)}" style="color:var(--red)">${esc(c.email)}</a></dd></div>
        <div><dt>Phone</dt><dd><a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a></dd></div>
        ${c.idNumber ? `<div><dt>ID / Passport</dt><dd>${esc(c.idNumber)}</dd></div>` : ""}
      </dl>
      ${r.document.notes ? `<p class="note">${esc(r.document.notes)}</p>` : ""}
      <div class="links"><a class="chip-link" href="https://wa.me/${phone}" target="_blank" rel="noopener">${icon("whatsapp")}<span>WhatsApp client</span></a></div>
    </div>`;
  }

  function linkHtml(r) {
    const MAIL = {
      received: "Request received",
      newRequest: "New request alert (you)",
      approved: "Attested: payment details",
      ready: "Ready to download",
      rejected: "Declined",
      slipUploaded: "Slip uploaded (you)",
      paymentRejected: "Slip not accepted",
    };
    const emails = [...r.emails].reverse();
    const mailState = (m) =>
      m.ok
        ? `<span class="mail-ok">Sent</span>`
        : m.mode === "outbox"
          ? `<span class="mail-warn" title="${esc(m.error || "")}">Not sent: email not set up</span>`
          : `<span class="mail-bad" title="${esc(m.error || "")}">Failed</span>`;
    let phone = r.client.phone.replace(/\D/g, "");
    if (phone.length === 7) phone = `960${phone}`;
    const shareText = `Hello ${r.client.name}, this is HL Attorney at Law about your attestation request ${r.ref}: ${r.trackUrl}`;
    return `<div class="box"><h2>Client link &amp; emails</h2>
      <p class="hint" style="margin-bottom:10px">Private page where the client pays and downloads. Share it if an email doesn't arrive.</p>
      <div class="links" style="margin-top:0">
        <button class="chip-link" type="button" data-copy="${esc(r.trackUrl)}">${icon("copy")}<span>Copy client link</span></button>
        <a class="chip-link" href="https://wa.me/${phone}?text=${encodeURIComponent(shareText)}" target="_blank" rel="noopener">${icon("whatsapp")}<span>Send by WhatsApp</span></a>
        ${["pending", "rejected", "awaiting_payment", "completed"].includes(r.status) ? `<button class="chip-link" type="button" data-action="resend">${icon("mail")}<span>Resend email</span></button>` : ""}
      </div>
      <ul class="history" style="margin-top:16px">${
        emails.length
          ? emails.map((m) => `<li><span>${esc(MAIL[m.type] || m.type)} · ${mailState(m)}</span><time>${date(m.at, true)}</time></li>`).join("")
          : `<li><span class="hint">No emails yet.</span></li>`
      }</ul>
    </div>`;
  }

  function filesHtml(r, base) {
    return `<div class="box"><h2>Uploaded files</h2>
      <div class="links" style="margin-top:0">
        ${r.document.files
          .map((f, i) => `<a class="chip-link" href="${base}/original/${i}">${icon("download")}<span>${esc(f.name)} · ${bytes(f.size)}</span></a>`)
          .join("")}
        <a class="chip-link" href="${base}/document" target="_blank" rel="noopener">${icon("file-text")}<span>Combined PDF (unstamped)</span></a>
      </div></div>`;
  }

  function historyHtml(r) {
    return `<div class="box"><h2>History</h2><ul class="history">${[...r.history]
      .reverse()
      .map((h) => `<li><span>${esc(h.event[0].toUpperCase() + h.event.slice(1))}</span><time>${date(h.at, true)}</time></li>`)
      .join("")}</ul></div>`;
  }

  function dangerHtml(r, attested) {
    return `<div class="box"><h2>More actions</h2><div class="links" style="margin-top:0">
      ${
        attested
          ? r.revoked
            ? `<button class="btn btn--quiet btn--sm" type="button" data-action="restore">Restore attestation</button>`
            : `<button class="btn btn--danger btn--sm" type="button" data-action="revoke">Withdraw attestation</button>`
          : ""
      }
      <button class="btn btn--danger btn--sm" type="button" data-action="delete">Delete request</button>
    </div>
    <p class="hint" style="margin-top:10px">Withdrawing blocks the download and shows the reference as withdrawn on the verification page. Deleting removes the request and all its files permanently.</p></div>`;
  }

  /* ---------- Actions ---------- */
  els.detail.addEventListener("click", async (e) => {
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) return copy(copyBtn.dataset.copy, copyBtn);
    const btn = e.target.closest("[data-action]");
    if (!btn || !current) return;
    const id = current.id;
    const run = async (path, json, message) => {
      btn.disabled = true;
      try {
        const updated = await call(`/api/admin/requests/${id}${path}`, { method: "POST", json });
        toast(message);
        await loadList();
        if (updated && updated.id) {
          current = updated;
          renderDetail(updated);
        } else await open(id, true);
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    };
    switch (btn.dataset.action) {
      case "back":
        location.hash = "";
        break;
      case "stamp":
        openStampDialog();
        break;
      case "confirm-payment":
        if (confirm("Confirm that this payment is in your account?")) run("/payment", { action: "confirm" }, "Payment confirmed.");
        break;
      case "reject-payment": {
        const note = prompt("Why was the slip not accepted? This is shown to the client.", "We could not find this payment in our account. Please check the amount and upload the correct slip.");
        if (note !== null) run("/payment", { action: "reject", note }, "The client has been asked for a new slip.");
        break;
      }
      case "resend":
        run("/resend", {}, session.emailConfigured ? "Email sent again." : "Email is not set up, so it was saved to the outbox instead.");
        break;
      case "revoke":
        if (confirm("Withdraw this attestation? The client can no longer download it and verification will show it as withdrawn.")) run("/revoke", { revoked: true }, "Attestation withdrawn.");
        break;
      case "restore":
        run("/revoke", { revoked: false }, "Attestation restored.");
        break;
      case "delete":
        if (!confirm(`Delete request ${current.ref} and all its files? This cannot be undone.`)) return;
        try {
          await call(`/api/admin/requests/${id}`, { method: "DELETE" });
          toast("Request deleted.");
          history.replaceState(null, "", location.pathname);
          await loadList();
          route();
        } catch (err) {
          toast(err.message, true);
        }
        break;
    }
  });

  /* ---------- Stamp editor ---------- */
  let pdfjsPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    pdfjsPromise =
      pdfjsPromise ||
      new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `${PDFJS}pdf.min.js`;
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.js`;
          resolve(window.pdfjsLib);
        };
        s.onerror = () => {
          pdfjsPromise = null;
          reject(new Error("The PDF viewer could not be loaded."));
        };
        document.head.append(s);
      });
    return pdfjsPromise;
  }

  // Draws the stamp with today's date and the reference, the same way the server prints it.
  async function stampImage(r, white) {
    const S = session.stamp;
    const img = new Image();
    img.src = `/api/admin/stamp.png?white=${white ? 1 : 0}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = S.width;
    canvas.height = S.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, S.width, S.height);
    ctx.fillStyle = `rgb(${S.color.join(",")})`;
    ctx.textBaseline = "alphabetic";
    const bold = (s) => `bold ${s}px Helvetica, Arial, sans-serif`;
    const regular = (s) => `${s}px Helvetica, Arial, sans-serif`;
    const width = (font, text) => ((ctx.font = font), ctx.measureText(text).width);

    const today = new Intl.DateTimeFormat("en-GB", { timeZone: session.timezone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
    const dw = width(bold(S.date.size), today);
    const ds = dw > S.date.maxWidth ? (S.date.size * S.date.maxWidth) / dw : S.date.size;
    ctx.font = bold(ds);
    ctx.textAlign = "center";
    ctx.fillText(today, S.date.centerX, S.date.baseline);

    const label = "Ref: ";
    const refWidth = (s) => width(regular(s), label) + width(bold(s), r.ref);
    const rs = Math.min(S.ref.size, (S.ref.size * S.ref.maxWidth) / refWidth(S.ref.size));
    const left = S.ref.right - refWidth(rs);
    ctx.textAlign = "left";
    ctx.font = regular(rs);
    ctx.fillText(label, left, S.ref.baseline);
    const labelWidth = ctx.measureText(label).width;
    ctx.font = bold(rs);
    ctx.fillText(r.ref, left + labelWidth, S.ref.baseline);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(URL.createObjectURL(b)), "image/png"));
  }

  function createEditor(r) {
    const sizes = r.document.pageSizes;
    const S = session.stamp;
    const ratio = S.height / S.width;
    const hf = (page) => (ratio * sizes[page].w) / sizes[page].h; // stamp height (page fraction) per unit of width
    const state = { page: 0, placements: new Map(), last: null, pdf: null, task: null, dirty: false, destroyed: false, urls: {} };
    const ui = {
      viewer: $("#viewer"),
      label: $("#pageLabel"),
      dots: $("#dots"),
      here: $("#stampHere"),
      size: $("#size"),
      sizeLabel: $("#sizeLabel"),
      white: $("#whiteBg"),
      fee: $("#fee"),
      approve: $("#approveBtn"),
    };

    const defaultPlacement = (page) => {
      const w = Math.min(0.5, 184 / sizes[page].w); // about 6.5 cm wide on any page size
      return { x: 0.06, y: Math.max(0, 1 - w * hf(page) - 0.05), w };
    };
    const fit = (page, p) => {
      const w = clamp(p.w, 0.04, Math.min(0.95, 0.95 / hf(page)));
      return { w, x: clamp(p.x, 0, 1 - w), y: clamp(p.y, 0, 1 - w * hf(page)) };
    };
    const set = (page, p) => {
      const placed = fit(page, p);
      state.placements.set(page, placed);
      state.last = { page, ...placed };
      state.dirty = true;
      return placed;
    };

    if (r.review && r.review.placements && r.review.placements.length) {
      r.review.placements.forEach((p) => state.placements.set(p.page, { x: p.x, y: p.y, w: p.w }));
    } else {
      sizes.forEach((_, i) => state.placements.set(i, defaultPlacement(i)));
    }
    state.dirty = false;

    // Page surface: canvas for the PDF page plus a layer with the draggable stamp
    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.innerHTML = `<canvas></canvas><div class="stamp-layer"><div class="stamp-box" tabindex="0" role="slider" aria-label="Stamp position. Use the arrow keys to move it.">
      <img alt="" draggable="false" /><span class="handle handle--nw" data-h="nw"></span><span class="handle handle--ne" data-h="ne"></span>
      <span class="handle handle--sw" data-h="sw"></span><span class="handle handle--se" data-h="se"></span></div></div>`;
    const canvas = wrap.querySelector("canvas");
    const layer = wrap.querySelector(".stamp-layer");
    const box = wrap.querySelector(".stamp-box");
    const boxImg = box.querySelector("img");

    async function refreshStampImage() {
      const key = ui.white.checked ? "white" : "clear";
      if (!state.urls[key]) state.urls[key] = await stampImage(r, ui.white.checked);
      if (!state.destroyed) boxImg.src = state.urls[key];
    }

    function drawStamp() {
      const p = state.placements.get(state.page);
      box.hidden = !p;
      if (!p) return;
      box.style.left = `${p.x * 100}%`;
      box.style.top = `${p.y * 100}%`;
      box.style.width = `${p.w * 100}%`;
    }

    function drawControls() {
      const p = state.placements.get(state.page);
      ui.label.textContent = `Page ${state.page + 1} of ${sizes.length}`;
      $("#prevPage").disabled = state.page === 0;
      $("#nextPage").disabled = state.page === sizes.length - 1;
      ui.here.checked = Boolean(p);
      ui.size.disabled = !p;
      $("#applyAll").disabled = !p || sizes.length === 1;
      if (p) {
        ui.size.value = Math.round(p.w * 100);
        ui.sizeLabel.textContent = `${Math.round(p.w * 100)}% of page width`;
      } else ui.sizeLabel.textContent = "Not stamped";
      ui.dots.innerHTML = sizes
        .map(
          (_, i) =>
            `<button type="button" data-page="${i}" class="${state.placements.has(i) ? "is-stamped" : ""} ${i === state.page ? "is-current" : ""}" aria-label="Page ${i + 1}${state.placements.has(i) ? ", stamped" : ""}">${i + 1}</button>`
        )
        .join("");
      ui.dots.hidden = sizes.length === 1;
    }

    async function renderPage() {
      const page = await state.pdf.getPage(state.page + 1);
      if (state.destroyed) return;
      const base = page.getViewport({ scale: 1 });
      wrap.style.aspectRatio = `${base.width} / ${base.height}`;
      wrap.style.width = `min(100%, calc((100svh - 250px) * ${base.width / base.height}))`;
      if (!wrap.isConnected) {
        ui.viewer.innerHTML = "";
        ui.viewer.append(wrap);
      }
      const cssWidth = wrap.getBoundingClientRect().width || 700;
      const viewport = page.getViewport({ scale: Math.min(4, (cssWidth * (window.devicePixelRatio || 1)) / base.width) });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      if (state.task) state.task.cancel();
      state.task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
      try {
        await state.task.promise;
      } catch (err) {
        if (err && err.name !== "RenderingCancelledException") throw err;
      }
    }

    async function goTo(page) {
      state.page = clamp(page, 0, sizes.length - 1);
      drawStamp();
      drawControls();
      if (state.pdf) await renderPage();
    }

    function resize(w) {
      const p = state.placements.get(state.page);
      if (!p) return;
      const h = hf(state.page);
      const cx = p.x + p.w / 2;
      const cy = p.y + (p.w * h) / 2;
      set(state.page, { w, x: cx - w / 2, y: cy - (w * h) / 2 });
      drawStamp();
      drawControls();
    }

    // Drag to move; drag a corner handle to resize around the opposite corner
    box.addEventListener("pointerdown", (e) => {
      const p = state.placements.get(state.page);
      if (!p || e.button > 0) return;
      e.preventDefault();
      box.focus();
      box.setPointerCapture(e.pointerId);
      box.classList.add("is-dragging");
      const corner = e.target.closest(".handle")?.dataset.h;
      const rect = layer.getBoundingClientRect();
      const h = hf(state.page);
      const start = { cx: e.clientX, cy: e.clientY, ...p };
      const ax = corner && corner.includes("w") ? p.x + p.w : p.x;
      const ay = corner && corner.includes("n") ? p.y + p.w * h : p.y;
      const move = (ev) => {
        if (!corner) {
          set(state.page, {
            w: start.w,
            x: start.x + (ev.clientX - start.cx) / rect.width,
            y: start.y + (ev.clientY - start.cy) / rect.height,
          });
        } else {
          const px = (ev.clientX - rect.left) / rect.width;
          const py = (ev.clientY - rect.top) / rect.height;
          const maxW = Math.min(corner.includes("w") ? ax : 1 - ax, (corner.includes("n") ? ay : 1 - ay) / h);
          const w = clamp(Math.max(Math.abs(px - ax), Math.abs(py - ay) / h), 0.04, maxW);
          set(state.page, { w, x: corner.includes("w") ? ax - w : ax, y: corner.includes("n") ? ay - w * h : ay });
        }
        drawStamp();
      };
      const end = () => {
        box.removeEventListener("pointermove", move);
        box.removeEventListener("pointerup", end);
        box.removeEventListener("pointercancel", end);
        box.classList.remove("is-dragging");
        drawControls();
      };
      box.addEventListener("pointermove", move);
      box.addEventListener("pointerup", end);
      box.addEventListener("pointercancel", end);
    });

    box.addEventListener("keydown", (e) => {
      const p = state.placements.get(state.page);
      if (!p) return;
      const step = e.shiftKey ? 0.02 : 0.004;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        e.preventDefault();
        set(state.page, { w: p.w, x: p.x + moves[e.key][0], y: p.y + moves[e.key][1] });
        drawStamp();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        resize(p.w + 0.01);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        resize(p.w - 0.01);
      }
    });

    $("#prevPage").addEventListener("click", () => goTo(state.page - 1));
    $("#nextPage").addEventListener("click", () => goTo(state.page + 1));
    ui.dots.addEventListener("click", (e) => {
      const b = e.target.closest("[data-page]");
      if (b) goTo(Number(b.dataset.page));
    });
    ui.size.addEventListener("input", () => resize(Number(ui.size.value) / 100));
    ui.here.addEventListener("change", () => {
      if (ui.here.checked) {
        const from = state.last && state.last.page !== state.page ? adapt(state.last, state.page) : defaultPlacement(state.page);
        set(state.page, from);
      } else {
        state.placements.delete(state.page);
        state.dirty = true;
      }
      drawStamp();
      drawControls();
    });
    // Same physical size and the same distance from the left and bottom edges on another page
    function adapt(p, page) {
      const w = (p.w * sizes[p.page].w) / sizes[page].w;
      const bottom = 1 - (p.y + p.w * hf(p.page));
      return { w, x: p.x, y: 1 - bottom - w * hf(page) };
    }
    $("#applyAll").addEventListener("click", () => {
      const p = { page: state.page, ...state.placements.get(state.page) };
      sizes.forEach((_, i) => i !== state.page && state.placements.set(i, fit(i, adapt(p, i))));
      state.dirty = true;
      drawControls();
      toast(`Stamp placed on all ${sizes.length} pages.`);
    });
    ui.white.addEventListener("change", () => {
      state.dirty = true;
      refreshStampImage();
    });

    // Approve / update
    ui.approve.addEventListener("click", async () => {
      const raw = ui.fee.value.trim();
      const fee = Number(raw);
      if (raw === "" || !Number.isFinite(fee) || fee < 0) {
        toast("Enter the attestation fee (0 or more).", true);
        return ui.fee.focus();
      }
      if (!state.placements.size) return toast("Place the stamp on at least one page.", true);
      const pending = r.status === "pending";
      const pages = [...state.placements.keys()].map((i) => i + 1).join(", ");
      const message = pending
        ? `Attest page ${pages} and approve?\n\n${
            fee > 0
              ? `${r.client.email} will be emailed the fee (${session.currency} ${fee.toFixed(2)}) and your bank details.`
              : `${r.client.email} will be able to download the attested copy straight away (no fee).`
          }`
        : "Replace the attested PDF with these settings?";
      if (!confirm(message)) return;
      const label = ui.approve.innerHTML;
      ui.approve.disabled = true;
      ui.approve.textContent = "Stamping…";
      try {
        const updated = await call(`/api/admin/requests/${r.id}/approve`, {
          method: "POST",
          json: {
            placements: [...state.placements].map(([page, p]) => ({ page, ...p })),
            white: ui.white.checked,
            fee,
            notify: Boolean($("#notifyAgain") && $("#notifyAgain").checked),
          },
        });
        state.dirty = false;
        toast(
          pending
            ? session.emailConfigured
              ? "Approved. The client has been emailed."
              : "Approved. Email isn't set up yet, so send the client their link below."
            : "Attested copy updated."
        );
        await loadList();
        current = updated;
        renderDetail(updated);
      } catch (err) {
        toast(err.message, true);
        ui.approve.disabled = false;
        ui.approve.innerHTML = label;
      }
    });

    // Decline
    const declineToggle = $("#declineToggle");
    if (declineToggle) {
      const declineBox = $("#declineBox");
      const reason = $("#declineReason");
      declineToggle.addEventListener("click", () => {
        declineBox.hidden = !declineBox.hidden;
        if (!declineBox.hidden) reason.focus();
      });
      declineBox.querySelector(".presets").addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (b) reason.value = b.textContent;
      });
      $("#declineBtn").addEventListener("click", async () => {
        if (!reason.value.trim()) return toast("Please give the client a reason.", true), reason.focus();
        if (!confirm(`Decline this request and email ${r.client.email}?`)) return;
        try {
          const updated = await call(`/api/admin/requests/${r.id}/reject`, { method: "POST", json: { reason: reason.value } });
          toast("Request declined. The client has been notified.");
          await loadList();
          current = updated;
          renderDetail(updated);
        } catch (err) {
          toast(err.message, true);
        }
      });
    }

    // Load lazily: straight away for new requests, on open for the collapsed "adjust" panel
    let started = false;
    async function start() {
      if (started) return;
      started = true;
      drawControls();
      if (!session.stampInstalled) {
        ui.approve.disabled = true;
        ui.viewer.innerHTML = `<div class="viewer__msg"><p style="margin:0 0 14px">Upload your attestation stamp before approving documents.</p>
          <button class="btn btn--primary btn--sm" type="button" data-action="stamp">${icon("upload")}Upload stamp</button></div>`;
        return;
      }
      try {
        await refreshStampImage();
        const lib = await loadPdfJs();
        state.pdf = await lib.getDocument({ url: `/api/admin/requests/${r.id}/document`, withCredentials: true }).promise;
        if (state.destroyed) return;
        await renderPage();
        drawStamp();
      } catch (err) {
        ui.viewer.innerHTML = `<p class="viewer__msg">${esc(err.message || "The document could not be displayed.")}</p>`;
      }
    }
    const details = $("#editorDetails");
    if (details) details.addEventListener("toggle", () => details.open && start());
    else start();

    let resizeTimer;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => state.pdf && wrap.isConnected && renderPage(), 200);
    };
    addEventListener("resize", onResize);

    return {
      get dirty() {
        return state.dirty;
      },
      destroy() {
        state.destroyed = true;
        removeEventListener("resize", onResize);
        if (state.task) state.task.cancel();
        if (state.pdf) state.pdf.destroy();
        Object.values(state.urls).forEach((u) => URL.revokeObjectURL(u));
      },
    };
  }

  /* ---------- Auto refresh ---------- */
  setInterval(() => {
    if (!document.hidden && session && session.signedIn) loadList().catch(() => {});
  }, 60_000);
  addEventListener("focus", () => session && session.signedIn && loadList().catch(() => {}));

  boot();
})();
