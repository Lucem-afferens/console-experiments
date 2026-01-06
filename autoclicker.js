// 1) Укажи селектор:
const sel = 'CSS_SELECTOR_HERE'; // .class / #id / tag

// 2) Запусти автоклик каждую минуту:
window.__ac && clearInterval(window.__ac);
window.__ac = setInterval(() => document.querySelector(sel)?.click(), 60000);

// Остановить:
// clearInterval(window.__ac)
