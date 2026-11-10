/* HL Attorney at Law · shared site script (config, header, reveals, WhatsApp, helpers) */
(() => {
  const SITE = Object.assign(
    {
      firmName: "HL Attorney at Law",
      attorneyName: "Uz. Hussain Layan",
      licenseNo: "PL-2024/13",
      phone: "",
      whatsapp: "",
      email: "",
      address: "",
      hours: "",
      attestation: { currency: "MVR", maxFiles: 10, maxFileMB: 15, maxTotalMB: 40 },
    },
    window.SITE || {}
  );

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const waLink = (text) => `https://wa.me/${SITE.whatsapp}?text=${encodeURIComponent(text)}`;
  const waDisplay = (n) => "+" + String(n).replace(/^(\d{3})(\d{3})(\d+)$/, "$1 $2 $3");

  /* ---- Fill in firm details ---- */
  const setHref = (el, key) => {
    if (key === "phone") el.href = "tel:" + SITE.phone.replace(/[^\d+]/g, "");
    if (key === "email") el.href = "mailto:" + SITE.email;
  };
  $$("[data-site]").forEach((el) => {
    const key = el.dataset.site;
    const value = key === "whatsappDisplay" ? waDisplay(SITE.whatsapp) : SITE[key];
    if (value) el.textContent = value;
    if (el.tagName === "A") setHref(el, key);
  });
  $$("[data-site-href]").forEach((el) => setHref(el, el.dataset.siteHref));
  $$(".js-whatsapp").forEach((a) => {
    a.href = waLink(`Hello ${SITE.firmName}, I would like some legal advice.`);
    a.target = "_blank";
    a.rel = "noopener";
  });
  $$("[data-year]").forEach((el) => (el.textContent = new Date().getFullYear()));

  /* ---- Header ---- */
  const header = $(".header");
  if (header) {
    const onScroll = () => header.classList.toggle("is-scrolled", scrollY > 8);
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
  const burger = $(".burger");
  const nav = $("#nav");
  if (burger && nav) {
    const setMenu = (open) => {
      nav.classList.toggle("is-open", open);
      header.classList.toggle("has-open-nav", open);
      burger.setAttribute("aria-expanded", String(open));
      burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    };
    burger.addEventListener("click", () => setMenu(!nav.classList.contains("is-open")));
    $$("a", nav).forEach((a) => a.addEventListener("click", () => setMenu(false)));
    addEventListener("keydown", (e) => e.key === "Escape" && setMenu(false));
  }

  /* ---- Highlight the current section in the menu ---- */
  const links = $$('.nav a[href^="/#"]:not(.btn)');
  if (links.length && location.pathname === "/") {
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) links.forEach((l) => l.classList.toggle("is-current", l.hash === "#" + e.target.id));
        }),
      { rootMargin: "-45% 0px -50% 0px" }
    );
    links.forEach((l) => {
      const section = document.getElementById(l.hash.slice(1));
      if (section) io.observe(section);
    });
  }
  $$(".nav a:not(.btn)").forEach((a) => {
    if (a.pathname !== "/" && a.pathname === location.pathname) a.classList.add("is-current");
  });

  /* ---- Scroll reveal, staggered between siblings ---- */
  const revealIO = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const el = e.target;
        el.classList.add("is-in");
        revealIO.unobserve(el);
        // hand control back to the element's own hover transitions once revealed
        setTimeout(() => el.classList.remove("reveal"), 900 + parseFloat(el.style.getPropertyValue("--d") || 0) * 1000);
      }),
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
  );
  const observeReveals = (root = document) =>
    $$(".reveal", root).forEach((el) => {
      const siblings = [...el.parentElement.children].filter((c) => c.classList.contains("reveal"));
      el.style.setProperty("--d", `${Math.min(siblings.indexOf(el), 6) * 0.07}s`);
      if (reduceMotion) el.classList.add("is-in");
      else revealIO.observe(el);
    });
  observeReveals();

  /* ---- WhatsApp tooltip nudge (once per visit) ---- */
  const wa = $(".wa");
  if (wa) {
    let seen = false;
    try { seen = sessionStorage.getItem("hl-wa-tip") === "1"; } catch {}
    if (!seen) {
      setTimeout(() => {
        wa.classList.add("show-tip");
        setTimeout(() => wa.classList.remove("show-tip"), 4500);
        try { sessionStorage.setItem("hl-wa-tip", "1"); } catch {}
      }, 5000);
    }
  }

  /* ---- Consultation form → WhatsApp ---- */
  const form = $("#contactForm");
  if (form) {
    const status = $(".form-status", form);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      let ok = true;
      $$("[required]", form).forEach((f) => {
        const bad = !f.value.trim();
        f.closest(".field").classList.toggle("is-error", bad);
        ok = ok && !bad;
      });
      const email = form.email.value.trim();
      if (email && !/^\S+@\S+\.\S+$/.test(email)) {
        form.email.closest(".field").classList.add("is-error");
        ok = false;
      }
      if (!ok) return (status.textContent = "Please complete the highlighted fields.");
      const lines = [
        `Hello ${SITE.firmName}, I would like to request a consultation.`,
        "",
        `Name: ${form.name.value.trim()}`,
        `Phone: ${form.phone.value.trim()}`,
        email ? `Email: ${email}` : null,
        `Practice area: ${form.area.value}`,
        "",
        form.message.value.trim(),
      ].filter((l) => l !== null);
      status.textContent = "";
      window.open(waLink(lines.join("\n")), "_blank", "noopener");
      form.reset();
    });
    $$("input, select, textarea", form).forEach((f) =>
      f.addEventListener("input", () => f.closest(".field").classList.remove("is-error"))
    );
  }

  /* ---- Helpers for the attestation pages ---- */
  async function api(path, { method = "GET", json, body, signal } = {}) {
    const headers = { "X-Requested-With": "fetch" };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(path, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : body,
      credentials: "same-origin",
      signal,
    });
    // A missing API answers with a web page instead of JSON; report that as its own case.
    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    const data = isJson ? await res.json().catch(() => ({})) : {};
    if (!res.ok || !isJson) {
      const err = new Error(data.error || `Something went wrong (error ${res.status}). Please try again.`);
      err.status = res.ok ? 0 : res.status;
      err.notJson = !isJson;
      throw err;
    }
    return data;
  }
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const bytes = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const date = (iso, withTime = false) =>
    new Date(iso).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    });
  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    if (button) {
      const label = button.innerHTML;
      button.classList.add("is-copied");
      button.textContent = "Copied";
      setTimeout(() => ((button.innerHTML = label), button.classList.remove("is-copied")), 1400);
    }
  }

  // Large photos are resized and saved as JPEG before upload (faster, and keeps PDFs small).
  async function shrinkImage(file) {
    if (!/^image\/(jpeg|png)$/.test(file.type) || file.size < 900 * 1024 || typeof createImageBitmap !== "function") return file;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
      const canvas = Object.assign(document.createElement("canvas"), {
        width: Math.round(bitmap.width * scale),
        height: Math.round(bitmap.height * scale),
      });
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], file.name.replace(/\.(png|jpe?g)$/i, "") + ".jpg", { type: "image/jpeg" });
    } catch {
      return file;
    }
  }

  // Uploads one file: asks the server for a short-lived upload URL, then sends the file there.
  async function uploadFile(file, { purpose = "document", token, onProgress } = {}) {
    const target = await api("/api/uploads", {
      method: "POST",
      json: { purpose, token, name: file.name, size: file.size, type: file.type },
    });
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(target.method || "PUT", target.url);
      Object.entries(target.headers || {}).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded, e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let message = "";
        try {
          message = JSON.parse(xhr.responseText).error;
        } catch {}
        reject(new Error(message || `"${file.name}" could not be uploaded (error ${xhr.status}). Please try again.`));
      };
      xhr.onerror = () => reject(new Error("Connection problem during the upload. Please check your internet and try again."));
      xhr.send(file);
    });
    return { key: target.key, name: file.name };
  }

  window.HL = { SITE, $, $$, api, esc, bytes, date, copy, waLink, observeReveals, reduceMotion, shrinkImage, uploadFile };
})();
