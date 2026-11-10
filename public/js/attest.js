/* Attestation request form + verification */
(() => {
  const { $, $$, esc, bytes, api, copy, SITE, shrinkImage, uploadFile } = window.HL;
  const LIMITS = SITE.attestation;
  const MB = 1024 * 1024;
  const OK_TYPES = ["application/pdf", "image/jpeg", "image/png"];
  const OK_EXT = /\.(pdf|jpe?g|png)$/i;

  const form = $("#attestForm");
  const drop = $("#drop");
  const input = $("#fileInput");
  const list = $("#fileList");
  const errorBox = $("#formError");
  const submitBtn = $("#submitBtn");
  const progress = $("#progress");
  let files = [];

  $("[data-limits]").textContent = `PDF, JPG or PNG · up to ${LIMITS.maxFiles} files · ${LIMITS.maxFileMB} MB each`;

  const showError = (msg) => {
    errorBox.textContent = msg;
    errorBox.hidden = !msg;
    if (msg) errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  /* ---- Files ---- */
  let adding = Promise.resolve();
  const addFiles = (incoming) => (adding = adding.then(() => addNow(incoming)));

  async function addNow(incoming) {
    const problems = [];
    drop.classList.add("is-busy");
    for (const original of incoming) {
      if (!OK_TYPES.includes(original.type) && !OK_EXT.test(original.name)) {
        problems.push(`"${original.name}" is not a PDF, JPG or PNG.`);
        continue;
      }
      const f = await shrinkImage(original);
      if (f.size > LIMITS.maxFileMB * MB) problems.push(`"${f.name}" is larger than ${LIMITS.maxFileMB} MB.`);
      else if (files.length >= LIMITS.maxFiles) problems.push(`You can upload up to ${LIMITS.maxFiles} files.`);
      else if (files.reduce((s, x) => s + x.size, f.size) > LIMITS.maxTotalMB * MB) {
        problems.push(`All files together must be under ${LIMITS.maxTotalMB} MB, so "${f.name}" was not added.`);
      } else if (!files.some((x) => x.name === f.name && x.size === f.size)) files.push(f);
    }
    drop.classList.remove("is-busy", "is-error");
    showError([...new Set(problems)].join(" "));
    render();
  }

  function render() {
    list.querySelectorAll("img").forEach((img) => URL.revokeObjectURL(img.src));
    list.innerHTML = files
      .map((f, i) => {
        const isImage = /^image\//.test(f.type) || /\.(jpe?g|png)$/i.test(f.name);
        const thumb = isImage
          ? `<img class="file__thumb" alt="" src="${URL.createObjectURL(f)}">`
          : `<span class="file__thumb">PDF</span>`;
        return `<li class="file">${thumb}
          <div style="min-width:0"><div class="file__name">${esc(f.name)}</div><div class="file__meta">${bytes(f.size)}</div></div>
          <div class="file__actions">
            <button type="button" class="icon-btn icon-btn--up" data-move="${i},-1" aria-label="Move up" ${i === 0 ? "disabled" : ""}><svg class="icon"><use href="/assets/icons.svg#arrow-right"/></svg></button>
            <button type="button" class="icon-btn icon-btn--down" data-move="${i},1" aria-label="Move down" ${i === files.length - 1 ? "disabled" : ""}><svg class="icon"><use href="/assets/icons.svg#arrow-right"/></svg></button>
            <button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove ${esc(f.name)}"><svg class="icon"><use href="/assets/icons.svg#x"/></svg></button>
          </div></li>`;
      })
      .join("");
  }

  list.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.remove) files.splice(Number(btn.dataset.remove), 1);
    if (btn.dataset.move) {
      const [i, d] = btn.dataset.move.split(",").map(Number);
      [files[i], files[i + d]] = [files[i + d], files[i]];
    }
    render();
  });
  input.addEventListener("change", () => {
    addFiles([...input.files]);
    input.value = "";
  });
  ["dragenter", "dragover"].forEach((t) =>
    drop.addEventListener(t, (e) => {
      e.preventDefault();
      drop.classList.add("is-over");
    })
  );
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("is-over")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  /* ---- Submit ---- */
  $$("input, textarea", form).forEach((f) =>
    f.addEventListener("input", () => f.closest(".field, .check")?.classList.remove("is-error"))
  );

  function validate() {
    let first = null;
    const flag = (el, bad) => {
      el.classList.toggle("is-error", bad);
      if (bad && !first) first = el;
    };
    ["name", "phone", "title"].forEach((n) => flag(form[n].closest(".field"), !form[n].value.trim()));
    flag(form.email.closest(".field"), !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.value.trim()));
    flag(drop, files.length === 0);
    flag($("#declaration"), !form.declaration.checked);
    if (first) {
      showError(files.length === 0 && first === drop ? "Please add the document you want attested." : "Please complete the highlighted fields.");
      first.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
    }
    return true;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    await adding;
    if (!validate()) return;

    progress.hidden = false;
    const bar = progress.firstElementChild;
    bar.style.width = "2%";
    submitBtn.disabled = true;
    submitBtn.firstChild.textContent = "Uploading… ";
    const total = files.reduce((s, f) => s + f.size, 0);
    let sent = 0;
    try {
      const uploads = [];
      for (const f of files) {
        uploads.push(await uploadFile(f, { onProgress: (loaded) => (bar.style.width = `${Math.max(2, ((sent + loaded) / total) * 90)}%`) }));
        sent += f.size;
      }
      submitBtn.firstChild.textContent = "Preparing your document… ";
      bar.style.width = "94%";
      const fields = Object.fromEntries(new FormData(form));
      delete fields.files;
      const res = await api("/api/attestations", { method: "POST", json: { ...fields, uploads } });
      bar.style.width = "100%";
      done(res);
    } catch (err) {
      fail(err.message || "Your request could not be submitted. Please try again.");
    }
  });

  function fail(msg) {
    progress.hidden = true;
    submitBtn.disabled = false;
    submitBtn.firstChild.textContent = "Submit for attestation ";
    showError(msg);
  }

  function done(res) {
    const url = new URL(res.trackUrl, location.origin).href;
    $("#successRef").textContent = res.ref;
    $("#successEmail").textContent = res.email;
    $("#trackLink").href = res.trackUrl;
    $("#copyTrack").onclick = (e) => copy(url, e.currentTarget);
    form.hidden = true;
    $("#success").hidden = false;
    $("#success").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ---- Verification ---- */
  const vForm = $("#verifyForm");
  const vOut = $("#verifyResult");
  async function verify(ref) {
    ref = ref.trim().toUpperCase();
    if (!/^UZHL-[A-Z0-9]{10}$/.test(ref)) {
      vOut.innerHTML = `<div class="verify-card verify-card--bad"><div class="verify-card__head"><svg class="icon"><use href="/assets/icons.svg#x"/></svg>Please enter a full reference, like UZHL-AB12CD34EF.</div></div>`;
      return;
    }
    vOut.innerHTML = `<div class="skeleton" style="height:120px"></div>`;
    try {
      const r = await api(`/api/verify/${encodeURIComponent(ref)}`);
      if (!r.found) {
        vOut.innerHTML = `<div class="verify-card verify-card--bad"><div class="verify-card__head"><svg class="icon"><use href="/assets/icons.svg#x"/></svg>No attestation found for ${esc(ref)}</div>
          <p style="margin:0;color:var(--muted);font-size:14.5px">Check the reference number on the stamp. If it is correct, this document was not attested by our office.</p></div>`;
        return;
      }
      vOut.innerHTML = `<div class="verify-card ${r.valid ? "verify-card--ok" : "verify-card--bad"}">
        <div class="verify-card__head"><svg class="icon"><use href="/assets/icons.svg#${r.valid ? "check" : "x"}"/></svg>
          ${r.valid ? "Genuine attestation" : "This attestation has been withdrawn"}</div>
        <dl class="kv">
          <div><dt>Reference</dt><dd>${esc(r.ref)}</dd></div>
          <div><dt>Document</dt><dd>${esc(r.title)} (${r.pages} page${r.pages === 1 ? "" : "s"})</dd></div>
          <div><dt>Issued to</dt><dd>${esc(r.holder)}</dd></div>
          <div><dt>Attested on</dt><dd>${esc(r.attestedOn)}</dd></div>
          <div><dt>Attested by</dt><dd>${esc(r.attorney)} · Licence ${esc(r.licenseNo)}</dd></div>
        </dl></div>`;
    } catch (err) {
      vOut.innerHTML = `<div class="verify-card verify-card--bad"><div class="verify-card__head"><svg class="icon"><use href="/assets/icons.svg#x"/></svg>${esc(err.message)}</div></div>`;
    }
  }
  vForm.addEventListener("submit", (e) => {
    e.preventDefault();
    verify(vForm.ref.value);
  });
  const preset = new URLSearchParams(location.search).get("ref");
  if (preset) {
    vForm.ref.value = preset;
    verify(preset);
  }
})();
