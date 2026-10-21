# HL Attorney at Law: Website

A static, single-page website for **HL Attorney at Law**. It doesn't need a build step.

## Files
- `index.html`: page content (hero, about, practice areas, why us, process, FAQ, contact)
- `styles.css`: design and animations
- `script.js`: **site details config** (top of file) and interactions
- `assets/logo.png` / `assets/logo.jpg`: firm emblem

## Update contact details
Open `script.js` and edit the `SITE` object at the top. Set the phone, WhatsApp number
(digits only, with country code), email, address and office hours. They update everywhere,
including the floating WhatsApp button and the contact form.

## Preview locally
Open `index.html` in a browser, or run `python3 -m http.server` and visit http://localhost:8000.

## Deploy
Upload the folder to any static host (GitHub Pages, Netlify, Vercel, cPanel).
