/* ==========================================================
   HL Attorney at Law — site config & interactions
   ----------------------------------------------------------
   EDIT THE DETAILS BELOW. They are inserted everywhere on the
   page (contact section, footer, WhatsApp buttons).
   ========================================================== */
const SITE = {
  phone: "+960 000 0000",            // office phone, shown as text
  whatsapp: "9600000000",            // WhatsApp number: digits only, with country code
  email: "info@hlattorney.com",
  address: "Malé, Republic of Maldives",
  hours: "Sun – Thu, 9:00 AM – 5:00 PM",
  whatsappGreeting: "Hello HL Attorney at Law, I would like to request a legal consultation.",
};

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const waLink = (text) => `https://wa.me/${SITE.whatsapp}?text=${encodeURIComponent(text)}`;

  /* ---- Fill in config ---- */
  $$('[data-field]').forEach((el) => {
    const key = el.dataset.field;
    if (key === "whatsappDisplay") el.textContent = "+" + SITE.whatsapp.replace(/^(\d{3})(\d{3})(\d+)$/, "$1 $2 $3");
    else el.textContent = SITE[key] || "";
    if (key === "phone") el.href = "tel:" + SITE.phone.replace(/[^\d+]/g, "");
    if (key === "email") el.href = "mailto:" + SITE.email;
  });
  $$(".js-whatsapp").forEach((a) => {
    a.href = waLink(SITE.whatsappGreeting);
    a.target = "_blank";
    a.rel = "noopener";
  });
  $("#year").textContent = new Date().getFullYear();

  /* ---- Loader ---- */
  document.body.classList.add("is-loading");
  const done = () => {
    document.body.classList.remove("is-loading");
    setTimeout(() => document.body.classList.add("is-ready"), 300);
  };
  if (document.readyState === "complete") setTimeout(done, 600);
  else addEventListener("load", () => setTimeout(done, 600));
  setTimeout(done, 3500); // safety net

  /* ---- Header state, back-to-top ---- */
  const header = $(".header");
  const totop = $(".totop");
  const onScroll = () => {
    const y = scrollY;
    header.classList.toggle("is-scrolled", y > 40);
    totop.classList.toggle("is-visible", y > 700);
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---- Scroll progress fallback (no scroll-timeline support) ---- */
  if (!CSS.supports("animation-timeline: scroll()")) {
    const bar = $(".progress");
    addEventListener("scroll", () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
    }, { passive: true });
  }

  /* ---- Mobile menu ---- */
  const burger = $(".burger");
  const nav = $(".nav");
  const setMenu = (open) => {
    nav.classList.toggle("is-open", open);
    burger.setAttribute("aria-expanded", open);
    document.body.style.overflow = open ? "hidden" : "";
  };
  burger.addEventListener("click", () => setMenu(!nav.classList.contains("is-open")));
  $$("a", nav).forEach((a) => a.addEventListener("click", () => setMenu(false)));

  /* ---- Reveal on scroll (staggered) ---- */
  const revealIO = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("is-in");
      revealIO.unobserve(e.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
  $$(".reveal").forEach((el) => {
    const siblings = $$(":scope > .reveal", el.parentElement);
    el.style.setProperty("--d", `${Math.min(siblings.indexOf(el), 8) * 0.08}s`);
    revealIO.observe(el);
  });

  /* ---- Active nav link ---- */
  const links = $$('.nav a[href^="#"]:not(.btn)');
  const sectionIO = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      links.forEach((l) => l.classList.toggle("is-current", l.getAttribute("href") === "#" + e.target.id));
    });
  }, { rootMargin: "-45% 0px -50% 0px" });
  links.forEach((l) => { const s = $(l.getAttribute("href")); if (s) sectionIO.observe(s); });

  /* ---- Pointer effects (desktop only) ---- */
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (fine && !reduceMotion) {
    // custom cursor
    const cursor = $(".cursor");
    let cx = innerWidth / 2, cy = innerHeight / 2, tx = cx, ty = cy;
    addEventListener("mousemove", (e) => { tx = e.clientX; ty = e.clientY; });
    (function loop() {
      cx += (tx - cx) * 0.18; cy += (ty - cy) * 0.18;
      cursor.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
      requestAnimationFrame(loop);
    })();
    $$("a, button, summary, .card").forEach((el) => {
      el.addEventListener("mouseenter", () => cursor.classList.add("is-active"));
      el.addEventListener("mouseleave", () => cursor.classList.remove("is-active"));
    });

    // magnetic buttons
    $$(".magnetic").forEach((btn) => {
      btn.addEventListener("mousemove", (e) => {
        const r = btn.getBoundingClientRect();
        const x = e.clientX - r.left - r.width / 2;
        const y = e.clientY - r.top - r.height / 2;
        btn.style.transform = `translate(${x * 0.25}px, ${y * 0.35}px)`;
      });
      btn.addEventListener("mouseleave", () => { btn.style.transform = ""; });
    });

    // spotlight on service cards
    $$(".card").forEach((card) => {
      card.addEventListener("mousemove", (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${e.clientX - r.left}px`);
        card.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    });

    // 3D tilt on hero emblem
    const tilt = $(".tilt");
    if (tilt) {
      const hero = $(".hero");
      hero.addEventListener("mousemove", (e) => {
        const x = e.clientX / innerWidth - 0.5;
        const y = e.clientY / innerHeight - 0.5;
        tilt.style.transform = `perspective(900px) rotateY(${x * 18}deg) rotateX(${-y * 18}deg)`;
      });
      hero.addEventListener("mouseleave", () => { tilt.style.transform = ""; });
      tilt.style.transition = "transform .6s cubic-bezier(.22,1,.36,1)";
    }
  }

  /* ---- WhatsApp tooltip nudge ---- */
  const wa = $(".wa");
  setTimeout(() => {
    wa.classList.add("show-tip");
    setTimeout(() => wa.classList.remove("show-tip"), 4500);
  }, 4000);

  /* ---- Contact form → WhatsApp ---- */
  const form = $("#contactForm");
  const status = $(".form__status", form);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let ok = true;
    $$("[required]", form).forEach((f) => {
      const bad = !f.value.trim();
      f.closest(".field").classList.toggle("is-error", bad);
      if (bad) ok = false;
    });
    const email = form.email.value.trim();
    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      form.email.closest(".field").classList.add("is-error");
      ok = false;
    }
    if (!ok) { status.textContent = "Please complete the highlighted fields."; return; }

    const msg = [
      "Hello HL Attorney at Law, I would like to request a consultation.",
      "",
      `Name: ${form.name.value.trim()}`,
      `Phone: ${form.phone.value.trim()}`,
      email ? `Email: ${email}` : null,
      `Practice area: ${form.area.value}`,
      "",
      form.message.value.trim(),
    ].filter((l) => l !== null).join("\n");

    status.textContent = "Opening WhatsApp…";
    window.open(waLink(msg), "_blank", "noopener");
    form.reset();
  });
  $$("input, textarea, select", form).forEach((f) =>
    f.addEventListener("input", () => f.closest(".field").classList.remove("is-error"))
  );
})();
