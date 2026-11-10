/* Client tracking page: status, payment details, slip upload and download */
(() => {
  const { $, esc, api, date, copy } = window.HL;
  const token = location.pathname.split("/").filter(Boolean)[1] || "";
  const card = $("#statusCard");
  const icon = (id) => `<svg class="icon"><use href="/assets/icons.svg#${id}"/></svg>`;
  const money = (fee) => `${esc(fee.currency)} ${Number(fee.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const STEPS = ["Submitted", "Attested", "Payment", "Download"];
  const STAGE = { pending: 1, rejected: 1, awaiting_payment: 2, payment_review: 2, completed: 4 };

  function timeline(r) {
    const stage = STAGE[r.status];
    return `<ol class="timeline">${STEPS.map((label, i) => {
      let cls = i < stage ? "is-done" : i === stage ? "is-current" : "";
      let mark = i < stage ? icon("check") : i + 1;
      if (r.status === "rejected" && i === 1) (cls = "is-bad"), (mark = icon("x"));
      if (r.status === "completed" && i === 3) cls = "is-done";
      return `<li class="${cls}"><span>${mark}</span>${label}</li>`;
    }).join("")}</ol>`;
  }

  function bankCard(r) {
    const b = r.bank;
    const row = (label, value, copyable) =>
      `<div><dt>${label}</dt><dd>${esc(value)}${copyable ? `<button class="copy-btn" type="button" data-copy="${esc(value)}">${icon("copy")}Copy</button>` : ""}</dd></div>`;
    return `<div class="bank">
      <div class="bank__head"><div><small>Amount to pay</small><b>${money(r.fee)}</b></div>${icon("bank")}</div>
      <dl>${row("Bank", b.bankName)}${row("Account name", b.accountName)}${row("Account number", b.accountNumber, true)}${row("Transfer remark", r.ref, true)}</dl>
    </div>`;
  }

  const slipForm = (label) => `
    <form id="slipForm" class="form-card" style="box-shadow:none;padding:0;border:0;gap:12px" novalidate>
      <div class="drop" id="slipDrop">
        <input type="file" name="slip" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" aria-label="Choose payment slip" />
        <span class="drop__icon">${icon("upload")}</span>
        <b id="slipName">Drop your payment slip here or <u>browse</u></b>
        <small>Screenshot or PDF of the transfer · JPG, PNG or PDF · max 10 MB</small>
      </div>
      <div class="progress" hidden><span></span></div>
      <p class="alert" role="alert" hidden></p>
      <button class="btn btn--primary btn--block" type="submit">${label}</button>
    </form>`;

  function render(r) {
    document.title = `${r.ref} | HL Attorney at Law`;
    $("#trackTitle").innerHTML = `Request <em class="code">${esc(r.ref)}</em>`;
    $("#trackLead").textContent = `${r.title} · submitted ${date(r.createdAt)}`;
    $("#summary").hidden = false;
    $("#summaryList").innerHTML = [
      ["Reference", r.ref],
      ["Document", r.title],
      ["Pages", r.pages],
      ["Name", r.name],
      ["Submitted", date(r.createdAt)],
      ...(r.attestedOn ? [["Attested on", r.attestedOn]] : []),
      ...(r.fee && r.fee.amount > 0 ? [["Fee", money(r.fee)]] : []),
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`)
      .join("");

    let html = timeline(r);
    if (r.revoked) {
      html += `<h2>This attestation has been withdrawn</h2><p>Please contact the office for more information.</p>`;
    } else if (r.status === "pending") {
      html += `<div class="result" style="padding:12px 0 0"><span class="result__badge result__badge--wait">${icon("clock")}</span>
        <h2>Your document is being reviewed</h2>
        <p>The attorney is checking your document. You'll receive an email as soon as it is attested, with the fee and payment details.</p></div>`;
    } else if (r.status === "rejected") {
      html += `<div class="result" style="padding:12px 0 0"><span class="result__badge result__badge--bad">${icon("x")}</span>
        <h2>We couldn't attest this document</h2>
        ${r.rejectReason ? `<p class="note" style="text-align:left;max-width:100%">${esc(r.rejectReason)}</p>` : ""}
        <p>You're welcome to submit a new request with a corrected document.</p>
        <div class="result__actions"><a class="btn btn--primary" href="/attest">Submit a new request</a></div></div>`;
    } else if (r.status === "awaiting_payment") {
      html += `<h2>Your document is attested</h2>
        <p>To download your attested copy, transfer the fee to the account below, then upload your payment slip.</p>
        ${r.paymentNote ? `<p class="alert">${icon("x")}<span><b>Your previous slip was not accepted.</b><br>${esc(r.paymentNote)}</span></p>` : ""}
        ${bankCard(r)}
        ${slipForm("Upload slip & unlock download")}`;
    } else if (r.status === "payment_review") {
      html += `<div class="result" style="padding:12px 0 0"><span class="result__badge result__badge--wait">${icon("receipt")}</span>
        <h2>Payment slip received</h2>
        <p>Thank you. We're confirming your payment and will email you as soon as your attested copy is ready to download.</p></div>
        <details style="margin-top:18px"><summary style="cursor:pointer;color:var(--red);font-weight:600">Uploaded the wrong file?</summary>
        <div style="margin-top:14px">${slipForm("Replace payment slip")}</div></details>`;
    } else if (r.status === "completed") {
      html += `<div class="result" style="padding:12px 0 0"><span class="result__badge">${icon("check")}</span>
        <h2>Your attested copy is ready</h2>
        <p>Download your attested PDF below. Anyone can confirm it is genuine on our website with the reference <b>${esc(r.ref)}</b>.</p>
        <div class="result__actions">
          <a class="btn btn--primary" href="/api/track/${esc(token)}/download">${icon("download")}Download attested PDF</a>
          <a class="btn btn--outline" href="/attest?ref=${encodeURIComponent(r.ref)}#verify">Verify</a>
        </div></div>`;
    }
    card.innerHTML = html;
    card.dataset.status = r.revoked ? "revoked" : r.status;
    delete card.dataset.busy;
    wireSlipForm();
  }

  function wireSlipForm() {
    const form = $("#slipForm");
    if (!form) return;
    const drop = $("#slipDrop", form);
    const input = form.slip;
    const alertBox = $(".alert", form);
    const progress = $(".progress", form);
    const button = $("button[type=submit]", form);
    let file = null;
    const pick = (f) => {
      if (!f) return;
      if (!/\.(pdf|jpe?g|png)$/i.test(f.name) && !/^(application\/pdf|image\/(jpeg|png))$/.test(f.type)) {
        return show("Please choose a JPG, PNG or PDF file.");
      }
      if (f.size > 10 * 1024 * 1024) return show("The slip must be smaller than 10 MB.");
      file = f;
      card.dataset.busy = "1";
      show("");
      drop.classList.remove("is-error");
      $("#slipName").textContent = `${f.name} (${window.HL.bytes(f.size)})`;
    };
    const show = (msg) => {
      alertBox.textContent = msg;
      alertBox.hidden = !msg;
    };
    input.addEventListener("change", () => pick(input.files[0]));
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => (e.preventDefault(), drop.classList.add("is-over"))));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("is-over")));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      pick(e.dataTransfer.files[0]);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!file) {
        drop.classList.add("is-error");
        return show("Please choose your payment slip first.");
      }
      const data = new FormData();
      data.append("slip", file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/track/${token}/slip`);
      xhr.responseType = "json";
      progress.hidden = false;
      button.disabled = true;
      button.textContent = "Uploading…";
      xhr.upload.onprogress = (ev) => ev.lengthComputable && (progress.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`);
      xhr.onload = () => {
        if (xhr.status === 200) return render(xhr.response);
        progress.hidden = true;
        button.disabled = false;
        button.textContent = "Try again";
        show((xhr.response && xhr.response.error) || "Upload failed. Please try again.");
      };
      xhr.onerror = () => {
        progress.hidden = true;
        button.disabled = false;
        button.textContent = "Try again";
        show("Connection problem. Please try again.");
      };
      xhr.send(data);
    });
  }

  card.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (b) copy(b.dataset.copy, b);
  });

  async function load() {
    try {
      render(await api(`/api/track/${encodeURIComponent(token)}`));
    } catch (err) {
      $("#trackTitle").textContent = "Request not found";
      $("#trackLead").textContent = "";
      card.innerHTML = `<div class="result"><span class="result__badge result__badge--bad">${icon("x")}</span>
        <h2>We couldn't find this request</h2><p>${esc(err.message)}</p>
        <div class="result__actions"><a class="btn btn--primary" href="/attest">Start a new attestation</a></div></div>`;
    }
  }
  load();

  // Refresh while waiting for the attorney (without disturbing an upload in progress)
  setInterval(() => {
    if (document.hidden || card.dataset.busy) return;
    if (["pending", "payment_review"].includes(card.dataset.status)) load();
  }, 60_000);
})();
